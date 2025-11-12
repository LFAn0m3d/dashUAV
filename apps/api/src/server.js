import http from 'http';
import morgan from 'morgan';
import { createBackend } from './backend.js';

const backend = createBackend();
const { app, attachWebSocketServer, config } = backend;

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`DashUAV backend listening on port ${config.port}`);
});
