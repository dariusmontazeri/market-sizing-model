// ONE real pinned Germany run — the live integration test of the back-half chain.
// PIN_STRUCTURE on, REAL researcher + CRAAP + web search. This supersedes the
// deferred single-slot scripts/test-research-loop.ts (this is a superset: it runs
// the anchor, every filter, AND the price slot, then the full waterfall).
//
// Run ONCE (it costs API + web search and may hit the rate cap):
//   npx tsx --env-file=.env.local scripts/run-pinned-germany.ts
import fs from "node:fs";
import path from "node:path";
import { runPinnedGermanySizing } from "../lib/orchestrator";

const OUTPUT_PATH = path.join(process.cwd(), "scripts", "pinned-germany.result.json");

const money = (n: number) => `€${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function main() {
  if (!process.env.PIN_STRUCTURE) process.env.PIN_STRUCTURE = "germany";
  console.log(`PIN_STRUCTURE=${process.env.PIN_STRUCTURE} — running the REAL back-half chain.\n`);

  const r = await runPinnedGermanySizing();

  console.log("=== SLOTS (each: own isolated researcher + CRAAP call) ===");
  for (const s of r.slots) {
    const tag = `${s.kind}${s.filterIndex !== null ? `[${s.filterIndex}]` : ""}`;
    console.log(`\n  ${tag}  (outcome: ${s.outcome}, resolved: ${s.resolved})`);
    console.log(`    metric:    ${s.metric}`);
    console.log(`    value:     ${s.rawValue} ${s.units ?? ""}${s.normalizedRate !== null ? `  -> rate ${s.normalizedRate}` : ""}`);
    if (s.normalizationNote) console.log(`    normalize: ${s.normalizationNote}`);
    console.log(`    source:    ${s.source?.author_publisher ?? "(none)"}`);
    console.log(`    url:       ${s.source?.source_url ?? "(none)"}`);
    console.log(`    CRAAP:     ${s.craapScore} (purpose gate: ${s.purposeGate})`);
    if (s.unresolvedReason) console.log(`    UNRESOLVED: ${s.unresolvedReason}`);
  }

  console.log(`\n=== COMPLETENESS ===`);
  console.log(`  complete: ${r.complete}`);
  if (!r.complete) {
    console.log("  INCOMPLETE — offending slots:");
    r.incompleteReasons.forEach((x) => console.log(`    - ${x}`));
  }

  if (r.sizing && r.sizingInputs) {
    const s = r.sizing;
    console.log(`\n=== WATERFALL ===`);
    console.log(`  anchor: ${r.sizingInputs.anchor}`);
    s.filterChain.forEach((f) =>
      console.log(`  filter[${f.index}] rate ${f.rate}: ${Math.round(f.countBefore)} -> ${Math.round(f.countAfter)}`),
    );
    console.log(`  SAM units: ${Math.round(s.samUnits)}`);
    console.log(`  unit price: ${money(r.sizingInputs.unitPrice)}`);
    console.log(`  SAM$: ${money(s.samDollars)}`);
    console.log(`\n=== SOM (penetration bear ${s.penetration.bear} / base ${s.penetration.base} / bull ${s.penetration.bull}) ===`);
    (["bear", "base", "bull"] as const).forEach((k) => {
      const c = s.som[k];
      console.log(`  ${k}: SOM ${money(c.somDollars)} | replacement ${money(c.replacementDollars)} | total ${money(c.totalWithReplacement)}`);
    });
    console.log(`\n  replacement honesty check: flag=${s.replacementHonestyCheck.flag} — ${s.replacementHonestyCheck.note}`);
  }

  console.log(`\n=== ASSUMPTIONS (explicit, not sourced) ===`);
  r.assumptions.forEach((a) => console.log(`  - ${a.field} = ${a.value}: ${a.basis}`));

  console.log(`\n=== CREDIBILITY ===`);
  console.log(`  score: ${r.credibility.score}`);
  console.log(`  basis: ${r.credibility.basis}`);

  console.log(`\n=== USAGE ===`);
  console.log(`  ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(r, null, 2) + "\n", "utf8");
  console.log(`\nFull raw result object written to ${OUTPUT_PATH}`);
  process.exit(r.complete ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
