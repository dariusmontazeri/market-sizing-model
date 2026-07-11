// Deterministic, OFFLINE proof of the batched back-half (V6.17.4). Zero API
// calls: the Batches API is a fake that scripts per-item behavior, and the
// live fallbacks are counting fakes. Proves, in one run each, that the batch
// path replicates the sequential semantics exactly:
//   - wave continuation: a pause_turn item is resubmitted with its assistant
//     turn appended (same attempt);
//   - wave retry: an empty-turn item is resubmitted with DOUBLED max_tokens;
//   - escalation handoff: a slot whose batched CRAAP is sub-threshold
//     escalates through the UNCHANGED loop to the live path (tier 2);
//   - dead-end mirror: a dead_end skeleton is never CRAAP-graded and routes to
//     the assumption seam (run INCOMPLETE, no zero-fill);
//   - cache awareness: a cached slot is excluded from the batch entirely.
//
// Run: npx tsx scripts/test-batch-sizing.ts   (no env / no API key needed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { runPinnedGermanySizingBatched } from "../lib/batchSizing";
import { deriveResearchSlots, slotCallOptions, type ResearcherCallResult, type ResearchSlot, type SearchFn } from "../lib/researcher";
import type { ValidateFn } from "../lib/researchLoop";
import { loadPinnedStructure } from "../lib/structurePin";
import { slotCacheKey, cacheSet } from "../lib/researchCache";
import { CRAAP_WEIGHTS, type CraapValidationResult } from "../lib/craapValidator";
import type { BatchClientLike } from "../lib/batchRunner";

let failures = 0;
function check(label: string, cond: boolean, actual?: unknown) {
  const tag = cond ? "PASS" : "FAIL";
  const suffix = actual === undefined ? "" : `  (actual: ${JSON.stringify(actual)})`;
  console.log(`  [${tag}] ${label}${suffix}`);
  if (!cond) failures++;
}

// --- fakes -----------------------------------------------------------------

function fakeMessage(opts: { text?: string | null; stopReason?: string; extraBlocks?: unknown[] }): Anthropic.Message {
  const content: unknown[] = [...(opts.extraBlocks ?? [])];
  if (opts.text !== null && opts.text !== undefined) content.push({ type: "text", text: opts.text });
  return {
    id: "msg_fake", type: "message", role: "assistant", model: "fake-model",
    content, stop_reason: opts.stopReason ?? "end_turn", stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  } as unknown as Anthropic.Message;
}

function skeletonJson(value: number | null, extra?: Partial<Record<string, unknown>>): string {
  return JSON.stringify({
    search_query: "fake", value, units: value !== null && value <= 1 ? "proportion" : "units",
    date: "2025", author_publisher: value === null ? null : "Fake Statistics Office",
    source_url: value === null ? null : "https://stats.example/fake",
    geography: "Germany", population_segment: "all", metric_definition: "fake",
    resolution_status: "found", resolution_reason: "sourced", ...extra,
  });
}

function craapJson(score: number): string {
  const dim = { score, reasoning: "fake" };
  return JSON.stringify({
    authority: dim, currency: dim, accuracy: dim,
    relevance: { geography_match: dim, population_match: dim, metric_match: dim },
    purpose: { gate: "pass", reasoning: "fake" },
  });
}

function liveCraap(total: number): CraapValidationResult {
  const dim = (s: number) => ({ score: s, reasoning: "live-fake" });
  return {
    ok: true,
    dimensions: {
      authority: dim(total), currency: dim(total), accuracy: dim(total),
      relevance: { geography_match: dim(total), population_match: dim(total), metric_match: dim(total) },
      purpose: { gate: "pass", reasoning: "live-fake" },
    },
    relevanceScore: total, weights: CRAAP_WEIGHTS, weightedTotal: total,
    purpose: { gate: "pass", reasoning: "live-fake" },
    model: "live-fake", usage: { inputTokens: 5, outputTokens: 5 },
  };
}

function liveFound(value: number): ResearcherCallResult {
  return {
    skeleton: JSON.parse(skeletonJson(value)) as ResearcherCallResult["skeleton"],
    model: "live-fake", usage: { inputTokens: 10, outputTokens: 5 },
    searchErrorCodes: [], rateLimitBlocked: false,
  };
}

type Handler = (customId: string, params: Anthropic.MessageCreateParamsNonStreaming, callNo: number) => Anthropic.Message;

