import MapWidget from '../components/MapWidget';

function Map() {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold text-white">Airspace Visualisation</h2>
        <p className="mt-1 text-sm text-slate-400">
          Layer different telemetry streams to track air, sea, and ground assets in real time.
        </p>
      </header>
      <MapWidget status="Interactive layers disabled in static preview" />
    </div>
  );
}

export default Map;
