// Researcher component — isolated server-side Claude call (CLAUDE.md: each
// component is ONE isolated API call; this module must never be imported by
// client code).
//
// Security boundary: ALL untrusted text — user free-text input and anything
// derived from it or from fetched web content — enters the prompt through
// wrapUntrusted() and nowhere else. Instructions live ONLY in the system
// prompt; the user message carries data.
import Anthropic from "@anthropic-ai/sdk";
import { loadInstruction } from "./instructions";
import {
  runStructuredCall,
  type StructuredCallOptions,
  type StructuredCallResult,
} from "./anthropic";
import { MODELS } from "./models";
// Type-only import: the researcher consumes the validated structure's shape.
// Types are erased at compile time, so this does NOT create a runtime cycle
// with structureProposer (which imports wrapUntrusted from here as a value).
import type {
  AnchorType,
  PriceBasis,
  ProposedStructure,
} from "./structureProposer";

const UNTRUSTED_CLOSE = "</untrusted_data>";

// Single entry point for all untrusted text. Strips any literal closing tag
// from the payload so hostile content cannot break out of the data block.
export function wrapUntrusted(text: string): string {
  const cleaned = text.split(UNTRUSTED_CLOSE).join("");
  return `<untrusted_data>\n${cleaned}\n${UNTRUSTED_CLOSE}`;
}

// The researcher's explicit verdict on whether a figure is obtainable. This is
// a MODEL judgment (Principle 5) — only the component reading the pages can tell
// "genuinely unpublished" from "I searched badly". Code must never infer it from
// null/empty patterns.
//   found    — a sourceable figure was located (value filled from a real source)
//   miss     — none found THIS attempt, but one may exist; retrying is sensible
//   dead_end — positively established that NO sourceable figure exists for this
//              slot (not collected / not published / confidential) → stop looking
export type ResolutionStatus = "found" | "miss" | "dead_end";
export const RESOLUTION_STATUSES: readonly ResolutionStatus[] = [
  "found",
  "miss",
  "dead_end",
];

export type AnchorSkeleton = {
  search_query: string;
  value: number | null;
  units: string | null;
  date: string | null;
  author_publisher: string | null;
  // URL of the source the figure came from — part of the source package handed
  // to CRAAP (helps authority/trace-back). Null if not available.
  source_url: string | null;
  geography: string | null;
  population_segment: string | null;
  metric_definition: string | null;
  // Researcher's resolution verdict (see ResolutionStatus) + a one-line reason.
  resolution_status: ResolutionStatus;
  resolution_reason: string;
};

// The extraction skeleton is slot-agnostic: an anchor figure, a filter rate,
// or a unit price all fill the same fields (value + units carry the meaning —
// e.g. units "%" for a rate, "EUR" for a price). Alias keeps call sites that
// resolve non-anchor slots readable without forking the schema.
export type ResearchSkeleton = AnchorSkeleton;

const SKELETON_KEYS: readonly (keyof AnchorSkeleton)[] = [
  "search_query",
  "value",
  "units",
  "date",
  "author_publisher",
  "source_url",
  "geography",
  "population_segment",
  "metric_definition",
  "resolution_status",
  "resolution_reason",
];

// Structured-outputs schema: every field required; "unknown" is an explicit
// null. additionalProperties:false is mandatory for the API.
const ANCHOR_SKELETON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...SKELETON_KEYS],
  properties: {
    search_query: {
      type: "string",
      description:
        "The web search query you would run for this slot, built per the query-construction rules.",
    },
    value: { anyOf: [{ type: "number" }, { type: "null" }] },
    units: { anyOf: [{ type: "string" }, { type: "null" }] },
    date: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Date or period the figure refers to, if known.",
    },
    author_publisher: { anyOf: [{ type: "string" }, { type: "null" }] },
    source_url: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "URL of the source the figure came from, if available.",
    },
    geography: { anyOf: [{ type: "string" }, { type: "null" }] },
    population_segment: { anyOf: [{ type: "string" }, { type: "null" }] },
    metric_definition: { anyOf: [{ type: "string" }, { type: "null" }] },
    resolution_status: {
      type: "string",
      enum: [...RESOLUTION_STATUSES],
      description:
        "Your verdict: 'found' (a sourceable figure located), 'miss' (none this time, may exist), or 'dead_end' (positively established no sourceable figure exists). Use dead_end ONLY with positive evidence of non-existence.",
    },
    resolution_reason: {
      type: "string",
      description:
        "One short sentence explaining the resolution_status (especially why a dead_end figure is genuinely unpublished).",
    },
  },
} as const;

