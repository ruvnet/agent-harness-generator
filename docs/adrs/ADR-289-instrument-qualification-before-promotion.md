# ADR-289: Qualify measurement instruments before promotion

Status: Proposed

Date: 2026-09-06

Tracks: #289

## Context

RuV evaluation currently assumes that a configured model endpoint, serving adapter, parser, and execution path constitute a sufficiently stable measurement instrument once the benchmark itself is frozen.

Two September 2026 results challenge that assumption from independent directions.

First, arXiv:2609.04198 reports low repeat ranking reliability for black box LLM observers on shared endpoints even under preregistered measurement gates and byte identical replay.

Second, arXiv:2609.03966 reports interface induced trajectory censoring in which valid tool calls are present in model output but disappear at the serving template and parser boundary, causing observed tool use to substantially understate model capability.

The common failure is that a benchmark can be reproducible at the code and dataset layer while the instrument producing its evidence is not reliable enough to support promotion decisions.

## Decision

Add a dependency free instrument qualification primitive to `@metaharness/bench`.

The primitive evaluates two independent properties.

1. Ranking repeatability. Matched repetitions over the same unique candidate set are compared using deterministic Spearman rank correlation.
2. Interface preservation. Valid emitted tool calls are accounted through parsed and executed stages so silent parser or execution loss is measurable.

Qualification thresholds are supplied explicitly by the experiment protocol. The library does not invent a universal reliability threshold.

The receipt is evidence only and always carries `authority: none`.

## Invariants

1. Measurement reliability never grants execution authority.
2. A promotion evaluator cannot certify itself solely from candidate outcomes.
3. Missing or malformed qualification evidence fails closed when that dimension is required.
4. Duplicate sample identities, mismatched ranking candidate sets, impossible tool counters, non finite thresholds, and resource bound violations invalidate the receipt.
5. Ranking and interface qualification remain separable because non tool benchmarks should not fabricate interface evidence.
6. Thresholds and instrument snapshots are frozen before candidate outcomes are used as promotion evidence.
7. Negative qualification results are durable experiment results and cannot be discarded by changing the instrument identifier.

## Interface

`RankingRepeat` records a sample identity and two complete permutations over the same candidate identities.

`ToolInterfaceObservation` records valid emitted calls, server parsed calls, and actually executed calls for one sample.

`InstrumentQualificationPolicy` declares which dimensions are required plus sample and loss thresholds.

`InstrumentQualificationReceipt` reports ranking correlations, aggregate parser and execution loss, failure reasons, validity, qualification state, and `authority: none`.

## Security and privacy

The primitive stores only opaque sample and candidate identities plus bounded integer telemetry. It does not require prompt text, tool arguments, model output, user data, credentials, or raw traces.

A dishonest adapter could still falsify emitted, parsed, or executed counters. Production integration must therefore bind observations to independently captured witness or host telemetry where available.

## Benchmark protocol

Baseline A is a stable synthetic control with identical repeated rankings and lossless tool transport.

Baseline B is an unstable ranking control with deliberately reordered candidates.

Baseline C is an interface censorship control with valid emitted calls and zero parsed calls.

Baseline D is a post parser execution loss control.

The external reproduction then pins model identifier, provider endpoint, host adapter commit, template and parser versions, benchmark commit, evaluator commit, seeds, sample size, latency, token usage, monetary cost, hardware where applicable, and timestamps.

Every result reports mean and minimum repeat Spearman, emitted, parsed, and executed call totals, parser loss, execution loss, invalid observations, failures, and exact reproduction commands.

## Falsification

Reject this primitive as unnecessary if existing MetaHarness benchmark instrumentation already catches all silent interface loss cases and repeated observer instability before promotion with no additional state.

Reject a universal default threshold if reliability requirements materially differ by benchmark. Keep policy explicit instead.

Do not treat increased repeatability as evidence of evaluator validity. A perfectly repeatable evaluator can still be systematically wrong.

## Rollback

The new module is additive, has no new runtime dependencies, and does not change existing benchmark execution. Rollback is deletion of the module, tests, and this ADR. No stored format, migration, credential, model, or deployment change is required.

## Consequences

Positive consequences are earlier detection of invalid benchmark runs, explicit measurement of serving stack censorship, reusable qualification receipts across Dream Machine, Ruflo, Cognitum, RVM, Core Memory, and RuVector experiments, and lower risk of promoting regressions because of an unstable evaluator.

Costs are extra repeated samples, extra preflight calls, and the possibility that shared endpoints fail qualification often enough to require a pinned self hosted evaluator or wider confidence intervals.

The largest remaining uncertainty is external validity. A stable preflight slice may still miss later endpoint drift. Long runs therefore need checkpoint qualification or drift detection in addition to the initial preflight.

## Acceptance

The implementation is acceptable only if synthetic stable controls qualify, unstable rankings fail, silent parser censorship fails, execution loss fails, malformed evidence fails closed, non tool ranking only mode works, no runtime dependency is added, existing bench behavior remains unchanged, and repository CI and security checks remain green.
