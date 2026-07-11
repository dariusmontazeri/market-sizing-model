// Structure proposer — Phase 1 of the units-based method, and the FIRST
// isolated component to run (before the researcher). CLAUDE.md: each component
// is ONE isolated API call with zero shared context; this module must never be
// imported by client code, and never sees the researcher's or validator's
// reasoning.
//
// The judgment core: given a market, it proposes the model's SHAPE — the
// addressable unit, anchor type, distinctions, filters, and price basis — as an
// empty labeled skeleton. It NEVER finds or records a number; that is the
// researcher's job (Phase 2). The no-value schema below makes the proposer
// structurally incapable of returning a figure.
import Anthropic from "@anthropic-ai/sdk";
import { loadInstruction } from "./instructions";
import { runStructuredCall } from "./anthropic";
import { MODELS } from "./models";
// The injection boundary is shared, not re-implemented: a security primitive
// re-coded per component invites drift. The market name is user-supplied in
// production, so it enters the prompt through wrapUntrusted() as untrusted data.
import { wrapUntrusted } from "./researcher";

// Hardcoded test market for this phase — same pattern as the researcher's
// hardcoded anchor slot. The typed Country/Market UI fields do NOT drive this
// yet.
const GERMANY_PROSTHETICS_MARKET = {
  country: "Germany",
  market: "prosthetics (prosthetic limb devices)",
} as const;

export type AnchorType = "population" | "event_count" | "installed_base";
export type PriceBasis = "per_device" | "per_procedure" | "per_unit_sold";

// The proposed model shape. NOTE: there is deliberately no numeric, percentage,
// or value field anywhere in this type — the proposer cannot return a figure.
export type ProposedStructure = {
  addressable_unit: string;
  anchor_type: { type: AnchorType; justification: string };
  distinctions: { characteristic: string; why_it_narrows: string }[];
  filters: { label: string; distinction_ref: string }[];
  price_basis: { basis: PriceBasis; justification: string };
  gap_check: string;
  double_count_check: string;
};

// Exported so the structural validator's Stage-1 mechanical check reuses the
// canonical valid-kind lists — one source of truth, no drift between the
// component that proposes an anchor/price kind and the gate that validates it.
export const ANCHOR_TYPES: readonly AnchorType[] = [
  "population",
  "event_count",
  "installed_base",
];
export const PRICE_BASES: readonly PriceBasis[] = [
  "per_device",
  "per_procedure",
  "per_unit_sold",
];

// Structured-outputs schema. Every field required; additionalProperties:false
// is mandatory for the API. Crucially, every leaf is a string or a fixed enum —
// there is no number type anywhere, so a value cannot be expressed.
const STRUCTURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "addressable_unit",
    "anchor_type",
    "distinctions",
    "filters",
    "price_basis",
    "gap_check",
    "double_count_check",
  ],
  properties: {
    addressable_unit: {
      type: "string",
      description:
        "The strict thing actually bought in this market, with its exact qualifying conditions.",
    },
    anchor_type: {
      type: "object",
      additionalProperties: false,
      required: ["type", "justification"],
      properties: {
        type: { type: "string", enum: [...ANCHOR_TYPES] },
        justification: {
          type: "string",
          description: "One line on why this anchor type fits the market.",
        },
      },
    },
    distinctions: {
      type: "array",
      description:
        "Every characteristic true of the addressable unit but NOT of the raw anchor.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["characteristic", "why_it_narrows"],
        properties: {
          characteristic: { type: "string" },
          why_it_narrows: {
            type: "string",
            description:
              "Why this distinction narrows the anchor toward the addressable unit.",
          },
        },
      },
    },
    filters: {
      type: "array",
      description:
        "One filter per distinction, ordered broadest-cut-first. A filter is a labeled cut, never a number.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "distinction_ref"],
        properties: {
          label: { type: "string" },
          distinction_ref: {
            type: "string",
            description:
              "The distinction characteristic this filter implements.",
          },
        },
      },
    },
    price_basis: {
      type: "object",
      additionalProperties: false,
      required: ["basis", "justification"],
      properties: {
        basis: { type: "string", enum: [...PRICE_BASES] },
        justification: {
          type: "string",
          description: "One line on why this price basis fits the market.",
        },
      },
    },
    gap_check: {
      type: "string",
      description:
        "Is the final filtered figure actually the addressable unit, or is there an uncut difference? Name any residual gap.",
    },
    double_count_check: {
      type: "string",
      description:
        "Does each filter cut a DISTINCT characteristic? Name any overlap risk.",
    },
  },
} as const;

