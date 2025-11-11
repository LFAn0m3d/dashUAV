# DashUAV

DashUAV now ships with a lightweight backend that can ingest live telemetry and detection events and stream them to the React dashboard.

## Quick start

Follow the steps below to run the entire stack (backend + dashboard) on your machine. The commands assume you have **Node.js 18+** and **npm** available in your shell.

### 1. Clone the repository

```bash
git clone https://github.com/<your-org>/dashUAV.git
cd dashUAV
```

### 2. Start the backend API/WebSocket service

```bash
cd server
npm install
npm run dev
```

The backend listens on <http://localhost:8080> and exposes REST + WebSocket endpoints for telemetry and detection events. Leave this terminal tab open so the process keeps running.

### 3. Spin up a React host for the dashboard

The repository ships the dashboard as a single React component (`usv_dash.jsx`). You can embed it into any existing React project. For a clean-room setup, the following snippet creates a Vite dev environment in a sibling folder, wires the dashboard, and launches the UI:

```bash
# from the repository root (/path/to/dashUAV)
cd ..
npm create vite@latest dashuav-frontend -- --template react
cd dashuav-frontend
npm install

# bring the dashboard component into the new React app
cp ../dashUAV/usv_dash.jsx src/DashUAVDashboard.jsx

# replace the generated App component so it renders the dashboard
cat <<'EOF' > src/App.jsx
import DashUAVDashboard from "./DashUAVDashboard";

export default function App() {
  return <DashUAVDashboard />;
}
EOF

# expose backend endpoints to the dashboard (ports differ between dev servers)
cat <<'EOF' > public/config.js
window.__APP_CONFIG__ = {
  WS_URL: "ws://localhost:8080/ws",
  HTTP_POLL_URL: "http://localhost:8080/api/events",
  USE_SIM: false,
};
EOF

# ensure the config file loads before the React bundle executes
sed -i 's#<body>#<body>\n    <script src="/config.js"></script>#' index.html

npm run dev
```

Vite will print a local URL (typically <http://localhost:5173>). Open it in your browser **after** the backend is running. The dashboard will read the configuration from `public/config.js`, connect to the backend, and stream live updates. If you prefer to run in simulator-only mode, omit `public/config.js` and open the app with `?sim=1`.

> ℹ️ If you already have a React host, copy `usv_dash.jsx` into your project, import it, and set `window.__APP_CONFIG__` before mounting the component (either inline in HTML or by bundling a small script).

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
