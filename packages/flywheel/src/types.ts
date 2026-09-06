// @metaharness/flywheel — the abstract API surface.
//
// DESIGN RULE (load-bearing): this package must NOT know about any host, model, or benchmark — no
// Claude Code, no SWE-bench, no GLM/Sonnet/Fable, no code-repair. It knows only CANDIDATES, SCORES,
// GATES, RECEIPTS, and PROMOTION LINEAGE. Everything host- or benchmark-specific enters through the
// injected `Proposer` / `Evaluator` (and, if you like, a custom `PromotionRule`). If you find yourself
// wanting a benchmark-specific branch in here, it belongs in the caller, not the flywheel.

/** A policy is an opaque bag of named string levers — the thing being evolved. The flywheel never
 *  interprets a lever's meaning; the caller's Evaluator does. */
export type Policy = Record<string, string>;

/** A versioned policy node in the evolution graph. `parents` is a DAG (usually one parent = the winner
 *  it re-based on); the gen-0 root has `parents: []` and never changes. */
export interface PolicyGenome {
  id: string;
  generation: number;
  parents: string[];
  policy: Policy;
}

/** One mutation attempt: which lever was changed, and a short human summary of how. */
export interface CandidateMutation {
  target: string;
  summary: string;
  /** ADR-246 §2.1 rollback-by-construction: the inverse of the applied edit — the parent bytes for the
   *  touched surface (plus its path and a content hash), so any refine step reverts byte-identically.
   *  OPTIONAL and additive (precedent: ADR-235 additive fields) — legacy commits simply omit it. */
  inverse?: { path: string; parentBytes: string; hash: string };
}

/** The abstract quality of a policy on a suite. All host/benchmark meaning is projected onto these four
 *  axes by the Evaluator. Higher `primary` is better; lower `noopRate`/`costPerWin` is better;
 *  `regressed` is a hard safety/security stop. (Named generically on purpose — "primary" not "gold".) */
export interface Score {
  /** The main quality signal (wins / accuracy / resolved) — higher is better. */
  primary: number;
  /** Fraction of non-committal / empty / no-op outputs — lower is better (the "never end empty" signal). */
  noopRate: number;
  /** Resource cost per successful outcome — lower is better. */
  costPerWin: number;
  /** A hard safety/security regression flag — any `true` blocks promotion outright. */
  regressed: boolean;
  /** OPTIONAL, additive: per-item win indicator, one entry per `suite.items`, in the SAME order the
   *  Evaluator was called with — e.g. `[true, false, true, ...]` meaning "this policy won item 0, lost
   *  item 1, won item 2". An Evaluator that wants its promotions covered by the anytime-valid sequential
   *  gate (see `sequential.ts`) sets this on both the baseline and candidate Score it returns for the SAME
   *  suite; `runFlywheelGenerations` zips the two arrays by index into `PromotionEvidence.pairedOutcomes`.
   *  Absent (the default) ⇒ no pairing is possible and any sequential-evidence rule degrades to its base
   *  rule, unchanged from today. */
  itemWins?: boolean[];
}

/** One paired per-item outcome — did the candidate and the baseline each win THIS suite item? Only a
 *  DISCORDANT pair (exactly one side won) carries information for the sequential e-process in
 *  `sequential.ts`; see `sequentialEvidence`. */
export interface PairedOutcome {
  /** Suite item id. Pairing is by item — comparing unpaired sets is a different, weaker test. When the
   *  two `Score.itemWins` vectors are reconstructed from a plain positional array (no typed item ids are
   *  available — see `Suite.items: unknown[]`), this is the array index, stringified; it is still a
   *  stable, unique per-item key within one comparison, which is all `sequentialEvidence` needs. */
  itemId: string;
  candidateWon: boolean;
  baselineWon: boolean;
}

/** What a promotion gate decides over. `anchor` (optional) is the FROZEN, never-optimized-against suite
 *  score — the anti-Goodhart check. `pairedOutcomes` (optional) is the per-item breakdown a sequential-
 *  evidence rule (`withSequentialEvidence`, sequential.ts) reads; see {@link Score.itemWins} for how it is
 *  populated. Absent for any caller that has not wired up per-item outcomes. */
export interface PromotionEvidence {
  baseline: Score;
  candidate: Score;
  anchor?: { baseline: number; candidate: number };
  pairedOutcomes?: PairedOutcome[];
}

export interface PromotionDecision {
  promote: boolean;
  reasons: string[];
}

/** THE GATE. Pure, deterministic, and — for a given deployment — FROZEN ("the gate is the product").
 *  Injectable so enterprises can supply their own; {@link meetsPromotionRule} is the default. */
export type PromotionRule = (evidence: PromotionEvidence) => PromotionDecision;

/** An opaque evaluation suite — the flywheel treats `items` as a black box. HoldoutSuite is optimized
 *  against; AnchorSuite is NOT (it is the frozen no-regression guard). Same shape; different role. */
export interface Suite {
  id: string;
  items: unknown[];
}
export type HoldoutSuite = Suite;
export type AnchorSuite = Suite;

/** A proposer's return: either the bare improved lever value (the legacy shape, unchanged), or — ADR-246
 *  §2.1, additive — an object carrying the value plus an optional evidence-citing `summary` and an
 *  optional rollback `inverse` to be recorded on the minted lineage commit. */
