import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * DashUAV Demo (self-contained)
 * - Simulates telemetry and detections (no backend needed)
 * - Fixes common issues: safe JSON usage, stable keys, map autofocus (Track Drone), threats filter
 * - Clean Tailwind UI
 */

// ---------- Helpers ----------
const toRad = (deg) => (deg * Math.PI) / 180;
function haversine(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return null;
  const R = 6371e3;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lon - a.lon);
  const s = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const makeId = () => {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  return c?.randomUUID ? c.randomUUID() : Math.random().toString(36).slice(2);
};
const now = () => Date.now();

// Deterministic key for events so React list rendering is stable
function eventKey(evt) {
  if (!evt) return "";
  if (evt.type?.startsWith("detection") && evt.payload?.detection_id) return `det:${evt.payload.detection_id}`;
  if (evt.type?.startsWith("telemetry") && evt.payload?.drone_id) {
    const t = typeof evt.ts === "number" ? evt.ts : Date.parse(evt.ts);
    const bucket = Math.floor(t / 250);
    return `tel:${evt.payload.drone_id}:${bucket}`;
  }
  return evt.id || `${evt.type}:${evt.ts}`;
}

// ---------- Simulated data source ----------
function useSimulator({ onTelemetry, onDetection }) {
  useEffect(() => {
    let t = 0;
    const center = { lat: 13.7563, lon: 100.5018 }; // Bangkok
    const drones = ["BLUE-1", "GOLD-2", "RED-3"];

    const interval = setInterval(() => {
      const ts = now();
      drones.forEach((id, i) => {
        const ang = t * 0.08 + i * 2.1;
        const r = 0.02 + i * 0.006;
        const lat = center.lat + Math.sin(ang) * r;
        const lon = center.lon + Math.cos(ang * 1.1) * r;
        const speed = 8 + (Math.sin(ang * 0.7) + 1) * 7; // m/s ~ 15-45kts
        const bearing = ((ang * 57.3) % 360 + 360) % 360;
        const battery = Math.max(5, 98 - t * 0.2 - i * 3);
        onTelemetry?.({
          id: makeId(), ts, type: "telemetry:update",
          payload: { drone_id: id, lat, lon, speed, bearing, altitude: 65 + i*5, battery: Math.round(battery) }
        });
      });

      if (t % 3 === 0) {
        onDetection?.({
          id: makeId(), ts: ts + 10, type: "detection:new",
          payload: {
            detection_id: makeId(),
            source: Math.random() > 0.5 ? "CAM-A1" : "CAM-B2",
            lat: center.lat + (Math.random() - 0.5) * 0.04,
            lon: center.lon + (Math.random() - 0.5) * 0.04,
            category: Math.random() > 0.6 ? "UAV" : "UNKNOWN",
            confidence: Number((0.6 + Math.random() * 0.35).toFixed(2)),
            snapshot_url: "https://placehold.co/640x360/e74c3c/ffffff?text=Detection"
          }
        });
      }
      t++;
    }, 1200);
    return () => clearInterval(interval);
  }, [onTelemetry, onDetection]);
}

// ---------- Map (Leaflet) ----------
function MapView({ center, items, trackTarget, onReady }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  // initialize
  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: true }).setView([center.lat, center.lon], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    mapRef.current = map;
    onReady?.(map);
    return () => map.remove();
  }, []);

  // update markers
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    // clear
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    // add
    for (const it of items) {
      const { lat, lon, type } = it;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const color = type === "detection" ? "red" : "blue";
      const icon = L.divIcon({ className: "", html: `<div style="width:10px;height:10px;border-radius:50%;background:${color};box-shadow:0 0 0 2px white"></div>` });
      const m = L.marker([lat, lon], { icon }).addTo(map);
      markersRef.current.push(m);
    }
  }, [items]);

  // Track target
  useEffect(() => {
    const map = mapRef.current; if (!map || !trackTarget) return;
    if (Number.isFinite(trackTarget.lat) && Number.isFinite(trackTarget.lon)) {
      map.setView([trackTarget.lat, trackTarget.lon]);
    }
  }, [trackTarget]);

  return <div ref={mapEl} className="w-full h-[420px] rounded-xl overflow-hidden border" />;
}

