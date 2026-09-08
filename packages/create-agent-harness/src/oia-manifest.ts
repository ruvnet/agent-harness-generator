// SPDX-License-Identifier: MIT
//
// `harness oia-manifest <path>` — 21st subcommand (iter 121).
//
// Implements ADR-034 — the Open Intelligence Architecture (OIA) cross-cutting
// manifest layer. Static, additive, kernel-free. Emits .harness/oia-manifest.json
// self-describing the harness's alignment with the OIA v0.1 9-layer model and
// horizontal spans.
//
// LAYER NAMES + SPAN KEYS — per ADR-034 §233, these are inferred from OIA v0.1
// narrative prose (no machine-readable schema published yet). They carry the
// `oiaVersion: "0.1"` forward-compatibility signal so parsers can switch on
// version when v1.0 ships an authoritative enumeration.
//
// Modes:
//   - default: emit/overwrite .harness/oia-manifest.json
//   - --check: read existing manifest, verify shape, exit 0 ok / 1 drift / 2 missing
//   - --dry-run: print the manifest to stdout, don't write
//   - --json: stdout the manifest (same as --dry-run + machine-friendly)

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanMcp } from './mcp-scan.js';

export type SubcommandResult = { code: number; lines: string[] };

export type AlignmentLevel = 'full' | 'partial' | 'none' | 'not-applicable';
export type SpanStatus = 'full' | 'partial' | 'none';

export interface OiaManifest {
  schema: 1;
  oiaVersion: '0.1';
  generatedAt: string;
  harnessId: string;
  layerAlignment: {
    L1_physicalCompute: AlignmentLevel;
    L2_dataAndStorage: AlignmentLevel;
    L3_models: AlignmentLevel;
    L4_toolsAndIntegrations: AlignmentLevel;
    L5_agentOrchestration: AlignmentLevel;
    L6_workflowAndAutomation: AlignmentLevel;
    L7_governanceAndPolicy: AlignmentLevel;
    L8_observabilityAndAudit: AlignmentLevel;
    L9_humanAndBrowserInterface: AlignmentLevel;
  };
  horizontalSpans: {
    security: { status: SpanStatus; implementation: string | null };
    observability: { status: SpanStatus; implementation: string | null };
    identity: { status: SpanStatus; implementation: string | null };
    governance: { status: SpanStatus; implementation: string | null };
    policyEnforcement: { status: SpanStatus; implementation: string | null };
    interoperability: { status: SpanStatus; implementation: string | null };
  };
  adjacentStandards: {
    mcp: { mode: 'off' | 'local' | 'remote'; policyPath: string | null };
    a2a: { mode: 'off' | 'inbound' | 'bidi'; note: string };
    acp: { mode: 'off' | 'inbound' | 'bidi'; note: string };
    agentProtocol: { mode: 'off' | 'inbound' | 'bidi'; note: string };
  };
  discoveryEndpoint: string | null;
  registryUrl: string | null;
}

interface HarnessProfile {
  name: string;
  version: string;
  hasMcp: boolean;
  mcpMode: 'off' | 'local' | 'remote';
  mcpPolicyPath: string | null;
  hasWitness: boolean;
  hasAuditLog: boolean;
}

function readHarnessProfile(dir: string): HarnessProfile {
  const root = resolve(dir);
  const safeReadJson = (p: string): any | null => {
    try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null; }
    catch { return null; }
  };
  const pkg = safeReadJson(join(root, 'package.json')) ?? {};
  const manifest = safeReadJson(join(root, '.harness', 'manifest.json')) ?? {};
  const mcpPolicy = safeReadJson(join(root, '.harness', 'mcp-policy.json'));
  // In-use detection routes through scanMcp()'s mcpEnabled (the authoritative
  // OR of all 3 valid registration surfaces — policy file, .mcp.json, and
  // .claude/settings.json's mcpServers) rather than re-deriving a narrower,
  // policy-file-or-.mcp.json-only check here. A settings.json-only harness
  // was previously reported ADR-034 mcp.mode:"off" / security span "partial"
  // even with a live, ungoverned MCP server registered — see issue #280.
  const hasMcp = scanMcp(root).mcpEnabled;
  // mcpMode inference: presence of mcp-policy with `mode: remote` → remote;
  // policy present without remote signal → local; otherwise off.
  let mcpMode: 'off' | 'local' | 'remote' = 'off';
  if (hasMcp) mcpMode = mcpPolicy?.mode === 'remote' ? 'remote' : 'local';
  const mcpPolicyPath = mcpPolicy != null ? '.harness/mcp-policy.json' : null;
  const hasWitness = existsSync(join(root, '.harness', 'witness.json'));
  const hasAuditLog = mcpPolicy?.auditLog === true;
  return {
    name: pkg.name ?? manifest.name ?? 'unknown-harness',
    version: pkg.version ?? '0.0.0',
    hasMcp,
    mcpMode,
    mcpPolicyPath,
    hasWitness,
    hasAuditLog,
  };
}

