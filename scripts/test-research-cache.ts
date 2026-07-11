// Deterministic, OFFLINE proof of the slot-results cache (V6.16.2). Zero API
// calls: search + CRAAP are injected fakes that COUNT their invocations, so the
// cache's core promises are directly assertable:
//   - OFF by default: with RESEARCH_CACHE unset, nothing is stored or replayed;
//   - cache on ACCEPT only: a passing slot is stored; failed-threshold and
//     dead-end outcomes are NOT;
//   - a hit replays the stored skeleton + CRAAP score and makes ZERO live
//     calls, is marked fromCache, and costs zero usage;
//   - a stale entry that no longer clears the threshold gate is a MISS
//     (re-checked in code at read time), not a free pass.
//
// Uses a temp cache dir (RESEARCH_CACHE_DIR) so real dev cache state is never
// touched. Exercises the real 2s pre-search spacing on live-path calls.
// Run: npx tsx scripts/test-research-cache.ts   (no env / no API key needed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSlotWithRetry } from "../lib/researchLoop";
import { slotCacheKey } from "../lib/researchCache";
import type { ResearchSlot, ResearcherCallResult, SearchFn } from "../lib/researcher";
import type { ValidateFn } from "../lib/researchLoop";
import { CRAAP_WEIGHTS, type CraapValidationResult } from "../lib/craapValidator";

let failures = 0;
function check(label: string, cond: boolean, actual?: unknown) {
  const tag = cond ? "PASS" : "FAIL";
  const suffix = actual === undefined ? "" : `  (actual: ${JSON.stringify(actual)})`;
  console.log(`  [${tag}] ${label}${suffix}`);
  if (!cond) failures++;
}

const slot: ResearchSlot = {
  kind: "anchor",
  filterIndex: null,
  geography: "Testland",
  metric: "annual widget events",
  definition: "Widget events per year in Testland.",
};

function foundResult(value: number): ResearcherCallResult {
  return {
    skeleton: {
      search_query: "fake",
      value,
      units: "events/year",
      date: "2025",
      author_publisher: "Testland Statistics Office",
      source_url: "https://stats.testland.example/widgets",
      geography: "Testland",
      population_segment: "all",
      metric_definition: "fake",
      resolution_status: "found",
      resolution_reason: "sourced",
    },
    model: "fake-researcher-model",
    usage: { inputTokens: 10, outputTokens: 5 },
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
      relevance: { geography_match: dim(total), population_match: dim(total), metric_match: dim(total) },
      purpose: { gate: "pass", reasoning: "fake" },
    },
    relevanceScore: total,
    weights: CRAAP_WEIGHTS,
    weightedTotal: total,
    purpose: { gate: "pass", reasoning: "fake" },
    model: "fake-craap-model",
    usage: { inputTokens: 3, outputTokens: 2 },
  };
}