// ---------- Panels ----------
function StatPill({ label, value }) {
  return (
    <div className="px-3 py-2 rounded-xl bg-gray-50 border text-sm flex items-center gap-2">
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function Sidebar({ telemetry, detections, filterThreats, onPick, selected }) {
  const tel = useMemo(() => telemetry.slice().sort((a,b) => b.ts - a.ts), [telemetry]);
  const det = useMemo(() => detections.slice().sort((a,b) => b.ts - a.ts), [detections]);
  const detFiltered = filterThreats ? det.filter(d => (d.payload?.category ?? "").toUpperCase() !== "UNKNOWN") : det;

  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-xl shadow-sm">
        <div className="px-4 py-3 border-b font-semibold">ดรอน (Telemetry)</div>
        <div className="p-3 divide-y max-h-60 overflow-auto">
          {tel.map((t) => (
            <button key={eventKey(t)} onClick={() => onPick?.(t)} className={`w-full text-left py-2 ${selected?.payload?.drone_id===t.payload?.drone_id?"bg-blue-50":""}`}>
              <div className="font-semibold">{t.payload?.drone_id}</div>
              <div className="text-xs text-gray-600">📍 {t.payload?.lat?.toFixed(5)}, {t.payload?.lon?.toFixed(5)} • {Math.round(t.payload?.speed ?? 0)} m/s</div>
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white border rounded-xl shadow-sm">
        <div className="px-4 py-3 border-b font-semibold flex items-center justify-between">
          <span>ภัยคุกคาม (Detections)</span>
          <span className="text-xs text-gray-500">{detFiltered.length}</span>
        </div>
        <div className="p-3 divide-y max-h-60 overflow-auto">
          {detFiltered.map((d) => (
            <button key={eventKey(d)} onClick={() => onPick?.(d)} className={`w-full text-left py-2 ${selected?.payload?.detection_id===d.payload?.detection_id?"bg-red-50":""}`}>
              <div className="font-semibold text-red-700">{d.payload?.category}</div>
              <div className="text-xs text-gray-600">📍 {d.payload?.lat?.toFixed(5)}, {d.payload?.lon?.toFixed(5)} • ✓ {Math.round((d.payload?.confidence ?? 0)*100)}%</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Main App ----------
export default function App() {
  const [telemetry, setTelemetry] = useState([]);
  const [detections, setDetections] = useState([]);
  const [selected, setSelected] = useState(null);
  const [track, setTrack] = useState(true);
  const [onlyThreats, setOnlyThreats] = useState(false);

  // Ingest from simulator
  useSimulator({
    onTelemetry: (evt) => setTelemetry((prev) => {
      const next = [...prev, evt].slice(-80);
      return next;
    }),
    onDetection: (evt) => setDetections((prev) => [...prev, evt].slice(-50)),
  });

  const latestByDrone = useMemo(() => {
    const m = new Map();
    for (const t of telemetry) {
      const id = t.payload?.drone_id;
      if (!id) continue;
      const old = m.get(id);
      if (!old || t.ts > old.ts) m.set(id, t);
    }
    return [...m.values()].sort((a,b) => b.ts - a.ts);
  }, [telemetry]);

  const threats = useMemo(() => {
    return detections.filter(d => (d.payload?.category ?? "").toUpperCase() !== "UNKNOWN");
  }, [detections]);

  const mapItems = useMemo(() => {
    const a = latestByDrone.map(t => ({ type: "telemetry", lat: t.payload?.lat, lon: t.payload?.lon }));
    const b = (onlyThreats ? threats : detections).map(d => ({ type: "detection", lat: d.payload?.lat, lon: d.payload?.lon }));
    return [...a, ...b];
  }, [latestByDrone, detections, onlyThreats, threats]);

  const trackTarget = useMemo(() => {
    if (!track || latestByDrone.length === 0) return null;
    return { lat: latestByDrone[0].payload?.lat, lon: latestByDrone[0].payload?.lon };
  }, [track, latestByDrone]);

  // UI selections
  const pick = useCallback((it) => setSelected(it), []);

  // quick stats
  const totalKm = useMemo(() => {
    if (latestByDrone.length < 2) return "—";
    const d = haversine(
      { lat: latestByDrone[0].payload?.lat, lon: latestByDrone[0].payload?.lon },
      { lat: latestByDrone[latestByDrone.length-1].payload?.lat, lon: latestByDrone[latestByDrone.length-1].payload?.lon },
    );
    return d ? (d/1000).toFixed(2)+" กม." : "—";
  }, [latestByDrone]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-col md:flex-row gap-4">
        <div className="md:w-2/3">
          <div className="bg-white border rounded-xl shadow-sm p-3 md:p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="font-semibold">DashUAV – Realtime Map (Sim)</div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={track} onChange={e=>setTrack(e.target.checked)} /> Track Drone</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyThreats} onChange={e=>setOnlyThreats(e.target.checked)} /> Show Threats Only</label>
              </div>
            </div>
            <MapView center={{ lat: 13.7563, lon: 100.5018 }} items={mapItems} trackTarget={trackTarget} />
            <div className="mt-3 flex gap-2">
              <StatPill label="Drones" value={latestByDrone.length} />
              <StatPill label="Detections" value={detections.length} />
              <StatPill label="Threats" value={threats.length} />
              <StatPill label="Span" value={totalKm} />
            </div>
          </div>
        </div>
        <div className="md:w-1/3">
          <Sidebar telemetry={latestByDrone} detections={detections} filterThreats={onlyThreats} onPick={pick} selected={selected} />
        </div>
      </div>
      <div className="text-xs text-gray-500">* Demo is simulated. Integrate with your backend by replacing <code>useSimulator</code> with a realtime hook (WebSocket/HTTP).</div>
    </div>
  );
}
