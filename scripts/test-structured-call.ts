// Deterministic offline test for the shared call plumbing (lib/anthropic.ts):
// proves the reliability layer routes each failure class correctly at ZERO API
// cost, via an injected fake client. Covers the two known live failure classes
// (empty final turn; max_tokens truncation/garble) plus continuation handling.
//
// Run: npx tsx scripts/test-structured-call.ts
import type Anthropic from "@anthropic-ai/sdk";
import { runStructuredCall, type MessageCreator } from "../lib/anthropic";

type Out = { answer: string };
const isOut = (v: unknown): v is Out =>
  typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).answer === "string";

// Minimal fake response factory (only the fields the plumbing reads).
function fakeMessage(opts: {
  text?: string | null;
  stopReason?: string;
  extraBlocks?: unknown[];
}): Anthropic.Message {
  const content: unknown[] = [...(opts.extraBlocks ?? [])];
  if (opts.text !== null && opts.text !== undefined) {
    content.push({ type: "text", text: opts.text });
  }
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake-model",
    content,
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  } as unknown as Anthropic.Message;
}

// Fake client: pops queued responses in order and records each request's
// max_tokens so the doubling behavior is assertable.
function fakeClient(queue: Anthropic.Message[]) {
  const maxTokensSeen: number[] = [];
  const client: MessageCreator = {
    messages: {
      create: async (params) => {
        maxTokensSeen.push(params.max_tokens);
        const next = queue.shift();
        if (!next) throw new Error("fake client: queue exhausted");
        return next;
      },
    },
  };
  return { client, maxTokensSeen };
}

const results: { name: string; passed: boolean; detail: string }[] = [];
function record(name: string, passed: boolean, detail: string) {
  results.push({ name, passed, detail });
  console.log(`[${passed ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}

const baseOpts = {
  label: "test component",
  model: "fake-model",
  system: "sys",
  userContent: "user",
  schema: {},
  guard: isOut,
  maxTokens: 1000,
};

async function main() {
  // 1. Clean success on the first attempt.
  {
    const { client, maxTokensSeen } = fakeClient([
      fakeMessage({ text: '{"answer":"ok"}' }),
    ]);
    const r = await runStructuredCall<Out>({ ...baseOpts, client });
    record(
      "clean first attempt",
      r.value.answer === "ok" && r.attempts === 1 && maxTokensSeen[0] === 1000,
      `value=${r.value.answer}, attempts=${r.attempts}, max_tokens=${maxTokensSeen.join(",")}`,
    );
  }

  // 2. EMPTY TURN (known class 1): no text block -> one retry, doubled budget.
  {
    const { client, maxTokensSeen } = fakeClient([
      fakeMessage({ text: null, stopReason: "end_turn" }),
      fakeMessage({ text: '{"answer":"recovered"}' }),
    ]);
    const r = await runStructuredCall<Out>({ ...baseOpts, client });
    record(
      "empty turn -> retry recovers",
      r.value.answer === "recovered" && r.attempts === 2 && maxTokensSeen[1] === 2000,
      `attempts=${r.attempts}, max_tokens=${maxTokensSeen.join(",")}`,
    );
  }

  // 3. TRUNCATION (known class 2): stop_reason max_tokens -> retry, doubled.
  {
    const { client, maxTokensSeen } = fakeClient([
      fakeMessage({ text: '{"answer":"trunca', stopReason: "max_tokens" }),
      fakeMessage({ text: '{"answer":"recovered"}' }),
    ]);
    const r = await runStructuredCall<Out>({ ...baseOpts, client });
    record(
      "max_tokens truncation -> retry recovers",
      r.value.answer === "recovered" && r.attempts === 2 && maxTokensSeen[1] === 2000,
      `attempts=${r.attempts}, max_tokens=${maxTokensSeen.join(",")}`,
    );
  }

  // 4. GARBLED JSON (class 2 variant): unparseable text on end_turn -> retry.
  {
    const { client } = fakeClient([
      fakeMessage({ text: '{"answer": "unterminated' }),
      fakeMessage({ text: '{"answer":"recovered"}' }),
    ]);
    const r = await runStructuredCall<Out>({ ...baseOpts, client });
    record(
      "garbled JSON -> retry recovers",
      r.value.answer === "recovered" && r.attempts === 2,
      `attempts=${r.attempts}`,
    );
  }

  // 5. Guard failure: valid JSON, wrong shape -> retry.
  {
    const { client } = fakeClient([
      fakeMessage({ text: '{"wrong":"shape"}' }),
      fakeMessage({ text: '{"answer":"recovered"}' }),
    ]);
    const r = await runStructuredCall<Out>({ ...baseOpts, client });
    record(
      "guard failure -> retry recovers",
      r.value.answer === "recovered" && r.attempts === 2,
      `attempts=${r.attempts}`,
    );
  }

  // 6. pause_turn continuation: content accumulates across turns, one attempt.
  {
    const searchBlock = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} };
    const { client } = fakeClient([
      fakeMessage({ text: null, stopReason: "pause_turn", extraBlocks: [searchBlock] }),
      fakeMessage({ text: '{"answer":"ok"}' }),
    ]);
    const r = await runStructuredCall<Out>({ ...baseOpts, client });
    const sawToolBlock = r.content.some(
      (b) => (b as { type?: string }).type === "server_tool_use",
    );
    record(
      "pause_turn continuation accumulates content",
      r.value.answer === "ok" && r.attempts === 1 && sawToolBlock && r.usage.inputTokens === 200,
      `attempts=${r.attempts}, sawToolBlock=${sawToolBlock}, usageIn=${r.usage.inputTokens}`,
    );
  }

  // 7. Both attempts fail -> throws a labeled, descriptive error.
  {
    const { client } = fakeClient([
      fakeMessage({ text: null }),
      fakeMessage({ text: "not json at all" }),
    ]);
    let threw = "";
    try {
      await runStructuredCall<Out>({ ...baseOpts, client });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    record(
      "exhausted attempts -> labeled throw",
      threw.includes("test component") && threw.includes("2 attempts"),
      `error="${threw}"`,
    );
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
