// SPDX-License-Identifier: MIT
//
// `harness score <path>` — 19th subcommand (iter 111). Priority 2 from the
// user's roadmap. Aggregates 5 dimensions into a single 0–100 score plus a
// per-dimension breakdown.
//
// Dimensions + weights (from the user's spec):
//   - Repo understanding   (25%) — meta.surface + meta.kernel_version + diag verdict
//   - Agent usefulness     (25%) — count of agents + skills + commands
//   - MCP safety           (20%) — mcp-policy.json default-deny + audit + no risky perms
//   - Test coverage        (15%) — presence of __tests__/ or tests/ + ci wiring
//   - Publish readiness    (15%) — witness present + sbom emit-able + npm pack ready
//
// Modes: text (default) · --json · --bundle (ADR-031 schema-1 envelope) · --out <file>.
//
// Verdict + exit code:
//   - score ≥ 85  → 'A' (exit 0, the target the user named)
//   - score ≥ 70  → 'B' (exit 0)
//   - score ≥ 50  → 'C' (exit 1, needs work)
//   - score <  50 → 'F' (exit 2, blocked)

import { existsSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { redactSecretsDeep } from './redact.js';
import { scanMcp } from './mcp-scan.js';

export type SubcommandResult = { code: number; lines: string[] };

/**
 * #15 — schema discriminator for the `harness score` badge JSON (`--json` / `--out`). It lets a
 * downstream consumer detect this shape at the data layer and REFUSE the wrong one: `harness score`
 * (this flat badge set) and `metaharness score` (the repo-scorecard, numeric `schema: 1`) are
 * DIFFERENT operations with different keys, and an unmarked badge blob silently mis-parsed as the
 * metaharness scorecard (every numeric field defaulting to 0). A string id is unambiguously distinct
 * from the numeric `schema: 1`.
 */
export const HARNESS_SCORE_SCHEMA = 'harness-quickcheck-v1';

interface DimensionScore {
  name: string;
  weight: number; // 0..1
  score: number;  // 0..100
  signals: string[]; // human-readable evidence
}

export interface Scorecard {
  schema: 1;
  generatedAt: string;
  dir: string;
  overall: number;       // 0..100
  grade: 'A' | 'B' | 'C' | 'F';
  dimensions: DimensionScore[];
  badges: {              // the README badge set the user asked for
    score: number;
    mcpRisk: 'Low' | 'Medium' | 'High' | 'None';
    releaseReady: boolean;
    testsDetected: boolean;
    sbom: boolean;
    witnessSigned: boolean;
  };
  exitCode: 0 | 1 | 2;
}

// --- helpers ---------------------------------------------------------------

function safeReadJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function dirExists(dir: string, sub: string): boolean {
  try {
    return existsSync(join(dir, sub)) && statSync(join(dir, sub)).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(dir: string, sub: string): boolean {
  try {
    return existsSync(join(dir, sub)) && statSync(join(dir, sub)).isFile();
  } catch {
    return false;
  }
}

function countDir(dir: string, sub: string): number {
  try {
    const target = join(dir, sub);
    if (!existsSync(target)) return 0;
    return readdirSync(target).filter((n) => !n.startsWith('.')).length;
  } catch {
    return 0;
  }
}

// --- dimension scorers (pure-ish — they read disk but no exec) -------------

function scoreRepoUnderstanding(dir: string, manifest: any): DimensionScore {
  const signals: string[] = [];
  let s = 0;
  if (manifest) {
    s += 35;
    signals.push('manifest.json present');
    if (manifest.meta?.surface) {
      s += 20;
      signals.push(`surface=${manifest.meta.surface}`);
    }
    if (manifest.meta?.kernel_version) {
      s += 25;
      signals.push(`kernel=${manifest.meta.kernel_version}`);
    }
    if (Array.isArray(manifest.hosts) && manifest.hosts.length > 0) {
      s += 20;
      signals.push(`host(s)=${manifest.hosts.join(', ')}`);
    }
  } else {
    signals.push('no manifest — cannot identify what this harness is');
  }
  return { name: 'Repo understanding', weight: 0.25, score: Math.min(100, s), signals };
}

function scoreAgentUsefulness(dir: string): DimensionScore {
  const signals: string[] = [];
  let s = 0;
  const agents = countDir(dir, 'src/agents');
  const skills = countDir(dir, '.claude/skills');
  const commands = countDir(dir, '.claude/commands');
  if (agents > 0) {
    s += Math.min(40, agents * 10);
    signals.push(`${agents} agent(s) in src/agents/`);
  }
  if (skills > 0) {
    s += Math.min(30, skills * 15);
    signals.push(`${skills} skill(s) in .claude/skills/`);
  }
  if (commands > 0) {
    s += Math.min(30, commands * 15);
    signals.push(`${commands} command(s) in .claude/commands/`);
  }
  if (s === 0) signals.push('no agents / skills / commands found');
  return { name: 'Agent usefulness', weight: 0.25, score: Math.min(100, s), signals };
}

interface McpScore extends DimensionScore {
  mcpRisk: 'None' | 'Low' | 'Medium' | 'High';
}

function scoreMcpSafety(dir: string): McpScore {
  const signals: string[] = [];
  const policy = safeReadJson(join(dir, '.harness', 'mcp-policy.json'));
  // "In use" is decided by scanMcp()'s mcpEnabled — the one place that ORs
  // all three valid registration surfaces (.harness/mcp-policy.json,
  // .mcp.json, and .claude/settings.json's mcpServers key). A policy-file-
  // or-.mcp.json-only check here missed the settings.json-only case and
  // scored it as the safest possible posture (mcpRisk: 'None') even when a
  // server was actually registered and ungoverned — see issue #280 (the
  // same class of gap #276 closed in threat-model.ts on 2026-09-03).
  const hasMcp = scanMcp(dir).mcpEnabled;
  if (!hasMcp) {
    signals.push('MCP not in use (mode=off — safest)');
    return { name: 'MCP safety', weight: 0.2, score: 100, signals, mcpRisk: 'None' };
  }
  let s = 0;
  let risk: 'None' | 'Low' | 'Medium' | 'High' = 'Low';
  if (policy?.defaultDeny === true) {
    s += 40;
    signals.push('default-deny ON');
  } else {
    risk = 'High';
    signals.push('default-deny OFF — dangerous');
  }
  if (policy?.auditLog === true) {
    s += 15;
    signals.push('audit-log ON');
  }
  if (policy?.allowShell === false || policy?.allowShell == null) {
    s += 15;
    signals.push('shell gated');
  } else {
    risk = 'High';
    signals.push('shell ALLOWED — risky');
  }
  if (policy?.allowNetwork === false || policy?.allowNetwork == null) {
    s += 15;
    signals.push('network gated');
  } else {
    if (risk !== 'High') risk = 'Medium';
    signals.push('network ALLOWED');
  }
  if (policy?.allowFileWrite === false || policy?.allowFileWrite == null) {
    s += 15;
    signals.push('file-write gated');
  } else {
    if (risk !== 'High') risk = 'Medium';
    signals.push('file-write ALLOWED');
  }
  return { name: 'MCP safety', weight: 0.2, score: Math.min(100, s), signals, mcpRisk: risk };
}

function scoreTestCoverage(dir: string): DimensionScore {
  const signals: string[] = [];
  let s = 0;
  const hasTests = dirExists(dir, '__tests__') || dirExists(dir, 'tests') || dirExists(dir, 'test');
  if (hasTests) {
    s += 50;
    signals.push('test directory present');
  }
  const pkg = safeReadJson(join(dir, 'package.json'));
  if (pkg?.scripts?.test) {
    s += 25;
    signals.push(`npm test → ${pkg.scripts.test}`);
  }
  if (dirExists(dir, '.github/workflows')) {
    s += 25;
    signals.push('CI workflow present');
  }
  if (s === 0) signals.push('no test signals detected');
  return { name: 'Test coverage', weight: 0.15, score: Math.min(100, s), signals };
}

interface PublishScore extends DimensionScore {
  witnessSigned: boolean;
  sbom: boolean;
  releaseReady: boolean;
}

function scorePublishReadiness(dir: string, manifest: any): PublishScore {
  const signals: string[] = [];
  let s = 0;
  const witnessSigned = fileExists(dir, '.harness/witness.json');
  if (witnessSigned) {
    s += 40;
    signals.push('witness.json present');
  }
  // sbom.json is emitted by `harness sbom`; presence indicates the operator
  // has at least run it once. Even if it's not committed, presence is the
  // strong publish-readiness signal.
  const sbom = fileExists(dir, 'sbom.json') || fileExists(dir, '.harness/sbom.json');
  if (sbom) {
    s += 20;
    signals.push('SBOM present');
  }
  const pkg = safeReadJson(join(dir, 'package.json'));
  if (pkg?.name && pkg?.version) {
    s += 20;
    signals.push(`pkg=${pkg.name}@${pkg.version}`);
  }
  if (Array.isArray(manifest?.hosts) && manifest.hosts.length > 0 && pkg?.bin) {
    s += 20;
    signals.push('bin entry present (npx-runnable)');
  } else if (pkg?.bin) {
    s += 10;
    signals.push('bin entry present');
  }
  if (s === 0) signals.push('no publish signals — run harness validate first');
  const releaseReady = s >= 70;
  return { name: 'Publish readiness', weight: 0.15, score: Math.min(100, s), signals, witnessSigned, sbom, releaseReady };
}

// --- overall ---------------------------------------------------------------

export function buildScorecard(dir: string, generatedAt: string = new Date().toISOString()): Scorecard {
  const manifest = safeReadJson(join(dir, '.harness', 'manifest.json'));
  const repoUnderstanding = scoreRepoUnderstanding(dir, manifest);
  const agentUsefulness = scoreAgentUsefulness(dir);
  const mcpSafety = scoreMcpSafety(dir);
  const testCoverage = scoreTestCoverage(dir);
  const publishReadiness = scorePublishReadiness(dir, manifest);

  const dims: DimensionScore[] = [repoUnderstanding, agentUsefulness, mcpSafety, testCoverage, publishReadiness];
  const overall = Math.round(dims.reduce((sum, d) => sum + d.weight * d.score, 0));

  let grade: 'A' | 'B' | 'C' | 'F';
  let exitCode: 0 | 1 | 2;
  if (overall >= 85) {
    grade = 'A';
    exitCode = 0;
  } else if (overall >= 70) {
    grade = 'B';
    exitCode = 0;
  } else if (overall >= 50) {
    grade = 'C';
    exitCode = 1;
  } else {
    grade = 'F';
    exitCode = 2;
  }

  // Detect tests: any of __tests__/ tests/ test/.
  const testsDetected = testCoverage.score > 0;

  return {
    schema: 1,
    generatedAt,
    dir,
    overall,
    grade,
    dimensions: dims,
    badges: {
      score: overall,
      mcpRisk: mcpSafety.mcpRisk,
      releaseReady: publishReadiness.releaseReady,
      testsDetected,
      sbom: publishReadiness.sbom,
      witnessSigned: publishReadiness.witnessSigned,
    },
    exitCode,
  };
}

// --- formatting ------------------------------------------------------------

function bar(score: number): string {
  const width = 20;
  const filled = Math.round((score / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function yn(b: boolean): string {
  return b ? 'Yes' : 'No';
}

export function formatScorecard(sc: Scorecard): string[] {
  const out: string[] = [];
  out.push(`harness score — ${sc.dir}`);
  out.push('');
  out.push(`Overall: ${sc.overall}/100  Grade: ${sc.grade}`);
  out.push('');
  for (const d of sc.dimensions) {
    out.push(`  ${d.name.padEnd(22)} ${String(d.score).padStart(3)}  ${bar(d.score)}  (${Math.round(d.weight * 100)}%)`);
    for (const s of d.signals) out.push(`    · ${s}`);
  }
  out.push('');
  out.push('Badges:');
  out.push(`  Harness Score: ${sc.badges.score}`);
  out.push(`  MCP Risk:      ${sc.badges.mcpRisk}`);
  out.push(`  Release Ready: ${yn(sc.badges.releaseReady)}`);
  out.push(`  Tests Detected:${yn(sc.badges.testsDetected)}`);
  out.push(`  SBOM:          ${yn(sc.badges.sbom)}`);
  out.push(`  Witness Signed:${yn(sc.badges.witnessSigned)}`);
  out.push('');
  out.push(`Verdict: ${sc.grade} (exit ${sc.exitCode})`);
  return out;
}

// --- sanitisation (ADR-031) ------------------------------------------------

const SECRET_RE = /(secret|token|key|password|passphrase)/i;

// GH #4 (HIGH-2): redact by KEY name AND by VALUE shape (redact.ts — single source of truth, #7).
function sanitise(v: unknown): unknown {
  return redactSecretsDeep(v, { keyRe: SECRET_RE, replacement: '[REDACTED]' });
}

// --- dispatch --------------------------------------------------------------

function usage(): string[] {
  return [
    'Usage: harness score <path> [--out <file>] [--json] [--bundle]',
    '',
    '  5-dimension scorecard for a generated harness. 0–100, grade A/B/C/F.',
    '  Dimensions: Repo understanding (25%) · Agent usefulness (25%) ·',
    '             MCP safety (20%) · Test coverage (15%) · Publish readiness (15%).',
    '',
    '  --out <file>   Write the badges JSON to <file>.',
    '  --json         Emit the badges JSON to stdout instead of text.',
    '  --bundle       Emit the full scorecard as an ADR-031 schema-1 envelope.',
  ];
}

export async function scoreCmd(args: string[]): Promise<SubcommandResult> {
  const bundle = args.includes('--bundle');
  const json = args.includes('--json');
  let outPath: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') {
      outPath = args[++i] ?? null;
      if (!outPath) {
        const err = { schema: 1 as const, error: 'missing-out-path', exitCode: 2 };
        return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : '--out requires a file path'] };
      }
    } else if (a === '--bundle' || a === '--json') {
      /* handled */
    } else if (a === '--help' || a === '-h') {
      return { code: 0, lines: usage() };
    } else if (a && !a.startsWith('--')) {
      positional.push(a);
    } else if (a) {
      const err = { schema: 1 as const, error: `unknown-flag-${a.replace(/^--?/, '')}`, exitCode: 2 };
      return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : `Unknown flag: ${a}`] };
    }
  }

  if (positional.length === 0) {
    return { code: 2, lines: usage() };
  }

  const dir = resolve(positional[0]!);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const generatedAt = new Date().toISOString();
    const err = { schema: 1 as const, generatedAt, error: 'not-a-directory', dir, exitCode: 2 };
    if (bundle || json) return { code: 2, lines: [JSON.stringify(err, null, 2)] };
    return { code: 2, lines: [`harness score: not a directory: ${dir}`] };
  }

  const sc = buildScorecard(dir);
  // #15 — carry the schema discriminator on the badge output so a consumer can detect this shape at
  // the DATA layer. `harness score` and `metaharness score` are DIFFERENT operations with different
  // JSON shapes; an unmarked badge blob was silently mis-parsed as the `metaharness score` scorecard
  // (every field defaulting to 0). The metaharness scorecard uses numeric `schema: 1`; this string id
  // is unambiguously distinct so downstream code can refuse the wrong shape instead of guessing.
  const badgeOutput = { schema: HARNESS_SCORE_SCHEMA, ...sc.badges };

  if (outPath) {
    try {
      writeFileSync(resolve(outPath), JSON.stringify(badgeOutput, null, 2) + '\n', 'utf-8');
    } catch (e) {
      const err = { schema: 1 as const, error: 'out-write-failed', detail: String(e), exitCode: 2 };
      return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : `harness score: failed to write --out: ${String(e)}`] };
    }
  }

  if (bundle) {
    return { code: sc.exitCode, lines: [JSON.stringify(sanitise(sc), null, 2)] };
  }
  if (json) {
    return { code: sc.exitCode, lines: [JSON.stringify(badgeOutput, null, 2)] };
  }
  return { code: sc.exitCode, lines: formatScorecard(sc) };
}
