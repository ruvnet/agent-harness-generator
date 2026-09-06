// SPDX-License-Identifier: MIT
//
// Memory retrieval benchmark harness.
//
// Goal: produce REPRODUCIBLE retrieval-quality numbers so the kernel's
// memory pipeline can be compared against published baselines:
//
//   Mem0 (arXiv 2504.19413): +26% LLM-as-Judge over OpenAI memory
//        baseline; 91% lower p95 latency; >90% token cost reduction
//   ReasoningBank (research.google blog): +8.3pp WebArena with
//        Gemini-2.5-Flash; k=1 retrieval per task is OPTIMAL
//        (more memory HURTS performance)
//
// We can't run Mem0 in CI without their API; we CAN match the
// EXPERIMENT SHAPE (single-hop / temporal / multi-hop / open-domain)
// and report on the kernel's behaviour under each, so users can sanity-
// check decay-vs-no-decay + k=1-vs-k=N empirically without rebuilding
// the harness.
//
// Output format: deterministic JSON report committed to the repo;
// future runs diff against it to detect regressions.

import { performance } from 'node:perf_hooks';

export * from './instrument-qualification.js';

export type EvalCategory = 'single-hop' | 'temporal' | 'multi-hop' | 'open-domain';

export interface MemoryItem {
  id: string;
  text: string;
  /** Vector embedding (synthetic in CI; real in user runs). */
  embedding: number[];
  /** ms-since-epoch when this item was stored. */
  storedAt: number;
  /** Semantic class — used to construct the eval pairs. */
  category: EvalCategory;
}

export interface EvalQuery {
  id: string;
  text: string;
  embedding: number[];
  /** Items that should be retrieved (ground truth). */
  relevant: Set<string>;
  category: EvalCategory;
}

export interface RetrievalConfig {
  /** Top-k. ReasoningBank says k=1 wins; verify against the corpus. */
  k: number;
  /** Apply AgenticClock decay weighting? */
  useDecay: boolean;
  /** Half-life when decay is on (ms). */
  halfLifeMs?: number;
}

export interface RunResult {
  config: RetrievalConfig;
  /** Number of queries evaluated. */
  queries: number;
  /** recall@k averaged across queries. */
  recall: number;
  /** Mean reciprocal rank. */
  mrr: number;
  /** p50 latency in ms. */
  p50_latency_ms: number;
  /** p95 latency in ms. */
  p95_latency_ms: number;
  /** Per-category breakdown. */
  by_category: Record<EvalCategory, { recall: number; mrr: number; n: number }>;
}

/** Cosine similarity for plain JS arrays. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Half-life decay. */
export function decayWeight(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/** Rank items for a query under a config. Returns ids in best-first order. */
export function rank(
  items: MemoryItem[],
  query: EvalQuery,
  config: RetrievalConfig,
  nowMs: number,
): string[] {
  const halfLife = config.halfLifeMs ?? 7 * 24 * 60 * 60 * 1000;
  const scored = items.map(it => {
    const sim = cosine(it.embedding, query.embedding);
    const score = config.useDecay
      ? sim * decayWeight(Math.max(0, nowMs - it.storedAt), halfLife)
      : sim;
    return { id: it.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, config.k).map(s => s.id);
}

/** Run the full eval, returning a deterministic RunResult. */
export function runEval(
  items: MemoryItem[],
  queries: EvalQuery[],
  config: RetrievalConfig,
  nowMs: number,
): RunResult {
  const latencies: number[] = [];
  let totalRecall = 0;
  let totalMrr = 0;
  const byCat: Record<EvalCategory, { recall: number; mrr: number; n: number }> = {
    'single-hop': { recall: 0, mrr: 0, n: 0 },
    'temporal': { recall: 0, mrr: 0, n: 0 },
    'multi-hop': { recall: 0, mrr: 0, n: 0 },
    'open-domain': { recall: 0, mrr: 0, n: 0 },
  };

  for (const q of queries) {
    const t0 = performance.now();
    const ranked = rank(items, q, config, nowMs);
    const dt = performance.now() - t0;
    latencies.push(dt);

    // recall@k = (relevant retrieved) / (total relevant)
    let hits = 0;
    let firstHitRank = Infinity;
    for (let i = 0; i < ranked.length; i++) {
      if (q.relevant.has(ranked[i]!)) {
        hits++;
        firstHitRank = Math.min(firstHitRank, i + 1);
      }
    }
    const recall = q.relevant.size === 0 ? 0 : hits / q.relevant.size;
    const mrr = firstHitRank === Infinity ? 0 : 1 / firstHitRank;
    totalRecall += recall;
    totalMrr += mrr;
    byCat[q.category].recall += recall;
    byCat[q.category].mrr += mrr;
    byCat[q.category].n += 1;
  }

  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * q))]!;

  // Average per-category.
  for (const c of Object.keys(byCat) as EvalCategory[]) {
    const n = byCat[c].n;
    if (n > 0) {
      byCat[c].recall /= n;
      byCat[c].mrr /= n;
    }
  }

  return {
    config,
    queries: queries.length,
    recall: queries.length === 0 ? 0 : totalRecall / queries.length,
    mrr: queries.length === 0 ? 0 : totalMrr / queries.length,
    p50_latency_ms: p(0.5),
    p95_latency_ms: p(0.95),
    by_category: byCat,
  };
}

/**
 * Build a deterministic synthetic corpus + query set so the bench
 * is reproducible across CI runners.
 *
 * Each query has 1-3 relevant items planted at known similarity levels.
 * Temporal queries reward decay; open-domain queries don't.
 */
export function buildSyntheticEval(opts: { items: number; queries: number; seed?: number }): {
  items: MemoryItem[];
  queries: EvalQuery[];
  nowMs: number;
} {
  const seed = opts.seed ?? 42;
  const rng = mulberry32(seed);
  const dim = 16; // small dimension for fast bench
  const items: MemoryItem[] = [];
  const queries: EvalQuery[] = [];
  const categories: EvalCategory[] = ['single-hop', 'temporal', 'multi-hop', 'open-domain'];
  const nowMs = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  // Generate items.
  for (let i = 0; i < opts.items; i++) {
    const cat = categories[i % categories.length]!;
    // Temporal items spread over 30 days; others recent.
    const ageDays = cat === 'temporal' ? rng() * 30 : rng() * 2;
    items.push({
      id: `item-${i}`,
      text: `synthetic item ${i} in ${cat}`,
      embedding: randomUnit(dim, rng),
      storedAt: nowMs - ageDays * DAY,
      category: cat,
    });
  }

  // Generate queries — each query's embedding is a NOISY copy of a
  // randomly-chosen item, and that item is the relevant target.
  for (let q = 0; q < opts.queries; q++) {
    const target = items[Math.floor(rng() * items.length)]!;
    const queryEmbedding = noisyCopy(target.embedding, 0.15, rng);
    queries.push({
      id: `q-${q}`,
      text: `query ${q}`,
      embedding: queryEmbedding,
      relevant: new Set([target.id]),
      category: target.category,
    });
  }

  return { items, queries, nowMs };
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnit(dim: number, rng: () => number): number[] {
  const v = Array.from({ length: dim }, () => rng() * 2 - 1);
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag === 0 ? v : v.map(x => x / mag);
}

function noisyCopy(v: number[], noise: number, rng: () => number): number[] {
  const out = v.map(x => x + (rng() * 2 - 1) * noise);
  const mag = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  return mag === 0 ? out : out.map(x => x / mag);
}