// System prompt lives in instructions/researcher.md (planner is the source
// of truth); loaded once at module load.
const RESEARCHER_SYSTEM_PROMPT = loadInstruction("researcher.md");

export function isAnchorSkeleton(value: unknown): value is AnchorSkeleton {
  if (typeof value !== "object" || value === null) return false;
  if (!SKELETON_KEYS.every((key) => key in value)) return false;
  // The loop branches on resolution_status, so verify it (and its reason) —
  // an out-of-enum value must not be mistaken for, or hide, a dead_end.
  const v = value as Record<string, unknown>;
  return (
    RESOLUTION_STATUSES.includes(v.resolution_status as ResolutionStatus) &&
    typeof v.resolution_reason === "string"
  );
}

export type ResearcherCallResult = {
  skeleton: ResearchSkeleton;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  // All web_search tool error codes seen in this call (diagnostic).
  searchErrorCodes: string[];
  // A transient web_search rate-limit/unavailability was hit (the SEARCH was
  // blocked — this is NOT a source-quality signal). The caller decides whether
  // that means "no source obtained" (see searchSlotWithBackoff).
  rateLimitBlocked: boolean;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// web_search error codes that mean the SEARCH was transiently blocked (the
// source was never evaluated), so the right response is wait-and-retry the SAME
// search — never a tier descent. Other codes (e.g. query_too_long) are real
// search problems and flow through to CRAAP as before.
const SEARCH_RATELIMIT_CODES = ["too_many_requests", "unavailable"] as const;

// Scan the model's content (across all turns of one call) for web_search tool
// results that came back as errors, returning their codes.
function collectSearchErrorCodes(content: Anthropic.ContentBlock[]): string[] {
  const codes: string[] = [];
  for (const block of content) {
    if (block.type === "web_search_tool_result") {
      const c = block.content;
      if (!Array.isArray(c) && c.type === "web_search_tool_result_error") {
        codes.push(c.error_code);
      }
    }
  }
  return codes;
}

// Per-call web_search ceiling. The research loop sets this per attempt (a cheaper
// first attempt, a richer escalated one); callers that pass nothing get the full
// budget. FLOORED at 3 — trace-back to a primary publisher is search-hungry and 3
// is the validated minimum, so the ceiling never drops below it.
const MIN_SEARCHES = 3;
const DEFAULT_MAX_SEARCHES = 5;

// Output budget per researcher call. Adaptive thinking counts against
// max_tokens, so this is sized with headroom for a long think plus the full
// skeleton JSON (the shared plumbing doubles it once on a reliability retry).
const RESEARCHER_MAX_TOKENS = 8192;

// Turn a completed structured call into the researcher's result shape (the
// search-error scan lives here). Exported so the batch path finalizes its
// results identically to the sync path.
export function finalizeResearcherResult(
  r: StructuredCallResult<AnchorSkeleton>,
): ResearcherCallResult {
  const searchErrorCodes = collectSearchErrorCodes(r.content);
  const rateLimitBlocked = searchErrorCodes.some((code) =>
    (SEARCH_RATELIMIT_CODES as readonly string[]).includes(code),
  );
  return {
    skeleton: r.value,
    model: r.model,
    usage: r.usage,
    searchErrorCodes,
    rateLimitBlocked,
  };
}

// ---------------------------------------------------------------------------
// Resolve the slots of a VALIDATED structure.
//
// Isolation (Principle 7): the researcher receives only the validated structure
// as DATA. It never sees the structural validator's reasoning or the CRAAP
// validator's scoring, and the slots do not share a conversation — each is a
// fresh, independent call.

export type MarketRef = { country: string; market: string };

export type ResearchSlotKind = "anchor" | "filter" | "price";

export type ResearchSlot = {
  kind: ResearchSlotKind;
  // Filter position (0-based) in the structure's filter chain; null otherwise.
  filterIndex: number | null;
  geography: string;
  metric: string;
  definition: string;
};

const ANCHOR_TYPE_LABEL: Record<AnchorType, string> = {
  population: "population (a standing count of who is in this state)",
  event_count: "count of qualifying events per year",
  installed_base: "installed base (the existing deployed stock)",
};

const PRICE_BASIS_LABEL: Record<PriceBasis, string> = {
  per_device: "per device supplied",
  per_procedure: "per procedure performed",
  per_unit_sold: "per unit sold",
};

// Turn a validated structure into the ordered list of research slots, in code
// (deterministic): the anchor first, then one rate per filter in the structure's
// own order, then the unit price. Each slot is self-contained so it can be
// researched in isolation.
export function deriveResearchSlots(
  market: MarketRef,
  structure: ProposedStructure,
): ResearchSlot[] {
  const geo = market.country;
  const anchorLabel = ANCHOR_TYPE_LABEL[structure.anchor_type.type];
  const slots: ResearchSlot[] = [];

  // Anchor — the broad figure BEFORE any narrowing filter. Atomic for v1: a
  // single sourced figure. (Composed/derived-precision anchor construction —
  // sourcing two sub-figures and combining them — is a deferred later facet,
  // intentionally NOT built here.)
  slots.push({
    kind: "anchor",
    filterIndex: null,
    geography: geo,
    metric: `Annual ${anchorLabel} that the market "${market.market}" descends from, before any narrowing filter`,
    definition:
      `The broad anchor figure for "${market.market}" in ${geo}, measured as the ${anchorLabel}. ` +
      `This is the starting figure BEFORE these narrowing cuts are applied (do NOT pre-apply them): ` +
      `${structure.distinctions.map((d) => d.characteristic).join("; ")}. ` +
      `For reference only, the fully narrowed target — which is NOT what this slot wants — is: ${structure.addressable_unit}`,
  });

  // Filters — one rate per filter, in the chain's order. Each slot states its
  // DENOMINATOR explicitly — the population surviving the PREVIOUS cut — so
  // the researcher matches rates to the right base and CRAAP's metric_match
  // can test denominator-match, not just subject-match (V6.16.5: a real,
  // correctly-quoted figure over the wrong base answers a different question).
  structure.filters.forEach((filter, i) => {
    const distinction = structure.distinctions.find(
      (d) => d.characteristic === filter.distinction_ref,
    );
    const denominator =
      i === 0
        ? `the FULL anchor population (the annual ${anchorLabel}), before any narrowing cut`
        : `ONLY the population that already passed the previous cut "${structure.filters[i - 1].label}" — not the full anchor, and not any other subset`;
    slots.push({
      kind: "filter",
      filterIndex: i,
      geography: geo,
      metric: `Rate kept by the narrowing cut "${filter.label}" in ${geo}`,
      definition:
        `Express as a proportion or percentage: of the figure entering this cut, the share that passes "${filter.label}". ` +
        `The rate's DENOMINATOR must be ${denominator}. A rate expressed over a different base does not fit this slot. ` +
        (distinction
          ? `The cut implements the distinction "${distinction.characteristic}" — ${distinction.why_it_narrows}`
          : `The cut references the distinction "${filter.distinction_ref}".`),
    });
  });

  // Price — the unit price on the structure's price basis.
  slots.push({
    kind: "price",
    filterIndex: null,
    geography: geo,
    metric: `Average price ${PRICE_BASIS_LABEL[structure.price_basis.basis]} for "${market.market}" in ${geo}`,
    definition: `The average unit price, measured ${PRICE_BASIS_LABEL[structure.price_basis.basis]}, for: ${structure.addressable_unit}`,
  });

  return slots;
}

// Source-quality tiers for tier descent. Lightweight descriptors, not a source
// whitelist — the full tier list (shared with CRAAP's Authority rubric) is a
// separate prep task and is deferred.
export type TierTarget = 1 | 2 | 3;

const TIER_DIRECTIVE: Record<TierTarget, string> = {
  1: "Tier 1 — official statistics offices and government agencies, peer-reviewed literature, and the primary publisher of the figure.",
  2: "Tier 2 — established market-research / industry reports, professional and trade bodies, and reputable secondary sources.",
  3: "Tier 3 — any credible published source, including reputable press. Avoid promotional, sales, or lead-generation pages where a credible alternative exists.",
};

// Resolve ONE slot via an isolated researcher call. The slot is derived from the
// proposer's output (which carries user-typed and web-influenced text), so it
// enters the prompt as untrusted DATA through the existing wrapUntrusted
// boundary — the instruction stays outside the block, exactly as the proposer
// does it. The researcher's injection posture is unchanged.
//
// The tier directive and the avoid-list are CODE-orchestrated (trusted), so they
// sit OUTSIDE the untrusted block alongside the task instruction.
export type ResearchSlotCallOpts = {
  tier?: TierTarget;
  attempt?: number;
  avoidPublishers?: string[];
  maxSearches?: number;
};

// Build the full structured-call options for one slot — the single place a
// researcher request is constructed. The sync path (researchSlot) and the
// batch path (lib/batchSizing.ts) both use this, so batched requests are
// byte-identical to sequential ones.
export function slotCallOptions(
  slot: ResearchSlot,
  opts?: ResearchSlotCallOpts,
): StructuredCallOptions<AnchorSkeleton> {
  const lines = [
    "Fill the extraction skeleton for the research slot described in the data block.",
    "Build your search query per the rules and extract exactly one sourced figure for this slot.",
  ];
  if (opts?.tier) {
    const attemptNote = opts.attempt ? ` (attempt ${opts.attempt})` : "";
    lines.push(
      `Source-quality target for this attempt${attemptNote}: ${TIER_DIRECTIVE[opts.tier]} Prefer the most authoritative source available at this tier.`,
    );
  }
  if (opts?.avoidPublishers && opts.avoidPublishers.length > 0) {
    lines.push(
      `Do NOT reuse these already-rejected sources — find a different, more suitable one: ${opts.avoidPublishers.join("; ")}.`,
    );
  }
  const userContent =
    lines.join("\n") +
    "\n" +
    wrapUntrusted(
      `Slot kind: ${slot.kind}\nGeography: ${slot.geography}\nMetric: ${slot.metric}\nSlot definition: ${slot.definition}`,
    );
  const maxSearches = Math.max(
    MIN_SEARCHES,
    opts?.maxSearches ?? DEFAULT_MAX_SEARCHES,
  );
  return {
    label: "researcher",
    model: MODELS.researcher,
    system: RESEARCHER_SYSTEM_PROMPT,
    userContent,
    schema: ANCHOR_SKELETON_SCHEMA as unknown as Record<string, unknown>,
    guard: isAnchorSkeleton,
    maxTokens: RESEARCHER_MAX_TOKENS,
    // Server-side web search; max_uses bounds cost per call (attempt-dependent,
    // floored at MIN_SEARCHES).
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: maxSearches },
    ],
  };
}

