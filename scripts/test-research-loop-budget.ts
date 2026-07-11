// Deterministic, OFFLINE proof of the attempt-budget + search-ceiling efficiency
// slice. Zero API calls: search and CRAAP are injected fakes, so the loop's REAL
// accept/escalate logic and per-attempt maxSearches policy run against mocks. The
// injected searchFn CAPTURES the maxSearches the loop requests on each attempt.
//
// Proves:
//   - DEFAULT 1 attempt: a first-attempt CRAAP pass ACCEPTS and STOPS (1 search,
//     1 CRAAP, no escalation) and that first attempt asks for 3 searches.
//   - earn the rest: a sub-threshold CRAAP escalates to a second attempt at the
//     next tier, and the ESCALATED attempt asks for 5 searches.
//   - keep-best stays correct once escalation fires (picks the passing source,
//     and the highest blend among failing sources).
//
// Exercises the REAL 2s pre-search spacing per attempt, so this takes ~12s.
// Run: npx tsx scripts/test-research-loop-budget.ts   (no env / no API key needed)
import { resolveSlotWithRetry, type ValidateFn } from "../lib/researchLoop";
import type {
  ResearchSkeleton,
  ResearchSlot,
  ResearcherCallResult,
  SearchFn,
} from "../lib/researcher";
import { CRAAP_WEIGHTS, type CraapValidationResult } from "../lib/craapValidator";

let failures = 0;
function check(label: string, cond: boolean, actual?: unknown) {
  const tag = cond ? "PASS" : "FAIL";
  const suffix = actual === undefined ? "" : `  (actual: ${JSON.stringify(actual)})`;
  console.log(`  [${tag}] ${label}${suffix}`);
  if (!cond) failures++;
}

const SLOT: ResearchSlot = {
  kind: "price",
  filterIndex: null,
  geography: "Germany",
  metric: "average price per device",
  definition: "average unit price for the addressable unit",
};

// A found source carrying a figure + publisher (distinct publisher per attempt so
// the avoid-list and keep-best have something to chew on).
function sourceResult(publisher: string): ResearcherCallResult {
  const skeleton: ResearchSkeleton = {
    search_query: "avg price germany",
    value: 1000,
    units: "EUR",
    date: "2025",
    author_publisher: publisher,
    source_url: `https://example.org/${encodeURIComponent(publisher)}`,
    geography: "Germany",
    population_segment: "all",
    metric_definition: "fake",
    resolution_status: "found",
    resolution_reason: "sourced figure located",
  };
  return {
    skeleton,
    model: "fake",
    usage: { inputTokens: 1, outputTokens: 1 },
    searchErrorCodes: [],
    rateLimitBlocked: false,
  };
}

