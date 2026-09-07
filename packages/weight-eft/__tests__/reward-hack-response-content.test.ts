// SPDX-License-Identifier: MIT
//
// Tests for the reward-hack monitor's response-content scan (2026-09-07 Dream Cycle):
// a trajectory whose outgoing tool-CALL arguments carry no leak signal, but whose
// tool-RESPONSE content does, must still be flagged. Prior to this fix, `detectRewardHack`
// only scanned `role:'assistant'` tool_calls[].function.arguments — a `role:'tool'` message's
// `content` (what the tool actually returned) was never inspected.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectRewardHack, isRewardHacked } from '../src/reward-hack.js';
import { exportTrainingData } from '../src/export.js';
import type { DarwinTrajectory } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const archive = JSON.parse(
  readFileSync(join(here, 'fixtures', 'reward-hack-response-content.json'), 'utf8'),
) as DarwinTrajectory[];

const byId = (id: string) => archive.find((t) => t.instance_id === id)!;

describe('reward-hack monitor — tool-response content scan', () => {
  const leak = byId('cheater__cheater-response-leak');
  const clean = byId('honest__honest-response-clean');

  it('the leaking trajectory\'s own tool-CALL arguments carry no gold-read signal', () => {
    // Non-vacuousness check: if the call arguments alone already matched, this fixture
    // would not exercise the new response-content path at all.
    const callArgsOnly = leak.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.tool_calls ?? [])
      .map((tc) => tc.function.arguments)
      .join('\n');
    expect(/gold_patch|FAIL_TO_PASS|PASS_TO_PASS|test_patch/i.test(callArgsOnly)).toBe(false);
  });

  it('flags the leak via the tool RESPONSE content (kind: gold-read)', () => {
    const findings = detectRewardHack(leak);
    expect(findings.some((f) => f.kind === 'gold-read' && f.tool === 'grep')).toBe(true);
    expect(isRewardHacked(leak)).toBe(true);
  });

  it('does not flag a trajectory whose tool responses are clean', () => {
    expect(detectRewardHack(clean)).toEqual([]);
    expect(isRewardHacked(clean)).toBe(false);
  });

  it('the exporter drops the response-leak trajectory and keeps the clean one', () => {
    const { report, sft } = exportTrainingData(archive, { evalHoldout: [] });
    expect(report.droppedRewardHacked).toBe(1);
    expect(report.sftInstanceIds).toEqual(['honest__honest-response-clean']);
    expect(sft.some((r) => r.messages.some((m) => (m.content ?? '').includes('FAIL_TO_PASS')))).toBe(false);
  });
});
