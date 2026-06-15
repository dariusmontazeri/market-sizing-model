// Deterministic, OFFLINE proof of the rate-limit-block handling that the live
// run could not trigger (the cap never tripped). Zero API calls, zero cost: the
// search and CRAAP calls are injected fakes, so the loop's REAL spacing/backoff
// and block-vs-CRAAP logic run against simulated rate-limit blocks.
//
// Note: this exercises the REAL backoff sleeps (2s spacing + 2/4/8s backoff), so
// it takes ~20s of wall time — that delay is itself evidence the backoff is real.
//
// Run: npx tsx scripts/test-research-loop-block.ts   (no env / no API key needed)
import {
  resolveSlotWithRetry,
  type ValidateFn,
} from "../lib/researchLoop";
import type { ResearchSkeleton, ResearchSlot, SearchFn } from "../lib/researcher";
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

const nullSkeleton = (): ResearchSkeleton => ({
  search_query: "(blocked)",
  value: null,
  units: null,
  date: null,
  author_publisher: null,
  source_url: null,
  geography: null,
  population_segment: null,
  metric_definition: "search blocked by rate limit",
  resolution_status: "miss",
  resolution_reason: "no source obtained this attempt",
});

const goodSkeleton = (): ResearchSkeleton => ({
  search_query: "avg price germany",
  value: 1234,
  units: "EUR",
  date: "2025",
  author_publisher: "Fake Statistics Office",
  source_url: "https://example.org/stat",
  geography: "Germany",
  population_segment: "all",
  metric_definition: "fake",
  resolution_status: "found",
  resolution_reason: "sourced figure located",
});

// A blocked search: rate-limit code present AND no source obtained.
const blocked = {
  skeleton: nullSkeleton(),
  model: "fake",
  usage: { inputTokens: 0, outputTokens: 0 },
  searchErrorCodes: ["too_many_requests"],
  rateLimitBlocked: true,
};
const recovered = {
  skeleton: goodSkeleton(),
  model: "fake",
  usage: { inputTokens: 1, outputTokens: 1 },
  searchErrorCodes: [],
  rateLimitBlocked: false,
};

