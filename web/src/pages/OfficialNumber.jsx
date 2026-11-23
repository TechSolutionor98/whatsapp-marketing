import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Loading, PasswordInput } from '../ui.jsx';

// Two ways to link a WhatsApp number: scan a QR code (free, like WhatsApp Web) or connect an
// official WhatsApp Business number through Meta's WhatsApp Cloud API.
export function LinkChoiceModal({ onPick, onClose }) {
  return (
    <Modal title="Link a WhatsApp number" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Cancel</button>}>
      <div className="link-choices">
        <button className="link-choice" onClick={() => onPick('qr')}>
          <div className="link-choice-ico"><Icon.link /></div>
          <div className="link-choice-title">Scan a QR code <span className="badge green">Free</span></div>
          <div className="link-choice-desc">Link the WhatsApp on your phone, like WhatsApp Web. Ready in seconds. Your chats load in, and sending is paced to protect the number.</div>
          <ul className="link-choice-list">
            <li>No Meta account needed</li>
            <li>Any message, any time</li>
            <li>Keep the phone online</li>
          </ul>
        </button>
        <button className="link-choice" onClick={() => onPick('cloud')}>
          <div className="link-choice-ico official"><Icon.shield /></div>
          <div className="link-choice-title">Official WhatsApp API <span className="badge blue">Meta Cloud API</span></div>
          <div className="link-choice-desc">Connect a WhatsApp Business number registered on Meta's platform with your own access token. No phone has to stay online.</div>
          <ul className="link-choice-list">
            <li>Meta's own sending limits, no ban risk from volume</li>
            <li>Campaigns send your Meta-approved templates</li>
            <li>Meta charges per conversation</li>
          </ul>
        </button>
      </div>
    </Modal>
  );
}

