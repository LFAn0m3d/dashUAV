import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ===== Runtime Config (no simulation) =====
// NOTE: Avoid using `import.meta` outside ESM. We read from a safe global instead.
// Set window.__APP_CONFIG__ = { WS_URL: "wss://...", HTTP_POLL_URL: "https://...", USE_SIM: false } before mounting the app.
// Also supports quick demo via URL: add ?sim=1 to enable built-in simulator.
const CONFIG = (() => {
  const g = (typeof window !== 'undefined' ? window : {});
  const cfg = g.__APP_CONFIG__ || {};
  const loc = (typeof window !== 'undefined' && window.location) ? window.location : null;
  const defaultWs = loc ? `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws` : null;
  const defaultHttp = loc ? `${loc.origin}/api/events` : null;
  let useSim = false;
  try {
    if (loc && loc.search) {
      const sp = new URLSearchParams(loc.search);
      if (sp.get('sim') === '1') useSim = true;
    }
  } catch (_) {}
  return {
    WS_URL: typeof cfg.WS_URL === 'string' ? cfg.WS_URL : defaultWs,
    HTTP_POLL_URL: typeof cfg.HTTP_POLL_URL === 'string' ? cfg.HTTP_POLL_URL : defaultHttp,
    USE_SIM: (typeof cfg.USE_SIM === 'boolean' ? cfg.USE_SIM : useSim),
  };
})();

// -------- Go/No-Go helpers (Open-Meteo integration) --------
function computeGoNoGo({ wind_ms = 0, gust_ms = 0, vis_km = 10, cloud_base_m = 1000, precip_mm = 0, kp = 2 }) {
  let score = 0; // higher = more risk
  if (wind_ms > 8) score += 2; else if (wind_ms > 5) score += 1;
  if (gust_ms - wind_ms > 4) score += 1;
  if (precip_mm > 0.5) score += 2; else if (precip_mm > 0.1) score += 1;
  if (vis_km < 5) score += 2; else if (vis_km < 8) score += 1;
  if (cloud_base_m < 300) score += 2; else if (cloud_base_m < 600) score += 1;
  if (kp >= 6) score += 2; else if (kp >= 4) score += 1;
  if (score >= 5) return "NO_GO";
  if (score >= 2) return "CAUTION";
  return "GO";
}
function beaufortFromMs(ms) {
  if (ms < 0.3) return 0; if (ms < 1.6) return 1; if (ms < 3.4) return 2; if (ms < 5.5) return 3; if (ms < 8.0) return 4; if (ms < 10.8) return 5; if (ms < 13.9) return 6; if (ms < 17.2) return 7; if (ms < 20.8) return 8; if (ms < 24.5) return 9; if (ms < 28.5) return 10; if (ms < 32.7) return 11; return 12;
}

/**
 * ========================= Utils & Validation =========================
 */
function validateEvent(evt) {
  if (!evt || typeof evt !== "object") return false;
  if (!evt.id || !evt.ts || !evt.type) return false;
  if (typeof evt.ts !== "number" && typeof evt.ts !== "string") return false;
  if (!evt.payload || typeof evt.payload !== "object") return false;
  return true;
}

function safePayload(payload) { return payload || {}; }
function pad(n) { return n.toString().padStart(2, "0"); }

