// Back-half orchestrator — the FIRST end-to-end wiring of the units-based chain.
//
// One code path, pin ON for this slice: load the pinned VALIDATED Germany
// structure -> deriveResearchSlots -> run the research loop per slot (each its own
// isolated researcher + CRAAP call) -> ADAPT resolved slots into the waterfall
// math inputs -> produce a scored result object. The proposer + structural
// validator are BYPASSED this slice (the pin supplies an already-validated shape);
// wiring the proposer front-half is the next slice.
//
// Component independence (Principle 7) is preserved BY CONSTRUCTION: this module
// only connects one component's structured OUTPUT to the next component's INPUT,
// in code. The slots are derived from the STRUCTURE (never from another slot's
// result), and each slot is resolved by its own isolated resolveSlotWithRetry
// call. No component ever sees another's conversation or reasoning.
//
// Honesty invariants (CLAUDE.md governing principles):
//  - No silent null -> 0. A slot that dead-ends or fails to resolve does NOT get
//    zero-filled; the whole result is marked INCOMPLETE and the offending slot is
//    surfaced loudly. The waterfall is computed ONLY when every researched slot
//    resolved to a real number.
//  - Every number traces to a source OR an explicit assumption tag. The
//    replacement layer is NOT researched this slice (deriveResearchSlots emits no
//    replacement-cadence slot), so it is an EXPLICIT, loudly-flagged assumption —
//    never presented as sourced, and excluded from the credibility score.
import { loadPinnedStructure, isStructurePinned } from "./structurePin";
import {
  deriveResearchSlots,
  type MarketRef,
  type ResearchSlot,
} from "./researcher";
import {
  resolveSlotWithRetry,
  type LoopDeps,
  type SlotLoopResult,
  type SlotOutcome,
} from "./researchLoop";
import {
  sizeUnitsBased,
  type SizingInput,
  type SizingResult,
} from "./units-math";
import type { ProposedStructure } from "./structureProposer";

// The replacement layer is not a researched slot yet — model it as an EXPLICIT
// assumption. Loudly flagged, never counted as a source, excluded from
// credibility. A later slice can replace it with a researched replacement-cadence
// slot. The value is a transparent placeholder for wiring, NOT a validated figure.
const REPLACEMENT_RATE_ASSUMPTION = {
  field: "replacementRate" as const,
  value: 0.2,
  basis:
    "EXPLICIT ASSUMPTION (not researched): recurring replacement/renewal revenue modeled as a fraction of the new-fitting SOM, at a 5-year replacement cadence (1/5 per year — the hand-done Germany benchmark's assumption). deriveResearchSlots derives no replacement-cadence slot yet, so this is a flagged, reasoned assumption pending a researched replacement layer. It is excluded from the credibility score and must not be read as sourced.",
};

export type SlotSource = {
  author_publisher: string | null;
  source_url: string | null;
};

// A flat, traceable view of one slot's outcome for the result object.
export type ResolvedSlotView = {
  kind: ResearchSlot["kind"];
  filterIndex: number | null;
  metric: string;
  outcome: SlotOutcome;
  resolved: boolean;
  rawValue: number | null;
  units: string | null;
  // For filters only: the rawValue normalized to a [0,1] proportion for the math.
  normalizedRate: number | null;
  normalizationNote: string | null;
  source: SlotSource | null;
  craapScore: number | null; // winner attempt's blended CRAAP weightedTotal
  purposeGate: "pass" | "fail" | null;
  // True when the slot was replayed from the slot-results cache (a prior
  // ACCEPTED run) rather than researched live — surfaced, never hidden.
  fromCache: boolean;
  // Loud reason when a slot did not yield a usable number (never silently zeroed).
  unresolvedReason: string | null;
};

export type AssumptionFlag = { field: string; value: number; basis: string };

export type SizingRunResult = {
  ok: true;
  market: MarketRef;
  pinned: boolean;
  complete: boolean;
  // Loud, human-readable list of why the run is incomplete (empty when complete).
  incompleteReasons: string[];
  slots: ResolvedSlotView[];
  // The waterfall + SAM$ + SOM bear/base/bull + replacement layer. ONLY present
  // when complete; null otherwise (we never size a chain with a missing number).
  sizing: SizingResult | null;
  sizingInputs: SizingInput | null;
  assumptions: AssumptionFlag[];
  credibility: { score: number | null; basis: string };
  usage: { inputTokens: number; outputTokens: number };
};

// Filters are proportions in [0,1]. The researcher may answer as a percentage
// ("60%", value 60) or a proportion (0.6). A value > 1 can only be a percentage,
// so divide by 100; otherwise treat it as a proportion as-is. Recorded, not
// silently applied.
function normalizeRate(
  value: number,
  units: string | null,
): { rate: number; note: string } {
  if (value > 1) {
    return {
      rate: value / 100,
      note: `interpreted ${value}${units ? ` ${units}` : ""} as ${value / 100} (value > 1 -> percentage divided by 100)`,
    };
  }
  return {
    rate: value,
    note: `interpreted ${value}${units ? ` ${units}` : ""} as a proportion in [0,1]`,
  };
}

function reasonFor(result: SlotLoopResult): string {
  switch (result.outcome) {
    case "dead_end":
      return `DEAD END — ${result.assumptionSeam?.resolutionReason ?? "researcher established no sourceable figure exists"} (routes to the assumption-fallback seam; no figure)`;
    case "rate_limited":
      return "search was rate-limited (infrastructure) — no source was obtained; not a quality verdict";
    case "failed_threshold":
      return `no source cleared CRAAP ${result.threshold} across all tiers`;
    case "resolved":
      return "resolved but the winning source carried no finite numeric value";
  }
}

