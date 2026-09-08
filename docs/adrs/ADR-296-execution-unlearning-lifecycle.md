# ADR 296: Execution Unlearning Lifecycle Across Hosts

Status: proposed

Date: 2026-09-08

Related: ruvnet/core-memory#65, ruvnet/core-memory#66, ruvnet/metaharness#295

## Context

Core Memory now provides durable forgetting plus an execution-state unlearning receipt that binds a selective replay plan. That is necessary but not sufficient at the harness layer. A running host can retain derived information in model context, summaries, plans, retrieval caches, MCP or tool sessions, browser state, subprocesses, filesystem artifacts, KV cache, or opaque provider-side state.

A harness must not claim successful forgetting when it cannot inspect or invalidate one of those surfaces.

## Decision

MetaHarness adds a provider-independent execution unlearning lifecycle contract in `@metaharness/projects`.

The lifecycle does not reproduce Core Memory's forget or replay logic. Instead, it consumes Core Memory plan and receipt digests and evaluates host-level completion using four evidence classes:

1. declared host state inventory
2. purge completion for purgeable surfaces
3. replay completion for replayable surfaces
4. adversarial probe outcomes after rebuild

The output status is one of:

* `PASS`: every declared surface is observable and purgeable, all required purge and replay work completed, and all probes are clean
* `FAIL`: a required purge or replay step is missing, or any probe leaks
* `INCOMPLETE`: no direct failure is observed, but at least one declared surface is opaque or cannot be purged

All receipts carry `authority: none`.

## Host state inventory

Each host adapter must declare its runtime surfaces before an unlearning claim can be evaluated. Initial state kinds are:

* model context
* summary
* plan
* retrieval cache
* tool session
* browser state
* subprocess
* filesystem
* KV cache
* provider cache
* other

Each surface records whether it is observable, purgeable, replayable, and remote.

Unknown runtime state must not be silently omitted. A production host integration requires a documented inventory completeness review.

## Probe classes

MetaHarness supports evidence receipts for:

* explicit elicitation
* string-free behavioral probes
* retrieval attempts
* tool-state recovery attempts
* delegation to another agent
* session resume

Probe receipts store only an evidence digest and leak boolean, never the forgotten payload.

## Security boundaries

Core Memory owns durable forget and selective replay evidence.

RVM owns authority to pause, clear, restart, resume, or invoke privileged tools.

MetaHarness owns orchestration, host inventory, and verification only.

A host-provided counter is not sufficient evidence if the host itself is inside the threat boundary. Production integrations should prefer independently observed state and witness receipts where possible.

Provider-side caches are especially important. If the provider does not expose a verifiable deletion or reset mechanism, the result is `INCOMPLETE` even if all local probes pass.

## Falsification

Do not add learned or host-specific unlearning machinery if a complete runtime reset is cheaper and operationally acceptable for the target workload.

Reject this abstraction if host inventories cannot be made complete enough to distinguish `PASS` from `INCOMPLETE` in real supported hosts.

## Benchmark

For each supported host, inject a unique synthetic value at a known step into at least 100 sessions. Compare:

1. durable deletion only
2. complete runtime reset
3. Core Memory selective replay plus MetaHarness lifecycle verification

Probe memory, model context, retrieval, tool state, delegation, resume behavior, and any host-specific surfaces.

Report task utility, leakage, recomputed tokens, latency, model cost, purge failures, replay failures, opaque surfaces, and reproduction commands.

Promotion requires zero leakage on tracked state, utility within 2 absolute percentage points of complete reset, at least 30 percent fewer recomputed tokens than complete reset where selective replay is used, and no `PASS` result from an inventory containing opaque or unpurgeable state.

## Migration and rollback

The feature is additive. Existing hosts do not change behavior until they explicitly integrate the lifecycle contract.

Rollback removes the module and export. Core Memory forgetting behavior remains unchanged.

## Governance

No autonomous merge, deployment, credential escalation, provider policy change, or irreversible state migration. MetaHarness issue 295 remains the independent reproduction gate.