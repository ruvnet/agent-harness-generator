// SPDX-License-Identifier: MIT
//
// iter 121 — `harness oia-manifest <path>` (21st subcommand). Implements
// ADR-034 OIA Integration as a static manifest layer (cross-cutting, NOT a
// host adapter). Verifies the manifest shape matches the v0.1 schema spec'd
// in the ADR §72 and survives the round-trip through checkOiaManifest().

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let oiaManifestCmd: (args: string[]) => Promise<{ code: number; lines: string[] }>;
let buildOiaManifest: any;
let checkOiaManifest: (m: unknown) => { ok: boolean; reasons: string[] };

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'oia-manifest.js'))) throw new Error('build first');
  const mod = await import(`file://${join(distDir, 'oia-manifest.js')}`);
  oiaManifestCmd = mod.oiaManifestCmd;
  buildOiaManifest = mod.buildOiaManifest;
  checkOiaManifest = mod.checkOiaManifest;
});

async function makeHarness(opts: { name?: string; mcp?: boolean; witness?: boolean; auditLog?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-oia-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: opts.name ?? 'demo-harness',
    version: '0.1.0',
  }), 'utf-8');
  await mkdir(join(dir, '.harness'), { recursive: true });
  await writeFile(join(dir, '.harness', 'manifest.json'), JSON.stringify({ name: opts.name ?? 'demo-harness' }), 'utf-8');
  if (opts.mcp ?? true) {
    await writeFile(join(dir, '.harness', 'mcp-policy.json'), JSON.stringify({
      defaultDeny: true,
      auditLog: opts.auditLog ?? true,
      allowShell: false,
      allowNetwork: false,
      allowFileWrite: false,
    }), 'utf-8');
  }
  if (opts.witness) {
    await writeFile(join(dir, '.harness', 'witness.json'), JSON.stringify({ sig: 'fake' }), 'utf-8');
  }
  return dir;
}

