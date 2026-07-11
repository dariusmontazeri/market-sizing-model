// Batched back-half sizing (V6.17.4) — the bulk/non-interactive entry point.
//
// Composition, not duplication: this module PRECOMPUTES the common case in two
// batched waves (all first-attempt researcher calls, then all their CRAAP
// gradings — 50% token price, one queue submission instead of a sequential
// drip), then runs the UNCHANGED sequential pipeline with replay deps that
// hand each slot its precomputed first attempt. Every routing decision —
// cache replay, dead-end seam, threshold gate, tier descent, keep-best,
// escalation — still happens in researchLoop.ts, single-sourced. Only slots
// whose precomputed first attempt fails the gate escalate to live sequential
// calls (tier 2+), exactly as if the first attempt had run inline.
//
// Isolation (Principle 7) holds: each batch item is its own isolated request
// with its own context. Batching changes WHERE the calls queue, never what
// any component sees.
import crypto from "node:crypto";
import {
  deriveResearchSlots,
  finalizeResearcherResult,
  researchSlot,
  slotCallOptions,
  type MarketRef,
  type ResearcherCallResult,
  type ResearchSlot,
  type SearchFn,
} from "./researcher";
import {
  craapCallOptions,
  finalizeCraapResult,
  validateSkeleton,
  type CraapValidationResult,
  type SlotDefinition,
} from "./craapValidator";
import { MAX_SEARCHES_FIRST, type ValidateFn } from "./researchLoop";
import { runStructuredBatch, type BatchClientLike } from "./batchRunner";
import { runBackHalfSizing, type SizingRunResult } from "./orchestrator";
import { cacheGet, slotCacheKey } from "./researchCache";
import { isStructurePinned, loadPinnedStructure } from "./structurePin";
import type { ProposedStructure } from "./structureProposer";

export type BatchSizingConfig = {
  client?: BatchClientLike;
  pollIntervalMs?: number;
  sleeper?: (ms: number) => Promise<void>;
  // Live fallbacks for escalations / batch-failed items — injectable so the
  // whole flow is deterministically testable offline. Default: the real calls.
  liveSearchFn?: SearchFn;
  liveValidateFn?: ValidateFn;
};

// CRAAP replay is keyed by the slot definition the loop hands validateFn —
// built from the same fields on both sides so the key always matches. HASHED,
// not raw JSON: the key doubles as the Batches API custom_id, which the API
// caps at 64 characters (a live-run finding the offline fake now enforces too).
function slotDefKey(def: SlotDefinition): string {
  const material = JSON.stringify({
    geography: def.geography,
    metric: def.metric,
    definition: def.definition,
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export async function runBackHalfSizingBatched(
  input: { market: MarketRef; structure: ProposedStructure },
  cfg: BatchSizingConfig = {},
  opts: { pinned?: boolean } = {},
): Promise<SizingRunResult> {
  const liveSearch = cfg.liveSearchFn ?? researchSlot;
  const liveValidate = cfg.liveValidateFn ?? validateSkeleton;
  const batchCfg = {
    client: cfg.client,
    pollIntervalMs: cfg.pollIntervalMs,
    sleeper: cfg.sleeper,
  };

  const slots = deriveResearchSlots(input.market, input.structure);

  // Cache-aware: slots the cache will replay are excluded from the batch —
  // no reason to pay (even half price) for a slot the loop won't research.
  const toResearch = slots.filter((slot) => cacheGet(slot) === null);

  // Wave R — all first-attempt researcher calls, batched. Identical requests
  // to the sequential loop's first attempt (tier 1, cheap search ceiling).
  const researcherOut = await runStructuredBatch(
    toResearch.map((slot) => ({
      id: slotCacheKey(slot),
      opts: slotCallOptions(slot, {
        tier: 1,
        attempt: 1,
        avoidPublishers: [],
        maxSearches: MAX_SEARCHES_FIRST,
      }),
    })),
    batchCfg,
  );

  const preSearch = new Map<string, ResearcherCallResult>();
  for (const slot of toResearch) {
    const item = researcherOut.get(slotCacheKey(slot));
    if (item?.ok) preSearch.set(slotCacheKey(slot), finalizeResearcherResult(item.result));
    // A batch-failed item simply has no precomputed attempt: the loop's
    // searchFn falls through to the live path for that slot (fail-open to
    // the sequential behavior, never a lost slot).
  }

  // Wave C — CRAAP gradings for every precomputed skeleton that will reach
  // CRAAP (a dead_end never does: the loop stops before scoring — mirror that
  // here so no grading is bought for a slot the loop won't score).
  const craapItems: { id: string; opts: ReturnType<typeof craapCallOptions> }[] = [];
  for (const slot of toResearch) {
    const pre = preSearch.get(slotCacheKey(slot));
    if (!pre || pre.skeleton.resolution_status === "dead_end") continue;
    const def: SlotDefinition = {
      geography: slot.geography,
      metric: slot.metric,
      definition: slot.definition,
    };
    craapItems.push({ id: slotDefKey(def), opts: craapCallOptions(def, pre.skeleton) });
  }
  const craapOut = await runStructuredBatch(craapItems, batchCfg);

  const preCraap = new Map<string, CraapValidationResult>();
  for (const { id } of craapItems) {
    const item = craapOut.get(id);
    if (item?.ok) {
      preCraap.set(id, finalizeCraapResult(item.result.value, item.result.model, item.result.usage));
    }
  }

  // Replay deps: each slot's FIRST search/grading consumes its precomputed
  // result; every subsequent call (backoff retries, escalated attempts,
  // batch-failed items) goes live. The loop cannot tell the difference.
  const searchConsumed = new Set<string>();
  const craapConsumed = new Set<string>();

  const searchFn: SearchFn = async (slot, sOpts) => {
    const key = slotCacheKey(slot);
    const pre = preSearch.get(key);
    if (pre && !searchConsumed.has(key)) {
      searchConsumed.add(key);
      return pre;
    }
    return liveSearch(slot, sOpts);
  };

  const validateFn: ValidateFn = async (def, skeleton) => {
    const key = slotDefKey(def);
    const pre = preCraap.get(key);
    if (pre && !craapConsumed.has(key)) {
      craapConsumed.add(key);
      return pre;
    }
    return liveValidate(def, skeleton);
  };

  return runBackHalfSizing(input, { searchFn, validateFn }, opts);
}

// Pin-gated batched dev entry — the bulk counterpart of runPinnedGermanySizing.
export async function runPinnedGermanySizingBatched(
  cfg: BatchSizingConfig = {},
): Promise<SizingRunResult> {
  if (!isStructurePinned()) {
    throw new Error(
      "runPinnedGermanySizingBatched requires PIN_STRUCTURE to be set — the proposer front-half is not wired, so the structure must come from the pin.",
    );
  }
  const { market, structure } = loadPinnedStructure();
  return runBackHalfSizingBatched({ market, structure }, cfg, { pinned: true });
}
