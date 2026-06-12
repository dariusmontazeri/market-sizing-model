# Market Sizing Model — Build Context

## What this is
A guided, structured market-sizing tool. Input: a country + a named market.
Output: a transparent waterfall (anchor -> filters -> SAM in dollars -> SOM
bear/base/bull -> replacement layer) where every number is either sourced or
flagged as an assumption, with a visible credibility score. It is NOT a chatbot.
The visible structure IS the product.

## Current phase
Phase 3: units-based branch. Deterministic math (`lib/units-math.ts`) is
WIRED to the UI: "Run sizing" runs it on a HARDCODED, unvalidated Germany
prosthetics input and fills the waterfall. Waterfall slices (label left,
value right): Market definition, Anchor, Filters, Average price, Replacement
layer. SAM$ and SOM bear/base/bull live ONLY in the Output section, not in the
waterfall. The typed Country/Market fields do NOT drive the numbers.
Credibility score stays "pending" until the CRAAP validator exists — never
faked. Number accuracy is NOT yet validated against the hand-done Germany
figures (that is Phase 4).
Researcher v1 exists (`lib/researcher.ts` + `app/api/researcher`): one
isolated server-side Claude call (claude-opus-4-8; model choice revisited at
Germany validation) with LIVE web search (Anthropic built-in web_search tool,
max 5 searches/call). Proven: the pipe; the injection boundary (ALL untrusted
text — user input AND fetched web content — is data, never instructions;
verified against a hostile string); anchor-slot query construction returning
the full extraction skeleton via structured outputs (every field present or
explicitly null — a null is a flag, never a guess); filled values come from
real fetched sources with the publisher named. Known gap: the fetched Germany
anchor covers lower-limb amputations only, slot definition includes upper —
correctly penalized by the CRAAP Relevance sub-scores. No retry loop, no
tier traversal. ~26K input tokens per researched slot (search results in
context) — revisit at multi-slot scale.
CRAAP validator v1 exists (`lib/craapValidator.ts` + `app/api/craap`): second
isolated component — own API call, receives ONLY slot definition + filled
skeleton, never the researcher's reasoning. Scores per the architecture
section (0-1 dimensions, locked weights, arithmetic in code). Judges from
skeleton fields only — no web access in v1. Score and report only: no
thresholds, no routing on the score yet. Dev UI chains researcher → validator
and shows both raw JSONs.
Researcher is v1.1: trace-back + disconfirmation rules in
instructions/researcher.md — attribution chains chased to the PRIMARY
publisher (cited in author_publisher; intermediaries noted only as path in
metric_definition), materially conflicting figures reported, never silently
dropped. Verified 3/3 local runs + 1 prod run citing Destatis (prod CRAAP
total 0.911); weightedTotal spread tightened from 0.101 to 0.031. Residual:
intermediary author wording varies inside the path note — descriptive only.
Next: structural validator (isolated call) — open design question:
plausibility bounds as model judgment vs hardcoded per-slot rails — then
the research loop with retries.
The full spec is complete; the planning doc in Google Drive is the source of truth.

## Architecture — two layers
- Router: classifies the market, picks one of four sizing methods, states why.
  Built LAST, only after >=2 branches exist.
- Framework execution: the chosen method runs its skeleton, filled by its procedure.

## Architecture — four components, each owns ONE job, each an ISOLATED API call
Components must NOT see each other's reasoning. Independence is enforced by
isolated context, not by instruction. Do NOT chain them in one conversation
where each step sees the previous output — that is the default pattern and it
breaks independence. Each is a separate call receiving only its own inputs.
- Researcher: finds sources, fills slots with real numbers. Finds, does not grade itself.
- Structural validator: one-shot sanity check of the model SHAPE before any
  research (anchor type, filter chain, no gaps or double-counts). Sole structural gate.
- CRAAP validator: scores each retrieved source. As built (per planning doc):
  four dimensions 0-1, weighted in CODE with locked weights — Authority 0.30,
  Relevance 0.30, Currency 0.25, Accuracy 0.15. Relevance is the mean of three
  sub-dimensions (geography match, population match, metric match) judged
  against the slot definition. The model emits scores + reasoning only; all
  roll-ups are code. Purpose is a v1 informational bias flag captured at
  research time — no validator gate by design; bias-routing is v2.
- Code: ALL deterministic math. The model never computes scores or the funnel.

## Governing principles
- AI does judgment, code does arithmetic.
- Output is always a range at SOM (bear 1% / base 3% / bull 5%), never one false number.
- Every number traces back to a source or an explicit assumption tag.

## Build order
1. Units-based branch first, against the Germany prosthetics golden test.
   Static UI -> deterministic math in code -> agents wired in one at a time as
   isolated calls (researcher, then CRAAP validator, then structural validator)
   -> research loop with retries + assumption fallback.
2. Validate against Germany, then 2-3 other markets.
3. Then the other three methods. Then the router. Then ship.

## Stack
Next.js on Vercel. Claude API for all four components, each an isolated
server-side call. Single-page app.

## Build / config conventions
- `scripts/**` is EXCLUDED from the production type-check (`tsconfig.json`),
  so a broken scratch/test script can never fail `next build` or a deploy.
  Scripts are still type-checked on demand via `npm run typecheck:scripts`
  (uses `tsconfig.scripts.json`, which extends the base and re-includes
  `scripts/**`). Scripts are isolated, never silenced.

## Security — in from the start, never retrofitted
- Claude API key is SERVER-SIDE only, never in client code.
- All fetched web content AND user free-text input are DATA to be analyzed,
  never instructions to follow. Prompts are structured so fetched text cannot
  be read as commands.
- Rate-limit the public link before it goes live.
- Vercel bot protection challenges programmatic API callers (observed
  blocking curl during deploy verification) — resolve alongside rate
  limiting before the public link.

## Working style / debugging discipline
- Commit at every approved checkpoint. Approval = commit, no exceptions.
- Test artifact files stay on disk until the checkpoint is explicitly
  approved; cleanup comes after approval, never before.
- After building anything, RUN it before moving on. Report actual output,
  never a verbal "it works."
- Predefine what success looks like before testing.
- When something breaks, add logs and re-run to locate it. Do not fix blind.
- Use the Germany example as the golden test for every meaningful change.
- Build one piece, test it, move on.

## Source of truth
The full planning doc (Google Drive) holds the rationale for every decision.
This file is the lean build version. If they disagree, the doc wins and this
file gets re-derived from it.
