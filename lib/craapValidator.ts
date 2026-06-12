// CRAAP validator — second isolated component (CLAUDE.md: components must
// NOT see each other's reasoning; isolation is enforced by isolated context).
// This module makes its OWN API call and receives ONLY the slot definition
// and the filled skeleton — never the researcher's conversation or sources.
//
// AI does judgment, code does arithmetic: the model emits per-dimension
// scores and reasoning; the relevance roll-up and the weighted total are
// computed HERE, in code, with locked weights.
import Anthropic from "@anthropic-ai/sdk";
import { loadInstruction } from "./instructions";
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

type DimensionScore = { score: number; reasoning: string };

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

const CRAAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["authority", "currency", "accuracy", "relevance"],
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
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

export async function validateSkeleton(
  slot: SlotDefinition,
  skeleton: AnchorSkeleton,
): Promise<CraapValidationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in the server environment");
  }
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: CRAAP_SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: CRAAP_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Slot definition:\n${JSON.stringify(slot, null, 2)}\n\nFilled skeleton to grade:\n${JSON.stringify(skeleton, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed: unknown = JSON.parse(text);
  if (!isCraapModelOutput(parsed)) {
    throw new Error(
      `CRAAP validator returned JSON outside the expected shape or score range: ${text}`,
    );
  }

  // Arithmetic lives here, not in the model.
  const relevanceScore =
    (parsed.relevance.geography_match.score +
      parsed.relevance.population_match.score +
      parsed.relevance.metric_match.score) /
    3;
  const weightedTotal =
    CRAAP_WEIGHTS.authority * parsed.authority.score +
    CRAAP_WEIGHTS.relevance * relevanceScore +
    CRAAP_WEIGHTS.currency * parsed.currency.score +
    CRAAP_WEIGHTS.accuracy * parsed.accuracy.score;

  return {
    ok: true,
    dimensions: parsed,
    relevanceScore: round3(relevanceScore),
    weights: CRAAP_WEIGHTS,
    weightedTotal: round3(weightedTotal),
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
