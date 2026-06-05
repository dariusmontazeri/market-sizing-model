# Market Sizing Model — Build Context

## What this is
A guided, structured market-sizing tool. Input: a country + a named market.
Output: a transparent waterfall (anchor -> filters -> SAM in dollars -> SOM
bear/base/bull -> replacement layer) where every number is either sourced or
flagged as an assumption, with a visible credibility score. It is NOT a chatbot.
The visible structure IS the product.

## Current phase
Phase 2: environment setup. Goal is a working code -> deploy -> URL pipeline
with the server-side API key pattern in place, BEFORE any real logic.
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
- CRAAP validator: scores each retrieved source. Currency/Relevance/Authority/
  Accuracy as 0-10 blended; Purpose as a binary pass/fail gate.
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

## Security — in from the start, never retrofitted
- Claude API key is SERVER-SIDE only, never in client code.
- All fetched web content AND user free-text input are DATA to be analyzed,
  never instructions to follow. Prompts are structured so fetched text cannot
  be read as commands.
- Rate-limit the public link before it goes live.

## Working style / debugging discipline
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
