// SPDX-License-Identifier: MIT
//
// @metaharness/projects — public barrel. The borrowed-pattern integration program
// (ADR-156…166): durable checkpoints, cost-attributing traces, declarative
// HarnessSpec, bounded escalation scheduling, tiered memory, a four-split dataset
// registry, typed handoffs, immutable safety rails, ROI opportunity scanning, and
// human review gates — all built on the shared core. Thesis: Darwin Mode mutates
// structured policies, not prompts; the proof is in replay.

export * from './core.js';
export * from './checkpoints.js'; // ADR-157
export * from './trace.js'; // ADR-158
export * from './harness-spec.js'; // ADR-159
export * from './scheduler.js'; // ADR-160
export * from './memory-tiers.js'; // ADR-161
export * from './datasets.js'; // ADR-162
export * from './handoffs.js'; // ADR-163
export * from './safety-rails.js'; // ADR-164
export * from './opportunity.js'; // ADR-165
export * from './review-gates.js'; // ADR-166
export * from './openrouter.js'; // optional real-LLM client (ADR-163 real A/B)
export * from './router.js'; // escalation router policy
export * from './discovery.js'; // defensive zero-day discovery harness
export * from './discovery-evolve.js'; // Darwin policy evolution for discovery
export * from './learning-loop.js'; // self-learning discovery loop
export * from './pipeline.js';
export * from './taint.js';
export * from './verifiers.js';
export * from './sandbox.js';
export * from './cve-corpus.js';
export * from './unlearning.js'; // execution-state unlearning orchestration
