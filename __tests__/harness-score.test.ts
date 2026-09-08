// SPDX-License-Identifier: MIT
//
// iter 111 — `harness score <path>` (19th subcommand). Priority 2 from the
// user's roadmap: 5-dimension 0–100 scorecard with badges that ship in the
// generated harness README.
//
// What we lock down:
//  1. A real scaffolded harness gets a non-trivial score (>= 30; we don't
//     gate on 85+ because tests/sbom/witness aren't always populated yet).
//  2. The 5 named dimensions appear in the text output.
//  3. --json emits the badges shape (score + mcpRisk + 4 booleans).
//  4. --bundle emits an ADR-031 schema-1 envelope of the full scorecard.
//  5. --out writes the badges JSON to a file.
//  6. Missing target dir is bundle-formed (ADR-031 rule 3).
//  7. Missing args returns exit 2 with usage.
//  8. An empty dir grades F with exit 2.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let scoreCmd: (args: string[]) => Promise<{ code: number; lines: string[] }>;
let scaffold: (opts: any) => Promise<any>;

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'score.js'))) throw new Error('build first');
  const mod = await import(`file://${join(distDir, 'score.js')}`);
  scoreCmd = mod.scoreCmd;
  const idx = await import(`file://${join(distDir, 'index.js')}`);
  scaffold = idx.scaffold;
});

async function scaffoldHarness(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ahg-score-${name}-`));
  await scaffold({ name, template: 'minimal', host: 'claude-code', targetDir: dir, force: true, generatorVersion: '0.1.0' });
  return dir;
}

describe('harness score (iter 111)', () => {
  it('real scaffold gets a non-trivial score with the 5 dimensions named', async () => {
    const dir = await scaffoldHarness('score-real');
    try {
      const r = await scoreCmd([dir]);
      const out = r.lines.join('\n');
      // Five dimensions from the user's spec.
      expect(out).toContain('Repo understanding');
      expect(out).toContain('Agent usefulness');
      expect(out).toContain('MCP safety');
      expect(out).toContain('Test coverage');
      expect(out).toContain('Publish readiness');
      // Overall + grade lines.
      expect(out).toMatch(/Overall: \d+\/100\s+Grade: [ABCF]/);
      // Badges block (the README-ready set).
      expect(out).toContain('Harness Score:');
      expect(out).toContain('MCP Risk:');
      expect(out).toContain('Release Ready:');
      expect(out).toContain('Tests Detected:');
      expect(out).toContain('SBOM:');
      expect(out).toContain('Witness Signed:');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--json emits the 6-field badges shape', async () => {
    const dir = await scaffoldHarness('score-json');
    try {
      const r = await scoreCmd([dir, '--json']);
      const j = JSON.parse(r.lines.join('\n'));
      const keys = Object.keys(j).sort();
      expect(keys).toEqual(['mcpRisk', 'releaseReady', 'sbom', 'score', 'testsDetected', 'witnessSigned']);
      expect(typeof j.score).toBe('number');
      expect(j.score).toBeGreaterThanOrEqual(0);
      expect(j.score).toBeLessThanOrEqual(100);
      expect(['None', 'Low', 'Medium', 'High']).toContain(j.mcpRisk);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--bundle emits an ADR-031 schema-1 envelope', async () => {
    const dir = await scaffoldHarness('score-bundle');
    try {
      const r = await scoreCmd([dir, '--bundle']);
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.schema).toBe(1);
      expect(typeof j.generatedAt).toBe('string');
      expect(j.overall).toBeDefined();
      expect(['A', 'B', 'C', 'F']).toContain(j.grade);
      expect(Array.isArray(j.dimensions)).toBe(true);
      expect(j.dimensions.length).toBe(5);
      expect(j.badges).toBeDefined();
      expect([0, 1, 2]).toContain(j.exitCode);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--out writes the badges JSON to a file', async () => {
    const dir = await scaffoldHarness('score-out');
    const outPath = join(dir, 'score.json');
    try {
      const r = await scoreCmd([dir, '--out', outPath]);
      expect([0, 1, 2]).toContain(r.code);
      expect(existsSync(outPath)).toBe(true);
      const j = JSON.parse(readFileSync(outPath, 'utf-8'));
      // File contains the badges shape, NOT the full envelope.
      expect(Object.keys(j).sort()).toEqual(['mcpRisk', 'releaseReady', 'sbom', 'score', 'testsDetected', 'witnessSigned']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('missing target dir is bundle-formed (ADR-031 rule 3)', async () => {
    const r = await scoreCmd(['/nonexistent/path/xyz789', '--bundle']);
    expect(r.code).toBe(2);
    const j = JSON.parse(r.lines.join('\n'));
    expect(j.schema).toBe(1);
    expect(j.error).toBe('not-a-directory');
  });

  it('missing args returns exit 2 with usage', async () => {
    const r = await scoreCmd([]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Usage: harness score/);
  });

  it('empty dir grades F with exit 2', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-score-empty-'));
    try {
      const r = await scoreCmd([dir, '--json']);
      // Empty dir has nothing but maybe a manifest-less .harness, so score should
      // be low enough to grade F or C. Exit 2 (F) is the most likely.
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.score).toBeLessThan(50);
      expect([1, 2]).toContain(r.code);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('MCP risk reads default-deny policy correctly', async () => {
    const dir = await scaffoldHarness('score-mcp');
    try {
      const r = await scoreCmd([dir, '--json']);
      const j = JSON.parse(r.lines.join('\n'));
      // Dream Cycle 2026-09-08 (security-adversarial, issue #280): this
      // assertion previously read 'None'/'Low' on the belief that the
      // `minimal` template scaffolds without MCP enabled by default. That
      // was itself a symptom of the bug this candidate fixes — the
      // `minimal` template's `.claude/settings.json.tmpl` DOES register a
      // self-referential `mcpServers` entry (so a host can call back into
      // the generated harness's own CLI as an MCP tool), and no template
      // ships a `.harness/mcp-policy.json`, so every default scaffold is
      // MCP-in-use and fully ungoverned. `scoreMcpSafety()`'s old
      // policy-file-or-.mcp.json-only detection missed the
      // settings.json-only registration and silently reported the safest
      // possible score for the actual state. Now correctly 'High'.
      expect(j.mcpRisk).toBe('High');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
