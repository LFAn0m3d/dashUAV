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

const DEFENSE_DRONE_PATTERNS = [/BLUE/i, /GOLD/i, /ALLY/i];
const classifyDroneSide = (id) => {
  if (!id) return "offense";
  return DEFENSE_DRONE_PATTERNS.some((re) => re.test(id)) ? "defense" : "offense";
};

const classifyDetectionSide = (source) => {
  if (!source) return "offense";
  return /A/i.test(source) ? "defense" : "offense";
};

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
function StatPill({ label, value, accent }) {
  const accentStyles = accent
    ? {
        accent: accent.accent ?? "#1f2937",
        soft: accent.soft ?? "#f3f4f6",
        muted: accent.muted ?? "#4b5563",
      }
    : null;
  const style = accentStyles
    ? {
        borderColor: accentStyles.accent,
        backgroundColor: accentStyles.soft,
        color: accentStyles.accent,
      }
    : undefined;
  const labelStyle = accentStyles ? { color: accentStyles.muted } : undefined;
  return (
    <div
      className="px-3 py-2 rounded-xl border text-sm flex items-center gap-2"
      style={style}
    >
      <span className="text-gray-500" style={labelStyle}>
        {label}
      </span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function Sidebar({
  telemetry,
  detections,
  filterThreats,
  onPick,
  selected,
  titles,
  accent,
}) {
  const accentStyles = accent ?? {
    accent: "#1f2937",
    muted: "#4b5563",
    soft: "#f9fafb",
    border: "#e5e7eb",
  };
  const tel = useMemo(() => telemetry.slice().sort((a,b) => b.ts - a.ts), [telemetry]);
  const det = useMemo(() => detections.slice().sort((a,b) => b.ts - a.ts), [detections]);
  const detFiltered = filterThreats ? det.filter(d => (d.payload?.category ?? "").toUpperCase() !== "UNKNOWN") : det;

  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-xl shadow-sm">
        <div
          className="px-4 py-3 border-b font-semibold"
          style={{
            backgroundColor: accentStyles.soft,
            borderColor: accentStyles.border,
            color: accentStyles.accent,
          }}
        >
          {titles?.telemetry ?? "ดรอน (Telemetry)"}
        </div>
        <div className="p-3 divide-y max-h-60 overflow-auto">
          {tel.map((t) => {
            const isActive = selected?.payload?.drone_id === t.payload?.drone_id;
            return (
              <button
                key={eventKey(t)}
                onClick={() => onPick?.(t)}
                className="w-full text-left py-2 px-2 rounded-lg transition"
                style={
                  isActive
                    ? {
                        backgroundColor: accentStyles.soft,
                        color: accentStyles.accent,
                        boxShadow: "inset 0 0 0 1px " + accentStyles.border,
                      }
                    : undefined
                }
              >
                <div className="font-semibold">{t.payload?.drone_id}</div>
                <div className="text-xs text-gray-600">📍 {t.payload?.lat?.toFixed(5)}, {t.payload?.lon?.toFixed(5)} • {Math.round(t.payload?.speed ?? 0)} m/s</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="bg-white border rounded-xl shadow-sm">
        <div
          className="px-4 py-3 border-b font-semibold flex items-center justify-between"
          style={{
            backgroundColor: accentStyles.soft,
            borderColor: accentStyles.border,
            color: accentStyles.accent,
          }}
        >
          <span>{titles?.detections ?? "ภัยคุกคาม (Detections)"}</span>
          <span className="text-xs text-gray-500">{detFiltered.length}</span>
        </div>
        <div className="p-3 divide-y max-h-60 overflow-auto">
          {detFiltered.map((d) => {
            const isActive = selected?.payload?.detection_id === d.payload?.detection_id;
            return (
              <button
                key={eventKey(d)}
                onClick={() => onPick?.(d)}
                className="w-full text-left py-2 px-2 rounded-lg transition"
                style={
                  isActive
                    ? {
                        backgroundColor: accentStyles.soft,
                        color: accentStyles.accent,
                        boxShadow: "inset 0 0 0 1px " + accentStyles.border,
                      }
                    : undefined
                }
              >
                <div className="font-semibold" style={{ color: accentStyles.accent }}>
                  {d.payload?.category}
                </div>
                <div className="text-xs text-gray-600">📍 {d.payload?.lat?.toFixed(5)}, {d.payload?.lon?.toFixed(5)} • ✓ {Math.round((d.payload?.confidence ?? 0)*100)}%</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- Main App ----------
export default function App() {
  const [telemetry, setTelemetry] = useState([]);
  const [detections, setDetections] = useState([]);
  const [activeSide, setActiveSide] = useState("defense");
  const [selectedBySide, setSelectedBySide] = useState({ defense: null, offense: null });
  const [viewPrefs, setViewPrefs] = useState({
    defense: { track: true, onlyThreats: false },
    offense: { track: true, onlyThreats: false },
  });

  const SIDE_STYLES = useMemo(() => ({
    defense: {
      accent: "#047857",
      muted: "#0f5132",
      soft: "#ecfdf5",
      border: "#a7f3d0",
      label: "ฝั่งรับ",
      description: "ภาพรวมหน่วยตรวจการณ์และป้องกันภัยคุกคาม",
      center: { lat: 13.7563, lon: 100.5018 },
    },
    offense: {
      accent: "#b91c1c",
      muted: "#7f1d1d",
      soft: "#fef2f2",
      border: "#fecaca",
      label: "ฝั่งรุก",
      description: "ภาพรวมหน่วยโจมตีและเข้าตีเชิงรุก",
      center: { lat: 13.8563, lon: 100.7018 },
    },
  }), []);

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

  const telemetryBySide = useMemo(() => {
    const bucket = { defense: [], offense: [] };
    for (const t of latestByDrone) {
      const side = classifyDroneSide(t.payload?.drone_id);
      bucket[side].push(t);
    }
    return bucket;
  }, [latestByDrone]);

  const detectionsBySide = useMemo(() => {
    const bucket = { defense: [], offense: [] };
    for (const d of detections) {
      const side = classifyDetectionSide(d.payload?.source);
      bucket[side].push(d);
    }
    return bucket;
  }, [detections]);

  const threatsBySide = useMemo(() => {
    const next = { defense: [], offense: [] };
    for (const side of ["defense", "offense"]) {
      next[side] = detectionsBySide[side].filter(
        (d) => (d.payload?.category ?? "").toUpperCase() !== "UNKNOWN"
      );
    }
    return next;
  }, [detectionsBySide]);

  const meta = SIDE_STYLES[activeSide];
  const currentPrefs = viewPrefs[activeSide];
  const currentSelected = selectedBySide[activeSide];
  const sideTelemetry = telemetryBySide[activeSide] ?? [];
  const sideDetections = detectionsBySide[activeSide] ?? [];
  const sideThreats = threatsBySide[activeSide] ?? [];

  const mapItems = useMemo(() => {
    const aircraft = sideTelemetry.map((t) => ({
      type: "telemetry",
      lat: t.payload?.lat,
      lon: t.payload?.lon,
    }));
    const detectionsList = currentPrefs.onlyThreats ? sideThreats : sideDetections;
    const hostile = detectionsList.map((d) => ({
      type: "detection",
      lat: d.payload?.lat,
      lon: d.payload?.lon,
    }));
    return [...aircraft, ...hostile];
  }, [sideTelemetry, sideDetections, sideThreats, currentPrefs.onlyThreats]);

  const trackTarget = useMemo(() => {
    if (!currentPrefs.track || sideTelemetry.length === 0) return null;
    return {
      lat: sideTelemetry[0].payload?.lat,
      lon: sideTelemetry[0].payload?.lon,
    };
  }, [currentPrefs.track, sideTelemetry]);

  const totalKm = useMemo(() => {
    if (sideTelemetry.length < 2) return "—";
    const d = haversine(
      { lat: sideTelemetry[0].payload?.lat, lon: sideTelemetry[0].payload?.lon },
      {
        lat: sideTelemetry[sideTelemetry.length - 1].payload?.lat,
        lon: sideTelemetry[sideTelemetry.length - 1].payload?.lon,
      },
    );
    return d ? (d / 1000).toFixed(2) + " กม." : "—";
  }, [sideTelemetry]);

  const pick = useCallback(
    (item) => {
      setSelectedBySide((prev) => ({ ...prev, [activeSide]: item }));
    },
    [activeSide],
  );

  const updatePref = useCallback(
    (key, value) => {
      setViewPrefs((prev) => ({
        ...prev,
        [activeSide]: { ...prev[activeSide], [key]: value },
      }));
    },
    [activeSide],
  );

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <div className="text-xl font-semibold">DashUAV – เปรียบเทียบยุทธการสองฝั่ง</div>
          <div className="text-sm text-gray-600">สลับดูสถานการณ์ระหว่างฝั่งรับและฝั่งรุก พร้อมแผนที่เฉพาะของแต่ละทีม</div>
        </div>
        <div className="flex gap-2">
          {(["defense", "offense"]).map((sideKey) => {
            const info = SIDE_STYLES[sideKey];
            const isActive = activeSide === sideKey;
            return (
              <button
                key={sideKey}
                onClick={() => setActiveSide(sideKey)}
                className={`px-4 py-2 rounded-full border text-sm font-semibold transition`}
                style={{
                  backgroundColor: isActive ? info.accent : "#ffffff",
                  color: isActive ? "#ffffff" : "#4b5563",
                  borderColor: isActive ? info.accent : "#d1d5db",
                  boxShadow: isActive ? "0 10px 20px -12px rgba(0,0,0,0.4)" : "none",
                }}
              >
                {info.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="bg-white border rounded-2xl shadow-lg overflow-hidden">
        <div className="h-1" style={{ backgroundColor: meta.accent }} />
        <div className="p-4 md:p-6 space-y-5">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="md:w-2/3 space-y-4">
              <div>
                <div className="text-lg font-semibold" style={{ color: meta.accent }}>{meta.label}</div>
                <div className="text-sm text-gray-600">{meta.description}</div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={currentPrefs.track}
                    onChange={(e) => updatePref("track", e.target.checked)}
                  />
                  ติดตามอากาศยาน
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={currentPrefs.onlyThreats}
                    onChange={(e) => updatePref("onlyThreats", e.target.checked)}
                  />
                  แสดงเฉพาะภัยคุกคาม
                </label>
              </div>
              <MapView
                key={activeSide}
                center={meta.center}
                items={mapItems}
                trackTarget={trackTarget}
              />
              <div className="flex flex-wrap gap-2">
                <StatPill label="Drones" value={sideTelemetry.length} accent={meta} />
                <StatPill label="Detections" value={sideDetections.length} accent={meta} />
                <StatPill label="Threats" value={sideThreats.length} accent={meta} />
                <StatPill label="Span" value={totalKm} accent={meta} />
              </div>
            </div>
            <div className="md:w-1/3">
              <Sidebar
                telemetry={sideTelemetry}
                detections={sideDetections}
                filterThreats={currentPrefs.onlyThreats}
                onPick={pick}
                selected={currentSelected}
                titles={{
                  telemetry: `${meta.label} – โดรน`,
                  detections: `${meta.label} – การตรวจจับ`,
                }}
                accent={meta}
              />
            </div>
          </div>
          {currentSelected && (
            <div className="bg-gray-50 border rounded-xl p-4 text-sm space-y-1">
              <div className="font-semibold text-gray-700">จุดที่เลือก</div>
              <div className="text-gray-600">
                {currentSelected.type?.includes("telemetry")
                  ? `โดรน ${currentSelected.payload?.drone_id} – ${currentSelected.payload?.lat?.toFixed(5)}, ${currentSelected.payload?.lon?.toFixed(5)}`
                  : `การตรวจจับ ${currentSelected.payload?.category ?? "UNKNOWN"} – ${currentSelected.payload?.lat?.toFixed(5)}, ${currentSelected.payload?.lon?.toFixed(5)}`}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-500">* Demo จำลองข้อมูล เพื่อเชื่อมต่อระบบจริงสามารถแทนที่ <code>useSimulator</code> ด้วย hook ที่เชื่อมต่อ Backend/Realtime</div>
    </div>
  );
}