/**
 * Build an OIA manifest from the harness profile. Pure: same profile + same
 * generatedAt → byte-identical manifest, so the witness fingerprint (ADR-011)
 * stays stable.
 */
export function buildOiaManifest(profile: HarnessProfile, generatedAt: string = new Date().toISOString()): OiaManifest {
  const mcpFull = profile.hasMcp && profile.mcpMode !== 'off';
  return {
    schema: 1,
    oiaVersion: '0.1',
    generatedAt,
    harnessId: `${profile.name}@${profile.version}`,
    layerAlignment: {
      L1_physicalCompute: 'not-applicable',
      L2_dataAndStorage: 'partial',
      L3_models: 'full',
      L4_toolsAndIntegrations: mcpFull ? 'full' : 'partial',
      L5_agentOrchestration: 'full',
      L6_workflowAndAutomation: 'partial',
      L7_governanceAndPolicy: mcpFull ? 'full' : 'partial',
      L8_observabilityAndAudit: profile.hasAuditLog ? 'full' : 'partial',
      L9_humanAndBrowserInterface: 'partial',
    },
    horizontalSpans: {
      security: {
        status: mcpFull ? 'full' : 'partial',
        implementation: mcpFull ? 'mcp-policy.json + ADR-022' : 'ADR-022 (MCP off)',
      },
      observability: {
        status: profile.hasAuditLog ? 'full' : 'partial',
        implementation: profile.hasAuditLog ? 'audit-log in src/mcp/audit.ts' : 'partial — audit-log not enabled',
      },
      identity: {
        status: 'none',
        implementation: null,
      },
      governance: {
        status: profile.hasWitness ? 'full' : 'partial',
        implementation: profile.hasWitness ? 'mcp-policy.json + witness ADR-011' : 'mcp-policy.json (witness missing)',
      },
      policyEnforcement: {
        status: mcpFull ? 'full' : 'partial',
        implementation: mcpFull ? 'policy.ts default-deny gate' : 'partial — MCP off',
      },
      interoperability: {
        status: 'partial',
        implementation: 'MCP (ADR-022); OIA manifest (ADR-034)',
      },
    },
    adjacentStandards: {
      mcp: { mode: profile.mcpMode, policyPath: profile.mcpPolicyPath },
      a2a: { mode: 'off', note: 'not yet wired' },
      acp: { mode: 'off', note: 'not yet wired' },
      agentProtocol: { mode: 'off', note: 'not yet wired' },
    },
    discoveryEndpoint: null,
    registryUrl: null,
  };
}

const SCHEMA_KEYS = [
  'schema', 'oiaVersion', 'generatedAt', 'harnessId',
  'layerAlignment', 'horizontalSpans', 'adjacentStandards',
  'discoveryEndpoint', 'registryUrl',
] as const;

const LAYER_KEYS = [
  'L1_physicalCompute', 'L2_dataAndStorage', 'L3_models',
  'L4_toolsAndIntegrations', 'L5_agentOrchestration', 'L6_workflowAndAutomation',
  'L7_governanceAndPolicy', 'L8_observabilityAndAudit', 'L9_humanAndBrowserInterface',
] as const;

const SPAN_KEYS = [
  'security', 'observability', 'identity', 'governance', 'policyEnforcement', 'interoperability',
] as const;

export interface CheckResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Validate an OIA manifest against the v0.1 schema. Strict shape check;
 * unknown keys are reported as warnings (not failures) so a v1.0 manifest
 * can be linted against v0.1 with informational drift output.
 */
