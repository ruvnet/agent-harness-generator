// SPDX-License-Identifier: MIT
// ADR-041 scorecard tests — `metaharness score <repo>`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoScorecard, formatRepoScorecard, scoreRepoCmd, topCandidates } from '../src/repo-scorecard.js';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'scorecard-'));
  // a TypeScript SDK-ish repo with build + test + CI signals
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'acme-sdk',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { typescript: '^5', vitest: '^2' },
    }),
  );
  writeFileSync(join(repo, 'README.md'), '# acme-sdk\nA TypeScript SDK / npm client library for the Acme API.\n');
  mkdirSync(join(repo, '.github'), { recursive: true });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('buildRepoScorecard', () => {
  it('produces all six dimensions in 0..100 + a cost + a mode', () => {
    const sc = buildRepoScorecard(repo, '2026-06-15T00:00:00Z');
    for (const k of ['harnessFit', 'compileConfidence', 'taskCoverage', 'toolSafety', 'memoryUsefulness'] as const) {
      expect(sc[k]).toBeGreaterThanOrEqual(0);
      expect(sc[k]).toBeLessThanOrEqual(100);
    }
    expect(sc.estCostPerRunUsd).toBeGreaterThan(0);
    expect(['CLI', 'CLI + MCP']).toContain(sc.recommendedMode);
    expect(sc.repo).toBe('acme-sdk');
  });

  it('rewards build+test signals in compile confidence', () => {
    const withBuild = buildRepoScorecard(repo, 'x');
    // has language + build + test → should be high
    expect(withBuild.compileConfidence).toBeGreaterThanOrEqual(80);
  });

  it('is deterministic for the same repo + timestamp', () => {
    const a = buildRepoScorecard(repo, 'fixed');
    const b = buildRepoScorecard(repo, 'fixed');
    expect(a).toEqual(b);
  });

  it('default-deny policy yields high tool safety', () => {
    expect(buildRepoScorecard(repo, 'x').toolSafety).toBeGreaterThanOrEqual(70);
  });
});

// Dream Cycle 2026-09-10 (generator-genome): before this fix, `toolSafety` was
// computed from `plan.policy`, which recommendPlan() always hardcodes to the
// same `SAFE` constant regardless of the repo — so the whole policy-posture
// branch always evaluated identically, and since no archetype ever recommends
// `mcp: 'off'`, the ONLY variation possible was a binary `plan.mcp === 'remote'`
// check (-10). toolSafety could only ever be 90 or 100, for any repository.
describe('toolSafety actually differentiates MCP exposure (Dream Cycle 2026-09-10)', () => {
  function fixture(opts: { name: string; readme: string; mcpJson?: boolean }): string {
    const dir = mkdtempSync(join(tmpdir(), `sc-toolsafety-${opts.name}-`));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: opts.name }));
    writeFileSync(join(dir, 'README.md'), opts.readme);
    if (opts.mcpJson) {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'npx' } } }));
    }
    return dir;
  }

  it('BUG REPRO (pre-fix would both read 90/100 — a 10-pt gap): a repo whose best-fit archetype is mcp-server-harness (remote MCP) scores measurably lower toolSafety than a repo with no MCP signal at all', () => {
    const mcpRepo = fixture({
      name: 'mcp-tool-server',
      readme: 'An MCP server exposing tools via protocol json rpc stdio streamable http resources prompts.',
      mcpJson: true,
    });
    const sdkRepo = fixture({
      name: 'acme-sdk',
      readme: 'A TypeScript SDK client library for the Acme API.',
    });
    const mcpSc = buildRepoScorecard(mcpRepo, 'x');
    const sdkSc = buildRepoScorecard(sdkRepo, 'x');
    expect(mcpSc.archetype).toBe('mcp-server-harness');
    expect(sdkSc.archetype).toBe('typescript-sdk-harness');
    // Real measured values post-fix (Dream Cycle 2026-09-10 evidence run):
    // mcp-server-harness → 82, typescript-sdk-harness → 95 (gap 13).
    // Pre-fix these were 90 and 100 (gap 10) for EVERY repo pair with this
    // archetype split — a fixed, repo-independent constant, not a measurement.
    expect(mcpSc.toolSafety).toBe(82);
    expect(sdkSc.toolSafety).toBe(95);
    expect(sdkSc.toolSafety - mcpSc.toolSafety).toBeGreaterThan(10); // was exactly 10 pre-fix, always
    expect([mcpSc.toolSafety, sdkSc.toolSafety]).not.toEqual([90, 100]); // the old constant pair
  });

  it('toolSafety stays in range and the default-deny credit is unaffected for a plain repo with zero MCP signal', () => {
    const dir = fixture({ name: 'plain-lib', readme: 'A small utility library with no tool integrations.' });
    const sc = buildRepoScorecard(dir, 'x');
    expect(sc.toolSafety).toBeGreaterThanOrEqual(0);
    expect(sc.toolSafety).toBeLessThanOrEqual(100);
    expect(sc.toolSafety).toBeGreaterThanOrEqual(90); // still high — default-deny credit is real and unchanged
  });
});