// Fake CRAAP — a pass result; the loop never reaches it in the block-exhaust case.
function fakeCraapPass(): CraapValidationResult {
  const dim = (score: number) => ({ score, reasoning: "fake" });
  return {
    ok: true,
    dimensions: {
      authority: dim(0.9),
      currency: dim(0.9),
      accuracy: dim(0.9),
      relevance: {
        geography_match: dim(1),
        population_match: dim(1),
        metric_match: dim(1),
      },
      purpose: { gate: "pass", reasoning: "fake" },
    },
    relevanceScore: 1,
    weights: CRAAP_WEIGHTS,
    weightedTotal: 0.9,
    purpose: { gate: "pass", reasoning: "fake" },
    model: "fake",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function countingValidate(): { fn: ValidateFn; calls: () => number } {
  let n = 0;
  const fn: ValidateFn = async () => {
    n++;
    return fakeCraapPass();
  };
  return { fn, calls: () => n };
}

async function case1() {
  console.log(
    "\n=== Behavior 1: block -> backoff -> SAME-tier retry -> recover -> handed to CRAAP ===",
  );
  console.log("Prediction: tier 1 only (no descend); 2 search calls; status searched;");
  console.log("            CRAAP called exactly once; 1 attempt at tier 1; outcome resolved.\n");

  let searchCalls = 0;
  const searchFn: SearchFn = async () => {
    searchCalls++;
    return searchCalls === 1 ? blocked : recovered; // block once, then recover
  };
  const craap = countingValidate();

  const r = await resolveSlotWithRetry(SLOT, { searchFn, validateFn: craap.fn });
  console.log("  searchRounds:", JSON.stringify(r.searchRounds));
  console.log("  outcome:", r.outcome, "| attempts:", r.attempts.length, "| craapCalls:", craap.calls());

  check("only 1 search round (no tier descent)", r.searchRounds.length === 1, r.searchRounds.length);
  check("tier 1 made 2 search calls (1 block + 1 retry)", r.searchRounds[0]?.searchCalls === 2, r.searchRounds[0]?.searchCalls);
  check('round status is "searched" after recovery', r.searchRounds[0]?.status === "searched", r.searchRounds[0]?.status);
  check("block code recorded (too_many_requests)", r.searchRounds[0]?.blockCodes.includes("too_many_requests"), r.searchRounds[0]?.blockCodes);
  check("handed to CRAAP exactly once", craap.calls() === 1, craap.calls());
  check("exactly 1 CRAAP attempt, at tier 1", r.attempts.length === 1 && r.attempts[0]?.tier === 1, { n: r.attempts.length, tier: r.attempts[0]?.tier });
  check("block was NOT counted as a CRAAP failure (the one attempt passed)", r.attempts[0]?.passed === true, r.attempts[0]?.passed);
  check("outcome resolved", r.outcome === "resolved", r.outcome);
}

async function case2() {
  console.log(
    "\n=== Behavior 2: backoff EXHAUSTED -> rate_limited halt (no descend, no CRAAP, no value) ===",
  );
  console.log("Prediction: 1 search round, status rate_limited, 4 search calls (1 + 3 backoff);");
  console.log("            CRAAP never called; 0 attempts; outcome rate_limited; winnerAttempt null.\n");

  const searchFn: SearchFn = async () => blocked; // always blocked
  const craap = countingValidate();

  const r = await resolveSlotWithRetry(SLOT, { searchFn, validateFn: craap.fn });
  console.log("  searchRounds:", JSON.stringify(r.searchRounds));
  console.log("  outcome:", r.outcome, "| attempts:", r.attempts.length, "| craapCalls:", craap.calls(), "| winnerAttempt:", r.winnerAttempt);

  check("only 1 search round (no tier descent on a block)", r.searchRounds.length === 1, r.searchRounds.length);
  check('round status is "rate_limited"', r.searchRounds[0]?.status === "rate_limited", r.searchRounds[0]?.status);
  check("4 search calls (1 initial + 3 backoff retries)", r.searchRounds[0]?.searchCalls === 4, r.searchRounds[0]?.searchCalls);
  check("CRAAP never called", craap.calls() === 0, craap.calls());
  check("0 CRAAP attempts", r.attempts.length === 0, r.attempts.length);
  check("outcome rate_limited (not failed_threshold)", r.outcome === "rate_limited", r.outcome);
  check("no invented value (winnerAttempt null)", r.winnerAttempt === null, r.winnerAttempt);
  check("not resolved", r.resolved === false, r.resolved);
}

async function case3() {
  console.log(
    "\n=== Behavior 3: clean search -> straight to CRAAP (seam did not alter happy path) ===",
  );
  console.log("Prediction: 1 search call, no block codes, status searched; CRAAP once; 1 attempt; resolved.\n");

  const searchFn: SearchFn = async () => recovered; // clean, no block
  const craap = countingValidate();

  const r = await resolveSlotWithRetry(SLOT, { searchFn, validateFn: craap.fn });
  console.log("  searchRounds:", JSON.stringify(r.searchRounds));
  console.log("  outcome:", r.outcome, "| attempts:", r.attempts.length, "| craapCalls:", craap.calls());

  check("1 search call", r.searchRounds[0]?.searchCalls === 1, r.searchRounds[0]?.searchCalls);
  check("no block codes", r.searchRounds[0]?.blockCodes.length === 0, r.searchRounds[0]?.blockCodes);
  check('status "searched"', r.searchRounds[0]?.status === "searched", r.searchRounds[0]?.status);
  check("handed to CRAAP once", craap.calls() === 1, craap.calls());
  check("1 attempt, resolved", r.attempts.length === 1 && r.outcome === "resolved", { n: r.attempts.length, outcome: r.outcome });
}

async function main() {
  console.log("Deterministic offline proof of rate-limit-block handling (ZERO API calls)");
  await case1();
  await case2();
  await case3();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
