// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { qualifyInstrument, spearmanRanking } from '../src/instrument-qualification.js';

const strictPolicy = {
  requireRanking: true,
  requireInterface: true,
  minRankingSamples: 2,
  minMeanSpearman: 0.9,
  minInterfaceSamples: 2,
  maxParserLossRate: 0,
  maxExecutionLossRate: 0,
};

const stableRankings = [
  { sampleId: 'r1', reference: ['a', 'b', 'c', 'd'], repeat: ['a', 'b', 'c', 'd'] },
  { sampleId: 'r2', reference: ['w', 'x', 'y', 'z'], repeat: ['w', 'x', 'y', 'z'] },
];

const healthyInterface = [
  { sampleId: 'i1', emittedValidCalls: 4, parsedCalls: 4, executedCalls: 4 },
  { sampleId: 'i2', emittedValidCalls: 3, parsedCalls: 3, executedCalls: 3 },
];

function qualify(overrides: Partial<Parameters<typeof qualifyInstrument>[0]> = {}) {
  return qualifyInstrument({
    instrumentId: 'provider:model:adapter',
    snapshotId: 'sha256:fixture',
    rankings: stableRankings,
    interfaceObservations: healthyInterface,
    policy: strictPolicy,
    ...overrides,
  });
}

describe('spearmanRanking', () => {
  it('returns one for identical rankings', () => {
    expect(spearmanRanking(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });

  it('returns negative one for a complete reversal', () => {
    expect(spearmanRanking(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(-1);
  });

  it('returns NaN for mismatched candidate sets', () => {
    expect(Number.isNaN(spearmanRanking(['a', 'b'], ['a', 'c']))).toBe(true);
  });
});

describe('qualifyInstrument', () => {
  it('qualifies a stable ranking and lossless interface control', () => {
    const receipt = qualify();
    expect(receipt.qualified).toBe(true);
    expect(receipt.invalid).toBe(false);
    expect(receipt.authority).toBe('none');
    expect(receipt.ranking.meanSpearman).toBe(1);
    expect(receipt.interface.parserLossRate).toBe(0);
    expect(receipt.interface.executionLossRate).toBe(0);
  });

  it('rejects unstable repeat rankings', () => {
    const receipt = qualify({
      rankings: [
        stableRankings[0]!,
        { sampleId: 'r2', reference: ['a', 'b', 'c', 'd'], repeat: ['d', 'c', 'b', 'a'] },
      ],
    });
    expect(receipt.qualified).toBe(false);
    expect(receipt.reasons).toContain('ranking reliability below threshold');
  });

  it('detects silent parser censorship', () => {
    const receipt = qualify({
      interfaceObservations: [
        { sampleId: 'i1', emittedValidCalls: 5, parsedCalls: 0, executedCalls: 0 },
        { sampleId: 'i2', emittedValidCalls: 5, parsedCalls: 0, executedCalls: 0 },
      ],
    });
    expect(receipt.qualified).toBe(false);
    expect(receipt.interface.parserLossRate).toBe(1);
    expect(receipt.reasons).toContain('parser loss above threshold');
  });

  it('detects post parser execution loss', () => {
    const receipt = qualify({
      interfaceObservations: [
        { sampleId: 'i1', emittedValidCalls: 5, parsedCalls: 5, executedCalls: 4 },
        { sampleId: 'i2', emittedValidCalls: 5, parsedCalls: 5, executedCalls: 5 },
      ],
    });
    expect(receipt.qualified).toBe(false);
    expect(receipt.interface.executionLossRate).toBeCloseTo(0.1);
    expect(receipt.reasons).toContain('execution loss above threshold');
  });

  it('fails closed on insufficient observations', () => {
    const receipt = qualify({ rankings: [stableRankings[0]!], interfaceObservations: [healthyInterface[0]!] });
    expect(receipt.qualified).toBe(false);
    expect(receipt.reasons).toContain('insufficient ranking samples');
    expect(receipt.reasons).toContain('insufficient interface samples');
  });

  it('fails closed on duplicate ranking identities', () => {
    const receipt = qualify({
      rankings: [
        { sampleId: 'r1', reference: ['a', 'a'], repeat: ['a', 'a'] },
        stableRankings[1]!,
      ],
    });
    expect(receipt.invalid).toBe(true);
    expect(receipt.qualified).toBe(false);
  });

  it('fails closed on impossible interface counters', () => {
    const receipt = qualify({
      interfaceObservations: [
        { sampleId: 'i1', emittedValidCalls: 1, parsedCalls: 2, executedCalls: 0 },
        healthyInterface[1]!,
      ],
    });
    expect(receipt.invalid).toBe(true);
    expect(receipt.qualified).toBe(false);
  });

  it('supports ranking only qualification for non tool benchmarks', () => {
    const receipt = qualify({
      interfaceObservations: [],
      policy: { ...strictPolicy, requireInterface: false, minInterfaceSamples: 0 },
    });
    expect(receipt.qualified).toBe(true);
  });
});
