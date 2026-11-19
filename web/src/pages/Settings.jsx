import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Loading, Modal } from '../ui.jsx';

// picking a provider fills in its model (a Groq model name on Gemini fails with 404)
const DEFAULT_MODEL = { groq: 'openai/gpt-oss-20b', gemini: 'gemini-3.1-flash-lite', ollama: 'llama3.2', custom: '' };
const MODEL_HINTS = {
  groq: 'e.g. openai/gpt-oss-20b (fast) or openai/gpt-oss-120b (best). See console.groq.com for your models.',
  gemini: 'gemini-3.1-flash-lite (fast, recommended). If Gemini is busy or out of quota, replies use Groq instead.',
  ollama: 'e.g. llama3.2 — must be pulled first: ollama pull llama3.2',
  custom: 'the exact model name your endpoint expects',
};

function Toggle({ checked, onChange, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}

// A rule the super admin set for every workspace, shown under the field it limits.
export function Rule({ children }) {
  return (
    <div className="st-rule">
      <Icon.crown /> {children}
    </div>
  );
}

function Num({ value, onChange, suffix, width = 90, min, max }) {
  return (
    <div className="flex" style={{ gap: 6 }}>
      <input type="number" className="input" style={{ width }} value={value} min={min || undefined} max={max || undefined} onChange={(e) => onChange(+e.target.value)} />
      {suffix && <span className="muted" style={{ fontSize: 12 }}>{suffix}</span>}
    </div>
  );
}

export default function Settings() {
  const { toast, limits: L = {} } = useApp();
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);

  useEffect(() => {
    (async () => {
      setS(await api.get('/settings'));
      try {
        setAiStatus(await api.get('/ai/status'));
      } catch {}
    })();
  }, []);

  if (!s) return <Loading label="Loading settings…" minHeight={360} />;
  const set = (k, v) => setS((prev) => (typeof k === 'object' ? { ...prev, ...k } : { ...prev, [k]: v })); // set('key', v) or set({ several })

  async function save() {
    setSaving(true);
    try {
      const { _adjusted = [], ...saved } = await api.put('/settings', s);
      setS(saved); // what was really saved (kept inside the super admin's rules)
      toast(_adjusted.length ? `Saved — adjusted to the super admin's rules: ${_adjusted.join('; ')}` : 'Settings saved', _adjusted.length ? 'info' : 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    setSaving(false);
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.bolt style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Pacing &amp; limits</h3><div className="sub">Default rhythm for new campaigns</div></div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="setting-row">
            <div>
              <div className="st-label">Daily send cap</div>
              <div className="st-desc">Hard ceiling of messages per day across the account.</div>
              {L.maxPerNumberDay > 0 && <Rule>At most {L.maxPerNumberDay} campaign messages a day per number</Rule>}
            </div>
            <Num value={s.dailyLimit} onChange={(v) => set('dailyLimit', v)} suffix="msgs/day" max={L.maxPerNumberDay} />
          </div>
          <div className="setting-row">
            <div>
              <div className="st-label">Delay between messages</div>
              <div className="st-desc">Each send waits a random gap in this range — mimics human typing.</div>
              {L.minDelaySec > 0 && <Rule>At least {L.minDelaySec} seconds between messages</Rule>}
            </div>
            <div className="flex" style={{ gap: 8 }}>
              <Num value={s.minDelaySec} onChange={(v) => set('minDelaySec', v)} width={70} min={L.minDelaySec} />
              <span className="muted">to</span>
              <Num value={s.maxDelaySec} onChange={(v) => set('maxDelaySec', v)} suffix="sec" width={70} min={L.minDelaySec} />
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="st-label">Simulate typing</div>
              <div className="st-desc">Show "typing…" before each message for a natural feel.</div>
              {L.forceTyping && <Rule>Always on</Rule>}
            </div>
            <Toggle checked={s.typingSimulation || L.forceTyping} disabled={L.forceTyping} onChange={(v) => set('typingSimulation', v)} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.clock style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Sending window</h3><div className="sub">Only send during waking hours</div></div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="setting-row">
            <div>
              <div className="st-label">Active hours</div>
              <div className="st-desc">Messages only go out between these local times.</div>
              {(L.windowStart || L.windowEnd) && <Rule>Only between {L.windowStart || '00:00'} and {L.windowEnd || '23:59'}</Rule>}
            </div>
            <div className="flex" style={{ gap: 8 }}>
              <input type="time" className="input" style={{ width: 120 }} value={s.windowStart} min={L.windowStart || undefined} onChange={(e) => set('windowStart', e.target.value)} />
              <span className="muted">to</span>
              <input type="time" className="input" style={{ width: 120 }} value={s.windowEnd} max={L.windowEnd || undefined} onChange={(e) => set('windowEnd', e.target.value)} />
            </div>
          </div>
          <div className="setting-row">
            <div><div className="st-label">Timezone</div><div className="st-desc">IANA name, e.g. Asia/Karachi, Europe/London.</div></div>
            <input className="input" style={{ width: 200 }} value={s.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.shield style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Warm-up &amp; safety</h3><div className="sub">Protect a fresh number from bans</div></div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="setting-row">
            <div>
              <div className="st-label">Gradual warm-up</div>
              <div className="st-desc">Start low and ramp daily volume until the cap is reached.</div>
              {L.forceRamp && <Rule>Always on</Rule>}
            </div>
            <Toggle checked={s.warmupEnabled || L.forceRamp} disabled={L.forceRamp} onChange={(v) => set('warmupEnabled', v)} />
          </div>
          {s.warmupEnabled && (
            <div className="setting-row">
              <div><div className="st-label">Warm-up curve</div><div className="st-desc">Day-1 allowance, then increase this much each day.</div></div>
              <div className="flex" style={{ gap: 8 }}>
                <Num value={s.warmupStart} onChange={(v) => set('warmupStart', v)} suffix="start" width={70} />
                <span className="muted">+</span>
                <Num value={s.warmupStep} onChange={(v) => set('warmupStep', v)} suffix="/day" width={70} />
              </div>
            </div>
          )}
          <div className="setting-row">
            <div><div className="st-label">Handoff on reply</div><div className="st-desc">The instant a lead replies, pause automation and flag a human.</div></div>
            <Toggle checked={s.handoffOnReply} onChange={(v) => set('handoffOnReply', v)} />
          </div>
          <div className="setting-row">
            <div><div className="st-label">Opt-out keywords</div><div className="st-desc">Replies starting with these auto-unsubscribe the contact.</div></div>
            <input
              className="input"
              style={{ width: 260 }}
              value={(s.stopKeywords || []).join(', ')}
              onChange={(e) => set('stopKeywords', e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))}
            />
          </div>
        </div>
      </div>

      <AiCard s={s} set={set} status={aiStatus} />

      <div className="flex" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={save} disabled={saving}>
          <Icon.check /> {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

// ---- Product catalogs for AI answers ----
// Manual catalogs: products typed in here. API catalogs: synced from a product URL.
// Each WhatsApp number picks its catalog in Conversations → ⚙️ AI settings.
function ProductCatalogs() {
  const { toast } = useApp();
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null); // catalog being added/edited
  const [openCat, setOpenCat] = useState(null); // catalog whose products are open
  const [busy, setBusy] = useState('');
  const load = () => api.get('/catalogs').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
  }, []);
  async function sync(c) {
    setBusy(c.id);
    try {
      const r = await api.post(`/catalogs/${c.id}/sync`);
      toast(`"${c.name}": ${r.count} products synced`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy('');
    load();
  }
  async function remove(c) {
    if (!confirm(`Delete the catalog "${c.name}" and its ${c.count} products? Numbers using it will stop using it.`)) return;
    await api.del(`/catalogs/${c.id}`).catch((e) => toast(e.message, 'error'));
    load();
  }
  return (
    <div className="setting-row" style={{ display: 'block' }}>
      <div className="st-label" style={{ marginBottom: 4 }}>Product catalogs for AI answers</div>
      <div className="st-desc" style={{ marginBottom: 10 }}>
        Add your products by hand, or connect your store's product API. The AI looks up the products a customer asks
        about and answers with the real title, price, stock and link. Choose which catalog each WhatsApp number uses in
        <strong> Conversations → ⚙️ AI settings</strong>.
      </div>
      {!list ? (
        <Loading label="Loading catalogs…" minHeight={60} />
      ) : (
        <>
          {list.map((c) => (
            <div key={c.id} className="cat-row">
              <div className="cat-main">
                <div>
                  <strong>{c.name}</strong> <span className="chip">{c.type === 'api' ? 'API' : 'Manual'}</span>
                </div>
                <div className="st-desc">
                  {c.count} product{c.count === 1 ? '' : 's'}
                  {c.currency ? ` · ${c.currency}` : ''}
                  {c.type === 'api' && c.status?.at && !c.status?.error ? ` · synced ${new Date(c.status.at).toLocaleString()}` : ''}
                  {c.type === 'api' && c.live?.ok ? ' · price & stock checked live before each reply' : ''}
                  {c.status?.error ? <span style={{ color: '#e5484d' }}> · last sync failed: {c.status.error}</span> : null}
                </div>
                {c.type === 'api' && c.count > 0 && (!c.currency || c.no_link === c.count) && (
                  <div className="st-desc" style={{ color: '#b7791f' }}>
                    {[!c.currency && 'no currency set', c.no_link === c.count && 'no product links'].filter(Boolean).join(' · ')} — click Edit to add {!c.currency && c.no_link === c.count ? 'them' : 'it'} so the AI can quote prices and send links
                  </div>
                )}
              </div>
              <div className="cat-actions">
                <button className="btn sm" onClick={() => setOpenCat(c)}>Products</button>
                {c.type === 'api' && (
                  <button className="btn sm" onClick={() => sync(c)} disabled={busy === c.id}>
                    <Icon.refresh /> {busy === c.id ? 'Syncing…' : 'Sync'}
                  </button>
                )}
                <button className="btn sm" onClick={() => setEdit(c)}>Edit</button>
                <button className="btn sm" onClick={() => remove(c)} title="Delete catalog"><Icon.trash /></button>
              </div>
            </div>
          ))}
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setEdit({ name: '', type: 'manual', url: '', header: '', link: '', currency: '' })}>
            <Icon.plus /> Add catalog
          </button>
        </>
      )}
      {edit && <CatalogModal cat={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {openCat && <ProductsModal cat={openCat} onClose={() => { setOpenCat(null); load(); }} />}
    </div>
  );
}

function CatalogModal({ cat, onClose, onSaved }) {
  const { toast } = useApp();
  const [c, setC] = useState(cat);
  const [busy, setBusy] = useState(false);
  const isNew = !cat.id;
  async function save() {
    setBusy(true);
    try {
      const r = isNew ? await api.post('/catalogs', c) : await api.put(`/catalogs/${cat.id}`, c);
      if (r.sync?.error) toast(`Saved, but the sync failed: ${r.sync.error}`, 'error');
      else if (r.linkError) toast(`Saved, but the product link: ${r.linkError}`, 'error');
      else toast(r.sync ? `Saved — ${r.sync.count} products synced` : 'Catalog saved', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }
  return (
    <Modal
      title={isNew ? 'Add a product catalog' : `Edit "${cat.name}"`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Icon.check /> {busy ? 'Saving…' : 'Save'}</button></>}
    >
      <div className="field">
        <label>Name</label>
        <input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="e.g. Grabatoz UAE products" />
      </div>
      {isNew && (
        <div className="field">
          <label>Products come from</label>
          <select className="select" value={c.type} onChange={(e) => setC({ ...c, type: e.target.value })}>
            <option value="manual">I'll add them here (title, price, description…)</option>
            <option value="api">My store's product API / feed URL</option>
          </select>
        </div>
      )}
      {c.type === 'api' && (
        <>
          <div className="field">
            <label>Product API URL</label>
            <input className="input" value={c.url} onChange={(e) => setC({ ...c, url: e.target.value })} placeholder="https://your-store.com/api/products" />
            <div className="hint">Shopify <code>/products.json</code>, WooCommerce <code>/wp-json/wc/store/v1/products</code>, or any JSON product list. Synced now and every 30 minutes; price and stock are also checked live before the AI quotes a product (when your API gives one product at <code>…/products/&lt;id&gt;</code>).</div>
          </div>
          <div className="field">
            <label>API key header (optional)</label>
            <input className="input" value={c.header} onChange={(e) => setC({ ...c, header: e.target.value })} placeholder="Authorization: Bearer abc123" />
          </div>
          <div className="field">
            <label>Product page link (if your API doesn't send links)</label>
            <input className="input" value={c.link || ''} onChange={(e) => setC({ ...c, link: e.target.value })} placeholder="Paste the link of any one product on your website" />
            <div className="hint">
              Open any product on your site and paste its address — we work out the link for every product from it, so the
              AI can send customers the right page. Or type a pattern like <code>https://your-store.com/product/{'{slug}'}</code>.
            </div>
          </div>
        </>
      )}
      <div className="field">
        <label>Currency (used when a product doesn't say)</label>
        <input className="input" style={{ width: 140 }} value={c.currency} onChange={(e) => setC({ ...c, currency: e.target.value.toUpperCase() })} placeholder="AED" />
      </div>
    </Modal>
  );
}

const EMPTY_PRODUCT = { name: '', price: '', currency: '', in_stock: true, url: '', sku: '', brand: '', category: '', description: '' };

function ProductsModal({ cat, onClose }) {
  const { toast } = useApp();
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null); // product being added/edited
  const [probe, setProbe] = useState('');
  const [probeHits, setProbeHits] = useState(null); // { products, context }
  const manual = cat.type === 'manual';
  const load = () => api.get(`/catalogs/${cat.id}/products?q=${encodeURIComponent(q)}`).then(setItems).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q]);
  async function saveProduct() {
    try {
      if (form.id) await api.put(`/catalogs/${cat.id}/products/${form.id}`, form);
      else await api.post(`/catalogs/${cat.id}/products`, form);
      toast('Product saved', 'success');
      setForm(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function delProduct(p) {
    if (!confirm(`Delete "${p.name}"?`)) return;
    await api.del(`/catalogs/${cat.id}/products/${p.id}`).catch((e) => toast(e.message, 'error'));
    load();
  }
  async function runProbe() {
    try {
      setProbeHits(await api.get(`/catalogs/${cat.id}/search?q=${encodeURIComponent(probe)}`));
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  const price = (p) => (p.price != null ? `${p.currency || cat.currency || ''} ${Number(p.price).toLocaleString()}`.trim() : 'no price');
  return (
    <Modal wide title={`${cat.name} — products`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {form ? (
        <ProductForm p={form} setP={setForm} currency={cat.currency} onSave={saveProduct} onCancel={() => setForm(null)} />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input className="input" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} />
            {manual && (
              <button className="btn primary sm" onClick={() => setForm({ ...EMPTY_PRODUCT, currency: cat.currency || '' })}>
                <Icon.plus /> Add product
              </button>
            )}
          </div>
          {!manual && <div className="hint" style={{ marginBottom: 8 }}>Synced from the store's API — edit products in the store itself.</div>}
          <div className="prod-list">
            {!items ? (
              <Loading label="Loading…" minHeight={80} />
            ) : !items.length ? (
              <div className="st-desc" style={{ padding: 12 }}>{q ? 'No product matches.' : manual ? 'No products yet — add your first one.' : 'No products synced yet.'}</div>
            ) : (
              items.map((p) => (
                <div key={p.id} className="prod-row">
                  <div className="prod-main">
                    <strong>{p.name}</strong>
                    <div className="st-desc">
                      {price(p)} · {p.in_stock === false ? 'out of stock' : p.in_stock === true ? 'in stock' : 'stock unknown'}
                      {[p.brand, p.category, p.sku].filter(Boolean).length ? ` · ${[p.brand, p.category, p.sku].filter(Boolean).join(' · ')}` : ''}
                    </div>
                  </div>
                  {manual && (
                    <div className="cat-actions">
                      <button className="btn sm" onClick={() => setForm({ ...EMPTY_PRODUCT, ...p, price: p.price ?? '' })}>Edit</button>
                      <button className="btn sm" onClick={() => delProduct(p)}><Icon.trash /></button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label>Test: what would the AI find for a customer message?</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" value={probe} onChange={(e) => setProbe(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runProbe()} placeholder="e.g. muja pos ka bara ma batao" />
              <button className="btn sm" onClick={runProbe} disabled={!probe.trim()}>Test</button>
            </div>
            {probeHits && (
              <div className="hint" style={{ marginTop: 6 }}>
                {probeHits.context ? (
                  <>
                    AI would see:
                    <pre className="probe-out">{probeHits.context}</pre>
                  </>
                ) : (
                  "No product matched — the AI would say it doesn't have that here and flag the chat for you (Conversations → Needs human)."
                )}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function ProductForm({ p, setP, currency, onSave, onCancel }) {
  const f = (k) => ({ value: p[k] ?? '', onChange: (e) => setP({ ...p, [k]: e.target.value }) });
  return (
    <>
      <div className="field">
        <label>Product title *</label>
        <input className="input" {...f('name')} placeholder="e.g. Sunmi T2 POS Terminal" />
      </div>
      <div className="row">
        <div className="field" style={{ margin: 0 }}>
          <label>Price</label>
          <input className="input" type="number" min="0" step="0.01" {...f('price')} placeholder="2499" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Currency</label>
          <input className="input" value={p.currency || ''} onChange={(e) => setP({ ...p, currency: e.target.value.toUpperCase() })} placeholder={currency || 'AED'} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Stock</label>
          <select className="select" value={p.in_stock === true ? 'yes' : p.in_stock === false ? 'no' : 'unknown'} onChange={(e) => setP({ ...p, in_stock: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null })}>
            <option value="yes">In stock</option>
            <option value="no">Out of stock</option>
            <option value="unknown">Don't say</option>
          </select>
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label>Description</label>
        <textarea className="textarea" style={{ minHeight: 70 }} {...f('description')} placeholder="Key features the AI can mention" />
      </div>
      <div className="row">
        <div className="field" style={{ margin: 0 }}><label>Brand</label><input className="input" {...f('brand')} /></div>
        <div className="field" style={{ margin: 0 }}><label>Category</label><input className="input" {...f('category')} /></div>
        <div className="field" style={{ margin: 0 }}><label>SKU / model</label><input className="input" {...f('sku')} /></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label>Product link</label>
        <input className="input" {...f('url')} placeholder="https://your-store.com/p/sunmi-t2" />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel}>Back</button>
        <button className="btn primary" onClick={onSave} disabled={!String(p.name || '').trim()}><Icon.check /> Save product</button>
      </div>
    </>
  );
}

function AiCard({ s, set, status }) {
  const { toast } = useApp();
  const [sample, setSample] = useState('');
  const [testing, setTesting] = useState(false);
  const configured = status?.available;

  async function preview() {
    setTesting(true);
    setSample('');
    try {
      const r = await api.post('/ai/rewrite', {
        text: 'Hi {{first_name}}, just checking if you are still interested in our offer. Reply STOP to opt out.',
        tone: s.aiTone,
      });
      setSample(r.text);
    } catch (e) {
      toast(e.message, 'error');
    }
    setTesting(false);
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        <Icon.sparkles style={{ width: 18, color: 'var(--brand-700)' }} />
        <div>
          <h3>AI message variation</h3>
          <div className="sub">Rewrite every send uniquely so your number stays safe</div>
        </div>
        <span
          className={`badge ${status?.blocked ? 'red' : configured ? 'green' : 'amber'}`}
          style={{ marginLeft: 'auto' }}
        >
          {status?.blocked ? 'Off — super admin' : configured ? '● Connected' : 'Not configured'}
        </span>
      </div>
      <div className="card-pad" style={{ paddingTop: 4 }}>
        {status?.blocked && (
          <div className="auth-note" style={{ marginBottom: 4 }}>
            The super admin has switched AI off for every workspace. Messages go out as written, and chats are answered by people.
          </div>
        )}
        {!configured && !status?.blocked && (
          <div className="auth-note" style={{ marginBottom: 4 }}>
            {s.aiProvider === 'ollama' ? (
              <>
                Start a local Ollama server (<code>ollama serve</code>) and pull a model
                (e.g. <code>ollama pull llama3.2</code>). No key needed.
              </>
            ) : (
              <>
                {s.aiProvider === 'gemini' ? (
                  <>Add your key to <code>.env</code> as <code>GEMINI_API_KEY=…</code> and restart the server. Get one at <code>aistudio.google.com/apikey</code>.</>
                ) : (
                  <>Add your free key to <code>.env</code> as <code>AI_API_KEY=…</code> and restart
                  the server. Get a free Groq key (no card) at <code>console.groq.com/keys</code>.</>
                )}
              </>
            )}
          </div>
        )}
        <div className="setting-row">
          <div>
            <div className="st-label">Rewrite each message with AI</div>
            <div className="st-desc">
              Every recipient gets a unique, human-sounding version of your template — the strongest
              defense against spam detection. Falls back to the original if AI is unavailable.
            </div>
          </div>
          <Toggle checked={s.aiEnabled} onChange={(v) => set('aiEnabled', v)} />
        </div>
        <div className="setting-row">
          <div>
            <div className="st-label">Provider</div>
            <div className="st-desc">Groq is free & fast. Gemini (key in <code>.env</code> as <code>GEMINI_API_KEY</code>) answers Arabic better. Ollama runs locally (no key).</div>
          </div>
          <select className="select" style={{ width: 240 }} value={s.aiProvider || 'groq'} onChange={(e) => set({ aiProvider: e.target.value, aiModel: DEFAULT_MODEL[e.target.value] ?? '' })}>
            <option value="groq">Groq — free & fast (recommended)</option>
            <option value="gemini">Google Gemini — free key</option>
            <option value="ollama">Ollama — 100% local</option>
            <option value="custom">Custom endpoint</option>
          </select>
        </div>
        {s.aiProvider === 'custom' && (
          <div className="setting-row" style={{ display: 'block' }}>
            <div className="st-label" style={{ marginBottom: 8 }}>Custom base URL (OpenAI-compatible)</div>
            <input className="input" placeholder="https://your-endpoint/v1" value={s.aiBaseUrl || ''} onChange={(e) => set('aiBaseUrl', e.target.value)} />
          </div>
        )}
        <div className="setting-row">
          <div>
            <div className="st-label">Model</div>
            <div className="st-desc">{MODEL_HINTS[s.aiProvider] || MODEL_HINTS.groq}</div>
          </div>
          <input className="input" style={{ width: 260 }} value={s.aiModel || ''} placeholder="openai/gpt-oss-120b" onChange={(e) => set('aiModel', e.target.value)} />
        </div>
        <div className="setting-row">
          <div>
            <div className="st-label">Tone</div>
            <div className="st-desc">How the rewritten messages should sound.</div>
          </div>
          <select className="select" style={{ width: 180 }} value={s.aiTone} onChange={(e) => set('aiTone', e.target.value)}>
            <option value="friendly">Friendly</option>
            <option value="professional">Professional</option>
            <option value="casual">Casual</option>
            <option value="enthusiastic">Enthusiastic</option>
          </select>
        </div>
        <div className="setting-row" style={{ display: 'block' }}>
          <div className="st-label" style={{ marginBottom: 8 }}>Extra guidance (optional)</div>
          <textarea
            className="textarea"
            style={{ minHeight: 70 }}
            placeholder="e.g. Always mention we're a local Karachi business. Never over-promise."
            value={s.aiInstructions || ''}
            onChange={(e) => set('aiInstructions', e.target.value)}
          />
        </div>

        {configured && (
          <>
            <div className="setting-row">
              <div>
                <div className="st-label">Auto-reply to incoming messages ✨</div>
                <div className="st-desc">
                  When a lead replies, AI answers automatically using the chat history. Falls back to a
                  human handoff if AI can't respond.
                </div>
              </div>
              <Toggle checked={s.autoReplyEnabled} onChange={(v) => set('autoReplyEnabled', v)} />
            </div>
            {s.autoReplyEnabled && (
              <div className="setting-row" style={{ display: 'block' }}>
                <div className="st-label" style={{ marginBottom: 8 }}>Auto-reply guidance (business context)</div>
                <textarea
                  className="textarea"
                  style={{ minHeight: 90 }}
                  placeholder="e.g. We're Tech Solutionor, an electronics store in Karachi. Answer product & delivery questions politely. For prices or orders you're unsure about, say a team member will follow up."
                  value={s.autoReplyInstructions || ''}
                  onChange={(e) => set('autoReplyInstructions', e.target.value)}
                />
              </div>
            )}

          </>
        )}
        {configured && <ProductCatalogs />}
        {configured && (
          <div style={{ marginTop: 14 }}>
            <button className="btn sm" onClick={preview} disabled={testing}>
              <Icon.sparkles /> {testing ? 'Generating…' : 'Preview a variation'}
            </button>
            {sample && (
              <div className="phone" style={{ marginTop: 12, minHeight: 0 }}>
                <div className="bubble out" style={{ maxWidth: '100%' }}>{sample}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