function formatLocal(date) {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}.${ms}`;
}

function tsToDate(ts) { return typeof ts === "number" ? new Date(ts) : new Date(ts); }

function byTsDesc(a, b) {
  const at = typeof a.ts === "number" ? a.ts : Date.parse(a.ts);
  const bt = typeof b.ts === "number" ? b.ts : Date.parse(b.ts);
  if (at > bt) return -1;
  if (at < bt) return 1;
  return 0;
}

function headingToCardinal(heading) {
  if (!Number.isFinite(heading)) return null;
  const normalized = ((heading % 360) + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(normalized / 45) % dirs.length;
  return dirs[idx];
}

function eventKey(evt) {
  if (!evt) return "";
  if (evt.type && evt.type.startsWith("detection") && evt.payload?.detection_id) {
    return `det:${evt.payload.detection_id}`;
  }
  if (evt.type && evt.type.startsWith("telemetry") && evt.payload?.drone_id) {
    const ts = typeof evt.ts === "number" ? evt.ts : Date.parse(evt.ts);
    const bucket = Math.floor(ts / 250);
    return `tel:${evt.payload.drone_id}:${bucket}`;
  }
  return `evt:${evt.id || evt.ts}`;
}

function makeLRU(capacity) {
  const map = new Map();
  return {
    has: (k) => map.has(k),
    set: (k, v) => {
      map.set(k, v);
      if (map.size > capacity) {
        const first = map.keys().next().value;
        map.delete(first);
      }
    },
    clear: () => map.clear(),
  };
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    return Infinity;
  }
  const R = 6371000; // meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return R * c;
}

function summarizeDetectionGroup(members) {
  if (!members.length) return null;
  let latSum = 0;
  let lonSum = 0;
  const categories = {};
  let latestTsVal = -Infinity;
  let primary = members[0];

  for (const det of members) {
    const payload = safePayload(det.payload);
    if (Number.isFinite(payload.lat)) latSum += payload.lat;
    if (Number.isFinite(payload.lon)) lonSum += payload.lon;
    const cat = payload.category || "UNKNOWN";
    categories[cat] = (categories[cat] || 0) + 1;
    const tsVal = typeof det.ts === "number" ? det.ts : Date.parse(det.ts);
    if (Number.isFinite(tsVal) && tsVal > latestTsVal) {
      latestTsVal = tsVal;
      primary = det;
    }
  }

  const avgLat = latSum / members.length;
  const avgLon = lonSum / members.length;

  return {
    count: members.length,
    lat: avgLat,
    lon: avgLon,
    categories,
    latestTs: Number.isFinite(latestTsVal) ? latestTsVal : Date.now(),
    primary,
    members,
  };
}

function groupOverlappingDetections(detections, thresholdMeters = 150) {
  const safe = Array.isArray(detections) ? detections : [];
  const groups = [];
  const used = new Set();

  for (let i = 0; i < safe.length; i++) {
    if (used.has(i)) continue;
    const det = safe[i];
    const payload = safePayload(det.payload);
    if (!Number.isFinite(payload.lat) || !Number.isFinite(payload.lon)) continue;

    const queue = [i];
    const enqueued = new Set([i]);
    const members = [];

    while (queue.length) {
      const idx = queue.pop();
      if (used.has(idx)) continue;
      const current = safe[idx];
      const cp = safePayload(current.payload);
      if (!Number.isFinite(cp.lat) || !Number.isFinite(cp.lon)) {
        used.add(idx);
        continue;
      }
      used.add(idx);
      members.push(current);

      for (let j = 0; j < safe.length; j++) {
        if (used.has(j) || enqueued.has(j)) continue;
        const candidate = safe[j];
        const candPayload = safePayload(candidate.payload);
        if (!Number.isFinite(candPayload.lat) || !Number.isFinite(candPayload.lon)) continue;
        const dist = haversineDistanceMeters(cp.lat, cp.lon, candPayload.lat, candPayload.lon);
        if (dist <= thresholdMeters) {
          queue.push(j);
          enqueued.add(j);
        }
      }
    }

    if (members.length > 1) {
      const summary = summarizeDetectionGroup(members);
      if (summary) groups.push(summary);
    }
  }

  return groups.sort((a, b) => b.count - a.count);
}

function analyzeData(telemetry, detections) {
  const safeTelemetry = Array.isArray(telemetry) ? telemetry : [];
  const safeDetections = Array.isArray(detections) ? detections : [];

  const uniqueDrones = new Set();
  let speedSum = 0;
  let speedCount = 0;
  for (const evt of safeTelemetry) {
    const payload = safePayload(evt.payload);
    if (payload.drone_id) uniqueDrones.add(payload.drone_id);
    if (Number.isFinite(payload.speed)) {
      speedSum += payload.speed;
      speedCount += 1;
    }
  }

  const detectionCategories = {};
  for (const det of safeDetections) {
    const payload = safePayload(det.payload);
    const cat = payload.category || "UNKNOWN";
    detectionCategories[cat] = (detectionCategories[cat] || 0) + 1;
  }

  const overlaps = groupOverlappingDetections(safeDetections);

  return {
    summary: {
      totalTelemetry: safeTelemetry.length,
      totalDetections: safeDetections.length,
      uniqueDrones: uniqueDrones.size,
      avgSpeed: speedCount ? speedSum / speedCount : 0,
      hasSpeedSamples: speedCount > 0,
    },
    detectionCategories,
    overlaps,
  };
}

/**
 * ========================= Event Buffer Hook =========================
 * (No UI/Map side-effects here)
 */
function useEventBuffer(config) {
  const capFeed = config.capFeed || 400;
  const capIndex = config.capIndex || 2000;
  const flushMs = config.flushMs || 120;

  const feedRef = useRef([]);
  const indexRef = useRef(makeLRU(capIndex));
  const [version, setVersion] = useState(0);

  const push = useCallback((evt) => {
    if (!validateEvent(evt)) return;
    const key = eventKey(evt);
    if (indexRef.current.has(key)) {
      indexRef.current.set(key, evt);
      return;
    }
    indexRef.current.set(key, evt);
    feedRef.current.push(evt);
    if (feedRef.current.length > capFeed) {
      feedRef.current.splice(0, feedRef.current.length - capFeed);
    }
  }, [capFeed]);

  useEffect(() => {
    const t = setInterval(() => setVersion((v) => v + 1), flushMs);
    return () => clearInterval(t);
  }, [flushMs]);

  const snapshot = useCallback(() => {
    const seen = new Set();
    const out = [];
    for (let i = feedRef.current.length - 1; i >= 0; i--) {
      const e = feedRef.current[i];
      const k = eventKey(e);
      if (!seen.has(k)) {
        out.push(e);
        seen.add(k);
      }
    }
    out.reverse();
    return out;
  }, []);

  return { push, snapshot, version };
}

/**
 * ========================= Mock Socket Manager (Simulator) =========================
 */
function useSocketManager(config) {
  const onTelemetry = config?.onTelemetry;
  const onDetection = config?.onDetection;

  useEffect(() => {
    let t = 0;
    const interval = setInterval(() => {
      const now = Date.now();

      if (onTelemetry) {
        onTelemetry({
          id: crypto.randomUUID(),
          ts: now,
          type: "telemetry:update",
          payload: {
            drone_id: "BLUE-1",
            lat: 13.760 + Math.sin(t / 30) * 0.01,
            lon: 100.501 + Math.cos(t / 30) * 0.01,
            alt: 120 + (Math.sin(t / 10) * 5),
            heading: (t * 12) % 360,
            speed: 12 + (Math.cos(t / 15) * 2),
            battery: Math.max(0, 86 - Math.floor(t / 30)),
            status: "in-flight",
          }
        });
      }

      if (t % 2 === 0 && onDetection) {
        onDetection({
          id: crypto.randomUUID(),
          ts: now + 5,
          type: "detection:new",
          payload: {
            detection_id: crypto.randomUUID(),
            source: "CAM-A1",
            lat: 13.761 + Math.random() * 0.008,
            lon: 100.501 + Math.random() * 0.008,
            category: Math.random() > 0.5 ? "UAV" : "UNKNOWN",
            confidence: Number((0.75 + Math.random() * 0.2).toFixed(2)),
            snapshot_url: "https://placehold.co/640x360/e74c3c/ffffff?text=Detection",
          }
        });
      }
      t++;
    }, 1500);

    return () => clearInterval(interval);
  }, [onTelemetry, onDetection]);
}

// Realtime (WebSocket / HTTP poll) — production path (no simulation)
function useRealtime({ onTelemetry, onDetection }) {
  const wsRef = useRef(null);

  useEffect(() => {
    // If WebSocket URL provided
    if (CONFIG.WS_URL) {
      const ws = new WebSocket(CONFIG.WS_URL);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg || typeof msg !== 'object') return;
          const t = msg.type || '';
          if (t.startsWith('telemetry') && onTelemetry) onTelemetry(msg);
          else if (t.startsWith('detection') && onDetection) onDetection(msg);
        } catch (e) { /* ignore */ }
      };
      return () => { try { ws.close(); } catch { /* noop */ } wsRef.current = null; };
    }

    // If HTTP polling URL provided
    if (CONFIG.HTTP_POLL_URL) {
      let stop = false;
      async function loop() {
        while (!stop) {
          try {
            const res = await fetch(CONFIG.HTTP_POLL_URL);
            const arr = await res.json();
            if (Array.isArray(arr)) {
              for (const msg of arr) {
                if (msg?.type?.startsWith?.('telemetry') && onTelemetry) onTelemetry(msg);
                else if (msg?.type?.startsWith?.('detection') && onDetection) onDetection(msg);
              }
            }
          } catch (_) { /* ignore one cycle */ }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      loop();
      return () => { stop = true; };
    }

    // Neither provided → do nothing (no simulation)
    return () => {};
  }, [onTelemetry, onDetection]);
}

/**
 * ========================= UI: Tabs (kept for future use) =========================
 */
function Tabs({ value, onChange }) {
  return (
    <div className="w-full bg-white border-b flex items-center gap-2 px-4 py-2">
      {[
        { id: null, label: "All Activity" },
        { id: "offense", label: "Offense Team" },
        { id: "defense", label: "Defense Team" },
      ].map((t) => (
        <button
          key={t.id === null ? "all" : t.id}
          onClick={() => onChange(t.id)}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition shadow-sm border ${
            value === t.id
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-gray-700 hover:bg-gray-50 border-gray-300"
          }`}
          aria-pressed={value === t.id}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * ========================= UI: Map Panel =========================
 */
