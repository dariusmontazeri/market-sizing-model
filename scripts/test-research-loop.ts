// Checkpoint runner for the research loop (Slice 1: retry + tier descent,
// CRAAP-driven). Reads the SAVED validated Germany structure, derives the slots,
// and runs the loop on the PRICE slot specifically — the slot that last pulled a
// low-authority aggregator (Bookimed), so it exercises CRAAP-driven retry,
// tier descent, keep-best, and (likely) the all-fail / failed-threshold path.
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
      `threshold: ${0.7} (blend) AND Purpose gate must pass\n`,
  );

  const result = await resolveSlotWithRetry(priceSlot);

  for (const a of result.attempts) {
    const s = a.skeleton;
    const d = a.craap.dimensions;
    console.log(`=== Attempt ${a.attempt} (target Tier ${a.tier}) ===`);
    console.log(`  source:        ${short(s.author_publisher)}`);
    console.log(`  source_url:    ${short(s.source_url)}`);
    console.log(`  value:         ${short(s.value)}  units: ${short(s.units)}  date: ${short(s.date)}`);
    console.log(`  CRAAP authority: ${d.authority.score}  | currency: ${d.currency.score}  | accuracy: ${d.accuracy.score}`);
    console.log(
      `  CRAAP relevance: ${a.craap.relevanceScore} (geo ${d.relevance.geography_match.score} / pop ${d.relevance.population_match.score} / metric ${d.relevance.metric_match.score})`,
    );
    console.log(`  Purpose gate:  ${a.craap.purpose.gate}`);
    console.log(`  blended score: ${a.blendedScore}  (threshold ${result.threshold})`);
    console.log(`  -> attempt passed: ${a.passed}\n`);
  }

  console.log(
    `WINNER: attempt ${result.winnerAttempt}  | resolved (passed CRAAP): ${result.resolved}  | failedThreshold: ${result.failedThreshold}`,
  );
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