describe('harness oia-manifest (iter 121 — ADR-034)', () => {
  it('emits .harness/oia-manifest.json with the full ADR-034 §72 shape', async () => {
    const dir = await makeHarness({ name: 'test-harness', mcp: true, auditLog: true });
    try {
      const r = await oiaManifestCmd([dir]);
      expect(r.code).toBe(0);
      const manifestPath = join(dir, '.harness', 'oia-manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(m.schema).toBe(1);
      expect(m.oiaVersion).toBe('0.1');
      expect(typeof m.generatedAt).toBe('string');
      expect(m.harnessId).toBe('test-harness@0.1.0');
      // 9 layers
      expect(Object.keys(m.layerAlignment).sort()).toEqual([
        'L1_physicalCompute', 'L2_dataAndStorage', 'L3_models',
        'L4_toolsAndIntegrations', 'L5_agentOrchestration', 'L6_workflowAndAutomation',
        'L7_governanceAndPolicy', 'L8_observabilityAndAudit', 'L9_humanAndBrowserInterface',
      ].sort());
      // 6 spans
      expect(Object.keys(m.horizontalSpans).sort()).toEqual([
        'governance', 'identity', 'interoperability', 'observability', 'policyEnforcement', 'security',
      ]);
      // 4 adjacent standards
      expect(Object.keys(m.adjacentStandards).sort()).toEqual(['a2a', 'acp', 'agentProtocol', 'mcp']);
      // OIA v0.1 has no registry; both null per ADR-034 §233 open question 2.
      expect(m.discoveryEndpoint).toBeNull();
      expect(m.registryUrl).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--check on a freshly-emitted manifest returns exit 0 PASS', async () => {
    const dir = await makeHarness({ name: 'check-test' });
    try {
      await oiaManifestCmd([dir]);
      const r = await oiaManifestCmd([dir, '--check']);
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toMatch(/PASS oia-manifest.json shape ok/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--check on missing manifest returns exit 2', async () => {
    const dir = await makeHarness({ name: 'missing-test' });
    try {
      const r = await oiaManifestCmd([dir, '--check']);
      expect(r.code).toBe(2);
      expect(r.lines.join('\n')).toMatch(/no \.harness\/oia-manifest\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--check on corrupted manifest returns exit 1 DRIFT with reasons', async () => {
    const dir = await makeHarness({ name: 'corrupt-test' });
    try {
      await mkdir(join(dir, '.harness'), { recursive: true });
      await writeFile(join(dir, '.harness', 'oia-manifest.json'), JSON.stringify({
        schema: 99,
        oiaVersion: 'wat',
      }), 'utf-8');
      const r = await oiaManifestCmd([dir, '--check']);
      expect(r.code).toBe(1);
      const out = r.lines.join('\n');
      expect(out).toContain('DRIFT');
      expect(out).toMatch(/schema:/);
      expect(out).toMatch(/oiaVersion:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--dry-run prints the manifest, does NOT write', async () => {
    const dir = await makeHarness({ name: 'dry-test' });
    try {
      const r = await oiaManifestCmd([dir, '--dry-run']);
      expect(r.code).toBe(0);
      // JSON output starts with `{`
      expect(r.lines[0]?.startsWith('{')).toBe(true);
      // No file written
      expect(existsSync(join(dir, '.harness', 'oia-manifest.json'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('manifest reflects MCP state — mcpFull on, audit on, no witness', async () => {
    const dir = await makeHarness({ name: 'mcp-state-test', mcp: true, auditLog: true, witness: false });
    try {
      await oiaManifestCmd([dir]);
      const m = JSON.parse(readFileSync(join(dir, '.harness', 'oia-manifest.json'), 'utf-8'));
      expect(m.horizontalSpans.security.status).toBe('full');
      expect(m.horizontalSpans.observability.status).toBe('full');
      expect(m.horizontalSpans.policyEnforcement.status).toBe('full');
      // Witness absent → governance partial
      expect(m.horizontalSpans.governance.status).toBe('partial');
      // OIA v0.1 has NO identity primitive (ADR-034 §118)
      expect(m.horizontalSpans.identity.status).toBe('none');
      expect(m.horizontalSpans.identity.implementation).toBeNull();
      expect(m.adjacentStandards.mcp.mode).toBe('local');
      expect(m.adjacentStandards.mcp.policyPath).toBe('.harness/mcp-policy.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('manifest reflects MCP-off harness — all MCP-tied spans partial', async () => {
    const dir = await makeHarness({ name: 'mcp-off', mcp: false });
    try {
      await oiaManifestCmd([dir]);
      const m = JSON.parse(readFileSync(join(dir, '.harness', 'oia-manifest.json'), 'utf-8'));
      expect(m.adjacentStandards.mcp.mode).toBe('off');
      expect(m.adjacentStandards.mcp.policyPath).toBeNull();
      expect(m.horizontalSpans.security.status).toBe('partial');
      expect(m.horizontalSpans.policyEnforcement.status).toBe('partial');
      expect(m.layerAlignment.L4_toolsAndIntegrations).toBe('partial');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('BUG REPRO (pre-fix would report mcp.mode:"off"/security "partial"): .claude/settings.json-only MCP registration is detected as in-use — issue #280', async () => {
    // Same detection-gap class PR #276 (2026-09-03) closed in threat-model.ts:
    // readHarnessProfile()'s hasMcp only checked .harness/mcp-policy.json and
    // .mcp.json, missing .claude/settings.json's mcpServers key.
    const dir = await mkdtemp(join(tmpdir(), 'ahg-oia-settings-mcp-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'settings-mcp-test', version: '0.1.0' }), 'utf-8');
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(
        join(dir, '.claude', 'settings.json'),
        JSON.stringify({ mcpServers: { bot: { command: 'npx' } } }),
        'utf-8',
      );
      const r = await oiaManifestCmd([dir]);
      expect(r.code).toBe(0);
      const m = JSON.parse(readFileSync(join(dir, '.harness', 'oia-manifest.json'), 'utf-8'));
      expect(m.adjacentStandards.mcp.mode).not.toBe('off');
      expect(m.horizontalSpans.security.status).not.toBe('partial');
      expect(m.layerAlignment.L4_toolsAndIntegrations).not.toBe('partial');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checkOiaManifest passes a freshly-built object', () => {
    const m = buildOiaManifest({
      name: 'unit',
      version: '0.0.1',
      hasMcp: true,
      mcpMode: 'local',
      mcpPolicyPath: '.harness/mcp-policy.json',
      hasWitness: true,
      hasAuditLog: true,
    });
    const r = checkOiaManifest(m);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('missing args returns exit 2 with usage', async () => {
    const r = await oiaManifestCmd([]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Usage: harness oia-manifest/);
  });
});