export async function researchSlot(
  slot: ResearchSlot,
  opts?: ResearchSlotCallOpts,
): Promise<ResearcherCallResult> {
  return finalizeResearcherResult(
    await runStructuredCall(slotCallOptions(slot, opts)),
  );
}

// ---------------------------------------------------------------------------
// Resolution ladder rung 2 — DECLARED GEOGRAPHY PROXY (V6.18).
//
// When the direct figure cannot be sourced (failed threshold or dead end), the
// ladder's next rung researches the SAME metric for the most comparable OTHER
// geography, declared openly. Same researcher, same skeleton, one extra
// REQUIRED field: proxy_justification (which geography and why comparable).
// The skeleton's own `geography` field carries the proxy geography.

export type ProxySkeleton = AnchorSkeleton & { proxy_justification: string };

const PROXY_SKELETON_SCHEMA = {
  ...ANCHOR_SKELETON_SCHEMA,
  required: [...SKELETON_KEYS, "proxy_justification"],
  properties: {
    ...ANCHOR_SKELETON_SCHEMA.properties,
    proxy_justification: {
      type: "string",
      description:
        "Which geography you used as the proxy and WHY it is comparable to the slot's original geography for this specific metric.",
    },
  },
} as const;

export function isProxySkeleton(value: unknown): value is ProxySkeleton {
  return (
    isAnchorSkeleton(value) &&
    typeof (value as Record<string, unknown>).proxy_justification === "string"
  );
}