function fakeBatchClient(handler: Handler) {
  const submissions: { custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }[][] = [];
  const stored = new Map<string, { custom_id: string; result: { type: "succeeded"; message: Anthropic.Message } }[]>();
  const perItemCalls = new Map<string, number>();
  let n = 0;
  const client: BatchClientLike = {
    messages: {
      batches: {
        create: async (body) => {
          // Mirror the real API's constraint (found live): custom_id <= 64 chars.
          for (const r of body.requests) {
            if (r.custom_id.length > 64) {
              throw new Error(`custom_id: String should have at most 64 characters (got ${r.custom_id.length})`);
            }
          }
          submissions.push(body.requests);
          const id = `batch_${n++}`;
          stored.set(
            id,
            body.requests.map((r) => {
              const calls = (perItemCalls.get(r.custom_id) ?? 0) + 1;
              perItemCalls.set(r.custom_id, calls);
              return { custom_id: r.custom_id, result: { type: "succeeded" as const, message: handler(r.custom_id, r.params, calls) } };
            }),
          );
          return { id };
        },
        retrieve: async () => ({ processing_status: "ended" }),
        results: async (id) => (async function* () { for (const e of stored.get(id) ?? []) yield e; })(),
      },
    },
  };
  return { client, submissions };
}

const isResearcherParams = (p: Anthropic.MessageCreateParamsNonStreaming) => Array.isArray((p as { tools?: unknown[] }).tools);
const userText = (p: Anthropic.MessageCreateParamsNonStreaming) => String(p.messages[0]?.content ?? "");

// --- cases -------------------------------------------------------------------

