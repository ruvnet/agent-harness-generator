// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { evaluateExecutionUnlearningLifecycle, type HostStateInventory } from '../src/unlearning.js';

const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);

function inventory(overrides: Partial<HostStateInventory> = {}): HostStateInventory {
  return {
    hostId: 'codex',
    hostVersion: '1.0.0',
    runtimeDigest: D3,
    surfaces: [
      { id: 'ctx', kind: 'model-context', observable: true, purgeable: true, replayable: true, remote: false },
      { id: 'retrieval', kind: 'retrieval-cache', observable: true, purgeable: true, replayable: true, remote: false },
      { id: 'tools', kind: 'tool-session', observable: true, purgeable: true, replayable: false, remote: false },
    ],
    ...overrides,
  };
}

function input(inv: HostStateInventory = inventory()) {
  return {
    coreMemoryPlanDigest: D1,
    coreMemoryReceiptDigest: D2,
    inventory: inv,
    purgedSurfaceIds: inv.surfaces.filter((s) => s.purgeable).map((s) => s.id),
    replayedSurfaceIds: inv.surfaces.filter((s) => s.replayable).map((s) => s.id),
    probeResults: [
      { id: 'p-explicit', kind: 'explicit' as const, leaked: false, evidenceDigest: D1 },
      { id: 'p-resume', kind: 'resume' as const, leaked: false, evidenceDigest: D2 },
    ],
    utilityBefore: 0.9,
    utilityAfter: 0.89,
  };
}

describe('execution unlearning lifecycle', () => {
  it('returns PASS only when declared state is observable, purged, replayed, and probes are clean', () => {
    const receipt = evaluateExecutionUnlearningLifecycle(input());
    expect(receipt.status).toBe('PASS');
    expect(receipt.authority).toBe('none');
    expect(receipt.leakedProbeIds).toEqual([]);
    expect(receipt.missingPurgeSurfaceIds).toEqual([]);
    expect(receipt.missingReplaySurfaceIds).toEqual([]);
    expect(receipt.utilityDelta).toBe(-0.01);
  });

  it('returns INCOMPLETE for opaque remote provider state instead of claiming success', () => {
    const inv = inventory({
      surfaces: [
        ...inventory().surfaces,
        { id: 'provider', kind: 'provider-cache', observable: false, purgeable: false, replayable: false, remote: true },
      ],
    });
    const receipt = evaluateExecutionUnlearningLifecycle(input(inv));
    expect(receipt.status).toBe('INCOMPLETE');
    expect(receipt.unobservableSurfaceIds).toEqual(['provider']);
    expect(receipt.unpurgeableSurfaceIds).toEqual(['provider']);
  });

  it('returns FAIL when a probe leaks after cleanup', () => {
    const value = input();
    value.probeResults = [{ id: 'p-tool', kind: 'tool', leaked: true, evidenceDigest: D1 }];
    const receipt = evaluateExecutionUnlearningLifecycle(value);
    expect(receipt.status).toBe('FAIL');
    expect(receipt.leakedProbeIds).toEqual(['p-tool']);
  });

  it('returns FAIL when a purgeable surface was not purged', () => {
    const value = input();
    value.purgedSurfaceIds = ['ctx', 'tools'];
    const receipt = evaluateExecutionUnlearningLifecycle(value);
    expect(receipt.status).toBe('FAIL');
    expect(receipt.missingPurgeSurfaceIds).toEqual(['retrieval']);
  });

  it('returns FAIL when a replayable surface was not replayed', () => {
    const value = input();
    value.replayedSurfaceIds = ['ctx'];
    const receipt = evaluateExecutionUnlearningLifecycle(value);
    expect(receipt.status).toBe('FAIL');
    expect(receipt.missingReplaySurfaceIds).toEqual(['retrieval']);
  });

  it('is deterministic regardless of inventory, purge, replay, and probe order', () => {
    const a = input();
    const b = input({ ...inventory(), surfaces: [...inventory().surfaces].reverse() });
    b.purgedSurfaceIds = [...b.purgedSurfaceIds].reverse();
    b.replayedSurfaceIds = [...b.replayedSurfaceIds].reverse();
    b.probeResults = [...b.probeResults].reverse();
    expect(evaluateExecutionUnlearningLifecycle(a).digest).toBe(evaluateExecutionUnlearningLifecycle(b).digest);
  });

  it('rejects duplicate and unknown state surfaces', () => {
    const dup = inventory({ surfaces: [inventory().surfaces[0], inventory().surfaces[0]] });
    expect(() => evaluateExecutionUnlearningLifecycle(input(dup))).toThrow(/duplicate surface id/);

    const unknown = input();
    unknown.purgedSurfaceIds = [...unknown.purgedSurfaceIds, 'not-declared'];
    expect(() => evaluateExecutionUnlearningLifecycle(unknown)).toThrow(/unknown surface id/);
  });

  it('rejects malformed digests and impossible utility telemetry', () => {
    expect(() => evaluateExecutionUnlearningLifecycle({ ...input(), coreMemoryPlanDigest: 'bad' })).toThrow(/sha256/);
    expect(() => evaluateExecutionUnlearningLifecycle({ ...input(), utilityAfter: 1.2 })).toThrow(/utilityAfter/);
  });
});