export type ProxyCallResult = ResearcherCallResult & {
  skeleton: ProxySkeleton;
};

export function proxySlotCallOptions(
  slot: ResearchSlot,
  opts?: ResearchSlotCallOpts,
): StructuredCallOptions<ProxySkeleton> {
  const lines = [
    `The direct figure for this slot could NOT be sourced for ${slot.geography} (no source of acceptable quality exists or was findable).`,
    "This attempt is a DECLARED GEOGRAPHY PROXY: find the SAME metric, with the same definition and the same denominator requirements, for the most comparable OTHER geography you can source it for.",
    "Pick the proxy geography for structural similarity to the original on the dimensions that drive THIS metric (e.g. health-system organization, income level, demographics, market maturity — whichever apply).",
    "Report the figure AS PUBLISHED for the proxy geography — do NOT scale or adjust it toward the original geography. Fill the skeleton's geography field with the proxy geography, and explain the choice in proxy_justification.",
    "TRANSFERABILITY LIMIT: rates, shares, and prices can transfer between comparable geographies; ABSOLUTE COUNTS cannot (a smaller country's raw count says nothing about the original geography). If this slot asks for an absolute count, only use a proxy whose figure can honestly fill the slot in a population-independent form matching the slot definition; if only raw foreign counts exist, return resolution_status dead_end for this proxy attempt instead.",
    "All other rules (trace-back, name/link agreement, denominator, representativeness) apply unchanged.",
  ];
  if (opts?.avoidPublishers && opts.avoidPublishers.length > 0) {
    lines.push(
      `Do NOT reuse these already-rejected sources: ${opts.avoidPublishers.join("; ")}.`,
    );
  }
  const userContent =
    lines.join("\n") +
    "\n" +
    wrapUntrusted(
      `Slot kind: ${slot.kind}\nOriginal geography: ${slot.geography}\nMetric: ${slot.metric}\nSlot definition: ${slot.definition}`,
    );
  const maxSearches = Math.max(
    MIN_SEARCHES,
    opts?.maxSearches ?? DEFAULT_MAX_SEARCHES,
  );
  return {
    label: "researcher (geography proxy)",
    model: MODELS.researcher,
    system: RESEARCHER_SYSTEM_PROMPT,
    userContent,
    schema: PROXY_SKELETON_SCHEMA as unknown as Record<string, unknown>,
    guard: isProxySkeleton,
    maxTokens: RESEARCHER_MAX_TOKENS,
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: maxSearches },
    ],
  };
}

