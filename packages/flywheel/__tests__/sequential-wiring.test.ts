// @metaharness/flywheel — proves `sequential.ts`'s anytime-valid gate is actually REACHABLE from a live
// `runFlywheelGenerations` run, not just from its own unit tests.
//
// Before this fix: `withSequentialEvidence` was fully implemented and unit-tested (sequential.test.ts),
// exported from the package's public API (index.ts), and its own header explains exactly why it exists
// (naive greedy accept-if-improved gating has a published 30-42% false-commit rate under repeated
// evaluation). But `runFlywheelGenerations` — the ONE production code path that decides real promotions —
// never put a `pairedOutcomes` field on the `PromotionEvidence` it built for the gate, and
// `PromotionEvidence` didn't even have that field in its type. A caller who dutifully set
// `promotionRule: withSequentialEvidence(meetsPromotionRule)` got a rule that could NEVER see per-item
// evidence and therefore ALWAYS silently degraded to the plain frozen gate — identical to not having
// wired it in at all. This is the same "documented safety mechanism, structurally unreachable from its
// one real call site" bug class as ADR-278 (Tier-2 sandbox never calling `inspectVariant`).
import { describe, expect, it } from 'vitest';
import {
  runFlywheelGenerations, meetsPromotionRule, withSequentialEvidence, makeSigner, verifyReplayBundle,
  gateFingerprint,
  type Policy, type Suite, type Proposer, type Evaluator, type Score, type LineageCommit, type ReplayBundle,
} from '../src/index.js';

/** An adapter whose Evaluator reports `itemWins` — one win/loss bit per suite item — mirroring
 *  acceptance.test.ts's domain-agnostic shape, extended with the optional per-item vector. */
function makeAdapter(difficulties: number[]) {
  const rootPolicy: Policy = { a: '' };
  const items = difficulties.map((d, i) => ({ id: `item-${i}`, difficulty: d }));
  const holdout: Suite = { id: 'holdout', items };

  const proposer: Proposer = async (base) => `${base.policy.a ?? ''}#`;

  const evaluator: Evaluator = async (policy: Policy, s: Suite): Promise<Score> => {
    const quality = (policy.a ?? '').split('#').length - 1;
    const itemWins = (s.items as Array<{ difficulty: number }>).map((it) => quality >= it.difficulty);
    const solved = itemWins.filter(Boolean).length;
    const n = Math.max(1, s.items.length);
    return { primary: solved, noopRate: (n - solved) / n, costPerWin: solved > 0 ? 1 / solved : 999, regressed: false, itemWins };
  };

  return { rootPolicy, proposer, evaluator, holdout };
}

describe('runFlywheelGenerations wires Evaluator.itemWins into PromotionEvidence.pairedOutcomes', () => {
  it('THIN evidence (3 discordant items, e=3.375<20): the frozen gate alone promotes, sequential-wrapped does not', async () => {
    // 3 easy items (root loses, one-`#`-candidate wins) + 17 hard items neither ever solves.
    const a = makeAdapter([1, 1, 1, ...Array(17).fill(5)]);

    const plain = await runFlywheelGenerations({
      rootPolicy: a.rootPolicy, proposer: a.proposer, evaluator: a.evaluator, holdout: a.holdout,
      promotionRule: meetsPromotionRule, maxGenerations: 1, signer: makeSigner(), dataSource: 'SYNTHETIC',
    });
    // Sanity: the frozen gate alone DOES promote this thin win (primary 0→3, noopRate 1→0.85, cheaper).
    expect(plain.promotions.length).toBe(1);
    expect(plain.replayBundle.verified_improvements).toBe(1);

    const sequential = await runFlywheelGenerations({
      rootPolicy: a.rootPolicy, proposer: a.proposer, evaluator: a.evaluator, holdout: a.holdout,
      promotionRule: withSequentialEvidence(meetsPromotionRule), maxGenerations: 1, signer: makeSigner(),
      dataSource: 'SYNTHETIC',
    });
    // The wrapped rule must see real pairedOutcomes and block on insufficient evidence — if the wiring
    // were still broken (pairedOutcomes never reaching the rule), this would promote identically to `plain`.
    expect(sequential.promotions.length).toBe(0);
    expect(sequential.replayBundle.verified_improvements).toBe(0);
    const rejected = sequential.replayBundle.all_commits.find((c) => c.verdict === 'REJECTED');
    expect(rejected?.failureReasons.some((r) => r.startsWith('insufficient_sequential_evidence'))).toBe(true);
  });

  it('STRONG evidence (20/20 discordant items, e=1.5^20≫20): both the frozen gate and the sequential-wrapped gate promote', async () => {
    const a = makeAdapter(Array(20).fill(1)); // every item flips from loss to win

    const sequential = await runFlywheelGenerations({
      rootPolicy: a.rootPolicy, proposer: a.proposer, evaluator: a.evaluator, holdout: a.holdout,
      promotionRule: withSequentialEvidence(meetsPromotionRule), maxGenerations: 1, signer: makeSigner(),
      dataSource: 'SYNTHETIC',
    });
    expect(sequential.promotions.length).toBe(1);
    expect(sequential.replayBundle.verified_improvements).toBe(1);
  });

  it('backward-compatible: an Evaluator that omits itemWins still degrades the sequential-wrapped rule to the base gate through the REAL run path (not just the unit-level function call)', async () => {
    const rootPolicy: Policy = { a: '' };
    const holdout: Suite = { id: 'holdout', items: [{ id: 'i0' }, { id: 'i1' }, { id: 'i2' }] };
    const proposer: Proposer = async (base) => `${base.policy.a ?? ''}#`;
    // No `itemWins` on the returned Score at all — the pre-existing, still-supported shape.
    const evaluator: Evaluator = async (policy: Policy): Promise<Score> => {
      const quality = (policy.a ?? '').split('#').length - 1;
      return { primary: quality, noopRate: quality > 0 ? 0 : 1, costPerWin: quality > 0 ? 1 : 999, regressed: false };
    };

    const result = await runFlywheelGenerations({
      rootPolicy, proposer, evaluator, holdout, promotionRule: withSequentialEvidence(meetsPromotionRule),
      maxGenerations: 1, signer: makeSigner(), dataSource: 'SYNTHETIC',
    });
    // No pairedOutcomes ⇒ withSequentialEvidence degrades to meetsPromotionRule ⇒ this clean win promotes.
    expect(result.promotions.length).toBe(1);
  });
});

