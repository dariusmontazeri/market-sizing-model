// CRAAP validator — second isolated component (CLAUDE.md: components must
// NOT see each other's reasoning; isolation is enforced by isolated context).
// This module makes its OWN API call and receives ONLY the slot definition
// and the filled skeleton — never the researcher's conversation or sources.
//
// AI does judgment, code does arithmetic: the model emits per-dimension
// scores and reasoning; the relevance roll-up and the weighted total are
// computed HERE, in code, with locked weights.
import { loadInstruction } from "./instructions";
import { runStructuredCall } from "./anthropic";
import { MODELS } from "./models";
import type { AnchorSkeleton } from "./researcher";

export type SlotDefinition = {
  geography: string;
  metric: string;
  definition: string;
};

// Locked weights — not tunable by the model or the request.
export const CRAAP_WEIGHTS = {
  authority: 0.3,
  relevance: 0.3,
  currency: 0.25,
  accuracy: 0.15,
} as const;

// Pass threshold for the weighted blend (0–1 scale; "~7/10"). A source must
// clear this AND pass the Purpose gate to be accepted by the research loop.
export const CRAAP_THRESHOLD = 0.7;

type DimensionScore = { score: number; reasoning: string };

// Purpose is a GATE, not a weighted dimension: a fail disqualifies the source
// regardless of the blend (e.g. a promotional/lead-gen figure produced to sell,
// not to measure). The model emits it; code acts on it.
export type PurposeGate = { gate: "pass" | "fail"; reasoning: string };

// Shape the model must return. Relevance is graded on three sub-dimensions —
// the shared vocabulary: geography match, population match, metric match.
type CraapModelOutput = {
  authority: DimensionScore;
  currency: DimensionScore;
  accuracy: DimensionScore;
  relevance: {
    geography_match: DimensionScore;
    population_match: DimensionScore;
    metric_match: DimensionScore;
  };
  // Gate, not part of the weighted blend.
  purpose: PurposeGate;
};

const DIMENSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "reasoning"],
  properties: {
    score: {
      type: "number",
      description: "Score from 0 to 1.",
    },
    reasoning: {
      type: "string",
      description: "Brief reasoning, one to three sentences.",
    },
  },
} as const;

const PURPOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gate", "reasoning"],
  properties: {
    gate: {
      type: "string",
      enum: ["pass", "fail"],
      description:
        "pass = the source's purpose is fit for objective market sizing; fail = promotional/sales/lead-generation, i.e. a figure produced to sell rather than to measure.",
    },
    reasoning: {
      type: "string",
      description: "Brief reasoning, one to three sentences.",
    },
  },
} as const;

const CRAAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["authority", "currency", "accuracy", "relevance", "purpose"],
  properties: {
    authority: DIMENSION_SCHEMA,
    currency: DIMENSION_SCHEMA,
    accuracy: DIMENSION_SCHEMA,
    relevance: {
      type: "object",
      additionalProperties: false,
      required: ["geography_match", "population_match", "metric_match"],
      properties: {
        geography_match: DIMENSION_SCHEMA,
        population_match: DIMENSION_SCHEMA,
        metric_match: DIMENSION_SCHEMA,
      },
    },
    purpose: PURPOSE_SCHEMA,
  },
} as const;

// System prompt lives in instructions/craap.md (planner is the source of
// truth); loaded once at module load.
const CRAAP_SYSTEM_PROMPT = loadInstruction("craap.md");

function isDimensionScore(value: unknown): value is DimensionScore {
  return (
    typeof value === "object" &&
    value !== null &&
    "score" in value &&
    typeof value.score === "number" &&
    value.score >= 0 &&
    value.score <= 1 &&
    "reasoning" in value &&
    typeof value.reasoning === "string"
  );
}

function isPurposeGate(value: unknown): value is PurposeGate {
  return (
    typeof value === "object" &&
    value !== null &&
    "gate" in value &&
    (value.gate === "pass" || value.gate === "fail") &&
    "reasoning" in value &&
    typeof value.reasoning === "string"
  );
}

function isCraapModelOutput(value: unknown): value is CraapModelOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    !isDimensionScore(v.authority) ||
    !isDimensionScore(v.currency) ||
    !isDimensionScore(v.accuracy)
  ) {
    return false;
  }
  if (!isPurposeGate(v.purpose)) return false;
  const rel = v.relevance;
  if (typeof rel !== "object" || rel === null) return false;
  const r = rel as Record<string, unknown>;
  return (
    isDimensionScore(r.geography_match) &&
    isDimensionScore(r.population_match) &&
    isDimensionScore(r.metric_match)
  );
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export type CraapValidationResult = {
  ok: true;
  dimensions: CraapModelOutput;
  // Computed in code, never by the model:
  relevanceScore: number; // mean of the three sub-dimension scores
  weights: typeof CRAAP_WEIGHTS;
  weightedTotal: number;
  // The Purpose gate, surfaced for the loop's accept/retry decision (the gate is
  // emitted by the model but it is NOT folded into weightedTotal).
  purpose: PurposeGate;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

export async function validateSkeleton(
  slot: SlotDefinition,
  skeleton: AnchorSkeleton,
): Promise<CraapValidationResult> {
  // Shared plumbing (lib/anthropic.ts) owns the client, continuations, and the
  // empty-turn/truncation reliability retry. Adaptive thinking + four scored
  // dimensions + the Purpose gate; 4096 keeps headroom so the turn doesn't end
  // on max_tokens before the final JSON (doubled once on a reliability retry).
  const { value, model, usage } = await runStructuredCall<CraapModelOutput>({
    label: "CRAAP validator",
    model: MODELS.craapValidator,
    system: CRAAP_SYSTEM_PROMPT,
    userContent: `Slot definition:\n${JSON.stringify(slot, null, 2)}\n\nFilled skeleton to grade:\n${JSON.stringify(skeleton, null, 2)}`,
    schema: CRAAP_SCHEMA as unknown as Record<string, unknown>,
    guard: isCraapModelOutput,
    maxTokens: 4096,
  });

  // Arithmetic lives here, not in the model.
  const relevanceScore =
    (value.relevance.geography_match.score +
      value.relevance.population_match.score +
      value.relevance.metric_match.score) /
    3;
  const weightedTotal =
    CRAAP_WEIGHTS.authority * value.authority.score +
    CRAAP_WEIGHTS.relevance * relevanceScore +
    CRAAP_WEIGHTS.currency * value.currency.score +
    CRAAP_WEIGHTS.accuracy * value.accuracy.score;

  return {
    ok: true,
    dimensions: value,
    relevanceScore: round3(relevanceScore),
    weights: CRAAP_WEIGHTS,
    weightedTotal: round3(weightedTotal),
    purpose: value.purpose,
    model,
    usage,
  };
}
