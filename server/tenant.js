// Workspaces (tenants). Each business on the platform — e.g. Tech Solutionor, or a customer the
// super admin gives access — is a workspace with its own numbers, contacts, campaigns, chats,
// catalogs, settings and team. Every request, WhatsApp event and worker run happens "inside"
// one workspace; the database layer (db/mongo.js) reads that here and scopes every query to it,
// so one workspace can never see or change another's data.
import { AsyncLocalStorage } from 'node:async_hooks';

// The business that used the app before workspaces existed. It keeps the original main
// WhatsApp number (data/wa_auth) and the original settings document.
export const DEFAULT_WS = 'default';

const als = new AsyncLocalStorage();

// The workspace the current code runs for (null = platform level, e.g. the Super Admin page
// listing every workspace, or startup).
export function currentWs() {
  return als.getStore()?.ws || null;
}

// Run fn inside a workspace. Everything it awaits, and timers/promises it starts, stay inside.
export function runInWs(ws, fn) {
  return als.run({ ws: ws || null }, fn);
}

// Wrap a callback so it always runs inside this workspace — for event handlers (an
// EventEmitter runs handlers in the context of whoever emits, not whoever subscribed).
export function inWs(ws, fn) {
  return function (...args) {
    return als.run({ ws: ws || null }, () => fn.apply(this, args));
  };
}

// Tests only: make the rest of the current async flow run inside a workspace.
export function enterWs(ws) {
  als.enterWith({ ws: ws || null });
}

// Tests set PULSE_STRICT_WS=1: workspace data touched outside any workspace throws instead of
// falling back to the default workspace, so a missing scope can't hide.
export const STRICT_WS = process.env.PULSE_STRICT_WS === '1';
