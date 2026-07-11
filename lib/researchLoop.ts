// Research loop — the retry + tier-descent spine, CRAAP-driven.
//
// Slice 1: for ONE slot, the researcher finds a source (isolated call), CRAAP
// scores it cold (a SEPARATE isolated call), and CODE decides accept-or-retry.
// The retry budget IS the tier descent — attempt N targets tier N — up to 3
// attempts. Keep the best source across all attempts, not the first to pass.
//
// Efficiency slice (pre-Germany): the budget is DEFAULT 1, earn the rest. The
// first attempt is the unescalated default — accept and stop the moment CRAAP
// clears the threshold; the 2 further attempts are spent ONLY when CRAAP comes
// back sub-threshold (escalate on evidence). Coupled with a cheaper search
// ceiling on that first attempt (MAX_SEARCHES_FIRST) than on an escalated one
// (MAX_SEARCHES_ESCALATED). Keep-best is unchanged but dormant on the common
// single-attempt path; it only arbitrates once escalation produces >1 source.
//
// Slice 2: separate a web_search RATE-LIMIT BLOCK from a CRAAP FAILURE. The
// search is wrapped in spacing + backoff (searchSlotWithBackoff). A block means
// the search never ran and no source was evaluated, so it must NOT descend a
// tier or count as a CRAAP attempt — the backoff retries the SAME search; if it
// stays blocked past the budget, the slot halts with a rate_limited outcome
// (an infrastructure result, distinct from a source-quality failure).
//
// Slice 3 (early-stop-on-dead-end): a THIRD failure class, distinct from the two
// above. When the researcher returns resolution_status === "dead_end" — its typed
// verdict that NO sourceable figure exists (positively established, not merely
// "not found this time") — the loop STOPS immediately and routes the slot to the
// assumption-fallback SEAM. It does not descend a tier (a different source won't
// conjure a figure that isn't published) and does not run CRAAP (there is no
// source to score). Per Principle 5 the dead end is a MODEL judgment: code reads
// the typed field and NEVER infers a dead end from null/empty/miss. A `miss` is
// not a dead end — it still flows to CRAAP and tier descent as before.
//
// Isolation (Principle 7): the two components never share a conversation. The
// researcher hands CRAAP only a source package (the filled skeleton). AI vs code
// (Principle 5): the models emit judgments only; the blend, threshold, gate
// decision, retry, backoff, keep-best, and dead-end stop all live in code.
//
// NOT in this slice (later): the assumption fallback BODY itself (Slice 3 builds
// only the stop + the route to a labeled seam that returns no value), and the
// proposer empty-turn fix.
import {
  searchSlotWithBackoff,
  type ResearchSkeleton,
  type ResearchSlot,
  type SearchFn,
  type TierTarget,
} from "./researcher";
import {
  validateSkeleton,
  CRAAP_THRESHOLD,
  type CraapValidationResult,
  type SlotDefinition,
} from "./craapValidator";
import { cacheGet, cacheSet } from "./researchCache";

// Attempt budget: DEFAULT 1, earn the rest. The first attempt is the cheap,
// unescalated default — resolve the slot, score it, and if CRAAP clears the
// threshold ACCEPT and STOP. The 2 further attempts are NOT spent by default;
// each is EARNED only by a sub-threshold CRAAP verdict (the escalate-on-evidence
// path), which descends a tier and tries a fresh source. So the common case is a
// single search-enabled attempt; tier descent + keep-best engage only when CRAAP
// says the source was not good enough.
const MAX_ATTEMPTS = 3;

// Web_search ceiling per attempt: the cheap first attempt searches less; an
// escalated attempt (earned by a sub-threshold CRAAP) gets the fuller budget so a
// hard slot can still recover. Never below MIN_SEARCHES (enforced in researcher).
const MAX_SEARCHES_FIRST = 3;
const MAX_SEARCHES_ESCALATED = 5;

// The assumption-fallback SEAM (Slice 3 boundary). When a slot dead-ends, the
// loop hands it off HERE instead of returning a figure. This is intentionally a
// labeled, typed entry point with NO fallback logic yet: a later slice replaces
// the "pending" state with a real, flagged assumption value carrying its own
// provenance. The invariant that survives that change: the seam NEVER emits a
// number. It surfaces the dead end loudly (slot label + the researcher's reason)
// so nothing downstream can read it as a resolved figure or a silent null.
export type AssumptionFallbackEntry = {
  kind: "assumption_fallback_pending";
  slotLabel: string;
  resolutionReason: string;
  value: null; // INVARIANT: the seam produces no figure (Slice 3 fills the rest)
};

export function enterAssumptionFallback(
  slot: ResearchSlot,
  resolutionReason: string,
): AssumptionFallbackEntry {
  const entry: AssumptionFallbackEntry = {
    kind: "assumption_fallback_pending",
    slotLabel: `${slot.kind} — ${slot.metric}`,
    resolutionReason,
    value: null,
  };
  // A dead end is a notable event, not a quiet null — say so out loud.
  console.warn(
    `[research-loop] DEAD END — slot "${entry.slotLabel}" routed to the ` +
      `assumption-fallback seam (Slice 3, not yet built). Reason: ${resolutionReason}`,
  );
  return entry;
}

