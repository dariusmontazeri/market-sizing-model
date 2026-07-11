// Deterministic, OFFLINE proof of the RESOLUTION LADDER (V6.18) routing
// correctly in the research loop: direct research -> declared geography proxy
// -> reasoned assumption, with rate limiting as the ONLY non-value outcome.
// Zero API calls, zero cost: search, proxy, CRAAP, and assumption calls are
// injected fakes, so the loop's REAL routing logic runs against simulated
// component outputs.
//
// The classes, each its own handler, no collision:
//   blocked    -> backoff + retry the SAME tier (no descent, no CRAAP attempt)
//   CRAAP-fail -> full tier descent, then LADDER: proxy rung (here it PASSES)
//   dead_end   -> STOP direct research immediately, LADDER: proxy dead-ends
//                 too -> assumption rung yields a flagged value
//   rate-limit -> halt; the ladder is NOT descended (infrastructure, not
//                 judgment — no assumption may be fabricated from a throttle)
//
// The loop's real spacing/backoff sleeps run here, so this script takes ~30s
// of wall time. Run: npx tsx scripts/test-research-loop-deadend.ts
import { resolveSlotWithRetry, type ValidateFn, type ProxySearchFn, type AssumptionFn } from "../lib/researchLoop";
import type {
  ProxyCallResult,
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
// "miss", NOT dead_end — it must flow to CRAAP and tier descent.
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

// --- fake proxy results -----------------------------------------------------

const PROXY_JUSTIFICATION =
  "Sweden's single-payer prosthetics reimbursement is structurally comparable to Germany's statutory system.";

const proxyGood: ProxyCallResult = {
  skeleton: {
    ...goodSkeleton(),
    geography: "Sweden",
    author_publisher: "Fake Swedish Registry",
    source_url: "https://example.org/se",
    value: 777,
    proxy_justification: PROXY_JUSTIFICATION,
  },
  model: "fake",
  usage: { inputTokens: 1, outputTokens: 1 },
  searchErrorCodes: [],
  rateLimitBlocked: false,
};

const proxyDead: ProxyCallResult = {
  skeleton: {
    ...deadEndSkeleton(),
    proxy_justification: "no comparable geography publishes this either",
  },
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

// Passes ONLY proxy-geography definitions (used to prove the proxy is graded
// against its OWN geography while direct Germany attempts keep failing).
function geoAwareValidate(): { fn: ValidateFn; calls: () => number; proxyDefs: () => number } {
  let n = 0;
  let proxyDefs = 0;
  const fn: ValidateFn = async (def) => {
    n++;
    const isProxyDef = def.geography === "Sweden" && def.definition.includes("DECLARED GEOGRAPHY PROXY");
    if (isProxyDef) proxyDefs++;
    return fakeCraap({ pass: isProxyDef });
  };
  return { fn, calls: () => n, proxyDefs: () => proxyDefs };
}

function countingAssume(value: number): { fn: AssumptionFn; calls: () => number } {
  let n = 0;
  const fn: AssumptionFn = async () => {
    n++;
    return {
      assumption: {
        value,
        units: "EUR",
        reasoning: "fake first-principles estimate; conservative end of the defensible range",
      },
      model: "fake",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  };
  return { fn, calls: () => n };
}

function neverProxy(): { fn: ProxySearchFn; calls: () => number } {
  let n = 0;
  const fn: ProxySearchFn = async () => {
    n++;
    return proxyGood;
  };
  return { fn, calls: () => n };
}

// === Class 1: blocked -> SAME-tier retry (no descent, no CRAAP attempt) =====
async function caseBlocked() {
  console.log(
    "\n=== Class 1 (blocked): block -> backoff -> SAME-tier retry -> recover -> CRAAP ===",
  );
  console.log(
    "Prediction: 1 search round at tier 1; 2 search calls; status searched; CRAAP once; resolved; ladder untouched.\n",
  );

  let searchCalls = 0;
  const searchFn: SearchFn = async () => {
    searchCalls++;
    return searchCalls === 1 ? blocked : recovered;
  };
  const craap = countingValidate(true);
  const proxy = neverProxy();
  const assume = countingAssume(0);

  const r = await resolveSlotWithRetry(SLOT, {
    searchFn, validateFn: craap.fn, proxySearchFn: proxy.fn, assumptionFn: assume.fn,
  });
  console.log("  searchRounds:", JSON.stringify(r.searchRounds));
  console.log("  outcome:", r.outcome, "| attempts:", r.attempts.length, "| craapCalls:", craap.calls());

  check("1 search round (no tier descent on a block)", r.searchRounds.length === 1, r.searchRounds.length);
  check("tier 1 made 2 search calls (1 block + 1 retry)", r.searchRounds[0]?.searchCalls === 2, r.searchRounds[0]?.searchCalls);
  check('round status "searched" after recovery', r.searchRounds[0]?.status === "searched", r.searchRounds[0]?.status);
  check("handed to CRAAP exactly once", craap.calls() === 1, craap.calls());
  check("outcome resolved", r.outcome === "resolved", r.outcome);
  check('directOutcome "resolved"', r.directOutcome === "resolved", r.directOutcome);
  check("ladder untouched (no proxy call, no assumption call)", proxy.calls() === 0 && assume.calls() === 0, { proxy: proxy.calls(), assume: assume.calls() });
  check("proxy and assumption fields null", r.proxy === null && r.assumption === null, { proxy: r.proxy, assumption: r.assumption });
}

// === Class 2: CRAAP-fail -> full descent -> LADDER: proxy PASSES ============
async function caseCraapFailThenProxy() {
  console.log(
    "\n=== Class 2 (CRAAP-fail): both direct attempts fail -> proxy rung PASSES -> resolved_proxy ===",
  );
  console.log(
    "Prediction: 2 direct rounds (tiers 1,2) both sub-threshold; proxy searched once; proxy CRAAP\n" +
      "            graded against Sweden with the proxy note; outcome resolved_proxy; assumption never called.\n",
  );

  const searchFn: SearchFn = async () => weak; // every direct attempt is a rejectable miss
  const craap = geoAwareValidate(); // fails Germany defs, passes the Sweden proxy def
  let proxyCalls = 0;
  const proxyFn: ProxySearchFn = async () => {
    proxyCalls++;
    return proxyGood;
  };
  const assume = countingAssume(0);

  const r = await resolveSlotWithRetry(SLOT, {
    searchFn, validateFn: craap.fn, proxySearchFn: proxyFn, assumptionFn: assume.fn,
  });
  console.log("  outcome:", r.outcome, "| directOutcome:", r.directOutcome, "| proxy passed:", r.proxy?.passed);

  check("2 direct search rounds (budget 1 + 1 earned)", r.searchRounds.length === 2, r.searchRounds.length);
  check('directOutcome "failed_threshold"', r.directOutcome === "failed_threshold", r.directOutcome);
  check("proxy rung called exactly once", proxyCalls === 1, proxyCalls);
  check("proxy CRAAP graded against the PROXY geography def", craap.proxyDefs() === 1, craap.proxyDefs());
  check("3 CRAAP calls total (2 direct + 1 proxy)", craap.calls() === 3, craap.calls());
  check('outcome "resolved_proxy"', r.outcome === "resolved_proxy", r.outcome);
  check("proxy record present and passed", r.proxy !== null && r.proxy.passed === true, r.proxy?.passed);
  check("proxy value carried (777, Sweden)", r.proxy?.skeleton.value === 777 && r.proxy?.skeleton.geography === "Sweden", { value: r.proxy?.skeleton.value, geo: r.proxy?.skeleton.geography });
  check("proxy justification carried", r.proxy?.skeleton.proxy_justification === PROXY_JUSTIFICATION, r.proxy?.skeleton.proxy_justification);
  check("proxy directFailure names the threshold failure", r.proxy?.directFailure.includes("no direct source cleared") === true, r.proxy?.directFailure);
  check("assumption rung never reached", assume.calls() === 0 && r.assumption === null, assume.calls());
  check("winnerAttempt null (no direct winner surfaced)", r.winnerAttempt === null, r.winnerAttempt);
  check("resolved flag false (resolved means DIRECT)", r.resolved === false, r.resolved);
}

// === Class 3: dead_end -> proxy dead-ends too -> ASSUMPTION =================
async function caseDeadEndToAssumption() {
  console.log(
    "\n=== Class 3 (dead_end): direct dead-ends -> proxy dead-ends -> reasoned assumption ===",
  );
  console.log(
    "Prediction: direct searched exactly ONCE (no descent past a dead end), CRAAP never called on it;\n" +
      "            proxy searched once, dead-ends, CRAAP never called on it; assumption yields 555;\n" +
      "            outcome resolved_assumption; the dead-end skeletons' 4321 never surfaces.\n",
  );

  let searchCalls = 0;
  const searchFn: SearchFn = async () => {
    searchCalls++;
    return searchCalls === 1 ? deadEnd : recovered; // descent past the dead end would wrongly resolve
  };
  const craap = countingValidate(true);
  let proxyCalls = 0;
  const proxyFn: ProxySearchFn = async () => {
    proxyCalls++;
    return proxyDead;
  };
  const assume = countingAssume(555);

  const r = await resolveSlotWithRetry(SLOT, {
    searchFn, validateFn: craap.fn, proxySearchFn: proxyFn, assumptionFn: assume.fn,
  });
  console.log("  outcome:", r.outcome, "| directOutcome:", r.directOutcome);
  console.log("  assumption:", JSON.stringify(r.assumption));

  check('directOutcome "dead_end"', r.directOutcome === "dead_end", r.directOutcome);
  check("direct searched exactly ONCE (no descent past the dead end)", searchCalls === 1, searchCalls);
  check("proxy rung tried once", proxyCalls === 1, proxyCalls);
  check("CRAAP never called (no gradeable source on either rung)", craap.calls() === 0, craap.calls());
  check("assumption rung called once", assume.calls() === 1, assume.calls());
  check('outcome "resolved_assumption"', r.outcome === "resolved_assumption", r.outcome);
  check("assumption value 555 carried", r.assumption?.value === 555, r.assumption?.value);
  check("assumption reasoning carried", typeof r.assumption?.reasoning === "string" && r.assumption.reasoning.length > 0, r.assumption?.reasoning);
  check("ladderTrace names BOTH rung failures", r.assumption?.ladderTrace.includes("dead-ended") === true && r.assumption?.ladderTrace.includes("proxy") === true, r.assumption?.ladderTrace);
  check("proxy record present but not passed (craap null)", r.proxy !== null && r.proxy.passed === false && r.proxy.craap === null, { passed: r.proxy?.passed, craap: r.proxy?.craap });
  check("winnerAttempt null — the 4321 never surfaces", r.winnerAttempt === null, r.winnerAttempt);
  check("0 direct CRAAP attempts recorded", r.attempts.length === 0, r.attempts.length);
}

// === Class 4: rate-limited -> HALT; the ladder is NOT descended =============
async function caseRateLimitedNoLadder() {
  console.log(
    "\n=== Class 4 (rate-limited): search stays blocked -> halt; NO proxy, NO assumption ===",
  );
  console.log(
    "Prediction: backoff budget exhausted; outcome rate_limited; proxyFn and assumptionFn NEVER called\n" +
      "            (an infrastructure failure must not be laundered into a fabricated assumption).\n",
  );

  const searchFn: SearchFn = async () => blocked; // never recovers
  const craap = countingValidate(true);
  const proxy = neverProxy();
  const assume = countingAssume(0);

  const r = await resolveSlotWithRetry(SLOT, {
    searchFn, validateFn: craap.fn, proxySearchFn: proxy.fn, assumptionFn: assume.fn,
  });
  console.log("  outcome:", r.outcome, "| directOutcome:", r.directOutcome);

  check('outcome "rate_limited"', r.outcome === "rate_limited", r.outcome);
  check("rateLimited flag true", r.rateLimited === true, r.rateLimited);
  check("proxy rung NOT descended", proxy.calls() === 0 && r.proxy === null, proxy.calls());
  check("assumption rung NOT descended", assume.calls() === 0 && r.assumption === null, assume.calls());
  check("CRAAP never called", craap.calls() === 0, craap.calls());
}

async function main() {
  console.log(
    "Deterministic offline proof of the RESOLUTION LADDER (V6.18) — ZERO API calls",
  );
  await caseBlocked();
  await caseCraapFailThenProxy();
  await caseDeadEndToAssumption();
  await caseRateLimitedNoLadder();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