async function caseFull() {
  console.log("\n=== Case 1: continuation + retry + escalation + dead-end, one batched run ===");
  process.env.PIN_STRUCTURE = "germany";
  delete process.env.RESEARCH_CACHE;

  const { market, structure } = loadPinnedStructure();
  const slots = deriveResearchSlots(market, structure);
  const key = (s: ResearchSlot) => slotCacheKey(s);
  const anchorKey = key(slots.find((s) => s.kind === "anchor")!);
  const f0Key = key(slots.find((s) => s.filterIndex === 0)!);
  const f1Key = key(slots.find((s) => s.filterIndex === 1)!);
  const priceKey = key(slots.find((s) => s.kind === "price")!);

  const doubledSeen: number[] = [];
  const handler: Handler = (id, params, callNo) => {
    if (isResearcherParams(params)) {
      if (id === anchorKey) {
        // pause_turn on the first wave; the skeleton lands on the continuation.
        if (callNo === 1) return fakeMessage({ text: null, stopReason: "pause_turn", extraBlocks: [{ type: "server_tool_use", id: "srv1", name: "web_search", input: {} }] });
        return fakeMessage({ text: skeletonJson(6000) });
      }
      if (id === f0Key) {
        // empty turn first, recovers on the doubled-budget retry.
        if (callNo === 1) return fakeMessage({ text: null });
        doubledSeen.push(params.max_tokens);
        return fakeMessage({ text: skeletonJson(0.6) });
      }
      if (id === f1Key) return fakeMessage({ text: skeletonJson(0.5) });
      if (id === priceKey) return fakeMessage({ text: skeletonJson(null, { value: null, resolution_status: "dead_end", resolution_reason: "not published (fake)" }) });
    }
    // CRAAP items: grade by which slot's metric appears in the user content.
    // Order matters: filter[1]'s denominator text embeds filter[0]'s label,
    // so test the more specific "fitting rate" pattern first.
    const u = userText(params);
    if (/fitting rate/i.test(u)) return fakeMessage({ text: craapJson(0.5) }); // sub-threshold -> escalate
    if (/Major-limb/.test(u)) return fakeMessage({ text: craapJson(0.9) });
    return fakeMessage({ text: craapJson(0.85) }); // anchor
  };

  const { client, submissions } = fakeBatchClient(handler);
  let liveSearches = 0;
  let liveValidations = 0;
  const liveSearchFn: SearchFn = async () => { liveSearches++; return liveFound(0.55); };
  const liveValidateFn: ValidateFn = async () => { liveValidations++; return liveCraap(0.92); };
  // Ladder fakes (V6.18): the dead-end price descends the ladder LIVE — the
  // proxy rung dead-ends too, the assumption rung yields a flagged 3000 EUR.
  let proxyCalls = 0;
  let assumptionCalls = 0;
  const liveProxySearchFn = async () => {
    proxyCalls++;
    return {
      skeleton: {
        ...(JSON.parse(skeletonJson(null, { value: null, resolution_status: "dead_end", resolution_reason: "no comparable geography publishes this (fake)" })) as ResearcherCallResult["skeleton"]),
        proxy_justification: "n/a",
      },
      model: "fake",
      usage: { inputTokens: 0, outputTokens: 0 },
      searchErrorCodes: [],
      rateLimitBlocked: false,
    };
  };
  const liveAssumptionFn = async () => {
    assumptionCalls++;
    return {
      assumption: { value: 3000, units: "EUR", reasoning: "fake first-principles price estimate" },
      model: "fake",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  };

  const r = await runPinnedGermanySizingBatched({ client, sleeper: async () => {}, liveSearchFn, liveValidateFn, liveProxySearchFn, liveAssumptionFn });

  check("3 batch submissions (R wave 1, R wave 2, CRAAP wave)", submissions.length === 3, submissions.length);
  check("R wave 1 batched all 4 slots", submissions[0].length === 4, submissions[0].length);
  check("R wave 2 = continuation + retry only", submissions[1].length === 2, submissions[1].map((x) => x.custom_id));
  const contItem = submissions[1].find((x) => x.custom_id === anchorKey);
  check("continuation resubmits with assistant turn appended", contItem?.params.messages.length === 2 && contItem?.params.messages[1].role === "assistant", contItem?.params.messages.length);
  const researcherBase = slotCallOptions(slots[0]).maxTokens;
  check("empty-turn retry doubled max_tokens", doubledSeen[0] === researcherBase * 2, { seen: doubledSeen[0], base: researcherBase });
  check("CRAAP wave excludes the dead-end slot (3 gradings)", submissions[2].length === 3, submissions[2].length);

  const f1 = r.slots.find((s) => s.filterIndex === 1);
  check("sub-threshold slot escalated to live (1 search, 1 validation)", liveSearches === 1 && liveValidations === 1, { liveSearches, liveValidations });
  check("escalated slot resolved with the LIVE value", f1?.resolved === true && f1?.rawValue === 0.55 && f1?.craapScore === 0.92, { raw: f1?.rawValue, craap: f1?.craapScore });
  check("anchor resolved from batch (continuation path)", r.slots.find((s) => s.kind === "anchor")?.rawValue === 6000, r.slots.find((s) => s.kind === "anchor")?.rawValue);
  check("filter[0] resolved from batch (retry path)", r.slots.find((s) => s.filterIndex === 0)?.rawValue === 0.6, r.slots.find((s) => s.filterIndex === 0)?.rawValue);
  const price = r.slots.find((s) => s.kind === "price");
  check("dead-end price descended the ladder LIVE (1 proxy try, 1 assumption)", proxyCalls === 1 && assumptionCalls === 1, { proxyCalls, assumptionCalls });
  check("price resolved via assumption (3000, flagged)", price?.outcome === "resolved_assumption" && price?.resolution === "assumption" && price?.rawValue === 3000, { outcome: price?.outcome, raw: price?.rawValue });
  check("run COMPLETE — the ladder never ends empty-handed", r.complete === true && r.sizing !== null, { complete: r.complete });
  check("price flagged in assumptions, excluded from credibility", r.assumptions.some((a) => a.field === "price" && a.value === 3000) && r.credibility.basis.includes("DIRECTLY SOURCED"), r.assumptions.map((a) => a.field));
}

async function caseCacheAware() {
  console.log("\n=== Case 2: cached slot excluded from the batch; clean run completes ===");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-sizing-cache-"));
  process.env.RESEARCH_CACHE = "1";
  process.env.RESEARCH_CACHE_DIR = tmpDir;
  process.env.PIN_STRUCTURE = "germany";

  const { market, structure } = loadPinnedStructure();
  const slots = deriveResearchSlots(market, structure);
  const anchorSlot = slots.find((s) => s.kind === "anchor")!;
  cacheSet(anchorSlot, {
    skeleton: JSON.parse(skeletonJson(7777)) as ResearcherCallResult["skeleton"],
    craap: liveCraap(0.95),
    researcherModel: "cached-fake",
  });

  const handler: Handler = (_id, params) => {
    if (isResearcherParams(params)) {
      const u = userText(params);
      if (/Major-limb/.test(u)) return fakeMessage({ text: skeletonJson(0.6) });
      if (/fitting rate/i.test(u)) return fakeMessage({ text: skeletonJson(0.3) });
      return fakeMessage({ text: skeletonJson(8000) }); // price
    }
    return fakeMessage({ text: craapJson(0.9) });
  };

  const { client, submissions } = fakeBatchClient(handler);
  let liveCalls = 0;
  const liveSearchFn: SearchFn = async () => { liveCalls++; return liveFound(1); };
  const liveValidateFn: ValidateFn = async () => { liveCalls++; return liveCraap(0.9); };

  const r = await runPinnedGermanySizingBatched({ client, sleeper: async () => {}, liveSearchFn, liveValidateFn });

  check("R wave batched only the 3 uncached slots", submissions[0].length === 3, submissions[0].length);
  check("anchor replayed from cache", r.slots.find((s) => s.kind === "anchor")?.fromCache === true && r.slots.find((s) => s.kind === "anchor")?.rawValue === 7777, r.slots.find((s) => s.kind === "anchor")?.rawValue);
  check("no live calls needed", liveCalls === 0, liveCalls);
  check("run COMPLETE with sizing computed", r.complete === true && r.sizing !== null, r.complete);

  delete process.env.RESEARCH_CACHE;
  delete process.env.RESEARCH_CACHE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function main() {
  console.log("Deterministic offline proof of the batched back-half (ZERO API calls)");
  await caseFull();
  await caseCacheAware();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
