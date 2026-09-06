// @metaharness/flywheel — runFlywheelGenerations(): the promotion LOOP. run → measure → mutate → verify
// → promote, generation after generation, each re-basing on the previous promoted winner so verified
// wins COMPOUND into an auditable lineage. Host- and benchmark-agnostic: everything specific enters via
// the injected `proposer` / `evaluator` / `promotionRule`. The gate selects the winner on the HOLDOUT;
// the FROZEN anchor is a separate survival check (never optimized against — the anti-Goodhart guard).
import { InMemoryLineageStore, computeLiftCurve } from './lineage.js';
import { meetsPromotionRule, gateFingerprint } from './gate.js';
import { pairedOutcomesFromItemWins } from './sequential.js';
import type {
  Policy, PolicyGenome, Proposer, Evaluator, PromotionRule, Signer, CandidateMutation,
  HoldoutSuite, AnchorSuite, LineageStore, LineageCommit, LiftCurve, ReplayBundle, Score,
  GenerationCheckpoint, ResumeState, PairedOutcome,
} from './types.js';

/** Builds the per-item pairing a sequential-evidence rule (`withSequentialEvidence`, sequential.ts) needs,
 *  when — and only when — BOTH the baseline and candidate Score carry a suite-aligned `itemWins` vector
 *  (see {@link Score.itemWins}). Otherwise returns `undefined` so the rule call omits `pairedOutcomes`
 *  entirely and any sequential-evidence rule degrades to its base rule, unchanged from today — this
 *  package's only Evaluators that don't opt in are completely unaffected by this wiring existing. The
 *  extra `suiteLen` check (on top of `pairedOutcomesFromItemWins`'s own length-agreement check) guards
 *  against an Evaluator whose `itemWins` silently drifted from the actual holdout it was called with. */
function pairedOutcomesOf(baseline: Score, candidate: Score, suiteLen: number): PairedOutcome[] | undefined {
  const paired = pairedOutcomesFromItemWins(baseline, candidate);
  return paired && paired.length === suiteLen ? paired : undefined;
}

export interface FlywheelConfig {
  /** The gen-0 policy — the immutable root every promotion chains back to. */
  rootPolicy: Policy;
  proposer: Proposer;
  evaluator: Evaluator;
  /** The FROZEN gate. Default: {@link meetsPromotionRule}. Inject your own compliance/cost gate here. */
  promotionRule?: PromotionRule;
  holdout: HoldoutSuite;
  /** Optional frozen anchor suite — never optimized against; a winner must not regress it to count. */
  anchor?: AnchorSuite;
  /** Which policy levers to try each generation. Default: every key of `rootPolicy`. */
  mutationTargets?: string[];
  maxGenerations: number;
  signer: Signer;
  /** Stop early once `spent() ≥ total` (e.g. a $ budget). */
  budget?: { total: number; spent: () => number };
  /** Caller-supplied ISO/label per generation (determinism; no clock in the engine). */
  now?: (generation: number) => string;
  /** Reuse evaluator results for (policy, suite) pairs already scored this run. The proposer can
   *  legitimately re-propose a policy a previous generation already tried (small lever domains,
   *  cycling proposers); each evaluation is typically a full benchmark run, so replays are the
   *  engine's dominant avoidable cost. OFF by default: only enable for evaluators that are
   *  deterministic (or whose first measurement you are happy to reuse) — a stochastic evaluator's
   *  cached score freezes one sample of the noise. */
  cacheEvaluations?: boolean;
  /** Stamped on the replay bundle — 'SYNTHETIC' | 'LIVE' | …. NEVER a benchmark name. */
  dataSource?: string;
  /** Optional per-generation checkpoint hook — called at the END of each generation with a fully
   *  assembled replay bundle for the run so far. Lets a long (multi-hour) run persist incremental
   *  progress so a crash keeps the completed generations. Observation-only: never affects promotion.
   *  Errors thrown by the hook are swallowed (a bad checkpoint must not kill a valid run). */
  onGeneration?: (info: GenerationCheckpoint) => void | Promise<void>;
  /** Resume a crashed run from a persisted {@link GenerationCheckpoint.resumeState}. When set, the gen-0
   *  root is NOT re-evaluated or re-created — the prior lineage is re-seeded and the loop continues from
   *  `resumeFrom.fromGeneration + 1`. Unset ⇒ a fresh run (identical to before). The caller is
   *  responsible for restoring any external spend counter from the checkpoint's `spent`. */
  resumeFrom?: ResumeState;
  lineageStore?: LineageStore;
  rootId?: string;
}

export interface FlywheelResult {
  liftCurve: LiftCurve;
  /** The promoted chain (current → root). */
  promotions: LineageCommit[];
  lineage: LineageStore;
  replayBundle: ReplayBundle;
  generationsRun: number;
  /** ≥2 anchor-surviving verified improvements joined the immutable lineage with no human. */
  milestoneReached: boolean;
  finalPolicy: Policy;
}

