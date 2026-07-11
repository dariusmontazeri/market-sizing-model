// Shared Claude-call plumbing for the isolated components. Each component is
// still ONE isolated API call (Principle 7 — isolation is about context, not
// code): this module holds the mechanics every component repeated — client
// construction, the pause_turn continuation loop, text extraction, structured-
// output parsing + guarding — plus the reliability layer for the two known
// failure classes (CLAUDE.md known issues):
//
//   1. EMPTY TURN: the final turn ends with no text block (observed ~1/3 of
//      proposer runs), so there is no JSON to parse.
//   2. TRUNCATED/GARBLED JSON: the turn ends on max_tokens mid-JSON (adaptive
//      thinking counts against max_tokens, so a long think can squeeze the
//      output), producing schema-valid-looking junk or an unterminated string.
//
// Both are handled the same way: the WHOLE call is retried once, with a doubled
// max_tokens budget. Bounded, loud (console.warn), and fail-closed — if the
// retry also fails, a descriptive error is thrown naming the component and the
// failure class. This is turn plumbing, NOT a research retry loop: a slot that
// resolves to nulls is a valid result and is never re-attempted here (that is
// researchLoop.ts's job).
import Anthropic from "@anthropic-ai/sdk";

export function getClient(): Anthropic {
  // Key is read server-side only, inside the call, so a missing key is a clean
  // per-request error rather than an import-time crash.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in the server environment");
  }
  return new Anthropic({ apiKey });
}

export function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export type Usage = { inputTokens: number; outputTokens: number };

// The subset of the client the helper actually uses — injectable so the
// reliability behavior is deterministically testable offline (zero API calls).
export type MessageCreator = {
  messages: {
    create: (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ) => Promise<Anthropic.Message>;
  };
};

export type StructuredCallOptions<T> = {
  // Component name for errors/logs (e.g. "researcher", "structure proposer").
  label: string;
  model: string;
  system: string;
  userContent: string;
  // Structured-outputs JSON schema (additionalProperties:false, all required).
  schema: Record<string, unknown>;
  // Verify, don't trust: structured outputs guarantees schema-valid JSON, but
  // every component still checks its own output shape.
  guard: (value: unknown) => value is T;
  maxTokens: number;
  tools?: Anthropic.ToolUnion[];
  // Total attempts including the first (default 2 = one reliability retry).
  maxAttempts?: number;
  client?: MessageCreator;
};

export type StructuredCallResult<T> = {
  value: T;
  model: string;
  // Accumulated across ALL turns and attempts — money actually spent.
  usage: Usage;
  // All content blocks of the SUCCESSFUL attempt (across its pause_turn
  // continuations) — callers scan these for web_search errors / tool uses.
  content: Anthropic.ContentBlock[];
  attempts: number;
};

const MAX_CONTINUATIONS = 5;

export async function runStructuredCall<T>(
  opts: StructuredCallOptions<T>,
): Promise<StructuredCallResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const client = opts.client ?? getClient();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let lastFailure = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Retry with a doubled output budget: the truncation class is usually a
    // too-tight max_tokens once adaptive thinking has taken its share.
    const maxTokens = opts.maxTokens * 2 ** (attempt - 1);
    let messages: Anthropic.MessageParam[] = [
      { role: "user", content: opts.userContent },
    ];

    const callModel = () =>
      client.messages.create({
        model: opts.model,
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        system: opts.system,
        ...(opts.tools ? { tools: opts.tools } : {}),
        output_config: {
          format: { type: "json_schema", schema: opts.schema },
        },
        messages,
      });

    let response = await callModel();
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    // Web-search errors / tool uses can appear in any turn, not just the final
    // one, so accumulate content across all turns of this attempt.
    const content: Anthropic.ContentBlock[] = [...response.content];

    // Server-side tools can pause the turn at the API's iteration limit;
    // re-send with the assistant turn appended and the server resumes. Bounded
    // so a stuck turn cannot loop forever.
    let continuations = 0;
    while (response.stop_reason === "pause_turn" && continuations < MAX_CONTINUATIONS) {
      messages = [...messages, { role: "assistant", content: response.content }];
      response = await callModel();
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      content.push(...response.content);
      continuations++;
    }

    // Classify the attempt. Every failure path below is one of the two known
    // reliability classes; anything else parses, guards, and returns.
    const text = extractText(response.content);
    if (response.stop_reason === "max_tokens") {
      lastFailure = `turn ended on max_tokens (${maxTokens}) — JSON likely truncated`;
    } else if (text.trim() === "") {
      lastFailure = `no JSON — turn ended without a final answer (stop_reason: ${response.stop_reason})`;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastFailure = `final text is not valid JSON (stop_reason: ${response.stop_reason})`;
        parsed = undefined;
      }
      if (parsed !== undefined) {
        if (opts.guard(parsed)) {
          return { value: parsed, model: response.model, usage, content, attempts: attempt };
        }
        lastFailure = `JSON parsed but failed the ${opts.label} output guard`;
      }
    }

    if (attempt < maxAttempts) {
      console.warn(
        `[${opts.label}] attempt ${attempt}/${maxAttempts} failed (${lastFailure}) — retrying with max_tokens ${opts.maxTokens * 2 ** attempt}`,
      );
    }
  }

  throw new Error(
    `${opts.label} failed after ${maxAttempts} attempts: ${lastFailure}`,
  );
}
