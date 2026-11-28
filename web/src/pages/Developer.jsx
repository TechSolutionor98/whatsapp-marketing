import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Loading, Empty, timeAgo } from '../ui.jsx';
import Conversations from './Conversations.jsx';

// Two pages. Developer: the API number, its sending settings and the API keys. Developer Docs:
// the POS receipt guide, the API reference and the request log. Software (a POS "Send on
// WhatsApp" button, a website, a CRM) sends with a key; the server is /api/v1
// (server/routes/public-api.js).

const TABS = [
  ['number', 'Number & sending', 'phone'],
  ['keys', 'API keys', 'key'],
];
// Only the super admin sees this tab: the API number's chats (the server refuses everyone else).
const SUPER_TABS = [...TABS, ['chats', 'Conversations', 'chat']];
const DOC_TABS = [
  ['pos', 'POS receipt button', 'receipt'],
  ['reference', 'API reference', 'book'],
  ['logs', 'Request log', 'logs'],
];
const TAB_KEY = { developer: 'pulse.devTab', devdocs: 'pulse.devDocsTab' };
// Open a tab on the other page (Developer ↔ Developer Docs).
function openOn(page, tab) {
  try {
    localStorage.setItem(TAB_KEY[page], tab);
  } catch {}
  window.location.hash = `/${page}`;
}
// The page's open tab, remembered per page.
function useTab(page, tabs) {
  const [tab, setTabState] = useState(() => {
    try {
      const t = localStorage.getItem(TAB_KEY[page]);
      return tabs.some(([id]) => id === t) ? t : tabs[0][0];
    } catch {
      return tabs[0][0];
    }
  });
  // A link from the other page (same component instance stays mounted on hash change).
  useEffect(() => {
    const onHash = () => {
      try {
        const t = localStorage.getItem(TAB_KEY[page]);
        if (tabs.some(([id]) => id === t)) setTabState(t);
      } catch {}
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [page]);
  const other = page === 'developer' ? 'devdocs' : 'developer';
  const setTab = (t) => {
    if (!tabs.some(([id]) => id === t)) return openOn(other, t);
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY[page], t);
    } catch {}
    window.scrollTo?.(0, 0);
  };
  return [tab, setTab];
}
function TabBar({ tabs, tab, setTab }) {
  return (
    <div className="sa-tabs" role="tablist">
      {tabs.map(([id, label, icon]) => {
        const I = Icon[icon];
        return (
          <button key={id} role="tab" aria-selected={tab === id} className={`sa-tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            <I /> {label}
          </button>
        );
      })}
    </div>
  );
}
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
// The number a key set to "Automatic" sends from right now.
const automaticName = (data) => {
  if (data.api_number?.phone) return `API number (+${data.api_number.phone})`;
  const d = data.numbers.find((n) => n.default);
  return `Your default WhatsApp Gateway number${d ? ` (+${d.phone})` : ''}`;
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
          <input id="dev-key-name" className="input" autoFocus maxLength={60} placeholder="e.g. Website OTP, Shop POS" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="hint">So you know which website, POS or app uses this key.</div>
        </div>
        <div className="field">
          <label htmlFor="dev-key-sender">Send from</label>
          <select id="dev-key-sender" className="select" value={sender} onChange={(e) => setSender(e.target.value)}>
            <option value="default">Automatic: {automaticName(data)}</option>
            {data.api_number?.phone && <option value={data.api_number.phone}>Only the API number (+{data.api_number.phone})</option>}
            {data.numbers.length > 0 && (
              <optgroup label="WhatsApp Gateway numbers">
                {data.numbers.map((n) => (
                  <option key={n.phone} value={n.phone}>{numName(n)}</option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="hint">Automatic uses the API number. If no API number is linked, it uses your default WhatsApp Gateway number.</div>
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
        <Icon.warn /> <span><strong>Copy this key now.</strong> You will see it only once. If you lose it, delete it and make a new one.</span>
      </div>
      <CopyLine label={`API key: ${created.name}`} value={created.key} />
      <p className="dev-p">Put it in your software's server settings (for example the <code>.env</code> file). Keep it secret: anyone with this key can send WhatsApp messages from your number. Never put it in website code that visitors can see.</p>
      <CodeBlock label="Try it (change the number to yours)" code={quickCurl(base, created.key)} />
    </Modal>
  );
}

function TestCard({ data }) {
  const { toast } = useApp();
  const [to, setTo] = useState('');
  const [text, setText] = useState('Hello! This is a test message.');
  const [sender, setSender] = useState('default');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }
  async function send(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post('/developer/test', { to, text, sender });
      const fromApi = r.from && r.from === data.api_number?.phone;
      setResult({ ok: true, text: fromApi ? `Sent to +${r.to} from the API number +${r.from}.` : `Sent to +${r.to} from +${r.from}. You'll find it in Conversations.` });
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
        <div><h3>Send a test message</h3><div className="sub">Check that sending works. No key needed.</div></div>
      </div>
      <form className="card-pad" onSubmit={send}>
        <div className="dev-test-grid">
          <div className="field">
            <label htmlFor="dev-test-to">Send to (number with country code)</label>
            <input id="dev-test-to" className="input" inputMode="tel" placeholder="971501234567" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="dev-test-from">Send from</label>
            <select id="dev-test-from" className="select" value={sender} onChange={(e) => setSender(e.target.value)}>
              <option value="default">Automatic: {automaticName(data)}</option>
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
          <div className="sub">This WhatsApp number sends the messages from your website, POS or app.</div>
        </div>
        {n?.status === 'connected' && <span className="dev-live"><span className="dev-live-dot" /> Connected</span>}
      </div>
      <div className="card-pad">
        {!n ? (
          <div className="dev-number-empty">
            <ul className="dev-list">
              <li>Use a separate number, so these messages don't come from your team's chat number.</li>
              <li>It is only for the API. Its chats don't show in Conversations, and campaigns and warm-up don't use it.</li>
              <li>All your API keys send from this number, unless you pick a different number for a key.</li>
            </ul>
            <button className="btn primary" onClick={link} disabled={busy}><Icon.plus /> {busy ? 'Starting…' : 'Link the API number'}</button>
          </div>
        ) : n.status === 'connected' ? (
          <div className="dev-number-row">
            <div className="dev-number-avatar"><Icon.phone /></div>
            <div style={{ flex: 1 }}>
              <div className="dev-number-phone">+{n.phone}</div>
              <div className="cell-muted">{n.name || n.label} · sends your API messages</div>
            </div>
            <button className="btn sm danger-text" onClick={() => setUnlinking(true)}>Unlink</button>
          </div>
        ) : n.qr ? (
          <div className="qr-stage dev-qr">
            <div className="qr-box"><img src={n.qr} alt="QR code to link the API number" /></div>
            <div>
              <h4 className="dev-h4" style={{ marginTop: 0 }}>Scan this code with the phone you want to send from</h4>
              <ol className="dev-list">
                <li>Open WhatsApp on that phone.</li>
                <li>Tap <strong>Settings → Linked devices → Link a device</strong>.</li>
                <li>Point the phone at this code. The code changes by itself, that's normal.</li>
              </ol>
              <button className="btn sm" onClick={() => setUnlinking(true)} disabled={busy}>Cancel</button>
            </div>
          </div>
        ) : n.phone && n.status === 'disconnected' ? (
          <div className="dev-number-row">
            <div className="dev-number-avatar off"><Icon.phone /></div>
            <div style={{ flex: 1 }}>
              <div className="dev-number-phone">+{n.phone}</div>
              <div className="cell-muted">Not connected. New messages wait and go out when it's back (up to 24 hours).</div>
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
              ? "Your API messages will go out from your default WhatsApp Gateway number instead. Messages still waiting are cancelled. Nothing is deleted from the phone."
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
    rules.per_batch ? `at most ${rules.per_batch} together` : null,
    rules.min_gap ? `at least ${rules.min_gap} seconds wait` : null,
    rules.max_queue ? `at most ${rules.max_queue} waiting` : null,
  ].filter(Boolean);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.put('/developer/settings', { per_batch: pb, gap_seconds: g, max_queue: num(maxQ, lim.max_queue) });
      toast(['Sending speed saved', ...(r.notes || [])].join(' — '), 'success');
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
          <h3>Sending speed</h3>
          <div className="sub">How fast messages go out from the API. Campaigns and warm-up have their own settings.</div>
        </div>
      </div>
      <form className="card-pad" onSubmit={save}>
        <div className="dev-send-grid">
          <div className="field">
            <label htmlFor="dev-per-batch">How many to send together</label>
            <input id="dev-per-batch" className="input" type="number" min={lim.per_batch[0]} max={lim.per_batch[1]} value={perBatch} onChange={(e) => setPerBatch(e.target.value)} />
            <div className="hint">From {lim.per_batch[0]} to {lim.per_batch[1]}. They go out a few seconds apart.</div>
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
            <label htmlFor="dev-maxq">How many can wait</label>
            <input id="dev-maxq" className="input" type="number" min={lim.max_queue[0]} max={lim.max_queue[1]} value={maxQ} onChange={(e) => setMaxQ(e.target.value)} />
            <div className="hint">When this many are waiting, new messages are refused.</div>
          </div>
        </div>
        <div className="dev-send-summary">
          {g > 0 ? (
            <>Sends <strong>{pb} message{pb === 1 ? '' : 's'}</strong>, waits <strong>{secs(g)}</strong>, then sends the next — about <strong>{fmtNum(perHour)} messages an hour</strong>. </>
          ) : (
            <>Sends <strong>{pb} message{pb === 1 ? '' : 's'}</strong> together, with no wait in between. </>
          )}
          If messages come in faster, they wait in line and go out in order.
        </div>
        {ruleText.length > 0 && <div className="dev-rule-note"><Icon.shield /> Limits set by the admin: {ruleText.join(', ')}.</div>}
        {risky && <div className="auth-error" style={{ marginTop: 10 }}>Sending this fast can get the number banned by WhatsApp. To stay safe, send 5 or fewer together and wait 30 seconds or more.</div>}
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
      toast(id ? 'Message cancelled' : 'All waiting messages cancelled', 'success');
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
          <h3>Waiting to send</h3>
          <div className="sub">{q ? (q.total ? `${fmtNum(q.total)} message${q.total === 1 ? '' : 's'} waiting` : 'No messages waiting') : 'Loading…'}</div>
        </div>
        {q?.total > 0 && <button className="btn sm danger-text" onClick={() => setConfirmAll(true)}>Cancel all</button>}
      </div>
      {!q ? (
        <Loading />
      ) : q.total === 0 ? (
        <Empty icon="inbox" title="Nothing is waiting">Messages show here when they come in faster than your sending speed, or while the number is not connected.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dev-table">
            <thead>
              <tr><th>To</th><th>Message</th><th>From</th><th>Added</th><th>Goes out</th><th aria-label="Actions" /></tr>
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
          <p className="dev-p" style={{ margin: 0 }}>They won't be sent. Your software will see them as failed (<code>cancelled</code>).</p>
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
            ? 'The admin has turned off the API for this workspace. New messages from your software are refused, and waiting messages are on hold.'
            : 'The admin has turned off the API. Messages from your software are refused.'}
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
      title: 'Link a WhatsApp number',
      text: data.api_number?.connected
        ? `+${data.api_number.phone} is connected. Your messages go out from this number.`
        : data.api_number
          ? 'Linked, but not connected right now. Open Number & sending to reconnect it.'
          : live
            ? 'For now, messages go out from your default WhatsApp Gateway number. You can link a separate number just for the API.'
            : 'Scan a QR code with the WhatsApp number you want to send from.',
      action: !data.api_number?.connected ? <button className="btn sm" onClick={() => setTab('number')}>Open Number &amp; sending</button> : null,
    },
    { done: data.keys.length > 0, title: 'Create an API key', text: 'A key is like a password for your software. Make one for each website, POS or app.', action: data.enabled ? <button className="btn sm primary" onClick={() => setModal('new')}><Icon.plus /> Create key</button> : null },
    { done: false, title: 'Add the key to your software', text: 'Give your developer the key and the API address below. The guide shows how.', action: <button className="btn sm" onClick={() => setTab('pos')}>Read the guide</button> },
  ];
  return (
    <>
      {!data.enabled && (
        <div className="auth-error">The admin has turned off the API. You can't create keys, and messages from your software are refused.</div>
      )}

      <div className="card dev-hero">
        <div className="card-pad">
          <h3 className="dev-h3">Send WhatsApp messages from your own software</h3>
          <p className="dev-p">Your website, POS or app can send WhatsApp messages, like an OTP code, a receipt or an order update. Follow these 3 steps.</p>
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
          <CopyLine label="API address (base URL) for your developer" value={apiBase()} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Icon.key style={{ width: 18, color: 'var(--brand-700)' }} />
          <div style={{ flex: 1 }}><h3>API keys</h3><div className="sub">{data.keys.length} of {data.limits.maxKeys} keys · {fmtNum(data.today)} message{data.today === 1 ? '' : 's'} sent today</div></div>
          {data.enabled && <button className="btn primary sm" onClick={() => setModal('new')}><Icon.plus /> Create key</button>}
        </div>
        {data.keys.length === 0 ? (
          <Empty icon="key" title="No API keys yet">Create a key for your website, POS or app. You'll see it only once, so copy it and keep it safe.</Empty>
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
        <div><span>Per minute</span><strong>{data.limits.perMinute} messages per key</strong></div>
        <div><span>File size</span><strong>PDF 16 MB · Photo 5 MB</strong></div>
        <div><span>Per day</span><strong>{data.limits.qrPerDay ? `${fmtNum(data.limits.qrPerDay)} messages per number` : 'No limit'}</strong></div>
        <div><span>Meta numbers</span><strong>Meta's rules apply</strong></div>
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
          <p className="dev-p">Any software using this key (<code className="dev-keyid">{deleting.prefix}…{deleting.last4}</code>) stops sending right away. You can't undo this, but you can create a new key any time.</p>
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
        <h4 className="dev-h4"><span className="dev-n">1</span> Link the WhatsApp number receipts come from</h4>
        <p className="dev-p">On <button className="link-btn" onClick={() => setTab('number')}>Developer → Number &amp; sending</button>, link the <strong>API number</strong>: scan a QR code with the phone that should send receipts. It's only used by the API. Without one, receipts go out from your default <strong>WhatsApp Gateway</strong> number, and a key can always be set to a Gateway number instead.</p>

        <h4 className="dev-h4"><span className="dev-n">2</span> Create an API key</h4>
        <p className="dev-p">On <button className="link-btn" onClick={() => setTab('keys')}>Developer → API keys</button>, create a key named after the POS (for example "Shop POS"). Copy it and save it in the POS settings. Keep it on the POS server or in the till's private settings, never in a public web page.</p>

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
          <li><strong>Waiting time</strong>: when the message can go out right away, the API answers once WhatsApp has taken it, usually in 1 to 5 seconds. When it has to wait its turn (your sending settings on <em>Developer → Number &amp; sending</em>, e.g. 5 messages then 60 seconds), it answers at once with <code>"status": "queued"</code> (HTTP 202) and goes out in order. Use a 30-second timeout.</li>
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

// The API number's chats, for the super admin only.
function ChatsTab({ data, setTab }) {
  const n = data.api_number;
  if (!n?.phone) {
    return (
      <div className="card">
        <Empty icon="chat" title="No API number yet" action={<button className="btn primary" onClick={() => setTab('number')}><Icon.phone /> Open Number &amp; sending</button>}>
          Link the API number first. Its chats will show here.
        </Empty>
      </div>
    );
  }
  return (
    <div className="dev-chats">
      <div className="dev-chats-note">
        <Icon.shield /> Only you (the super admin) can see this tab. It shows the chats of the API number +{n.phone}
        {n.connected ? '' : ' — not connected right now, so new messages will show when it is back'}.
      </div>
      <Conversations apiNumber={n} />
    </div>
  );
}

export default function Developer() {
  const { onBus, user } = useApp();
  const isSuper = user?.role === 'owner';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useTab('developer', isSuper ? SUPER_TABS : TABS);
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
      <TabBar tabs={isSuper ? SUPER_TABS : TABS} tab={tab} setTab={setTab} />
      {tab === 'number' && <NumberTab data={data} reload={load} />}
      {tab === 'keys' && <KeysTab data={data} reload={load} setTab={setTab} />}
      {tab === 'chats' && isSuper && <ChatsTab data={data} setTab={setTab} />}
      {tab !== 'chats' && <div className="dev-docs-link">
        <Icon.book /> Need help connecting? The setup guide, the API reference and the request log are in{' '}
        <button className="link-btn" onClick={() => openOn('devdocs', 'pos')}>Developer Docs</button>.
      </div>}
    </div>
  );
}

// Developer Docs: for whoever connects the POS / website (and to check what it sent).
export function DeveloperDocs() {
  const [tab, setTab] = useTab('devdocs', DOC_TABS);
  return (
    <div className="dev-page">
      <TabBar tabs={DOC_TABS} tab={tab} setTab={setTab} />
      {tab === 'pos' && <PosTab setTab={setTab} />}
      {tab === 'reference' && <ReferenceTab />}
      {tab === 'logs' && <LogsTab />}
    </div>
  );
}
