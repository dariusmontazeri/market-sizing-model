// Checkpoint runner for the structure proposer (Phase 1, units-based method).
// Calls the isolated component on the hardcoded Germany prosthetics market,
// prints the full proposed structure, and persists it to a JSON artifact next
// to this script so the result can be re-read from disk. Kept on disk until the
// checkpoint is approved.
//
// Run with the server env loaded, e.g.:
//   node --env-file=.env.local --import tsx scripts/test-structure-proposer.ts
import fs from "node:fs";
import path from "node:path";
import { proposeStructure } from "../lib/structureProposer";

// Run from the project root (same convention as loadInstruction's cwd usage).
const OUTPUT_PATH = path.join(
  process.cwd(),
  "scripts",
  "structure-proposer.germany.json",
);

async function main() {
  const result = await proposeStructure();
  const json = JSON.stringify(result, null, 2);
  fs.writeFileSync(OUTPUT_PATH, json + "\n", "utf8");
  console.log(json);
  console.log(`\nWrote artifact to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
