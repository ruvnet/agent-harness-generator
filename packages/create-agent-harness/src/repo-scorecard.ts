// SPDX-License-Identifier: MIT
//
// ADR-041 scorecard — `metaharness score <repo>`. The killer feature: point it
// at a repo and get a 6-line scorecard (harness fit, compile confidence, task
// coverage, tool safety, memory usefulness, est. $/run + recommended mode).
//
// Reuses the no-exec repo analyzer (analyze-repo.ts): inventory → profile →
// recommendPlan. Every dimension is derived from REAL repo signals, not invented
// — the scorecard's job is to tell the truth about whether a generated harness
// fits this repo and what it would cost, before you scaffold anything.

import { resolve, basename } from 'node:path';
import { inventory, analyzeFiles, recommendPlan, scoreArchetypes, ruvllmSemantic, type HarnessPlan } from './analyze-repo.js';
import { scoreMcpRisk } from './genome-scorers.js';
import { checkConstraints, summarise, formatConstraints } from './constraints.js';

export type SubcommandResult = { code: number; lines: string[] };

export interface RepoScorecard {
  schema: 1;
  repo: string;
  /** 0-100 each. */
  harnessFit: number;
  compileConfidence: number;
  taskCoverage: number;
  toolSafety: number;
  memoryUsefulness: number;
  /** Estimated USD per harness run (cheap-tier routing, DRACO finding). */
  estCostPerRunUsd: number;
  recommendedMode: 'CLI' | 'CLI + MCP';
  archetype: string;
  template: string;
  /** All HARD constraints passed → the recommended design is scaffold-ready (ADR-041 validation). */
  scaffoldReady: boolean;
  /** hard-constraints-passed / total (e.g. "6/6"). */
  hardConstraints: string;
  generatedAt: string;
}

const clamp100 = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Cheap-tier blended $/1M tokens (DRACO: route DRACO-style work to a cheap model). */
const CHEAP_USD_PER_MTOK = 3;
/** Rough per-agent token budget for one harness run (analysis estimate). */
const TOKENS_PER_AGENT = 4000;

/**
 * Build the ADR-041 scorecard for a repo directory. Pure + no-exec (only reads
 * high-signal files via inventory). `generatedAt` is injected for determinism.
 */
