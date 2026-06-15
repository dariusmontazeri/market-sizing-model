// Checkpoint runner for the research loop. Reads the SAVED validated Germany
// structure, derives the slots, and runs the loop on the PRICE slot — the slot
// that hit the web_search rate cap in the prior runs.
//
// Slice 2 focus: show that a rate-limit BLOCK is handled differently from a
// CRAAP FAILURE. The output separates SEARCH ROUNDS (which may back off and
// retry the same tier, or end rate_limited) from CRAAP EVALUATIONS (real
// source-quality verdicts that descend a tier on failure).
//
// NOT wired live to the proposer or structural validator.
//
// Run with the server env loaded, e.g.:
//   npx tsx --env-file=.env.local scripts/test-research-loop.ts
import fs from "node:fs";
import path from "node:path";
import { deriveResearchSlots } from "../lib/researcher";
import { resolveSlotWithRetry } from "../lib/researchLoop";
import type { ProposedStructure } from "../lib/structureProposer";

const INPUT_PATH = path.join(
  process.cwd(),
  "scripts",
  "structure-proposer.germany.json",
);
const OUTPUT_PATH = path.join(
  process.cwd(),
  "scripts",
  "research-loop.germany-price.json",
);

type ValidatedStructureFixture = {
  market: { country: string; market: string };
  structure: ProposedStructure;
};

const short = (v: unknown) =>
  v === null || v === undefined
    ? "null"
    : typeof v === "string"
      ? v
      : JSON.stringify(v);

async function main() {
  const raw = fs.readFileSync(INPUT_PATH, "utf8");
  const { market, structure } = JSON.parse(raw) as ValidatedStructureFixture;

  const slots = deriveResearchSlots(market, structure);
  const priceSlot = slots.find((s) => s.kind === "price");
  if (!priceSlot) throw new Error("No price slot derived from the fixture");

  console.log(
    `Loop on PRICE slot for ${market.market} (${market.country})\n` +
      `metric: ${priceSlot.metric}\n` +
      `accept = Purpose gate pass AND blend >= 0.7\n`,
  );

  const result = await resolveSlotWithRetry(priceSlot);

  // 1) Search rounds — the rate-limit-vs-CRAAP distinction lives here.
  console.log("--- SEARCH ROUNDS (per tier) ---");
  for (const r of result.searchRounds) {
    const blocks =
      r.blockCodes.length > 0 ? r.blockCodes.join(", ") : "(none)";
    const note =
      r.status === "rate_limited"
        ? "RATE-LIMIT BLOCK — backoff exhausted, NOT handed to CRAAP, NOT a tier descent"
        : r.searchCalls > 1
          ? `recovered after backoff (${r.searchCalls} search calls) — then handed to CRAAP`
          : "searched cleanly (1 call) — handed to CRAAP";
    console.log(
      `  Round ${r.attempt} (Tier ${r.tier}): status=${r.status} | searchCalls=${r.searchCalls} | blockCodes=[${blocks}]\n    -> ${note}`,
    );
  }

  // 2) CRAAP evaluations — real source-quality verdicts (these descend tiers).
  console.log("\n--- CRAAP EVALUATIONS (source-quality verdicts) ---");
  if (result.attempts.length === 0) {
    console.log("  (none — no search produced a source to evaluate)");
  }
  for (const a of result.attempts) {
    const s = a.skeleton;
    const d = a.craap.dimensions;
    console.log(`  Attempt ${a.attempt} (Tier ${a.tier}):`);
    console.log(`    source:        ${short(s.author_publisher)}`);
    console.log(`    source_url:    ${short(s.source_url)}`);
    console.log(`    value:         ${short(s.value)}  units: ${short(s.units)}  date: ${short(s.date)}`);
    console.log(`    CRAAP authority ${d.authority.score} | currency ${d.currency.score} | accuracy ${d.accuracy.score} | relevance ${a.craap.relevanceScore}`);
    console.log(`    Purpose gate:  ${a.craap.purpose.gate}`);
    console.log(`    blended:       ${a.blendedScore} (threshold ${result.threshold}) -> passed: ${a.passed}`);
  }

  console.log(
    `\nOUTCOME: ${result.outcome}  | resolved: ${result.resolved} | failedThreshold: ${result.failedThreshold} | rateLimited: ${result.rateLimited}`,
  );
  console.log(`winnerAttempt: ${short(result.winnerAttempt)}`);
  console.log(
    `Total usage: ${result.totalUsage.inputTokens} in / ${result.totalUsage.outputTokens} out tokens`,
  );

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(`\nWrote full artifact to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
