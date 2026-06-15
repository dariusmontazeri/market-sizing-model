// Structural validator — third isolated component, and the SOLE structural gate
// (CLAUDE.md: each component is ONE isolated API call with zero shared context;
// this module must never be imported by client code, and never sees the
// proposer's, researcher's, or CRAAP validator's conversation/reasoning).
//
// It is a pre-research SHAPE GATE. It consumes the structure proposer's
// structured OUTPUT and decides whether that shape is sound BEFORE any research
// happens. It never sees, finds, or judges a researched value — only the shape.
// (Any earlier description of this component checking filled-in numbers or
// "value within bounds for the geography" is superseded: shape only.)
//
// Two stages, in order:
//   Stage 1 — deterministic mechanical checks in code. Run FIRST. If any fail,
//             the structure is rejected immediately and the model is NOT called
//             (no point spending a call to judge a structure that is mechanically
//             broken). No market knowledge here — pure structural integrity.
//   Stage 2 — model judgment (one isolated Claude call, no web search), run ONLY
//             if Stage 1 passes. The model grades the things code cannot:
//             whether the anchor truly fits the market, whether a real gap or a
//             semantic double-count hides in the chain, etc.
// The overall pass/fail is rolled up HERE, in code, from the per-check verdicts
// (AI does judgment, code does the arithmetic — Principle 4/5).
import Anthropic from "@anthropic-ai/sdk";
import { loadInstruction } from "./instructions";
import { wrapUntrusted } from "./researcher";
import {
  ANCHOR_TYPES,
  PRICE_BASES,
  type AnchorType,
  type PriceBasis,
  type ProposedStructure,
} from "./structureProposer";

export type MarketRef = { country: string; market: string };

// What the validator receives: the proposer's full structured output (including
// its self-checks, which Stage 2 grades) plus the market it was proposed for.
// This is the proposer's OUTPUT interface, not its hidden reasoning — isolation
// is preserved because the two never share a conversation/context.
export type StructureToValidate = {
  market: MarketRef;
  structure: ProposedStructure;
};

// ---------------------------------------------------------------------------
// Stage 1 — deterministic mechanical checks (code, no model, no market
// knowledge). Each check is a hard gate; a non-blocking observation is a flag.

export type Stage1Check = { id: string; passed: boolean; detail: string };
export type Stage1Result = {
  passed: boolean;
  checks: Stage1Check[];
  flags: string[];
};

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