export function checkOiaManifest(m: unknown): CheckResult {
  const reasons: string[] = [];
  const ok = (cond: boolean, msg: string) => { if (!cond) reasons.push(msg); };
  if (typeof m !== 'object' || m == null) {
    return { ok: false, reasons: ['manifest is not an object'] };
  }
  const obj = m as Record<string, unknown>;
  ok(obj.schema === 1, `schema: expected 1, got ${JSON.stringify(obj.schema)}`);
  ok(obj.oiaVersion === '0.1', `oiaVersion: expected "0.1", got ${JSON.stringify(obj.oiaVersion)}`);
  ok(typeof obj.generatedAt === 'string', 'generatedAt: must be ISO 8601 string');
  ok(typeof obj.harnessId === 'string', 'harnessId: must be string');
  for (const k of SCHEMA_KEYS) ok(k in obj, `missing top-level key: ${k}`);
  if (typeof obj.layerAlignment === 'object' && obj.layerAlignment != null) {
    const la = obj.layerAlignment as Record<string, unknown>;
    for (const lk of LAYER_KEYS) ok(lk in la, `layerAlignment: missing ${lk}`);
  } else {
    reasons.push('layerAlignment: not an object');
  }
  if (typeof obj.horizontalSpans === 'object' && obj.horizontalSpans != null) {
    const hs = obj.horizontalSpans as Record<string, unknown>;
    for (const sk of SPAN_KEYS) ok(sk in hs, `horizontalSpans: missing ${sk}`);
  } else {
    reasons.push('horizontalSpans: not an object');
  }
  return { ok: reasons.length === 0, reasons };
}

function usage(): string[] {
  return [
    'Usage: harness oia-manifest <path> [--check] [--dry-run] [--json]',
    '',
    '  Emits .harness/oia-manifest.json self-describing the harness alignment',
    '  with the OIA v0.1 9-layer reference architecture (ADR-034).',
    '',
    '  --check     Read existing manifest, verify shape (exit 0/1/2).',
    '  --dry-run   Print the manifest to stdout, do not write.',
    '  --json      Same as --dry-run; emit JSON to stdout.',
  ];
}

export async function oiaManifestCmd(args: string[]): Promise<SubcommandResult> {
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const positional: string[] = [];
  for (const a of args) {
    if (a === '--check' || a === '--dry-run' || a === '--json') continue;
    if (a === '--help' || a === '-h') return { code: 0, lines: usage() };
    if (a && !a.startsWith('--')) positional.push(a);
    else if (a) return { code: 2, lines: [`Unknown flag: ${a}`] };
  }
  if (positional.length === 0) return { code: 2, lines: usage() };

  const dir = resolve(positional[0]!);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { code: 2, lines: [`harness oia-manifest: not a directory: ${dir}`] };
  }
  const manifestPath = join(dir, '.harness', 'oia-manifest.json');

  if (check) {
    if (!existsSync(manifestPath)) {
      return { code: 2, lines: [`FAIL no .harness/oia-manifest.json at ${dir}`] };
    }
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const r = checkOiaManifest(m);
      if (r.ok) return { code: 0, lines: [`PASS oia-manifest.json shape ok (oiaVersion=${m.oiaVersion ?? '?'})`] };
      return { code: 1, lines: ['DRIFT oia-manifest.json shape mismatch:', ...r.reasons.map((s) => `  · ${s}`)] };
    } catch (e) {
      return { code: 2, lines: [`FAIL oia-manifest.json parse error: ${String(e)}`] };
    }
  }

  const profile = readHarnessProfile(dir);
  const manifest = buildOiaManifest(profile);
  const out = JSON.stringify(manifest, null, 2) + '\n';

  if (json || dryRun) {
    return { code: 0, lines: [out.trimEnd()] };
  }

  const harnessDir = join(dir, '.harness');
  if (!existsSync(harnessDir)) {
    try { mkdirSync(harnessDir, { recursive: true }); }
    catch (e) { return { code: 2, lines: [`failed to create .harness/: ${String(e)}`] }; }
  }
  try {
    writeFileSync(manifestPath, out, 'utf-8');
  } catch (e) {
    return { code: 2, lines: [`failed to write oia-manifest.json: ${String(e)}`] };
  }
  return { code: 0, lines: [
    `wrote .harness/oia-manifest.json`,
    `  harnessId:  ${manifest.harnessId}`,
    `  oiaVersion: ${manifest.oiaVersion}`,
    `  mcp mode:   ${manifest.adjacentStandards.mcp.mode}`,
    `  identity:   ${manifest.horizontalSpans.identity.status} (OIA v0.1 has no identity primitive)`,
  ]};
}