export async function runFlywheelGenerations(cfg: FlywheelConfig): Promise<FlywheelResult> {
  const rule = cfg.promotionRule ?? meetsPromotionRule;
  const targets = cfg.mutationTargets ?? Object.keys(cfg.rootPolicy);
  const store = cfg.lineageStore ?? new InMemoryLineageStore();
  const now = cfg.now ?? ((g: number) => `gen-${g}`);
  const rootId = cfg.rootId ?? 'root';

  // Optional per-run evaluation memo (see FlywheelConfig.cacheEvaluations). Keyed by suite id +
  // key-sorted policy, so key order in the Policy object never splits the cache. Returns a copy so
  // a caller mutating a Score cannot poison later hits.
  const evalCache = cfg.cacheEvaluations ? new Map<string, Score>() : null;
  const evaluate: Evaluator = async (p, suite) => {
    if (!evalCache) return cfg.evaluator(p, suite);
    const key = `${suite.id}\u0000${JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]))}`;
    const hit = evalCache.get(key);
    if (hit) return { ...hit };
    const s = await cfg.evaluator(p, suite);
    evalCache.set(key, s);
    return { ...s };
  };

  const anchorOf = async (p: Policy): Promise<number | null> =>
    cfg.anchor ? (await evaluate(p, cfg.anchor)).primary : null;

  let rootScore: Score;
  let rootAnchor: number | null;
  let parentId: string;
  let policy: Policy;
  let score: Score;
  const allCommits: LineageCommit[] = [];
  let generationsRun = 0;
  let startGen = 1;

  if (cfg.resumeFrom) {
    // ── RESUME: re-seed the prior lineage and restore the mutable state; DON'T re-evaluate the root. ──
    const r = cfg.resumeFrom;
    for (const c of r.priorCommits) await store.append(c);
    allCommits.push(...r.priorCommits.filter((c) => c.verdict !== 'ROOT')); // allCommits excludes the root
    rootScore = r.rootScore; rootAnchor = r.rootAnchor;
    parentId = r.parentId; policy = { ...r.policy }; score = r.score;
    generationsRun = r.fromGeneration; startGen = r.fromGeneration + 1;
  } else {
    // ── gen-0: the immutable root. Evaluate it once (the baseline) + its anchor (the frozen bar). ──
    rootScore = await evaluate(cfg.rootPolicy, cfg.holdout);
    rootAnchor = await anchorOf(cfg.rootPolicy);
    await store.append({
      id: rootId, generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: rootAnchor,
      verdict: 'ROOT', failureReasons: [], receipt: cfg.signer.sign({ kind: 'root', root: rootId }), createdAt: now(0),
    });
    parentId = rootId;
    policy = { ...cfg.rootPolicy };
    score = rootScore;
  }

  // Assemble a self-consistent replay bundle for the run SO FAR (or final). Pure over the current
  // lineage; used both for the per-generation checkpoint and the final return so the two can never
  // diverge. `rootScore`, `rootAnchor`, `allCommits`, `rule`, `rootId`, `cfg` are captured by closure.
  const buildBundle = (chainNow: LineageCommit[], createdAt: string): ReplayBundle => {
    const promoted = chainNow.filter((c) => c.verdict === 'PROMOTED');
    const verifiedN = promoted.filter((c) => c.primaryDelta > 0).length;
    const anchorSurvivingN = promoted.filter((c) => c.primaryDelta > 0 && (rootAnchor === null || (c.anchorScore ?? -Infinity) >= rootAnchor)).length;
    return {
      data_source: cfg.dataSource ?? 'UNSPECIFIED',
      root_id: rootId,
      chain: chainNow,
      all_commits: allCommits,
      lift_curve: computeLiftCurve(chainNow, rootScore.primary),
      gate_fingerprint: gateFingerprint(rule),
      verified_improvements: verifiedN,
      anchor_surviving_improvements: anchorSurvivingN,
      milestone_reached: anchorSurvivingN >= 2,
      created_at: createdAt,
    };
  };

  for (let gen = startGen; gen <= cfg.maxGenerations; gen++) {
    if (cfg.budget && cfg.budget.spent() >= cfg.budget.total) break;
    generationsRun = gen;

    // propose + evaluate one candidate per mutation target, gate each on the HOLDOUT.
    const base: PolicyGenome = { id: parentId, generation: gen, parents: [parentId], policy };
    const cands: Array<{
      target: string; policy: Policy; score: Score; reasons: string[]; promote: boolean;
      summary?: string; inverse?: CandidateMutation['inverse'];
    }> = [];
    for (const target of targets) {
      const proposed = await cfg.proposer(base, target);
      // ADR-246 §2.1 (additive): normalize the proposer result — legacy bare string, or the object form
      // carrying an evidence-citing summary + rollback inverse for the minted lineage commit.
      const norm = typeof proposed === 'string' ? { value: proposed } : proposed;
      const candPolicy: Policy = { ...policy, [target]: norm.value };
      const candScore = await evaluate(candPolicy, cfg.holdout);
      // Anytime-valid sequential evidence (sequential.ts) can only ever gate a LIVE run through this call —
      // it needs it here, not just at replay, since it decides which candidate gets promoted in the first
      // place. See `pairedOutcomesOf` above: populated only when the Evaluator opts in via `itemWins`.
      const pairedOutcomes = pairedOutcomesOf(score, candScore, cfg.holdout.items.length);
      const decision = rule({ baseline: score, candidate: candScore, ...(pairedOutcomes ? { pairedOutcomes } : {}) });
      cands.push({
        target, policy: candPolicy, score: candScore, reasons: decision.reasons, promote: decision.promote,
        summary: norm.summary, inverse: norm.inverse,
      });
    }

    // winner = highest primary among the promotable; then verify it survives the FROZEN anchor.
    const promotable = cands.filter((c) => c.promote).sort((a, b) => b.score.primary - a.score.primary);
    const winner = promotable[0] ?? null;
    const winnerAnchor = winner ? await anchorOf(winner.policy) : null;
    const anchorSurvives = winner ? (rootAnchor === null || (winnerAnchor ?? -Infinity) >= rootAnchor) : false;
    // A winner that regresses the anchor is NOT promoted (Goodhart guard) — it becomes a rejection.
    const promotedWinner = winner && anchorSurvives ? winner : null;

    for (const c of cands) {
      const isWinner = c === promotedWinner;
      const id = `${parentId}__${c.target}_gen${gen}`;
      const primaryDelta = c.score.primary - score.primary;
      const anchorScore = isWinner ? winnerAnchor : c === winner ? winnerAnchor : null;
      const verdict: 'PROMOTED' | 'REJECTED' = isWinner ? 'PROMOTED' : 'REJECTED';
      const failureReasons = isWinner ? [] : c === winner && !anchorSurvives ? ['anchor_regressed'] : c.reasons;
      const commit: LineageCommit = {
        id, generation: gen, parents: [parentId],
        // ADR-246 §2.1: an object-form proposer's summary (and rollback inverse) reaches the lineage
        // commit; a legacy string-form proposer keeps the exact `adapt <target>` summary, unchanged.
        mutation: { target: c.target, summary: c.summary ?? `adapt ${c.target}`, ...(c.inverse ? { inverse: c.inverse } : {}) },
        primaryDelta,
        anchorScore,
        verdict,
        failureReasons,
        // Sealed-field binding (ADR-254 addendum): baseline/candidate/anchor scores + failureReasons
        // enter the SIGNED payload too, not just the commit's unsigned fields below — otherwise a bundle
        // editor with no signing key can splice favorable scores onto a PROMOTED commit and
        // gateReExecutes (replay.ts, ADR-235) would re-run the frozen rule on forged input and still
        // pass. `parents`/`generation` are sealed too: without them, an editor with no signing key could
        // reattach two genuinely-signed, self-consistent commits into a fabricated multi-generation chain
        // by rewriting only their unsigned `parents`/`generation` — every per-commit check (id binding,
        // score re-gate) still passes because each commit is still bound to itself, but the CHAIN
        // structure itself is undefended. See replay.ts's `sealedFieldsAuthentic` check.
        receipt: cfg.signer.sign({
          kind: 'candidate', id, target: c.target, verdict, primaryDelta,
          baselineScore: score, candidateScore: c.score, anchorScore, failureReasons,
          parents: [parentId], generation: gen,
        }),
        createdAt: now(gen),
        baselineScore: score,       // ADR-235 — sealed so the gate can be re-run in replay
        candidateScore: c.score,
      };
      await store.append(commit);
      allCommits.push(commit);
    }

    if (promotedWinner) { parentId = `${parentId}__${promotedWinner.target}_gen${gen}`; policy = promotedWinner.policy; score = promotedWinner.score; }

    // Per-generation checkpoint — a fully assembled, replay-verifiable bundle for the run so far, so a
    // long run can persist incremental progress. Fail-safe: a throwing hook must NOT kill a valid run.
    if (cfg.onGeneration) {
      try {
        const partialChain = await store.walkToRoot(parentId);
        const info: GenerationCheckpoint = {
          generation: gen,
          generationsRun,
          partialBundle: buildBundle(partialChain, now(gen)),
          spent: cfg.budget ? cfg.budget.spent() : 0,
          resumeState: {
            rootScore, rootAnchor, parentId, policy, score,
            fromGeneration: gen,
            priorCommits: await store.list(), // root + every candidate — re-seeds the store on resume
          },
        };
        await cfg.onGeneration(info);
      } catch { /* checkpoint is observational — never let it abort a valid run */ }
    }
  }

  const chain = await store.walkToRoot(parentId);
  const replayBundle = buildBundle(chain, now(cfg.maxGenerations));
  const promotions = chain.filter((c) => c.verdict === 'PROMOTED');

  return {
    liftCurve: replayBundle.lift_curve, promotions, lineage: store, replayBundle,
    generationsRun,
    milestoneReached: replayBundle.milestone_reached, finalPolicy: policy,
  };
}
