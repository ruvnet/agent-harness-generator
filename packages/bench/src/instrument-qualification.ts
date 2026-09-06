// SPDX-License-Identifier: MIT

export interface RankingRepeat {
  sampleId: string;
  reference: string[];
  repeat: string[];
}

export interface ToolInterfaceObservation {
  sampleId: string;
  emittedValidCalls: number;
  parsedCalls: number;
  executedCalls: number;
}

export interface InstrumentQualificationPolicy {
  requireRanking: boolean;
  requireInterface: boolean;
  minRankingSamples: number;
  minMeanSpearman: number;
  minInterfaceSamples: number;
  maxParserLossRate: number;
  maxExecutionLossRate: number;
}

export interface InstrumentQualificationInput {
  instrumentId: string;
  snapshotId: string;
  rankings: RankingRepeat[];
  interfaceObservations: ToolInterfaceObservation[];
  policy: InstrumentQualificationPolicy;
}

export interface InstrumentQualificationReceipt {
  instrumentId: string;
  snapshotId: string;
  authority: 'none';
  qualified: boolean;
  invalid: boolean;
  reasons: string[];
  ranking: {
    samples: number;
    meanSpearman: number | null;
    minSpearman: number | null;
  };
  interface: {
    samples: number;
    emittedValidCalls: number;
    parsedCalls: number;
    executedCalls: number;
    parserLossRate: number | null;
    executionLossRate: number | null;
  };
}

const MAX_OBSERVATIONS = 4096;
const MAX_RANKED_ITEMS = 2048;

function finiteUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validPolicy(policy: InstrumentQualificationPolicy): boolean {
  return (
    (policy.requireRanking || policy.requireInterface) &&
    Number.isInteger(policy.minRankingSamples) && policy.minRankingSamples >= 0 &&
    Number.isInteger(policy.minInterfaceSamples) && policy.minInterfaceSamples >= 0 &&
    finiteUnit(policy.minMeanSpearman) &&
    finiteUnit(policy.maxParserLossRate) &&
    finiteUnit(policy.maxExecutionLossRate)
  );
}

function validRanking(repeat: RankingRepeat): boolean {
  if (!repeat.sampleId || repeat.reference.length < 2 || repeat.reference.length > MAX_RANKED_ITEMS) return false;
  if (repeat.reference.length !== repeat.repeat.length) return false;
  const left = new Set(repeat.reference);
  const right = new Set(repeat.repeat);
  if (left.size !== repeat.reference.length || right.size !== repeat.repeat.length) return false;
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id) || id.length === 0) return false;
  return true;
}

/** Spearman rank correlation for two permutations of the same unique identities. */
export function spearmanRanking(reference: string[], repeat: string[]): number {
  const observation: RankingRepeat = { sampleId: 'spearman', reference, repeat };
  if (!validRanking(observation)) return Number.NaN;

  const positions = new Map<string, number>();
  reference.forEach((id, index) => positions.set(id, index + 1));
  let squaredDistance = 0;
  repeat.forEach((id, index) => {
    const delta = positions.get(id)! - (index + 1);
    squaredDistance += delta * delta;
  });
  const n = reference.length;
  return 1 - (6 * squaredDistance) / (n * (n * n - 1));
}

function validInterfaceObservation(observation: ToolInterfaceObservation): boolean {
  const values = [observation.emittedValidCalls, observation.parsedCalls, observation.executedCalls];
  return (
    observation.sampleId.length > 0 &&
    values.every(value => Number.isSafeInteger(value) && value >= 0) &&
    observation.parsedCalls <= observation.emittedValidCalls &&
    observation.executedCalls <= observation.parsedCalls
  );
}

/**
 * Qualify a measurement instrument before its outputs can be used as promotion evidence.
 * This function never grants execution authority.
 */
export function qualifyInstrument(input: InstrumentQualificationInput): InstrumentQualificationReceipt {
  const reasons: string[] = [];
  let invalid = false;

  if (!input.instrumentId || !input.snapshotId || !validPolicy(input.policy)) {
    invalid = true;
    reasons.push('invalid identity or policy');
  }

  if (input.rankings.length > MAX_OBSERVATIONS || input.interfaceObservations.length > MAX_OBSERVATIONS) {
    invalid = true;
    reasons.push('resource bound exceeded');
  }

  const rankingIds = new Set<string>();
  const correlations: number[] = [];
  for (const repeat of input.rankings) {
    if (rankingIds.has(repeat.sampleId) || !validRanking(repeat)) {
      invalid = true;
      reasons.push(`invalid ranking observation: ${repeat.sampleId || '<empty>'}`);
      continue;
    }
    rankingIds.add(repeat.sampleId);
    correlations.push(spearmanRanking(repeat.reference, repeat.repeat));
  }

  const interfaceIds = new Set<string>();
  let emittedValidCalls = 0;
  let parsedCalls = 0;
  let executedCalls = 0;
  for (const observation of input.interfaceObservations) {
    if (interfaceIds.has(observation.sampleId) || !validInterfaceObservation(observation)) {
      invalid = true;
      reasons.push(`invalid interface observation: ${observation.sampleId || '<empty>'}`);
      continue;
    }
    interfaceIds.add(observation.sampleId);
    emittedValidCalls += observation.emittedValidCalls;
    parsedCalls += observation.parsedCalls;
    executedCalls += observation.executedCalls;
    if (![emittedValidCalls, parsedCalls, executedCalls].every(Number.isSafeInteger)) {
      invalid = true;
      reasons.push('interface count overflow');
      break;
    }
  }

  const meanSpearman = correlations.length === 0
    ? null
    : correlations.reduce((sum, value) => sum + value, 0) / correlations.length;
  const minSpearman = correlations.length === 0 ? null : Math.min(...correlations);
  const parserLossRate = emittedValidCalls === 0 ? null : (emittedValidCalls - parsedCalls) / emittedValidCalls;
  const executionLossRate = parsedCalls === 0 ? null : (parsedCalls - executedCalls) / parsedCalls;

  if (input.policy.requireRanking) {
    if (correlations.length < input.policy.minRankingSamples) reasons.push('insufficient ranking samples');
    if (meanSpearman === null || meanSpearman < input.policy.minMeanSpearman) reasons.push('ranking reliability below threshold');
  }

  if (input.policy.requireInterface) {
    if (interfaceIds.size < input.policy.minInterfaceSamples) reasons.push('insufficient interface samples');
    if (parserLossRate === null) reasons.push('no valid emitted tool calls observed');
    else if (parserLossRate > input.policy.maxParserLossRate) reasons.push('parser loss above threshold');
    if (executionLossRate === null) reasons.push('no parsed tool calls available for execution check');
    else if (executionLossRate > input.policy.maxExecutionLossRate) reasons.push('execution loss above threshold');
  }

  return {
    instrumentId: input.instrumentId,
    snapshotId: input.snapshotId,
    authority: 'none',
    qualified: !invalid && reasons.length === 0,
    invalid,
    reasons,
    ranking: {
      samples: correlations.length,
      meanSpearman,
      minSpearman,
    },
    interface: {
      samples: interfaceIds.size,
      emittedValidCalls,
      parsedCalls,
      executedCalls,
      parserLossRate,
      executionLossRate,
    },
  };
}
