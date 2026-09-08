// SPDX-License-Identifier: MIT
//
// Dream Cycle 2026-09-08 (security-adversarial), closing issue #280: the
// same narrow MCP-detection gap PR #276 (2026-09-03) closed in
// threat-model.ts also existed in `scoreMcpSafety()` (score.ts) — `hasMcp`
// only checked `.harness/mcp-policy.json` and `.mcp.json`, missing
// `.claude/settings.json`'s `mcpServers` key. A harness that registers MCP
// only through `.claude/settings.json` was scored as the SAFEST possible
// posture (`mcpRisk: 'None'`, MCP-safety score 100) even though a real,
// ungoverned MCP server was present — the false negative feeds directly
// into publish-readiness / overall scoring. Fixed by routing `hasMcp`
// through `scanMcp()`'s `mcpEnabled`, the one place all 3 valid
// registration surfaces are already OR'd together (see mcp-scan.ts).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScorecard } from '../src/score.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(opts: {
  policy?: Record<string, unknown> | null;
  mcpJson?: boolean;
  settingsMcpServers?: Record<string, unknown> | null;
}): string {
  const d = mkdtempSync(join(tmpdir(), 'score-mcp-detect-'));
  dirs.push(d);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  if (opts.policy) {
    mkdirSync(join(d, '.harness'), { recursive: true });
    writeFileSync(join(d, '.harness', 'mcp-policy.json'), JSON.stringify(opts.policy));
  }
  if (opts.mcpJson) {
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { bot: { command: 'npx' } } }));
  }
  if (opts.settingsMcpServers) {
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ mcpServers: opts.settingsMcpServers }));
  }
  return d;
}

function mcpDim(sc: ReturnType<typeof buildScorecard>) {
  const d = sc.dimensions.find((x) => x.name === 'MCP safety');
  if (!d) throw new Error('MCP safety dimension not found');
  return d as typeof d & { mcpRisk: 'None' | 'Low' | 'Medium' | 'High' };
}

describe('scoreMcpSafety — MCP-in-use detection covers all 3 registration surfaces (issue #280)', () => {
  it('no policy, no .mcp.json, no settings mcpServers: correctly None (true negative, unaffected by the fix)', () => {
    const d = fixture({});
    const sc = buildScorecard(d);
    const mcp = mcpDim(sc);
    expect(mcp.mcpRisk).toBe('None');
    expect(mcp.score).toBe(100);
    expect(sc.badges.mcpRisk).toBe('None');
  });

  it('BUG REPRO (pre-fix would score mcpRisk:"None"/100): .claude/settings.json-only MCP registration is detected as in-use and ungoverned', () => {
    const d = fixture({ settingsMcpServers: { bot: { command: 'npx' } } });
    const sc = buildScorecard(d);
    const mcp = mcpDim(sc);
    expect(mcp.mcpRisk).not.toBe('None');
    expect(mcp.mcpRisk).toBe('High'); // no .harness/mcp-policy.json => default-deny OFF
    expect(mcp.score).not.toBe(100);
    expect(mcp.signals).not.toContain('MCP not in use (mode=off — safest)');
    expect(sc.badges.mcpRisk).toBe('High');
  });

  it('.mcp.json-only registration (no settings.json) still detected as in-use (regression guard, not touched by this fix)', () => {
    const d = fixture({ mcpJson: true });
    const sc = buildScorecard(d);
    expect(mcpDim(sc).mcpRisk).not.toBe('None');
  });

  it('a compliant .harness/mcp-policy.json is unaffected by the fix — still scores fully governed', () => {
    const d = fixture({
      policy: { defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false },
    });
    const sc = buildScorecard(d);
    const mcp = mcpDim(sc);
    expect(mcp.mcpRisk).toBe('Low');
    expect(mcp.score).toBe(100); // 40+15+15+15+15 — fully compliant policy
  });

  it('policy present AND settings.json also registers MCP: no double-counting, still exactly the policy-derived score', () => {
    const d = fixture({
      policy: { defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false },
      settingsMcpServers: { bot: { command: 'npx' } },
    });
    const sc = buildScorecard(d);
    const mcp = mcpDim(sc);
    expect(mcp.mcpRisk).toBe('Low');
    expect(mcp.score).toBe(100);
  });
});