// CRAAP scoring, injectable so tests can drive the loop with zero API calls.
// Defaults to the real validator. Same signature as validateSkeleton.
export type ValidateFn = (
  slot: SlotDefinition,
  skeleton: ResearchSkeleton,
) => Promise<CraapValidationResult>;

// Dependency seams (both default to the real isolated calls; production passes
// nothing). Used only to make the rate-limit-block path deterministically
// testable offline.
export type LoopDeps = { searchFn?: SearchFn; validateFn?: ValidateFn };

// One tier round's SEARCH behavior — distinct from a CRAAP evaluation. A round
// that ends "rate_limited" never reached CRAAP.
export type SearchRound = {
  attempt: number;
  tier: TierTarget;
  searchCalls: number; // researcher calls made, including backoff retries
  blockCodes: string[]; // web_search error / API throttle codes seen
  status: "searched" | "rate_limited";
};

// One CRAAP evaluation (only produced when the search succeeded).
export type LoopAttempt = {
  attempt: number;
  tier: TierTarget;
  skeleton: ResearchSkeleton;
  craap: CraapValidationResult;
  blendedScore: number; // = craap.weightedTotal (computed in CRAAP code)
  purposePass: boolean; // = craap.purpose.gate === "pass"
  passed: boolean; // purposePass AND blendedScore >= threshold
  model: string; // researcher model that produced the skeleton (provenance)
  usage: { inputTokens: number; outputTokens: number }; // researcher + CRAAP
};

export type SlotOutcome =
  | "resolved"
  | "failed_threshold"
  | "rate_limited"
  | "dead_end";

export type SlotLoopResult = {
  ok: true;
  slot: ResearchSlot;
  threshold: number;
  outcome: SlotOutcome;
  resolved: boolean; // a CRAAP attempt passed
  failedThreshold: boolean; // every tier was evaluated and none passed (quality)
  rateLimited: boolean; // a search was unrecoverably blocked (infrastructure)
  deadEnd: boolean; // researcher's typed verdict: no sourceable figure exists
  // Result replayed from the slot-results cache (V6.16.2): a prior ACCEPTED
  // run's skeleton + CRAAP score, no live calls made. Never a live masquerade —
  // consumers can and should surface this.
  fromCache: boolean;
  searchRounds: SearchRound[];
  attempts: LoopAttempt[]; // CRAAP evaluations only
  winnerAttempt: number | null; // null if no source was ever evaluated
  // Set only on a dead_end: the labeled hand-off to the assumption-fallback seam.
  // Carries NO figure (value is null by construction). null on every other outcome.
  assumptionSeam: AssumptionFallbackEntry | null;
  totalUsage: { inputTokens: number; outputTokens: number };
};

function toSlotDefinition(slot: ResearchSlot): SlotDefinition {
  return {
    geography: slot.geography,
    metric: slot.metric,
    definition: slot.definition,
  };
}

// Keep-best: a passing source always beats a failing one (a Purpose-gate failure
// disqualifies regardless of blend), and among same pass-status the higher blend
// wins. Order-independent — not "the first to pass on retry".
function pickBest(attempts: LoopAttempt[]): LoopAttempt {
  return attempts.reduce((best, a) => {
    if (a.passed !== best.passed) return a.passed ? a : best;
    return a.blendedScore > best.blendedScore ? a : best;
  });
}