// An independent adversarial critic reviewing the wiring above found the SAME bug class at a sibling call
// site: `verifyReplayBundle`'s ADR-235 gate re-execution (replay.ts) re-runs `opts.promotionRule` on each
// PROMOTED commit's sealed scores but — before this addendum — never reconstructed `pairedOutcomes` from
// their sealed `itemWins` either, so a sequential-gated run's REPLAY silently re-verified only the wrapped
// base rule. That can't turn a real rejection into a false promotion, but it does mean "trust the gate
// re-run" (ADR-235's own framing) was weaker than advertised for sequential-gated promotions specifically.
describe('verifyReplayBundle also reconstructs pairedOutcomes for its ADR-235 gate re-execution', () => {
  const rule = withSequentialEvidence(meetsPromotionRule);
  const fp = gateFingerprint(rule);
  const signer = makeSigner();
  const root: LineageCommit = {
    id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null,
    verdict: 'ROOT', failureReasons: [], receipt: signer.sign({ kind: 'root', root: 'root' }), createdAt: 'g0',
  };
  const promoted = (baselineScore: Score, candidateScore: Score): LineageCommit => ({
    id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' },
    primaryDelta: candidateScore.primary - baselineScore.primary, anchorScore: null, verdict: 'PROMOTED',
    failureReasons: [], receipt: signer.sign({ kind: 'candidate', id: 'c1', verdict: 'PROMOTED' }),
    createdAt: 'g1', baselineScore, candidateScore,
  });
  const bundleOf = (c1: LineageCommit): ReplayBundle => ({
    data_source: 'SYNTHETIC', root_id: 'root', chain: [c1, root], all_commits: [c1], lift_curve: [],
    gate_fingerprint: fp, verified_improvements: 1, anchor_surviving_improvements: 1, milestone_reached: false,
    created_at: 'g1',
  });
  const bl = (itemWins: boolean[]): Score => ({ primary: 0, noopRate: 1, costPerWin: 999, regressed: false, itemWins });
  const cd = (itemWins: boolean[]): Score => {
    const solved = itemWins.filter(Boolean).length;
    return { primary: solved, noopRate: (itemWins.length - solved) / itemWins.length, costPerWin: solved > 0 ? 1 / solved : 999, regressed: false, itemWins };
  };

  it('STRONG sealed evidence (20/20 discordant) → gateReExecutes true, pass true', () => {
    const c1 = promoted(bl(Array(20).fill(false)), cd(Array(20).fill(true)));
    const v = verifyReplayBundle(bundleOf(c1), { promotionRule: rule });
    expect(v.checks.gateReExecutes).toBe(true);
    expect(v.pass).toBe(true);
  });

  it('THIN sealed evidence (3/20 discordant, e=3.375<20) → gateReExecutes FALSE even though the wrapped base rule alone would re-pass it — proves replay re-verifies sequential evidence, not just the base rule', () => {
    const thinWins = [true, true, true, ...Array(17).fill(false)];
    const c1 = promoted(bl(Array(20).fill(false)), cd(thinWins));
    // Sanity: the base rule alone DOES re-pass these sealed scores (mirrors the live-run finding above).
    expect(meetsPromotionRule({ baseline: c1.baselineScore!, candidate: c1.candidateScore! }).promote).toBe(true);
    const v = verifyReplayBundle(bundleOf(c1), { promotionRule: rule });
    expect(v.checks.gateReExecutes).toBe(false);
    expect(v.pass).toBe(false);
  });
});