// Map one slot's loop result into the flat view + decide if it yielded a number.
function viewSlot(slot: ResearchSlot, result: SlotLoopResult): ResolvedSlotView {
  const winner =
    result.winnerAttempt !== null
      ? (result.attempts.find((a) => a.attempt === result.winnerAttempt) ?? null)
      : null;
  const skeleton = winner?.skeleton ?? null;
  const rawValue =
    typeof skeleton?.value === "number" && Number.isFinite(skeleton.value)
      ? skeleton.value
      : null;

  // "Usable" = the loop resolved AND a finite value actually came back. Anything
  // else is unresolved for sizing purposes — never silently zeroed.
  const usable = result.outcome === "resolved" && rawValue !== null;

  let normalizedRate: number | null = null;
  let normalizationNote: string | null = null;
  if (usable && slot.kind === "filter") {
    const norm = normalizeRate(rawValue, skeleton?.units ?? null);
    normalizedRate = norm.rate;
    normalizationNote = norm.note;
  }

  return {
    kind: slot.kind,
    filterIndex: slot.filterIndex,
    metric: slot.metric,
    outcome: result.outcome,
    resolved: usable,
    rawValue,
    units: skeleton?.units ?? null,
    normalizedRate,
    normalizationNote,
    source: skeleton
      ? { author_publisher: skeleton.author_publisher, source_url: skeleton.source_url }
      : null,
    craapScore: winner ? winner.blendedScore : null,
    purposeGate: winner ? (winner.purposePass ? "pass" : "fail") : null,
    fromCache: result.fromCache,
    unresolvedReason: usable ? null : reasonFor(result),
  };
}

// The pure back-half: structure in -> scored result out. No pin knowledge, so it
// is testable with any structure and any (injected) loop deps.
export async function runBackHalfSizing(
  input: { market: MarketRef; structure: ProposedStructure },
  deps: LoopDeps = {},
  opts: { pinned?: boolean } = {},
): Promise<SizingRunResult> {
  const { market, structure } = input;
  const slots = deriveResearchSlots(market, structure);

  const views: ResolvedSlotView[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  // Sequential, isolated, per-slot. Each call is its own researcher + CRAAP pair;
  // nothing is shared between slots beyond what code passes here.
  for (const slot of slots) {
    const result = await resolveSlotWithRetry(slot, deps);
    usage.inputTokens += result.totalUsage.inputTokens;
    usage.outputTokens += result.totalUsage.outputTokens;
    views.push(viewSlot(slot, result));
  }

  // Credibility = mean of the per-slot CRAAP blended scores over RESOLVED, sourced
  // slots only (assumptions excluded). Arithmetic in code (Principle 5).
  const resolvedScores = views
    .filter((v) => v.resolved && v.craapScore !== null)
    .map((v) => v.craapScore as number);
  const credibilityScore =
    resolvedScores.length > 0
      ? resolvedScores.reduce((a, b) => a + b, 0) / resolvedScores.length
      : null;

  // Completeness: EVERY derived slot must have yielded a usable number.
  const incompleteReasons = views
    .filter((v) => !v.resolved)
    .map((v) => `${v.kind}${v.filterIndex !== null ? `[${v.filterIndex}]` : ""}: ${v.unresolvedReason}`);
  const complete = incompleteReasons.length === 0;

  // Assemble the waterfall ONLY when complete. A missing number never gets zeroed.
  let sizing: SizingResult | null = null;
  let sizingInputs: SizingInput | null = null;
  if (complete) {
    const anchorView = views.find((v) => v.kind === "anchor");
    const priceView = views.find((v) => v.kind === "price");
    const filterViews = views
      .filter((v) => v.kind === "filter")
      .sort((a, b) => (a.filterIndex ?? 0) - (b.filterIndex ?? 0));

    // Guarded by `complete`, but assert the shape so a future change can't slip a
    // null through into the math.
    if (
      !anchorView ||
      anchorView.rawValue === null ||
      !priceView ||
      priceView.rawValue === null ||
      filterViews.some((f) => f.normalizedRate === null)
    ) {
      throw new Error(
        "Internal: marked complete but an anchor/filter/price value was null — refusing to size.",
      );
    }

    sizingInputs = {
      anchor: anchorView.rawValue,
      filters: filterViews.map((f) => f.normalizedRate as number),
      unitPrice: priceView.rawValue,
      replacementRate: REPLACEMENT_RATE_ASSUMPTION.value,
    };
    sizing = sizeUnitsBased(sizingInputs);
  }

  return {
    ok: true,
    market,
    pinned: opts.pinned ?? false,
    complete,
    incompleteReasons,
    slots: views,
    sizing,
    sizingInputs,
    assumptions: [REPLACEMENT_RATE_ASSUMPTION],
    credibility: {
      score: credibilityScore,
      basis: complete
        ? "mean of per-slot CRAAP weightedTotal across all resolved, sourced slots (assumptions excluded)"
        : "PARTIAL — mean over resolved slots only; run is INCOMPLETE so this is not a whole-model score",
    },
    usage,
  };
}

// The pin-gated entry for this slice. Requires PIN_STRUCTURE on (the proposer
// front-half is not wired yet), loads the validated Germany structure, and runs
// the back half. Injected deps let the deterministic dry-run drive it with fakes.
export async function runPinnedGermanySizing(
  deps: LoopDeps = {},
): Promise<SizingRunResult> {
  if (!isStructurePinned()) {
    throw new Error(
      "runPinnedGermanySizing requires PIN_STRUCTURE to be set — the proposer front-half is not wired this slice, so the structure must come from the pin.",
    );
  }
  const { market, structure } = loadPinnedStructure();
  return runBackHalfSizing({ market, structure }, deps, { pinned: true });
}
