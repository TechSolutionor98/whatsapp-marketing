import { fetchLatestBaileysVersion, DEFAULT_CONNECTION_CONFIG } from 'baileys';

// The WhatsApp Web version to announce. Fetching it costs an HTTP round trip (100–400 ms
// measured) before every QR / reconnect, so fetch once and reuse it; refresh in the
// background every few hours.
//
// Baileys' fetchLatestBaileysVersion uses axios with NO timeout — a stalled request never
// resolves, and every connection waiting on it would hang silently. So: a hard timeout, and
// fall back to the version bundled with Baileys (what it uses itself when the fetch fails).
const REFRESH_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;
let cached = null;
let fetchedAt = 0;
let inflight = null;

function refresh() {
  inflight ||= Promise.race([
    fetchLatestBaileysVersion({ timeout: TIMEOUT_MS }),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), TIMEOUT_MS + 500)),
  ])
    .then((r) => {
      if (r?.version && r.isLatest) {
        cached = r.version;
        fetchedAt = Date.now();
      }
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function getWaVersion() {
  if (cached) {
    if (Date.now() - fetchedAt > REFRESH_MS) refresh().catch(() => {});
    return cached;
  }
  const r = await refresh().catch(() => null);
  if (cached) return cached;
  // Couldn't fetch in time: use Baileys' bundled version — never block the connection, and
  // never return undefined (makeWASocket spreads our config over its defaults, so an
  // undefined version would wipe out its own default).
  return r?.version || DEFAULT_CONNECTION_CONFIG.version;
}

// Warm the cache at boot so the very first QR doesn't wait for it either.
refresh().catch(() => {});