export type ProposerResult =
  | string
  | { value: string; summary?: string; inverse?: CandidateMutation['inverse'] };

/** Proposes an improved value for ONE policy lever. The ONLY seam where a model/host enters propose.
 *  May return the legacy bare string OR the richer {@link ProposerResult} object form. */
export type Proposer = (base: PolicyGenome, target: string) => Promise<ProposerResult>;

/** Scores a policy on a suite. The ONLY seam where a host/benchmark enters evaluate. Everything
 *  Claude-Code-, SWE-bench-, or trading-specific lives HERE, in the caller — never in the flywheel. */
export type Evaluator = (policy: Policy, suite: Suite) => Promise<Score>;

/* ── receipts (trust the signature, not the producer) ───────────────────────── */

export interface PromotionReceipt {
  payload: Record<string, unknown>;
  signature: string; // base64 signature over canon(payload)
  publicKey: string; // base64 SPKI DER
  alg: 'ed25519';
}

/** Signs a receipt + publishes its public key. Injectable (per-process, secret-backed, HSM, …). */
export interface Signer {
  sign(payload: Record<string, unknown>): PromotionReceipt;
  publicKey(): string;
}

/* ── lineage (git for operating policies) ───────────────────────────────────── */

export interface LineageCommit {
  id: string;
  generation: number;
  parents: string[];
  mutation: CandidateMutation | null;
  /** baseline→candidate deltas on each axis (for the knowledge base / regression ancestry). */
  primaryDelta: number;
  anchorScore: number | null;
  verdict: 'ROOT' | 'PROMOTED' | 'REJECTED';
  failureReasons: string[];
  receipt: PromotionReceipt;
  createdAt: string;
  /** ADR-235 — the sealed baseline+candidate Score this commit's verdict was decided from. Lets an
   *  external reviewer RE-RUN the promotion rule and confirm the verdict reproduces (trust the gate
   *  re-run, not the logged verdict). Absent on the gen-0 root (nothing was compared). */
  baselineScore?: Score;
  candidateScore?: Score;
}

export interface LineageStore {
  append(commit: LineageCommit): Promise<void>;
  get(id: string): Promise<LineageCommit | null>;
  /** Walk parents from `id` to the immutable gen-0 root (current → root). */
  walkToRoot(id: string): Promise<LineageCommit[]>;
  list(): Promise<LineageCommit[]>;
}

/* ── the observable proof ───────────────────────────────────────────────────── */

/** One point per promoted generation — the compounding curve. */
export interface LiftPoint {
  generation: number;
  primary: number;
  delta: number;
  anchor: number | null;
}
export type LiftCurve = LiftPoint[];

/** Everything an EXTERNAL reviewer needs to replay the run with no trust in the producer. */
export interface ReplayBundle {
  data_source: string; // caller-stamped ('SYNTHETIC' | 'LIVE' | …). Never a benchmark name.
  root_id: string;
  /** current → gen-0 root (the promoted chain). */
  chain: LineageCommit[];
  /** every candidate commit across all generations (promoted + rejected) — the full diagnostic ledger. */
  all_commits: LineageCommit[];
  lift_curve: LiftCurve;
  /** sha256 of the PromotionRule source, when the caller supplies it — proves the gate was UNCHANGED. */
  gate_fingerprint: string | null;
  verified_improvements: number;
  anchor_surviving_improvements: number;
  milestone_reached: boolean;
  created_at: string;
}

/** Everything needed to RESUME a run from a checkpoint — the mutable engine state at a generation
 *  boundary, made explicit so it can be persisted and handed back as {@link FlywheelConfig.resumeFrom}.
 *  A crashed multi-hour run continues from `fromGeneration + 1` instead of re-spending from generation 1. */
export interface ResumeState {
  /** The gen-0 baseline score (the lift-curve origin) — NOT re-evaluated on resume. */
  rootScore: Score;
  /** The frozen anchor's root score (or null when no anchor) — the never-regress bar. */
  rootAnchor: number | null;
  /** The current promoted head the next generation re-bases on. */
  parentId: string;
  /** The current promoted policy (the levers evolved so far). */
  policy: Policy;
  /** The current promoted policy's holdout score. */
  score: Score;
  /** The last COMPLETED generation (resume starts at this + 1). */
  fromGeneration: number;
  /** Every commit so far (root + candidates) — re-seeds the lineage store so the chain reconstructs. */
  priorCommits: LineageCommit[];
}

/** Handed to the optional per-generation checkpoint hook at the END of each generation. Carries a fully
 *  assembled, replay-verifiable {@link ReplayBundle} for the run SO FAR — so a long (multi-hour) run can
 *  persist incremental progress and a crash is recoverable (the completed generations survive). Purely
 *  observational: the hook never influences promotion. */
export interface GenerationCheckpoint {
  /** 1-based generation index just completed. */
  generation: number;
  /** Total generations run so far (== generation unless the budget stopped it early). */
  generationsRun: number;
  /** A complete, self-consistent replay bundle for the run up to this generation. */
  partialBundle: ReplayBundle;
  /** Cumulative spend if a budget was supplied (else 0). */
  spent: number;
  /** Persist this + pass it back as `resumeFrom` to CONTINUE from this generation after a crash. */
  resumeState: ResumeState;
}
