const waterfallSections = [
  "Market definition",
  "Anchor",
  "Filters",
  "Dollar conversion (SAM)",
  "SOM penetration (bear/base/bull)",
  "Replacement layer",
  "Output panel",
];

const somScenarios = [
  { label: "Bear", rate: "1%" },
  { label: "Base", rate: "3%" },
  { label: "Bull", rate: "5%" },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Market Sizing Model</h1>
        <p className="text-sm text-zinc-500">
          Units-based method — Phase 3 static shell
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
          <button
            type="button"
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
          {waterfallSections.map((label, i) => (
            <li
              key={label}
              className="flex items-center justify-between px-4 py-3"
            >
              <span className="text-sm">
                <span className="mr-3 text-zinc-400">{i + 1}.</span>
                {label}
              </span>
              <span className="text-sm italic text-zinc-300">— pending —</span>
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
          <div className="text-2xl text-zinc-300">— pending —</div>
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
              <div className="text-xl text-zinc-300">—</div>
            </div>
          ))}
        </div>

        <div className="space-y-1 rounded border border-zinc-200 p-4">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Credibility score
          </div>
          <div className="text-2xl text-zinc-300">— pending —</div>
        </div>
      </section>
    </main>
  );
}