function CopyField({ label, value }) {
  const { toast } = useApp();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`, 'success');
    } catch {
      toast('Select the text and copy it', 'error');
    }
  };
  return (
    <div className="field">
      <label>{label}</label>
      <div className="copy-field">
        <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn sm" onClick={copy}><Icon.copy /> Copy</button>
      </div>
    </div>
  );
}

const webhookUrl = () => `${window.location.origin}/api/cloud/webhook`;

// After connecting: tell Meta where to send messages (Callback URL + Verify token), and show
// when Meta has checked it.
function WebhookSteps({ info }) {
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(window.location.hostname);
  const ok = !!(info.webhook_verified_at || info.last_event_at);
  return (
    <>
      <div className={`cloud-status ${ok ? 'ok' : 'wait'}`}>
        {ok ? <Icon.check /> : <div className="spinner sm" />}
        <div>
          <strong>{ok ? 'Webhook connected' : 'Waiting for Meta to check the webhook…'}</strong>
          <div>{ok ? (info.last_event_at ? 'Messages and delivery updates are arriving.' : 'Meta checked the address. New messages will arrive here.') : 'Do the steps below; this turns green on its own.'}</div>
        </div>
      </div>
      {local && <div className="auth-error">This page is open on {window.location.hostname}. Meta can only reach a public https address, so do this from your live site.</div>}
      <ol className="cloud-steps">
        <li>In your Meta app, open <strong>WhatsApp → Configuration</strong> and click <strong>Edit</strong> next to Webhook.</li>
        <li>Paste the <strong>Callback URL</strong> and <strong>Verify token</strong> below, then click <strong>Verify and save</strong>.</li>
        <li>Under <strong>Webhook fields</strong>, click <strong>Manage</strong> and subscribe to <strong>messages</strong>.</li>
      </ol>
      <CopyField label="Callback URL" value={webhookUrl()} />
      <CopyField label="Verify token" value={info.verify_token || ''} />
      {info.subscribed === false && (
        <div className="auth-note">
          We couldn't subscribe your app to this WhatsApp Business Account automatically ({info.subscribe_error || 'no permission'}). In Meta, make sure the app is
          subscribed to the account's webhooks, or give the token the <code>whatsapp_business_management</code> permission and save it again.
        </div>
      )}
    </>
  );
}

// Connect an official number: the details from Meta, checked before anything is saved.
export function OfficialNumberModal({ onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({ label: '', phoneNumberId: '', wabaId: '', token: '', appSecret: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null); // the connected number's setup details
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  // Once connected, watch for Meta's webhook check.
  useEffect(() => {
    if (!done?.id) return;
    const t = setInterval(async () => {
      try {
        setDone(await api.get(`/conversations/accounts/${done.id}/cloud`));
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, [done?.id]);

  async function connect(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await api.post('/conversations/accounts/cloud', f);
      setDone(r);
      toast(`+${r.phone} connected through the official API`, 'success');
      onDone?.();
    } catch (e2) {
      setErr(e2.message);
    }
    setBusy(false);
  }

  if (done) {
    return (
      <Modal title={`Connected: ${done.verified_name || `+${done.phone}`}`} onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <div className="auth-note" style={{ marginBottom: 14 }}>
          <strong>+{done.phone}</strong> is connected{done.quality ? ` (quality: ${done.quality.toLowerCase()})` : ''}. You can already send from it. One last step lets
          its incoming messages and read receipts reach you:
        </div>
        <WebhookSteps info={done} />
      </Modal>
    );
  }

  return (
    <Modal
      title="Connect an official WhatsApp number"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" form="cloud-form" disabled={busy}><Icon.shield /> {busy ? 'Checking with Meta…' : 'Connect'}</button>
        </>
      }
    >
      <form id="cloud-form" onSubmit={connect}>
        {err && <div className="auth-error">{err}</div>}
        <details className="cloud-help">
          <summary>Where do I find these?</summary>
          <ol>
            <li>Open <strong>developers.facebook.com → My Apps</strong>, pick your Business app and go to <strong>WhatsApp → API Setup</strong>. Copy the <strong>Phone number ID</strong> and <strong>WhatsApp Business Account ID</strong>.</li>
            <li>Access token: use a permanent token from <strong>Meta Business Settings → Users → System users → Generate new token</strong>, with <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>. (The token on the API Setup page stops working after 24 hours.)</li>
            <li>App secret: in your app, <strong>App settings → Basic → App secret → Show</strong>.</li>
          </ol>
        </details>
        <div className="field">
          <label>Label (optional)</label>
          <input className="input" value={f.label} onChange={set('label')} placeholder="e.g. Sales line" maxLength={60} />
        </div>
        <div className="row">
          <div className="field">
            <label>Phone number ID</label>
            <input className="input" value={f.phoneNumberId} onChange={set('phoneNumberId')} placeholder="e.g. 106540352242922" inputMode="numeric" required />
          </div>
          <div className="field">
            <label>WhatsApp Business Account ID</label>
            <input className="input" value={f.wabaId} onChange={set('wabaId')} placeholder="e.g. 102290129340398" inputMode="numeric" required />
          </div>
        </div>
        <div className="field">
          <label>Access token</label>
          <PasswordInput value={f.token} onChange={set('token')} placeholder="EAAG…" autoComplete="off" required />
        </div>
        <div className="field">
          <label>App secret</label>
          <PasswordInput value={f.appSecret} onChange={set('appSecret')} placeholder="32 letters and numbers" autoComplete="off" required />
          <div className="hint">Used only to check that incoming messages really come from Meta. The token and secret are never shown again.</div>
        </div>
      </form>
    </Modal>
  );
}

// An official number's webhook details, status, and a new token when the old one expires.
export function OfficialSetupModal({ id, onClose, onChanged }) {
  const { toast } = useApp();
  const [info, setInfo] = useState(null);
  const [f, setF] = useState({ token: '', appSecret: '' });
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      setInfo(await api.get(`/conversations/accounts/${id}/cloud`));
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [id]);
  async function save() {
    setBusy(true);
    try {
      await api.put(`/conversations/accounts/${id}/cloud`, f);
      setF({ token: '', appSecret: '' });
      toast('Saved and checked with Meta', 'success');
      load();
      onChanged?.();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }
  return (
    <Modal title="Official number setup" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {!info ? (
        <Loading label="Loading…" minHeight={200} />
      ) : (
        <>
          <div className="cloud-facts">
            <div><span>Number</span><strong>+{info.phone}</strong></div>
            <div><span>Business name</span><strong>{info.verified_name || '—'}</strong></div>
            <div><span>Quality</span><strong>{info.quality ? info.quality.toLowerCase() : '—'}</strong></div>
            <div><span>Token</span><strong>••••{info.token_last4}</strong></div>
          </div>
          {info.error && <div className="auth-error">{info.error}</div>}
          <WebhookSteps info={info} />
          <div className="cloud-update">
            <h4>Replace the access token or app secret</h4>
            <div className="row">
              <div className="field">
                <label>New access token</label>
                <PasswordInput value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="off" placeholder="Leave empty to keep" />
              </div>
              <div className="field">
                <label>New app secret</label>
                <PasswordInput value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} autoComplete="off" placeholder="Leave empty to keep" />
              </div>
            </div>
            <button className="btn" onClick={save} disabled={busy || (!f.token && !f.appSecret)}>{busy ? 'Checking with Meta…' : 'Save and check'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---- Campaigns: pick an approved template and fill in its variables ----

const keyOf = (t) => `${t.name}|${t.language}`;
const fill = (text, vars, vals) => vars.reduce((s, k, i) => s.split(`{{${k}}}`).join(vals[i] ? `[${vals[i]}]` : `{{${k}}}`), text || '');

export function CloudTemplatePicker({ accountId, value, onChange }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!accountId) return;
    setList(null);
    setErr('');
    api
      .get(`/conversations/accounts/${accountId}/templates`)
      .then(setList)
      .catch((e) => {
        setErr(e.message);
        setList([]);
      });
  }, [accountId]);

  const cur = list && value ? list.find((t) => keyOf(t) === keyOf(value)) : null;
  const pick = (k) => {
    const t = (list || []).find((x) => keyOf(x) === k);
    if (!t) return onChange(null);
    onChange({
      name: t.name,
      language: t.language,
      body_params: t.bodyVars.map((_, i) => (i === 0 ? '{{first_name}}' : '')),
      header_params: t.headerVars.map(() => ''),
      header_link: '',
    });
  };
  const setParam = (field, i, v) => {
    const arr = [...(value[field] || [])];
    arr[i] = v;
    onChange({ ...value, [field]: arr });
  };
  const media = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(cur?.header?.format);

  if (!accountId) return <div className="hint">Pick the official number first.</div>;
  if (!list) return <Loading label="Loading your approved templates from Meta…" minHeight={80} />;
  return (
    <div className="cloud-tpl">
      {err && <div className="auth-error">{err}</div>}
      <select className="select" value={value ? keyOf(value) : ''} onChange={(e) => pick(e.target.value)}>
        <option value="">Select an approved WhatsApp template…</option>
        {list.map((t) => (
          <option key={keyOf(t)} value={keyOf(t)} disabled={!!t.unsupported}>
            {t.name} · {t.language} · {String(t.category || '').toLowerCase()}{t.unsupported ? ` (not supported: ${t.unsupported})` : ''}
          </option>
        ))}
      </select>
      {!err && list.length === 0 && (
        <div className="hint">No approved templates yet. Create one in Meta (WhatsApp Manager → Message templates). Approval usually takes minutes.</div>
      )}
      {cur && (
        <>
          <div className="cloud-tpl-preview">
            {cur.header?.format === 'TEXT' && <strong>{fill(cur.header.text, cur.headerVars, value.header_params || [])}</strong>}
            {media && <div className="cloud-tpl-media"><Icon.image /> {cur.header.format.toLowerCase()} at the top</div>}
            <div className="cloud-tpl-body">{fill(cur.body, cur.bodyVars, value.body_params || [])}</div>
            {cur.footer && <div className="cloud-tpl-footer">{cur.footer}</div>}
            {cur.buttons.length > 0 && <div className="cloud-tpl-buttons">{cur.buttons.map((b, i) => <span key={i}>{b.text}</span>)}</div>}
          </div>
          {media && (
            <div className="field">
              <label>Link to the {cur.header.format.toLowerCase()}</label>
              <input className="input" value={value.header_link || ''} onChange={(e) => onChange({ ...value, header_link: e.target.value })} placeholder="https://…" />
              <div className="hint">A public https:// link Meta can download.</div>
            </div>
          )}
          {cur.headerVars.map((k, i) => (
            <div className="field" key={`h${k}`}>
              <label>Header {`{{${k}}}`}</label>
              <input className="input" value={value.header_params?.[i] || ''} onChange={(e) => setParam('header_params', i, e.target.value)} placeholder="Text, or {{first_name}}" />
            </div>
          ))}
          {cur.bodyVars.length > 0 && (
            <div className="cloud-vars">
              {cur.bodyVars.map((k, i) => (
                <div className="field" key={`b${k}`}>
                  <label>{`{{${k}}}`}</label>
                  <input className="input" value={value.body_params?.[i] || ''} onChange={(e) => setParam('body_params', i, e.target.value)} placeholder="Text, or {{first_name}}" />
                </div>
              ))}
              <div className="hint">Use {'{{first_name}}'}, {'{{name}}'} or {'{{phone}}'} to fill in each person's details, or type fixed text.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// What's still missing from a template choice ('' = ready to save).
export function cloudTemplateMissing(value) {
  if (!value?.name) return 'Pick an approved WhatsApp template';
  if ((value.body_params || []).some((v) => !String(v || '').trim())) return 'Fill in every variable of the template';
  if ((value.header_params || []).some((v) => !String(v || '').trim())) return "Fill in the template's header";
  return '';
}
