// Research loop — the retry + tier-descent spine, CRAAP-driven, ending in the
// RESOLUTION LADDER (V6.18): direct research -> declared geography proxy ->
// reasoned assumption. The ladder is the universal protocol for every slot:
// a slot NEVER terminates empty-handed unless infrastructure (rate limiting)
// blocked the research entirely.
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
// Slice 3 (the RESOLUTION LADDER, V6.18 — supersedes the empty "seam"): when
// direct research ends without an accepted source — EITHER because no source
// cleared CRAAP across the attempts (failed threshold) OR because the
// researcher returned its typed dead_end verdict (no sourceable figure exists;
// per Principle 5 that verdict is a MODEL judgment, never inferred by code) —
// the loop descends the ladder instead of giving up:
//
//   Rung 2 — DECLARED GEOGRAPHY PROXY: one escalated researcher call for the
//   SAME metric in the most comparable OTHER geography, declared openly
//   (proxy_justification is a required output field). The proxy source is
//   CRAAP-graded against ITS OWN geography (the mismatch to the original
//   geography is carried as the declared-proxy flag, not double-punished),
//   and must clear the same threshold + Purpose gate.
//
//   Rung 3 — REASONED ASSUMPTION: an isolated NO-SEARCH call that constructs a
//   transparent, conservative estimate from first principles. It always yields
//   a value; the value is flagged as an explicit assumption and excluded from
//   the credibility score by the orchestrator.
//
// A rate-limit halt (infrastructure) does NOT descend the ladder: fabricating
// an assumption because the API throttled us would launder an infrastructure
// failure into a model judgment. Rate-limited slots stay unresolved.
//
// Isolation (Principle 7): the components never share a conversation. The
// researcher hands CRAAP only a source package (the filled skeleton). AI vs
// code (Principle 5): the models emit judgments only; the blend, threshold,
// gate decision, retry, backoff, ladder routing, and keep-best all live in code.
//
// Caching: only DIRECT resolved slots are cached. A proxy or assumption result
// is never cached — replaying one later would masquerade a fallback as a
// sourced figure (the cache entry carries no rung marker; extending it is a
// later facet if proxy replay ever matters).
import {
  searchSlotWithBackoff,
  reasonAssumption,
  researchSlotProxy,
  type ProxyCallResult,
  type ProxySkeleton,
  type AssumptionCallResult,
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
// threshold ACCEPT and STOP. The further attempt is NOT spent by default; it is
// EARNED only by a sub-threshold CRAAP verdict (the escalate-on-evidence path),
// which descends a tier and tries a fresh source with the fuller search budget.
//
// Reduced 3 -> 2 with the resolution ladder (V6.18): the old third attempt
// targeted tier 3 ("any credible published source"), which structurally cannot
// score well on authority — observed live at CRAAP 0.103. With the ladder, a
// DECLARED comparable-geography proxy from a strong publisher is better
// evidence than a weak tier-3 direct source, so the ladder replaces the
// desperation pass rather than following it.
const MAX_ATTEMPTS = 2;

// Web_search ceiling per attempt: the cheap first attempt searches less; an
// escalated attempt (earned by a sub-threshold CRAAP) gets the fuller budget so a
// hard slot can still recover. Never below MIN_SEARCHES (enforced in researcher).
// MAX_SEARCHES_FIRST is exported so the batch path's precomputed first attempts
// use the same ceiling as the sequential loop's first attempt.
export const MAX_SEARCHES_FIRST = 3;
const MAX_SEARCHES_ESCALATED = 5;

// CRAAP scoring, injectable so tests can drive the loop with zero API calls.
// Defaults to the real validator. Same signature as validateSkeleton.
export type ValidateFn = (
  slot: SlotDefinition,
  skeleton: ResearchSkeleton,
) => Promise<CraapValidationResult>;

// Ladder rungs, injectable for the same reason. Defaults are the real calls.
export type ProxySearchFn = (
  slot: ResearchSlot,
  opts?: Parameters<SearchFn>[1],
) => Promise<ProxyCallResult>;
export type AssumptionFn = (slot: ResearchSlot) => Promise<AssumptionCallResult>;

// Dependency seams (all default to the real isolated calls; production passes
// nothing). Used to make every routing path deterministically testable offline.
export type LoopDeps = {
  searchFn?: SearchFn;
  validateFn?: ValidateFn;
  proxySearchFn?: ProxySearchFn;
  assumptionFn?: AssumptionFn;
};

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

// How the DIRECT research stage ended — the ladder's routing evidence. Kept as
// its own field so consumers can always see WHY a proxy/assumption was used.
export type DirectStageOutcome =
  | "resolved" // a direct source passed CRAAP
  | "failed_threshold" // sources found, none cleared the gate
  | "dead_end" // researcher's typed verdict: no sourceable figure exists
  | "rate_limited"; // infrastructure halt — the search never completed

// Terminal outcome of the whole ladder. Every slot resolves to a value unless
// infrastructure blocked it.
export type SlotOutcome =
  | "resolved" // rung 1: direct sourced figure
  | "resolved_proxy" // rung 2: declared geography proxy
  | "resolved_assumption" // rung 3: reasoned assumption
  | "rate_limited";

// Rung 2 record: the declared proxy attempt, pass or fail. craap is null only
// when the proxy researcher itself dead-ended (there was no source to grade).
export type ProxyResolution = {
  skeleton: ProxySkeleton;
  craap: CraapValidationResult | null;
  blendedScore: number | null;
  purposePass: boolean | null;
  passed: boolean;
  model: string;
  searchRound: SearchRound;
  directFailure: string; // why the ladder descended past direct research
};

// Rung 3 record: the reasoned assumption ("its own thinking").
export type AssumptionResolution = {
  value: number;
  units: string;
  reasoning: string;
  model: string;
  ladderTrace: string; // what was tried and how it failed, per rung
};

export type SlotLoopResult = {
  ok: true;
  slot: ResearchSlot;
  threshold: number;
  outcome: SlotOutcome;
  directOutcome: DirectStageOutcome;
  resolved: boolean; // outcome === "resolved" (a DIRECT source passed)
  rateLimited: boolean; // infrastructure halt (direct or proxy stage)
  // Result replayed from the slot-results cache (V6.16.2): a prior ACCEPTED
  // run's skeleton + CRAAP score, no live calls made. Never a live masquerade —
  // consumers can and should surface this.
  fromCache: boolean;
  searchRounds: SearchRound[]; // direct stage only; the proxy round lives in `proxy`
  attempts: LoopAttempt[]; // direct-stage CRAAP evaluations only
  winnerAttempt: number | null; // direct winner; null unless outcome === "resolved"
  proxy: ProxyResolution | null; // rung 2 record (present whenever rung 2 ran)
  assumption: AssumptionResolution | null; // rung 3 record (terminal fallback)
  totalUsage: { inputTokens: number; outputTokens: number };
};

function toSlotDefinition(slot: ResearchSlot): SlotDefinition {
  return {
    geography: slot.geography,
    metric: slot.metric,
    definition: slot.definition,
  };
}

// The proxy source is graded against ITS OWN geography: the mismatch to the
// original geography is the openly-declared proxy flag, carried by the loop —
// grading the Sweden source as if it claimed to be Germany would double-punish
// the honesty. Metric and denominator requirements are unchanged.
function toProxySlotDefinition(
  slot: ResearchSlot,
  proxyGeography: string,
): SlotDefinition {
  return {
    geography: proxyGeography,
    metric: slot.metric,
    definition:
      slot.definition +
      ` NOTE (DECLARED GEOGRAPHY PROXY): the direct ${slot.geography} figure was unavailable, so this source is offered for ${proxyGeography} as a comparable-market proxy. Grade geography_match against ${proxyGeography} (the declared proxy geography), not ${slot.geography}. The metric and denominator requirements are unchanged.`,
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
  const proxySearchFn = deps.proxySearchFn ?? researchSlotProxy;
  const assumeFn = deps.assumptionFn ?? reasonAssumption;
  const slotDef = toSlotDefinition(slot);
  const slotLabel = `${slot.kind} — ${slot.metric}`;
  const searchRounds: SearchRound[] = [];
  const attempts: LoopAttempt[] = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let halted = false; // a search was unrecoverably rate-limited
  let deadEndReason: string | null = null; // researcher's typed dead_end verdict

  // Cache replay (V6.16.2, opt-in via RESEARCH_CACHE): only ACCEPTED results
  // are ever stored, but re-check the pass condition at read time in CODE so a
  // later-raised threshold turns a stale entry into a miss, never a free pass.
  const cached = cacheGet(slot);
  if (cached) {
    const blendedScore = cached.craap.weightedTotal;
    const purposePass = cached.craap.purpose.gate === "pass";
    if (purposePass && blendedScore >= CRAAP_THRESHOLD) {
      console.log(
        `[research-loop] "${slotLabel}" replayed from cache (CRAAP ${blendedScore.toFixed(3)}, zero cost)`,
      );
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
        directOutcome: "resolved",
        resolved: true,
        rateLimited: false,
        fromCache: true,
        searchRounds: [],
        attempts: [attempt],
        winnerAttempt: 1,
        proxy: null,
        assumption: null,
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  // --- Rung 1: DIRECT research (attempt budget 1 + earned escalations) -------
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

    console.log(
      `[research-loop] "${slotLabel}" attempt ${attempt}/${MAX_ATTEMPTS} (tier ${tier}, up to ${maxSearches} searches${escalated ? ", escalated live" : ""})...`,
    );

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

    // Dead end: the researcher's TYPED verdict that no sourceable figure
    // exists. Checked here — after the search succeeded, BEFORE CRAAP —
    // because a dead end has no source to score. It stops DIRECT research
    // (a different tier won't conjure an unpublished figure) and routes to
    // the ladder's proxy rung. Only resolution_status === "dead_end" triggers
    // this; a `miss` falls through to CRAAP exactly as before.
    if (search.result.skeleton.resolution_status === "dead_end") {
      deadEndReason = search.result.skeleton.resolution_reason;
      console.warn(
        `[research-loop] "${slotLabel}" DEAD END on direct research (${deadEndReason}) — descending the ladder`,
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

    console.log(
      `[research-loop] "${slotLabel}" attempt ${attempt}: CRAAP ${blendedScore.toFixed(3)} — ${passed ? "PASS" : purposePass ? `below threshold ${CRAAP_THRESHOLD}` : "PURPOSE gate FAIL"}`,
    );

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

  const anyPassed = attempts.some((a) => a.passed);
  const directOutcome: DirectStageOutcome = anyPassed
    ? "resolved"
    : deadEndReason !== null
      ? "dead_end"
      : halted
        ? "rate_limited"
        : "failed_threshold";
  const winner = attempts.length > 0 ? pickBest(attempts) : null;

  // Cache on ACCEPT only (V6.16.2): a DIRECT resolved slot's winning skeleton
  // is stored WITH its CRAAP score so a future hit skips both live calls.
  // Failed, rate-limited, proxy, and assumption outcomes are never cached.
  if (directOutcome === "resolved" && winner) {
    cacheSet(slot, {
      skeleton: winner.skeleton,
      craap: winner.craap,
      researcherModel: winner.model,
    });
  }

  const base = {
    ok: true as const,
    slot,
    threshold: CRAAP_THRESHOLD,
    directOutcome,
    fromCache: false,
    searchRounds,
    attempts,
    totalUsage,
  };

  if (directOutcome === "resolved") {
    return {
      ...base,
      outcome: "resolved",
      resolved: true,
      rateLimited: false,
      winnerAttempt: winner ? winner.attempt : null,
      proxy: null,
      assumption: null,
    };
  }

  if (directOutcome === "rate_limited") {
    // Infrastructure halt: do NOT descend the ladder — an assumption produced
    // because the API throttled us would launder an infrastructure failure
    // into a model judgment. The slot stays unresolved; retry later.
    return {
      ...base,
      outcome: "rate_limited",
      resolved: false,
      rateLimited: true,
      winnerAttempt: null,
      proxy: null,
      assumption: null,
    };
  }

  // --- Rung 2: DECLARED GEOGRAPHY PROXY --------------------------------------
  const directFailure =
    directOutcome === "dead_end"
      ? `direct research dead-ended: ${deadEndReason}`
      : `no direct source cleared CRAAP ${CRAAP_THRESHOLD} across ${attempts.length} attempt(s)`;
  console.log(
    `[research-loop] "${slotLabel}" descending to DECLARED GEOGRAPHY PROXY (${directFailure})...`,
  );

  const avoidPublishers = attempts
    .map((a) => a.skeleton.author_publisher)
    .filter((p): p is string => typeof p === "string" && p.trim() !== "");
  const proxySearch = await searchSlotWithBackoff(
    slot,
    { avoidPublishers, maxSearches: MAX_SEARCHES_ESCALATED },
    proxySearchFn,
  );
  totalUsage.inputTokens += proxySearch.usage.inputTokens;
  totalUsage.outputTokens += proxySearch.usage.outputTokens;
  const proxyRound: SearchRound = {
    attempt: MAX_ATTEMPTS + 1,
    tier: 3,
    searchCalls: proxySearch.searchCalls,
    blockCodes: proxySearch.blockCodes,
    status: proxySearch.status,
  };

  if (proxySearch.status === "rate_limited") {
    // Same infrastructure rule as the direct stage: halt, don't fabricate.
    return {
      ...base,
      outcome: "rate_limited",
      resolved: false,
      rateLimited: true,
      winnerAttempt: null,
      proxy: null,
      assumption: null,
    };
  }

  // The guard on the proxy call enforces ProxySkeleton; the runtime check is
  // belt-and-braces for injected test fakes.
  const proxySkeleton = proxySearch.result.skeleton as ProxySkeleton;
  let proxy: ProxyResolution;

  if (proxySkeleton.resolution_status === "dead_end") {
    console.warn(
      `[research-loop] "${slotLabel}" proxy rung DEAD END (${proxySkeleton.resolution_reason}) — descending to assumption`,
    );
    proxy = {
      skeleton: proxySkeleton,
      craap: null,
      blendedScore: null,
      purposePass: null,
      passed: false,
      model: proxySearch.result.model,
      searchRound: proxyRound,
      directFailure,
    };
  } else {
    const proxyGeo =
      proxySkeleton.geography && proxySkeleton.geography.trim() !== ""
        ? proxySkeleton.geography
        : "the declared proxy geography";
    const craap = await validate(
      toProxySlotDefinition(slot, proxyGeo),
      proxySkeleton,
    );
    totalUsage.inputTokens += craap.usage.inputTokens;
    totalUsage.outputTokens += craap.usage.outputTokens;
    const blendedScore = craap.weightedTotal;
    const purposePass = craap.purpose.gate === "pass";
    const passed = purposePass && blendedScore >= CRAAP_THRESHOLD;
    console.log(
      `[research-loop] "${slotLabel}" proxy (${proxyGeo}): CRAAP ${blendedScore.toFixed(3)} — ${passed ? "PASS (declared proxy)" : purposePass ? `below threshold ${CRAAP_THRESHOLD}` : "PURPOSE gate FAIL"}`,
    );
    proxy = {
      skeleton: proxySkeleton,
      craap,
      blendedScore,
      purposePass,
      passed,
      model: proxySearch.result.model,
      searchRound: proxyRound,
      directFailure,
    };
  }

  if (proxy.passed) {
    return {
      ...base,
      outcome: "resolved_proxy",
      resolved: false,
      rateLimited: false,
      winnerAttempt: null,
      proxy,
      assumption: null,
    };
  }

  // --- Rung 3: REASONED ASSUMPTION (always yields) ----------------------------
  const proxyFailure =
    proxy.craap === null
      ? `proxy rung dead-ended: ${proxySkeleton.resolution_reason}`
      : `proxy source (${proxySkeleton.geography ?? "unknown geography"}) scored CRAAP ${proxy.blendedScore?.toFixed(3)}${proxy.purposePass === false ? " with a Purpose-gate fail" : ""} — below the bar`;
  const ladderTrace = `${directFailure}; ${proxyFailure}`;
  console.log(
    `[research-loop] "${slotLabel}" descending to REASONED ASSUMPTION (${proxyFailure})...`,
  );

  const assumed = await assumeFn(slot);
  totalUsage.inputTokens += assumed.usage.inputTokens;
  totalUsage.outputTokens += assumed.usage.outputTokens;
  console.log(
    `[research-loop] "${slotLabel}" ASSUMED: ${assumed.assumption.value} ${assumed.assumption.units} (explicit assumption, excluded from credibility)`,
  );

  return {
    ...base,
    outcome: "resolved_assumption",
    resolved: false,
    rateLimited: false,
    winnerAttempt: null,
    proxy,
    assumption: {
      value: assumed.assumption.value,
      units: assumed.assumption.units,
      reasoning: assumed.assumption.reasoning,
      model: assumed.model,
      ladderTrace,
    },
  };
}
