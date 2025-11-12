import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';

type LatLngTuple = [number, number];

type ThreatLevel = 'high' | 'med' | 'low';

interface Threat {
  id: string;
  name: string;
  level: ThreatLevel;
  lat: number;
  lng: number;
}

const START_CENTER: LatLngTuple = [13.7563, 100.5018];

// Fix Leaflet default marker icon
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(delete (L.Icon.Default.prototype as any)._getIconUrl);
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const THREATS: Threat[] = [
  { id: 't1', name: 'RF Jammer', level: 'high', lat: 13.7563, lng: 100.5018 },
  { id: 't2', name: 'No-fly Zone', level: 'med', lat: 13.744, lng: 100.53 },
  { id: 't3', name: 'Interference', level: 'low', lat: 13.77, lng: 100.48 },
];

const threatStyles: Record<ThreatLevel, { background: string; border: string; glow: string; text: string }> = {
  high: {
    background: 'rgba(239,68,68,.2)',
    border: '#ef4444',
    glow: 'rgba(239,68,68,.3)',
    text: 'text-rose-600',
  },
  med: {
    background: 'rgba(249,115,22,.2)',
    border: '#f97316',
    glow: 'rgba(249,115,22,.3)',
    text: 'text-orange-600',
  },
  low: {
    background: 'rgba(234,179,8,.2)',
    border: '#eab308',
    glow: 'rgba(234,179,8,.3)',
    text: 'text-yellow-600',
  },
};

function filterThreats(showThreatsOnly: boolean, threats: Threat[]): Threat[] {
  if (!showThreatsOnly) return threats;
  return threats.filter((threat) => threat.level !== 'low');
}

function nextDronePos(tick: number, start: LatLngTuple, radius = 0.02): LatLngTuple {
  const angle = ((tick % 360) * Math.PI) / 180;
  const lat = start[0] + radius * Math.cos(angle);
  const lng = start[1] + radius * Math.sin(angle);
  return [lat, lng];
}

function computeCenter(pos: LatLngTuple | null, fallback: LatLngTuple): LatLngTuple {
  if (Array.isArray(pos) && pos.length === 2 && pos.every((value) => typeof value === 'number')) {
    return pos as LatLngTuple;
  }
  return fallback;
}

interface FlyToProps {
  enabled: boolean;
  position: LatLngTuple | null;
  zoom?: number;
}

function FlyTo({ enabled, position, zoom = 16 }: FlyToProps) {
  const map = useMap();

  useEffect(() => {
    if (!enabled || !position) return;
    map.flyTo(position, zoom, { duration: 0.6 });
  }, [enabled, map, position, zoom]);

  return null;
}

function useMockDrone(start: LatLngTuple = START_CENTER) {
  const [pos, setPos] = useState<LatLngTuple | null>(null);
  const [trail, setTrail] = useState<LatLngTuple[]>([]);
  const tick = useRef(0);

  useEffect(() => {
    setPos(start);
    setTrail([start]);

    const id = window.setInterval(() => {
      tick.current += 1;
      const next = nextDronePos(tick.current, start, 0.02);
      setPos(next);
      setTrail((prev) => (prev.length > 400 ? [...prev.slice(-300), next] : [...prev, next]));
    }, 1000);

    return () => window.clearInterval(id);
  }, [start[0], start[1]]);

  return { pos, trail };
}

