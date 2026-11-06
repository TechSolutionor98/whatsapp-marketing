const base = '/api';

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, { ...opts, credentials: 'same-origin' });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  // A 401 on anything other than the auth probe means the session lapsed.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (p) => req('GET', p),
  post: (p, b) => req('POST', p, b),
  put: (p, b) => req('PUT', p, b),
  del: (p) => req('DELETE', p),
};

// Subscribe to the server's SSE stream. Returns an unsubscribe fn.
export function subscribe(onEvent) {
  const es = new EventSource(base + '/events');
  const events = [
    'wa:status',
    'wa:qr',
    'message:in',
    'message:out',
    'stats:dirty',
    'campaign:update',
    'pool:update',
    'warmup:update',
    'message:status',
  ];
  for (const ev of events) {
    es.addEventListener(ev, (e) => {
      let data = {};
      try {
        data = JSON.parse(e.data);
      } catch {}
      onEvent(ev, data);
    });
  }
  return () => es.close();
}
