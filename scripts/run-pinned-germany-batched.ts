// The BATCHED real pinned Germany run (V6.17.4) — same chain as
// scripts/run-pinned-germany.ts but the first-attempt researcher calls and
// their CRAAP gradings go through the Message Batches API (50% token price,
// separate queue). Escalations and batch-failed items fall back to the live
// sequential path automatically. Async by nature: the batch usually completes
// in minutes but may take up to an hour — this script polls until done.
//
// Run (costs API + web search, at batch pricing):
//   npx tsx --env-file=.env.local scripts/run-pinned-germany-batched.ts
import fs from "node:fs";
import path from "node:path";
import { runPinnedGermanySizingBatched } from "../lib/batchSizing";

const OUTPUT_PATH = path.join(process.cwd(), "scripts", "pinned-germany-batched.result.json");

const money = (n: number) => `€${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function main() {
  if (!process.env.PIN_STRUCTURE) process.env.PIN_STRUCTURE = "germany";
  console.log(
    `PIN_STRUCTURE=${process.env.PIN_STRUCTURE} | RESEARCH_CACHE=${process.env.RESEARCH_CACHE ?? "(off)"} — running the BATCHED back-half chain.\n` +
      `Submitting batch waves (polling every 30s until each wave ends)...\n`,
  );

  const r = await runPinnedGermanySizingBatched();

  console.log("=== SLOTS (batched first attempts; escalations live) ===");
  for (const s of r.slots) {
    const tag = `${s.kind}${s.filterIndex !== null ? `[${s.filterIndex}]` : ""}`;
    console.log(`\n  ${tag}  (outcome: ${s.outcome}, resolved: ${s.resolved}${s.fromCache ? ", FROM CACHE" : ""})`);
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

  console.log(`\n=== USAGE (batched tokens bill at 50%) ===`);
  console.log(`  ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(r, null, 2) + "\n", "utf8");
  console.log(`\nFull raw result object written to ${OUTPUT_PATH}`);
  process.exit(r.complete ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
