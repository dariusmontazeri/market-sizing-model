"use client";

import { useState } from "react";
import { sizeUnitsBased, type SizingInput, type SizingResult } from "../lib/units-math";

// Hardcoded Germany prosthetics inputs — Phase 3 pipeline proof ONLY.
// UNVALIDATED PLACEHOLDERS: these are not researched and are NOT checked
// against the hand-done Germany figures (accuracy is Phase 4). The real anchor
// and filters will come from the researcher agent in a later phase. Do not
// build upstream population math or a research step to derive these.
const GERMANY_PROSTHETICS_PLACEHOLDER: SizingInput = {
  anchor: 84_000_000, // Germany population — UNVALIDATED placeholder single anchor
  filters: [0.0019, 0.78], // [share with relevant limb loss, share who are device candidates] — placeholder
  unitPrice: 7_500, // $ per prosthetic device — placeholder
  replacementRate: 0.22, // recurring replacement layer as a fraction of SOM — placeholder
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const somScenarios = [
  { key: "bear", label: "Bear", rate: "1%" },
  { key: "base", label: "Base", rate: "3%" },
  { key: "bull", label: "Bull", rate: "5%" },
] as const;

export default function Home() {
  const [result, setResult] = useState<SizingResult | null>(null);
  const [researcherOut, setResearcherOut] = useState<string | null>(null);
  const [craapOut, setCraapOut] = useState<string | null>(null);

  // Dev-only trigger: researcher (live web search), then CRAAP validator on
  // its skeleton. Two isolated server calls; the validator sees only
  // slot + skeleton, never the researcher's reasoning. No Claude logic and
  // no key ever exist client-side.
  const runResearcherPipe = async () => {
    setCraapOut(null);
    setResearcherOut("…calling /api/researcher (live search, ~1 min)…");
    try {
      const res = await fetch("/api/researcher", { method: "POST" });
      const researcher = await res.json();
      setResearcherOut(JSON.stringify(researcher, null, 2));
      if (!researcher.ok) return;

      setCraapOut("…calling /api/craap…");
      const craapRes = await fetch("/api/craap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slot: researcher.slot,
          skeleton: researcher.skeleton,
        }),
      });
      setCraapOut(JSON.stringify(await craapRes.json(), null, 2));
    } catch (e) {
      setResearcherOut(`Request failed: ${String(e)}`);
    }
  };

  const runSizing = () => {
    // All arithmetic lives in lib/units-math.ts; the UI only renders what it returns.
    setResult(sizeUnitsBased(GERMANY_PROSTHETICS_PLACEHOLDER));
  };

  const pending = (
    <span className="text-sm italic text-zinc-300">— pending —</span>
  );

  // Each waterfall row renders a value from `result`; nothing is computed here.
  const waterfallRows: { label: string; node: React.ReactNode }[] = [
    {
      label: "Market definition",
      node: result ? (
        <span className="text-sm">
          Germany · Prosthetics{" "}
          <span className="text-zinc-400">(placeholder inputs)</span>
        </span>
      ) : (
        pending
      ),
    },
    {
      label: "Anchor",
      node: result ? (
        <span className="text-sm">
          {num.format(result.inputs.anchor)}{" "}
          <span className="text-zinc-400">starting population</span>
        </span>
      ) : (
        pending
      ),
    },
    {
      label: "Filters",
      node: result ? (
        <span className="text-sm">
          {result.filterChain
            .map(
              (s) => `× ${s.rate} → ${num.format(Math.round(s.countAfter))}`,
            )
            .join("   ·   ")}
        </span>
      ) : (
        pending
      ),
    },
    {
      label: "Average price",
      node: result ? (
        // Pull the per-unit price from the same input the math uses, so the
        // two can't drift. States the price only — no multiplication, no SAM.
        <span className="text-sm">
          {usd.format(result.inputs.unitPrice)} per unit
        </span>
      ) : (
        pending
      ),
    },
    {
      label: "Replacement layer",
      node: result ? (
        <span className="text-sm">
          +{Math.round(result.replacementHonestyCheck.replacementRate * 100)}%
          recurring → {usd.format(result.som.bear.replacementDollars)} ·{" "}
          {usd.format(result.som.base.replacementDollars)} ·{" "}
          {usd.format(result.som.bull.replacementDollars)}
        </span>
      ) : (
        pending
      ),
    },
  ];

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Market Sizing Model</h1>
        <p className="text-sm text-zinc-500">
          Units-based method — Phase 3 (deterministic pipeline)
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Input
        </h2>
        <div className="space-y-3 rounded border border-zinc-200 p-4">
          <label className="block">
            <span className="mb-1 block text-sm text-zinc-700">Country</span>
            <input
              type="text"
              placeholder="e.g. Germany"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-zinc-700">Market</span>
            <input
              type="text"
              placeholder="e.g. Prosthetics"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>
          <p className="text-xs text-zinc-400">
            Note: these fields don&apos;t drive the numbers yet. &quot;Run
            sizing&quot; uses hardcoded placeholder Germany inputs to prove the
            math pipeline; real values come from the researcher agent later.
          </p>
          <button
            type="button"
            onClick={runSizing}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Run sizing
          </button>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Waterfall
        </h2>
        <ol className="divide-y divide-zinc-200 rounded border border-zinc-200">
          {waterfallRows.map((row, i) => (
            <li
              key={row.label}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <span className="text-sm">
                <span className="mr-3 text-zinc-400">{i + 1}.</span>
                {row.label}
              </span>
              <span className="text-right">{row.node}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Output
        </h2>

        <div className="space-y-1 rounded border border-zinc-200 p-4">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            SAM
          </div>
          <div className={result ? "text-2xl" : "text-2xl text-zinc-300"}>
            {result ? usd.format(result.samDollars) : "— pending —"}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {somScenarios.map((s) => (
            <div
              key={s.label}
              className="space-y-1 rounded border border-zinc-200 p-4 text-center"
            >
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                {s.label} ({s.rate})
              </div>
              <div className={result ? "text-xl" : "text-xl text-zinc-300"}>
                {result ? usd.format(result.som[s.key].somDollars) : "—"}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-1 rounded border border-zinc-200 p-4">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Credibility score
          </div>
          {/* Stays pending until the CRAAP validator exists — never faked. */}
          <div className="text-2xl text-zinc-300">— pending —</div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Researcher (dev)
        </h2>
        <div className="space-y-3 rounded border border-dashed border-zinc-300 p-4">
          <button
            type="button"
            onClick={runResearcherPipe}
            className="rounded border border-zinc-400 px-4 py-2 text-sm font-medium hover:bg-zinc-100"
          >
            Run researcher → CRAAP
          </button>
          {researcherOut && (
            <>
              <div className="text-xs font-semibold text-zinc-500">
                Researcher
              </div>
              <pre className="overflow-x-auto rounded bg-zinc-50 p-3 text-xs text-zinc-700">
                {researcherOut}
              </pre>
            </>
          )}
          {craapOut && (
            <>
              <div className="text-xs font-semibold text-zinc-500">
                CRAAP validator
              </div>
              <pre className="overflow-x-auto rounded bg-zinc-50 p-3 text-xs text-zinc-700">
                {craapOut}
              </pre>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
