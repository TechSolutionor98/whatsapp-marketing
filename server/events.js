// Tiny in-process event bus bridged to the browser over Server-Sent Events.
// Every event belongs to the workspace it happened in, and only that workspace's open pages
// receive it (events carry chat updates, number lists and QR codes). Platform-level events
// (no workspace) go to the super admin only.
import { EventEmitter } from 'node:events';
import { currentWs } from './tenant.js';

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

  const client = { res, ws: req.ws || null, owner: req.user?.role === 'owner' };
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

// opts.ws overrides the workspace (null = platform level).
export function emit(event, data, opts = {}) {
  const ws = opts.ws !== undefined ? opts.ws : currentWs();
  // Local listeners (e.g. worker reacting to connection changes) get the workspace too.
  bus.emit(event, data, ws);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const c of clients) {
    if (ws ? c.ws !== ws : !c.owner) continue;
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}
