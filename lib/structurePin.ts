// Dev-only structure pin (Option A: bypasses BOTH the proposer AND the structural
// validator). For the upcoming expensive Germany phase: when the PIN_STRUCTURE
// env flag is set, the pipeline can load a KNOWN-GOOD, ALREADY-VALIDATED Germany
// structure straight into the research loop instead of spending a live proposer
// call + a live validator call on every run.
//
// PRODUCTION PATH IS UNTOUCHED: the flag is OFF by default and OFF in production,
// so the live path always runs proposer -> structural validator -> research loop.
// Nothing here runs unless a caller first checks isStructurePinned(). This module
// is a dev affordance, not a code path the live pipeline takes on its own.
//
// What is pinned is the VALIDATED structure, never raw proposer output: it is the
// committed Germany proposer fixture with the phantom Hilfsmittelverzeichnis
// "reimbursable-listing" filter REMOVED (that filter failed the structural
// validator's filter_narrows_demand check — it gates a supply-side reimbursement
// step, not real demand) along with its now-orphaned distinction. The remaining
// two filters narrow genuine demand and pass the gate (confirmed once via
// scripts/validate-pinned-structure.ts; Stage-1 integrity is asserted offline in
// scripts/test-structure-pin.ts).
import type { MarketRef } from "./researcher";
import type { ProposedStructure } from "./structureProposer";

// Recognized opt-in values for the dev flag. Anything else (incl. unset) is OFF.
const PIN_ON_VALUES = new Set(["1", "true", "germany"]);

// Is the dev structure pin engaged? Reads the env at call time (not module load)
// so a test or a server route sees the current value. Default OFF.
export function isStructurePinned(): boolean {
  const v = process.env.PIN_STRUCTURE;
  return typeof v === "string" && PIN_ON_VALUES.has(v.trim().toLowerCase());
}

export const PINNED_GERMANY_MARKET: MarketRef = {
  country: "Germany",
  market: "prosthetics (prosthetic limb devices)",
};

// The validated Germany structure. Single source of truth — the committed pinned
// fixture lives here as a typed const, so it ships with the bundle and is checked
// against ProposedStructure at compile time (no runtime file load, no tracing).
export const PINNED_GERMANY_STRUCTURE: ProposedStructure = {
  addressable_unit:
    "A functional prosthetic limb device (lower- or upper-limb prosthesis) supplied or fitted within a year in Germany to a person with major limb loss/absence who is clinically a prosthesis candidate at a qualifying mobility grade.",
  anchor_type: {
    type: "event_count",
    justification:
      "The market is driven by per-year device fittings and renewals (each supplied prosthesis is a billable provision event), not by a static count of people, so it descends from a count of provision-triggering events per period.",
  },
  distinctions: [
    {
      characteristic:
        "Involves loss/absence of a MAJOR limb segment rather than any amputation event",
      why_it_narrows:
        "The raw anchor of all limb amputation/loss events is dominated by minor/partial (digit, partial-foot) amputations that are not fitted with a functional limb prosthesis, so only major-limb events feed this market.",
    },
    {
      characteristic:
        "Recipient is a clinically eligible prosthesis candidate at a qualifying mobility grade",
      why_it_narrows:
        "Many major-limb amputees (frail, dysvascular, diabetic, low-mobility) are never fitted; the German mobility-class (Mobilitätsklasse/K-level) candidacy assessment gates who actually receives a device.",
    },
  ],
  filters: [
    {
      label:
        "Major-limb-segment filter (exclude minor/digit/partial amputations not fitted with a limb prosthesis)",
      distinction_ref:
        "Involves loss/absence of a MAJOR limb segment rather than any amputation event",
    },
    {
      label:
        "Clinical-candidacy / mobility-grade fitment filter (keep only those assessed as prosthesis-eligible at a qualifying Mobilitätsklasse)",
      distinction_ref:
        "Recipient is a clinically eligible prosthesis candidate at a qualifying mobility grade",
    },
  ],
  price_basis: {
    basis: "per_device",
    justification:
      "Revenue accrues per physical prosthesis supplied (and replaced), the discrete reimbursed unit, rather than per procedure or per generic unit.",
  },
  gap_check:
    "Residual gap on the addition side: a new-amputation event stream undercounts the addressable unit because annual device supply also includes replacement/renewal prostheses for the existing prosthesis-user base (devices wear out on a multi-year cycle and are re-supplied). Filtering amputation events alone never captures these renewal provision events, so the filtered figure is the 'newly fitted' subset, not total devices supplied per year; the replacement-flow component must be added separately. There is also a residual unilateral/bilateral nuance (one event can require more than one device).",
  double_count_check:
    "The two filters target distinct characteristics — anatomical level (major vs minor limb segment) and clinical fitment candidacy (mobility grade) — that are largely independent: anatomical eligibility is a structural fact about the amputation, while candidacy is a downstream clinical assessment. Applied in order (major-limb first, then candidacy), the candidacy rate is conditioned on the already-major-limb subset, so the two cuts do not remove the same patients twice.",
};

export type PinnedStructure = {
  market: MarketRef;
  structure: ProposedStructure;
};

// Load the pinned, pre-validated Germany structure. Callers MUST gate this behind
// isStructurePinned() — it is the dev bypass of proposer + validator, never the
// default. Returns a fresh shallow copy so a consumer cannot mutate the const.
export function loadPinnedStructure(): PinnedStructure {
  return {
    market: { ...PINNED_GERMANY_MARKET },
    structure: PINNED_GERMANY_STRUCTURE,
  };
}