export async function researchSlotProxy(
  slot: ResearchSlot,
  opts?: ResearchSlotCallOpts,
): Promise<ProxyCallResult> {
  const r = await runStructuredCall(proxySlotCallOptions(slot, opts));
  return { ...finalizeResearcherResult(r), skeleton: r.value };
}

// ---------------------------------------------------------------------------
// Resolution ladder rung 3 — REASONED ASSUMPTION (V6.18).
//
// The final rung: no web access, one isolated call that constructs a
// transparent, conservative estimate from first principles ("its own
// thinking"). It ALWAYS yields a value — this is the reason the ladder never
// ends empty-handed — and the value is flagged as an explicit assumption,
// excluded from the credibility score.

export type AssumptionOutput = {
  value: number;
  units: string;
  reasoning: string;
};

const ASSUMPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["value", "units", "reasoning"],
  properties: {
    value: {
      type: "number",
      description: "Your reasoned estimate for the slot's quantity, in the slot's own terms.",
    },
    units: {
      type: "string",
      description: "Units of the estimate (e.g. 'percent', 'EUR', 'events per year') — consistent with the slot definition.",
    },
    reasoning: {
      type: "string",
      description:
        "The full logic chain: reference points used, structural bounds, why this magnitude, where you chose the conservative end, and an honest statement of the estimate's weakness.",
    },
  },
} as const;

function isAssumptionOutput(value: unknown): value is AssumptionOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.value === "number" &&
    Number.isFinite(v.value) &&
    typeof v.units === "string" &&
    typeof v.reasoning === "string"
  );
}

const ASSUMPTION_SYSTEM_PROMPT = loadInstruction("assumption.md");
const ASSUMPTION_MAX_TOKENS = 4096;