export async function resolveSlotWithRetry(
  slot: ResearchSlot,
  deps: LoopDeps = {},
): Promise<SlotLoopResult> {
  const searchFn = deps.searchFn;
  const validate = deps.validateFn ?? validateSkeleton;
  const slotDef = toSlotDefinition(slot);
  const searchRounds: SearchRound[] = [];
  const attempts: LoopAttempt[] = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let halted = false; // a search was unrecoverably rate-limited
  let deadEndSeam: AssumptionFallbackEntry | null = null; // researcher dead-ended

  // Cache replay (V6.16.2, opt-in via RESEARCH_CACHE): only ACCEPTED results
  // are ever stored, but re-check the pass condition at read time in CODE so a
  // later-raised threshold turns a stale entry into a miss, never a free pass.
  const cached = cacheGet(slot);
  if (cached) {
    const blendedScore = cached.craap.weightedTotal;
    const purposePass = cached.craap.purpose.gate === "pass";
    if (purposePass && blendedScore >= CRAAP_THRESHOLD) {
      const attempt: LoopAttempt = {
        attempt: 1,
        tier: 1,
        skeleton: cached.skeleton,
        craap: cached.craap,
        blendedScore,
        purposePass,
        passed: true,
        model: cached.researcherModel,
        usage: { inputTokens: 0, outputTokens: 0 }, // replay costs nothing
      };
      return {
        ok: true,
        slot,
        threshold: CRAAP_THRESHOLD,
        outcome: "resolved",
        resolved: true,
        failedThreshold: false,
        rateLimited: false,
        deadEnd: false,
        fromCache: true,
        searchRounds: [],
        attempts: [attempt],
        winnerAttempt: 1,
        assumptionSeam: null,
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tier = attempt as TierTarget;
    // Escalated = any attempt past the default first one. Reaching here on
    // attempt > 1 means a prior CRAAP verdict came back sub-threshold (the only
    // path that continues the loop), so the escalation was earned, not spent by
    // default. The escalated attempt gets the fuller search budget.
    const escalated = attempt > 1;
    const maxSearches = escalated ? MAX_SEARCHES_ESCALATED : MAX_SEARCHES_FIRST;
    const avoidPublishers = attempts
      .map((a) => a.skeleton.author_publisher)
      .filter((p): p is string => typeof p === "string" && p.trim() !== "");

    // Spacing + backoff live here: a rate-limit block is retried at the SAME
    // tier inside this call. It returns only once the search succeeded or the
    // backoff budget was exhausted.
    const search = await searchSlotWithBackoff(
      slot,
      { tier, attempt, avoidPublishers, maxSearches },
      searchFn,
    );
    totalUsage.inputTokens += search.usage.inputTokens;
    totalUsage.outputTokens += search.usage.outputTokens;
    searchRounds.push({
      attempt,
      tier,
      searchCalls: search.searchCalls,
      blockCodes: search.blockCodes,
      status: search.status,
    });

    if (search.status === "rate_limited") {
      // Infrastructure block, not a source-quality verdict: halt the slot. Do
      // NOT descend a tier (the cap is account-level — a different query won't
      // help) and do NOT record a CRAAP attempt.
      halted = true;
      break;
    }

    // Dead-end (Slice 3): the researcher's TYPED verdict that no sourceable
    // figure exists. Checked here — after the search succeeded, BEFORE CRAAP —
    // because a dead end has no source to score: running CRAAP or descending a
    // tier would be wrong. Stop now and route to the assumption-fallback seam.
    // Only resolution_status === "dead_end" triggers this; a `miss` falls
    // through to CRAAP exactly as before (a miss is not a dead end).
    if (search.result.skeleton.resolution_status === "dead_end") {
      deadEndSeam = enterAssumptionFallback(
        slot,
        search.result.skeleton.resolution_reason,
      );
      break;
    }

    // Search succeeded -> isolated CRAAP scoring (a real attempt).
    const craap = await validate(slotDef, search.result.skeleton);
    totalUsage.inputTokens += craap.usage.inputTokens;
    totalUsage.outputTokens += craap.usage.outputTokens;

    const blendedScore = craap.weightedTotal;
    const purposePass = craap.purpose.gate === "pass";
    const passed = purposePass && blendedScore >= CRAAP_THRESHOLD;

    attempts.push({
      attempt,
      tier,
      skeleton: search.result.skeleton,
      craap,
      blendedScore,
      purposePass,
      passed,
      model: search.result.model,
      usage: {
        inputTokens: search.usage.inputTokens + craap.usage.inputTokens,
        outputTokens: search.usage.outputTokens + craap.usage.outputTokens,
      },
    });

    // Retry only on a CRAAP failure (descend a tier, new source). A pass stops.
    if (passed) break;
  }

  // A pass is terminal (the loop breaks on it), so anyPassed and deadEndSeam are
  // mutually exclusive; ordering anyPassed first is defensive, not load-bearing.
  // A dead end takes precedence over any failing attempts left in the log.
  const anyPassed = attempts.some((a) => a.passed);
  const outcome: SlotOutcome = anyPassed
    ? "resolved"
    : deadEndSeam
      ? "dead_end"
      : halted
        ? "rate_limited"
        : "failed_threshold";
  const winner = attempts.length > 0 ? pickBest(attempts) : null;

  // Cache on ACCEPT only (V6.16.2): a resolved slot's winning skeleton is
  // stored WITH its CRAAP score so a future hit skips both live calls. Failed,
  // rate-limited, and dead-end outcomes are never cached.
  if (outcome === "resolved" && winner) {
    cacheSet(slot, {
      skeleton: winner.skeleton,
      craap: winner.craap,
      researcherModel: winner.model,
    });
  }

  return {
    ok: true,
    slot,
    threshold: CRAAP_THRESHOLD,
    outcome,
    resolved: outcome === "resolved",
    failedThreshold: outcome === "failed_threshold",
    rateLimited: outcome === "rate_limited",
    deadEnd: outcome === "dead_end",
    fromCache: false,
    searchRounds,
    attempts,
    // A dead end resolves to no figure: never surface a winner the consumer
    // could read as the slot's value. Only the seam represents a dead end.
    winnerAttempt: outcome === "dead_end" ? null : winner ? winner.attempt : null,
    assumptionSeam: deadEndSeam,
    totalUsage,
  };
}
