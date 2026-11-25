import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Loading, Empty, timeAgo } from '../ui.jsx';

// Developer page: API keys, the POS receipt guide, the API reference and the request log. Software
// (a POS "Send on WhatsApp" button, a website, a CRM) sends through this workspace's numbers with
// a key; the server is /api/v1 (server/routes/public-api.js).

const TABS = [
  ['number', 'Number & sending', 'phone'],
  ['keys', 'API keys', 'key'],
  ['pos', 'POS receipt button', 'receipt'],
  ['reference', 'API reference', 'book'],
  ['logs', 'Request log', 'logs'],
];
const KEY_HOLDER = 'YOUR_API_KEY';
const apiBase = () => `${window.location.origin}/api/v1`;
const numName = (n) => `${n.label || n.name || 'Number'} · +${n.phone}${n.kind === 'cloud' ? ' (Official API)' : ''}`;
const fmtNum = (n) => Number(n || 0).toLocaleString();
// "in 45 s" / "in 3 min" / "now"
const fromNow = (iso) => {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (!(s > 1)) return 'now';
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
const secs = (n) => (n < 60 ? `${n} second${n === 1 ? '' : 's'}` : n % 60 === 0 ? `${n / 60} minute${n === 60 ? '' : 's'}` : `${Math.floor(n / 60)} min ${n % 60} s`);
// What a key's "Send from: Automatic" means right now.
const automaticName = (data) => {
  if (data.api_number?.phone) return `Automatic — the API number (+${data.api_number.phone})`;
  const d = data.numbers.find((n) => n.default);
  return `Automatic — default Gateway number${d ? ` (+${d.phone})` : ''}`;
};

function useCopy() {
  const { toast } = useApp();
  return async (text, what = 'Text') => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`, 'success');
    } catch {
      toast('Select the text and copy it', 'error');
    }
  };
}

function CopyLine({ label, value, mono = true }) {
  const copy = useCopy();
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <div className="copy-field">
        <input className={`input ${mono ? '' : 'plain'}`} readOnly value={value} onFocus={(e) => e.target.select()} aria-label={label || 'Value'} />
        <button type="button" className="btn sm" onClick={() => copy(value, label || 'Text')}><Icon.copy /> Copy</button>
      </div>
    </div>
  );
}

function CodeBlock({ code, label }) {
  const copy = useCopy();
  return (
    <div className="dev-code">
      <div className="dev-code-head">
        <span>{label}</span>
        <button type="button" onClick={() => copy(code, label || 'Code')}><Icon.copy /> Copy</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

// One example in several languages; the choice is remembered.
function CodeTabs({ samples }) {
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem('pulse.devLang') || samples[0][0];
    } catch {
      return samples[0][0];
    }
  });
  const cur = samples.find((s) => s[0] === lang) || samples[0];
  const pick = (id) => {
    setLang(id);
    try {
      localStorage.setItem('pulse.devLang', id);
    } catch {}
  };
  return (
    <div className="dev-codetabs">
      <div className="dev-langs" role="tablist">
        {samples.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={cur[0] === id} className={cur[0] === id ? 'on' : ''} onClick={() => pick(id)}>{label}</button>
        ))}
      </div>
      <CodeBlock code={cur[2]} label={cur[1]} />
    </div>
  );
}

// ---- Code samples (the base URL and key are filled in) ----

function receiptSamples(base, key = KEY_HOLDER) {
  return [
    [
      'curl',
      'cURL',
      `curl -X POST ${base}/messages \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "971501234567",
    "text": "Thank you for shopping with us! Your receipt INV-1043 is attached. Total: AED 162.00",
    "document": { "url": "https://your-pos.com/receipts/INV-1043.pdf", "filename": "INV-1043.pdf" },
    "reference": "INV-1043"
  }'`,
    ],
    [
      'js',
      'JavaScript',
      `// Node.js 18+ (on your POS server, so the key stays private)
async function sendReceiptOnWhatsApp(receipt, pdfBuffer) {
  const res = await fetch('${base}/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.WHATSAPP_API_KEY, // ${key}
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: receipt.customerPhone,            // e.g. "971501234567"
      text: \`Thank you for shopping with us! Receipt \${receipt.number}, total \${receipt.total}\`,
      document: { base64: pdfBuffer.toString('base64'), filename: \`\${receipt.number}.pdf\` },
      reference: receipt.number,            // the same receipt never goes out twice
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error.message); // show this to the cashier
  return data; // { id, status: "sent", ... }
}`,
    ],
    [
      'php',
      'PHP',
      `<?php
$payload = [
    'to'        => '971501234567',
    'text'      => 'Thank you for shopping with us! Receipt INV-1043, total AED 162.00',
    'document'  => [
        'base64'   => base64_encode(file_get_contents('/path/to/INV-1043.pdf')),
        'filename' => 'INV-1043.pdf',
    ],
    'reference' => 'INV-1043',
];

$ch = curl_init('${base}/messages');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 60,
    CURLOPT_HTTPHEADER     => ['Authorization: Bearer ${key}', 'Content-Type: application/json'],
    CURLOPT_POSTFIELDS     => json_encode($payload),
]);
$data   = json_decode(curl_exec($ch), true);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($status >= 400) {
    echo 'Not sent: ' . $data['error']['message'];
} else {
    echo 'Sent on WhatsApp (' . $data['status'] . ')';
}`,
    ],
    [
      'python',
      'Python',
      `import base64
import requests

with open("INV-1043.pdf", "rb") as f:
    pdf = base64.b64encode(f.read()).decode()

r = requests.post(
    "${base}/messages",
    headers={"Authorization": "Bearer ${key}"},
    json={
        "to": "971501234567",
        "text": "Thank you for shopping with us! Receipt INV-1043, total AED 162.00",
        "document": {"base64": pdf, "filename": "INV-1043.pdf"},
        "reference": "INV-1043",
    },
    timeout=60,
)
data = r.json()
if r.ok:
    print("Sent on WhatsApp:", data["status"])
else:
    print("Not sent:", data["error"]["message"])`,
    ],
    [
      'csharp',
      'C# (.NET)',
      `using System.Net.Http.Json;

var http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
http.DefaultRequestHeaders.Add("Authorization", "Bearer ${key}");

var pdf = Convert.ToBase64String(File.ReadAllBytes(@"C:\\Receipts\\INV-1043.pdf"));
var res = await http.PostAsJsonAsync("${base}/messages", new {
    to = "971501234567",
    text = "Thank you for shopping with us! Receipt INV-1043, total AED 162.00",
    document = new { base64 = pdf, filename = "INV-1043.pdf" },
    reference = "INV-1043"
});

var body = await res.Content.ReadAsStringAsync();
Console.WriteLine(res.IsSuccessStatusCode ? "Sent on WhatsApp" : "Not sent: " + body);`,
    ],
  ];
}