export default function OSMDroneMap() {
  const { pos, trail } = useMockDrone();
  const [trackDrone, setTrackDrone] = useState(true);
  const [showThreatsOnly, setShowThreatsOnly] = useState(false);

  const center = useMemo(() => computeCenter(pos, START_CENTER), [pos]);
  const visibleThreats = useMemo(() => filterThreats(showThreatsOnly, THREATS), [showThreatsOnly]);

  const droneIcon = useMemo(
    () =>
      L.divIcon({
        className: 'drone-marker',
        html:
          '<div style="width:24px;height:24px;border-radius:9999px;background:rgba(59,130,246,.15);border:2px solid #3b82f6;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px rgba(59,130,246,.2);">' +
          '<span style="width:8px;height:8px;border-radius:9999px;background:#3b82f6;display:block"></span>' +
          '</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    [],
  );

  const threatIcon = useMemo(
    () =>
      (level: ThreatLevel) => {
        const { background, border, glow } = threatStyles[level];
        return L.divIcon({
          className: 'threat-marker',
          html: `<div style="width:28px;height:28px;border-radius:9999px;background:${background};border:2px solid ${border};display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px ${glow};"><span style="font-size:14px;">⚠️</span></div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
      },
    [],
  );

  return (
    <div className="space-y-6">
      <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-xl shadow-slate-950/40">
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-white md:text-3xl">🚁 UAV Tracking Dashboard</h1>
          <p className="text-sm text-slate-300 md:text-base">Real-time drone position and threat monitoring system</p>
        </div>

        <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
          <div className="absolute left-4 top-4 z-[1000] flex flex-wrap gap-2">
            <button
              onClick={() => setTrackDrone((prev) => !prev)}
              className={`px-4 py-2 text-sm font-medium transition-all active:scale-95 md:text-base ${
                trackDrone
                  ? 'rounded-xl border border-blue-400/60 bg-blue-500 text-white shadow-lg shadow-blue-500/30'
                  : 'rounded-xl border border-slate-700/80 bg-slate-900 text-slate-200 shadow-lg shadow-slate-900/40 hover:border-blue-400/60'
              }`}
            >
              {trackDrone ? '📍 Tracking Drone' : '📍 Track Drone'}
            </button>
            <button
              onClick={() => setShowThreatsOnly((prev) => !prev)}
              className={`px-4 py-2 text-sm font-medium transition-all active:scale-95 md:text-base ${
                showThreatsOnly
                  ? 'rounded-xl border border-rose-400/60 bg-rose-500 text-white shadow-lg shadow-rose-500/30'
                  : 'rounded-xl border border-slate-700/80 bg-slate-900 text-slate-200 shadow-lg shadow-slate-900/40 hover:border-rose-400/60'
              }`}
            >
              {showThreatsOnly ? '⚠️ High Threats Only' : '⚠️ All Threats'}
            </button>
          </div>

          <div className="absolute right-4 top-4 z-[1000] max-w-xs rounded-xl border border-slate-700/80 bg-slate-900/80 p-4 backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">System Status</div>
            <div className="mt-2 space-y-2 text-sm text-slate-200">
              <div className="flex justify-between">
                <span className="text-slate-400">Drone Position:</span>
                <span className="font-mono">
                  {pos ? `${pos[0].toFixed(4)}, ${pos[1].toFixed(4)}` : 'Acquiring...'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Trail Points:</span>
                <span className="font-semibold text-blue-400">{trail.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Threats Visible:</span>
                <span className="font-semibold text-rose-400">{visibleThreats.length}</span>
              </div>
            </div>
          </div>

          <MapContainer center={center} zoom={13} className="h-[500px] w-full" scrollWheelZoom>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap contributors" />

            {trail.length > 1 && (
              <Polyline
                positions={trail}
                pathOptions={{
                  color: '#3b82f6',
                  weight: 3,
                  opacity: 0.6,
                  dashArray: '10, 10',
                }}
              />
            )}

            {pos && (
              <Marker position={pos} icon={droneIcon}>
                <Popup>
                  <div className="text-sm">
                    <div className="mb-2 font-bold text-blue-500">🚁 UAV #A1</div>
                    <div className="space-y-1 text-slate-800">
                      <div>
                        <span className="font-semibold">Lat:</span> {pos[0].toFixed(5)}
                      </div>
                      <div>
                        <span className="font-semibold">Lng:</span> {pos[1].toFixed(5)}
                      </div>
                      <div>
                        <span className="font-semibold">Status:</span>{' '}
                        <span className="text-green-600">En Route</span>
                      </div>
                      <div>
                        <span className="font-semibold">Battery:</span> 87%
                      </div>
                      <div>
                        <span className="font-semibold">Altitude:</span> 120m
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            )}

            {visibleThreats.map((threat) => (
              <Marker key={threat.id} position={[threat.lat, threat.lng]} icon={threatIcon(threat.level)}>
                <Popup>
                  <div className="text-sm text-slate-900">
                    <div className={`mb-2 font-bold ${threatStyles[threat.level].text}`}>
                      ⚠️ {threat.name}
                    </div>
                    <div className="space-y-1">
                      <div>
                        <span className="font-semibold">Severity:</span>{' '}
                        <span className={`uppercase font-bold ${threatStyles[threat.level].text}`}>
                          {threat.level}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold">Lat:</span> {threat.lat}
                      </div>
                      <div>
                        <span className="font-semibold">Lng:</span> {threat.lng}
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}

            <FlyTo position={trackDrone ? pos : null} enabled={trackDrone} />
          </MapContainer>

          <div className="flex items-center justify-between border-t border-slate-800 bg-slate-950/80 px-4 py-2 text-xs text-slate-400">
            <span>Map data © OpenStreetMap contributors</span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              Live Tracking Active
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-xl shadow-slate-950/40">
        <div className="text-sm font-semibold uppercase tracking-wide text-slate-400">Legend</div>
        <div className="mt-3 grid grid-cols-2 gap-4 text-sm text-slate-200 md:grid-cols-4">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full border-2 border-blue-500 bg-blue-400/60" />
            <span>Active Drone</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full border-2 border-rose-500 bg-rose-400/60" />
            <span>High Threat</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full border-2 border-orange-500 bg-orange-400/60" />
            <span>Medium Threat</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full border-2 border-yellow-500 bg-yellow-400/60" />
            <span>Low Threat</span>
          </div>
        </div>
      </div>
    </div>
  );
}
