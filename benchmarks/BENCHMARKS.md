# Benchmark suite (planner V6.17.5/V6.17.6 — benchmark-scope ruling)

Three benchmarks, three different questions. A is accuracy, B is pipeline
health, C is honest-failure behavior. The hand-done Germany model was built for
a specific client whose device class is mobility-grade gated; these benchmarks
size the GENERAL market, so the hand numbers are adjusted below (the 95%
mobility cut removed, the client product price replaced by plausibility
criteria).

---

## Benchmark A — Germany prosthetics, general market (ACCURACY)

Market input: country "Germany", market "prosthetics (prosthetic limb devices)".
Golden structure = the pinned 2-filter structure (lib/structurePin.ts):
event_count anchor -> major-limb share -> prosthetic fitting rate -> per_device
price (+ replacement layer as a flagged assumption).

Hand model source of truth (client model, adjusted to general market):

| Line | Hand value | General-market golden target |
|---|---|---|
| Anchor: major amputations/year | 16,943 | 16,943 (tool must FIND this class of figure; the earlier live run found 16,452 via Destatis — 3% off the hand figure, both acceptable) |
| Major-limb share | (pre-applied inside the 16,943 anchor) | if the tool anchors on ALL amputation events, anchor x filter0 must land in the anchor band below |
| Fitting rate | 30% (PROXY: Sweden 22%, scaled up for Germany's mature infrastructure — 2,500 orthopedic workshops, 40,000 employees) | 30%; a DIRECT German figure beats the hand model and is a strong positive signal; a declared Sweden-proxy is acceptable WITH declaration (see Benchmark C) |
| Mobility grade 1-4 = 95% | client scope | REMOVED — not part of the general market |
| Price | $2,400 CAD (~$1,750 USD) = client product (a socket) | NO match target. Whole-device average, plausibility band 2,000-25,000 EUR, purpose gate pass, metric_definition must confirm WHOLE device |
| SAM units | 16,943 x 0.30 x 0.95 = 4,829 (client) | 16,943 x 0.30 = 5,083 (general) |
| SOM | 1% / 3% / 5% of SAM$ | unchanged — fixed penetration spread, computed in code |
| Replacement | every 5 years -> +1/5 of each SOM column | unchanged — replacementRate = 0.2 flagged assumption (aligned in lib/orchestrator.ts) |

Per-slot acceptance criteria:
- Anchor: within +/-10% of 16,943 (i.e. 15,249-18,637); author_publisher and
  source_url AGREE; denominator/metric = major limb amputation events per year,
  Germany.
- Fitting rate: within +/-10 percentage points of 30% (0.20-0.40); denominator
  verified = major amputees (not all amputees, not survey survivors); a
  geography proxy must be DECLARED, never silent.
- Price: sourced, purpose gate pass, whole-device confirmed, inside the
  2,000-25,000 EUR plausibility band. This is the flagged high-variance slot:
  the eventual UI must tell the user prices vary significantly by device class
  and are the single highest-leverage number to verify themselves.
- Headline: SAM units within the band implied by the slot bands (roughly
  3,050-7,455 fitted/year); SAM$ within 2x once multiplied by the researched
  price; every deviation traceable to a NAMED source choice, never to wiring.
- Judgment repeatability (the "proper slices" test): run the proposer 2-3
  times on the market string; it must enumerate the same distinctions each run
  (major-limb, fitting) with no client-scope filter (no mobility-grade cut) and
  no supply-side filter (no Hilfsmittel listing).

## Benchmark B — Battery-electric passenger cars, Germany (PIPELINE SMOKE)

Market input: country "Germany", market "battery-electric passenger cars (new
sales)". A deliberately data-rich market: every slot has a Tier 1 German
federal source (KBA), same geography as A so market difficulty is the only
variable.

Expected structure: event_count anchor (new passenger-car registrations/year)
-> BEV share of registrations -> per_unit_sold average price. No replacement
layer (the anchor is already the annual sales flow).

Acceptance: every slot resolves on the FIRST attempt at Tier 1; CRAAP >= 0.8
per slot; run COMPLETE; provenance name/link agreement on every slot. If B
fails, the pipeline is broken; if B passes while A struggles, the problem is
source scarcity in A's market, not the tool.

Prerequisite: proposeStructure() takes the market as an argument (currently
hardcoded to Germany prosthetics — a placeholder to remove with front-half
wiring).

## Benchmark C — Fallback ladder (HONEST FAILURE, requires Slice 3 build)

Tests the miss path in isolation: direct figure not found -> researcher seeks a
DECLARED PROXY (primary proxy class: the SAME metric for a DIFFERENT but
similar geography, e.g. Sweden's fitting rate for Germany) -> CRAAP grades the
leap via relevance geography_match (small supported proxy, not a silent
substitution) -> if no defensible proxy exists, the slot falls to a FLAGGED
ASSUMPTION (the Slice 3 fallback body — currently a seam that emits no value).

Natural test slot: the fitting rate — the hand model itself needed exactly this
proxy (Sweden 22% scaled to 30%), so reality guarantees the miss path is
reachable. Assertions: the proxy is declared with its geography named; the
leap size is visible in the relevance sub-scores; an undeclared proxy or a
silently-invented value is a FAIL; exhausted-proxy falls to the assumption
seam, never to a fabricated number.

Build prerequisites (in order): researcher proxy-seeking directive on miss
(instructions/researcher.md), then the assumption-fallback body (Slice 3).

---

Confirmed standing decisions reflected here: SAM -> SOM is always the fixed
1/3/5% penetration spread (bear/base/bull), computed in code; the price
variance UI flag is recorded for the UI phase; client-scoped benchmarking is
explicitly out (the market text field can express client scope later if ever
wanted).