function craap(total: number): CraapValidationResult {
  const dim = (s: number) => ({ score: s, reasoning: "fake" });
  return {
    ok: true,
    dimensions: {
      authority: dim(total),
      currency: dim(total),
      accuracy: dim(total),
      relevance: {
        geography_match: dim(total),
        population_match: dim(total),
        metric_match: dim(total),
      },
      purpose: { gate: "pass", reasoning: "fake" },
    },
    relevanceScore: total,
    weights: CRAAP_WEIGHTS,
    weightedTotal: total,
    purpose: { gate: "pass", reasoning: "fake" },
    model: "fake",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

// A searchFn that returns a fresh-publisher source each call and records the
// maxSearches the loop requested per attempt.
function recordingSearch(): { fn: SearchFn; maxSearches: () => (number | undefined)[] } {
  const seen: (number | undefined)[] = [];
  let n = 0;
  const fn: SearchFn = async (_slot, opts) => {
    n++;
    seen.push(opts?.maxSearches);
    return sourceResult(`Publisher-${n}`);
  };
  return { fn, maxSearches: () => seen };
}

// === Case A: first-attempt pass -> ACCEPT & STOP, first attempt asks for 3 =====
async function caseDefaultOne() {
  console.log("\n=== Case A: CRAAP passes on attempt 1 -> accept & stop (default 1 attempt) ===");
  console.log("Prediction: 1 search round, maxSearches [3], CRAAP once, outcome resolved, winner 1.\n");

  const search = recordingSearch();
  const validate: ValidateFn = async () => craap(0.9); // clears 0.7
  const r = await resolveSlotWithRetry(SLOT, { searchFn: search.fn, validateFn: validate });

  console.log("  maxSearches per attempt:", JSON.stringify(search.maxSearches()));
  console.log("  outcome:", r.outcome, "| attempts:", r.attempts.length, "| winner:", r.winnerAttempt);

  check("exactly 1 search round (no escalation on a pass)", r.searchRounds.length === 1, r.searchRounds.length);
  check("first attempt asked for 3 searches", JSON.stringify(search.maxSearches()) === "[3]", search.maxSearches());
  check("1 CRAAP attempt", r.attempts.length === 1, r.attempts.length);
  check("outcome resolved", r.outcome === "resolved", r.outcome);
  check("winner is attempt 1", r.winnerAttempt === 1, r.winnerAttempt);
}

// === Case B: sub-0.7 -> escalate to attempt 2 (asks 5), keep-best picks pass ===
async function caseEarnEscalation() {
  console.log("\n=== Case B: attempt 1 fails CRAAP -> escalate to attempt 2 (earned) ===");
  console.log("Prediction: 2 rounds tiers [1,2], maxSearches [3,5], outcome resolved, winner 2.\n");

  const search = recordingSearch();
  let c = 0;
  const validate: ValidateFn = async () => {
    c++;
    return c === 1 ? craap(0.5) : craap(0.9); // fail first, pass on escalation
  };
  const r = await resolveSlotWithRetry(SLOT, { searchFn: search.fn, validateFn: validate });

  console.log("  maxSearches per attempt:", JSON.stringify(search.maxSearches()));
  console.log("  tiers:", JSON.stringify(r.searchRounds.map((s) => s.tier)), "| outcome:", r.outcome, "| winner:", r.winnerAttempt);

  check("2 search rounds", r.searchRounds.length === 2, r.searchRounds.length);
  check("tiers descended 1 -> 2", JSON.stringify(r.searchRounds.map((s) => s.tier)) === "[1,2]", r.searchRounds.map((s) => s.tier));
  check("ceiling: first 3, escalated 5", JSON.stringify(search.maxSearches()) === "[3,5]", search.maxSearches());
  check("outcome resolved", r.outcome === "resolved", r.outcome);
  check("keep-best picked the passing escalated attempt (2)", r.winnerAttempt === 2, r.winnerAttempt);
}

// === Case C: all attempts fail -> ladder engages (V6.18) =====================
async function caseKeepBestAmongFails() {
  console.log("\n=== Case C: every attempt fails CRAAP -> full descent -> resolution ladder ===");
  console.log("Prediction: 2 rounds (budget 1 + 1 earned), maxSearches [3,5], directOutcome failed_threshold;\n" +
    "            the ladder then runs (fake proxy dead-ends, fake assumption yields) -> resolved_assumption.\n");

  const search = recordingSearch();
  const blends = [0.4, 0.6]; // all < 0.7
  let c = 0;
  const validate: ValidateFn = async () => craap(blends[c++]);
  // Ladder fakes so the budget test stays offline: proxy dead-ends, assumption yields.
  const proxySearchFn = async () => ({
    skeleton: {
      ...sourceResult("Proxy-Publisher").skeleton,
      resolution_status: "dead_end" as const,
      resolution_reason: "no comparable geography publishes this (fake)",
      proxy_justification: "n/a",
    },
    model: "fake",
    usage: { inputTokens: 0, outputTokens: 0 },
    searchErrorCodes: [],
    rateLimitBlocked: false,
  });
  const assumptionFn = async () => ({
    assumption: { value: 1, units: "EUR", reasoning: "fake" },
    model: "fake",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const r = await resolveSlotWithRetry(SLOT, { searchFn: search.fn, validateFn: validate, proxySearchFn, assumptionFn });

  console.log("  maxSearches per attempt:", JSON.stringify(search.maxSearches()));
  console.log("  blends:", JSON.stringify(r.attempts.map((a) => a.blendedScore)), "| outcome:", r.outcome, "| directOutcome:", r.directOutcome);

  check("2 direct search rounds (budget 1 + 1 earned; V6.18 dropped the tier-3 pass)", r.searchRounds.length === 2, r.searchRounds.length);
  check("ceiling: [3,5] (proxy round not in searchRounds)", JSON.stringify(search.maxSearches()) === "[3,5]", search.maxSearches());
  check("directOutcome failed_threshold", r.directOutcome === "failed_threshold", r.directOutcome);
  check("ladder terminal: outcome resolved_assumption", r.outcome === "resolved_assumption", r.outcome);
  check("both failing attempts kept in the log (best blend 0.6 visible)", r.attempts.length === 2 && Math.max(...r.attempts.map((a) => a.blendedScore)) === 0.6, r.attempts.map((a) => a.blendedScore));
  check("no direct winner surfaced (winner only on resolved)", r.winnerAttempt === null && r.resolved === false, { winner: r.winnerAttempt, resolved: r.resolved });
}

async function main() {
  console.log("Deterministic offline proof: attempt budget (default 1, earn the rest) + 3/5 search ceiling (ZERO API calls)");
  await caseDefaultOne();
  await caseEarnEscalation();
  await caseKeepBestAmongFails();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
