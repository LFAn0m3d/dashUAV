import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normaliseOrigins(origins) {
  if (Array.isArray(origins)) {
    return origins.map((origin) => origin.trim()).filter(Boolean);
  }
  return String(origins || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function safeId() {
  try {
    return randomUUID();
  } catch (error) {
    return `evt_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function sanitisePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  return payload;
}

export function createBackend(options = {}) {
  const config = {
    port: parseNumber(options.port ?? process.env.PORT, 8080),
    maxEvents: parseNumber(options.maxEvents ?? process.env.MAX_EVENTS, 5000),
    maxTelemetry: parseNumber(options.maxTelemetry ?? process.env.MAX_TELEMETRY, 2000),
    maxDetections: parseNumber(options.maxDetections ?? process.env.MAX_DETECTIONS, 2000),
    defaultEventLimit: parseNumber(
      options.defaultEventLimit ?? process.env.DEFAULT_EVENT_LIMIT,
      200,
    ),
    corsOrigins: normaliseOrigins(options.corsOrigins ?? process.env.CORS_ORIGINS ?? '*'),
  };

  const allowAllOrigins = config.corsOrigins.includes('*');
  const allowedOrigins = new Set(
    config.corsOrigins.filter((origin) => origin !== '*'),
  );

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  app.use(
    cors({
      origin: (origin, callback) => {
        if (allowAllOrigins || !origin || allowedOrigins.has(origin)) {
          callback(null, origin || true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    }),
  );

  const state = {
    telemetry: [],
    detections: [],
    events: [],
  };

  let wss;

  function broadcastEvent(evt) {
    if (!wss || wss.clients.size === 0) {
      return;
    }
    const data = JSON.stringify({ kind: 'event', event: evt });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  function pushBounded(list, item, max) {
    list.push(item);
    if (list.length > max) {
      list.splice(0, list.length - max);
    }
  }

  function normaliseEvent(input, fallbackType) {
    if (!input || typeof input !== 'object') {
      return null;
    }

    const type =
      typeof input.type === 'string' && input.type.trim().length > 0
        ? input.type.trim()
        : fallbackType;

    if (!type) {
      return null;
    }

    const ts = toTimestamp(input.ts ?? Date.now());
    const id = input.id || safeId();

    const event = {
      id,
      type,
      ts,
      payload: sanitisePayload(input.payload),
      meta:
        input.meta && typeof input.meta === 'object' ? input.meta : undefined,
    };

    return event;
  }

  function ingest(event) {
    if (!event) {
      return false;
    }

    pushBounded(state.events, event, config.maxEvents);

    if (event.type.startsWith('telemetry')) {
      pushBounded(state.telemetry, event, config.maxTelemetry);
    } else if (event.type.startsWith('detection')) {
      pushBounded(state.detections, event, config.maxDetections);
    }

    broadcastEvent(event);
    return true;
  }

  function ingestMany(events, fallbackType) {
    let accepted = 0;
    const arr = Array.isArray(events) ? events : [events];
    for (const raw of arr) {
      const evt = normaliseEvent(raw, fallbackType);
      if (evt && ingest(evt)) {
        accepted += 1;
      }
    }
    return accepted;
  }

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/api/events', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10);
    const since = Number.parseInt(req.query.since, 10);

    let events = state.events;
    if (Number.isFinite(since)) {
      events = events.filter((evt) => toTimestamp(evt.ts) > since);
    }

    const effectiveLimit = Number.isFinite(limit)
      ? Math.min(Math.max(limit, 1), config.maxEvents)
      : config.defaultEventLimit;

    res.json(events.slice(-effectiveLimit));
  });

  app.get('/api/telemetry', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10);
    const effectiveLimit = Number.isFinite(limit)
      ? Math.min(Math.max(limit, 1), config.maxTelemetry)
      : Math.min(200, config.maxTelemetry);

    res.json(state.telemetry.slice(-effectiveLimit));
  });

  app.get('/api/detections', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10);
    const effectiveLimit = Number.isFinite(limit)
      ? Math.min(Math.max(limit, 1), config.maxDetections)
      : Math.min(200, config.maxDetections);

    res.json(state.detections.slice(-effectiveLimit));
  });

  app.get('/api/summary', (_req, res) => {
    const latestTelemetry = state.telemetry[state.telemetry.length - 1];
    const latestDetection = state.detections[state.detections.length - 1];

    res.json({
      totals: {
        events: state.events.length,
        telemetry: state.telemetry.length,
        detections: state.detections.length,
      },
      latestTelemetry: latestTelemetry ?? null,
      latestDetection: latestDetection ?? null,
    });
  });

  app.post('/api/telemetry', (req, res) => {
    const accepted = ingestMany(req.body, 'telemetry:update');
    if (!accepted) {
      res.status(400).json({ error: 'No valid telemetry payloads accepted' });
      return;
    }
    res.status(202).json({ accepted });
  });

  app.post('/api/detections', (req, res) => {
    const accepted = ingestMany(req.body, 'detection:new');
    if (!accepted) {
      res.status(400).json({ error: 'No valid detection payloads accepted' });
      return;
    }
    res.status(202).json({ accepted });
  });

  app.post('/api/events', (req, res) => {
    const accepted = ingestMany(req.body, undefined);
    if (!accepted) {
      res.status(400).json({ error: 'No valid events accepted' });
      return;
    }
    res.status(202).json({ accepted });
  });

  app.use((err, _req, res, _next) => {
    if (err?.message === 'Not allowed by CORS') {
      res.status(403).json({ error: 'Origin not allowed by CORS policy' });
      return;
    }

    if (err?.type === 'entity.parse.failed') {
      res.status(err.statusCode ?? 400).json({ error: 'Invalid JSON payload' });
      return;
    }

    // eslint-disable-next-line no-console
    console.error('Unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  function attachWebSocketServer(server, path = '/ws') {
    wss = new WebSocketServer({ server, path });
    wss.on('connection', (socket) => {
      socket.send(
        JSON.stringify({ kind: 'hello', message: 'DashUAV stream ready' }),
      );
      const snapshot = state.events.slice(-config.defaultEventLimit);
      if (snapshot.length) {
        socket.send(JSON.stringify({ kind: 'snapshot', events: snapshot }));
      }
    });
    return wss;
  }

  return {
    app,
    state,
    config,
    normaliseEvent,
    ingest,
    ingestMany,
    attachWebSocketServer,
  };
}

export { toTimestamp };