// System prompt lives in instructions/structureProposer.md (planner is the
// source of truth); loaded once at module load.
const STRUCTURE_SYSTEM_PROMPT = loadInstruction("structureProposer.md");

function isDistinction(
  value: unknown,
): value is ProposedStructure["distinctions"][number] {
  return (
    typeof value === "object" &&
    value !== null &&
    "characteristic" in value &&
    typeof value.characteristic === "string" &&
    "why_it_narrows" in value &&
    typeof value.why_it_narrows === "string"
  );
}

function isFilter(
  value: unknown,
): value is ProposedStructure["filters"][number] {
  return (
    typeof value === "object" &&
    value !== null &&
    "label" in value &&
    typeof value.label === "string" &&
    "distinction_ref" in value &&
    typeof value.distinction_ref === "string"
  );
}

// Verify, don't trust: structured outputs guarantees schema shape, but the
// pipeline rule is that every component checks its own output.
export function isProposedStructure(value: unknown): value is ProposedStructure {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (typeof v.addressable_unit !== "string") return false;
  if (typeof v.gap_check !== "string") return false;
  if (typeof v.double_count_check !== "string") return false;

  const anchor = v.anchor_type;
  if (
    typeof anchor !== "object" ||
    anchor === null ||
    !("type" in anchor) ||
    !ANCHOR_TYPES.includes(anchor.type as AnchorType) ||
    !("justification" in anchor) ||
    typeof anchor.justification !== "string"
  ) {
    return false;
  }

  const price = v.price_basis;
  if (
    typeof price !== "object" ||
    price === null ||
    !("basis" in price) ||
    !PRICE_BASES.includes(price.basis as PriceBasis) ||
    !("justification" in price) ||
    typeof price.justification !== "string"
  ) {
    return false;
  }

  if (!Array.isArray(v.distinctions) || !v.distinctions.every(isDistinction)) {
    return false;
  }
  if (!Array.isArray(v.filters) || !v.filters.every(isFilter)) return false;

  return true;
}

export type StructureProposalResult = {
  ok: true;
  market: typeof GERMANY_PROSTHETICS_MARKET;
  structure: ProposedStructure;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

// Output budget per proposer call. Adaptive thinking counts against
// max_tokens; the intermittent empty-turn failure (~1/3 of runs) was the turn
// ending before the final JSON, so this is sized with headroom and the shared
// plumbing (lib/anthropic.ts) retries once with a doubled budget on an
// empty/truncated/garbled turn.
const PROPOSER_MAX_TOKENS = 8192;

export async function proposeStructure(): Promise<StructureProposalResult> {
  const market = GERMANY_PROSTHETICS_MARKET;
  // Instruction lives in the system prompt; the user message carries the market
  // as untrusted data through the injection boundary.
  const userContent = `Propose the units-based market structure for the market in the data block.\n${wrapUntrusted(
    `Country: ${market.country}\nMarket: ${market.market}`,
  )}`;

  const { value, model, usage, content } =
    await runStructuredCall<ProposedStructure>({
      label: "structure proposer",
      model: MODELS.structureProposer,
      system: STRUCTURE_SYSTEM_PROMPT,
      userContent,
      schema: STRUCTURE_SCHEMA as unknown as Record<string, unknown>,
      guard: isProposedStructure,
      maxTokens: PROPOSER_MAX_TOKENS,
      // Shape-only web search; the no-value schema enforces that nothing
      // numeric comes back. max_uses bounds cost per call.
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    });

  // Count web_search server-tool uses across all turns — diagnostic to confirm
  // shape-search actually fired (and stayed within max_uses).
  const webSearchUses = content.filter(
    (b): b is Anthropic.ServerToolUseBlock =>
      b.type === "server_tool_use" && b.name === "web_search",
  ).length;
  console.log(`[structure-proposer] web_search tool uses: ${webSearchUses}`);

  return {
    ok: true,
    market,
    structure: value,
    model,
    usage,
  };
}