export type AssumptionCallResult = {
  assumption: AssumptionOutput;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

export function assumptionCallOptions(
  slot: ResearchSlot,
): StructuredCallOptions<AssumptionOutput> {
  const userContent =
    "Produce one reasoned, conservative assumption for the research slot described in the data block. Live research (direct and via a declared geography proxy) could not source this figure.\n" +
    wrapUntrusted(
      `Slot kind: ${slot.kind}\nGeography: ${slot.geography}\nMetric: ${slot.metric}\nSlot definition: ${slot.definition}`,
    );
  return {
    label: "assumption reasoner",
    model: MODELS.researcher,
    system: ASSUMPTION_SYSTEM_PROMPT,
    userContent,
    schema: ASSUMPTION_SCHEMA as unknown as Record<string, unknown>,
    guard: isAssumptionOutput,
    maxTokens: ASSUMPTION_MAX_TOKENS,
    // No tools: this rung is reasoning, not research.
  };
}

export async function reasonAssumption(
  slot: ResearchSlot,
): Promise<AssumptionCallResult> {
  const r = await runStructuredCall(assumptionCallOptions(slot));
  return { assumption: r.value, model: r.model, usage: r.usage };
}

// ---------------------------------------------------------------------------
// Spacing + backoff around a single tier's search (Research loop, Slice 2).
//
// The burst of back-to-back searches is what trips the web_search rate cap, so:
//  - SPACING: a fixed pause before EVERY search (the first try and every retry).
//  - BACKOFF: when a search comes back rate-limit-BLOCKED (the search never ran,
//    no source was evaluated), wait exponentially (2s, 4s, 8s) and retry the
//    SAME search at the SAME tier. A block is NOT a source-quality failure, so
//    it must never descend a tier or count as a CRAAP attempt.
// If the backoff budget is exhausted while still blocked, the search is reported
// as unavailable due to rate limit — distinct from a CRAAP failure.

const SEARCH_SPACING_MS = 2000;
const SEARCH_BACKOFF_MS = [2000, 4000, 8000] as const; // up to 3 backoff retries

// A "block" = a transient rate limit AND no usable source came back. If the
// model still extracted a source despite a partial rate-limit hit, that is a
// real result for CRAAP to judge, not a block to discard.
function skeletonHasSource(s: ResearchSkeleton): boolean {
  return (
    s.value !== null ||
    (typeof s.author_publisher === "string" && s.author_publisher.trim() !== "") ||
    (typeof s.source_url === "string" && s.source_url.trim() !== "")
  );
}

// Transient throttling at the API level (429 rate limit, 529 overloaded, or any
// 5xx) — treat like a search block: back off and retry the same search.
function isTransientApiError(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError &&
    typeof err.status === "number" &&
    (err.status === 429 || err.status >= 500)
  );
}

export type SearchOutcome =
  | {
      status: "searched";
      result: ResearcherCallResult;
      searchCalls: number;
      blockCodes: string[];
      usage: { inputTokens: number; outputTokens: number };
    }
  | {
      status: "rate_limited";
      searchCalls: number;
      blockCodes: string[];
      usage: { inputTokens: number; outputTokens: number };
      lastResult: ResearcherCallResult | null;
    };

// The single isolated search call, injectable so tests can simulate rate-limit
// blocks/recoveries with zero API calls. Defaults to the real researcher.
export type SearchFn = (
  slot: ResearchSlot,
  opts?: ResearchSlotCallOpts,
) => Promise<ResearcherCallResult>;

export async function searchSlotWithBackoff(
  slot: ResearchSlot,
  opts?: ResearchSlotCallOpts,
  searchFn: SearchFn = researchSlot,
): Promise<SearchOutcome> {
  const blockCodes: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let searchCalls = 0;
  let lastResult: ResearcherCallResult | null = null;

  for (let i = 0; i <= SEARCH_BACKOFF_MS.length; i++) {
    // Spacing before the first search; exponential backoff before any retry.
    await sleep(i === 0 ? SEARCH_SPACING_MS : SEARCH_BACKOFF_MS[i - 1]);

    let result: ResearcherCallResult;
    try {
      result = await searchFn(slot, opts);
    } catch (err) {
      searchCalls++;
      if (isTransientApiError(err)) {
        // API-level throttle: the request itself was rejected — treat as a
        // block and back off, same as a tool-result rate-limit error.
        const status =
          err instanceof Anthropic.APIError ? err.status : "unknown";
        blockCodes.push(`api_${status}`);
        continue;
      }
      throw err; // a real error (parse failure, missing key, etc.) — surface it
    }

    searchCalls++;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    blockCodes.push(...result.searchErrorCodes);
    lastResult = result;

    const blocked = result.rateLimitBlocked && !skeletonHasSource(result.skeleton);
    if (!blocked) {
      return { status: "searched", result, searchCalls, blockCodes, usage };
    }
    // Blocked: loop continues -> backoff and retry the same search.
  }

  return { status: "rate_limited", searchCalls, blockCodes, usage, lastResult };
}
