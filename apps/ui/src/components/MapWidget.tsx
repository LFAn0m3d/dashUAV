interface MapWidgetProps {
  status?: string;
}

function MapWidget({ status = 'Awaiting telemetry' }: MapWidgetProps) {
  return (
    <div className="flex h-72 flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-sm text-slate-300">
        <span>Operational Map</span>
        <span className="text-xs uppercase tracking-wide text-primary">{status}</span>
      </header>
      <div className="flex flex-1 items-center justify-center bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900">
        <div className="rounded-full border border-dashed border-slate-700 px-6 py-4 text-center text-xs uppercase tracking-widest text-slate-500">
          Map tiles disabled in preview
        </div>
      </div>
    </div>
  );
}

export default MapWidget;
