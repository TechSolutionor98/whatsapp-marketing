// Tiny in-process event bus bridged to the browser over Server-Sent Events.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const clients = new Set();

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const client = { res };
  clients.add(client);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function emit(event, data) {
  // Local listeners (e.g. worker reacting to connection changes).
  bus.emit(event, data);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}
