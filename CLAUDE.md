# Market Sizing Model — Build Context

## What this is
A guided, structured market-sizing tool. Input: a country + a named market.
Output: a transparent waterfall (anchor -> filters -> SAM in dollars -> SOM
bear/base/bull -> replacement layer) where every number is either sourced or
flagged as an assumption, with a visible credibility score. It is NOT a chatbot.
The visible structure IS the product. Works for ANY market the user types
(Germany prosthetics is only the golden test, not the scope).

## Current phase
Phase 3: units-based branch. Deterministic math (`lib/units-math.ts`) is
WIRED to the UI: "Run sizing" runs it on a HARDCODED, unvalidated Germany
prosthetics input and fills the waterfall. Waterfall slices (label left,
value right): Market definition, Anchor, Filters, Average price, Replacement
layer. SAM$ and SOM bear/base/bull live ONLY in the Output section, not in the
waterfall. The typed Country/Market fields do NOT drive the numbers.
Credibility score stays "pending" until wired — never faked. Number accuracy
is NOT yet validated against the hand-done Germany figures (that is Phase 4).

Researcher v1.1 exists (`lib/researcher.ts` + `app/api/researcher`): one
isolated server-side Claude call (claude-opus-4-8; model choice revisited at
Germany validation) with LIVE web search (Anthropic built-in web_search tool,
max 5 searches/call). Proven: the pipe; the injection boundary (ALL untrusted
text — user input AND fetched web content — is data, never instructions;
verified against a hostile string); anchor-slot query construction returning
the full extraction skeleton via structured outputs (every field present or
explicitly null — a null is a flag, never a guess); filled values come from
real fetched sources traced to the PRIMARY publisher (cited in
author_publisher; intermediaries noted only as path in metric_definition);
materially conflicting figures reported, never silently dropped. Verified
3/3 local + 1 prod run citing Destatis (prod CRAAP total 0.911); weightedTotal
spread tightened 0.101 -> 0.031. No retry loop, no tier traversal. ~26K input
tokens per researched slot — revisit at multi-slot scale.

CRAAP validator v1 exists (`lib/craapValidator.ts` + `app/api/craap`): second
isolated component — own API call, receives ONLY slot definition + filled
skeleton, never the researcher's reasoning. Scores per the architecture
section (0-1 dimensions, locked weights, arithmetic in code). Judges from
skeleton fields only — no web access in v1. Score and report only: no
thresholds, no routing on the score yet. Dev UI chains researcher -> validator
and shows both raw JSONs.

