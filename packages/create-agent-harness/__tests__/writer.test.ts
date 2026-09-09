// SPDX-License-Identifier: MIT
// Regression tests for the atomic writer, incl. GH #42 (Windows EXDEV: staging
// must not depend on os.tmpdir() being on the same drive as the target).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../src/writer.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'writer-test-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /**/ } });

const files = [
  { path: 'package.json', content: '{"name":"x"}', rendered: false, unresolved: [] },
  { path: 'src/index.ts', content: 'export const x = 1;\n', rendered: false, unresolved: [] },
];

describe('writeAtomic', () => {
  it('writes all files under the target', async () => {
    const target = join(root, 'proj');
    const written = await writeAtomic(target, files);
    expect(written).toEqual(['package.json', 'src/index.ts']);
    expect(readFileSync(join(target, 'package.json'), 'utf-8')).toContain('"name":"x"');
    expect(readFileSync(join(target, 'src/index.ts'), 'utf-8')).toContain('export const x');
  });

  it('GH #42: stages adjacent to the target and leaves no staging residue', async () => {
    const target = join(root, 'proj');
    await writeAtomic(target, files);
    // the staging dir (.create-agent-harness-*) lived in the target's PARENT
    // (same drive), not os.tmpdir(); after success it must be gone (renamed in).
    const residue = readdirSync(root).filter(n => n.startsWith('.create-agent-harness-'));
    expect(residue).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses to overwrite an existing target without force', async () => {
    const target = join(root, 'proj');
    await writeAtomic(target, files);
    await expect(writeAtomic(target, files)).rejects.toThrow(/already exists/);
  });

  it('overwrites with force and cleans up staging', async () => {
    const target = join(root, 'proj');
    await writeAtomic(target, files);
    const next = [{ path: 'package.json', content: '{"name":"y"}', rendered: false, unresolved: [] }];
    await writeAtomic(target, next, { force: true });
    expect(readFileSync(join(target, 'package.json'), 'utf-8')).toContain('"name":"y"');
    expect(existsSync(join(target, 'src/index.ts'))).toBe(false); // replaced, not merged
    expect(readdirSync(root).filter(n => n.startsWith('.create-agent-harness-'))).toEqual([]);
  });

  it('creates intermediate parent directories of the target', async () => {
    const target = join(root, 'a', 'b', 'proj');
    await writeAtomic(target, files);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });

  // Regression: RenderedFile.path is produced by whatever assembled the
  // RenderedFile[] (walkTemplate today; host-adapter generateConfig() output
  // in future wiring per ADR-046's injection-bug class), and writeAtomic
  // previously trusted it verbatim. A `../`-shaped path escaped the staging
  // dir via `join()`'s normalization and could write outside the intended
  // target directory entirely.
  describe('path traversal (ADR-046 bug class)', () => {
    it('refuses a file path that escapes the target directory', async () => {
      const target = join(root, 'proj');
      const escapee = randomTraversalName();
      const malicious = [
        { path: `../../../${escapee}`, content: 'pwned', rendered: false, unresolved: [] },
      ];
      await expect(writeAtomic(target, malicious)).rejects.toThrow(/outside the target directory/);
      expect(existsSync(join(root, escapee))).toBe(false);
      expect(existsSync(join(target, '..', '..', escapee))).toBe(false);
    });

    it('refuses a mixed batch (one safe file, one traversal) without writing either to the final target', async () => {
      const target = join(root, 'proj');
      const escapee = randomTraversalName();
      const mixed = [
        { path: 'package.json', content: '{"name":"x"}', rendered: false, unresolved: [] },
        { path: `../${escapee}`, content: 'pwned', rendered: false, unresolved: [] },
      ];
      await expect(writeAtomic(target, mixed)).rejects.toThrow(/outside the target directory/);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(join(root, escapee))).toBe(false);
    });

    it('refuses an absolute path', async () => {
      const target = join(root, 'proj');
      const absolute = [
        { path: '/etc/passwd-not-really', content: 'pwned', rendered: false, unresolved: [] },
      ];
      // An absolute-looking posix path still normalizes to *inside* staging
      // via join() (it is not treated as filesystem-root-absolute), so this
      // case documents that join()'s own normalization already denies the
      // classic "/etc/passwd" shape — the guard exists for the `../` shape,
      // which join() does NOT neutralize.
      const written = await writeAtomic(target, absolute);
      expect(written).toEqual(['/etc/passwd-not-really']);
      expect(existsSync(join(target, 'etc', 'passwd-not-really'))).toBe(true);
    });
  });
});

function randomTraversalName(): string {
  return `writer-traversal-${Math.random().toString(36).slice(2)}.txt`;
}
