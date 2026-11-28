import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Loading, Empty, timeAgo } from '../ui.jsx';
import { TabBar, CodeBlock } from './Developer.jsx';

// AI Agents: an AI chat assistant for the business's own website. It answers visitors from the
// workspace's product catalogs and the business info written here, and sends them to WhatsApp
// when only a person can help. Websites add it with one line (web/public/widget.js); the
// server side is server/agents.js, server/routes/agents.js and server/routes/agent-public.js.

const TABS = [
  ['agents', 'Agents', 'bot'],
  ['install', 'Add to website', 'globe'],
  ['chats', 'Website chats', 'chat'],
];
const TAB_KEY = 'pulse.agentsTab';
const COLORS = ['#16a34a', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0f766e', '#111827'];
const TONES = [
  ['friendly', 'Friendly'],
  ['professional', 'Professional'],
  ['casual', 'Casual'],
  ['enthusiastic', 'Enthusiastic'],
];
const INFO_EXAMPLE = `About: We sell laptops, phones and accessories. Family business since 2015.
Opening hours: Saturday to Thursday 10am–10pm, Friday 2pm–10pm.
Location: Shop 12, City Centre Mall (Google Maps: https://maps.google.com/…)
Delivery: Free over 200 in the city, 1–2 days. Other cities 25, 2–3 days.
Returns: Within 7 days, unused, with the receipt.
Payment: Cash on delivery, card, bank transfer.
Contact: +971 4 123 4567 · sales@yourshop.com`;

const fmtNum = (n) => Number(n || 0).toLocaleString();
const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const origin = () => window.location.origin;
const snippet = (a) => `<script src="${origin()}/widget.js" data-agent="${a.pub_id}" async></script>`;
const previewUrl = (a) => `${origin()}/api/agent/${a.pub_id}/preview`;

// Text colour that reads on the agent's colour (same rule as the widget).
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 0.45 ? '#111827' : '#ffffff';
}
const initials = (name) => {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  return `${(w[0] || '?')[0]}${w[1] ? w[1][0] : ''}`.toUpperCase();
};

// What an agent knows, in a few words.
function knowsText(a, data) {
  let products = '';
  if (a.catalogs === 'none') products = 'No products';
  else if (Array.isArray(a.catalogs)) {
    const chosen = data.catalogs.filter((c) => a.catalogs.includes(c.id));
    products = `${plural(chosen.reduce((s, c) => s + c.count, 0), 'product')} from ${plural(chosen.length, 'catalog')}`;
  } else products = data.products ? `All ${plural(data.products, 'product')}` : 'No products yet';
  return `${products}${a.info?.trim() ? ' · business info' : ''}`;
}

