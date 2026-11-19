const base = '/api';

// The workspace this tab works in. Only the super admin can pick one (everyone else always
// works in their own — the server ignores this for them). Kept per tab, so two tabs can show
// two different workspaces; new tabs start where you last were.
let workspace = '';
try {
  workspace = sessionStorage.getItem('pulse_ws') || localStorage.getItem('pulse_ws') || '';
} catch {}
export const getWorkspace = () => workspace;
export function setWorkspace(id) {
  workspace = id || '';
  try {
    sessionStorage.setItem('pulse_ws', workspace);
    localStorage.setItem('pulse_ws', workspace);
  } catch {}
}

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (workspace) opts.headers['X-Workspace'] = workspace;
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
  // 403 "no access" → the super admin changed this user's pages; re-read them.
  if (res.status === 403 && data.noAccess) window.dispatchEvent(new Event('auth:changed'));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (p) => req('GET', p),
  post: (p, b) => req('POST', p, b),
  put: (p, b) => req('PUT', p, b),
  del: (p, b) => req('DELETE', p, b),
};

// Subscribe to the server's SSE stream. Returns an unsubscribe fn.
export function subscribe(onEvent) {
  const es = new EventSource(base + '/events' + (workspace ? `?ws=${encodeURIComponent(workspace)}` : ''));
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
    'admin:update',
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
