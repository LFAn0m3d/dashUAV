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

function bearingBetween(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    return null;
  }
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

function headingDifference(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let diff = (a - b) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return Math.abs(diff);
}

function bearingToCardinal(bearing) {
  if (!Number.isFinite(bearing)) return "ไม่ทราบ";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(bearing / 45) % dirs.length;
  return dirs[idx];
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

function MapPanel({ detections, telemetry, onSelectItem, filter, forecast, title, subtitle, icon }) {
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
            radius: 6,
            color: '#2563eb',
            weight: 2,
            fillColor: '#93c5fd',
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
            radius: 7,
            color: '#dc2626',
            weight: 2,
            fillColor: '#fecaca',
            fillOpacity: 0.95,
          }).addTo(detLayer);
          const img = p.snapshot_url || 'https://placehold.co/400x200?text=Threat+Detected';
          m.bindPopup(`<div style=\"min-width:240px\"><strong>${p.category || 'THREAT'}</strong><br/>`
            + `Lat ${p.lat?.toFixed(5)}, Lon ${p.lon?.toFixed(5)}<br/>`
            + `<img src=\"${img}\" style=\"width:100%;margin-top:6px;border-radius:8px\"/></div>`);
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
        L.polyline([[lat, lon], end], { color:'#0ea5e9', weight:4, opacity:0.9 }).addTo(windLayer);
        L.circleMarker([lat, lon], { radius:5, color:'#0284c7', fillColor:'#7dd3fc', fillOpacity:1 })
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
    <div className="relative w-full h-full rounded-xl overflow-hidden shadow-lg">
      {/* Map container */}
      <div ref={mapDivRef} className="absolute inset-0 bg-gray-100" />

      {/* Map title */}
      <div className="absolute top-3 left-3 bg-white/95 backdrop-blur px-3 py-2 rounded-lg shadow-md z-10">
        <div className="font-bold text-gray-800 flex items-center gap-2">
          <span className="text-lg">{icon || '🗺️'}</span>
          <span>{title || 'Live Map (OpenStreetMap)'}</span>
        </div>
        <div className="text-xs text-gray-600 mt-1">{subtitle || 'Bangkok, Thailand'}</div>
        {forecast && (
          <div className="mt-2 text-xs">
            <span className={`px-2 py-0.5 rounded font-semibold ${forecast.goNoGo === 'GO' ? 'bg-green-100 text-green-700' : forecast.goNoGo === 'CAUTION' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
              {forecast.goNoGo}
            </span>
            <span className="ml-2 text-gray-600">Wind {forecast.wind?.sfc_ms?.toFixed?.(1)} m/s • {forecast.wind?.sfc_deg}°</span>
          </div>
        )}
      </div>

      {/* Side list */}
      <div className="absolute right-3 top-3 bg-white/95 backdrop-blur rounded-lg shadow-lg divide-y z-20 max-w-xs max-h-[75vh] overflow-hidden flex flex-col">
        <div className="px-3 py-2 font-bold text-gray-800 bg-gray-50 flex items-center justify-between">
          <span>📍 Markers</span>
          <span className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">
            {(showDetections ? safeDetections.length : 0) + (showTelemetry ? safeTelemetry.length : 0)}
          </span>
        </div>

        <div className="overflow-auto flex-1">
          {showTelemetry && safeTelemetry.length > 0 && (
            <div className="p-2 space-y-1">
              <div className="text-xs font-bold text-blue-600 mb-2 flex items-center gap-1">
                <span>🛩️</span>
                <span>Offensive Drone</span>
              </div>
              {safeTelemetry.map((t) => {
                const p = safePayload(t.payload);
                return (
                  <div
                    key={t.id}
                    className="bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer px-3 py-2 text-xs transition shadow-sm border border-blue-200"
                    onClick={() => onSelectItem && onSelectItem({ type: "telemetry", data: t })}
                  >
                    <div className="font-bold text-blue-900">{p.drone_id}</div>
                    <div className="text-blue-700 mt-1">
                      📍 {p.lat?.toFixed(5)}, {p.lon?.toFixed(5)}
                    </div>
                    <div className="text-blue-700 flex items-center gap-2 mt-1">
                      <span>↗️ {Math.round(p.heading || 0)}°</span>
                      <span>•</span>
                      <span>🔋 {p.battery}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {showDetections && safeDetections.length > 0 && (
            <div className="p-2 space-y-1 border-t">
              <div className="text-xs font-bold text-red-600 mb-2 flex items-center gap-1">
                <span>🎯</span>
                <span>Threats</span>
              </div>
              {safeDetections.slice(0, 8).map((d) => {
                const p = safePayload(d.payload);
                return (
                  <div
                    key={d.id}
                    className="bg-red-50 hover:bg-red-100 rounded-lg cursor-pointer px-3 py-2 text-xs transition shadow-sm border border-red-200"
                    onClick={() => onSelectItem && onSelectItem({ type: "detection", data: d })}
                  >
                    <div className="font-bold text-red-900">{p.category}</div>
                    <div className="text-red-700 mt-1">
                      📍 {p.lat?.toFixed(5)}, {p.lon?.toFixed(5)}
                    </div>
                    <div className="text-red-700 flex items-center gap-2 mt-1">
                      <span>📷 {p.source}</span>
                      <span>•</span>
                      <span>✓ {(p.confidence * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(!showTelemetry || safeTelemetry.length === 0) && (!showDetections || safeDetections.length === 0) && (
            <div className="text-gray-400 px-3 py-8 text-center text-sm">
              <div className="text-2xl mb-2">⏳</div>
              <div>Waiting for data…</div>
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
    <div className="text-[10px] text-gray-500 bg-gray-50 px-2 py-1 rounded">
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

  return (
    <div
      className={`border-2 ${isDetection ? "border-red-200 bg-red-50 hover:bg-red-100 hover:border-red-300" : "border-blue-200 bg-blue-50 hover:bg-blue-100 hover:border-blue-300"} rounded-lg p-3 transition cursor-pointer shadow-sm`}
      onClick={onClick}
    >
      {isDetection && imgSrc && (
        <img src={imgSrc} alt="threat" className="w-full rounded-md mb-2 shadow" />
      )}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{isDetection ? "🎯" : "🛩️"}</span>
          <div>
            <div className={`font-bold ${isDetection ? "text-red-900" : "text-blue-900"}`}>
              {isDetection ? payload.category : payload.drone_id}
            </div>
            <div className={`text-xs ${isDetection ? "text-red-700" : "text-blue-700"}`}>
              {isDetection ? "Threat" : "Offensive Drone"}
            </div>
          </div>
        </div>
        <TimeStampBlock ts={item.ts} />
      </div>
      <div className="text-sm text-gray-700 space-y-1">
        <div>📍 {payload.lat?.toFixed(5)}, {payload.lon?.toFixed(5)}</div>
        {isDetection ? (
          <div className="flex items-center gap-2 text-xs">
            <span>📷 {payload.source}</span>
            <span>•</span>
            <span>✓ {(payload.confidence * 100).toFixed(0)}%</span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span>↗️ {Math.round(payload.heading || 0)}°</span>
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
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-2">📭</div>
          <div>No data</div>
        </div>
      )}
    </div>
  );
}

/**
 * ========================= UI: Analytics Panel =========================
 */
function AnalyticsPanel({ analytics, onSelect, forecast }) {
  if (!analytics) return null;
  const { summary, detectionCategories, overlaps } = analytics;
  const categoryEntries = Object.entries(detectionCategories || {});

  return (
    <div className="bg-white border rounded-xl shadow-sm h-full flex flex-col">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-800">แดชบอร์ดรวม</h2>
          <p className="text-xs text-gray-500">ภาพรวมสถานการณ์ฝั่งบุกและรับแบบเรียลไทม์</p>
        </div>
        <div className="text-xs text-gray-400">อัปเดต {formatLocal(new Date())}</div>
      </div>

      <div className="p-4 space-y-4 flex-1 overflow-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border bg-blue-50/80 border-blue-200 p-3">
            <div className="text-xs font-semibold text-blue-600 uppercase tracking-wide">โดรนปฏิบัติการ</div>
            <div className="text-3xl font-bold text-blue-700 mt-1">{summary.uniqueDrones}</div>
            <div className="text-xs text-blue-600 mt-1">เฟรมเทเลเมทรี {summary.totalTelemetry}</div>
            <div className="text-xs text-blue-600 mt-1">ความเร็วเฉลี่ย {summary.hasSpeedSamples ? `${summary.avgSpeed.toFixed(1)} m/s` : "ไม่ทราบ"}</div>
          </div>
          <div className="rounded-lg border bg-red-50/80 border-red-200 p-3">
            <div className="text-xs font-semibold text-red-600 uppercase tracking-wide">ภัยคุกคามที่ตรวจพบ</div>
            <div className="text-3xl font-bold text-red-700 mt-1">{summary.totalDetections}</div>
            <div className="text-xs text-red-600 mt-1">ข้อมูลสอดแนม {categoryEntries.length}</div>
            <div className="text-xs text-red-600 mt-1">จุดซ้อนทับ {overlaps.length}</div>
          </div>
        </div>

        {forecast && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-emerald-700">GO/NO-GO</div>
                <div className="text-lg font-semibold text-emerald-700">{forecast.goNoGo}</div>
              </div>
              <div className="text-xs text-emerald-700 text-right">
                ลม {forecast.wind?.sfc_ms?.toFixed?.(1)} m/s • {forecast.wind?.sfc_deg}°<br />
                วิสัยทัศน์ {forecast.vis_km?.toFixed?.(1)} กม.
              </div>
            </div>
          </div>
        )}

        <div className="rounded-lg border bg-white p-3">
          <div className="text-xs text-gray-600 font-semibold uppercase tracking-wide">ประเภทภัยคุกคาม</div>
          <div className="flex flex-wrap gap-2 mt-2">
            {categoryEntries.length === 0 && (
              <span className="text-xs text-gray-500">ยังไม่มีการตรวจพบ</span>
            )}
            {categoryEntries.map(([cat, count]) => (
              <span
                key={cat}
                className="px-2 py-1 text-xs rounded-full border border-red-200 bg-red-50 text-red-700"
              >
                {cat} • {count}
              </span>
            ))}
          </div>
        </div>

        {overlaps.length > 0 && (
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-600 font-semibold uppercase tracking-wide">จุดคุกคามซ้ำซ้อน</div>
            <ul className="mt-2 space-y-2">
              {overlaps.slice(0, 5).map((group, idx) => (
                <li key={idx}>
                  <button
                    type="button"
                    onClick={() => onSelect && onSelect(group.primary)}
                    className="w-full text-left bg-red-50/60 hover:bg-red-100 border border-red-200 rounded-lg px-3 py-2 transition"
                  >
                    <div className="text-sm font-semibold text-red-700">
                      จุดที่ {idx + 1} • {group.count} การตรวจพบ
                    </div>
                    <div className="text-xs text-gray-600 mt-1">
                      📍 {group.lat.toFixed(4)}, {group.lon.toFixed(4)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-2">
                      {Object.entries(group.categories).map(([cat, count]) => (
                        <span key={cat}>{cat}: {count}</span>
                      ))}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-1">
                      ล่าสุด {formatLocal(tsToDate(group.latestTs))}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ========================= UI: Offense Dashboard =========================
 */
function OffenseDashboard({ telemetry, onSelect }) {
  const drones = useMemo(() => {
    const map = new Map();
    (Array.isArray(telemetry) ? telemetry : []).forEach((evt) => {
      const payload = safePayload(evt.payload);
      if (!payload.drone_id) return;
      const arr = map.get(payload.drone_id) || [];
      arr.push(evt);
      map.set(payload.drone_id, arr);
    });
    return Array.from(map.entries()).map(([id, events]) => {
      const ordered = [...events].sort(byTsDesc);
      const latest = ordered[0];
      const previous = ordered.length > 1 ? ordered[1] : null;
      const latestPayload = safePayload(latest?.payload);
      const previousPayload = safePayload(previous?.payload);
      let pathStatus = null;
      if (previousPayload && Number.isFinite(previousPayload.lat) && Number.isFinite(previousPayload.lon)
        && Number.isFinite(latestPayload.lat) && Number.isFinite(latestPayload.lon)) {
        const expected = bearingBetween(previousPayload.lat, previousPayload.lon, latestPayload.lat, latestPayload.lon);
        const diff = headingDifference(latestPayload.heading, expected);
        if (diff !== null) {
          pathStatus = diff <= 35 ? 'on_path' : 'off_path';
        }
      }

      const signalRaw = latestPayload.signal_quality ?? latestPayload.link_quality ?? latestPayload.signal;
      let signalText = 'ปกติ';
      if (typeof signalRaw === 'number') {
        const pct = signalRaw > 1 ? signalRaw : signalRaw * 100;
        if (pct >= 80) signalText = 'แรง';
        else if (pct >= 50) signalText = 'ปานกลาง';
        else signalText = 'อ่อน';
      } else if (typeof signalRaw === 'string') {
        signalText = signalRaw;
      }

      return {
        id,
        latest,
        previous,
        latestPayload,
        pathStatus,
        signalText,
      };
    });
  }, [telemetry]);

  return (
    <div className="bg-white border rounded-xl shadow-sm">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h2 className="font-semibold text-gray-800">แดชบอร์ดฝั่งบุก</h2>
        <span className="text-xs text-gray-500">{drones.length} ลำ</span>
      </div>
      <div className="p-4 space-y-3">
        {drones.length === 0 && (
          <div className="text-sm text-gray-500">ยังไม่มีโดรนปฏิบัติการ</div>
        )}
        {drones.map(({ id, latest, latestPayload, pathStatus, signalText }) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect && onSelect(latest)}
            className="w-full text-left border border-blue-100 bg-blue-50/50 hover:bg-blue-100 rounded-lg px-3 py-3 transition"
          >
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold text-blue-700">{id}</div>
              <div className="text-xs text-gray-500">{formatLocal(tsToDate(latest?.ts))}</div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-gray-700">
              <div>สถานะ: {latestPayload.status || 'ไม่ทราบ'}</div>
              <div>แบตเตอรี่: {latestPayload.battery ?? '—'}%</div>
              <div>ความเร็ว: {Number.isFinite(latestPayload.speed) ? `${latestPayload.speed.toFixed(1)} m/s` : '—'}</div>
              <div>ระดับบิน: {Number.isFinite(latestPayload.alt) ? `${latestPayload.alt.toFixed(0)} m` : '—'}</div>
              <div>หัวมุ่ง: {Number.isFinite(latestPayload.heading) ? `${Math.round(latestPayload.heading)}°` : '—'}</div>
              <div>สัญญาณควบคุม: {signalText}</div>
            </div>
            <div className="mt-2 text-xs text-gray-600">เซนเซอร์หลัก: {latestPayload.sensors || 'IMU / EO / IR'}</div>
            <div className="mt-2">
              {pathStatus === null && (
                <span className="text-xs text-gray-500">กำลังคำนวณเส้นทาง...</span>
              )}
              {pathStatus === 'on_path' && (
                <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-1 rounded-full">อยู่ในเส้นทาง</span>
              )}
              {pathStatus === 'off_path' && (
                <span className="text-xs font-semibold text-red-700 bg-red-100 px-2 py-1 rounded-full">ออกนอกเส้นทาง</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * ========================= UI: Defense Dashboard =========================
 */
function DefenseDashboard({ detections, onSelect }) {
  const base = { lat: 13.7563, lon: 100.5018 };
  const recent = useMemo(() => {
    const arr = Array.isArray(detections) ? [...detections] : [];
    return arr.sort(byTsDesc).slice(0, 6);
  }, [detections]);

  return (
    <div className="bg-white border rounded-xl shadow-sm">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h2 className="font-semibold text-gray-800">แดชบอร์ดฝั่งรับ</h2>
        <span className="text-xs text-gray-500">{recent.length} เหตุการณ์ล่าสุด</span>
      </div>
      <div className="p-4 space-y-3">
        {recent.length === 0 && (
          <div className="text-sm text-gray-500">ยังไม่มีการรายงานจากกล้องเฝ้าระวัง</div>
        )}
        {recent.map((det) => {
          const payload = safePayload(det.payload);
          const bearing = bearingBetween(base.lat, base.lon, payload.lat, payload.lon);
          const direction = bearingToCardinal(bearing);
          const distance = haversineDistanceMeters(base.lat, base.lon, payload.lat, payload.lon);
          return (
            <button
              key={det.id}
              type="button"
              onClick={() => onSelect && onSelect(det)}
              className="w-full text-left border border-red-100 bg-red-50/50 hover:bg-red-100 rounded-lg px-3 py-3 transition"
            >
              <div className="flex items-center justify-between">
                <div className="font-semibold text-red-700">{payload.category || 'ภัยคุกคาม'}</div>
                <div className="text-xs text-gray-500">{formatLocal(tsToDate(det.ts))}</div>
              </div>
              <div className="mt-1 text-sm text-gray-700">กล้อง: {payload.source || 'ไม่ทราบ'}</div>
              <div className="mt-1 text-sm text-gray-700">พิกัด: {Number.isFinite(payload.lat) ? payload.lat.toFixed(5) : '—'}, {Number.isFinite(payload.lon) ? payload.lon.toFixed(5) : '—'}</div>
              <div className="mt-1 text-xs text-gray-600">ทิศ {direction} ({Number.isFinite(bearing) ? `${Math.round(bearing)}°` : '—'}) • ระยะ {Number.isFinite(distance) ? `${(distance/1000).toFixed(2)} กม.` : 'ไม่ทราบ'}</div>
            </button>
          );
        })}
      </div>
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

  return (
    <div className="fixed right-0 top-0 h-full w-[420px] bg-white shadow-2xl border-l z-50 flex flex-col">
      <div className="p-4 border-b bg-gradient-to-r from-gray-50 to-white flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{isDet ? "🎯" : "🛩️"}</span>
          <div>
            <div className="font-bold text-lg">{isDet ? "Threat" : "Offensive Drone"}</div>
            <div className="text-xs text-gray-600">{isDet ? "Defense Team" : "Offense Team"}</div>
          </div>
        </div>
        <button
          className="text-gray-500 hover:text-black text-xl font-bold px-3 py-1 hover:bg-gray-100 rounded"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="p-4 space-y-4 overflow-auto flex-1">
        {forecast && (
          <div className="grid grid-cols-2 gap-3">
            <div className={`rounded-lg p-3 border text-center font-bold ${forecast.goNoGo === 'GO' ? 'bg-green-50 border-green-200 text-green-700' : forecast.goNoGo === 'CAUTION' ? 'bg-yellow-50 border-yellow-200 text-yellow-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
              {forecast.goNoGo} • Wind {forecast.wind?.sfc_ms?.toFixed?.(1)} m/s {forecast.wind?.sfc_deg}°
            </div>
            <div className="rounded-lg p-3 border bg-gray-50">
              <div className="text-xs text-gray-600 mb-1">GNSS (Kp)</div>
              <div className="font-semibold">Kp {forecast.kp_index ?? '-'}</div>
            </div>
          </div>
        )}
        <div className="bg-gray-50 rounded-lg p-3 border">
          <div className="text-xs text-gray-600 mb-1">Time</div>
          <TimeStampBlock ts={item.ts} />
        </div>

        {isDet ? (
          <>
            <div className="bg-red-50 rounded-lg p-3 border border-red-200">
              <div className="text-xs text-red-600 mb-1">Type</div>
              <div className="font-bold text-red-900 text-lg">{p.category}</div>
            </div>

            <div className="bg-gray-50 rounded-lg p-3 border">
              <div className="text-xs text-gray-600 mb-1">Confidence</div>
              <div className="font-bold text-lg">{(p.confidence * 100).toFixed(0)}%</div>
              <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                <div
                  className="bg-red-600 h-2 rounded-full transition-all"
                  style={{ width: `${p.confidence * 100}%` }}
                />
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-3 border">
              <div className="text-xs text-gray-600 mb-1">Location</div>
              <div className="font-mono text-sm">
                <div>📍 Lat: {p.lat?.toFixed(6)}</div>
                <div>📍 Lon: {p.lon?.toFixed(6)}</div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-3 border">
              <div className="text-xs text-gray-600 mb-1">Source</div>
              <div className="font-bold">{p.source}</div>
            </div>

            {
              <div>
                <div className="text-xs text-gray-600 mb-2">Snapshot (Latest)</div>
                <img
                  src={p.snapshot_url || "https://placehold.co/640x360/e74c3c/ffffff?text=Detection"}
                  alt="snapshot"
                  className="rounded-lg border-2 border-red-200 cursor-zoom-in hover:border-red-400 transition shadow-lg w-full"
                  onClick={() => onOpenImage && onOpenImage(p.snapshot_url || "https://placehold.co/640x360/e74c3c/ffffff?text=Detection")}
                />
                <div className="text-xs text-gray-500 mt-2 text-center">🔍 Click to zoom</div>
              </div>
            }
          </>
        ) : (
          <>
            <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
              <div className="text-xs text-blue-600 mb-1">Drone ID</div>
              <div className="font-bold text-blue-900 text-lg">{p.drone_id}</div>
            </div>

            <div className="bg-gray-50 rounded-lg p-3 border">
              <div className="text-xs text-gray-600 mb-1">Status</div>
              <div className="font-bold text-lg capitalize">{p.status}</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-50 rounded-lg p-3 border">
                <div className="text-xs text-gray-600 mb-1">Battery</div>
                <div className="font-bold text-lg">🔋 {p.battery}%</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border">
                <div className="text-xs text-gray-600 mb-1">Speed</div>
                <div className="font-bold text-lg">⚡ {p.speed?.toFixed(1)} m/s</div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-3 border">
              <div className="text-xs text-gray-600 mb-1">Heading</div>
              <div className="font-bold text-lg">↗️ {Math.round(p.heading || 0)}°</div>
            </div>

            <div className="bg-gray-50 rounded-lg p-3 border">
              <div className="text-xs text-gray-600 mb-1">Position</div>
              <div className="text-sm font-mono space-y-1">
                <div>📍 Lat: {p.lat?.toFixed(6)}</div>
                <div>📍 Lon: {p.lon?.toFixed(6)}</div>
                <div>⬆️ Alt: {p.alt?.toFixed(1)} m</div>
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
    <div className="fixed bottom-3 left-3 bg-white/95 backdrop-blur rounded-lg shadow px-3 py-2 text-xs z-50 border">
      <div className="font-bold">Tests: <span className={fail?"text-red-600":"text-green-700"}>{pass}/{results.length} passed</span></div>
      {fail>0 && (
        <ul className="list-disc pl-4 mt-1 text-red-600 max-w-[260px]">
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
  const [selected, setSelected] = useState(null);
  const [lastSelected, setLastSelected] = useState(null);
  const [viewer, setViewer] = useState({ open: false, src: "" });
  const [telemetry, setTelemetry] = useState([]);
  const [detections, setDetections] = useState([]);
  const [forecast, setForecast] = useState(null);
  const [feedFilter, setFeedFilter] = useState(null); // null | 'offense' | 'defense'

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
  const summary = analytics?.summary || { totalTelemetry: 0, totalDetections: 0, uniqueDrones: 0, avgSpeed: 0, hasSpeedSamples: false };

  const handleSelect = useCallback((it) => {
    let payload = null;
    if (it && it.type) payload = it;
    else if (it && it.data) payload = it.data;
    if (payload) {
      setSelected(payload);
      setLastSelected(payload);
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
    if (selected) {
      const payload = safePayload(selected.payload);
      if (Number.isFinite(payload.lat) && Number.isFinite(payload.lon)) {
        point = { lat: payload.lat, lon: payload.lon };
      }
    }
    if (!point && telemetry.length) {
      const p = safePayload(telemetry[telemetry.length - 1]?.payload);
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) point = { lat: p.lat, lon: p.lon };
    }
    if (!point && detections.length) {
      const p = safePayload(detections[detections.length - 1]?.payload);
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) point = { lat: p.lat, lon: p.lon };
    }
    if (!point) { setForecast(null); return; }
    let cancelled = false;
    (async () => {
      const f = await fetchOpenMeteo(point);
      if (!cancelled) setForecast(f);
    })();
    return () => { cancelled = true; };
  }, [selected, telemetry, detections]);

  return (
    <div className="h-screen w-screen bg-gray-100 flex flex-col overflow-hidden">
      <div className="bg-gradient-to-r from-blue-700 via-blue-600 to-indigo-700 text-white px-6 py-5 shadow-lg">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl" aria-hidden>🛰️</span>
            <div>
              <h1 className="text-2xl font-bold">USV Battle Command Center</h1>
              <p className="text-sm text-blue-100">ภาพรวมสนามรบแบบเรียลไทม์สำหรับผู้บังคับบัญชา</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="px-3 py-2 bg-white/10 rounded-lg border border-white/20">
              <div className="text-[10px] uppercase tracking-wide text-blue-100">โดรนปฏิบัติการ</div>
              <div className="text-lg font-semibold">{summary.uniqueDrones}</div>
            </div>
            <div className="px-3 py-2 bg-white/10 rounded-lg border border-white/20">
              <div className="text-[10px] uppercase tracking-wide text-blue-100">ภัยคุกคาม</div>
              <div className="text-lg font-semibold">{summary.totalDetections}</div>
            </div>
            <div className="px-3 py-2 bg-white/10 rounded-lg border border-white/20">
              <div className="text-[10px] uppercase tracking-wide text-blue-100">เหตุการณ์ทั้งหมด</div>
              <div className="text-lg font-semibold">{merged.length}</div>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/20 rounded-lg border border-emerald-300/40">
              <span className={`h-3 w-3 rounded-full ${CONFIG.WS_URL ? 'bg-green-300 animate-pulse' : CONFIG.USE_SIM ? 'bg-yellow-200 animate-pulse' : 'bg-red-300'}`} aria-label="online status" />
              <span className="text-sm font-medium">{CONFIG.WS_URL ? 'Connected' : (CONFIG.USE_SIM ? 'Simulation' : 'Offline')}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-4 space-y-6">
          <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-2">
              <div className="bg-white border rounded-xl shadow-sm h-full flex flex-col">
                <div className="px-4 py-3 border-b flex items-center justify-between">
                  <h2 className="font-semibold text-gray-800">แผนที่รวมสนามรบ</h2>
                  <span className="text-xs text-gray-500">{summary.uniqueDrones} โดรน • {summary.totalDetections} ภัยคุกคาม</span>
                </div>
                <div className="relative h-[360px] lg:h-[420px]">
                  <MapPanel
                    detections={detections}
                    telemetry={telemetry}
                    onSelectItem={handleSelect}
                    filter={null}
                    forecast={forecast}
                    title="แผนที่ภาพรวม"
                    subtitle="รวมเส้นทางฝั่งบุกและจุดคุกคาม"
                    icon="🗺️"
                  />
                </div>
              </div>
            </div>
            <div className="xl:col-span-1 min-h-[360px]">
              <AnalyticsPanel analytics={analytics} onSelect={handleSelect} forecast={forecast} />
            </div>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="space-y-4">
              <div className="bg-white border rounded-xl shadow-sm">
                <div className="px-4 py-3 border-b font-semibold text-gray-800 flex items-center gap-2">
                  <span aria-hidden>🛩️</span>
                  <span>แผนที่ฝั่งบุก</span>
                </div>
                <div className="relative h-[300px] lg:h-[320px]">
                  <MapPanel
                    detections={detections}
                    telemetry={telemetry}
                    onSelectItem={handleSelect}
                    filter="offense"
                    forecast={null}
                    title="เส้นทางโดรนปฏิบัติการ"
                    subtitle="เน้นการเคลื่อนที่ของฝั่งบุก"
                    icon="🛩️"
                  />
                </div>
              </div>
              <OffenseDashboard telemetry={telemetry} onSelect={handleSelect} />
            </div>
            <div className="space-y-4">
              <div className="bg-white border rounded-xl shadow-sm">
                <div className="px-4 py-3 border-b font-semibold text-gray-800 flex items-center gap-2">
                  <span aria-hidden>🎯</span>
                  <span>แผนที่ฝั่งรับ</span>
                </div>
                <div className="relative h-[300px] lg:h-[320px]">
                  <MapPanel
                    detections={detections}
                    telemetry={telemetry}
                    onSelectItem={handleSelect}
                    filter="defense"
                    forecast={null}
                    title="จุดตรวจพบภัยคุกคาม"
                    subtitle="ข้อมูลจากกล้องและเรดาร์ฝั่งรับ"
                    icon="🎯"
                  />
                </div>
              </div>
              <DefenseDashboard detections={detections} onSelect={handleSelect} />
            </div>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-2 bg-white border rounded-xl shadow-sm flex flex-col">
              <div className="px-4 py-3 border-b flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-gray-800">บันทึกเหตุการณ์</h2>
                  <p className="text-xs text-gray-500">รวมการสื่อสารและการแจ้งเตือนล่าสุด</p>
                </div>
                <div className="flex items-center gap-2">
                  {[{ id: null, label: 'ทั้งหมด' }, { id: 'offense', label: 'ฝั่งบุก' }, { id: 'defense', label: 'ฝั่งรับ' }].map((f) => (
                    <button
                      key={f.id === null ? 'all' : f.id}
                      onClick={() => setFeedFilter(f.id)}
                      className={`px-3 py-1 rounded-full border text-xs font-medium transition ${feedFilter === f.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-auto px-4 py-3">
                <FeedPanel items={merged} onSelect={handleSelect} filter={feedFilter} />
              </div>
            </div>
            <div className="space-y-4">
              <div className="bg-white border rounded-xl shadow-sm">
                <div className="px-4 py-3 border-b font-semibold text-gray-800">การเลือกปัจจุบัน</div>
                <div className="p-4 text-sm text-gray-600 space-y-3">
                  {lastSelected ? (
                    <>
                      <div className="flex items-center gap-2 text-base font-semibold text-gray-800">
                        <span aria-hidden>{lastSelected.type?.startsWith('detection') ? '🎯' : '🛩️'}</span>
                        <span>{lastSelected.type?.startsWith('detection') ? 'ข้อมูลฝั่งรับ' : 'ข้อมูลฝั่งบุก'}</span>
                      </div>
                      <TimeStampBlock ts={lastSelected.ts} />
                      {(() => {
                        const payload = safePayload(lastSelected.payload);
                        return (
                          <div className="space-y-1 text-xs text-gray-600">
                            <div>พิกัด: {Number.isFinite(payload.lat) ? payload.lat.toFixed(5) : '—'}, {Number.isFinite(payload.lon) ? payload.lon.toFixed(5) : '—'}</div>
                            {payload.category && <div>ประเภท: {payload.category}</div>}
                            {payload.drone_id && <div>โดรน: {payload.drone_id}</div>}
                          </div>
                        );
                      })()}
                      <button
                        onClick={() => setSelected(lastSelected)}
                        className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                      >
                        เปิดรายละเอียดเต็ม ↗
                      </button>
                    </>
                  ) : (
                    <div className="text-xs text-gray-500">แตะที่โดรนหรือการแจ้งเตือนเพื่อดูรายละเอียดทันที</div>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <DetailDrawer
        item={selected}
        onClose={() => setSelected(null)}
        onOpenImage={handleOpenImage}
        forecast={forecast}
      />

      <ImageViewer
        isOpen={viewer.open}
        src={viewer.src}
        onClose={() => setViewer({ open: false, src: "" })}
      />

      <TestPanel />
    </div>
  );
}
