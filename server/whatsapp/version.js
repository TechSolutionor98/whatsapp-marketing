import { fetchLatestBaileysVersion } from 'baileys';

// The WhatsApp Web version to announce. Fetching it costs an HTTP round trip (100–400 ms
// measured) before every QR / reconnect, so fetch once and reuse it; refresh in the
// background every few hours so it doesn't go stale.
const REFRESH_MS = 6 * 60 * 60 * 1000;
let cached = null;
let fetchedAt = 0;
let inflight = null;

function refresh() {
  inflight ||= fetchLatestBaileysVersion()
    .then(({ version }) => {
      cached = version;
      fetchedAt = Date.now();
      return version;
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
  return refresh();
}

// Warm the cache at boot so the very first QR doesn't wait for it either.
refresh().catch(() => {});