export function runStage1(structure: ProposedStructure): Stage1Result {
  const checks: Stage1Check[] = [];
  const flags: string[] = [];

  // 1. anchor_type is a recognized kind.
  const anchorType = structure.anchor_type?.type;
  const anchorValid = ANCHOR_TYPES.includes(anchorType as AnchorType);
  checks.push({
    id: "anchor_type_valid",
    passed: anchorValid,
    detail: anchorValid
      ? `anchor_type "${anchorType}" is a recognized kind`
      : `anchor_type "${String(anchorType)}" is not one of: ${ANCHOR_TYPES.join(", ")}`,
  });

  // 2. price_basis is a recognized kind.
  const priceBasis = structure.price_basis?.basis;
  const priceValid = PRICE_BASES.includes(priceBasis as PriceBasis);
  checks.push({
    id: "price_basis_valid",
    passed: priceValid,
    detail: priceValid
      ? `price_basis "${priceBasis}" is a recognized kind`
      : `price_basis "${String(priceBasis)}" is not one of: ${PRICE_BASES.join(", ")}`,
  });

  const distinctions = Array.isArray(structure.distinctions)
    ? structure.distinctions
    : [];
  const filters = Array.isArray(structure.filters) ? structure.filters : [];

  // 3. every filter's distinction_ref resolves to a listed distinction.
  const distinctionChars = new Set(distinctions.map((d) => d?.characteristic));
  const dangling = filters.filter((f) => !distinctionChars.has(f?.distinction_ref));
  checks.push({
    id: "filter_refs_resolve",
    passed: dangling.length === 0,
    detail:
      dangling.length === 0
        ? "every filter.distinction_ref matches a listed distinction"
        : `dangling distinction_ref(s) with no matching distinction: ${dangling
            .map((f) => `"${f?.distinction_ref}"`)
            .join(", ")}`,
  });

  // 4. no two filters share the same distinction_ref (literal double-count).
  const refCounts = new Map<string, number>();
  for (const f of filters) {
    const ref = f?.distinction_ref;
    if (typeof ref === "string") refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
  }
  const repeatedRefs = [...refCounts.entries()].filter(([, n]) => n > 1);
  checks.push({
    id: "no_repeated_distinction_ref",
    passed: repeatedRefs.length === 0,
    detail:
      repeatedRefs.length === 0
        ? "no two filters reference the same distinction"
        : `distinction_ref(s) used by more than one filter: ${repeatedRefs
            .map(([ref, n]) => `"${ref}" (${n}x)`)
            .join(", ")}`,
  });

  // 5. all required fields present and non-empty; filter labels unique.
  const missing: string[] = [];
  if (!isNonEmptyString(structure.addressable_unit)) missing.push("addressable_unit");
  if (!isNonEmptyString(structure.anchor_type?.justification))
    missing.push("anchor_type.justification");
  if (!isNonEmptyString(structure.price_basis?.justification))
    missing.push("price_basis.justification");
  if (!isNonEmptyString(structure.gap_check)) missing.push("gap_check");
  if (!isNonEmptyString(structure.double_count_check))
    missing.push("double_count_check");
  if (distinctions.length === 0) missing.push("distinctions (empty)");
  if (filters.length === 0) missing.push("filters (empty)");
  distinctions.forEach((d, i) => {
    if (!isNonEmptyString(d?.characteristic))
      missing.push(`distinctions[${i}].characteristic`);
    if (!isNonEmptyString(d?.why_it_narrows))
      missing.push(`distinctions[${i}].why_it_narrows`);
  });
  filters.forEach((f, i) => {
    if (!isNonEmptyString(f?.label)) missing.push(`filters[${i}].label`);
    if (!isNonEmptyString(f?.distinction_ref))
      missing.push(`filters[${i}].distinction_ref`);
  });
  const labels = filters.map((f) => f?.label).filter(isNonEmptyString);
  const duplicateLabels = labels.filter((l, i) => labels.indexOf(l) !== i);
  const fieldsOk = missing.length === 0 && duplicateLabels.length === 0;
  checks.push({
    id: "required_fields_present",
    passed: fieldsOk,
    detail: fieldsOk
      ? "all required fields present and non-empty; filter labels unique"
      : [
          missing.length ? `missing/empty: ${missing.join(", ")}` : "",
          duplicateLabels.length
            ? `duplicate filter labels: ${[...new Set(duplicateLabels)]
                .map((l) => `"${l}"`)
                .join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("; "),
  });

  // Non-blocking: filter count outside the typical 2–5 range. NOT a failure —
  // a flag handed to Stage 2 for the model to weigh (Section 6B step 3:
  // "the 2–5 range is a sanity check, not the rule").
  if (filters.length < 2 || filters.length > 5) {
    flags.push(
      `filter count is ${filters.length}, outside the typical 2–5 range — scrutinize whether distinctions were invented or a necessary cut was skipped`,
    );
  }

  return { passed: checks.every((c) => c.passed), checks, flags };
}

// ---------------------------------------------------------------------------
// Stage 2 — model judgment (one isolated call, NO web search). The model only
// reasons over the proposer's surfaced structure and its own knowledge.

export type CheckVerdict = { verdict: "pass" | "fail"; reasoning: string };

export type Stage2Checks = {
  anchor_appropriate: CheckVerdict;
  gap_check_grade: CheckVerdict;
  semantic_double_count: CheckVerdict;
  distinctions_genuine: CheckVerdict;
  price_basis_match: CheckVerdict;
};

const STAGE2_CHECK_IDS = [
  "anchor_appropriate",
  "gap_check_grade",
  "semantic_double_count",
  "distinctions_genuine",
  "price_basis_match",
] as const;

export type Stage2Result = { passed: boolean; checks: Stage2Checks };

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reasoning"],
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fail"],
      description:
        "pass = the structure is sound on this check; fail = a real problem that requires the proposer to revise.",
    },
    reasoning: {
      type: "string",
      description: "Brief reasoning, one to three sentences.",
    },
  },
} as const;

const STAGE2_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...STAGE2_CHECK_IDS],
  properties: Object.fromEntries(
    STAGE2_CHECK_IDS.map((id) => [id, VERDICT_SCHEMA]),
  ),
} as const;

const STRUCTURAL_SYSTEM_PROMPT = loadInstruction("structural.md");

function isCheckVerdict(value: unknown): value is CheckVerdict {
  return (
    typeof value === "object" &&
    value !== null &&
    "verdict" in value &&
    (value.verdict === "pass" || value.verdict === "fail") &&
    "reasoning" in value &&
    typeof value.reasoning === "string"
  );
}

function isStage2Checks(value: unknown): value is Stage2Checks {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return STAGE2_CHECK_IDS.every((id) => isCheckVerdict(v[id]));
}

// ---------------------------------------------------------------------------

export type StructuralValidationResult = {
  ok: true;
  market: MarketRef;
  // Overall gate decision, rolled up in code: Stage 1 must pass AND, if reached,
  // every Stage 2 verdict must be "pass". A rejected structure goes back to the
  // proposer to revise; it is never passed downstream to research.
  passed: boolean;
  stage1: Stage1Result;
  stage2: Stage2Result | null; // null when Stage 1 failed (model not called)
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

export async function validateStructure(
  input: StructureToValidate,
): Promise<StructuralValidationResult> {
  const { market, structure } = input;

  // Stage 1 — deterministic. Short-circuit on failure: do not spend a model
  // call to judge a mechanically broken structure.
  const stage1 = runStage1(structure);
  if (!stage1.passed) {
    return {
      ok: true,
      market,
      passed: false,
      stage1,
      stage2: null,
      model: null,
      usage: null,
    };
  }

  // Stage 2 — model judgment. Key read server-side only, inside the call.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in the server environment");
  }
  const client = new Anthropic({ apiKey });

  // The structure is the proposer's output, ultimately derived from user input
  // and fetched web content — so it enters as UNTRUSTED DATA through the shared
  // injection boundary. Stage-1 flags are code-generated and trusted, so they
  // sit OUTSIDE the data block as a genuine instruction-level note.
  const flagNote =
    stage1.flags.length > 0
      ? `\n\nAutomated pre-check flags to weigh:\n${stage1.flags
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "";
  const payload = { market, structure };
  const userContent = `Grade the proposed market structure in the data block.${flagNote}\n${wrapUntrusted(
    JSON.stringify(payload, null, 2),
  )}`;

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: STRUCTURAL_SYSTEM_PROMPT,
    // No tools: the shape gate reasons only from the surfaced structure and its
    // own knowledge. It must not research, so it has no web access.
    output_config: {
      format: { type: "json_schema", schema: STAGE2_SCHEMA },
    },
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (text.trim() === "") {
    throw new Error(
      `Structural validator returned no JSON — turn ended without a final answer (stop_reason: ${response.stop_reason}).`,
    );
  }

  const parsed: unknown = JSON.parse(text);
  if (!isStage2Checks(parsed)) {
    throw new Error(
      `Structural validator returned JSON outside the expected shape: ${text}`,
    );
  }

  // Code rolls up the overall verdict from the per-check judgments.
  const stage2Passed = STAGE2_CHECK_IDS.every(
    (id) => parsed[id].verdict === "pass",
  );

  return {
    ok: true,
    market,
    passed: stage1.passed && stage2Passed,
    stage1,
    stage2: { passed: stage2Passed, checks: parsed },
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
