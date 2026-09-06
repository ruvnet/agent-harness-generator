// @metaharness/flywheel — anytime-valid sequential testing for promotion gates.
//
// WHY THIS EXISTS
//
// `meetsPromotionRule` is a single-shot conjunctive comparison, and it is the
// right shape: frozen, fingerprintable, every clause load-bearing. But a
// flywheel run evaluates MANY generations against the SAME holdout, and that is
// uncontrolled multiple testing. Published measurements of greedy
// "accept-if-the-score-improved" acceptance put the false-commit rate at
// 30-42%, and found 13-21 spurious modifications made even when NO true gains
// existed — degrading one agent by 4.9 points while every individual decision
// looked locally justified.
//
// The conjunctive gate plus a frozen anchor already mitigates this with
// multiple hurdles, which is real. It is not, however, anytime-valid: nothing
// in it accounts for how many times you have looked.
//
// This module adds that missing property WITHOUT touching the default gate,
// whose stability is itself the product. It composes: wrap any PromotionRule,
// and a candidate must clear both the frozen clauses AND accumulated evidence.
//
// METHOD
//
// Testing-by-betting / e-processes. An e-value is a non-negative random
// variable with expectation <= 1 under the null hypothesis ("this candidate is
// no better than baseline"). By Ville's inequality, P(sup_t E_t >= 1/alpha)
// <= alpha, so you may stop and reject at ANY time — no pre-registered sample
// size, no alpha spending schedule, and no penalty for peeking. That is exactly
// the property a flywheel needs, because it peeks by construction.
//
// The bet here is deliberately simple and assumption-light: per paired item,
// a candidate win against a baseline loss multiplies the e-value up, the
// reverse multiplies it down, and ties leave it unchanged.

import type { PairedOutcome, PromotionDecision, PromotionEvidence, PromotionRule, Score } from './types.js';

export type { PairedOutcome } from './types.js';

export interface SequentialConfig {
  /**
   * Type-I error bound. Reject the null only when the e-value reaches 1/alpha.
   * Default 0.05 => threshold 20.
   */
  alpha?: number;
  /**
   * Betting fraction in (0, 1). Higher detects large effects sooner but is
   * slower on small ones. 0.5 is the Kelly-ish default and needs no tuning.
   */
  lambda?: number;
}

export interface SequentialVerdict {
  /** True when accumulated evidence crosses 1/alpha. */
  significant: boolean;
  /** The e-value. Interpretable directly: 20 means "20:1 against the null". */
  eValue: number;
  threshold: number;
  /** Items where the two arms disagreed — the only ones carrying information. */
  informativePairs: number;
  totalPairs: number;
}

const DEFAULT_ALPHA = 0.05;
const DEFAULT_LAMBDA = 0.5;

/** Reconstructs the per-item pairing `sequentialEvidence`/`withSequentialEvidence` need from two Scores
 *  that each carry a same-length {@link Score.itemWins} vector evaluated over the SAME suite. Returns
 *  `undefined` when either side omits it or the lengths disagree — the caller then simply omits
 *  `pairedOutcomes`, and any sequential-evidence rule degrades to its base rule (see
 *  `withSequentialEvidence`'s own degrade-safe contract). Shared by the LIVE promotion loop (`run.ts`) and
 *  independent replay's gate re-execution (`replay.ts`, ADR-235) so a sequential-gated promotion is
 *  re-verified with the SAME evidence it was live-gated with, instead of replay silently re-running only
 *  the wrapped base rule. */
export function pairedOutcomesFromItemWins(baseline: Score, candidate: Score): PairedOutcome[] | undefined {
  const bw = baseline.itemWins;
  const cw = candidate.itemWins;
  if (!bw || !cw || bw.length !== cw.length) return undefined;
  return bw.map((baselineWon, i) => ({ itemId: String(i), candidateWon: cw[i]!, baselineWon }));
}

/**
 * Accumulate paired outcomes into an anytime-valid e-value.
 *
 * Only discordant pairs move the e-value: if both arms win or both lose, that
 * item tells you nothing about which is better (this is the McNemar insight,
 * carried over to the sequential setting).
 */
export function sequentialEvidence(
  outcomes: PairedOutcome[],
  config: SequentialConfig = {},
): SequentialVerdict {
  const alpha = config.alpha ?? DEFAULT_ALPHA;
  const lambda = config.lambda ?? DEFAULT_LAMBDA;

  if (!(alpha > 0 && alpha < 1)) throw new RangeError('alpha must be in (0, 1)');
  if (!(lambda > 0 && lambda < 1)) throw new RangeError('lambda must be in (0, 1)');

  const threshold = 1 / alpha;
  let eValue = 1;
  let informativePairs = 0;

  for (const o of outcomes) {
    if (o.candidateWon === o.baselineWon) continue; // concordant: no information
    informativePairs++;
    // Under the null, a discordant pair favors either arm with probability 1/2,
    // so E[multiplier] = 1 and the process is a non-negative martingale.
    eValue *= o.candidateWon ? 1 + lambda : 1 - lambda;
  }

  return {
    significant: eValue >= threshold,
    eValue,
    threshold,
    informativePairs,
    totalPairs: outcomes.length,
  };
}

/**
 * Compose a frozen gate with a sequential-evidence requirement.
 *
 * The returned rule is still a plain `PromotionRule`, so it fingerprints and
 * freezes exactly like the default one. A candidate must satisfy BOTH: every
 * clause of `baseRule`, and evidence strong enough to survive having been
 * looked at repeatedly.
 *
 * Paired outcomes are read from `evidence.pairedOutcomes` when present (see
 * {@link PromotionEvidence.pairedOutcomes} — `runFlywheelGenerations` populates
 * it automatically when the Evaluator sets `Score.itemWins` on both sides).
 * When absent the rule degrades to `baseRule` alone rather than silently
 * blocking every promotion — a caller that has not wired up per-item outcomes
 * yet should get the old behavior, not a permanently closed gate.
 */
export function withSequentialEvidence(
  baseRule: PromotionRule,
  config: SequentialConfig = {},
): PromotionRule {
  return function sequentialPromotionRule(evidence: PromotionEvidence): PromotionDecision {
    const base = baseRule(evidence);
    const outcomes = evidence.pairedOutcomes;

    if (!outcomes) return base;

    const verdict = sequentialEvidence(outcomes, config);
    if (verdict.significant) return base;

    return {
      promote: false,
      reasons: [
        ...base.reasons,
        `insufficient_sequential_evidence(e=${verdict.eValue.toFixed(2)}<${verdict.threshold})`,
      ],
    };
  };
}
