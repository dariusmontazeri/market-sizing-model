// Cheapest LIVE end-to-end probe of the CRAAP validator: one real API call
// (~1-2c, no web search) grading a known-good synthetic skeleton. Used to
// smoke-test a model change (e.g. the Sonnet switch) or the shared plumbing
// against the real API without paying for a researcher slot.
//
// Success criteria (predefined): returns ok:true, all four dimension scores in
// [0,1], purpose gate emitted, weightedTotal computed in code, and the model id
// echoed matches lib/models.ts craapValidator.
//
// Run: npx tsx --env-file=.env.local scripts/smoke-craap-live.ts
import { validateSkeleton } from "../lib/craapValidator";
import { MODELS } from "../lib/models";

async function main() {
  const slot = {
    geography: "Germany",
    metric: "annual number of major limb amputations",
    definition:
      "Major (above-ankle or above-wrist) limb amputations performed per year in Germany.",
  };
  const skeleton = {
    search_query: "Germany major limb amputations per year Destatis",
    value: 16452,
    units: "amputations/year",
    date: "2022",
    author_publisher: "Destatis (Federal Statistical Office of Germany)",
    source_url: "https://www.destatis.de/example",
    geography: "Germany",
    population_segment: "all inpatients",
    metric_definition:
      "Count of major (above-ankle) lower-limb amputation procedures per year from hospital procedure statistics.",
    resolution_status: "found" as const,
    resolution_reason: "sourced figure located in official statistics",
  };

  console.log(`CRAAP live smoke — expecting model ${MODELS.craapValidator}`);
  const r = await validateSkeleton(slot, skeleton);

  const inRange = (n: number) => n >= 0 && n <= 1;
  const checks: [string, boolean, unknown][] = [
    ["ok", r.ok === true, r.ok],
    ["model matches config", r.model.startsWith(MODELS.craapValidator), r.model],
    ["authority in [0,1]", inRange(r.dimensions.authority.score), r.dimensions.authority.score],
    ["currency in [0,1]", inRange(r.dimensions.currency.score), r.dimensions.currency.score],
    ["accuracy in [0,1]", inRange(r.dimensions.accuracy.score), r.dimensions.accuracy.score],
    ["relevance mean in [0,1]", inRange(r.relevanceScore), r.relevanceScore],
    ["weightedTotal in [0,1]", inRange(r.weightedTotal), r.weightedTotal],
    ["purpose gate emitted", r.purpose.gate === "pass" || r.purpose.gate === "fail", r.purpose.gate],
  ];

  let failures = 0;
  for (const [label, passed, actual] of checks) {
    console.log(`  [${passed ? "PASS" : "FAIL"}] ${label}  (actual: ${JSON.stringify(actual)})`);
    if (!passed) failures++;
  }
  console.log(
    `\nweightedTotal=${r.weightedTotal} | purpose=${r.purpose.gate} | usage ${r.usage.inputTokens} in / ${r.usage.outputTokens} out`,
  );
  console.log(failures === 0 ? "SMOKE PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
