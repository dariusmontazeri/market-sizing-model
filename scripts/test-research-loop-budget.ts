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

// === Case C: all attempts fail -> keep-best returns the highest-blend source ===
async function caseKeepBestAmongFails() {
  console.log("\n=== Case C: every attempt fails CRAAP -> keep-best = highest blend ===");
  console.log("Prediction: 3 rounds, maxSearches [3,5,5], outcome failed_threshold, winner = attempt 2 (blend 0.6).\n");

  const search = recordingSearch();
  const blends = [0.4, 0.6, 0.5]; // all < 0.7; the middle attempt is best
  let c = 0;
  const validate: ValidateFn = async () => craap(blends[c++]);
  const r = await resolveSlotWithRetry(SLOT, { searchFn: search.fn, validateFn: validate });

  console.log("  maxSearches per attempt:", JSON.stringify(search.maxSearches()));
  console.log("  blends:", JSON.stringify(r.attempts.map((a) => a.blendedScore)), "| outcome:", r.outcome, "| winner:", r.winnerAttempt);

  check("3 search rounds (full descent on repeated CRAAP fail)", r.searchRounds.length === 3, r.searchRounds.length);
  check("ceiling: [3,5,5]", JSON.stringify(search.maxSearches()) === "[3,5,5]", search.maxSearches());
  check("outcome failed_threshold", r.outcome === "failed_threshold", r.outcome);
  check("keep-best = highest-blend attempt (2, blend 0.6)", r.winnerAttempt === 2, r.winnerAttempt);
  check("not resolved, no dead end", r.resolved === false && r.deadEnd === false, { resolved: r.resolved, deadEnd: r.deadEnd });
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
