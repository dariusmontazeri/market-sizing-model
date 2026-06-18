// One-time live confirmation that the pinned Germany structure passes the
// structural validator (Stage 1 deterministic + Stage 2 model judgment). This is
// the single sanction that lets us treat lib/structurePin.ts's const as a
// VALIDATED structure. It is NOT a regression test — it makes one isolated
// Stage-2 Opus call (no web search). Run it once when the pinned structure
// changes; the deterministic Stage-1 check lives in scripts/test-structure-pin.ts.
//
// Run: npx tsx --env-file=.env.local scripts/validate-pinned-structure.ts
import { loadPinnedStructure } from "../lib/structurePin";
import { validateStructure } from "../lib/structuralValidator";

async function main() {
  const { market, structure } = loadPinnedStructure();
  console.log(`Validating pinned structure for ${market.market} (${market.country})`);
  console.log(`Filters (${structure.filters.length}):`);
  structure.filters.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}`));

  const result = await validateStructure({ market, structure });

  console.log("\n--- STAGE 1 (deterministic) ---");
  for (const c of result.stage1.checks) {
    console.log(`  [${c.passed ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
  }
  if (result.stage1.flags.length) console.log("  flags:", result.stage1.flags.join("; "));

  console.log("\n--- STAGE 2 (model judgment) ---");
  if (result.stage2) {
    for (const [id, v] of Object.entries(result.stage2.checks)) {
      console.log(`  [${v.verdict === "pass" ? "PASS" : "FAIL"}] ${id}: ${v.reasoning}`);
    }
  } else {
    console.log("  (not reached — Stage 1 failed)");
  }

  console.log(`\nOVERALL: ${result.passed ? "PASS — structure is validated" : "FAIL — do NOT pin this structure"}`);
  if (result.usage) console.log(`Usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`);
  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
