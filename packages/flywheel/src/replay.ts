// @metaharness/flywheel — independent replay. Given ONLY a ReplayBundle (and, optionally, the pinned
// gate fingerprint + the gate rule itself), an external reviewer establishes the run with no trust in the
// producer:
//   (1) every promotion receipt verifies (Ed25519, recompute canon vs the embedded key);
//   (2) the promoted lineage reconstructs current → gen-0 immutable root, contiguously;
//   (3) every commit on the promoted chain is actually PROMOTED (no rejected node smuggled in);
//   (4) the gate fingerprint matches the pinned value ⇒ the promotion rule was UNCHANGED;
//   (5) [ADR-235, extended ADR-254] if the reviewer supplies the (fingerprint-matched) rule, every
//       PROMOTED commit is RE-GATED on its sealed baseline+candidate+anchor scores and must STILL
//       promote — trust the gate re-run, not the logged verdict. Catches a signed-but-forged promotion
//       the fingerprint check cannot. A PROMOTED commit with no (complete, well-typed) sealed scores to
//       re-gate FAILS this check, not passes by omission — including a root-pinned anchor bar with no
//       matching anchorScore on the commit.
//   (6) every entry in `all_commits` — the full diagnostic ledger of promoted AND rejected candidates —
//       also carries a receipt that verifies AND actually attests to that commit's own id + verdict, not
//       just the promoted `chain`. A signature is only as trustworthy as the fields it covers: `run.ts`
//       signs {kind, id, target, verdict, primaryDelta, ...sealed scores} (root: {kind, root}), so
//       `verifyReceipt` alone proves the PAYLOAD is internally consistent, not that it's attached to the
//       RIGHT commit — without cross-checking id/verdict, a REJECTED commit's outer `verdict` field could
//       be flipped to `PROMOTED` (or a receipt spliced onto a different id) and still "verify."
//   (7) whichever of id/target/verdict/primaryDelta/baselineScore/candidateScore/anchorScore/
//       failureReasons/parents/generation a commit's SIGNED receipt payload carries, the signed copy
//       must match the commit's live (unsigned) fields. Binding 'id' matters as much as the score
//       fields: without it, a bundle editor with no signing key can clone ONE genuine receipt across many
//       fabricated commit ids/parents (copying the real receipt's baseline/candidate/anchor scores onto
//       each fabricated commit too) to manufacture a fake multi-generation promoted lineage from a single
//       real promotion — (6)'s id/verdict cross-check alone would not catch this, since the cloned
//       receipt's sealed values still match the copied live fields. Binding 'parents'/'generation' closes
//       a DIFFERENT bypass of point (2): an editor can take TWO genuinely-signed, self-consistent commits
//       (each still correctly bound to its own id/scores) and splice them into a fabricated chain by
//       rewriting only their unsigned `parents`/`generation` — every per-commit check still passes, but
//       the reconstructed chain SHAPE was never actually signed by the producer. Checking whichever keys
//       a payload happens to carry keeps this additive: a receipt whose payload predates this check
//       (carries none of these keys) is left unchecked here — it does not retroactively secure old
//       bundles, only binds every bundle produced after this check shipped.
import { verifyReceipt, canon } from './receipts.js';
import { gateFingerprint } from './gate.js';
import { pairedOutcomesFromItemWins } from './sequential.js';
import type { ReplayBundle, PromotionRule, LineageCommit, Score } from './types.js';

// A bundle is untrusted external JSON — `baselineScore != null` only proves the field exists, not that
// its required sub-fields are present and well-typed. `meetsPromotionRule` compares them with `<`/`>` on
// possibly-`undefined` values, and JS comparison semantics make several of those clauses fail OPEN (e.g.
// `undefined > n` is false, so a missing `costPerWin` or `regressed` never trips its rejection reason).
// A Score with a missing/mistyped field is exactly as unusable as a missing Score for gate re-execution.
function isCompleteScore(s: Score | undefined): s is Score {
  return (
    !!s &&
    typeof s.primary === 'number' &&
    typeof s.noopRate === 'number' &&
    typeof s.costPerWin === 'number' &&
    typeof s.regressed === 'boolean'
  );
}

/** A verified signature proves the PAYLOAD is internally consistent; it does not by itself prove the
 *  payload is attached to the RIGHT commit. `run.ts` signs `{kind:'candidate', id, target, verdict,
 *  primaryDelta, ...}` for every candidate (root: `{kind:'root', root}`) — cross-check `id`/`verdict`
 *  against the embedded payload so a receipt cannot be spliced onto a different id, and a REJECTED
 *  commit's outer `verdict` field cannot be flipped to `PROMOTED` (or vice versa) without invalidating
 *  the check. */
function receiptMatchesCommit(c: LineageCommit): boolean {
  const p = c.receipt.payload as { kind?: unknown; id?: unknown; verdict?: unknown; root?: unknown };
  if (c.verdict === 'ROOT') return p.kind === 'root' && p.root === c.id;
  return p.kind === 'candidate' && p.id === c.id && p.verdict === c.verdict;
}