// Links and *bold* in a chat message, as React elements (never raw HTML).
function inline(s) {
  const out = [];
  const rx = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"*])|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = rx.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<a key={k++} href={m[1]} target="_blank" rel="noopener noreferrer">{m[1]}</a>);
    else out.push(<strong key={k++}>{m[2] || m[3]}</strong>);
    last = rx.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function Rich({ text }) {
  return String(text || '')
    .split('\n')
    .map((line, i) => (
      <span key={i}>
        {i > 0 && <br />}
        {inline(line)}
      </span>
    ));
}

function useLocalTab() {
  const [tab, set] = useState(() => {
    try {
      const t = localStorage.getItem(TAB_KEY);
      return TABS.some(([id]) => id === t) ? t : 'agents';
    } catch {
      return 'agents';
    }
  });
  const setTab = (t) => {
    set(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {}
    window.scrollTo?.(0, 0);
  };
  return [tab, setTab];
}

// ---- The editor's form ↔ an agent ----

function blankForm(data) {
  return {
    name: 'Shop assistant',
    subtitle: 'Replies instantly',
    greeting: 'Hi! 👋 How can I help you today?',
    color: COLORS[0],
    position: 'right',
    enabled: true,
    info: data.business_info || '',
    tone: 'friendly',
    catalogs: 'all',
    suggestions: ['What do you sell?', 'Do you deliver?', 'Talk to a person', ''],
    domains: '',
    handoff: { mode: data.default_phone ? 'default' : 'none', phone: '' },
  };
}
const toForm = (a) => {
  const s = [...(a.suggestions || [])];
  while (s.length < 4) s.push('');
  return {
    name: a.name,
    subtitle: a.subtitle,
    greeting: a.greeting,
    color: a.color,
    position: a.position,
    enabled: a.enabled,
    info: a.info || '',
    tone: a.tone || 'friendly',
    catalogs: a.catalogs ?? 'all',
    suggestions: s,
    domains: (a.domains || []).join('\n'),
    handoff: { mode: a.handoff?.mode || 'default', phone: a.handoff?.phone || '' },
  };
};
const toBody = (f) => ({
  ...f,
  suggestions: f.suggestions.map((s) => s.trim()).filter(Boolean),
  domains: f.domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
});

// ---- Small pieces ----

function AiNotice({ data }) {
  const { can } = useApp();
  if (data.ai.available) return null;
  return (
    <div className="auth-error">
      {data.ai.allowed ? (
        <>
          AI isn't set up for this workspace yet, so your agents can't answer visitors. Add an AI key in{' '}
          {can('settings') ? <a href="#/settings">Settings → AI</a> : 'Settings → AI (ask your admin)'}.
        </>
      ) : (
        'The super admin has switched AI off, so agents can’t answer visitors right now.'
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}

// A static picture of the chat, for the intro card.
function DemoChat() {
  return (
    <div className="agp ag-demo" style={{ '--agc': COLORS[0], '--agi': '#fff' }} aria-hidden="true">
      <div className="agp-head">
        <span className="agp-av">SA</span>
        <div className="agp-who"><strong>Shop assistant</strong><span><i /> Replies instantly</span></div>
      </div>
      <div className="agp-body">
        <div className="agp-msg a">Hi! 👋 How can I help you today?</div>
        <div className="agp-msg v">Do you have wireless earbuds under 200?</div>
        <div className="agp-msg a">Yes! 2 are in stock:<br />1. <strong>Pro Buds 2</strong>: 149<br />2. <strong>Air Mini</strong>: 189<br />Want the links?</div>
        <div className="agp-msg v">Can I pay on delivery?</div>
        <div className="agp-msg a">Yes, cash on delivery is available. 🚚</div>
      </div>
    </div>
  );
}

// ---- Agents tab ----

function IntroCard({ data, onNew }) {
  return (
    <div className="card dev-hero">
      <div className="card-pad ag-intro">
        <div>
          <h3 className="dev-h3">Put an AI assistant on your website</h3>
          <p className="dev-p">It chats with your website visitors day and night. It knows all your products, prices and stock from your catalogs, plus the business info you give it. When only a person can help, it sends the visitor to your WhatsApp.</p>
          <ol className="dev-steps ag-steps">
            <li>
              <span className="dev-step-n">1</span>
              <div className="dev-step-body"><strong>Create an agent</strong><span>Give it a name, a colour and a welcome message.</span></div>
            </li>
            <li>
              <span className="dev-step-n">2</span>
              <div className="dev-step-body">
                <strong>Teach it</strong>
                <span>{data.products ? `Your ${plural(data.products, 'product')} are included automatically. Add your opening hours, delivery and returns.` : 'Add your opening hours, delivery and returns. Products come from Settings → Product catalogs.'}</span>
              </div>
            </li>
            <li>
              <span className="dev-step-n">3</span>
              <div className="dev-step-body"><strong>Add it to your website</strong><span>One line of code. Step-by-step guides for WordPress, Shopify, Wix and more.</span></div>
            </li>
          </ol>
          <button className="btn primary" onClick={onNew}><Icon.plus /> Create your first agent</button>
        </div>
        <DemoChat />
      </div>
    </div>
  );
}

function AgentCard({ a, data, onEdit, onInstall }) {
  return (
    <div className={`ag-card ${a.enabled ? '' : 'off'}`}>
      <div className="ag-card-top">
        <span className="ag-av" style={{ background: a.color, color: textOn(a.color) }} aria-hidden="true">{initials(a.name)}</span>
        <div className="ag-card-who">
          <strong>{a.name}</strong>
          <span>{knowsText(a, data)}</span>
        </div>
        <span className={`badge ${a.enabled ? 'green' : 'gray'}`}>{a.enabled ? 'On' : 'Off'}</span>
      </div>
      <div className="ag-card-stats">
        <div><strong>{fmtNum(a.chats_today)}</strong><span>{a.chats_today === 1 ? 'chat' : 'chats'} today</span></div>
        <div><strong>{fmtNum(a.chats)}</strong><span>{a.chats === 1 ? 'chat' : 'chats'} in all</span></div>
        <div><strong>{fmtNum(a.today_replies)}</strong><span>{a.today_replies === 1 ? 'answer' : 'answers'} today</span></div>
      </div>
      <div className="ag-card-act">
        <button className="btn sm" onClick={onEdit}><Icon.edit /> Edit &amp; test</button>
        <button className="btn sm ghost" onClick={onInstall}><Icon.code /> Add to website</button>
      </div>
    </div>
  );
}

function AgentsList({ data, onEdit, onNew, onInstall }) {
  const n = data.agents.length;
  const def = data.default_phone;
  return (
    <>
      <AiNotice data={data} />
      {n === 0 ? (
        <IntroCard data={data} onNew={onNew} />
      ) : (
        <div className="card">
          <div className="card-head">
            <Icon.bot style={{ width: 18, color: 'var(--brand-700)' }} />
            <div style={{ flex: 1 }}>
              <h3>Your AI agents</h3>
              <div className="sub">{n} of {data.limits.maxAgents} · they answer your website visitors from your products and business info</div>
            </div>
            {n < data.limits.maxAgents && <button className="btn primary sm" onClick={onNew}><Icon.plus /> New agent</button>}
          </div>
          <div className="card-pad ag-grid">
            {data.agents.map((a) => (
              <AgentCard key={a.id} a={a} data={data} onEdit={() => onEdit(a.id)} onInstall={() => onInstall(a.id)} />
            ))}
          </div>
        </div>
      )}
      <div className="dev-facts">
        <div><span>Knows</span><strong>{data.products ? `${plural(data.products, 'product')} in ${plural(data.catalogs.length, 'catalog')}` : 'No products yet'}</strong></div>
        <div><span>Answers a day</span><strong>Up to {fmtNum(data.limits.perDay)} per agent</strong></div>
        <div><span>WhatsApp button</span><strong>{def ? `Opens +${def}` : 'Link a WhatsApp number first'}</strong></div>
        <div><span>Chats kept</span><strong>{data.limits.keepDays} days</strong></div>
      </div>
    </>
  );
}

// ---- The live test chat (looks like the real widget) ----

function ChatPreview({ f, saved }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  useEffect(() => {
    const b = bodyRef.current;
    if (b) b.scrollTop = b.scrollHeight;
  }, [msgs, busy]);
  async function send(t) {
    t = String(t || '').trim();
    if (!t || busy) return;
    const next = [...msgs.filter((m) => m.role !== 'error'), { role: 'visitor', text: t }];
    setMsgs(next);
    setText('');
    setBusy(true);
    try {
      const r = await api.post('/agents/test', { agent: toBody(f), messages: next.map(({ role, text: x }) => ({ role, text: x })) });
      setMsgs([...next, { role: 'agent', text: r.reply, whatsapp: r.whatsapp }]);
    } catch (e) {
      setMsgs([...next.slice(0, -1), { role: 'error', text: e.message }]);
      setText(t);
    }
    setBusy(false);
  }
  const ink = textOn(f.color);
  const chips = f.suggestions.map((s) => s.trim()).filter(Boolean);
  const visitorSaid = msgs.some((m) => m.role === 'visitor');
  return (
    <div className="ag-preview">
      <div className="ag-preview-head">
        <strong>Try it</strong>
        <span>Uses the settings on the left, even before you save. Test chats aren't saved.</span>
      </div>
      <div className="agp" style={{ '--agc': f.color, '--agi': ink }}>
        <div className="agp-head">
          <span className="agp-av" aria-hidden="true">{initials(f.name)}</span>
          <div className="agp-who">
            <strong>{f.name || 'Assistant'}</strong>
            <span><i /> {f.subtitle || 'Replies instantly'}</span>
          </div>
          <button type="button" className="agp-hb" title="Start a new chat" aria-label="Start a new test chat" onClick={() => !busy && setMsgs([])}><Icon.refresh /></button>
        </div>
        <div className="agp-body" ref={bodyRef} aria-live="polite">
          <div className="agp-msg a"><Rich text={f.greeting || 'Hi! How can I help?'} /></div>
          {!visitorSaid && chips.length > 0 && (
            <div className="agp-chips">
              {chips.map((c) => <button key={c} type="button" onClick={() => send(c)}>{c}</button>)}
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`agp-msg ${m.role === 'visitor' ? 'v' : m.role === 'error' ? 'e' : 'a'}`}>
              <Rich text={m.text} />
              {m.whatsapp && (
                <a className="agp-wa" href={m.whatsapp} target="_blank" rel="noopener noreferrer"><Icon.chat /> Chat on WhatsApp</a>
              )}
            </div>
          ))}
          {busy && <div className="agp-typing" aria-label="Typing"><span /><span /><span /></div>}
        </div>
        <form
          className="agp-foot"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <input className="agp-input" placeholder="Ask like a visitor would…" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-label="Test message" />
          <button className="agp-send" disabled={busy || !text.trim()} aria-label="Send"><Icon.send /></button>
        </form>
        <div className="agp-note">Virtual assistant · it can make mistakes</div>
      </div>
      <div className={`ag-launch-row ${f.position === 'left' ? 'left' : ''}`}>
        <span className="ag-launch" style={{ background: f.color, color: ink }} aria-hidden="true"><Icon.chat /></span>
        <span className="ag-launch-cap">The chat button sits at the bottom {f.position === 'left' ? 'left' : 'right'} of your website</span>
      </div>
      {saved && (
        <a className="btn sm ag-preview-link" href={previewUrl(saved)} target="_blank" rel="noreferrer"><Icon.globe /> Open the preview page (saved settings)</a>
      )}
    </div>
  );
}

// ---- Create / edit an agent ----

function AgentEditor({ data, id, onClose, onSaved, onDeleted, onInstall, dirtyRef }) {
  const { toast, can } = useApp();
  const saved = id === 'new' ? null : data.agents.find((a) => a.id === id) || null;
  const [start] = useState(() => (saved ? toForm(saved) : blankForm(data)));
  const [f, setF] = useState(start);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dirty = !saved || JSON.stringify(f) !== JSON.stringify(start);
  useEffect(() => {
    dirtyRef.current = dirty && !busy;
    return () => {
      dirtyRef.current = false;
    };
  }, [dirty, busy]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const pickMode = f.catalogs === 'all' ? 'all' : f.catalogs === 'none' ? 'none' : 'pick';
  const chosen = Array.isArray(f.catalogs) ? f.catalogs : [];
  const def = data.default_phone;

  async function save() {
    if (!f.name.trim()) return toast('Give the agent a name', 'error');
    if (pickMode === 'pick' && !chosen.length) return toast('Choose at least one catalog, or pick "All catalogs"', 'error');
    setBusy(true);
    try {
      const r = saved ? await api.put(`/agents/${saved.id}`, toBody(f)) : await api.post('/agents', toBody(f));
      dirtyRef.current = false;
      onSaved(r, !saved);
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    try {
      await api.del(`/agents/${saved.id}`);
      dirtyRef.current = false;
      toast(`"${saved.name}" deleted. The chat button is gone from your website.`, 'success');
      onDeleted();
    } catch (e) {
      toast(e.message, 'error');
      setBusy(false);
    }
  }
  const back = () => {
    if (saved && dirty && !window.confirm('Leave without saving your changes?')) return;
    onClose();
  };

  return (
    <div className="ag-editor">
      <div className="ag-bar">
        <button className="btn sm ghost" onClick={back}><Icon.chevronDown style={{ transform: 'rotate(90deg)' }} /> All agents</button>
        <strong className="ag-bar-title">{saved ? saved.name : 'New agent'}</strong>
        <div className="ag-bar-act">
          {saved && <button className="btn sm ghost" onClick={() => onInstall(saved.id)}><Icon.code /> Add to website</button>}
          {saved && <button className="btn sm ghost danger-text" onClick={() => setDeleting(true)}><Icon.trash /> Delete</button>}
          <button className="btn sm primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : saved ? (dirty ? 'Save changes' : 'Saved') : 'Create agent'}</button>
        </div>
      </div>
      <AiNotice data={data} />

      <div className="ag-edit">
        <div className="ag-form">
          <div className="card">
            <div className="card-head">
              <Icon.sparkles style={{ width: 18, color: 'var(--brand-700)' }} />
              <div style={{ flex: 1 }}><h3>Look and welcome</h3><div className="sub">What visitors see when they open the chat.</div></div>
              <div className="ag-on">
                <span>{f.enabled ? 'On' : 'Off'}</span>
                <Toggle checked={f.enabled} onChange={(v) => set('enabled', v)} label="Agent on" />
              </div>
            </div>
            <div className="card-pad">
              {!f.enabled && <div className="ag-hint-box">Off: the chat button doesn't show on your website.</div>}
              <div className="ag-two">
                <div className="field">
                  <label htmlFor="ag-name">Name</label>
                  <input id="ag-name" className="input" maxLength={60} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sara, or Shop assistant" />
                </div>
                <div className="field">
                  <label htmlFor="ag-sub">Line under the name</label>
                  <input id="ag-sub" className="input" maxLength={60} value={f.subtitle} onChange={(e) => set('subtitle', e.target.value)} placeholder="Replies instantly" />
                </div>
              </div>
              <div className="field">
                <label htmlFor="ag-greet">Welcome message</label>
                <textarea id="ag-greet" className="textarea" rows={2} maxLength={400} value={f.greeting} onChange={(e) => set('greeting', e.target.value)} />
                <div className="hint">The first message in the chat. It also pops up next to the chat button once per visit.</div>
              </div>
              <div className="ag-two">
                <div className="field">
                  <label>Colour</label>
                  <div className="ag-colors">
                    {COLORS.map((c) => (
                      <button key={c} type="button" className={`ag-swatch ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set('color', c)} aria-label={`Colour ${c}`} aria-pressed={f.color === c} />
                    ))}
                    <label className="ag-swatch custom" title="Your own colour">
                      <input type="color" value={f.color} onChange={(e) => set('color', e.target.value)} aria-label="Your own colour" />
                    </label>
                  </div>
                </div>
                <div className="field">
                  <label>Chat button</label>
                  <div className="seg">
                    {[['left', 'Bottom left'], ['right', 'Bottom right']].map(([v, l]) => (
                      <button key={v} type="button" className={`seg-btn ${f.position === v ? 'active' : ''}`} onClick={() => set('position', v)}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <Icon.book style={{ width: 18, color: 'var(--brand-700)' }} />
              <div><h3>What it knows</h3><div className="sub">It only says what's here. It never makes up prices, stock, hours or policies.</div></div>
            </div>
            <div className="card-pad">
              <div className="field">
                <label>Products</label>
                {data.catalogs.length === 0 ? (
                  <div className="ag-hint-box">
                    You have no product catalogs yet. Add your products (from your store's API, or typed in) in{' '}
                    {can('settings') ? <a href="#/settings">Settings → Product catalogs</a> : 'Settings → Product catalogs'} and the agent knows them right away.
                  </div>
                ) : (
                  <>
                    <div className="ag-radios">
                      <label className={`ag-radio ${pickMode === 'all' ? 'on' : ''}`}>
                        <input type="radio" name="ag-cat" checked={pickMode === 'all'} onChange={() => set('catalogs', 'all')} />
                        <span><strong>All catalogs</strong><em>{plural(data.products, 'product')}, plus any catalog you add later</em></span>
                      </label>
                      <label className={`ag-radio ${pickMode === 'pick' ? 'on' : ''}`}>
                        <input type="radio" name="ag-cat" checked={pickMode === 'pick'} onChange={() => set('catalogs', data.catalogs.map((c) => c.id))} />
                        <span><strong>Choose catalogs</strong><em>Only the ones you tick</em></span>
                      </label>
                      <label className={`ag-radio ${pickMode === 'none' ? 'on' : ''}`}>
                        <input type="radio" name="ag-cat" checked={pickMode === 'none'} onChange={() => set('catalogs', 'none')} />
                        <span><strong>No products</strong><em>Business info only</em></span>
                      </label>
                    </div>
                    {pickMode === 'pick' && (
                      <div className="ag-cats">
                        {data.catalogs.map((c) => (
                          <label key={c.id} className={`sa-check ${chosen.includes(c.id) ? 'on' : ''}`}>
                            <input
                              type="checkbox"
                              checked={chosen.includes(c.id)}
                              onChange={(e) => set('catalogs', e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))}
                            />
                            {c.name} <span className="cell-muted">· {plural(c.count, 'product')}{c.type === 'api' ? ' · from your store' : ''}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="field">
                <div className="ag-label-row">
                  <label htmlFor="ag-info">Business info</label>
                  {data.business_info && f.info.trim() !== data.business_info && (
                    <button type="button" className="link-btn" onClick={() => set('info', data.business_info)}>Use the WhatsApp AI's business info</button>
                  )}
                </div>
                <textarea id="ag-info" className="textarea" rows={9} maxLength={6000} value={f.info} onChange={(e) => set('info', e.target.value)} placeholder={INFO_EXAMPLE} />
                <div className="hint">Opening hours, location, delivery, returns, payment, contact details: anything visitors ask. Short lines work best.</div>
              </div>
              <div className="field" style={{ marginBottom: 0, maxWidth: 260 }}>
                <label htmlFor="ag-tone">Tone</label>
                <select id="ag-tone" className="select" value={f.tone} onChange={(e) => set('tone', e.target.value)}>
                  {TONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <Icon.list style={{ width: 18, color: 'var(--brand-700)' }} />
              <div><h3>Quick questions</h3><div className="sub">Buttons under the welcome message, so visitors can start with one tap. Up to 4.</div></div>
            </div>
            <div className="card-pad ag-two">
              {f.suggestions.map((s, i) => (
                <input
                  key={i}
                  className="input"
                  maxLength={80}
                  value={s}
                  placeholder={`Question ${i + 1} (optional)`}
                  aria-label={`Quick question ${i + 1}`}
                  onChange={(e) => set('suggestions', f.suggestions.map((x, j) => (j === i ? e.target.value : x)))}
                />
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <Icon.chat style={{ width: 18, color: 'var(--brand-700)' }} />
              <div><h3>When it can't answer</h3><div className="sub">For orders, payments, complaints, or anything it doesn't know, it shows a "Chat on WhatsApp" button.</div></div>
            </div>
            <div className="card-pad">
              <div className="field" style={{ marginBottom: f.handoff.mode === 'number' ? 14 : 0 }}>
                <label htmlFor="ag-ho">WhatsApp button opens</label>
                <select id="ag-ho" className="select" value={f.handoff.mode} onChange={(e) => set('handoff', { ...f.handoff, mode: e.target.value })}>
                  <option value="default">{def ? `Your default number (+${def})` : 'Your default number (none linked yet)'}</option>
                  <option value="number">Another number…</option>
                  <option value="none">Don't show a WhatsApp button</option>
                </select>
                {f.handoff.mode === 'default' && !def && <div className="hint">Link a number on the WhatsApp Gateway page, or choose another number.</div>}
                {f.handoff.mode === 'none' && <div className="hint">It gives the contact details from your business info instead, if there are any.</div>}
              </div>
              {f.handoff.mode === 'number' && (
                <div className="field" style={{ marginBottom: 0, maxWidth: 320 }}>
                  <label htmlFor="ag-ho-phone">WhatsApp number (with country code)</label>
                  <input id="ag-ho-phone" className="input" inputMode="tel" placeholder="971501234567" value={f.handoff.phone} onChange={(e) => set('handoff', { ...f.handoff, phone: e.target.value })} />
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <Icon.globe style={{ width: 18, color: 'var(--brand-700)' }} />
              <div><h3>Websites</h3><div className="sub">Where this chat may show. Keeps other sites from using your agent.</div></div>
            </div>
            <div className="card-pad">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="ag-dom">Your website addresses (one per line)</label>
                <textarea id="ag-dom" className="textarea" rows={3} value={f.domains} onChange={(e) => set('domains', e.target.value)} placeholder={'yourshop.com\nshop.yourbrand.ae'} />
                <div className="hint">Subdomains are included (yourshop.com also allows www.yourshop.com and blog.yourshop.com). Leave empty to allow any website.</div>
              </div>
            </div>
          </div>
        </div>

        <div className="ag-side">
          <ChatPreview f={f} saved={saved} />
        </div>
      </div>

      {deleting && (
        <Modal
          title={`Delete "${saved.name}"?`}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(false)}>Cancel</button>
              <button className="btn danger" onClick={remove} disabled={busy}>{busy ? 'Deleting…' : 'Delete agent'}</button>
            </>
          }
        >
          <p className="dev-p">The chat button disappears from every website that uses this agent, and its {plural(saved.chats, 'website chat')} {saved.chats === 1 ? 'is' : 'are'} deleted too. You can't undo this.</p>
        </Modal>
      )}
    </div>
  );
}

// Right after creating an agent: its code, and where the guide is.
function CreatedModal({ agent, onClose, onGuide }) {
  return (
    <Modal
      title={`${agent.name} is ready`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Later</button>
          <button className="btn primary" onClick={onGuide}><Icon.book /> Open the step-by-step guide</button>
        </>
      }
    >
      <p className="dev-p">Paste this one line into your website, just before <code>&lt;/body&gt;</code>. The chat button then shows on every page.</p>
      <CodeBlock code={snippet(agent)} label="Your chat code" />
      <p className="dev-p" style={{ margin: 0 }}>Using WordPress, Shopify, Wix, Squarespace, Webflow or Google Tag Manager? The guide shows exactly where to paste it.</p>
    </Modal>
  );
}

// ---- Add to website (the guide) ----

function platformGuides(code, a) {
  const src = `${origin()}/widget.js`;
  return [
    {
      id: 'html',
      label: 'Any website',
      steps: [
        <>Open the HTML of your website. If every page shares a footer or template file, open that one, so the chat is on every page at once.</>,
        <>Find the closing <code>&lt;/body&gt;</code> tag near the end and paste the code just above it.</>,
        <>Save and upload the file to your hosting.</>,
      ],
      code: `    <!-- …your page… -->

    ${code}
  </body>
</html>`,
      codeLabel: 'index.html',
    },
    {
      id: 'wordpress',
      label: 'WordPress',
      steps: [
        <>The easy way, without touching theme files: in WordPress go to <strong>Plugins → Add New</strong>, search for <strong>WPCode</strong>, then click <strong>Install</strong> and <strong>Activate</strong>.</>,
        <>Open <strong>Code Snippets → Header &amp; Footer</strong>.</>,
        <>Paste the code in the <strong>Footer</strong> box and click <strong>Save Changes</strong>.</>,
        <>Using a cache plugin (WP Rocket, LiteSpeed, W3 Total Cache) or Cloudflare? Clear the cache so visitors get the new page.</>,
      ],
      note: <>Or in the theme: <strong>Appearance → Theme File Editor → footer.php</strong>, paste just above <code>&lt;/body&gt;</code>, click <strong>Update File</strong>. A theme update can remove it, so the plugin way is safer.</>,
    },
    {
      id: 'shopify',
      label: 'Shopify',
      steps: [
        <>In Shopify admin go to <strong>Online Store → Themes</strong>.</>,
        <>Next to your live theme, click <strong>⋯</strong> (three dots), then <strong>Edit code</strong>.</>,
        <>Under <strong>Layout</strong>, open <strong>theme.liquid</strong>.</>,
        <>Find <code>&lt;/body&gt;</code> near the end (Ctrl+F or Cmd+F), paste the code just above it, and click <strong>Save</strong>.</>,
      ],
      code: `    ${code}
  </body>
</html>`,
      codeLabel: 'layout/theme.liquid',
    },
    {
      id: 'wix',
      label: 'Wix',
      steps: [
        <>In your Wix dashboard open <strong>Settings</strong>, then <strong>Custom code</strong> (in the Advanced section).</>,
        <>Click <strong>+ Add Custom Code</strong> and paste the code.</>,
        <>Name it "AI chat", choose <strong>All pages</strong> (load code once) and place it in <strong>Body - end</strong>.</>,
        <>Click <strong>Apply</strong>. Custom code works on a published site with a connected domain (a Wix premium plan).</>,
      ],
    },
    {
      id: 'squarespace',
      label: 'Squarespace',
      steps: [
        <>Open <strong>Settings → Developer tools → Code injection</strong> (in older versions: <strong>Settings → Advanced → Code injection</strong>).</>,
        <>Paste the code in the <strong>Footer</strong> box.</>,
        <>Click <strong>Save</strong>. Code injection is only on Squarespace plans that include it.</>,
      ],
    },
    {
      id: 'webflow',
      label: 'Webflow',
      steps: [
        <>Open your project's <strong>Site settings → Custom code</strong>.</>,
        <>Paste the code in <strong>Footer code</strong> (before the <code>&lt;/body&gt;</code> tag) and click <strong>Save changes</strong>.</>,
        <><strong>Publish</strong> the site. Custom code needs a paid Webflow site plan.</>,
      ],
    },
    {
      id: 'gtm',
      label: 'Google Tag Manager',
      steps: [
        <>In your container go to <strong>Tags → New → Tag configuration → Custom HTML</strong>.</>,
        <>Paste the code.</>,
        <>Under <strong>Triggering</strong> choose <strong>All Pages</strong>, name the tag "AI chat" and click <strong>Save</strong>.</>,
        <>Click <strong>Submit</strong>, then <strong>Publish</strong>.</>,
      ],
    },
    {
      id: 'react',
      label: 'React / Next.js',
      steps: [
        <><strong>Next.js:</strong> add the script once in the root layout with <code>next/script</code>, so it loads on every page.</>,
        <><strong>React (Vite, Create React App):</strong> paste the code in <code>index.html</code> just above <code>&lt;/body&gt;</code>. Or add it once from your top component, as in the second example.</>,
      ],
      code: `// app/layout.js (Next.js)
import Script from 'next/script';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script src="${src}" data-agent="${a.pub_id}" strategy="lazyOnload" />
      </body>
    </html>
  );
}

// React: add it once, e.g. in App.jsx
useEffect(() => {
  const s = document.createElement('script');
  s.src = '${src}';
  s.async = true;
  s.dataset.agent = '${a.pub_id}';
  document.body.appendChild(s);
}, []);`,
      codeLabel: 'Next.js / React',
    },
  ];
}

function PlatformGuide({ code, a }) {
  const guides = platformGuides(code, a);
  const [id, setId] = useState(() => {
    try {
      return localStorage.getItem('pulse.agentPlatform') || 'html';
    } catch {
      return 'html';
    }
  });
  const g = guides.find((x) => x.id === id) || guides[0];
  const pick = (v) => {
    setId(v);
    try {
      localStorage.setItem('pulse.agentPlatform', v);
    } catch {}
  };
  return (
    <div className="ag-platforms">
      <div className="dev-langs ag-langs" role="tablist" aria-label="Website builder">
        {guides.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={g.id === x.id} className={g.id === x.id ? 'on' : ''} onClick={() => pick(x.id)}>{x.label}</button>
        ))}
      </div>
      <ol className="ag-howto">
        {g.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {g.note && <p className="dev-p ag-note">{g.note}</p>}
      {g.code && <CodeBlock code={g.code} label={g.codeLabel} />}
    </div>
  );
}

function InstallTab({ data, pick, setPick, onCreate, onEdit }) {
  const list = data.agents;
  if (!list.length) {
    return (
      <div className="card">
        <Empty icon="bot" title="Create an agent first" action={<button className="btn primary" onClick={onCreate}><Icon.plus /> Create an agent</button>}>
          Then copy its code here and paste it into your website.
        </Empty>
      </div>
    );
  }
  const a = list.find((x) => x.id === pick) || list[0];
  const code = snippet(a);
  const src = `${origin()}/widget.js`;
  return (
    <div className="dev-doc">
      <div className="card card-pad">
        <div className="ag-install-head">
          <div>
            <h3 className="dev-h3">Add the AI chat to your website</h3>
            <p className="dev-p">Copy one line of code and paste it into your website. A chat button appears in the bottom corner of every page, and visitors can ask {a.name} about your products, prices and anything in your business info.</p>
          </div>
          {list.length > 1 && (
            <div className="field ag-install-pick">
              <label htmlFor="ag-pick">Agent</label>
              <select id="ag-pick" className="select" value={a.id} onChange={(e) => setPick(e.target.value)}>
                {list.map((x) => <option key={x.id} value={x.id}>{x.name}{x.enabled ? '' : ' (off)'}</option>)}
              </select>
            </div>
          )}
        </div>
        <AiNotice data={data} />
        {!a.enabled && <div className="auth-error">{a.name} is turned off, so the chat button won't show. Turn it on in <button className="link-btn" onClick={() => onEdit(a.id)}>Agents → Edit</button>.</div>}

        <h4 className="dev-h4"><span className="dev-n">1</span> Copy your code</h4>
        <CodeBlock code={code} label={`Chat code for ${a.name}`} />

        <h4 className="dev-h4"><span className="dev-n">2</span> Paste it into your website</h4>
        <p className="dev-p">It goes just above the closing <code>&lt;/body&gt;</code> tag, on every page (or once in the shared footer). Pick your website builder:</p>
        <PlatformGuide code={code} a={a} />

        <h4 className="dev-h4"><span className="dev-n">3</span> Check it works</h4>
        <ul className="dev-list">
          <li>Open your website (refresh the page). A round chat button shows in the bottom {a.position === 'left' ? 'left' : 'right'} corner.</li>
          <li>Ask it something a customer would, like the price of one of your products. Every chat shows in <strong>Website chats</strong>.</li>
          <li>Not on your website yet? Open the preview page to see and try the real chat first.</li>
        </ul>
        <div className="ag-btn-row">
          <a className="btn" href={previewUrl(a)} target="_blank" rel="noreferrer"><Icon.globe /> Open the preview page</a>
          <button className="btn ghost" onClick={() => onEdit(a.id)}><Icon.edit /> Edit {a.name}</button>
        </div>
      </div>

      <div className="card card-pad">
        <h4 className="dev-h4">Which websites can show it</h4>
        {a.domains.length ? (
          <p className="dev-p">Only <strong>{a.domains.join(', ')}</strong> (and their subdomains). On any other website the chat stays hidden.</p>
        ) : (
          <p className="dev-p">Any website. To keep it on your own site only, add your website address under <button className="link-btn" onClick={() => onEdit(a.id)}>Websites</button> in the agent's settings.</p>
        )}
      </div>

      <div className="card card-pad">
        <h4 className="dev-h4">More options</h4>
        <p className="dev-p"><strong>Open the chat from your own button or link.</strong> Add <code>data-launcher="false"</code> to hide the round button, then call <code>ChatAgent.open()</code>:</p>
        <CodeBlock
          label="Your own chat button"
          code={`<script src="${src}" data-agent="${a.pub_id}" data-launcher="false" async></script>

<button onclick="ChatAgent.open()">Chat with us</button>`}
        />
        <div className="table-wrap">
          <table className="dev-table">
            <thead><tr><th>Option</th><th>What it does</th></tr></thead>
            <tbody>
              <tr><td><code>data-open="true"</code></td><td>Opens the chat when the page loads (not on phones).</td></tr>
              <tr><td><code>data-position="left"</code></td><td>Puts the button on the left on this website, whatever the agent is set to.</td></tr>
              <tr><td><code>data-launcher="false"</code></td><td>No round button. Open it with <code>ChatAgent.open()</code>.</td></tr>
              <tr><td><code>ChatAgent.open()</code> · <code>.close()</code> · <code>.toggle()</code></td><td>Open or close the chat from your own code.</td></tr>
              <tr><td><code>ChatAgent.send("Do you deliver?")</code></td><td>Opens the chat and asks this question for the visitor (for example from a product page button).</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <h4 className="dev-h4">If the chat button doesn't show</h4>
        <ul className="dev-list">
          <li><strong>Is the agent on?</strong> It must say <em>On</em> on the Agents tab.</li>
          <li><strong>Is your website allowed?</strong> If the agent has a Websites list, your address must be in it.</li>
          <li><strong>Look at the browser console</strong> (right-click → Inspect → Console). A line starting with <code>[chat]</code> says what's wrong.</li>
          <li><strong>Cache:</strong> clear your website's cache (cache plugin, Cloudflare) and refresh the page.</li>
          <li><strong>Strict security settings:</strong> if your site sends a Content-Security-Policy header, allow <code>{origin()}</code> in <code>script-src</code> and <code>connect-src</code>.</li>
          <li><strong>"The assistant can't answer right now"</strong> means the AI isn't working for this workspace (no AI key, or its free daily limit is used up). Check <em>Settings → AI</em>.</li>
        </ul>
      </div>
    </div>
  );
}

// ---- Website chats ----

function ChatView({ id, onClose, onDeleted }) {
  const { toast } = useApp();
  const [c, setC] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.get(`/agents/chats/${id}`).then((r) => live && setC(r)).catch((e) => {
      toast(e.message, 'error');
      onClose();
    });
    return () => {
      live = false;
    };
  }, [id]);
  async function remove() {
    if (!window.confirm('Delete this chat?')) return;
    setBusy(true);
    try {
      await api.del(`/agents/chats/${id}`);
      toast('Chat deleted', 'success');
      onDeleted();
    } catch (e) {
      toast(e.message, 'error');
      setBusy(false);
    }
  }
  return (
    <Modal
      title={c ? `Chat with ${c.agent_name}` : 'Chat'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost danger-text" onClick={remove} disabled={busy || !c}><Icon.trash /> Delete chat</button>
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      {!c ? (
        <Loading minHeight={200} />
      ) : (
        <>
          <div className="ag-chat-meta">
            <span>Started {timeAgo(c.started_at)}</span>
            <span>{plural(c.visitor_msgs, 'question')}</span>
            {c.handoff && <span className="badge green">Sent to WhatsApp</span>}
            {c.page && <span className="ag-chat-page" title={c.page}>On <a href={c.page} target="_blank" rel="noreferrer noopener">{c.page.replace(/^https?:\/\//, '').slice(0, 60)}</a></span>}
          </div>
          <div className="ag-thread">
            {c.list.map((m, i) => (
              <div key={i} className={`agp-msg ${m.role === 'visitor' ? 'v' : 'a'} ${m.failed ? 'failed' : ''}`}>
                <Rich text={m.text} />
                <div className="ag-thread-time">
                  {new Date(m.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                  {m.handoff ? ' · showed the WhatsApp button' : ''}
                  {m.failed ? ' · the AI could not answer' : ''}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function ChatsTab({ data }) {
  const { onBus, toast } = useApp();
  const [agent, setAgent] = useState('');
  const [onlyWa, setOnlyWa] = useState(false);
  const [res, setRes] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(
    async (more = false, prev = null) => {
      try {
        const q = new URLSearchParams({ limit: '50' });
        if (agent) q.set('agent', agent);
        if (onlyWa) q.set('handoff', '1');
        if (more && prev?.chats.length) q.set('before', prev.chats[prev.chats.length - 1].last_at);
        const r = await api.get(`/agents/chats?${q}`);
        setRes(more && prev ? { ...r, chats: [...prev.chats, ...r.chats] } : r);
      } catch (e) {
        toast(e.message, 'error');
        setRes((x) => x || { chats: [], total: 0, more: false });
      }
    },
    [agent, onlyWa]
  );
  useEffect(() => {
    setRes(null);
    load();
  }, [load]);
  useEffect(() => {
    let t = null;
    const off = onBus?.((ev) => {
      if (ev !== 'agent:chat') return;
      clearTimeout(t);
      t = setTimeout(() => load(), 1500);
    });
    return () => {
      clearTimeout(t);
      off?.();
    };
  }, [onBus, load]);

  return (
    <div className="card">
      <div className="card-head ag-chats-head">
        <Icon.chat style={{ width: 18, color: 'var(--brand-700)' }} />
        <div style={{ flex: 1, minWidth: 180 }}>
          <h3>Website chats</h3>
          <div className="sub">What visitors asked your agents{res ? ` · ${plural(res.total, 'chat')}` : ''} · kept {data.limits.keepDays} days</div>
        </div>
        {data.agents.length > 1 && (
          <select className="select ag-chats-filter" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
            <option value="">All agents</option>
            {data.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <label className="ag-check">
          <input type="checkbox" checked={onlyWa} onChange={(e) => setOnlyWa(e.target.checked)} /> Sent to WhatsApp only
        </label>
      </div>
      {!res ? (
        <Loading minHeight={200} />
      ) : res.chats.length === 0 ? (
        <Empty icon="chat" title={onlyWa ? 'No chats sent to WhatsApp' : 'No website chats yet'}>
          {data.agents.length ? 'When visitors chat with your agent on your website, the chats show here.' : 'Create an agent and add it to your website first.'}
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="dev-table ag-chats-table">
              <thead>
                <tr><th>Visitor asked</th><th>Agent</th><th>Questions</th><th>Last message</th></tr>
              </thead>
              <tbody>
                {res.chats.map((c) => (
                  <tr key={c.id} className="ag-chat-row" onClick={() => setOpen(c.id)} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' ? setOpen(c.id) : null)}>
                    <td className="cell-strong">
                      <div className="ag-ask">{c.first_text || '—'}</div>
                      {c.last_text && c.last_text !== c.first_text && <div className="cell-muted ag-ask">Last: {c.last_text}</div>}
                      {c.handoff && <span className="badge green ag-wa-badge">Sent to WhatsApp</span>}
                    </td>
                    <td>{c.agent_name}</td>
                    <td>{fmtNum(c.visitor_msgs)}</td>
                    <td className="cell-muted">{timeAgo(c.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.more && (
            <div className="ag-more"><button className="btn sm" onClick={() => load(true, res)}>Show older chats</button></div>
          )}
        </>
      )}
      {open && <ChatView id={open} onClose={() => setOpen(null)} onDeleted={() => { setOpen(null); load(); }} />}
    </div>
  );
}

// ---- The page ----

export default function Agents() {
  const { onBus, toast } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTabRaw] = useLocalTab();
  const [editing, setEditing] = useState(null); // null | 'new' | agent id
  const [pick, setPick] = useState(null); // the agent on "Add to website"
  const [created, setCreated] = useState(null);
  const [ver, setVer] = useState(0); // re-opens the editor fresh after a save
  const dirtyRef = useRef(false);
  const load = useCallback(async () => {
    try {
      setData(await api.get('/agents'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // New website chats update the counts a moment later.
  useEffect(() => {
    let t = null;
    const off = onBus?.((ev) => {
      if (ev !== 'agent:chat') return;
      clearTimeout(t);
      t = setTimeout(load, 2500);
    });
    return () => {
      clearTimeout(t);
      off?.();
    };
  }, [onBus, load]);

  // Leaving the editor with unsaved changes asks first.
  const leaveEditor = () => !dirtyRef.current || window.confirm('Leave without saving your changes?');
  const setTab = (t) => {
    if (editing && !leaveEditor()) return;
    dirtyRef.current = false;
    setEditing(null);
    setTabRaw(t);
  };
  const openInstall = (id) => {
    if (editing && !leaveEditor()) return;
    dirtyRef.current = false;
    setPick(id);
    setEditing(null);
    setTabRaw('install');
  };
  const edit = (id) => {
    setEditing(id);
    setTabRaw('agents');
  };

  if (error && !data) return <Empty icon="bot" title="Couldn't load AI Agents" action={<button className="btn" onClick={load}><Icon.refresh /> Try again</button>}>{error}</Empty>;
  if (!data) return <Loading />;
  return (
    <div className="dev-page">
      <TabBar tabs={TABS} tab={tab} setTab={setTab} />
      {tab === 'agents' &&
        (editing ? (
          <AgentEditor
            key={`${editing}:${ver}`}
            data={data}
            id={editing}
            dirtyRef={dirtyRef}
            onClose={() => setEditing(null)}
            onInstall={openInstall}
            onDeleted={() => {
              setEditing(null);
              load();
            }}
            onSaved={async (a, isNew) => {
              await load();
              if (isNew) {
                setEditing(null);
                setCreated(a);
              } else {
                toast('Saved. Your website shows the changes on the next page load.', 'success');
                setVer((v) => v + 1); // the saved settings are the new starting point
              }
            }}
          />
        ) : (
          <AgentsList data={data} onEdit={edit} onNew={() => edit('new')} onInstall={openInstall} />
        ))}
      {tab === 'install' && <InstallTab data={data} pick={pick} setPick={setPick} onCreate={() => edit('new')} onEdit={edit} />}
      {tab === 'chats' && <ChatsTab data={data} />}
      {created && (
        <CreatedModal
          agent={created}
          onClose={() => setCreated(null)}
          onGuide={() => {
            const id = created.id;
            setCreated(null);
            openInstall(id);
          }}
        />
      )}
    </div>
  );
}
