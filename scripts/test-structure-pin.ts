// Deterministic, OFFLINE proof of the dev-only structure pin. Zero API calls.
//
// Proves:
//   - the flag is OFF by default and only recognized opt-in values turn it on
//     (so the PRODUCTION path — proposer -> validator -> loop — is never bypassed
//     unless a dev explicitly sets PIN_STRUCTURE);
//   - the pinned Germany structure is the VALIDATED shape: the phantom
//     Hilfsmittel reimbursable-listing filter (and its distinction) is GONE, two
//     demand-narrowing filters remain, and it PASSES the structural validator's
//     deterministic Stage 1 (Stage 2 model pass is confirmed separately, once,
//     by scripts/validate-pinned-structure.ts);
//   - loadPinnedStructure() hands back a fresh market copy (no shared mutable ref).
//
// Run: npx tsx scripts/test-structure-pin.ts   (no env / no API key needed)
import {
  isStructurePinned,
  loadPinnedStructure,
  PINNED_GERMANY_MARKET,
  PINNED_GERMANY_STRUCTURE,
} from "../lib/structurePin";
import { runStage1 } from "../lib/structuralValidator";

let failures = 0;
function check(label: string, cond: boolean, actual?: unknown) {
  const tag = cond ? "PASS" : "FAIL";
  const suffix = actual === undefined ? "" : `  (actual: ${JSON.stringify(actual)})`;
  console.log(`  [${tag}] ${label}${suffix}`);
  if (!cond) failures++;
}

function withFlag(value: string | undefined, fn: () => void) {
  const prev = process.env.PIN_STRUCTURE;
  if (value === undefined) delete process.env.PIN_STRUCTURE;
  else process.env.PIN_STRUCTURE = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.PIN_STRUCTURE;
    else process.env.PIN_STRUCTURE = prev;
  }
}

function caseFlag() {
  console.log("\n=== Flag: OFF by default; only explicit opt-in turns it on ===");
  withFlag(undefined, () => check("unset -> OFF (production path runs)", isStructurePinned() === false, isStructurePinned()));
  withFlag("", () => check('"" -> OFF', isStructurePinned() === false));
  withFlag("0", () => check('"0" -> OFF', isStructurePinned() === false));
  withFlag("no", () => check('"no" -> OFF', isStructurePinned() === false));
  withFlag("nonsense", () => check('"nonsense" -> OFF', isStructurePinned() === false));
  withFlag("1", () => check('"1" -> ON', isStructurePinned() === true));
  withFlag("true", () => check('"true" -> ON', isStructurePinned() === true));
  withFlag("germany", () => check('"germany" -> ON', isStructurePinned() === true));
  withFlag(" GERMANY ", () => check('" GERMANY " (trim + case) -> ON', isStructurePinned() === true));
}

function caseValidatedShape() {
  console.log("\n=== Pinned structure is the VALIDATED Germany shape ===");
  const { market, structure } = loadPinnedStructure();

  check("market is Germany prosthetics", market.country === "Germany" && /prosthetic/i.test(market.market), market);
  check("two filters remain", structure.filters.length === 2, structure.filters.length);
  check("two distinctions remain", structure.distinctions.length === 2, structure.distinctions.length);

  const labels = structure.filters.map((f) => f.label).join(" | ");
  const refs = structure.filters.map((f) => f.distinction_ref).join(" | ");
  const phantomGone =
    !/hilfsmittel/i.test(labels) &&
    !/reimbursable-listing/i.test(labels) &&
    !/GKV-coverage/i.test(labels) &&
    !/hilfsmittel/i.test(refs);
  check("phantom Hilfsmittel reimbursable-listing filter REMOVED", phantomGone, labels);

  check("anchor_type event_count", structure.anchor_type.type === "event_count", structure.anchor_type.type);
  check("price_basis per_device", structure.price_basis.basis === "per_device", structure.price_basis.basis);

  const stage1 = runStage1(structure);
  console.log("  Stage-1 checks:", JSON.stringify(stage1.checks.map((c) => ({ id: c.id, passed: c.passed }))));
  console.log("  Stage-1 flags:", JSON.stringify(stage1.flags));
  check("structural validator Stage 1 PASSES (deterministic)", stage1.passed === true, stage1.passed);
  check("no Stage-1 flags (filter count 2 is in range)", stage1.flags.length === 0, stage1.flags);
}

function caseNoSharedMutableRef() {
  console.log("\n=== loadPinnedStructure returns a fresh market copy ===");
  const a = loadPinnedStructure();
  check("market object is a copy, not the module const", a.market !== PINNED_GERMANY_MARKET, true);
  a.market.country = "MUTATED";
  check("mutating the returned market does NOT touch the const", PINNED_GERMANY_MARKET.country === "Germany", PINNED_GERMANY_MARKET.country);
  // sanity: structure const has the expected addressable unit text
  check("structure const intact", /major limb loss/i.test(PINNED_GERMANY_STRUCTURE.addressable_unit), true);
}

function main() {
  console.log("Deterministic offline proof of the dev-only structure pin (ZERO API calls)");
  caseFlag();
  caseValidatedShape();
  caseNoSharedMutableRef();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
