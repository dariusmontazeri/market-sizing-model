// Per-component model assignment — the single place a component's model is
// chosen, so a model change is a one-line edit here, never a grep.
//
// Split (user decision, 2026-07-10): the two JUDGMENT components (shape
// proposal and the shape gate) stay on Opus — they are where sizing judgment
// lives and where model strength shows. The two EXECUTION components
// (find-and-extract, grade-against-rubric) run on Sonnet 4.6. Structured
// outputs (output_config.format) is supported on the 4.6 family. If Germany
// validation shows quality drop on the Sonnet side, claude-sonnet-5 is the
// one-line fallback per component.
export const MODELS = {
  // Judgment core: proposes the model SHAPE. Strength over cost.
  structureProposer: "claude-opus-4-8",
  // Sole pre-research shape gate. Strength over cost.
  structuralValidator: "claude-opus-4-8",
  // Execution: finds and extracts figures (search-heavy, most calls).
  researcher: "claude-sonnet-4-6",
  // Execution: grades a filled skeleton against a rubric, no web access.
  craapValidator: "claude-sonnet-4-6",
} as const;
