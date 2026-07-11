// Per-component model assignment — the single place a component's model is
// chosen, so the Opus-vs-Sonnet lever (V6.6, decided pre-Germany: judgment
// components stay on Opus, execution components run on Sonnet) is a one-line
// change per component, never a grep.
//
// Sonnet 5 (not Sonnet 4.6) is the Sonnet-tier choice because every component
// relies on structured outputs (output_config.format), which is documented for
// Sonnet 5 but not for Sonnet 4.6. Same list price; supports the same
// web_search tool version and adaptive thinking.
export const MODELS = {
  // Judgment core: proposes the model SHAPE. Strength over cost.
  structureProposer: "claude-opus-4-8",
  // Sole pre-research shape gate. Strength over cost.
  structuralValidator: "claude-opus-4-8",
  // Execution: finds and extracts figures (search-heavy, most calls).
  researcher: "claude-sonnet-5",
  // Execution: grades a filled skeleton against a rubric, no web access.
  craapValidator: "claude-sonnet-5",
} as const;