describe('taskCoverage measures the repo, not the template (#171)', () => {
  let empty: string;
  let real: string;
  let bare: string;
  let withTests: string;
  beforeAll(() => {
    empty = mkdtempSync(join(tmpdir(), 'sc-empty-'));

    // a real project: source + tests + CI + README + manifest
    real = mkdtempSync(join(tmpdir(), 'sc-real-'));
    mkdirSync(join(real, 'src'), { recursive: true });
    mkdirSync(join(real, 'tests'), { recursive: true });
    mkdirSync(join(real, '.github', 'workflows'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(real, 'src', `mod${i}.py`), `def f${i}(x):\n    return x * ${i}\n`);
    for (let i = 0; i < 10; i++) writeFileSync(join(real, 'tests', `test_${i}.py`), `def test_${i}():\n    assert True\n`);
    writeFileSync(join(real, '.github', 'workflows', 'ci.yml'), 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pytest\n');
    writeFileSync(join(real, 'README.md'), '# real\nA Python data-processing service with a REST API and a worker queue.\n');
    writeFileSync(join(real, 'package.json'), JSON.stringify({ name: 'real-proj', scripts: { test: 'pytest', build: 'python -m build' } }));

    // the same repo WITHOUT tests + CI — adding them must not lower coverage
    bare = mkdtempSync(join(tmpdir(), 'sc-bare-'));
    mkdirSync(join(bare, 'src'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(bare, 'src', `mod${i}.py`), `def f${i}(x):\n    return x * ${i}\n`);
    writeFileSync(join(bare, 'README.md'), '# bare\nA Python data-processing service with a REST API and a worker queue.\n');
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'bare-proj' }));

    withTests = mkdtempSync(join(tmpdir(), 'sc-tests-'));
    mkdirSync(join(withTests, 'src'), { recursive: true });
    mkdirSync(join(withTests, 'tests'), { recursive: true });
    mkdirSync(join(withTests, '.github', 'workflows'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(withTests, 'src', `mod${i}.py`), `def f${i}(x):\n    return x * ${i}\n`);
    for (let i = 0; i < 10; i++) writeFileSync(join(withTests, 'tests', `test_${i}.py`), `def test_${i}():\n    assert True\n`);
    writeFileSync(join(withTests, '.github', 'workflows', 'ci.yml'), 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pytest\n');
    writeFileSync(join(withTests, 'README.md'), '# bare\nA Python data-processing service with a REST API and a worker queue.\n');
    writeFileSync(join(withTests, 'package.json'), JSON.stringify({ name: 'bare-proj', scripts: { test: 'pytest' } }));
  });
  afterAll(() => {
    for (const d of [empty, real, bare, withTests]) rmSync(d, { recursive: true, force: true });
  });

  it('a real project with source/tests/CI outscores an empty dir on task coverage', () => {
    const realCov = buildRepoScorecard(real, 'x').taskCoverage;
    // empty is refused by the CLI, but the pure function still scores it — it must be ~0
    const emptyCov = buildRepoScorecard(empty, 'x').taskCoverage;
    expect(emptyCov).toBeLessThan(realCov);
    expect(emptyCov).toBeLessThanOrEqual(5);
  });

  it('adding tests + CI never LOWERS task coverage', () => {
    const before = buildRepoScorecard(bare, 'x').taskCoverage;
    const after = buildRepoScorecard(withTests, 'x').taskCoverage;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('the CLI refuses an empty directory instead of emitting a scorecard', async () => {
    const r = await scoreRepoCmd([empty]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/[Nn]othing to score/);
  });

  it('--json refusal for an empty directory carries the empty-repo error code', async () => {
    const r = await scoreRepoCmd([empty, '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.lines.join('\n')).error).toBe('empty-repo');
  });
});

describe('formatRepoScorecard', () => {
  it('renders the 6-line card', () => {
    const lines = formatRepoScorecard(buildRepoScorecard(repo, 'x'));
    const joined = lines.join('\n');
    expect(joined).toMatch(/Harness fit:/);
    expect(joined).toMatch(/Compile confidence:/);
    expect(joined).toMatch(/Task coverage:/);
    expect(joined).toMatch(/Tool safety:/);
    expect(joined).toMatch(/Memory usefulness:/);
    expect(joined).toMatch(/Est\. cost per run:\s+\$/);
    expect(joined).toMatch(/Recommended mode:/);
  });
});

describe('topCandidates (beam / candidate generation)', () => {
  it('returns N ranked candidates, each with a fit score and mode', () => {
    const cands = topCandidates(repo, 3);
    expect(cands.length).toBe(3);
    // ranked descending by fit
    expect(cands[0].harnessFit).toBeGreaterThanOrEqual(cands[1].harnessFit);
    expect(cands[1].harnessFit).toBeGreaterThanOrEqual(cands[2].harnessFit);
    for (const c of cands) {
      expect(c.harnessFit).toBeGreaterThanOrEqual(0);
      expect(c.harnessFit).toBeLessThanOrEqual(100);
      expect(['CLI', 'CLI + MCP']).toContain(c.recommendedMode);
      expect(c.template).toBeTruthy();
    }
  });
});

describe('scoreRepoCmd', () => {
  it('exits 0 and prints the card for a valid repo', async () => {
    const r = await scoreRepoCmd([repo]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/Harness fit:/);
  });
  it('--json emits valid parseable JSON with schema 1', async () => {
    const r = await scoreRepoCmd([repo, '--json']);
    expect(r.code).toBe(0);
    const sc = JSON.parse(r.lines.join('\n'));
    expect(sc.schema).toBe(1);
    expect(sc.recommendedMode).toBeTruthy();
  });
  it('no path → usage, exit 2', async () => {
    const r = await scoreRepoCmd([]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Usage: metaharness score/);
  });
  it('--help → exit 0 usage', async () => {
    expect((await scoreRepoCmd(['--help'])).code).toBe(0);
  });
  it('--top 2 lists 2 candidate designs', async () => {
    const r = await scoreRepoCmd([repo, '--top', '2']);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/Top 2 harness designs/);
  });
  it('--top with bad value → exit 2', async () => {
    expect((await scoreRepoCmd([repo, '--top', 'x'])).code).toBe(2);
  });
});
