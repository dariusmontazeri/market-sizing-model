// Checkpoint runner for the Phase 1 -> Phase 2 connection (resolving the slots
// of a validated structure). Components stay isolated: this does NOT call the
// proposer or the structural validator live. It reads a SAVED validated Germany
// structure from disk and feeds it to the researcher.
//
// The fixture is the committed proposer output, which is the structure that
// passed the structural validator (the gate adds no fields — a validated
// structure IS the proposed structure, having passed). So this file is the
// validated structure handed to Phase 2.
//
// Run with the server env loaded, e.g.:
//   npx tsx --env-file=.env.local scripts/test-research-structure.ts
import fs from "node:fs";
import path from "node:path";
import { researchValidatedStructure } from "../lib/researcher";
import type { ProposedStructure } from "../lib/structureProposer";

const INPUT_PATH = path.join(
  process.cwd(),
  "scripts",
  "structure-proposer.germany.json",
);
const OUTPUT_PATH = path.join(
  process.cwd(),
  "scripts",
  "research-structure.germany.json",
);

type ValidatedStructureFixture = {
  market: { country: string; market: string };
  structure: ProposedStructure;
};

function loadFixture(): ValidatedStructureFixture {
  const raw = fs.readFileSync(INPUT_PATH, "utf8");
  const parsed = JSON.parse(raw) as ValidatedStructureFixture;
  return { market: parsed.market, structure: parsed.structure };
}

const short = (v: unknown) =>
  v === null ? "null" : typeof v === "string" ? v : JSON.stringify(v);

async function main() {
  const { market, structure } = loadFixture();
  console.log(
    `Resolving slots for: ${market.market} (${market.country})\n` +
      `Anchor type: ${structure.anchor_type.type} | filters: ${structure.filters.length} | price basis: ${structure.price_basis.basis}\n`,
  );

  const result = await researchValidatedStructure({ market, structure });

  // Per-slot summary: figure found, its source, and the key skeleton fields.
  result.resolutions.forEach((r, i) => {
    const s = r.skeleton;
    const tag =
      r.slot.kind === "filter"
        ? `filter[${r.slot.filterIndex}]`
        : r.slot.kind;
    console.log(`--- Slot ${i + 1}/${result.resolutions.length}: ${tag} ---`);
    console.log(`  metric:        ${r.slot.metric}`);
    console.log(`  search_query:  ${short(s.search_query)}`);
    console.log(`  value:         ${short(s.value)}  units: ${short(s.units)}`);
    console.log(`  date:          ${short(s.date)}`);
    console.log(`  publisher:     ${short(s.author_publisher)}`);
    console.log(`  geography:     ${short(s.geography)}`);
    console.log(`  population:    ${short(s.population_segment)}`);
    console.log(`  metric_def:    ${short(s.metric_definition)}`);
    console.log("");
  });

  console.log(
    `Total usage: ${result.totalUsage.inputTokens} in / ${result.totalUsage.outputTokens} out tokens`,
  );

  const json = JSON.stringify(result, null, 2);
  fs.writeFileSync(OUTPUT_PATH, json + "\n", "utf8");
  console.log(`\nWrote full artifact to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
