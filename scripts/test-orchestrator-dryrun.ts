// Deterministic, OFFLINE dry-run of the back-half orchestrator. Zero API calls:
// search + CRAAP are injected fakes, so the REAL chain runs — pin -> load
// validated structure -> deriveResearchSlots -> resolveSlotWithRetry per slot ->
// adapter -> units-math -> scored result object — proving every SEAM connects and
// the shape/traceability is right before any real (paid) run.
//
// Two cases:
//   1. Complete Germany run: all slots resolve, waterfall computed, SAM$/SOM/
//      replacement/credibility correct, percentage AND proportion filters
//      normalized, every number carries a source + CRAAP score.
//   2. Dead-end run: the price slot dead-ends -> result INCOMPLETE, sizing null,
//      the offending slot surfaced loudly, NO zero-fill, NO fabricated number.
//
// Exercises the REAL 2s pre-search spacing per slot, so this takes ~16s.
// Run: npx tsx scripts/test-orchestrator-dryrun.ts   (no env / no API key needed)
import { runPinnedGermanySizing } from "../lib/orchestrator";
import type {
  ResearchSlot,
  ResearcherCallResult,
  SearchFn,
} from "../lib/researcher";
import type { ValidateFn } from "../lib/researchLoop";
import { CRAAP_WEIGHTS, type CraapValidationResult } from "../lib/craapValidator";

let failures = 0;
function check(label: string, cond: boolean, actual?: unknown) {
  const tag = cond ? "PASS" : "FAIL";
  const suffix = actual === undefined ? "" : `  (actual: ${JSON.stringify(actual)})`;
  console.log(`  [${tag}] ${label}${suffix}`);
  if (!cond) failures++;
}

// Build a found skeleton with a slot-appropriate value.
function found(
  value: number,
  units: string,
  publisher: string,
): ResearcherCallResult {
  return {
    skeleton: {
      search_query: "fake",
      value,
      units,
      date: "2025",
      author_publisher: publisher,
      source_url: `https://example.org/${encodeURIComponent(publisher)}`,
      geography: "Germany",
      population_segment: "all",
      metric_definition: "fake",
      resolution_status: "found",
      resolution_reason: "sourced figure located",
    },
    model: "fake",
    usage: { inputTokens: 10, outputTokens: 5 },
    searchErrorCodes: [],
    rateLimitBlocked: false,
  };
}

function deadEnd(reason: string): ResearcherCallResult {
  return {
    skeleton: {
      search_query: "fake",
      value: null,
      units: null,
      date: null,
      author_publisher: null,
      source_url: null,
      geography: "Germany",
      population_segment: null,
      metric_definition: "fake",
      resolution_status: "dead_end",
      resolution_reason: reason,
    },
    model: "fake",
    usage: { inputTokens: 10, outputTokens: 5 },
    searchErrorCodes: [],
    rateLimitBlocked: false,
  };
}

// Per-slot fake values: anchor=6000 events, filter0=0.6 (proportion path),
// filter1=50% (percentage path -> 0.5), price=8000 EUR.
function slotValue(slot: ResearchSlot): ResearcherCallResult {
  if (slot.kind === "anchor") return found(6000, "events/year", "Destatis (fake)");
  if (slot.kind === "price") return found(8000, "EUR", "GKV (fake)");
  if (slot.filterIndex === 0) return found(0.6, "proportion", "Study A (fake)");
  return found(50, "%", "Study B (fake)"); // filter[1] as a percentage
}

