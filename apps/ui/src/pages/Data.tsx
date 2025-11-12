const DATASETS = [
  { name: 'Telemetry Stream', description: 'Historic flight telemetry captured in the last 24h', size: '32 MB' },
  { name: 'Threat Archive', description: 'All detections emitted by perimeter radars', size: '4 MB' },
  { name: 'Mission Logs', description: 'Operator annotations and mission outcomes', size: '12 MB' },
];

function Data() {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold text-white">Data Exchange</h2>
        <p className="mt-1 text-sm text-slate-400">
          Download curated snapshots for analysis, replay, or integration with external systems.
        </p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {DATASETS.map((dataset) => (
          <li key={dataset.name} className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 shadow-inner shadow-black/20">
            <h3 className="text-lg font-semibold text-slate-100">{dataset.name}</h3>
            <p className="mt-2 text-sm text-slate-400">{dataset.description}</p>
            <div className="mt-4 flex items-center justify-between text-xs uppercase tracking-wide text-slate-500">
              <span>{dataset.size}</span>
              <button
                type="button"
                className="rounded-md border border-primary/60 px-3 py-1 text-primary transition hover:bg-primary/10"
              >
                Request Export
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default Data;
