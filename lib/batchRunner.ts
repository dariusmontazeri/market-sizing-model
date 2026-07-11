// Batch runner (V6.17.4) — executes many structured calls through the
// Anthropic Message Batches API (50% token price, separate queue) while
// replicating the sync path's semantics EXACTLY:
//  - requests are built by the same buildStructuredParams (byte-identical);
//  - results are classified by the same classifyStructuredResponse;
//  - a pause_turn result is CONTINUED (assistant turn appended, resubmitted in
//    the next wave) — bounded like the sync continuation loop;
//  - a failed attempt (empty turn / max_tokens truncation / garble / guard) is
//    RETRIED once with a doubled max_tokens, exactly like the sync path;
//  - an item that exhausts its attempts settles as a labeled error — the
//    caller decides what to do (batchSizing falls back to the live path).
//
// Batching is NOT chaining: every item is its own isolated request with its
// own context, so component independence (Principle 7) is untouched. This is
// for BULK, non-interactive work (benchmark runs, showcase pre-compute,
// multi-market sweeps) — the interactive path stays sequential.
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildStructuredParams,
  classifyStructuredResponse,
  getClient,
  type StructuredCallOptions,
  type StructuredCallResult,
  type Usage,
} from "./anthropic";

// The subset of the SDK the runner uses — injectable so the wave mechanics are
// deterministically testable offline (zero API calls, zero waiting).
export type BatchClientLike = {
  messages: {
    batches: {
      create(body: {
        requests: { custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }[];
      }): Promise<{ id: string }>;
      retrieve(id: string): Promise<{ processing_status: string }>;
      results(id: string): Promise<
        AsyncIterable<{
          custom_id: string;
          result:
            | { type: "succeeded"; message: Anthropic.Message }
            | { type: "errored"; error: unknown }
            | { type: "canceled" }
            | { type: "expired" };
        }>
      >;
    };
  };
};

export type BatchRunConfig = {
  client?: BatchClientLike;
  // Poll interval while a batch is processing (default 30s live).
  pollIntervalMs?: number;
  sleeper?: (ms: number) => Promise<void>;
  // Safety cap on resubmission waves (continuations + retries share it).
  maxWaves?: number;
};

export type BatchItemResult<T> =
  | { ok: true; result: StructuredCallResult<T> }
  | { ok: false; error: string };

const MAX_CONTINUATIONS = 5;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_MAX_WAVES = 8;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type ItemState<T> = {
  id: string;
  opts: StructuredCallOptions<T>;
  attempt: number; // 1-based; maxAttempts mirrors the sync default of 2
  continuations: number;
  messages: Anthropic.MessageParam[];
  usage: Usage; // accumulated across ALL waves — money actually spent
  content: Anthropic.ContentBlock[]; // current attempt's turns
};

export async function runStructuredBatch<T>(
  items: { id: string; opts: StructuredCallOptions<T> }[],
  cfg: BatchRunConfig = {},
): Promise<Map<string, BatchItemResult<T>>> {
  const settled = new Map<string, BatchItemResult<T>>();
  if (items.length === 0) return settled;

  const client = cfg.client ?? (getClient() as unknown as BatchClientLike);
  const sleep = cfg.sleeper ?? realSleep;
  const pollMs = cfg.pollIntervalMs ?? DEFAULT_POLL_MS;
  const maxWaves = cfg.maxWaves ?? DEFAULT_MAX_WAVES;

  let pending: ItemState<T>[] = items.map(({ id, opts }) => ({
    id,
    opts,
    attempt: 1,
    continuations: 0,
    messages: [{ role: "user", content: opts.userContent }],
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [],
  }));

  for (let wave = 1; pending.length > 0 && wave <= maxWaves; wave++) {
    const byId = new Map(pending.map((s) => [s.id, s]));
    const batch = await client.messages.batches.create({
      requests: pending.map((s) => ({
        custom_id: s.id,
        params: buildStructuredParams(
          s.opts,
          s.opts.maxTokens * 2 ** (s.attempt - 1),
          s.messages,
        ),
      })),
    });

    // Poll until the batch ends (results are not readable before that).
    for (;;) {
      const status = await client.messages.batches.retrieve(batch.id);
      if (status.processing_status === "ended") break;
      await sleep(pollMs);
    }

    const nextPending: ItemState<T>[] = [];
    const seen = new Set<string>();

    for await (const entry of await client.messages.batches.results(batch.id)) {
      const state = byId.get(entry.custom_id);
      if (!state) continue; // not ours (defensive)
      seen.add(entry.custom_id);

      if (entry.result.type !== "succeeded") {
        // API-level failure for this item (errored/canceled/expired): spend a
        // retry like any other failed attempt; exhausted -> settle as error.
        if (state.attempt < (state.opts.maxAttempts ?? 2)) {
          state.attempt++;
          state.continuations = 0;
          state.messages = [{ role: "user", content: state.opts.userContent }];
          state.content = [];
          console.warn(
            `[batch:${state.opts.label}] item ${state.id} ${entry.result.type} — retrying (attempt ${state.attempt})`,
          );
          nextPending.push(state);
        } else {
          settled.set(state.id, {
            ok: false,
            error: `${state.opts.label} batch item ${entry.result.type} after ${state.attempt} attempts`,
          });
        }
        continue;
      }

      const response = entry.result.message;
      state.usage.inputTokens += response.usage.input_tokens;
      state.usage.outputTokens += response.usage.output_tokens;
      state.content.push(...response.content);

      const maxTokens = state.opts.maxTokens * 2 ** (state.attempt - 1);
      const outcome = classifyStructuredResponse(state.opts, response, maxTokens);

      if (outcome.kind === "ok") {
        settled.set(state.id, {
          ok: true,
          result: {
            value: outcome.value,
            model: response.model,
            usage: state.usage,
            content: state.content,
            attempts: state.attempt,
          },
        });
      } else if (outcome.kind === "pause_turn" && state.continuations < MAX_CONTINUATIONS) {
        // Server-side tool pause: continue the SAME attempt next wave with the
        // assistant turn appended — the batch equivalent of the sync loop.
        state.continuations++;
        state.messages = [
          ...state.messages,
          { role: "assistant", content: response.content },
        ];
        nextPending.push(state);
      } else {
        const reason =
          outcome.kind === "fail"
            ? outcome.reason
            : `turn still paused after ${MAX_CONTINUATIONS} continuations`;
        if (state.attempt < (state.opts.maxAttempts ?? 2)) {
          state.attempt++;
          state.continuations = 0;
          state.messages = [{ role: "user", content: state.opts.userContent }];
          state.content = [];
          console.warn(
            `[batch:${state.opts.label}] item ${state.id} attempt failed (${reason}) — retrying with doubled max_tokens`,
          );
          nextPending.push(state);
        } else {
          settled.set(state.id, {
            ok: false,
            error: `${state.opts.label} failed after ${state.attempt} attempts: ${reason}`,
          });
        }
      }
    }

    // Items the batch never reported (should not happen): settle as errors so
    // the caller's fallback can take over rather than hanging.
    for (const state of pending) {
      if (!seen.has(state.id) && !settled.has(state.id)) {
        settled.set(state.id, {
          ok: false,
          error: `${state.opts.label} batch item ${state.id} missing from batch results`,
        });
      }
    }

    pending = nextPending;
  }

  for (const state of pending) {
    settled.set(state.id, {
      ok: false,
      error: `${state.opts.label} batch item unresolved after wave cap`,
    });
  }

  return settled;
}