// Fake CRAAP: pass, distinct scores per slot so the credibility mean is checkable.
function craapFor(slot: ResearchSlot): CraapValidationResult {
  const total =
    slot.kind === "anchor" ? 0.9 : slot.kind === "price" ? 0.75 : slot.filterIndex === 0 ? 0.8 : 0.85;
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
    model: "fake",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

async function caseComplete() {
  console.log("\n=== Case 1: complete Germany run (all slots resolve) ===");
  const searchFn: SearchFn = async (slot) => slotValue(slot);
  const validateFn: ValidateFn = async (slotDef) =>
    // slotDef carries metric/geography; map back to a slot kind via the metric text.
    craapFor(
      /Annual/.test(slotDef.metric)
        ? ({ kind: "anchor", filterIndex: null } as ResearchSlot)
        : /price/i.test(slotDef.metric)
          ? ({ kind: "price", filterIndex: null } as ResearchSlot)
          : /Major-limb/.test(slotDef.metric)
            ? ({ kind: "filter", filterIndex: 0 } as ResearchSlot)
            : ({ kind: "filter", filterIndex: 1 } as ResearchSlot),
    );

  const r = await runPinnedGermanySizing({ searchFn, validateFn });

  console.log("  complete:", r.complete, "| pinned:", r.pinned, "| credibility:", r.credibility.score);
  console.log("  slots:", JSON.stringify(r.slots.map((s) => ({ k: s.kind, i: s.filterIndex, raw: s.rawValue, norm: s.normalizedRate, craap: s.craapScore, src: s.source?.author_publisher }))));
  if (r.sizing) {
    console.log("  samUnits:", r.sizing.samUnits, "| samDollars:", r.sizing.samDollars);
    console.log("  SOM base:", JSON.stringify(r.sizing.som.base));
  }

  check("pinned flag true", r.pinned === true, r.pinned);
  check("complete", r.complete === true, r.complete);
  check("no incomplete reasons", r.incompleteReasons.length === 0, r.incompleteReasons);
  check("4 slots", r.slots.length === 4, r.slots.length);
  check("every slot resolved", r.slots.every((s) => s.resolved), r.slots.map((s) => s.resolved));
  check("every resolved slot has a source", r.slots.every((s) => s.source?.author_publisher), true);
  check("filter[0] proportion 0.6 kept as 0.6", r.slots.find((s) => s.kind === "filter" && s.filterIndex === 0)?.normalizedRate === 0.6, r.slots.find((s) => s.kind === "filter" && s.filterIndex === 0)?.normalizedRate);
  check("filter[1] 50% normalized to 0.5", r.slots.find((s) => s.kind === "filter" && s.filterIndex === 1)?.normalizedRate === 0.5, r.slots.find((s) => s.kind === "filter" && s.filterIndex === 1)?.normalizedRate);
  check("samUnits = 6000*0.6*0.5 = 1800", r.sizing?.samUnits === 1800, r.sizing?.samUnits);
  check("samDollars = 1800*8000 = 14,400,000", r.sizing?.samDollars === 14_400_000, r.sizing?.samDollars);
  check("SOM base somDollars = 432,000", r.sizing?.som.base.somDollars === 432_000, r.sizing?.som.base.somDollars);
  check("SOM base replacement (rate 0.5) = 216,000", r.sizing?.som.base.replacementDollars === 216_000, r.sizing?.som.base.replacementDollars);
  check("SOM base total w/ replacement = 648,000", r.sizing?.som.base.totalWithReplacement === 648_000, r.sizing?.som.base.totalWithReplacement);
  check("SOM bear/base/bull present", !!(r.sizing?.som.bear && r.sizing?.som.base && r.sizing?.som.bull), true);
  check("replacementRate is a flagged assumption (0.5)", r.assumptions.some((a) => a.field === "replacementRate" && a.value === 0.5), r.assumptions);
  check("sizingInputs.replacementRate = assumption 0.5", r.sizingInputs?.replacementRate === 0.5, r.sizingInputs?.replacementRate);
  // credibility = mean(0.9, 0.8, 0.85, 0.75) = 0.825 (compare within float epsilon)
  check("credibility = mean of slot CRAAP = 0.825", r.credibility.score !== null && Math.abs(r.credibility.score - 0.825) < 1e-9, r.credibility.score);
}

async function caseDeadEnd() {
  console.log("\n=== Case 2: price slot dead-ends -> INCOMPLETE, no zero-fill ===");
  const searchFn: SearchFn = async (slot) =>
    slot.kind === "price"
      ? deadEnd("no per-device price is published in Germany (fake dead end)")
      : slotValue(slot);
  const validateFn: ValidateFn = async (slotDef) =>
    craapFor(
      /Annual/.test(slotDef.metric)
        ? ({ kind: "anchor", filterIndex: null } as ResearchSlot)
        : /Major-limb/.test(slotDef.metric)
          ? ({ kind: "filter", filterIndex: 0 } as ResearchSlot)
          : ({ kind: "filter", filterIndex: 1 } as ResearchSlot),
    );

  const r = await runPinnedGermanySizing({ searchFn, validateFn });

  console.log("  complete:", r.complete, "| sizing:", r.sizing, "| sizingInputs:", r.sizingInputs);
  console.log("  incompleteReasons:", JSON.stringify(r.incompleteReasons));
  const price = r.slots.find((s) => s.kind === "price");
  console.log("  price slot:", JSON.stringify({ outcome: price?.outcome, resolved: price?.resolved, raw: price?.rawValue, reason: price?.unresolvedReason }));

  check("complete is FALSE", r.complete === false, r.complete);
  check("sizing is null (no waterfall on a missing number)", r.sizing === null, r.sizing);
  check("sizingInputs null", r.sizingInputs === null, r.sizingInputs);
  check("incompleteReasons surfaces the price slot", r.incompleteReasons.some((x) => /price/.test(x) && /DEAD END/.test(x)), r.incompleteReasons);
  check("price slot outcome dead_end", price?.outcome === "dead_end", price?.outcome);
  check("price slot NOT resolved", price?.resolved === false, price?.resolved);
  check("price slot rawValue null (NOT zero-filled)", price?.rawValue === null, price?.rawValue);
  check("the 3 non-price slots still resolved", r.slots.filter((s) => s.kind !== "price").every((s) => s.resolved), true);
}

async function main() {
  process.env.PIN_STRUCTURE = "germany"; // dev pin ON for the back-half path
  console.log("Deterministic offline dry-run of the back-half orchestrator (ZERO API calls)");
  await caseComplete();
  await caseDeadEnd();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