export function buildRepoScorecard(dir: string, generatedAt: string = new Date().toISOString()): RepoScorecard {
  const files = inventory(dir);
  // Prefer the package.json name (more meaningful than a temp/checkout dir name);
  // fall back to the directory basename.
  let name = basename(resolve(dir)) || 'repo';
  try {
    const pkgName = files['package.json'] ? (JSON.parse(files['package.json']) as { name?: string }).name : undefined;
    if (pkgName && pkgName.length > 0) name = pkgName;
  } catch {
    /* keep basename */
  }
  const profile = analyzeFiles(name, files);
  const plan: HarnessPlan = recommendPlan(profile, ruvllmSemantic(profile));

  // Harness fit — how confidently the recommended archetype matches this repo.
  const harnessFit = clamp100(plan.confidence * 100);

  // Compile confidence — signals a generated harness will build/run cleanly:
  // a detected language is the floor; build + test commands + CI raise it.
  const compileConfidence = clamp100(
    (profile.languages.length ? 40 : 12) +
      (profile.buildCommands.length ? 25 : 0) +
      (profile.testCommands.length ? 25 : 0) +
      (profile.hasCi ? 10 : 0),
  );

  // Task coverage — how much observable work surface THIS REPO presents for a
  // harness to cover. Derived from real repo signals only (#171): the previous
  // formula multiplied the chosen archetype's plan size (a constant per
  // template), so an empty dir that fell through to a larger fallback plan
  // outscored a real project mapped to a smaller one, and adding tests/CI could
  // LOWER the score by switching templates. Grounding it in repo signals makes
  // it monotonic in the repo — more code, tests, CI, and docs never lower it.
  const hasDocs = Object.keys(files).some((f) => /(^|\/)readme|\.md$/i.test(f));
  const taskCoverage = clamp100(
    Math.min(profile.tokens.length, 30) * 2 + // repo work-vocabulary breadth (0-60)
      (profile.languages.length ? 12 : 0) + // a detected implementation language
      (profile.testCommands.length ? 12 : 0) + // tests define coverable work
      (profile.buildCommands.length ? 8 : 0) + // a build step to wire around
      (profile.hasCi ? 8 : 0) + // CI to hook into
      (hasDocs ? 6 : 0), // docs describing the work
  );

  // Tool safety — the default-deny policy posture, minus MCP exposure.
  //
  // Dream Cycle 2026-09-10 (generator-genome): `plan.policy` is ALWAYS the
  // hardcoded `SAFE` constant (recommendPlan() never derives it from the
  // repo — see analyze-repo.ts), so every branch below the first `let safety`
  // line used to evaluate IDENTICALLY on every call, for every repo: the
  // policy-posture credit was a constant +100, and the only variation came
  // from a single binary `plan.mcp === 'remote'` check (-10). Since none of
  // the 8 archetypes ever recommend `mcp: 'off'` (recommendPlan.ARCHETYPES),
  // that meant `toolSafety` could only ever be 90 or 100 for ANY input
  // repository — a scorecard dimension that claimed to measure "the tool
  // safety posture of this repo's recommended design" but in practice never
  // measured the repo at all, for 7 of 8 archetypes. `scoreMcpRisk()`
  // (genome-scorers.ts, already used by `harness genome`) computes the exact
  // same (profile, plan) inputs into a 4-way-differentiated 0..1 exposure
  // signal (off / local_default_deny / local_permissive / remote) instead of
  // a single binary check — reused here rather than reinventing a coarser
  // one. The always-safe default-deny credit itself is not a bug (every
  // generated harness genuinely does scaffold default-deny — ADR-022) and is
  // unchanged.
  const p = plan.policy;
  let safety = 0;
  if (p.defaultDeny) safety += 35;
  if (!p.allowShell) safety += 15;
  if (!p.allowNetwork) safety += 10;
  if (!p.allowFileWrite) safety += 10;
  if (p.requireApprovalForDangerous) safety += 15;
  if (p.auditLog) safety += 15;
  const mcpExposure = scoreMcpRisk(profile, plan); // { surface, numeric: 0..1 }
  safety -= Math.round(mcpExposure.numeric * 30); // scale the shared MCP-risk signal onto a 0..30-pt deduction
  const toolSafety = clamp100(safety);

  // Memory usefulness — repo scale: more files / languages / distinct tokens →
  // a persistent memory layer pays off more.
  const fileCount = Object.keys(files).length;
  const memoryUsefulness = clamp100(
    Math.min(fileCount, 30) * 2 + profile.languages.length * 5 + Math.min(profile.tokens.length, 25),
  );

  // Est. $/run — agents × per-agent budget at the cheap tier (DRACO routing).
  const estTokens = (plan.agents.length || 1) * TOKENS_PER_AGENT;
  const estCostPerRunUsd = round3((estTokens / 1_000_000) * CHEAP_USD_PER_MTOK);

  const recommendedMode: RepoScorecard['recommendedMode'] = plan.mcp === 'off' ? 'CLI' : 'CLI + MCP';

  // ADR-041 validation stage — hard/soft constraints over the recommended design.
  const cs = summarise(checkConstraints(profile, plan));

  return {
    schema: 1,
    repo: name,
    harnessFit,
    compileConfidence,
    taskCoverage,
    toolSafety,
    memoryUsefulness,
    estCostPerRunUsd,
    recommendedMode,
    archetype: plan.archetypeId,
    template: plan.template,
    scaffoldReady: cs.allHardPass,
    hardConstraints: `${cs.hardPassed}/${cs.hardTotal}`,
    generatedAt,
  };
}

/** Format the scorecard as the ADR-041 6-line card. */
export function formatRepoScorecard(sc: RepoScorecard): string[] {
  return [
    `Scorecard — ${sc.repo}  (best-fit archetype: ${sc.archetype})`,
    ``,
    `  Harness fit:        ${sc.harnessFit}/100`,
    `  Compile confidence: ${sc.compileConfidence}/100`,
    `  Task coverage:      ${sc.taskCoverage}/100`,
    `  Tool safety:        ${sc.toolSafety}/100`,
    `  Memory usefulness:  ${sc.memoryUsefulness}/100`,
    `  Est. cost per run:  $${sc.estCostPerRunUsd.toFixed(3)}`,
    `  Recommended mode:   ${sc.recommendedMode}  (template ${sc.template})`,
    `  Constraints:        ${sc.hardConstraints} hard ${sc.scaffoldReady ? '✓ scaffold-ready' : '✗ blocked — run with --constraints'}`,
  ];
}

/** One candidate harness design (ADR-041 candidate-generation / beam stage). */
export interface CandidateScore {
  archetype: string;
  label: string;
  template: string;
  harnessFit: number;
  recommendedMode: 'CLI' | 'CLI + MCP';
}

/**
 * The top-N candidate harness designs for a repo, each scored — the beam-search
 * candidate-generation stage of ADR-041 over the archetype library. Lets the user
 * see the alternatives, not just the single recommendation.
 */
export function topCandidates(dir: string, n = 3): CandidateScore[] {
  const files = inventory(dir);
  let name = basename(resolve(dir)) || 'repo';
  try {
    const pkgName = files['package.json'] ? (JSON.parse(files['package.json']) as { name?: string }).name : undefined;
    if (pkgName) name = pkgName;
  } catch {
    /* keep basename */
  }
  const profile = analyzeFiles(name, files);
  return scoreArchetypes(profile, ruvllmSemantic(profile))
    .slice(0, Math.max(1, n))
    .map((s) => ({
      archetype: s.archetype.id,
      label: s.archetype.label,
      template: s.archetype.template,
      harnessFit: clamp100(s.confidence * 100),
      recommendedMode: (s.archetype.mcp === 'off' ? 'CLI' : 'CLI + MCP') as CandidateScore['recommendedMode'],
    }));
}

