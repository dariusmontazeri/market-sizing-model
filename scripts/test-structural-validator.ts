// Checkpoint runner for the structural validator (the pre-research shape gate).
// Components stay isolated: this does NOT call the proposer live. It reads a
// SAVED, known-good Germany proposer output from disk (the committed fixture)
// and feeds it to the validator as a fixed test input.
//
// Two scenarios:
//   A. Golden case — the unmodified saved structure. Exercises Stage 1 (expected
//      pass) and the Stage 2 model call. Result is persisted to a JSON artifact.
//   B. Broken case — the same structure with one mechanical defect injected
//      (a dangling filter.distinction_ref). Exercises the Stage 1 short-circuit:
//      it must fail in code and make NO model call (stage2 === null).
//
// Run with the server env loaded, e.g.:
//   npx tsx --env-file=.env.local scripts/test-structural-validator.ts
// (tsx is not a local dependency, so `node --import tsx` won't resolve it.)
import fs from "node:fs";
import path from "node:path";
import { validateStructure } from "../lib/structuralValidator";
import type { ProposedStructure } from "../lib/structureProposer";

const INPUT_PATH = path.join(
  process.cwd(),
  "scripts",
  "structure-proposer.germany.json",
);
const OUTPUT_PATH = path.join(
  process.cwd(),
  "scripts",
  "structural-validator.germany.json",
);

type ProposerArtifact = {
  market: { country: string; market: string };
  structure: ProposedStructure;
};

function loadFixture(): ProposerArtifact {
  const raw = fs.readFileSync(INPUT_PATH, "utf8");
  const parsed = JSON.parse(raw) as ProposerArtifact;
  return { market: parsed.market, structure: parsed.structure };
}

async function main() {
  const { market, structure } = loadFixture();

  // --- Scenario A: golden, unmodified saved structure -----------------------
  console.log("=== Scenario A: golden Germany structure (expect overall PASS) ===");
  const golden = await validateStructure({ market, structure });
  const goldenJson = JSON.stringify(golden, null, 2);
  console.log(goldenJson);
  fs.writeFileSync(OUTPUT_PATH, goldenJson + "\n", "utf8");
  console.log(`\nWrote artifact to ${OUTPUT_PATH}`);
  console.log(
    `Summary: stage1.passed=${golden.stage1.passed}, ` +
      `stage2.passed=${golden.stage2?.passed ?? "n/a (not called)"}, ` +
      `overall passed=${golden.passed}`,
  );

  // --- Scenario B: inject one mechanical defect (dangling distinction_ref) ---
  console.log(
    "\n=== Scenario B: broken structure, dangling distinction_ref (expect Stage 1 FAIL, no model call) ===",
  );
  const broken: ProposedStructure = {
    ...structure,
    filters: structure.filters.map((f, i) =>
      i === structure.filters.length - 1
        ? { ...f, distinction_ref: "THIS DISTINCTION DOES NOT EXIST" }
        : f,
    ),
  };
  const brokenResult = await validateStructure({ market, structure: broken });
  console.log(JSON.stringify(brokenResult, null, 2));
  console.log(
    `\nSummary: stage1.passed=${brokenResult.stage1.passed}, ` +
      `stage2=${brokenResult.stage2 === null ? "null (model NOT called)" : "CALLED — UNEXPECTED"}, ` +
      `overall passed=${brokenResult.passed}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