function counters(craapTotal: number) {
  let searches = 0;
  let validations = 0;
  const searchFn: SearchFn = async () => {
    searches++;
    return foundResult(6000);
  };
  const validateFn: ValidateFn = async () => {
    validations++;
    return craap(craapTotal);
  };
  return { searchFn, validateFn, count: () => ({ searches, validations }) };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-cache-test-"));
  process.env.RESEARCH_CACHE_DIR = tmpDir;
  const entryFile = path.join(tmpDir, `${slotCacheKey(slot)}.json`);

  console.log("Deterministic offline proof of the slot-results cache (ZERO API calls)");
  console.log(`  temp cache dir: ${tmpDir}`);

  // === Case 1: flag OFF (default) -> no store, no replay ===
  console.log("\n=== Case 1: RESEARCH_CACHE unset -> cache fully inert ===");
  delete process.env.RESEARCH_CACHE;
  {
    const c = counters(0.9);
    const r1 = await resolveSlotWithRetry(slot, { searchFn: c.searchFn, validateFn: c.validateFn });
    const r2 = await resolveSlotWithRetry(slot, { searchFn: c.searchFn, validateFn: c.validateFn });
    check("both runs researched live", c.count().searches === 2 && c.count().validations === 2, c.count());
    check("no fromCache flag", !r1.fromCache && !r2.fromCache, [r1.fromCache, r2.fromCache]);
    check("no cache file written", !fs.existsSync(entryFile), fs.existsSync(entryFile));
  }

  // === Case 2: flag ON, accept -> stored; second run replays with zero calls ===
  console.log("\n=== Case 2: ON + ACCEPT -> stored once, replayed free ===");
  process.env.RESEARCH_CACHE = "1";
  {
    const c = counters(0.9);
    const r1 = await resolveSlotWithRetry(slot, { searchFn: c.searchFn, validateFn: c.validateFn });
    check("first run resolved live", r1.resolved && !r1.fromCache, { resolved: r1.resolved, fromCache: r1.fromCache });
    check("entry written on accept", fs.existsSync(entryFile), fs.existsSync(entryFile));

    const r2 = await resolveSlotWithRetry(slot, { searchFn: c.searchFn, validateFn: c.validateFn });
    check("second run is a replay (fromCache)", r2.fromCache === true, r2.fromCache);
    check("replay made ZERO further live calls", c.count().searches === 1 && c.count().validations === 1, c.count());
    check("replay resolved with the stored value", r2.resolved && r2.attempts[0]?.skeleton.value === 6000, r2.attempts[0]?.skeleton.value);
    check("replay carries the stored CRAAP score", r2.attempts[0]?.blendedScore === 0.9, r2.attempts[0]?.blendedScore);
    check("replay costs zero usage", r2.totalUsage.inputTokens === 0 && r2.totalUsage.outputTokens === 0, r2.totalUsage);
    check("replay winner is surfaced", r2.winnerAttempt === 1, r2.winnerAttempt);
  }

  // === Case 3: sub-threshold outcome is NOT cached ===
  console.log("\n=== Case 3: failed_threshold -> never cached ===");
  {
    fs.rmSync(entryFile, { force: true });
    const c = counters(0.2); // CRAAP fails every tier
    const r = await resolveSlotWithRetry(slot, { searchFn: c.searchFn, validateFn: c.validateFn });
    check("outcome failed_threshold", r.outcome === "failed_threshold", r.outcome);
    check("no cache entry written", !fs.existsSync(entryFile), fs.existsSync(entryFile));
  }

  // === Case 4: dead_end is NOT cached ===
  console.log("\n=== Case 4: dead_end -> never cached ===");
  {
    const searchFn: SearchFn = async () => ({
      ...foundResult(0),
      skeleton: { ...foundResult(0).skeleton, value: null, resolution_status: "dead_end", resolution_reason: "not published (fake)" },
    });
    const c = counters(0.9);
    const r = await resolveSlotWithRetry(slot, { searchFn, validateFn: c.validateFn });
    check("outcome dead_end", r.outcome === "dead_end", r.outcome);
    check("no cache entry written", !fs.existsSync(entryFile), fs.existsSync(entryFile));
  }

  // === Case 5: stale entry below the threshold gate is a MISS ===
  console.log("\n=== Case 5: stored entry re-gated at read time ===");
  {
    // Hand-write an entry whose stored score no longer clears 0.7.
    const stale = {
      cachedAt: new Date().toISOString(),
      slotKey: slotCacheKey(slot),
      skeleton: foundResult(1234).skeleton,
      craap: craap(0.5),
      researcherModel: "fake",
    };
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(entryFile, JSON.stringify(stale), "utf8");

    const c = counters(0.9);
    const r = await resolveSlotWithRetry(slot, { searchFn: c.searchFn, validateFn: c.validateFn });
    check("stale entry NOT replayed (live research ran)", c.count().searches === 1, c.count());
    check("result is the fresh live value, not the stale one", r.attempts[0]?.skeleton.value === 6000 && !r.fromCache, r.attempts[0]?.skeleton.value);
  }

  // === Case 6: TTL — an entry older than the TTL is STALE and re-researches ===
  console.log("\n=== Case 6: entry older than TTL -> stale MISS; within TTL -> hit ===");
  {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const oldEntry = {
      cachedAt: fortyDaysAgo,
      slotKey: slotCacheKey(slot),
      skeleton: foundResult(4242).skeleton,
      craap: craap(0.9),
      researcherModel: "fake",
    };
    fs.writeFileSync(entryFile, JSON.stringify(oldEntry), "utf8");

    // Default TTL (30 days): 40-day-old entry must MISS -> live research runs.
    delete process.env.RESEARCH_CACHE_TTL_DAYS;
    const c1 = counters(0.9);
    const r1 = await resolveSlotWithRetry(slot, { searchFn: c1.searchFn, validateFn: c1.validateFn });
    check("40-day entry stale under default 30d TTL (live ran)", c1.count().searches === 1 && !r1.fromCache, { ...c1.count(), fromCache: r1.fromCache });

    // Widened TTL (365 days): the same-aged entry is a HIT.
    fs.writeFileSync(entryFile, JSON.stringify(oldEntry), "utf8");
    process.env.RESEARCH_CACHE_TTL_DAYS = "365";
    const c2 = counters(0.9);
    const r2 = await resolveSlotWithRetry(slot, { searchFn: c2.searchFn, validateFn: c2.validateFn });
    check("same entry HITS under 365d TTL (zero live calls)", c2.count().searches === 0 && r2.fromCache === true, { ...c2.count(), fromCache: r2.fromCache });
    check("hit replays the stored (older) value", r2.attempts[0]?.skeleton.value === 4242, r2.attempts[0]?.skeleton.value);
    delete process.env.RESEARCH_CACHE_TTL_DAYS;
  }

  delete process.env.RESEARCH_CACHE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
