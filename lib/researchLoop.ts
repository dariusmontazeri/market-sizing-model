// Research loop — the retry + tier-descent spine, CRAAP-driven.
//
// Slice 1: for ONE slot, the researcher finds a source (isolated call), CRAAP
// scores it cold (a SEPARATE isolated call), and CODE decides accept-or-retry.
// The retry budget IS the tier descent — attempt N targets tier N — up to 3
// attempts. Keep the best source across all attempts, not the first to pass.
//
// Slice 2: separate a web_search RATE-LIMIT BLOCK from a CRAAP FAILURE. The
// search is wrapped in spacing + backoff (searchSlotWithBackoff). A block means
// the search never ran and no source was evaluated, so it must NOT descend a
// tier or count as a CRAAP attempt — the backoff retries the SAME search; if it
// stays blocked past the budget, the slot halts with a rate_limited outcome
// (an infrastructure result, distinct from a source-quality failure).
//
// Isolation (Principle 7): the two components never share a conversation. The
// researcher hands CRAAP only a source package (the filled skeleton). AI vs code
// (Principle 5): the models emit judgments only; the blend, threshold, gate
// decision, retry, backoff, and keep-best all live in code.
//
// NOT in this slice (later): assumption fallback, early-stop-on-dead-end, and
// the proposer empty-turn fix.
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

const MAX_ATTEMPTS = 3;

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
  usage: { inputTokens: number; outputTokens: number }; // researcher + CRAAP
};

export type SlotOutcome = "resolved" | "failed_threshold" | "rate_limited";

export type SlotLoopResult = {
  ok: true;
  slot: ResearchSlot;
  threshold: number;
  outcome: SlotOutcome;
  resolved: boolean; // a CRAAP attempt passed
  failedThreshold: boolean; // every tier was evaluated and none passed (quality)
  rateLimited: boolean; // a search was unrecoverably blocked (infrastructure)
  searchRounds: SearchRound[];
  attempts: LoopAttempt[]; // CRAAP evaluations only
  winnerAttempt: number | null; // null if no source was ever evaluated
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tier = attempt as TierTarget;
    const avoidPublishers = attempts
      .map((a) => a.skeleton.author_publisher)
      .filter((p): p is string => typeof p === "string" && p.trim() !== "");

    // Spacing + backoff live here: a rate-limit block is retried at the SAME
    // tier inside this call. It returns only once the search succeeded or the
    // backoff budget was exhausted.
    const search = await searchSlotWithBackoff(
      slot,
      { tier, attempt, avoidPublishers },
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
      usage: {
        inputTokens: search.usage.inputTokens + craap.usage.inputTokens,
        outputTokens: search.usage.outputTokens + craap.usage.outputTokens,
      },
    });

    // Retry only on a CRAAP failure (descend a tier, new source). A pass stops.
    if (passed) break;
  }

  const anyPassed = attempts.some((a) => a.passed);
  const outcome: SlotOutcome = anyPassed
    ? "resolved"
    : halted
      ? "rate_limited"
      : "failed_threshold";
  const winner = attempts.length > 0 ? pickBest(attempts) : null;

  return {
    ok: true,
    slot,
    threshold: CRAAP_THRESHOLD,
    outcome,
    resolved: outcome === "resolved",
    failedThreshold: outcome === "failed_threshold",
    rateLimited: outcome === "rate_limited",
    searchRounds,
    attempts,
    winnerAttempt: winner ? winner.attempt : null,
    totalUsage,
  };
}