export interface ReplayVerdict {
  pass: boolean;
  checks: {
    receipts: boolean;
    reachesRoot: boolean;
    contiguousParents: boolean;
    allPromoted: boolean;
    gateUnchanged: boolean;
    gateReExecutes: boolean;
    /** Every entry in `all_commits` — the full diagnostic ledger, PROMOTED *and* REJECTED — carries a
     *  receipt that both verifies AND attests to that commit's own id + verdict (see the file header's
     *  point (6)). `run.ts` signs every commit it mints, promoted or not, so this is always satisfiable
     *  by an honest producer; it exists to catch a receipt-splicing / verdict-flip forgery that
     *  `receipts` alone (chain-only) would miss. */
    allCommitsReceipts: boolean;
    /** See the file header's point (7): whichever sealed fields a receipt's signed payload carries must
     *  match the commit's own live fields, including `id` — catches post-signing tampering of unsigned
     *  fields AND receipt-cloning onto a fabricated commit, neither of which a bare signature check nor
     *  (6) alone can distinguish from an honest bundle. */
    sealedFieldsAuthentic: boolean;
  };
  failures: string[];
  chainSummary: string;
}

export function verifyReplayBundle(
  bundle: ReplayBundle,
  opts: { pinnedGateFingerprint?: string; promotionRule?: PromotionRule } = {},
): ReplayVerdict {
  const failures: string[] = [];
  const chain = bundle.chain;

  const receipts = chain.length > 0 && chain.every((c) => verifyReceipt(c.receipt) && receiptMatchesCommit(c));
  if (!receipts) failures.push('receipts');

  // `chain` proves the WINNING lineage; `all_commits` is the "full diagnostic ledger" (every candidate
  // across every generation, promoted + rejected — see ReplayBundle) that analyzeBundle's
  // rejection-reason / cost-per-win / mutation-effectiveness reporting reads. The producer already signs
  // every commit it mints (run.ts: `receipt: cfg.signer.sign(...)` on both PROMOTED and REJECTED verdicts)
  // — verifying only `chain`'s receipts left that ledger's signatures (and the id/verdict they attest to)
  // unchecked, so a receipt-splicing or verdict-flip forgery on a REJECTED entry would not fail replay.
  const allCommitsReceipts = bundle.all_commits.every((c) => verifyReceipt(c.receipt) && receiptMatchesCommit(c));
  if (!allCommitsReceipts) failures.push('allCommitsReceipts');

  const root = chain[chain.length - 1];
  const reachesRoot = !!root && root.parents.length === 0 && root.id === bundle.root_id;
  if (!reachesRoot) failures.push('reachesRoot');

  let contiguousParents = chain.length > 0;
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i]!.parents.includes(chain[i + 1]!.id)) contiguousParents = false;
  }
  if (!contiguousParents) failures.push('contiguousParents');

  // Every non-root commit on the promoted chain must be PROMOTED (no rejected node smuggled in). An
  // HONEST-NULL run — the flywheel found no improvement, so the chain is just the immutable gen-0 root —
  // is VALID and replayable: an empty set of non-root commits satisfies this VACUOUSLY. (Requiring
  // ≥1 promotion here was a bug: it failed replay on a legitimate 0-promotion result, e.g. a weak model
  // that resolves nothing — the negative is a real, verifiable outcome, not an invalid bundle.)
  const promos = chain.filter((c) => c.verdict !== 'ROOT');
  const allPromoted = promos.every((c) => c.verdict === 'PROMOTED');
  if (!allPromoted) failures.push('allPromoted');

  const gateUnchanged = opts.pinnedGateFingerprint ? bundle.gate_fingerprint === opts.pinnedGateFingerprint : true;
  if (!gateUnchanged) failures.push('gateUnchanged');

  // The run's frozen anti-Goodhart bar is the ROOT commit's sealed `anchorScore` (set once at gen-0,
  // run.ts — the same `rootAnchor` every live winner was compared against). Reading it off `root` here
  // keeps the anchor re-check at the SAME sealed-field trust tier as the baseline/candidate re-execution
  // below — not a new/stronger guarantee. (Hardening sealed fields against bundle-editing, as opposed to
  // signature, forgery is (7) above — the anchor axis is covered there too via `sealedFieldsAuthentic`.)
  const rootAnchorSealed = root && root.anchorScore != null ? root.anchorScore : null;

  // (5) RE-EXECUTE the gate. Only when the reviewer supplies the rule (otherwise unchecked → true, so
  // existing fingerprint-only callers are unaffected). The supplied rule must be the SAME one (its
  // fingerprint must match the pinned/bundled value) or re-execution is meaningless. Then every PROMOTED
  // commit that carries its sealed scores must RE-PASS the rule — a logged promotion the frozen gate
  // would NOT grant is a forgery. This includes the anti-Goodhart anchor clause: previously
  // `evidence.anchor` was NEVER supplied here, so `anchor_regressed` was structurally unreachable during
  // replay even though `run.ts` enforces it live — a promotion that regressed the frozen anchor replayed
  // clean.
  let gateReExecutes = true;
  if (opts.promotionRule) {
    const suppliedFp = gateFingerprint(opts.promotionRule);
    const expectedFp = opts.pinnedGateFingerprint ?? bundle.gate_fingerprint ?? undefined;
    if (expectedFp && suppliedFp !== expectedFp) {
      gateReExecutes = false; // wrong rule supplied — cannot re-execute the run's gate
    } else {
      const seen = new Set<string>();
      for (const c of [...chain, ...bundle.all_commits] as LineageCommit[]) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (c.verdict !== 'PROMOTED') continue;
        // Fail-closed: a PROMOTED commit missing (or carrying an incomplete/mistyped) sealed score this
        // verification mode claims to re-execute is not "unchecked" — it cannot prove the gate re-run, so
        // replay must not pass it. Previously a bare truthy check silently SKIPPED an unauditable
        // promotion (neither pass nor fail); per ADR-235 ("trust the gate re-run, not the logged
        // verdict"), an unauditable promotion must FAIL.
        if (!isCompleteScore(c.baselineScore) || !isCompleteScore(c.candidateScore)) {
          gateReExecutes = false;
          break;
        }
        // Same fail-closed rule for the anchor axis: once the root pins an anchor bar, a promoted commit
        // missing its own anchorScore must not silently drop out of the anti-Goodhart check (that was the
        // original gap — anchor: undefined made the clause unreachable instead of failing).
        if (rootAnchorSealed != null && c.anchorScore == null) {
          gateReExecutes = false;
          break;
        }
        const anchor = rootAnchorSealed != null ? { baseline: rootAnchorSealed, candidate: c.anchorScore! } : undefined;
        // Sequential-evidence re-verification (2026-09-06 addendum, same ADR): a PROMOTED commit whose
        // sealed baseline/candidate scores carry `itemWins` (see Score.itemWins) is re-gated with the SAME
        // pairedOutcomes it was LIVE-gated with — a caller that live-gates with
        // `withSequentialEvidence(...)` must not have that guarantee silently re-verified as just the
        // wrapped base rule during replay. Absent `itemWins` (every bundle produced before tonight, and
        // any non-sequential Evaluator), this is `undefined` and behavior is byte-for-byte unchanged.
        const pairedOutcomes = pairedOutcomesFromItemWins(c.baselineScore, c.candidateScore);
        if (!opts.promotionRule({ baseline: c.baselineScore, candidate: c.candidateScore, anchor, ...(pairedOutcomes ? { pairedOutcomes } : {}) }).promote) {
          gateReExecutes = false;
          break;
        }
      }
    }
  }
  if (!gateReExecutes) failures.push('gateReExecutes');

  // (7) RECEIPT-BOUND-TO-COMMIT (see header). 'id' binds the receipt to a specific commit — without it,
  // whichever score/reason keys a payload carries can canon-match by cloning the whole receipt (sealed
  // fields included) onto a different, fabricated commit that copies the same values live. 'parents' and
  // 'generation' matter for a DIFFERENT reason: without them, an editor with no signing key can take TWO
  // genuinely-signed, internally self-consistent commits (each still correctly bound to its own id/scores)
  // and splice them into a fabricated multi-generation chain by rewriting only their unsigned
  // `parents`/`generation` fields — every per-commit check above still passes, but `contiguousParents` and
  // `reachesRoot` are then reconstructing a chain shape the producer never actually signed. Binding
  // `parents`/`generation` closes that: a rewritten `parents` no longer canon-matches the signed value.
  // Only receipts whose payload opts in (carries at least one of these keys) are checked — additive over
  // every pre-existing bundle.
  const BOUND_KEYS: { [k: string]: (c: LineageCommit) => unknown } = {
    id: (c) => c.id,
    target: (c) => c.mutation?.target ?? null,
    verdict: (c) => c.verdict,
    primaryDelta: (c) => c.primaryDelta,
    baselineScore: (c) => c.baselineScore ?? null,
    candidateScore: (c) => c.candidateScore ?? null,
    anchorScore: (c) => c.anchorScore,
    failureReasons: (c) => c.failureReasons,
    parents: (c) => c.parents,
    generation: (c) => c.generation,
  };
  let sealedFieldsAuthentic = true;
  {
    const seen = new Set<string>();
    for (const c of [...chain, ...bundle.all_commits] as LineageCommit[]) {
      if (seen.has(c.id) || c.verdict === 'ROOT') continue;
      seen.add(c.id);
      const payload = c.receipt.payload as Record<string, unknown>;
      for (const [k, live] of Object.entries(BOUND_KEYS)) {
        if (!(k in payload)) continue;
        if (canon(payload[k]) !== canon(live(c))) { sealedFieldsAuthentic = false; break; }
      }
      if (!sealedFieldsAuthentic) break;
    }
  }
  if (!sealedFieldsAuthentic) failures.push('sealedFieldsAuthentic');

  return {
    pass: failures.length === 0,
    checks: { receipts, reachesRoot, contiguousParents, allPromoted, gateUnchanged, gateReExecutes, allCommitsReceipts, sealedFieldsAuthentic },
    failures,
    chainSummary: chain.map((c) => `gen${c.generation}${c.mutation ? `(${c.mutation.target})` : '(root)'}`).join(' → '),
  };
}
