// Ops utility: list recent Message Batches and their status (read-only, free).
// Useful while a batched run is polling — shows whether the queue is actually
// moving. Run: npx tsx --env-file=.env.local scripts/list-batches.ts
import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const client = new Anthropic();
  const page = await client.messages.batches.list({ limit: 6 });
  if (page.data.length === 0) {
    console.log("No batches found for this API key.");
    return;
  }
  for (const b of page.data) {
    console.log(`${b.id} | ${b.processing_status} | created ${b.created_at}`);
    console.log(`  counts: ${JSON.stringify(b.request_counts)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