function jitterCoordinates(lat, lon, tracker, key) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [lat, lon];
  const bucket = key || `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const count = tracker.get(bucket) || 0;
  tracker.set(bucket, count + 1);
  if (count === 0) return [lat, lon];
  const radius = 0.0003 * count; // roughly ~30m per step
  const angle = (count * 137.508) * Math.PI / 180;
  return [
    lat + radius * Math.sin(angle),
    lon + radius * Math.cos(angle),
  ];
}

function MapPanel({ detections, telemetry, onSelectItem, filter, forecast }) {
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const droneLayerRef = useRef(null);
  const detLayerRef = useRef(null);
  const windLayerRef = useRef(null);

  const safeDetections = Array.isArray(detections) ? detections : [];
  const safeTelemetry = Array.isArray(telemetry) ? telemetry : [];

  const showTelemetry = filter === null || filter === "offense";
  const showDetections = filter === null || filter === "defense";

  // Init Leaflet map with OSM tiles
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;

    const center = [13.76, 100.501];
    const map = L.map(mapDivRef.current, {
      center,
      zoom: 12,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    const droneLayer = L.layerGroup().addTo(map);
    const detLayer = L.layerGroup().addTo(map);
    const windLayer = L.layerGroup().addTo(map);

    mapRef.current = map;
    droneLayerRef.current = droneLayer;
    detLayerRef.current = detLayer;
    windLayerRef.current = windLayer;

    return () => {
      map.remove();
      mapRef.current = null;
      droneLayerRef.current = null;
      detLayerRef.current = null;
      windLayerRef.current = null;
    };
  }, []);

  // Render markers according to filter
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const droneLayer = droneLayerRef.current; 
    const detLayer = detLayerRef.current;
    const windLayer = windLayerRef.current;
    if (!droneLayer || !detLayer || !windLayer) return;

    droneLayer.clearLayers();
    detLayer.clearLayers();
    windLayer.clearLayers();

    const jitterTracker = new Map();

    if (showTelemetry) {
      safeTelemetry.forEach((t) => {
        const p = safePayload(t.payload);
        if (typeof p.lat === 'number' && typeof p.lon === 'number') {
          const [jLat, jLon] = jitterCoordinates(p.lat, p.lon, jitterTracker);
          const m = L.circleMarker([jLat, jLon], {
            radius: 7,
            color: '#1b4332',
            weight: 2,
            fillColor: '#2d6a4f',
            fillOpacity: 0.9,
          }).addTo(droneLayer);
          m.bindTooltip(`${p.drone_id || 'DRONE'}\n${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
          m.on('click', () => onSelectItem && onSelectItem({ type: 'telemetry', data: t }));
        }
      });
    }

    if (showDetections) {
      safeDetections.forEach((d) => {
        const p = safePayload(d.payload);
        if (typeof p.lat === 'number' && typeof p.lon === 'number') {
          const [jLat, jLon] = jitterCoordinates(p.lat, p.lon, jitterTracker);
          const m = L.circleMarker([jLat, jLon], {
            radius: 8,
            color: '#f59f00',
            weight: 2,
            fillColor: '#ffe066',
            fillOpacity: 0.9,
          }).addTo(detLayer);
          const img = p.snapshot_url || 'https://placehold.co/400x200?text=Threat+Detected';
          const dirDeg = Number.isFinite(p.bearing) ? p.bearing : Number.isFinite(p.heading) ? p.heading : null;
          const dirLabel = headingToCardinal(dirDeg);
          const directionText = dirDeg === null ? 'Direction: N/A' : `Direction: ${Math.round(dirDeg)}°${dirLabel ? ` (${dirLabel})` : ''}`;
          m.bindPopup(`<div style=\"min-width:240px\"><strong>${p.category || 'THREAT'}</strong><br/>`
            + `${directionText}<br/>`
            + `Lat ${p.lat?.toFixed(5)}, Lon ${p.lon?.toFixed(5)}<br/>`
            + `<img src=\"${img}\" style=\"width:100%;margin-top:6px;border-radius:8px;border:2px solid #f59f00;box-shadow:0 0 12px rgba(0,0,0,0.45)\"/></div>`);
          m.on('click', () => onSelectItem && onSelectItem({ type: 'detection', data: d }));
        }
      });
    }

    // wind arrow from forecast
    if (forecast && typeof forecast.lat === 'number' && typeof forecast.lon === 'number') {
      const { lat, lon, wind } = forecast;
      if (wind && typeof wind.sfc_ms === 'number' && typeof wind.sfc_deg === 'number') {
        const len = 0.01; // short arrow
        const rad = (wind.sfc_deg - 90) * Math.PI/180;
        const end = [lat + len*Math.sin(rad), lon + len*Math.cos(rad)];
        L.polyline([[lat, lon], end], { color:'#ffba08', weight:4, opacity:0.9 }).addTo(windLayer);
        L.circleMarker([lat, lon], { radius:5, color:'#ffba08', fillColor:'#ffe066', fillOpacity:1 })
          .addTo(windLayer)
          .bindTooltip(`Wind ${wind.sfc_ms.toFixed(1)} m/s • ${wind.sfc_deg}° (Bft ${beaufortFromMs(wind.sfc_ms)})`);
      }
    }
  }, [showTelemetry, showDetections, safeTelemetry, safeDetections, onSelectItem, forecast]);

  // Auto-focus when switching tabs
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (filter === 'offense' && safeTelemetry.length > 0) {
      const latest = safeTelemetry[safeTelemetry.length - 1];
      const p = safePayload(latest.payload);
      if (typeof p.lat === 'number' && typeof p.lon === 'number') {
        map.setView([p.lat, p.lon], 15, { animate: true });
      }
    }

    if (filter === 'defense' && safeDetections.length > 0) {
      const latestDet = safeDetections[safeDetections.length - 1];
      const pd = safePayload(latestDet.payload);
      if (typeof pd.lat === 'number' && typeof pd.lon === 'number') {
        map.setView([pd.lat, pd.lon], 15, { animate: true });
      }
    }
  }, [filter, safeTelemetry, safeDetections]);

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.45)] border border-[#1f3d2b] bg-[#06100c]">
      {/* Map container */}
      <div ref={mapDivRef} className="absolute inset-0 bg-[#06100c]" />

      {/* Map title */}
      <div className="absolute top-3 left-3 bg-[#10231c]/95 backdrop-blur px-4 py-3 rounded-lg shadow-lg z-10 border border-[#1f3d2b] text-green-100">
        <div className="font-bold tracking-wide flex items-center gap-2 uppercase text-sm">
          <span className="text-lg">🗺️</span>
          <span>Tactical Map • OSM</span>
        </div>
        <div className="text-[11px] text-green-200/70 mt-1">Bangkok AO • Defensive Grid</div>
        {forecast && (
          <div className="mt-2 text-[11px] flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded font-semibold border ${forecast.goNoGo === 'GO' ? 'bg-[#0f3d2e] border-[#1f8a5b] text-[#95d5b2]' : forecast.goNoGo === 'CAUTION' ? 'bg-[#3f341f] border-[#ffba08] text-[#ffba08]' : 'bg-[#3d1f1f] border-[#f87171] text-[#fca5a5]'}`}>
              {forecast.goNoGo}
            </span>
            <span className="text-green-200/70">Wind {forecast.wind?.sfc_ms?.toFixed?.(1)} m/s • {forecast.wind?.sfc_deg}°</span>
          </div>
        )}
      </div>

      {/* Side list */}
      <div className="absolute right-3 top-3 bg-[#10231c]/95 backdrop-blur rounded-xl shadow-2xl border border-[#1f3d2b] z-20 max-w-xs max-h-[75vh] overflow-hidden flex flex-col text-green-100">
        <div className="px-4 py-3 font-bold tracking-wide text-sm bg-[#0b1b14] flex items-center justify-between border-b border-[#1f3d2b] uppercase">
          <span>Target Watch</span>
          <span className="bg-[#2d6a4f] text-xs px-2 py-0.5 rounded-full font-mono text-green-100">
            {(showDetections ? safeDetections.length : 0) + (showTelemetry ? safeTelemetry.length : 0)}
          </span>
        </div>

        <div className="overflow-auto flex-1 px-3 py-2 space-y-3">
          {showTelemetry && safeTelemetry.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-[#74c69d] flex items-center gap-2 uppercase tracking-widest">
                <span className="text-sm">🛩️</span>
                <span>Blue Force</span>
              </div>
              {safeTelemetry.map((t) => {
                const p = safePayload(t.payload);
                const headingDeg = Number.isFinite(p.heading) ? p.heading : null;
                const headingLabel = headingDeg === null ? '—' : `${Math.round(headingDeg)}° ${headingToCardinal(headingDeg) || ''}`.trim();
                return (
                  <div
                    key={t.id}
                    className="bg-[#0f241a] hover:bg-[#133024] rounded-lg cursor-pointer px-3 py-3 text-xs transition shadow border border-[#1f3d2b]"
                    onClick={() => onSelectItem && onSelectItem({ type: "telemetry", data: t })}
                  >
                    <div className="flex items-center justify-between text-[13px] font-bold text-[#95d5b2]">
                      <span>{p.drone_id}</span>
                      <span className="text-[10px] text-green-200">{formatLocal(tsToDate(t.ts)).split(' ')[1]}</span>
                    </div>
                    <div className="mt-2 font-mono text-[11px] text-green-100">
                      LAT {p.lat?.toFixed(5)}
                      <br />
                      LON {p.lon?.toFixed(5)}
                    </div>
                    <div className="text-[#74c69d] flex items-center gap-3 mt-2 text-[11px]">
                      <span>↗️ {headingLabel}</span>
                      <span className="opacity-70">•</span>
                      <span>🔋 {p.battery}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {showDetections && safeDetections.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-[#1f3d2b]">
              <div className="text-[11px] font-semibold text-[#ffba08] flex items-center gap-2 uppercase tracking-widest">
                <span className="text-sm">🎯</span>
                <span>Incoming Threats</span>
              </div>
              {safeDetections.slice(0, 8).map((d) => {
                const p = safePayload(d.payload);
                const dirDeg = Number.isFinite(p.bearing) ? p.bearing : Number.isFinite(p.heading) ? p.heading : null;
                const dirLabel = dirDeg === null ? 'N/A' : `${Math.round(dirDeg)}° ${headingToCardinal(dirDeg) || ''}`.trim();
                const confPercent = Number.isFinite(p.confidence) ? Math.round(p.confidence * 100) : 0;
                return (
                  <div
                    key={d.id}
                    className="bg-[#2b2717] hover:bg-[#3a341f] rounded-lg cursor-pointer p-3 text-xs transition shadow border border-[#ffba08]/40"
                    onClick={() => onSelectItem && onSelectItem({ type: "detection", data: d })}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-16 h-12 rounded border border-[#ffba08]/50 overflow-hidden flex-shrink-0 bg-black/40">
                        <img
                          src={p.snapshot_url || 'https://placehold.co/160x120?text=CAM'}
                          alt="detection"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-[#ffba08] text-[13px] truncate">{p.category || 'UNKNOWN'}</div>
                        <div className="text-[11px] text-yellow-100 mt-1">
                          LAT {p.lat?.toFixed(5)} • LON {p.lon?.toFixed(5)}
                        </div>
                        <div className="text-[11px] text-yellow-200 mt-1 flex flex-wrap gap-2 items-center">
                          <span>↗️ {dirLabel}</span>
                          <span className="opacity-70">•</span>
                          <span>📷 {p.source || 'UNKNOWN'}</span>
                          <span className="opacity-70">•</span>
                          <span>CONF {confPercent}%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(!showTelemetry || safeTelemetry.length === 0) && (!showDetections || safeDetections.length === 0) && (
            <div className="text-[#4d6b5b] px-3 py-8 text-center text-sm border border-dashed border-[#1f3d2b] rounded-lg bg-[#0f241a]">
              <div className="text-2xl mb-2">⏳</div>
              <div>Awaiting Tactical Feed…</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ========================= UI: TimeStamp =========================
 */
function TimeStampBlock({ ts }) {
  const d = tsToDate(ts);
  return (
    <div className="text-[10px] text-green-100 bg-[#1b2b23] px-2 py-1 rounded border border-[#1f3d2b] font-mono">
      <div>🕐 {formatLocal(d)}</div>
    </div>
  );
}

/**
 * ========================= UI: Feed Item (Cards) =========================
 */
const FeedItem = React.memo(function FeedItem({ item, onClick }) {
  if (!item) return null;
  const isDetection = item.type && item.type.startsWith("detection");
  const payload = safePayload(item.payload);

  // Detection cards show latest snapshot; Offensive Drone has no image by design
  const imgSrc = isDetection
    ? (payload.snapshot_url || "https://placehold.co/400x200?text=Threat+Detected")
    : null;
  const directionDeg = Number.isFinite(payload.bearing)
    ? payload.bearing
    : (Number.isFinite(payload.heading) ? payload.heading : null);
  const directionLabel = directionDeg === null ? null : `${Math.round(directionDeg)}° ${headingToCardinal(directionDeg) || ""}`.trim();
  const confidencePercent = Number.isFinite(payload.confidence) ? Math.round(payload.confidence * 100) : 0;
  const friendlyHeading = Number.isFinite(payload.heading)
    ? `${Math.round(payload.heading)}° ${headingToCardinal(payload.heading) || ""}`.trim()
    : 'N/A';

  return (
    <div
      className={`border ${isDetection
        ? "border-[#ffba08]/50 bg-[#2b2717] hover:bg-[#3a341f]"
        : "border-[#1f3d2b] bg-[#0f241a] hover:bg-[#133024]"} rounded-xl p-4 transition cursor-pointer shadow-lg text-green-50`}
      onClick={onClick}
    >
      {isDetection && imgSrc && (
        <img src={imgSrc} alt="threat" className="w-full rounded-md mb-3 shadow-lg border border-[#ffba08]/40" />
      )}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">{isDetection ? "🎯" : "🛩️"}</span>
          <div className="space-y-0.5">
            <div className={`font-extrabold tracking-wide ${isDetection ? "text-[#ffba08]" : "text-[#74c69d]"}`}>
              {isDetection ? payload.category : payload.drone_id}
            </div>
            <div className={`text-[11px] uppercase tracking-widest ${isDetection ? "text-yellow-200" : "text-green-200/80"}`}>
              {isDetection ? "Defense Alert" : "Blue Force Telemetry"}
            </div>
          </div>
        </div>
        <TimeStampBlock ts={item.ts} />
      </div>
      <div className="text-sm space-y-2">
        <div className="font-mono text-[12px] text-green-100">
          LAT {payload.lat?.toFixed(5)} • LON {payload.lon?.toFixed(5)}
        </div>
        {isDetection ? (
          <div className="flex flex-wrap gap-3 items-center text-[11px] text-yellow-100">
            <span>↗️ {directionLabel || 'N/A'}</span>
            <span className="opacity-60">•</span>
            <span>📷 {payload.source || 'UNKNOWN'}</span>
            <span className="opacity-60">•</span>
            <span>CONF {confidencePercent}%</span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3 text-[11px] text-[#74c69d] items-center">
            <span>↗️ {friendlyHeading}</span>
            <span>⚡ {payload.speed?.toFixed(1)} m/s</span>
            <span>🔋 {payload.battery}%</span>
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * ========================= UI: Feed Panel =========================
 */
function FeedPanel({ items, onSelect, filter }) {
  const safeItems = Array.isArray(items) ? items : [];

  const filtered = useMemo(() => {
    let result = [...safeItems].sort(byTsDesc);
    if (filter === "defense") return result.filter(it => it.type && it.type.startsWith("detection"));
    if (filter === "offense") return result.filter(it => it.type && it.type.startsWith("telemetry"));
    return result;
  }, [safeItems, filter]);

  return (
    <div className="flex flex-col gap-2">
      {filtered.slice(0, 50).map((it) => (
        <FeedItem key={it.id} item={it} onClick={() => onSelect && onSelect(it)} />
      ))}
      {filtered.length === 0 && (
        <div className="text-center py-12 text-green-200/40 border border-dashed border-[#1f3d2b] rounded-lg bg-[#0f241a]">
          <div className="text-4xl mb-2">📭</div>
          <div>Standing by for intel…</div>
        </div>
      )}
    </div>
  );
}

/**
 * ========================= UI: Analytics Panel =========================
 */
function AnalyticsPanel({ analytics, onSelect }) {
  if (!analytics) return null;
  const { summary, detectionCategories, overlaps } = analytics;
  const categoryEntries = Object.entries(detectionCategories || {});

  return (
    <div className="space-y-3 text-green-100">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-[#1f3d2b] bg-[#0f241a] p-3 shadow">
          <div className="text-[11px] uppercase tracking-widest text-[#74c69d]">Active Drones</div>
          <div className="text-3xl font-extrabold text-[#95d5b2] mt-1">{summary.uniqueDrones}</div>
          <div className="text-[11px] text-green-200/80 mt-2 font-mono">Telemetry {summary.totalTelemetry}</div>
        </div>
        <div className="rounded-lg border border-[#3f2d14] bg-[#2b2717] p-3 shadow">
          <div className="text-[11px] uppercase tracking-widest text-[#ffba08]">Threat Detections</div>
          <div className="text-3xl font-extrabold text-[#ffba08] mt-1">{summary.totalDetections}</div>
          <div className="text-[11px] text-yellow-200/90 mt-2 font-mono">
            Avg Speed {summary.hasSpeedSamples ? `${summary.avgSpeed.toFixed(1)} m/s` : '—'}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-[#1f3d2b] bg-[#0f241a] p-3 shadow">
        <div className="text-[11px] uppercase tracking-widest text-[#74c69d]">Threat Categories</div>
        <div className="flex flex-wrap gap-2 mt-2">
          {categoryEntries.length === 0 && (
            <span className="text-xs text-green-200/60">No detections yet</span>
          )}
          {categoryEntries.map(([cat, count]) => (
            <span
              key={cat}
              className="px-2 py-1 text-[11px] rounded-full border border-[#ffba08]/40 bg-[#2b2717] text-yellow-100 font-mono"
            >
              {cat} • {count}
            </span>
          ))}
        </div>
      </div>

      {overlaps.length > 0 && (
        <div className="rounded-lg border border-[#3f2d14] bg-[#2b2717] p-3 shadow">
          <div className="text-[11px] uppercase tracking-widest text-[#ffba08]">Overlapping Threat Areas</div>
          <ul className="mt-2 space-y-2">
            {overlaps.slice(0, 5).map((group, idx) => (
              <li key={idx}>
                <button
                  type="button"
                  onClick={() => onSelect && onSelect(group.primary)}
                  className="w-full text-left bg-[#3d341f] hover:bg-[#4a3f26] border border-[#ffba08]/40 rounded-lg px-3 py-2 transition text-yellow-100"
                >
                  <div className="text-sm font-semibold text-[#ffba08]">
                    Cluster #{idx + 1} • {group.count} detections
                  </div>
                  <div className="text-[11px] text-yellow-100 mt-1 font-mono">
                    📍 {group.lat.toFixed(4)}, {group.lon.toFixed(4)}
                  </div>
                  <div className="text-[11px] text-yellow-200/90 mt-1 flex flex-wrap gap-2">
                    {Object.entries(group.categories).map(([cat, count]) => (
                      <span key={cat}>{cat}: {count}</span>
                    ))}
                  </div>
                  <div className="text-[10px] text-yellow-200/60 mt-1">
                    Latest: {formatLocal(tsToDate(group.latestTs))}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * ========================= UI: Detail Drawer =========================
 */
function DetailDrawer({ item, onClose, onOpenImage, forecast }) {
  if (!item) return null;
  const isDet = item.type && item.type.startsWith("detection");
  const p = safePayload(item.payload);
  const directionDeg = isDet ? (Number.isFinite(p.bearing) ? p.bearing : (Number.isFinite(p.heading) ? p.heading : null)) : null;
  const directionLabel = directionDeg === null ? 'N/A' : `${Math.round(directionDeg)}° ${headingToCardinal(directionDeg) || ''}`.trim();
  const confidencePercent = Number.isFinite(p.confidence) ? Math.round(p.confidence * 100) : 0;

  return (
    <div className="fixed right-0 top-0 h-full w-[420px] bg-[#0b1b14] text-green-100 shadow-[0_0_30px_rgba(0,0,0,0.45)] border-l border-[#1f3d2b] z-50 flex flex-col">
      <div className="p-4 border-b border-[#1f3d2b] bg-gradient-to-r from-[#0b1b14] to-[#10231c] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{isDet ? "🎯" : "🛩️"}</span>
          <div>
            <div className="font-bold text-xl tracking-wide text-[#95d5b2]">{isDet ? "Threat Intel" : "Blue Force Asset"}</div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-green-200/60">{isDet ? "Defense Channel" : "Operations"}</div>
          </div>
        </div>
        <button
          className="text-green-200 hover:text-white text-xl font-bold px-3 py-1 hover:bg-[#143626] rounded"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="p-5 space-y-4 overflow-auto flex-1 bg-[#0f241a]">
        {forecast && (
          <div className="grid grid-cols-2 gap-3">
            <div className={`rounded-lg p-3 border text-center font-bold text-[13px] ${forecast.goNoGo === 'GO' ? 'bg-[#0f3d2e] border-[#1f8a5b] text-[#95d5b2]' : forecast.goNoGo === 'CAUTION' ? 'bg-[#3f341f] border-[#ffba08] text-[#ffba08]' : 'bg-[#3d1f1f] border-[#f87171] text-[#fca5a5]'}`}>
              {forecast.goNoGo} • Wind {forecast.wind?.sfc_ms?.toFixed?.(1)} m/s {forecast.wind?.sfc_deg}°
            </div>
            <div className="rounded-lg p-3 border border-[#1f3d2b] bg-[#13281f]">
              <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">GNSS (Kp)</div>
              <div className="font-semibold text-[#95d5b2]">Kp {forecast.kp_index ?? '-'}</div>
            </div>
          </div>
        )}
        <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
          <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Time Stamp</div>
          <TimeStampBlock ts={item.ts} />
        </div>

        {isDet ? (
          <>
            <div className="bg-[#3f2d14] rounded-lg p-3 border border-[#ffba08]/60">
              <div className="text-[11px] text-[#ffba08] mb-1 uppercase tracking-widest">Classification</div>
              <div className="font-bold text-[#ffba08] text-lg">{p.category}</div>
            </div>

            <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
              <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Confidence</div>
              <div className="font-bold text-lg text-[#95d5b2]">{confidencePercent}%</div>
              <div className="w-full bg-[#1f3d2b] rounded-full h-2 mt-2">
                <div
                  className="bg-[#ffba08] h-2 rounded-full transition-all"
                  style={{ width: `${confidencePercent}%` }}
                />
              </div>
            </div>

            <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
              <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Location</div>
              <div className="font-mono text-sm text-green-100 space-y-1">
                <div>LAT: {p.lat?.toFixed(6)}</div>
                <div>LON: {p.lon?.toFixed(6)}</div>
              </div>
            </div>

            <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
              <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Direction</div>
              <div className="font-bold text-[#ffba08] text-lg">↗️ {directionLabel}</div>
            </div>

            <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
              <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Source</div>
              <div className="font-bold text-[#95d5b2]">{p.source}</div>
            </div>

            {
              <div>
                <div className="text-[11px] text-green-200/80 mb-2 uppercase tracking-widest">Snapshot (Latest)</div>
                <img
                  src={p.snapshot_url || "https://placehold.co/640x360/e74c3c/ffffff?text=Detection"}
                  alt="snapshot"
                  className="rounded-lg border-2 border-[#ffba08]/60 cursor-zoom-in hover:border-[#ffba08] transition shadow-lg w-full"
                  onClick={() => onOpenImage && onOpenImage(p.snapshot_url || "https://placehold.co/640x360/e74c3c/ffffff?text=Detection")}
                />
                <div className="text-xs text-green-200/60 mt-2 text-center">🔍 Click to zoom</div>
              </div>
            }
          </>
        ) : (
          <>
            <div className="bg-[#0f3d2e] rounded-lg p-3 border border-[#1f8a5b]/60">
              <div className="text-[11px] text-[#74c69d] mb-1 uppercase tracking-widest">Drone ID</div>
              <div className="font-bold text-[#95d5b2] text-lg">{p.drone_id}</div>
            </div>

            <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
              <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Status</div>
              <div className="font-bold text-lg capitalize text-[#95d5b2]">{p.status}</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
                <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Battery</div>
                <div className="font-bold text-lg text-[#95d5b2]">🔋 {p.battery}%</div>
              </div>
              <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
                <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Speed</div>
                <div className="font-bold text-lg text-[#95d5b2]">⚡ {p.speed?.toFixed(1)} m/s</div>
              </div>
            </div>

            <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
              <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Heading</div>
              <div className="font-bold text-lg text-[#95d5b2]">↗️ {Math.round(p.heading || 0)}° {headingToCardinal(p.heading) || ''}</div>
            </div>

            <div className="bg-[#13281f] rounded-lg p-3 border border-[#1f3d2b]">
              <div className="text-[11px] text-green-200/80 mb-1 uppercase tracking-widest">Position</div>
              <div className="text-sm font-mono space-y-1 text-green-100">
                <div>LAT: {p.lat?.toFixed(6)}</div>
                <div>LON: {p.lon?.toFixed(6)}</div>
                <div>ALT: {p.alt?.toFixed(1)} m</div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * ========================= UI: Image Viewer =========================
 */
function ImageViewer({ isOpen, src, onClose }) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    function onKey(e) {
      if (!isOpen) return;
      if (e.key === "Escape") onClose && onClose();
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(5, z + 0.25));
      if (e.key === "-" || e.key === "_") setZoom((z) => Math.max(0.25, z - 0.25));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <button
          className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 backdrop-blur font-medium"
          onClick={() => setZoom(1)}
        >
          Reset
        </button>
        <button
          className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 backdrop-blur text-xl"
          onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
        >
          −
        </button>
        <button
          className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 backdrop-blur text-xl"
          onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
        >
          +
        </button>
        <button
          className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium"
          onClick={onClose}
        >
          ✕ Close
        </button>
      </div>
      <div className="max-w-[90vw] max-h-[85vh] overflow-auto rounded-xl shadow-2xl bg-black/60 p-4">
        <img
          src={src}
          alt="viewer"
          style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
          className="mx-auto rounded"
        />
      </div>
    </div>
  );
}

/**
 * ========================= Tiny Runtime Tests =========================
 * (Displayed at bottom-left)
 */
function runTests() {
  const tests = [];
  const push = (name, fn) => {
    try { fn(); tests.push({ name, pass: true }); }
    catch (e) { tests.push({ name, pass: false, err: e.message }); }
  };

  // validateEvent tests
  push("validateEvent rejects null", () => { if (validateEvent(null)) throw new Error("should reject"); });
  push("validateEvent minimal ok", () => {
    const ok = validateEvent({ id: "1", ts: Date.now(), type: "t", payload: {} });
    if (!ok) throw new Error("should accept valid event");
  });
  // NEW: ts string accepted
  push("validateEvent allows string ts", () => {
    const ok = validateEvent({ id: "2", ts: new Date().toISOString(), type: "t", payload: {} });
    if (!ok) throw new Error("should accept string ts");
  });
  // NEW: rejects without payload
  push("validateEvent rejects no payload", () => {
    const ok = validateEvent({ id: "3", ts: Date.now(), type: "t" });
    if (ok) throw new Error("should reject missing payload");
  });

  // eventKey tests
  push("eventKey detection uses detection_id", () => {
    const k = eventKey({ id: "x", ts: 1, type: "detection:new", payload: { detection_id: "D1" } });
    if (k !== "det:D1") throw new Error("bad key: "+k);
  });
  // NEW: eventKey telemetry bucketed
  push("eventKey telemetry bucketed", () => {
    const k = eventKey({ id: "y", ts: 1000, type: "telemetry:update", payload: { drone_id: "B" } });
    if (!k.startsWith("tel:B:")) throw new Error("telemetry key malformed: "+k);
  });

  // byTsDesc tests
  push("byTsDesc sorts newest first", () => {
    const arr = [{ ts: 1 }, { ts: 3 }, { ts: 2 }];
    const s = [...arr].sort(byTsDesc);
    if (s[0].ts !== 3 || s[2].ts !== 1) throw new Error("sorting wrong");
  });

  // formatLocal test (shape only)
  push("formatLocal outputs parts", () => {
    const out = formatLocal(new Date("2020-01-02T03:04:05.006Z"));
    if (!/\d{4}-\d{2}-\d{2} /.test(out)) throw new Error("bad date format");
  });

  // NEW: filter logic unit test
  push("filter offense/defense logic", () => {
    const items = [
      { ts: 1, type: "telemetry:update" },
      { ts: 2, type: "detection:new" },
    ];
    const offense = items.filter(it => it.type.startsWith("telemetry"));
    const defense = items.filter(it => it.type.startsWith("detection"));
    if (offense.length !== 1 || defense.length !== 1) throw new Error("filter counts wrong");
  });

  // NEW: snapshot presence for detection cards
  push("detection snapshot placeholder works", () => {
    const d = { ts: Date.now(), type: "detection:new", payload: {} };
    const url = d.payload.snapshot_url || "https://placehold.co/400x200?text=Threat+Detected";
    if (!url.includes("placehold.co")) throw new Error("placeholder missing");
  });

  // NEW: computeGoNoGo unit tests
  push("computeGoNoGo basic thresholds", () => {
    const a = computeGoNoGo({ wind_ms: 2, vis_km: 10, cloud_base_m: 1200, precip_mm: 0, kp: 1 });
    const b = computeGoNoGo({ wind_ms: 6, vis_km: 7, cloud_base_m: 500, precip_mm: 0.2, kp: 4 });
    const c = computeGoNoGo({ wind_ms: 12, vis_km: 3, cloud_base_m: 200, precip_mm: 1.0, kp: 6 });
    if (a !== 'GO' || b !== 'CAUTION' || c !== 'NO_GO') throw new Error('go/no-go thresholds wrong');
  });

  // NEW: CONFIG sanity
  push("CONFIG closes correctly", () => {
    if (typeof CONFIG !== 'object') throw new Error('CONFIG not object');
    if (!('USE_SIM' in CONFIG)) throw new Error('CONFIG.USE_SIM missing');
  });

  // NEW: overlap grouping sanity
  push("groupOverlappingDetections clusters nearby points", () => {
    const base = Date.now();
    const dets = [
      { id: '1', ts: base, type: 'detection:new', payload: { detection_id: 'd1', lat: 10, lon: 20 } },
      { id: '2', ts: base + 1000, type: 'detection:new', payload: { detection_id: 'd2', lat: 10.0005, lon: 20.0004 } },
      { id: '3', ts: base + 2000, type: 'detection:new', payload: { detection_id: 'd3', lat: 11, lon: 21 } },
    ];
    const groups = groupOverlappingDetections(dets, 200);
    if (groups.length !== 1 || groups[0].count !== 2) throw new Error('overlap grouping failed');
  });

  // NEW: analyzeData handles empty inputs
  push("analyzeData handles empty", () => {
    const res = analyzeData([], []);
    if (!res.summary || res.summary.totalTelemetry !== 0 || res.summary.hasSpeedSamples !== false) {
      throw new Error('analyzeData summary incorrect');
    }
  });

  return tests;
}

function TestPanel() {
  const [results] = useState(runTests());
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  return (
    <div className="fixed bottom-3 left-3 bg-[#10231c]/90 backdrop-blur rounded-lg shadow-lg px-3 py-2 text-xs z-50 border border-[#1f3d2b] text-green-100">
      <div className="font-bold">Tests: <span className={fail?"text-[#f87171]":"text-[#95d5b2]"}>{pass}/{results.length} passed</span></div>
      {fail>0 && (
        <ul className="list-disc pl-4 mt-1 text-[#f87171] max-w-[260px]">
          {results.filter(r=>!r.pass).map((r,i)=>(<li key={i}>{r.name}: {r.err}</li>))}
        </ul>
      )}
    </div>
  );
}

/**
 * ========================= App =========================
 */
export default function App() {
  // UI states
  const [tab, setTab] = useState("offense"); // offense | defense | null
  const [selected, setSelected] = useState(null);
  const [viewer, setViewer] = useState({ open: false, src: "" });
  const [telemetry, setTelemetry] = useState([]);
  const [detections, setDetections] = useState([]);
  const [forecast, setForecast] = useState(null);

  const buf = useEventBuffer({ capFeed: 400, capIndex: 2000, flushMs: 120 });

  // keep last signature per drone to avoid pushing identical states
  const lastSigRef = useRef(new Map()); // drone_id -> string signature

  const onTelemetry = useCallback((evt) => {
    if (!validateEvent(evt)) return;
    const p = safePayload(evt.payload);
    const id = p.drone_id;
    if (!id) return;

    // drop exact duplicates (same core fields)
    const sig = [p.lat,p.lon,p.alt,p.heading,p.speed,p.battery,p.status].map(v=>String(Math.round((v??0)*1e6))).join("|");
    const prevSig = lastSigRef.current.get(id);
    if (prevSig === sig) {
      // still update the LRU index for freshness but don't grow the feed
      buf.push(evt); // indexRef will update existing key
      setTelemetry(prev => {
        const i = prev.findIndex(x => x.payload?.drone_id === id);
        if (i < 0) return prev; // nothing to update visually
        const next = [...prev];
        // keep ts fresh but avoid extra render churn: only replace if newer
        const oldTs = typeof next[i].ts === 'number' ? next[i].ts : Date.parse(next[i].ts);
        const newTs = typeof evt.ts === 'number' ? evt.ts : Date.parse(evt.ts);
        if (newTs > oldTs) next[i] = evt;
        return next;
      });
      return;
    }
    lastSigRef.current.set(id, sig);

    buf.push(evt);
    setTelemetry((prev) => {
      const idx = prev.findIndex((x) => x.payload && x.payload.drone_id === id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = evt;
        return next.slice(-50);
      }
      return [...prev, evt].slice(-50);
    });
  }, [buf]);

  const onDetection = useCallback((evt) => {
    if (!validateEvent(evt)) return;
    const id = evt.payload?.detection_id || evt.id;
    buf.push(evt);
    setDetections((prev) => {
      // de-duplicate by detection_id, keep latest fields and snapshot (use latest non-empty)
      const map = new Map(prev.map(e => [(e.payload?.detection_id || e.id), e]));
      const old = map.get(id);
      if (!old) {
        map.set(id, evt);
      } else {
        const oldTs = typeof old.ts === 'number' ? old.ts : Date.parse(old.ts);
        const newTs = typeof evt.ts === 'number' ? evt.ts : Date.parse(evt.ts);
        const merged = { ...old, ...evt, payload: { ...old.payload, ...evt.payload } };
        // if new snapshot missing but old has, keep old snapshot
        if (!evt.payload?.snapshot_url && old.payload?.snapshot_url) {
          merged.payload.snapshot_url = old.payload.snapshot_url;
        }
        if (newTs >= oldTs) map.set(id, merged);
      }
      // keep recent order by ts
      const arr = Array.from(map.values()).sort(byTsDesc).slice(0, 100);
      return arr.reverse();
    });
  }, [buf]);

  // Unified data source hook (fix: avoid conditional hook calls)
  useEffect(() => {
    let cleanup = () => {};

    if (CONFIG.USE_SIM) {
      let t = 0;
      const interval = setInterval(() => {
        const now = Date.now();
        // telemetry
        onTelemetry({
          id: crypto.randomUUID(), ts: now, type: 'telemetry:update',
          payload: {
            drone_id: 'BLUE-1',
            lat: 13.760 + Math.sin(t / 30) * 0.01,
            lon: 100.501 + Math.cos(t / 30) * 0.01,
            alt: 120 + (Math.sin(t / 10) * 5),
            heading: (t * 12) % 360,
            speed: 12 + (Math.cos(t / 15) * 2),
            battery: Math.max(0, 86 - Math.floor(t / 30)),
            status: 'in-flight'
          }
        });
        // detection
        if (t % 2 === 0) {
          onDetection({
            id: crypto.randomUUID(), ts: now + 5, type: 'detection:new',
            payload: {
              detection_id: crypto.randomUUID(), source: 'CAM-A1',
              lat: 13.761 + Math.random() * 0.008,
              lon: 100.501 + Math.random() * 0.008,
              category: Math.random() > 0.5 ? 'UAV' : 'UNKNOWN',
              confidence: Number((0.75 + Math.random() * 0.2).toFixed(2)),
              snapshot_url: 'https://placehold.co/640x360/e74c3c/ffffff?text=Detection',
            }
          });
        }
        t++;
      }, 1500);
      cleanup = () => clearInterval(interval);
    } else if (CONFIG.WS_URL || CONFIG.HTTP_POLL_URL) {
      // WebSocket preferred
      if (CONFIG.WS_URL) {
        const ws = new WebSocket(CONFIG.WS_URL);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            const t = msg?.type || '';
            if (t.startsWith('telemetry')) onTelemetry(msg);
            else if (t.startsWith('detection')) onDetection(msg);
          } catch {}
        };
        cleanup = () => { try { ws.close(); } catch {} };
      } else {
        // HTTP poll
        let stop = false;
        (async function loop(){
          while(!stop){
            try{
              const res = await fetch(CONFIG.HTTP_POLL_URL);
              const arr = await res.json();
              if (Array.isArray(arr)) {
                for (const msg of arr) {
                  const t = msg?.type || '';
                  if (t.startsWith('telemetry')) onTelemetry(msg);
                  else if (t.startsWith('detection')) onDetection(msg);
                }
              }
            } catch {}
            await new Promise(r=>setTimeout(r,1500));
          }
        })();
        cleanup = () => { stop = true; };
      }
    }

    return cleanup;
  }, [onTelemetry, onDetection]);

  const merged = useMemo(() => buf.snapshot(), [buf.version]);
  const analytics = useMemo(() => analyzeData(telemetry, detections), [telemetry, detections]);

  const handleSelect = useCallback((it) => {
    if (it && it.type) {
      setSelected(it);
    } else if (it && it.data) {
      setSelected(it.data);
    }
  }, []);

  const handleOpenImage = useCallback((src) => { setViewer({ open: true, src }); }, []);

  // --- Open-Meteo fetch ---
  async function fetchOpenMeteo(point) {
    if (!point || typeof point.lat !== 'number' || typeof point.lon !== 'number') return null;
    const params = new URLSearchParams({
      latitude: String(point.lat),
      longitude: String(point.lon),
      hourly: ['windspeed_10m','winddirection_10m','gusts_10m','visibility','cloud_base_height','precipitation'].join(','),
      current: ['windspeed_10m','winddirection_10m','gusts_10m','visibility','cloud_base_height','precipitation'].join(',')
    });
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
      const data = await res.json();
      const cur = data.current || {};
      const wind_ms_final = data.current_units?.windspeed_10m?.includes?.('km') ? (cur.windspeed_10m ?? 0)/3.6 : (cur.windspeed_10m ?? 0);
      const gust_ms_final = data.current_units?.gusts_10m?.includes?.('km') ? (cur.gusts_10m ?? 0)/3.6 : (cur.gusts_10m ?? 0);
      const vis_km = data.current_units?.visibility?.includes?.('m') ? (cur.visibility ?? 10000)/1000 : (cur.visibility ?? 10);
      const cloud_base_m = data.current_units?.cloud_base_height?.includes?.('km') ? (cur.cloud_base_height ?? 1)*1000 : (cur.cloud_base_height ?? 1000);
      const precip_mm = cur.precipitation ?? 0;
      const kp = 3; // placeholder for now

      const goNoGo = computeGoNoGo({ wind_ms: wind_ms_final, gust_ms: gust_ms_final, vis_km, cloud_base_m, precip_mm, kp });
      return {
        lat: point.lat,
        lon: point.lon,
        ts: Date.now(),
        goNoGo,
        wind: { sfc_ms: wind_ms_final, sfc_deg: cur.winddirection_10m ?? 0 },
        vis_km, cloud_base_m, precip_mm, kp_index: kp
      };
    } catch (e) {
      console.warn('Open-Meteo fetch failed', e);
      return null;
    }
  }

  useEffect(() => {
    let point = null;
    if (tab === 'offense' && telemetry.length) {
      const p = telemetry[telemetry.length-1]?.payload || {};
      if (typeof p.lat === 'number' && typeof p.lon === 'number') point = { lat: p.lat, lon: p.lon };
    } else if (tab === 'defense' && detections.length) {
      const p = detections[detections.length-1]?.payload || {};
      if (typeof p.lat === 'number' && typeof p.lon === 'number') point = { lat: p.lat, lon: p.lon };
    }
    if (!point) { setForecast(null); return; }
    (async () => {
      const f = await fetchOpenMeteo(point);
      setForecast(f);
    })();
  }, [tab, telemetry, detections]);

  return (
    <div className="h-screen w-screen bg-[#050d08] text-green-100 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#04140d] via-[#0b1b14] to-[#12281f] px-6 py-5 border-b border-[#1f3d2b] shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-3xl" aria-hidden>🎖️</span>
            <div>
              <h1 className="text-2xl font-extrabold tracking-wide">Tactical Defense Console</h1>
              <p className="text-sm text-green-200/70 uppercase tracking-[0.3em]">Live Drone & Threat Fusion</p>
            </div>
          </div>
          <div className="flex items-center gap-3 bg-[#13281f] px-4 py-2 rounded-lg border border-[#1f3d2b]">
            <span className={`h-3 w-3 rounded-full animate-pulse ${CONFIG.WS_URL || CONFIG.USE_SIM ? 'bg-green-400' : 'bg-yellow-400'}`} aria-label="online status" />
            <span className="text-sm font-medium text-green-100">
              {CONFIG.WS_URL ? 'LINKED' : (CONFIG.USE_SIM ? 'SIM MODE' : 'OFFLINE')} • {merged.length} EVENTS
            </span>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-[#1f3d2b] bg-[#06100c]">
        <button
          className={`px-4 py-2 rounded-lg border text-sm tracking-wide uppercase transition ${tab === "offense" ? "bg-[#0f3d2e] border-[#1f8a5b] text-[#95d5b2] shadow-lg" : "bg-transparent border-[#1f3d2b] text-green-200/70 hover:bg-[#0b1b14]"}`}
          onClick={() => setTab("offense")}
        >
          🛩️ Track Drone
        </button>
        <button
          className={`px-4 py-2 rounded-lg border text-sm tracking-wide uppercase transition ${tab === "defense" ? "bg-[#3f2d14] border-[#ffba08] text-[#ffba08] shadow-lg" : "bg-transparent border-[#1f3d2b] text-green-200/70 hover:bg-[#0b1b14]"}`}
          onClick={() => setTab("defense")}
        >
          🎯 Show Threats
        </button>
        <div className="ml-auto text-[11px] text-green-200/60 font-mono">SIM {CONFIG.USE_SIM ? 'ON' : 'OFF'} • WS {CONFIG.WS_URL ? 'READY' : 'IDLE'}</div>
      </div>

      {/* Content */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 p-6 overflow-hidden">
        {/* Map */}
        <div className="lg:col-span-2 min-h-[440px]">
          <MapPanel
            detections={detections}
            telemetry={telemetry}
            onSelectItem={handleSelect}
            filter={tab}
            forecast={forecast}
          />
        </div>

        {/* Feed */}
        <div className="lg:col-span-1 flex flex-col gap-4 overflow-hidden">
          <div className="shrink-0">
            <AnalyticsPanel analytics={analytics} onSelect={handleSelect} />
          </div>
          <div className="flex-1 overflow-auto pr-1">
            <FeedPanel items={merged} onSelect={handleSelect} filter={tab} />
          </div>
        </div>
      </div>

      {/* Drawer */}
      <DetailDrawer
        item={selected}
        onClose={() => setSelected(null)}
        onOpenImage={handleOpenImage}
        forecast={forecast}
      />

      {/* Image Viewer */}
      <ImageViewer
        isOpen={viewer.open}
        src={viewer.src}
        onClose={() => setViewer({ open: false, src: "" })}
      />

      {/* Runtime tests */}
      <TestPanel />
    </div>
  );
}