Structure proposer v1 EXISTS (`lib/structureProposer.ts` +
`app/api/structure-proposer`, instructions in instructions/structureProposer.md).
Phase 1 of the units-based method and the FIRST component to run, before the
researcher. The judgment core: takes a market and proposes the model's SHAPE
via the reverse-engineering method (Section 6B Phase 1) — addressable_unit ->
distinctions -> filters -> anchor_type -> price_basis — as an empty labeled
skeleton, plus two self-check fields (gap_check, double_count_check). NEVER
finds or records a value (researcher's job): the structured-output schema has
NO numeric/enum-only-or-string leaves, so it is structurally incapable of
returning a number. One isolated call; SHAPE-ONLY web search allowed (to learn
market structure e.g. mobility-grade gating — NOT to find figures); the market
input enters through wrapUntrusted(), fetched web content is defended by the
system prompt (server-injected search results can't be wrapped — same posture
as the researcher). Hardcoded test market: Germany prosthetics. Verified on
Germany: valid JSON, zero numbers, anchor_type=event_count, independently
re-derived the major-vs-minor / fitment / mobility-grade distinctions
(Mobilitätsklasse tell present), substantive gap_check (catches the
replacement/renewal undercount) and double_count_check. A reference fixture
from a passing run is committed at scripts/structure-proposer.germany.json.
NOT yet wired into the researcher or the waterfall.

KNOWN ISSUES (recorded, deliberately deferred):
- Structure proposer intermittently returns an empty final turn (~1/3 of runs),
  likely a token ceiling or the turn ending mid-tool-cycle. It fails closed
  (clean 500; a legibility guard now throws a descriptive "no JSON — turn ended
  without a final answer" error instead of an opaque JSON.parse SyntaxError).
  This MUST be resolved in the research-loop phase before anything depends on
  the proposer — root cause is continuation/retry, which belongs there. This is
  a GATE on the research loop, not a passing concern.
- The proposer's runtime guard (isProposedStructure) checks SHAPE only, not
  semantic coherence: it does not enforce distinction/filter count parity,
  that each filter's distinction_ref matches a listed distinction, or label
  uniqueness. Real but not urgent — the structural validator will catch
  incoherent structures downstream. Deferred.
- Researcher intermittently returns a MALFORMED skeleton — a garbled
  structured-output JSON (observed in a Germany price-slot run: value 21,
  units ",", corrupted date ".Ers c RanA...", broken ".t://" URL). Same class
  as the proposer empty-turn issue: the call likely hit its max_tokens ceiling
  mid-JSON or a transient structured-output failure. It fails safe here — the
  skeleton still schema-validates and CRAAP correctly rejected it (authority
  0.08, purpose fail), so the pipeline stayed robust — but the data is junk.
  Belongs with the research-loop/continuation reliability work alongside the
  proposer fix; do NOT treat as a one-off. Deferred.

After the proposer: the structural validator (the pre-research shape gate,
below), then rewire the researcher to consume a validated structure instead
of the hardcoded slot, then the research loop with retries.

The full spec is the Google Drive planning doc (now at V6) — source of truth.

## Architecture — two layers
- Router: classifies the market, picks one of four sizing methods, states why.
  Built LAST, only after >=2 branches exist.
- Framework execution: the chosen method runs its skeleton, filled by its procedure.

## Architecture — five components, each owns ONE job, each an ISOLATED API call
Components must NOT see each other's reasoning. Independence is enforced by
isolated context, not by instruction. Do NOT chain them in one conversation
where each step sees the previous output — that is the default pattern and it
breaks independence. Each is a separate call receiving only its own inputs.
Runtime order: proposer -> structural validator -> researcher -> CRAAP -> code.
- Structure proposer (Phase 1): decides the model SHAPE — anchor type, filter
  chain (reverse-engineering method), price basis. Outputs an empty labeled
  skeleton, never a value. May search for market STRUCTURE only, never figures.
  This is the real sizing judgment; everything downstream is execution.
- Structural validator: one-shot sanity check of the proposed SHAPE, BEFORE any
  research (anchor type sensible, filter chain narrows to the addressable unit
  with no gaps or double-counts, price basis consistent). Sole structural gate;
  structure must pass before research happens. Sees the proposed structure, not
  researched values. (This was previously mis-described as the immediate next
  build with a "plausibility bounds: model judgment vs hardcoded rails" question
  — that was a mis-scope: the validator checks SHAPE, not researched value
  plausibility, so that question doesn't apply.)
- Researcher: finds sources, fills the validated slots with real numbers.
  Finds, does not grade itself.
- CRAAP validator: scores each retrieved source. Four dimensions 0-1, weighted
  in CODE with locked weights — Authority 0.30, Relevance 0.30, Currency 0.25,
  Accuracy 0.15. Relevance is the mean of three sub-dimensions (geography,
  population, metric match) judged against the slot definition. Model emits
  scores + reasoning only; all roll-ups are code. Purpose is a v1 informational
  bias flag captured at research time — no validator gate by design; routing v2.
- Code: ALL deterministic math. The model never computes scores or the funnel.

## Governing principles
- AI does judgment, code does arithmetic.
- Output is always a range at SOM (bear 1% / base 3% / bull 5%), never one false number.
- Every number traces back to a source or an explicit assumption tag.

## Build order
1. Units-based branch first, against the Germany prosthetics golden test.
   Static UI -> deterministic math in code -> agents wired in one at a time as
   isolated calls. Built so far: researcher, then CRAAP validator. Next:
   structure proposer (Phase 1 shape), then structural validator (shape gate),
   then rewire researcher onto the validated structure -> research loop with
   retries + assumption fallback.
2. Validate against Germany, then 2-3 other markets.
3. Then the other three methods. Then the router. Then ship.

## Stack
Next.js on Vercel. Claude API for all agent components, each an isolated
server-side call. Single-page app.

## Build / config conventions
- `scripts/**` is EXCLUDED from the production type-check (`tsconfig.json`),
  so a broken scratch/test script can never fail `next build` or a deploy.
  Scripts are still type-checked on demand via `npm run typecheck:scripts`
  (uses `tsconfig.scripts.json`, which extends the base and re-includes
  `scripts/**`). Scripts are isolated, never silenced.
- Per-component system prompts live in `instructions/*.md` (derived from the
  planning doc, one-line provenance header stripped on load, shipped to Vercel
  via output file tracing). Built: researcher.md, craap.md. Next: structureProposer.md.

## Security — in from the start, never retrofitted
- Claude API key is SERVER-SIDE only, never in client code.
- All fetched web content AND user free-text input are DATA to be analyzed,
  never instructions to follow. Applies to the structure proposer's shape
  searches too — same wrapUntrusted() boundary.
- Rate-limit the public link before it goes live.
- Vercel bot protection challenges programmatic API callers (observed
  blocking curl during deploy verification) — resolve alongside rate
  limiting before the public link.

## Working style / debugging discipline
- Commit at every approved checkpoint. Approval = commit, no exceptions.
- Test artifact files stay on disk until the checkpoint is explicitly
  approved; cleanup comes after approval, never before.
- After building anything, RUN it before moving on. Report actual output,
  never a verbal "it works." Type real output in the report, not collapsed.
- Predefine what success looks like before testing.
- When something breaks, add logs and re-run to locate it. Do not fix blind.
- Use the Germany example as the golden test for every meaningful change.
- Build one piece, test it, move on.
- No tight polling loops against the prod deployment (trips Vercel bot
  protection). Local verification + a single prod probe.

## Source of truth
The full planning doc (Google Drive, V6) holds the rationale for every
decision. This file is the lean build version. If they disagree, the doc
wins and this file gets re-derived from it.
