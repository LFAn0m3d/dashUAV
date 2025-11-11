# DashUAV

DashUAV now ships with a lightweight backend that can ingest live telemetry and detection events and stream them to the React dashboard.

## Backend

The backend lives in [`server/`](server/) and exposes both REST and WebSocket interfaces.

### Features

- `POST /api/telemetry` and `POST /api/detections` accept JSON payloads (single object or array) and normalise them into the dashboard event format.
- `POST /api/events` lets you push pre-formatted events in bulk.
- `GET /api/events`, `/api/telemetry`, and `/api/detections` expose the recent buffers for polling clients.
- A WebSocket endpoint at `/ws` streams every accepted event to connected clients in real time.
- Buffers sizes are capped via environment variables (`MAX_EVENTS`, `MAX_TELEMETRY`, `MAX_DETECTIONS`).

### Running locally

```bash
cd server
npm install
npm run dev
```

By default the backend listens on port `8080`. You can override the port with the `PORT` environment variable. The service responds to `GET /healthz` with a simple health payload.

When the backend and frontend are served from the same origin, the dashboard will automatically connect to `ws://<host>/ws` or `https://<host>/api/events` without any extra configuration. You can override the defaults by setting `window.__APP_CONFIG__` before mounting the React app, for example:

```html
<script>
  window.__APP_CONFIG__ = {
    WS_URL: "wss://dash.example.com/ws",
    HTTP_POLL_URL: "https://dash.example.com/api/events",
    USE_SIM: false,
  };
</script>
```

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

## Frontend

The React dashboard remains in [`usv_dash.jsx`](usv_dash.jsx). When no backend configuration is provided it can still run in simulator mode by opening the page with `?sim=1`.
