# DashUAV

DashUAV is organised as an npm workspace with separate packages for the React control centre and the backend API.

```
.
├─ apps/
│  ├─ ui/        # Vite + React + Router + Tailwind + shadcn/ui primitives
│  └─ api/       # Express backend exposing REST and WebSocket streams
├─ package.json  # npm workspaces definition
└─ .env          # Runtime configuration (API keys, map tokens, ...)
```

## Frontend (`apps/ui`)

The UI is built with Vite, React Router, Tailwind CSS, Zustand, and lightweight shadcn/ui primitives. The project bootstraps a
multi-page dashboard including views for the mission overview, map, threats, data exports, settings, and authentication.

```bash
npm install
npm run dev
```

The commands above install dependencies for every workspace and start the Vite dev server on port `5173`. To build or preview
production assets use:

```bash
npm run build
npm run preview --workspace apps/ui
```

Tailwind is configured via `tailwind.config.js` and reads environment variables from `.env`. Do not hard-code API tokens in the
codebase—define them in `.env` or inject them at runtime through `window.__APP_CONFIG__`.

## Backend (`apps/api`)

The backend is an Express service that accepts telemetry and detection payloads and streams them to connected clients (either by
polling or via WebSocket).

```bash
npm run dev --workspace apps/api
```

### Features

- `POST /api/telemetry` and `POST /api/detections` accept JSON payloads (single object or array) and normalise them into events.
- `POST /api/events` lets you push pre-formatted events in bulk.
- `GET /api/events`, `/api/telemetry`, and `/api/detections` expose the recent buffers for polling clients.
- A WebSocket endpoint at `/ws` streams every accepted event to connected clients in real time.
- Buffer sizes are configurable via environment variables (`MAX_EVENTS`, `MAX_TELEMETRY`, `MAX_DETECTIONS`).

The backend listens on port `8080` by default. Override the port with the `PORT` environment variable.

### Testing

```bash
npm test
```

This runs the Node.js test suite inside `apps/api/test`.

### Posting sample data

```bash
curl -X POST http://localhost:8080/api/telemetry \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "drone_id": "BLUE-1",
      "lat": 13.7563,
      "lon": 100.5018,
      "alt": 120,
      "heading": 270,
      "speed": 13.2,
      "battery": 82
    }
  }'
```

When the backend and frontend are served from the same origin, the dashboard automatically connects to `ws://<host>/ws` or
`https://<host>/api/events`. Override the defaults by setting `window.__APP_CONFIG__` before mounting the React app.
