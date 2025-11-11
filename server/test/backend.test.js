import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBackend } from '../src/backend.js';

function createTestBackend() {
  return createBackend({
    port: 0,
    maxEvents: 20,
    maxTelemetry: 10,
    maxDetections: 10,
    defaultEventLimit: 5,
    corsOrigins: '*',
  });
}

async function withServer(app, onStart) {
  const server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, resolve);
  });
  const { port } = server.address();
  try {
    await onStart({ server, port });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('ingests telemetry payloads and exposes them via APIs', async () => {
  const backend = createTestBackend();

  await withServer(backend.app, async ({ port }) => {
    const baseUrl = `http://127.0.0.1:${port}`;

    const telemetryPayload = {
      payload: {
        drone_id: 'BLUE-1',
        lat: 13.7563,
        lon: 100.5018,
      },
    };

    const response = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(telemetryPayload),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, 1);
    assert.equal(backend.state.telemetry.length, 1);
    assert.equal(backend.state.events.length, 1);

    const eventsResponse = await fetch(`${baseUrl}/api/events?limit=10`);
    assert.equal(eventsResponse.status, 200);
    const eventsBody = await eventsResponse.json();
    assert.equal(eventsBody.length, 1);
    assert.equal(eventsBody[0].type, 'telemetry:update');

    const telemetryResponse = await fetch(`${baseUrl}/api/telemetry`);
    assert.equal(telemetryResponse.status, 200);
    const telemetryBody = await telemetryResponse.json();
    assert.equal(telemetryBody.length, 1);
    assert.equal(telemetryBody[0].payload.drone_id, 'BLUE-1');
  });
});

test('rejects invalid telemetry payloads', async () => {
  const backend = createTestBackend();

  await withServer(backend.app, async ({ port }) => {
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(null),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.deepEqual(body, { error: 'Invalid JSON payload' });
    assert.equal(backend.state.telemetry.length, 0);
  });
});

test('websocket clients receive snapshots and live updates', async () => {
  const backend = createTestBackend();

  await withServer(backend.app, async ({ server, port }) => {
    backend.attachWebSocketServer(server);

    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'system:ready',
        payload: { status: 'ready' },
      }),
    });

    const messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const messagePromise = new Promise((resolve, reject) => {
      ws.on('message', async (data) => {
        const payload = JSON.parse(data.toString());
        messages.push(payload);

        if (messages.length === 2) {
          try {
            await fetch(`${baseUrl}/api/telemetry`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                payload: { drone_id: 'BLUE-2' },
              }),
            });
          } catch (error) {
            reject(error);
          }
        }

        if (messages.length === 3) {
          resolve();
        }
      });
      ws.on('error', reject);
    });

    await messagePromise;

    assert.equal(messages[0].kind, 'hello');
    assert.equal(messages[1].kind, 'snapshot');
    assert.equal(messages[1].events.length, 1);
    assert.equal(messages[2].kind, 'event');
    assert.equal(messages[2].event.type, 'telemetry:update');

    ws.close();
    await once(ws, 'close').catch(() => {});
  });
});
