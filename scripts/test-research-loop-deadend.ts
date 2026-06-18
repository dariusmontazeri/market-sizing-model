// Deterministic, OFFLINE proof of the THREE failure classes routing correctly in
// the research loop, with the early-stop-on-dead-end class (Slice 3) as the focus.
// Zero API calls, zero cost: the search and CRAAP calls are injected fakes, so the
// loop's REAL routing logic runs against simulated researcher outputs.
//
// The three classes, each its own handler, no collision:
//   blocked   -> backoff + retry the SAME tier (no descent, no CRAAP attempt)
//   CRAAP-fail-> descend a tier (a fresh source at lower authority)
//   dead_end  -> STOP and route to the assumption-fallback seam (no CRAAP, no number)
//
// The block case exercises the REAL spacing + backoff sleeps (~4s here: 1 block +
// 1 recovery), so this script takes a few seconds of wall time. The CRAAP-fail and
// dead_end cases never block, so they incur only the 2s pre-search spacing each.
//
// Run: npx tsx scripts/test-research-loop-deadend.ts   (no env / no API key needed)
import { resolveSlotWithRetry, type ValidateFn } from "../lib/researchLoop";
import type {
  ResearchSkeleton,
  ResearchSlot,
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

// --- mock skeletons -------------------------------------------------------

// A blocked search: rate-limit code present AND no source obtained.
const blockedSkeleton = (): ResearchSkeleton => ({
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

// A found, CRAAP-worthy source.
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

// A `miss` source carrying a figure CRAAP will reject. resolution_status is
// "miss", NOT dead_end — it must flow to CRAAP and tier descent, never the seam.
const weakSkeleton = (): ResearchSkeleton => ({
  search_query: "avg price germany blog",
  value: 999,
  units: "EUR",
  date: "2018",
  author_publisher: "Some Promotional Blog",
  source_url: "https://example.org/ad",
  geography: "Germany",
  population_segment: "unclear",
  metric_definition: "fake-weak",
  resolution_status: "miss",
  resolution_reason: "found a figure but unsure it is authoritative",
});

const DEAD_END_REASON =
  "Germany does not publish a per-device prosthetic price; confirmed absent from Destatis and the GKV Hilfsmittel catalog pricing.";

// A dead_end verdict that ADVERSARIALLY carries a numeric value, to prove the
// loop routes on the TYPED resolution_status field alone and discards any figure
// — it never reads value/null to decide, and never emits the number.
const deadEndSkeleton = (): ResearchSkeleton => ({
  search_query: "per-device prosthetic price germany",
  value: 4321, // perverse on purpose: a dead end must still emit NO number
  units: "EUR",
  date: "2025",
  author_publisher: "Should Be Ignored",
  source_url: "https://example.org/ignored",
  geography: "Germany",
  population_segment: "all",
  metric_definition: "should not survive a dead_end route",
  resolution_status: "dead_end",
  resolution_reason: DEAD_END_REASON,
});

// --- fake researcher call results -----------------------------------------

const blocked = {
  skeleton: blockedSkeleton(),
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
const weak = {
  skeleton: weakSkeleton(),
  model: "fake",
  usage: { inputTokens: 1, outputTokens: 1 },
  searchErrorCodes: [],
  rateLimitBlocked: false,
};
const deadEnd = {
  skeleton: deadEndSkeleton(),
  model: "fake",
  usage: { inputTokens: 1, outputTokens: 1 },
  searchErrorCodes: [],
  rateLimitBlocked: false,
};

// --- fake CRAAP -----------------------------------------------------------

function fakeCraap(opts: { pass: boolean }): CraapValidationResult {
  const dim = (score: number) => ({ score, reasoning: "fake" });
  const total = opts.pass ? 0.9 : 0.4; // below CRAAP_THRESHOLD on a fail
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

function countingValidate(pass: boolean): { fn: ValidateFn; calls: () => number } {
  let n = 0;
  const fn: ValidateFn = async () => {
    n++;
    return fakeCraap({ pass });
  };
  return { fn, calls: () => n };
}

// === Class 1: blocked -> SAME-tier retry (no descent, no CRAAP attempt) =====
async function caseBlocked() {
  console.log(
    "\n=== Class 1 (blocked): block -> backoff -> SAME-tier retry -> recover -> CRAAP ===",
  );
  console.log(
    "Prediction: 1 search round at tier 1; 2 search calls; status searched; CRAAP once; resolved.\n",
  );

  let searchCalls = 0;
  const searchFn: SearchFn = async () => {
    searchCalls++;
    return searchCalls === 1 ? blocked : recovered;
  };
  const craap = countingValidate(true);

  const r = await resolveSlotWithRetry(SLOT, { searchFn, validateFn: craap.fn });
  console.log("  searchRounds:", JSON.stringify(r.searchRounds));
  console.log(
    "  outcome:", r.outcome, "| attempts:", r.attempts.length,
    "| craapCalls:", craap.calls(), "| assumptionSeam:", r.assumptionSeam,
  );

  check("1 search round (no tier descent on a block)", r.searchRounds.length === 1, r.searchRounds.length);
  check("tier 1 made 2 search calls (1 block + 1 retry)", r.searchRounds[0]?.searchCalls === 2, r.searchRounds[0]?.searchCalls);
  check('round status "searched" after recovery', r.searchRounds[0]?.status === "searched", r.searchRounds[0]?.status);
  check("handed to CRAAP exactly once", craap.calls() === 1, craap.calls());
  check("outcome resolved", r.outcome === "resolved", r.outcome);
  check("deadEnd false", r.deadEnd === false, r.deadEnd);
  check("assumptionSeam null (not a dead end)", r.assumptionSeam === null, r.assumptionSeam);
}

// === Class 2: CRAAP-fail -> tier descent (a `miss` is NOT a dead end) =======
async function caseCraapFail() {
  console.log(
    "\n=== Class 2 (CRAAP-fail): every tier fails CRAAP -> full descent -> failed_threshold ===",
  );
  console.log(
    "Prediction: 3 search rounds (tiers 1,2,3); 3 CRAAP calls; outcome failed_threshold;\n" +
      "            a `miss` never routes to the seam (assumptionSeam null, deadEnd false).\n",
  );

  let searchCalls = 0;
  const searchFn: SearchFn = async () => {
    searchCalls++;
    return weak; // always a miss-with-figure that CRAAP rejects
  };
  const craap = countingValidate(false);

  const r = await resolveSlotWithRetry(SLOT, { searchFn, validateFn: craap.fn });
  console.log("  searchRounds:", JSON.stringify(r.searchRounds.map((s) => ({ tier: s.tier, status: s.status }))));
  console.log(
    "  outcome:", r.outcome, "| attempts:", r.attempts.length,
    "| craapCalls:", craap.calls(), "| searchFn calls:", searchCalls,
    "| assumptionSeam:", r.assumptionSeam,
  );

  check("3 search rounds (descended through all tiers)", r.searchRounds.length === 3, r.searchRounds.length);
  check("tiers descended 1 -> 2 -> 3", JSON.stringify(r.searchRounds.map((s) => s.tier)) === "[1,2,3]", r.searchRounds.map((s) => s.tier));
  check("3 CRAAP attempts (a miss IS scored)", r.attempts.length === 3 && craap.calls() === 3, { attempts: r.attempts.length, craap: craap.calls() });
  check("outcome failed_threshold (quality, not dead end)", r.outcome === "failed_threshold", r.outcome);
  check("a `miss` did NOT route to the seam", r.assumptionSeam === null, r.assumptionSeam);
  check("deadEnd false for a miss", r.deadEnd === false, r.deadEnd);
}

// === Class 3: dead_end -> seam (no further attempts, no number) =============
async function caseDeadEnd() {
  console.log(
    "\n=== Class 3 (dead_end): researcher dead-ends -> STOP -> assumption-fallback seam ===",
  );
  console.log(
    "Prediction: 1 search round; searchFn called exactly ONCE (no descent to tier 2/3 even\n" +
      "            though a later call WOULD pass); CRAAP never called; 0 attempts; outcome dead_end;\n" +
      "            seam emitted with value null and the researcher's reason; NO numeric value anywhere.\n",
  );

  // First call dead-ends; any later call would return a CRAAP-passing source.
  // So if the loop wrongly fell through to descent, outcome would become resolved
  // — the assertions below would catch it.
  let searchCalls = 0;
  const searchFn: SearchFn = async () => {
    searchCalls++;
    return searchCalls === 1 ? deadEnd : recovered;
  };
  const craap = countingValidate(true);

  const r = await resolveSlotWithRetry(SLOT, { searchFn, validateFn: craap.fn });
  console.log("  searchRounds:", JSON.stringify(r.searchRounds));
  console.log(
    "  outcome:", r.outcome, "| attempts:", r.attempts.length,
    "| craapCalls:", craap.calls(), "| searchFn calls:", searchCalls,
    "| winnerAttempt:", r.winnerAttempt,
  );
  console.log("  assumptionSeam:", JSON.stringify(r.assumptionSeam));

  // routes to the seam
  check("outcome dead_end", r.outcome === "dead_end", r.outcome);
  check("deadEnd flag true", r.deadEnd === true, r.deadEnd);
  check("assumptionSeam present", r.assumptionSeam !== null, r.assumptionSeam !== null);
  check('seam kind "assumption_fallback_pending"', r.assumptionSeam?.kind === "assumption_fallback_pending", r.assumptionSeam?.kind);
  check("seam carries the researcher's resolution_reason", r.assumptionSeam?.resolutionReason === DEAD_END_REASON, r.assumptionSeam?.resolutionReason);
  check("seam labels the slot loudly", typeof r.assumptionSeam?.slotLabel === "string" && r.assumptionSeam.slotLabel.includes(SLOT.metric), r.assumptionSeam?.slotLabel);

  // (a) consumes no additional attempts AFTER the dead_end verdict
  check("(a) searchFn called exactly ONCE (no tier descent past the dead end)", searchCalls === 1, searchCalls);
  check("(a) only 1 search round", r.searchRounds.length === 1, r.searchRounds.length);
  check("(a) CRAAP never called (no source to score)", craap.calls() === 0, craap.calls());
  check("(a) 0 CRAAP attempts recorded", r.attempts.length === 0, r.attempts.length);
  check("(a) did NOT fall through to resolved despite a passing source waiting", r.outcome !== "resolved", r.outcome);

  // (b) emits no numeric value — even though the dead_end skeleton carried 4321
  check("(b) seam value is null (no figure)", r.assumptionSeam?.value === null, r.assumptionSeam?.value);
  check("(b) winnerAttempt null (no figure surfaced)", r.winnerAttempt === null, r.winnerAttempt);
  check("(b) not resolved / not rate_limited / not failed_threshold", !r.resolved && !r.rateLimited && !r.failedThreshold, { resolved: r.resolved, rateLimited: r.rateLimited, failedThreshold: r.failedThreshold });
}

async function main() {
  console.log(
    "Deterministic offline proof of the 3 failure classes — focus: early-stop-on-dead-end (ZERO API calls)",
  );
  await caseBlocked();
  await caseCraapFail();
  await caseDeadEnd();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
