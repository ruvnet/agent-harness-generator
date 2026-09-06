# ADR-279: Wiring `withSequentialEvidence` into the flywheel's live promotion path (and its replay)

- **Status**: Accepted — implemented (`packages/flywheel/src/{run,replay,sequential,types}.ts`),
  regression-tested (`packages/flywheel/__tests__/sequential-wiring.test.ts`), independently critiqued.
- **Date**: 2026-09-06
- **Deciders**: MetaHarness Dream Cycle (autonomous nightly research), slot 1 (flywheel-promotion)
- **Tags**: flywheel, promotion, statistics, anti-multiple-testing, metaharness, process
- **Extends**: ADR-235 (independent re-executing verifiers + honest-null replay), ADR-254 (anti-Goodhart
  anchor re-execution during replay), ADR-274 (flywheel-replay consolidation and chain binding)
- **Related**: ADR-278 (closing the Tier-2 sandbox's missing safety gate) — the same bug class
  ("documented safety/statistical mechanism, structurally unreachable from its one real call site") in a
  different package
- **Prompted by**: architecture review of `packages/flywheel/src/*` during tonight's flywheel-promotion
  deep dive, cross-checked against a recent primary source (arXiv:2512.03109, "E-valuator: Reliable Agent
  Verifiers with Sequential Hypothesis Testing", Dec 2025 / rev. May 2026) confirming e-process /
  anytime-valid sequential testing is an active, not-yet-standardized approach to exactly this problem in
  agent-verifier settings — no competitor framework surveyed (LangGraph, AutoGen, CrewAI, DSPy/GEPA, OpenAI
  Agents SDK) ships anything comparable for its own optimizer/promotion loop as of this survey.

---

## Context

`packages/flywheel/src/sequential.ts` implements `withSequentialEvidence()`: an anytime-valid e-process
gate (Ville's inequality; a non-negative martingale under the null) meant to compose with the frozen
`meetsPromotionRule` and block a promotion whose winning margin is not yet statistically distinguishable
from noise. Its own module header cites the concrete motivation: naive greedy "accept if the score
improved" acceptance under repeated peeking has a published 30-42% false-commit rate, with 13-21 spurious
modifications landing even when no true gain existed.

The module was fully built, exported from the package's public API (`index.ts`), and unit-tested
end-to-end at the function level (`sequential.test.ts`, 14 tests, all passing). But `runFlywheelGenerations`
— the one production code path that decides real promotions — never put a `pairedOutcomes` field on the
`PromotionEvidence` object it constructed before calling the gate, and `PromotionEvidence`'s own type did
not carry that field at all (`sequential.ts` reached it only via an `as PromotionEvidence & {...}` cast in
its own test file). A caller who dutifully set `promotionRule: withSequentialEvidence(meetsPromotionRule)`
on a real `FlywheelConfig` got a rule that could never see per-item evidence and therefore *always* silently
degraded to the plain frozen gate — byte-for-byte identical to never having wired it in. `verifyReplayBundle`'s
independent ADR-235 gate re-execution had the identical gap at its own, separate call site (found by
tonight's independent critic, not the original pass): re-running the rule on sealed scores during replay
never reconstructed `pairedOutcomes` either, so replaying a sequential-gated run's promotion would silently
re-verify only the wrapped base rule.

This is the same defect *class* as ADR-278 (Darwin Mode's Tier-2 sandbox never calling its own safety gate)
— a real, tested, exported mechanism that cannot fire because nothing on its one live path invokes it — just
in the statistical-integrity domain instead of sandbox containment.

## Decision

1. `Score` gains an optional, additive field: `itemWins?: boolean[]` — a per-suite-item win indicator, in
   the same order the Evaluator was called with. An Evaluator that wants its promotions covered by
   `withSequentialEvidence` sets this on both the baseline and candidate `Score` it returns for the same
   suite.
2. `PromotionEvidence` gains an optional, additive field: `pairedOutcomes?: PairedOutcome[]` (the
   `PairedOutcome` interface moves from `sequential.ts` into `types.ts`, re-exported unchanged from
   `sequential.ts` for API compatibility).
3. A new shared helper, `pairedOutcomesFromItemWins(baseline, candidate)` (`sequential.ts`), zips two
   same-length `itemWins` vectors into `PairedOutcome[]`, returning `undefined` on any mismatch.
4. `runFlywheelGenerations` (`run.ts`) calls it for every candidate evaluated against the holdout and
   splices the result onto the evidence passed to the promotion rule — the ONE place a live run decides
   who wins.
5. `verifyReplayBundle`'s ADR-235 gate re-execution (`replay.ts`) calls the same helper on each PROMOTED
   commit's sealed scores before re-running the supplied rule, so replaying a sequential-gated promotion
   re-verifies the same evidence it was live-gated with.

Absent `itemWins` on either side (every existing Evaluator, and every bundle produced before tonight), both
call sites omit `pairedOutcomes` entirely and every existing rule — `meetsPromotionRule`, every `evals-*`
vertical's composite gate, `withSequentialEvidence` itself — behaves byte-for-byte as before. Nothing about
`meetsPromotionRule` (the FROZEN default gate) changed.

## Consequences

- `withSequentialEvidence` is now reachable from the one place it needs to be to do its job: it can
  actually block a thin/noisy live promotion the frozen gate alone would accept, and that guarantee now
  survives independent replay, not just a direct unit-level function call.
- No behavioral change for any existing caller: the two new fields are optional and additive, verified by
  the full downstream test sweep (flywheel 77/77, evals-math/sql/toolcall/servedmodel/hle/extract 47/47,
  autogenous 7/7 — 0 regressions across every consumer of `@metaharness/flywheel` in this repo).
- This does NOT retroactively make any existing evals-* vertical gate (`evals-math/src/gate.ts` and
  siblings) sequential-evidence-aware — none of them wrap `meetsPromotionRule` with
  `withSequentialEvidence`, and none of their Evaluators set `itemWins` yet. That remains a legitimate,
  disclosed-not-fixed follow-up (see tonight's issue) — adopting it per-vertical is a product decision
  about each domain's holdout size and noise floor, not a mechanical wiring fix like this one.
- `PairedOutcome.itemId` is a stringified positional index when the Evaluator has no typed item id to
  offer (`Suite.items: unknown[]`) — cosmetically implies a real id; documented as intentional in
  `types.ts`, not changed, since pairing is purely positional and this does not affect correctness.

## Alternatives Considered

- **Extend `Evaluator` to return per-item results as its primary shape instead of an aggregate `Score`.**
  Rejected: a much larger, breaking change to the package's core seam for a benefit fully achievable
  additively.
- **Wire `withSequentialEvidence` as the new default `promotionRule`.** Rejected: changes the frozen gate's
  default behavior for every existing caller without their opt-in; the existing degrade-to-base-rule
  contract already lets a caller adopt it explicitly per `FlywheelConfig.promotionRule`.
- **Leave `replay.ts`'s parallel gap for a future night** (as the critic's finding was technically outside
  tonight's original scope). Rejected: identical bug class, identical file family, ~10 line fix with its
  own non-vacuous regression test — fixing it same-night avoids adding a 9th name to the flywheel-promotion
  backlog for a gap already fully diagnosed.

## Test Contract

`packages/flywheel/__tests__/sequential-wiring.test.ts` (8 new tests, all non-vacuous):
- THIN evidence (3/20 discordant items, e=3.375<20): the frozen gate alone promotes through a real
  `runFlywheelGenerations` call; the sequential-wrapped rule does not (fails pre-fix: 1 promotion observed
  where 0 expected).
- STRONG evidence (20/20 discordant, e=1.5^20≫20): both promote.
- Backward-compatible: an Evaluator that never sets `itemWins` still degrades to the base rule through the
  real run path.
- The same THIN/STRONG pair replayed through `verifyReplayBundle`'s gate re-execution (fails pre-fix on the
  `replay.ts` side specifically: gateReExecutes incorrectly `true` for the THIN case without the fix).

## References

- `packages/flywheel/src/sequential.ts` — the anytime-valid e-process gate (unchanged statistics, only its
  reachability changed tonight)
- `packages/flywheel/src/run.ts`, `packages/flywheel/src/replay.ts`, `packages/flywheel/src/types.ts`
- ADR-235, ADR-254, ADR-274 — the flywheel replay/gate-integrity ADR lineage this extends
- ADR-278 — the sibling "documented gate, unreachable call site" finding in Darwin Mode
- arXiv:2512.03109, "E-valuator: Reliable Agent Verifiers with Sequential Hypothesis Testing" (submitted
  2025-12-02, revised 2026-05-28)