/** Full constraint report for a repo's recommended design (ADR-041 validation). */
export function repoConstraints(dir: string): { repo: string; results: ReturnType<typeof checkConstraints> } {
  const files = inventory(dir);
  let name = basename(resolve(dir)) || 'repo';
  try {
    const pkgName = files['package.json'] ? (JSON.parse(files['package.json']) as { name?: string }).name : undefined;
    if (pkgName) name = pkgName;
  } catch {
    /* keep basename */
  }
  const profile = analyzeFiles(name, files);
  const plan = recommendPlan(profile, ruvllmSemantic(profile));
  return { repo: name, results: checkConstraints(profile, plan) };
}

/** Format the top-N candidates as a ranked list. */
export function formatCandidates(repo: string, cands: CandidateScore[]): string[] {
  return [
    `Top ${cands.length} harness designs — ${repo}`,
    ``,
    ...cands.map((c, i) => `  ${i + 1}. ${c.label.padEnd(22)} fit ${String(c.harnessFit).padStart(3)}/100  ${c.recommendedMode.padEnd(9)}  (${c.template})`),
  ];
}

function usage(): string[] {
  return [
    'Usage: metaharness score <repo-path> [--json] [--top N]',
    '',
    'Produces the ADR-041 scorecard: harness fit, compile confidence, task',
    'coverage, tool safety, memory usefulness, est. $/run, recommended mode.',
    '--top N lists the N best-fit harness designs (candidate generation).',
    'No-exec: only reads high-signal files; never runs repo code.',
  ];
}

/** CLI: `metaharness score <repo> [--json]`. Mirrors genomeCmd's shape. */
export async function scoreRepoCmd(args: string[]): Promise<SubcommandResult> {
  const json = args.includes('--json');
  const positional: string[] = [];
  let topN: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json' || a === '--constraints') continue;
    if (a === '--help' || a === '-h') return { code: 0, lines: usage() };
    if (a === '--top') {
      const v = parseInt(args[++i] ?? '', 10);
      if (!Number.isFinite(v) || v < 1) {
        const err = { schema: 1 as const, error: 'invalid-top', exitCode: 2 };
        return { code: 2, lines: [json ? JSON.stringify(err, null, 2) : '--top requires a positive integer'] };
      }
      topN = v;
      continue;
    }
    if (a.startsWith('--')) {
      const err = { schema: 1 as const, error: `unknown-flag-${a.replace(/^--?/, '')}`, exitCode: 2 };
      return { code: 2, lines: [json ? JSON.stringify(err, null, 2) : `Unknown flag: ${a}`] };
    }
    positional.push(a);
  }
  if (positional.length === 0) return { code: 2, lines: usage() };

  const dir = resolve(positional[0]!);
  const showConstraints = args.includes('--constraints');
  try {
    // #171 — a directory with no inventoried signal is not scoreable. Refuse
    // rather than emit a full scorecard, recommended archetype, and cost
    // estimate for a repo that isn't there.
    if (Object.keys(inventory(dir)).length === 0) {
      const err = { schema: 1 as const, error: 'empty-repo', detail: 'no scoreable files found in target directory', exitCode: 2 };
      return { code: 2, lines: [json ? JSON.stringify(err, null, 2) : `Nothing to score: no scoreable files found in ${dir}`] };
    }
    if (showConstraints) {
      const { repo, results } = repoConstraints(dir);
      const s = summarise(results);
      return {
        code: s.allHardPass ? 0 : 1, // non-zero exit when a hard constraint fails (CI gate)
        lines: json ? [JSON.stringify({ schema: 1, repo, summary: { ...s, failures: undefined }, results }, null, 2)] : formatConstraints(results),
      };
    }
    if (topN != null) {
      const cands = topCandidates(dir, topN);
      const repo = (() => {
        try {
          const f = inventory(dir)['package.json'];
          return (f && (JSON.parse(f) as { name?: string }).name) || basename(dir);
        } catch {
          return basename(dir);
        }
      })();
      return { code: 0, lines: json ? [JSON.stringify({ schema: 1, repo, candidates: cands }, null, 2)] : formatCandidates(repo, cands) };
    }
    const sc = buildRepoScorecard(dir);
    return { code: 0, lines: json ? [JSON.stringify(sc, null, 2)] : formatRepoScorecard(sc) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const e = { schema: 1 as const, error: 'score-failed', detail: msg, exitCode: 1 };
    return { code: 1, lines: [json ? JSON.stringify(e, null, 2) : `score failed: ${msg}`] };
  }
}