const quickCurl = (base, key) => `curl -X POST ${base}/messages \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{ "to": "971501234567", "text": "Hello from our POS!" }'`;

// ---- API keys tab ----

function KeyModal({ data, editing, onClose, onSaved }) {
  const { toast } = useApp();
  const [name, setName] = useState(editing?.name || '');
  const [sender, setSender] = useState(editing?.sender || 'default');
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = editing ? await api.put(`/developer/keys/${editing.id}`, { name, sender }) : await api.post('/developer/keys', { name, sender });
      onSaved(r, !editing);
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy(false);
  }
  return (
    <Modal
      title={editing ? 'Edit API key' : 'Create an API key'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" form="dev-key-form" disabled={busy || !name.trim()}>{busy ? 'Saving…' : editing ? 'Save' : 'Create key'}</button>
        </>
      }
    >
      <form id="dev-key-form" onSubmit={save}>
        <div className="field">
          <label htmlFor="dev-key-name">Name</label>
          <input id="dev-key-name" className="input" autoFocus maxLength={60} placeholder="e.g. Shop POS, Branch 2 till, Website" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="hint">So you know which software uses it.</div>
        </div>
        <div className="field">
          <label htmlFor="dev-key-sender">Send from</label>
          <select id="dev-key-sender" className="select" value={sender} onChange={(e) => setSender(e.target.value)}>
            <option value="default">{automaticName(data)}</option>
            {data.api_number?.phone && <option value={data.api_number.phone}>API number · +{data.api_number.phone}</option>}
            {data.numbers.length > 0 && (
              <optgroup label="WhatsApp Gateway numbers">
                {data.numbers.map((n) => (
                  <option key={n.phone} value={n.phone}>{numName(n)}</option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="hint">Automatic sends from the API number when one is linked (Number &amp; sending tab), otherwise from the default Gateway number.</div>
        </div>
      </form>
    </Modal>
  );
}

function NewKeyModal({ created, onClose }) {
  const base = apiBase();
  return (
    <Modal title="Your new API key" onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>I've copied it</button>}>
      <div className="dev-warn">
        <Icon.warn /> <span><strong>Copy this key now.</strong> For your security it's shown only once. If you lose it, delete it and create a new one.</span>
      </div>
      <CopyLine label={`API key: ${created.name}`} value={created.key} />
      <p className="dev-p">Put it in your POS settings, on the server side. Anyone who has this key can send WhatsApp messages from your number, so never put it in a public web page or app.</p>
      <CodeBlock label="Try it (change the number to yours)" code={quickCurl(base, created.key)} />
    </Modal>
  );
}

function TestCard({ data }) {
  const { toast } = useApp();
  const [to, setTo] = useState('');
  const [text, setText] = useState('Hello! This is a test message from our WhatsApp receipts setup.');
  const [sender, setSender] = useState('default');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }
  async function send(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post('/developer/test', { to, text, sender });
      setResult({ ok: true, text: `Sent to +${r.to} from +${r.from}. You'll find it in Conversations.` });
    } catch (err) {
      setResult({ ok: false, text: err.message });
      toast('Test message not sent', 'error');
    }
    setBusy(false);
  }
  return (
    <div className="card">
      <div className="card-head">
        <Icon.send style={{ width: 18, color: 'var(--brand-700)' }} />
        <div><h3>Send a test message</h3><div className="sub">Goes through the same steps as an API request, without a key.</div></div>
      </div>
      <form className="card-pad" onSubmit={send}>
        <div className="dev-test-grid">
          <div className="field">
            <label htmlFor="dev-test-to">To (WhatsApp number with country code)</label>
            <input id="dev-test-to" className="input" inputMode="tel" placeholder="971501234567" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="dev-test-from">From</label>
            <select id="dev-test-from" className="select" value={sender} onChange={(e) => setSender(e.target.value)}>
              <option value="default">Default number</option>
              {data.numbers.map((n) => <option key={n.phone} value={n.phone}>{numName(n)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="dev-test-text">Message</label>
          <textarea id="dev-test-text" className="textarea" rows={3} maxLength={4096} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {result && <div className={`dev-result ${result.ok ? 'ok' : 'err'}`}>{result.ok ? <Icon.check /> : <Icon.warn />}<span>{result.text}</span></div>}
        <button className="btn primary" disabled={busy || !to.trim() || !text.trim() || !data.enabled}><Icon.send /> {busy ? 'Sending…' : 'Send test'}</button>
      </form>
    </div>
  );
}

// ---- Number & sending: the API-only number, how fast it sends, and the queue ----
function ApiNumberCard({ data, reload }) {
  const { toast } = useApp();
  const [n, setN] = useState(data.api_number);
  const [busy, setBusy] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  useEffect(() => setN(data.api_number), [data.api_number]);
  // While a QR code is up (it changes) or it's connecting, ask every 2 s.
  const waiting = n && n.status !== 'connected' && !(n.status === 'disconnected' && !n.qr);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      try {
        const x = await api.get('/developer/number');
        setN(x);
        if (x?.status === 'connected') {
          toast(`API number +${x.phone} connected`, 'success');
          reload();
        }
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [waiting, n?.id]);
  async function call(fn) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }
  const link = () => call(async () => setN(await api.post('/developer/number', {})));
  const reconnect = () => call(async () => setN(await api.post('/developer/number/reconnect', {})));
  const unlink = () =>
    call(async () => {
      await api.del('/developer/number');
      setUnlinking(false);
      toast('API number unlinked', 'success');
      reload();
    });
  return (
    <div className="card">
      <div className="card-head">
        <Icon.phone style={{ width: 18, color: 'var(--brand-700)' }} />
        <div style={{ flex: 1 }}>
          <h3>API number</h3>
          <div className="sub">A WhatsApp number used only by the API: receipts and messages from your POS, website or app.</div>
        </div>
        {n?.status === 'connected' && <span className="dev-live"><span className="dev-live-dot" /> Connected</span>}
      </div>
      <div className="card-pad">
        {!n ? (
          <div className="dev-number-empty">
            <ul className="dev-list">
              <li>Its own number, so API messages don't go out from the number your team chats on.</li>
              <li>Only for the API: its chats don't show in Conversations, and campaigns and warm-up never send from it.</li>
              <li>Keys set to <strong>Automatic</strong> send from it. A key can still use a WhatsApp Gateway number instead.</li>
            </ul>
            <button className="btn primary" onClick={link} disabled={busy}><Icon.plus /> {busy ? 'Starting…' : 'Link the API number'}</button>
          </div>
        ) : n.status === 'connected' ? (
          <div className="dev-number-row">
            <div className="dev-number-avatar"><Icon.phone /></div>
            <div style={{ flex: 1 }}>
              <div className="dev-number-phone">+{n.phone}</div>
              <div className="cell-muted">{n.name || n.label} · sends the API's messages</div>
            </div>
            <button className="btn sm danger-text" onClick={() => setUnlinking(true)}>Unlink</button>
          </div>
        ) : n.qr ? (
          <div className="qr-stage dev-qr">
            <div className="qr-box"><img src={n.qr} alt="QR code to link the API number" /></div>
            <div>
              <h4 className="dev-h4" style={{ marginTop: 0 }}>Scan with the phone of the API number</h4>
              <ol className="dev-list">
                <li>Open WhatsApp on that phone.</li>
                <li>Tap <strong>Settings → Linked devices → Link a device</strong>.</li>
                <li>Point the phone at this code. It refreshes by itself.</li>
              </ol>
              <button className="btn sm" onClick={() => setUnlinking(true)} disabled={busy}>Cancel</button>
            </div>
          </div>
        ) : n.phone && n.status === 'disconnected' ? (
          <div className="dev-number-row">
            <div className="dev-number-avatar off"><Icon.phone /></div>
            <div style={{ flex: 1 }}>
              <div className="dev-number-phone">+{n.phone}</div>
              <div className="cell-muted">Not connected. Messages wait in the queue until it's back (up to 24 hours).</div>
            </div>
            <button className="btn sm primary" onClick={reconnect} disabled={busy}><Icon.refresh /> Reconnect</button>
            <button className="btn sm danger-text" onClick={() => setUnlinking(true)}>Unlink</button>
          </div>
        ) : (
          <div className="dev-number-row">
            <span className="wa-spin" />
            <div style={{ flex: 1 }} className="cell-muted">{n.phone ? `Connecting +${n.phone}…` : 'Getting a QR code…'}</div>
            <button className="btn sm" onClick={() => setUnlinking(true)} disabled={busy}>Cancel</button>
          </div>
        )}
      </div>
      {unlinking && (
        <Modal
          title={n?.phone ? `Unlink +${n.phone}?` : 'Stop linking the API number?'}
          onClose={() => setUnlinking(false)}
          footer={
            <>
              <button className="btn" onClick={() => setUnlinking(false)}>Keep it</button>
              <button className="btn danger" onClick={unlink} disabled={busy}>{n?.phone ? 'Unlink' : 'Stop'}</button>
            </>
          }
        >
          <p className="dev-p" style={{ margin: 0 }}>
            {n?.phone
              ? "Keys set to Automatic will send from the default Gateway number instead. Messages still waiting for this number are cancelled. The phone itself keeps all its chats."
              : 'The QR code goes away. You can link a number again any time.'}
          </p>
        </Modal>
      )}
    </div>
  );
}

function SendingCard({ data, reload }) {
  const { toast } = useApp();
  const s = data.sending;
  const lim = data.sending_limits;
  const [perBatch, setPerBatch] = useState(s.per_batch);
  const [gap, setGap] = useState(s.gap_seconds);
  const [maxQ, setMaxQ] = useState(s.max_queue);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPerBatch(s.per_batch);
    setGap(s.gap_seconds);
    setMaxQ(s.max_queue);
  }, [s.per_batch, s.gap_seconds, s.max_queue]);
  const num = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
  const pb = num(perBatch, lim.per_batch);
  const g = num(gap, lim.gap_seconds);
  const dirty = pb !== s.per_batch || g !== s.gap_seconds || num(maxQ, lim.max_queue) !== s.max_queue;
  const perHour = g > 0 ? Math.floor((3600 / g) * pb) : null;
  const risky = pb > 10 && g < 30;
  const rules = data.sending_rules || {};
  const ruleText = [
    rules.per_batch ? `at most ${rules.per_batch} at a time` : null,
    rules.min_gap ? `at least ${rules.min_gap} seconds between batches` : null,
    rules.max_queue ? `a queue of at most ${rules.max_queue}` : null,
  ].filter(Boolean);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.put('/developer/settings', { per_batch: pb, gap_seconds: g, max_queue: num(maxQ, lim.max_queue) });
      toast(['Sending settings saved', ...(r.notes || [])].join(' — '), 'success');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy(false);
  }
  return (
    <div className="card">
      <div className="card-head">
        <Icon.clock style={{ width: 18, color: 'var(--brand-700)' }} />
        <div style={{ flex: 1 }}>
          <h3>Sending settings</h3>
          <div className="sub">How fast API messages go out. These are separate from campaign and warm-up settings.</div>
        </div>
      </div>
      <form className="card-pad" onSubmit={save}>
        <div className="dev-send-grid">
          <div className="field">
            <label htmlFor="dev-per-batch">Messages sent at a time</label>
            <input id="dev-per-batch" className="input" type="number" min={lim.per_batch[0]} max={lim.per_batch[1]} value={perBatch} onChange={(e) => setPerBatch(e.target.value)} />
            <div className="hint">{lim.per_batch[0]}–{lim.per_batch[1]} messages, a few seconds apart.</div>
          </div>
          <div className="field">
            <label htmlFor="dev-gap">Then wait (seconds)</label>
            <input id="dev-gap" className="input" type="number" min={lim.gap_seconds[0]} max={lim.gap_seconds[1]} value={gap} onChange={(e) => setGap(e.target.value)} />
            <div className="dev-chips">
              {[0, 5, 15, 30, 60, 120, 300].filter((v) => v >= lim.gap_seconds[0]).map((v) => (
                <button type="button" key={v} className={`chip-btn ${g === v ? 'on' : ''}`} onClick={() => setGap(v)}>{v === 0 ? 'No wait' : v < 60 ? `${v}s` : `${v / 60} min`}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="dev-maxq">Most messages in the queue</label>
            <input id="dev-maxq" className="input" type="number" min={lim.max_queue[0]} max={lim.max_queue[1]} value={maxQ} onChange={(e) => setMaxQ(e.target.value)} />
            <div className="hint">More than this and new requests get <code>429 queue_full</code>.</div>
          </div>
        </div>
        <div className="dev-send-summary">
          {g > 0 ? (
            <>Sends <strong>{pb} message{pb === 1 ? '' : 's'}</strong>, then waits <strong>{secs(g)}</strong> — about <strong>{fmtNum(perHour)} an hour</strong>. </>
          ) : (
            <>Sends <strong>{pb} message{pb === 1 ? '' : 's'}</strong> at a time with no wait between batches. </>
          )}
          Messages that arrive faster wait in the queue and go out in order; your software gets <code>"status": "queued"</code> (HTTP 202) for them.
        </div>
        {ruleText.length > 0 && <div className="dev-rule-note"><Icon.shield /> Set by the platform admin: {ruleText.join(', ')}.</div>}
        {risky && <div className="auth-error" style={{ marginTop: 10 }}>Sending this fast from a number linked by QR code can get it banned. For big volumes, keep it to 5 or fewer at a time with 30 seconds or more between.</div>}
        <div className="dev-form-foot">
          <button className="btn primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

function QueueCard({ data }) {
  const { toast, onBus } = useApp();
  const [q, setQ] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const load = useCallback(async () => {
    try {
      setQ(await api.get('/developer/queue'));
    } catch {}
  }, []);
  useEffect(() => {
    load();
  }, [load, data.queue.total]);
  useEffect(() => {
    let t = null;
    const off = onBus?.((ev) => {
      if (ev === 'message:out' || ev === 'message:status') {
        clearTimeout(t);
        t = setTimeout(load, 800);
      }
    });
    return () => {
      clearTimeout(t);
      off?.();
    };
  }, [onBus, load]);
  // Count-downs while something is waiting.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!q?.total) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    const r = setInterval(load, 10000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [q?.total, load]);
  async function cancel(id) {
    try {
      await api.del(id ? `/developer/queue/${id}` : '/developer/queue');
      toast(id ? 'Message cancelled' : 'Queue cleared', 'success');
      setConfirmAll(false);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  const nameOf = (phone) => (data.api_number?.phone === phone ? 'API number' : data.numbers.find((n) => n.phone === phone)?.label || `+${phone}`);
  return (
    <div className="card">
      <div className="card-head">
        <Icon.inbox style={{ width: 18, color: 'var(--brand-700)' }} />
        <div style={{ flex: 1 }}>
          <h3>Queue</h3>
          <div className="sub">{q ? (q.total ? `${fmtNum(q.total)} waiting to go out` : 'Nothing waiting') : 'Loading…'}</div>
        </div>
        {q?.total > 0 && <button className="btn sm danger-text" onClick={() => setConfirmAll(true)}>Cancel all</button>}
      </div>
      {!q ? (
        <Loading />
      ) : q.total === 0 ? (
        <Empty icon="inbox" title="The queue is empty">Messages wait here when they arrive faster than your sending settings allow, or while the number is offline.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dev-table">
            <thead>
              <tr><th>To</th><th>Message</th><th>From</th><th>Queued</th><th>Goes out</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {q.items.map((m) => (
                <tr key={m.id}>
                  <td className="cell-strong">{m.name || `+${m.to}`}{m.name && <div className="cell-muted">+{m.to}</div>}</td>
                  <td>
                    <div className="dev-queue-text">{m.file_name ? `📄 ${m.file_name}` : m.text}</div>
                    <div className="cell-muted">{m.key}{m.reference ? ` · ${m.reference}` : ''}</div>
                  </td>
                  <td className="cell-muted">{nameOf(m.from)}</td>
                  <td className="cell-muted">{timeAgo(m.queued_at)}</td>
                  <td>{fromNow(m.estimated_send_at)}</td>
                  <td><button className="btn sm" onClick={() => cancel(m.id)}>Cancel</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.total > q.items.length && <div className="cell-muted" style={{ padding: '10px 16px' }}>…and {fmtNum(q.total - q.items.length)} more</div>}
        </div>
      )}
      {confirmAll && (
        <Modal
          title={`Cancel all ${fmtNum(q.total)} waiting messages?`}
          onClose={() => setConfirmAll(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmAll(false)}>Keep them</button>
              <button className="btn danger" onClick={() => cancel(null)}>Cancel all</button>
            </>
          }
        >
          <p className="dev-p" style={{ margin: 0 }}>They won't be sent. Your software sees them as <code>failed</code> with the code <code>cancelled</code>.</p>
        </Modal>
      )}
    </div>
  );
}

function NumberTab({ data, reload }) {
  return (
    <>
      {!data.enabled && (
        <div className="auth-error">
          {data.off_by === 'workspace'
            ? 'The platform admin switched the Developer API off for this workspace. API requests are refused and the queue waits.'
            : 'The Developer API is switched off by the platform admin. API requests are refused.'}
        </div>
      )}
      <ApiNumberCard data={data} reload={reload} />
      <SendingCard data={data} reload={reload} />
      <QueueCard data={data} />
    </>
  );
}

function KeysTab({ data, reload, setTab }) {
  const { can, toast } = useApp();
  const [modal, setModal] = useState(null); // 'new' | key
  const [created, setCreated] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const linked = data.numbers.length > 0;
  const live = data.numbers.some((n) => n.connected);
  const senderName = (phone) => {
    if (!phone) return automaticName(data);
    if (data.api_number?.phone === phone) return `API number (+${phone})`;
    const n = data.numbers.find((x) => x.phone === phone);
    return n ? numName(n) : `+${phone} (no longer linked)`;
  };
  async function remove() {
    setBusy(true);
    try {
      await api.del(`/developer/keys/${deleting.id}`);
      toast(`"${deleting.name}" deleted. Software using it can no longer send.`, 'success');
      setDeleting(null);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }
  const steps = [
    {
      done: !!data.api_number?.connected || (!data.api_number && live),
      title: 'Link the API number',
      text: data.api_number?.connected
        ? `+${data.api_number.phone} is connected and sends your API messages.`
        : data.api_number
          ? 'Linked, but not connected right now.'
          : live
            ? 'Sending from your default Gateway number for now. Link a separate number just for the API.'
            : 'Scan a QR code with the WhatsApp you want receipts to come from.',
      action: !data.api_number?.connected ? <button className="btn sm" onClick={() => setTab('number')}>Open Number &amp; sending</button> : null,
    },
    { done: data.keys.length > 0, title: 'Create an API key', text: 'One for each POS or app, so you can delete one without touching the others.', action: data.enabled ? <button className="btn sm primary" onClick={() => setModal('new')}><Icon.plus /> Create key</button> : null },
    { done: false, title: 'Add it to your POS button', text: 'When the cashier taps "Send on WhatsApp", the receipt goes to the customer.', action: <button className="btn sm" onClick={() => setTab('pos')}>Read the guide</button> },
  ];
  return (
    <>
      {!data.enabled && (
        <div className="auth-error">The Developer API is switched off by the super admin. Keys can't be created and API requests are refused.</div>
      )}

      <div className="card dev-hero">
        <div className="card-pad">
          <h3 className="dev-h3">Send WhatsApp messages from your own software</h3>
          <p className="dev-p">Connect your POS, website or app to this workspace. A receipt, an order update or a reminder goes out from your WhatsApp number{data.numbers.length ? '' : ' once one is linked'}, scanned by QR or connected through the official API.</p>
          <ol className="dev-steps">
            {steps.map((s, i) => (
              <li key={s.title} className={s.done ? 'done' : ''}>
                <span className="dev-step-n">{s.done ? <Icon.check /> : i + 1}</span>
                <div className="dev-step-body">
                  <strong>{s.title}</strong>
                  <span>{s.text}</span>
                  {s.action && <div className="dev-step-act">{s.action}</div>}
                </div>
              </li>
            ))}
          </ol>
          <CopyLine label="API address (base URL)" value={apiBase()} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Icon.key style={{ width: 18, color: 'var(--brand-700)' }} />
          <div style={{ flex: 1 }}><h3>API keys</h3><div className="sub">{data.keys.length} of {data.limits.maxKeys} · {fmtNum(data.today)} sent through the API today</div></div>
          {data.enabled && <button className="btn primary sm" onClick={() => setModal('new')}><Icon.plus /> Create key</button>}
        </div>
        {data.keys.length === 0 ? (
          <Empty icon="key" title="No API keys yet">Create one for your POS. You'll copy it once and paste it into the POS settings.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="dev-table">
              <thead>
                <tr><th>Name</th><th>Key</th><th>Sends from</th><th>Last used</th><th>Sent</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id}>
                    <td className="cell-strong">{k.name}<div className="cell-muted">Created {timeAgo(k.created_at)}{k.created_by ? ` by ${k.created_by}` : ''}</div></td>
                    <td><code className="dev-keyid">{k.prefix}…{k.last4}</code></td>
                    <td>{senderName(k.sender)}</td>
                    <td className="cell-muted">{k.last_used_at ? timeAgo(k.last_used_at) : 'Never'}</td>
                    <td>{fmtNum(k.sent)}</td>
                    <td>
                      <div className="dev-row-act">
                        <button className="btn sm ghost" onClick={() => setModal(k)} title="Edit"><Icon.edit /> Edit</button>
                        <button className="btn sm ghost danger-text" onClick={() => setDeleting(k)} title="Delete"><Icon.trash /> Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dev-facts">
        <div><span>Requests</span><strong>{data.limits.perMinute} a minute per key</strong></div>
        <div><span>Files</span><strong>PDF & documents up to 16 MB, images up to 5 MB</strong></div>
        <div><span>QR-linked numbers</span><strong>{data.limits.qrPerDay ? `Up to ${fmtNum(data.limits.qrPerDay)} API messages a day each` : 'No daily API cap'}</strong></div>
        <div><span>Official API numbers</span><strong>Meta's own limits; templates after 24 hours</strong></div>
      </div>

      <TestCard data={data} />

      {modal && (
        <KeyModal
          data={data}
          editing={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={(r, isNew) => {
            setModal(null);
            if (isNew) setCreated(r);
            else toast('Key saved', 'success');
            reload();
          }}
        />
      )}
      {created && <NewKeyModal created={created} onClose={() => setCreated(null)} />}
      {deleting && (
        <Modal
          title={`Delete "${deleting.name}"?`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn danger" onClick={remove} disabled={busy}>{busy ? 'Deleting…' : 'Delete key'}</button>
            </>
          }
        >
          <p className="dev-p">Software using this key (<code className="dev-keyid">{deleting.prefix}…{deleting.last4}</code>) stops sending straight away. This can't be undone, but you can create a new key at any time.</p>
        </Modal>
      )}
    </>
  );
}

// ---- POS guide tab ----

function PosTab({ setTab }) {
  const base = apiBase();
  return (
    <div className="dev-doc">
      <div className="card card-pad">
        <h3 className="dev-h3">Add a "Send on WhatsApp" button to your POS</h3>
        <p className="dev-p">The cashier finishes a sale, taps the button, and the customer gets their receipt on WhatsApp from your business number. No app for the customer, no paper.</p>
        <div className="dev-flow">
          <div><Icon.pointer /><strong>Cashier taps the button</strong><span>after the receipt is made</span></div>
          <Icon.chevronDown className="dev-flow-arrow" />
          <div><Icon.code /><strong>Your POS calls our API</strong><span>with the number and the receipt</span></div>
          <Icon.chevronDown className="dev-flow-arrow" />
          <div><Icon.chat /><strong>The customer gets it on WhatsApp</strong><span>from your number, in seconds</span></div>
        </div>
      </div>

      <div className="card card-pad">
        <h4 className="dev-h4"><span className="dev-n">1</span> Link your WhatsApp number</h4>
        <p className="dev-p">On <strong>WhatsApp Gateway</strong>, scan a QR code with the shop's phone (free) or connect the official WhatsApp API. Receipts go out from your <strong>default number</strong> unless you choose another one for the key.</p>

        <h4 className="dev-h4"><span className="dev-n">2</span> Create an API key</h4>
        <p className="dev-p">On the <button className="link-btn" onClick={() => setTab('keys')}>API keys</button> tab, create a key named after the POS (for example "Shop POS"). Copy it and save it in the POS settings. Keep it on the POS server or in the till's private settings, never in a public web page.</p>

        <h4 className="dev-h4"><span className="dev-n">3</span> When the button is tapped, send the receipt</h4>
        <p className="dev-p">Send a <code>POST</code> to <code>{base}/messages</code> with the customer's number and the receipt: a text, a PDF, or both (the text becomes the PDF's caption).</p>
        <CodeTabs samples={receiptSamples(base)} />
        <p className="dev-p">A PDF can be a <strong>link</strong> (<code>"url"</code>, must be reachable on the internet) or the file itself as <strong>base64</strong> (<code>"base64"</code>). To send only text, leave out <code>"document"</code>. A receipt saved as a picture can go as <code>"image"</code>.</p>

        <h4 className="dev-h4"><span className="dev-n">4</span> Show the result to the cashier</h4>
        <ul className="dev-list">
          <li><strong>Sent</strong> (HTTP 201): show a tick. The answer has <code>"status": "sent"</code> and the message <code>"id"</code>.</li>
          <li><strong>Queued</strong> (HTTP 202): accepted, and it goes out shortly following your sending settings (<code>"status": "queued"</code>, with <code>"queue": &#123; "position", "estimated_send_at" &#125;</code>). Show a tick too.</li>
          <li><strong>Not sent</strong> (HTTP 4xx/5xx): show <code>error.message</code>. It's written for people, e.g. <em>"0501234567" looks like a local number. Use the full international number with the country code.</em></li>
          <li>Later you can check <code>GET {base}/messages/&#123;id&#125;</code> to see <em>delivered</em> or <em>read</em>.</li>
        </ul>
      </div>

      <div className="card card-pad">
        <h4 className="dev-h4">Good to know</h4>
        <ul className="dev-list">
          <li><strong>Phone numbers</strong>: always with the country code, e.g. <code>971501234567</code> or <code>+971 50 123 4567</code>. Numbers that start with a single 0 are refused.</li>
          <li><strong>No double sends</strong>: put the receipt number in <code>"reference"</code>. If the button is tapped twice, or your POS retries, the same receipt to the same number goes out only once in 24 hours (the answer then has <code>"duplicate": true</code>).</li>
          <li><strong>Customer's name</strong>: add <code>"name": "Ali Khan"</code> and the contact is saved with it on the first receipt.</li>
          <li><strong>Waiting time</strong>: the API answers once WhatsApp has taken the message, usually in 1 to 5 seconds. If many tills send at once from one QR-linked number, messages go out one after another, a few seconds apart, to keep the number safe. Use a 60-second timeout.</li>
          <li><strong>Replies</strong>: if the customer answers, the chat appears in <strong>Conversations</strong>, with the receipt you sent.</li>
          <li><strong>STOP</strong>: a customer who replied STOP doesn't get messages (error <code>opted_out</code>).</li>
        </ul>
      </div>

      <div className="card card-pad">
        <h4 className="dev-h4"><Icon.shield style={{ width: 16, verticalAlign: -3 }} /> Sending from an official WhatsApp API number</h4>
        <p className="dev-p">Meta allows a normal message only within <strong>24 hours</strong> of the customer's last message to you. A shop customer usually hasn't written, so official numbers send receipts with a <strong>template</strong> you create and get approved in Meta (WhatsApp Manager → Message templates, category <em>Utility</em>). A template that starts with a document carries the PDF.</p>
        <CodeBlock
          label="Receipt with an approved template"
          code={`{
  "to": "971501234567",
  "template": {
    "name": "order_receipt",
    "language": "en",
    "variables": ["Ali", "INV-1043", "AED 162.00"]
  },
  "document": { "url": "https://your-pos.com/receipts/INV-1043.pdf", "filename": "INV-1043.pdf" },
  "reference": "INV-1043"
}`}
        />
        <p className="dev-p">The variables fill <code>{'{{1}}'}</code>, <code>{'{{2}}'}</code>, <code>{'{{3}}'}</code> in order. For a template with named variables, send an object instead: <code>{'"variables": { "customer_name": "Ali" }'}</code>. QR-linked numbers don't need templates: they can send any text at any time.</p>
      </div>
    </div>
  );
}

// ---- API reference tab ----

const Method = ({ m }) => <span className={`dev-method ${m.toLowerCase()}`}>{m}</span>;

function Endpoint({ m, path, children }) {
  return (
    <div className="card card-pad dev-endpoint">
      <h4 className="dev-endpoint-title"><Method m={m} /> <code>{path}</code></h4>
      {children}
    </div>
  );
}

const FIELDS = [
  ['to', 'string', 'Required. The customer\'s WhatsApp number with country code: "971501234567". Spaces, + and dashes are fine.'],
  ['text', 'string', 'The message, up to 4,096 characters. With a file, it becomes the caption (up to 1,024). WhatsApp formatting works: *bold*, _italic_.'],
  ['document', 'object', 'A file such as a PDF receipt: { "url": "https://…" } or { "base64": "…", "filename": "INV-1043.pdf" }. PDF, Word, Excel, PowerPoint or text, up to 16 MB.'],
  ['image', 'object', 'A JPG or PNG: { "url": "https://…" } or { "base64": "…" }. Up to 5 MB.'],
  ['caption', 'string', 'Optional. The file\'s caption, if it should differ from "text".'],
  ['template', 'object', 'Official API numbers: { "name", "language", "variables", "header_variables" } of a Meta-approved template. A template that starts with a document or image takes it from "document" / "image".'],
  ['reference', 'string', 'Optional, up to 100 characters. Your own id, e.g. the receipt number. The same reference to the same number is sent only once in 24 hours; also used to look the message up.'],
  ['name', 'string', "Optional. The customer's name, saved on the contact if it doesn't have one yet."],
  ['from', 'string', 'Optional. Another of this workspace\'s numbers to send from (otherwise the key\'s number).'],
];

const ERRORS = [
  ['missing_api_key / invalid_api_key', 401, 'No key, or the key was deleted.'],
  ['missing_to, invalid_phone', 400, 'The number is missing, local (starts with 0) or not a phone number.'],
  ['missing_content, text_too_long, caption_too_long', 400, 'Nothing to send, or the text is too long.'],
  ['invalid_file, invalid_json, invalid_request', 400, 'The file data or the body is not valid.'],
  ['template_not_supported, missing_variable, missing_header_file', 400, 'A template problem: wrong number type, a variable or the header file is missing.'],
  ['invalid_sender', 400, "The chosen \"from\" number isn't linked in this workspace."],
  ['workspace_suspended, workspace_pending, api_disabled', 403, 'The workspace or the API is switched off.'],
  ['not_found', 404, 'No such message or endpoint.'],
  ['file_too_large', 413, 'The file is over the limit.'],
  ['unsupported_file', 415, 'Not a PDF, image, Office or text file.'],
  ['not_on_whatsapp', 422, "This number doesn't use WhatsApp (QR-linked numbers check first)."],
  ['opted_out', 422, 'The customer replied STOP.'],
  ['window_closed', 422, 'Official number, more than 24 hours since the customer wrote: send a template.'],
  ['template_not_found', 422, 'No approved template with that name and language.'],
  ['file_unreachable', 422, "The file link couldn't be downloaded, or points to a private address."],
  ['rate_limited', 429, 'Too many requests a minute. Retry shortly (see Retry-After).'],
  ['queue_full', 429, 'The queue is at its limit (Developer page → Number & sending). Retry in a little while.'],
  ['daily_limit', 429, "A QR-linked number reached today's API cap."],
  ['send_failed', 502, "WhatsApp or Meta didn't accept the message; the message says why."],
  ['expired, cancelled, number_removed', '—', 'Only on a queued message that later failed (GET /messages/{id}): it waited over 24 hours, was cancelled on the Developer page, or its number was unlinked.'],
  ['number_not_connected, no_number', 503, 'The WhatsApp number is offline or none is linked. Reconnect it on WhatsApp Gateway.'],
];

function ReferenceTab() {
  const base = apiBase();
  return (
    <div className="dev-doc">
      <div className="card card-pad">
        <h3 className="dev-h3">API reference</h3>
        <CopyLine label="Base URL" value={base} />
        <h4 className="dev-h4">Authentication</h4>
        <p className="dev-p">Send your key with every request, in the <code>Authorization</code> header (or <code>X-API-Key</code>):</p>
        <CodeBlock label="Header" code={`Authorization: Bearer ${KEY_HOLDER}`} />
        <p className="dev-p">Bodies are JSON (<code>Content-Type: application/json</code>); a normal form post works too. Every answer is JSON. Errors look like this, with a matching HTTP status:</p>
        <CodeBlock label="Error" code={`{
  "error": {
    "code": "invalid_phone",
    "message": "\\"0501234567\\" looks like a local number. Use the full international number with the country code, e.g. 971501234567."
  }
}`} />
      </div>

      <Endpoint m="POST" path="/messages">
        <p className="dev-p">Send a message. If it can go out right away it answers once WhatsApp has taken it, with <strong>201</strong>. If it has to wait its turn (the sending settings on the Developer page, e.g. 5 messages then 60 seconds), it answers at once with <strong>202</strong> and <code>"status": "queued"</code>, plus <code>"queue": &#123; "position": 3, "estimated_send_at": "…" &#125;</code>; check it later with <code>GET /messages/&#123;id&#125;</code>. A reference that was already sent or queued answers <strong>200</strong> with <code>"duplicate": true</code>.</p>
        <div className="table-wrap">
          <table className="dev-table dev-fields">
            <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
            <tbody>
              {FIELDS.map(([f, t, d]) => (
                <tr key={f}><td><code>{f}</code></td><td className="cell-muted">{t}</td><td>{d}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dev-p">Send one of <code>text</code>, <code>document</code>, <code>image</code> or <code>template</code> (text can go with a file as its caption).</p>
        <div className="dev-two">
          <CodeBlock label="Request" code={`POST ${base}/messages
Authorization: Bearer ${KEY_HOLDER}
Content-Type: application/json

{
  "to": "971501234567",
  "text": "Your receipt INV-1043. Thank you!",
  "document": {
    "url": "https://your-pos.com/r/INV-1043.pdf"
  },
  "reference": "INV-1043"
}`} />
          <CodeBlock label="Response 201" code={`{
  "id": "6740c3f2a1b2c3d4e5f60718",
  "status": "sent",
  "to": "971501234567",
  "from": "971509876543",
  "type": "document",
  "reference": "INV-1043",
  "created_at": "2026-11-21T10:15:30.000Z",
  "file_name": "INV-1043.pdf"
}`} />
        </div>
      </Endpoint>

      <Endpoint m="GET" path="/messages/{id}">
        <p className="dev-p">A message's delivery status. <code>status</code> moves from <strong>queued</strong> (waiting its turn) → <strong>sent</strong> → <strong>delivered</strong> (on the customer's phone) → <strong>read</strong> (blue ticks; only if the customer has read receipts on), or becomes <strong>failed</strong> with an <code>error</code>.</p>
        <CodeBlock label="cURL" code={`curl ${base}/messages/6740c3f2a1b2c3d4e5f60718 \\
  -H "Authorization: Bearer ${KEY_HOLDER}"`} />
      </Endpoint>

      <Endpoint m="GET" path="/messages?reference={reference}">
        <p className="dev-p">The latest message sent with your own reference, such as the receipt number. Same answer as above.</p>
      </Endpoint>

      <Endpoint m="GET" path="/me">
        <p className="dev-p">Check that a key works and which number it sends from. A good first call when you set up the POS.</p>
        <CodeBlock label="Response 200" code={`{
  "workspace": "Your business",
  "key": { "name": "Shop POS", "prefix": "twa_live_Ab3x" },
  "number": { "phone": "971509876543", "label": "API number", "type": "qr", "connected": true, "api_only": true },
  "limits": { "requests_per_minute": 60, "messages_per_day": 500 },
  "sending": { "messages_per_batch": 5, "seconds_between_batches": 60, "max_queue": 500 }
}`} />
      </Endpoint>

      <div className="card card-pad">
        <h4 className="dev-h4">Errors</h4>
        <div className="table-wrap">
          <table className="dev-table">
            <thead><tr><th>error.code</th><th>HTTP</th><th>What it means</th></tr></thead>
            <tbody>
              {ERRORS.map(([c, h, d]) => (
                <tr key={c}><td><code>{c}</code></td><td>{h}</td><td>{d}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <h4 className="dev-h4">Limits</h4>
        <ul className="dev-list">
          <li>60 requests a minute per key. Over that you get <code>429 rate_limited</code> with a <code>Retry-After</code> header.</li>
          <li>Documents up to 16 MB, images up to 5 MB; a request body up to 25 MB (send big files as a link).</li>
          <li>QR-linked numbers: messages go out one by one, a few seconds apart, with a daily API cap set by the platform. Official API numbers: Meta's own limits.</li>
          <li>The request log on this page keeps the last 30 days.</li>
        </ul>
      </div>
    </div>
  );
}

// ---- Request log tab ----

function LogsTab() {
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setLogs(await api.get('/developer/logs?limit=100'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (error) return <Empty icon="logs" title="Couldn't load the request log" action={<button className="btn" onClick={load}><Icon.refresh /> Try again</button>}>{error}</Empty>;
  if (!logs) return <Loading />;
  return (
    <div className="card">
      <div className="card-head">
        <Icon.logs style={{ width: 18, color: 'var(--brand-700)' }} />
        <div style={{ flex: 1 }}><h3>Recent API requests</h3><div className="sub">Every send, and any request that failed. Kept 30 days.</div></div>
        <button className="btn sm" onClick={load}><Icon.refresh /> Refresh</button>
      </div>
      {logs.length === 0 ? (
        <Empty icon="logs" title="No requests yet">When your POS sends its first receipt, it shows here, including the reason if something went wrong.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dev-table">
            <thead><tr><th>When</th><th>Key</th><th>Request</th><th>To</th><th>Result</th></tr></thead>
            <tbody>
              {logs.map((l) => {
                const ok = l.http < 400;
                return (
                  <tr key={l.id}>
                    <td className="cell-muted dev-log-when" title={new Date(l.at).toLocaleString()}>{timeAgo(l.at)}</td>
                    <td>{l.key}</td>
                    <td><Method m={l.method} /> <code>{l.path.replace(/^\/api\/v1/, '')}</code>{l.type ? <div className="cell-muted">{l.type}{l.reference ? ` · ${l.reference}` : ''}</div> : null}</td>
                    <td>{l.to ? `+${l.to}` : '-'}</td>
                    <td className="dev-log-result">
                      <span className={`badge ${ok ? (l.code === 'duplicate' ? 'blue' : 'green') : 'red'}`}>{l.http} {ok ? (l.code === 'duplicate' ? 'Already sent' : 'Sent') : l.code}</span>
                      {l.message && <div className="cell-muted">{l.message}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Page ----

export default function Developer() {
  const { onBus } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTabState] = useState(() => {
    try {
      const t = localStorage.getItem('pulse.devTab');
      return TABS.some(([id]) => id === t) ? t : 'number';
    } catch {
      return 'number';
    }
  });
  const setTab = (t) => {
    setTabState(t);
    try {
      localStorage.setItem('pulse.devTab', t);
    } catch {}
    window.scrollTo?.(0, 0);
  };
  const load = useCallback(async () => {
    try {
      setData(await api.get('/developer'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // Numbers connecting/disconnecting update the page at once; new sends (counts) a moment later.
  useEffect(() => {
    let t = null;
    const off = onBus?.((ev) => {
      if (ev === 'pool:update' || ev === 'wa:status') load();
      else if (ev === 'message:out') {
        clearTimeout(t);
        t = setTimeout(load, 3000);
      }
    });
    return () => {
      clearTimeout(t);
      off?.();
    };
  }, [onBus, load]);

  if (error && !data) return <Empty icon="code" title="Couldn't load the Developer page" action={<button className="btn" onClick={load}><Icon.refresh /> Try again</button>}>{error}</Empty>;
  if (!data) return <Loading />;
  return (
    <div className="dev-page">
      <div className="sa-tabs" role="tablist">
        {TABS.map(([id, label, icon]) => {
          const I = Icon[icon];
          return (
            <button key={id} role="tab" aria-selected={tab === id} className={`sa-tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              <I /> {label}
            </button>
          );
        })}
      </div>
      {tab === 'number' && <NumberTab data={data} reload={load} />}
      {tab === 'keys' && <KeysTab data={data} reload={load} setTab={setTab} />}
      {tab === 'pos' && <PosTab setTab={setTab} />}
      {tab === 'reference' && <ReferenceTab />}
      {tab === 'logs' && <LogsTab />}
    </div>
  );
}
