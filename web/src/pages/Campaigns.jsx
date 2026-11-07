import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Empty, Loading, StatusBadge } from '../ui.jsx';

export default function Campaigns() {
  const { toast, refreshStats } = useApp();
  const [list, setList] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const load = async () => {
    try {
      setList(await api.get('/campaigns'));
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  async function action(c, verb) {
    try {
      await api.post(`/campaigns/${c.id}/${verb}`);
      toast(`Campaign ${verb === 'start' ? 'started' : 'paused'}`, 'success');
      load();
      refreshStats();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function remove(c) {
    if (!confirm(`Delete campaign "${c.name}"? This removes its queue.`)) return;
    await api.del('/campaigns/' + c.id);
    toast('Campaign deleted');
    load();
  }
  async function rebuild(c) {
    const r = await api.post(`/campaigns/${c.id}/rebuild`);
    toast(`Audience rescanned · ${r.progress.total} recipients`, 'success');
    load();
  }

  return (
    <>
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn primary" onClick={() => setShowNew(true)}>
          <Icon.plus /> New campaign
        </button>
      </div>

      {!loaded ? (
        <div className="card">
          <Loading label="Loading campaigns…" />
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          <Empty
            icon="megaphone"
            title="No campaigns yet"
            action={<button className="btn primary" onClick={() => setShowNew(true)}><Icon.plus /> Create campaign</button>}
          >
            A campaign sends a template to a slice of your audience — paced, within a daily window, with auto human-handoff on replies.
          </Empty>
        </div>
      ) : (
        <div className="grid-cards">
          {list.map((c) => (
            <div className="camp-card" key={c.id}>
              <div className="flex between">
                <StatusBadge status={c.status} />
                <div className="flex" style={{ gap: 4 }}>
                  {c.status === 'running' ? (
                    <button className="btn warn sm" onClick={() => action(c, 'pause')}><Icon.pause /> Pause</button>
                  ) : c.status === 'scheduled' ? (
                    <>
                      <button className="btn primary sm" onClick={() => action(c, 'start')}><Icon.play /> Start now</button>
                      <button className="btn sm" title="Cancel schedule" onClick={() => action(c, 'pause')}><Icon.x /></button>
                    </>
                  ) : c.status === 'completed' ? (
                    <button className="btn sm" onClick={() => rebuild(c)}><Icon.refresh /></button>
                  ) : (
                    <button className="btn primary sm" onClick={() => action(c, 'start')}><Icon.play /> Start</button>
                  )}
                  <button className="btn ghost sm" onClick={() => remove(c)}><Icon.trash /></button>
                </div>
              </div>

              <h3 style={{ margin: '12px 0 4px', fontSize: 17 }}>{c.name}</h3>
              <div className="muted" style={{ fontSize: 12.5 }}>
                <Icon.template style={{ width: 13, verticalAlign: '-2px' }} /> {c.template_name || 'No template'}
                {c.list_name ? <> · <span className="chip">{c.list_name}</span></> : c.audience_filter ? <> · tag: <span className="chip">{c.audience_filter}</span></> : null}
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                <Icon.gateway style={{ width: 13, verticalAlign: '-2px' }} /> from{' '}
                {c.sender?.phone ? `+${c.sender.phone}` : c.sender ? c.sender.label : 'main number'}
                {c.ai_rewrite && <> · <span className="badge green" style={{ padding: '1px 7px' }}>AI</span></>}
              </div>
              <div className="muted" style={{ fontSize: 12.5, margin: '6px 0 12px' }}>
                <Icon.clock style={{ width: 13, verticalAlign: '-2px' }} /> {c.window_start}–{c.window_end} · {c.daily_limit}/day · ~{c.min_delay_sec}-{c.max_delay_sec}s gap
              </div>
              {c.status === 'scheduled' && c.scheduled_at && (
                <div style={{ fontSize: 12.5, margin: '0 0 12px', color: '#1d4ed8', fontWeight: 600 }}>
                  <Icon.clock style={{ width: 13, verticalAlign: '-2px' }} /> Starts {new Date(c.scheduled_at).toLocaleString()}
                </div>
              )}

              <div className="flex between" style={{ fontSize: 12, marginBottom: 6 }}>
                <span className="muted">Delivery</span>
                <span className="muted">{c.progress.done}/{c.progress.total} · {c.progress.percent}%</span>
              </div>
              <div className="progress"><span style={{ width: `${c.progress.percent}%` }} /></div>

              <div className="mini-stats">
                <div className="mini-stat"><div className="v">{c.progress.queued}</div><div className="l">Queued</div></div>
                <div className="mini-stat"><div className="v" style={{ color: 'var(--brand-700)' }}>{c.progress.sent}</div><div className="l">Sent</div></div>
                <div className="mini-stat"><div className="v" style={{ color: 'var(--info)' }}>{c.progress.replied}</div><div className="l">Replies</div></div>
                <div className="mini-stat"><div className="v" style={{ color: 'var(--danger)' }}>{c.progress.failed}</div><div className="l">Failed</div></div>
              </div>
              {(c.progress.delivered > 0 || c.progress.read > 0) && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8, display: 'flex', gap: 14 }}>
                  <span><span style={{ color: '#53bdeb' }}>✓✓</span> {c.progress.delivered} delivered</span>
                  <span><span style={{ color: '#53bdeb' }}>✓✓</span> {c.progress.read} read</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showNew && <NewCampaign onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
    </>
  );
}

function NewCampaign({ onClose, onSaved }) {
  const { toast } = useApp();
  const [templates, setTemplates] = useState([]);
  const [lists, setLists] = useState([]);
  const [settings, setSettings] = useState({});
  const [aiStatus, setAiStatus] = useState(null);
  const [senders, setSenders] = useState([]); // connected warm-up numbers usable as senders
  const [estimate, setEstimate] = useState(null);
  const [f, setF] = useState({
    name: '',
    template_id: '',
    audience_filter: '',
    audience_list_id: '',
    sender_id: '',
    schedule_when: '',
    daily_limit: 150,
    window_start: '09:00',
    window_end: '21:00',
    timezone: 'Asia/Karachi',
    min_delay_sec: 35,
    max_delay_sec: 90,
    ai_rewrite: false,
    ai_tone: 'friendly',
  });

  useEffect(() => {
    (async () => {
      const [t, ls, s] = await Promise.all([
        api.get('/templates'),
        api.get('/lists'),
        api.get('/settings'),
      ]);
      setTemplates(t);
      setLists(ls);
      setSettings(s);
      setF((x) => ({
        ...x,
        daily_limit: s.dailyLimit ?? 150,
        window_start: s.windowStart ?? '09:00',
        window_end: s.windowEnd ?? '21:00',
        timezone: s.timezone ?? 'Asia/Karachi',
        min_delay_sec: s.minDelaySec ?? 35,
        max_delay_sec: s.maxDelaySec ?? 90,
        ai_rewrite: s.aiEnabled ?? false,
        ai_tone: s.aiTone ?? 'friendly',
      }));
      try {
        setAiStatus(await api.get('/ai/status'));
      } catch {}
      try {
        const w = await api.get('/warmup/status');
        setSenders((w.accounts || []).filter((a) => a.status === 'connected' && a.me?.phone));
      } catch {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams({ status: 'active', limit: '1' });
      if (f.audience_list_id) params.set('list', f.audience_list_id);
      const r = await api.get('/contacts?' + params);
      setEstimate(r.total ?? (Array.isArray(r) ? r.length : 0));
    })();
  }, [f.audience_list_id]);

  const [step, setStep] = useState(1);
  const STEPS = ['Basics', 'Sending', 'Pacing'];

  function validateStep(s) {
    if (s === 1) {
      if (!f.name.trim()) { toast('Name your campaign', 'error'); return false; }
      if (!f.template_id) { toast('Pick a template', 'error'); return false; }
    }
    if (s === 2) {
      if (f.schedule_when && new Date(f.schedule_when).getTime() <= Date.now()) {
        toast('Pick a future date & time', 'error'); return false;
      }
    }
    return true;
  }
  const next = () => { if (validateStep(step)) setStep((s) => Math.min(3, s + 1)); };
  const back = () => setStep((s) => Math.max(1, s - 1));

  async function save() {
    if (!validateStep(1)) { setStep(1); return; }
    if (!validateStep(2)) { setStep(2); return; }
    try {
      const payload = { ...f, template_id: f.template_id };
      delete payload.schedule_when;
      if (f.schedule_when) payload.scheduled_at = new Date(f.schedule_when).toISOString();
      await api.post('/campaigns', payload);
      toast(
        f.schedule_when ? 'Campaign scheduled ✓' : 'Campaign created (draft) — press Start when ready',
        'success'
      );
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  const templateName = templates.find((t) => t.id === f.template_id)?.name || '—';
  const senderObj = f.sender_id ? senders.find((a) => a.id === f.sender_id) : null;
  const senderLabel = senderObj ? `+${senderObj.me.phone}` : 'Main number (Gateway)';
  const listName = f.audience_list_id ? lists.find((l) => l.id === f.audience_list_id)?.name || '—' : 'All active contacts';

  return (
    <Modal
      title="New campaign"
      onClose={onClose}
      wide
      footer={
        <>
          {step > 1
            ? <button className="btn" onClick={back}><Icon.chevronDown style={{ width: 15, transform: 'rotate(90deg)' }} /> Back</button>
            : <button className="btn" onClick={onClose}>Cancel</button>}
          <span style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>Step {step} of 3</span>
          {step < 3
            ? <button className="btn primary" onClick={next}>Next <Icon.chevronDown style={{ width: 15, transform: 'rotate(-90deg)' }} /></button>
            : <button className="btn primary" onClick={save}><Icon.check /> Create campaign</button>}
        </>
      }
    >
      <div className="stepper">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const cls = step === n ? 'active' : step > n ? 'done' : '';
          return (
            <Fragment key={label}>
              {i > 0 && <div className={`step-line ${step > i ? 'done' : ''}`} />}
              <button className={`step ${cls}`} onClick={() => n < step && setStep(n)}>
                <span className="step-num">{step > n ? <Icon.check /> : n}</span>
                <span className="step-label">{label}</span>
              </button>
            </Fragment>
          );
        })}
      </div>

      {/* STEP 1 — Basics: what to send & who to */}
      {step === 1 && (
        <>
          <div className="field">
            <label>Campaign name</label>
            <input className="input" value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="October outreach" />
          </div>
          <div className="field">
            <label>Template</label>
            <select className="select" value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value })}>
              <option value="">Select a template…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {templates.length === 0 && <div className="hint">Create a template first.</div>}
          </div>
          <div className="field">
            <label>Send to list</label>
            <select className="select" value={f.audience_list_id} onChange={(e) => setF({ ...f, audience_list_id: e.target.value })}>
              <option value="">All active contacts</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.count})</option>)}
            </select>
            {estimate != null && <div className="hint">≈ {estimate} recipients will be queued.</div>}
            {lists.length === 0 && <div className="hint">No lists yet — make one in Contacts → Lists, or leave as “All active contacts”.</div>}
          </div>
        </>
      )}

      {/* STEP 2 — Sending: which number, when, AI */}
      {step === 2 && (
        <>
          <div className="field">
            <label>Send from</label>
            <select className="select" value={f.sender_id} onChange={(e) => setF({ ...f, sender_id: e.target.value })}>
              <option value="">Main number (WhatsApp Gateway)</option>
              {senders.map((a) => (
                <option key={a.id} value={a.id}>
                  +{a.me.phone}{a.label ? ` — ${a.label}` : ''} (warmed number)
                </option>
              ))}
            </select>
            <div className="hint">
              {senders.length
                ? 'Pick a warmed-up number to send this campaign from, or use your main number.'
                : 'Connect numbers in Warmup to send campaigns from them. Using your main number for now.'}
            </div>
          </div>

          <div className="field">
            <label><Icon.clock style={{ width: 13, verticalAlign: '-2px' }} /> Schedule start (optional)</label>
            <input type="datetime-local" className="input" value={f.schedule_when} onChange={(e) => setF({ ...f, schedule_when: e.target.value })} />
            <div className="hint">
              {f.schedule_when ? 'The campaign will auto-start at this time.' : 'Leave empty to start it manually with the Start button.'}
            </div>
          </div>

          <div className="card" style={{ background: 'var(--surface-2)', padding: 16, marginBottom: 6, border: 'none' }}>
            <div className="flex between" style={{ marginBottom: f.ai_rewrite ? 12 : 0 }}>
              <div className="flex" style={{ gap: 8 }}>
                <Icon.sparkles style={{ width: 16, color: 'var(--brand-700)' }} />
                <div>
                  <strong style={{ fontSize: 13 }}>AI rewrite each message</strong>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    Every recipient gets a unique variation — strongest anti-ban protection.
                  </div>
                </div>
              </div>
              {aiStatus?.available ? (
                <label className="switch">
                  <input type="checkbox" checked={!!f.ai_rewrite} onChange={(e) => setF({ ...f, ai_rewrite: e.target.checked })} />
                  <span className="slider" />
                </label>
              ) : (
                <span className="badge amber" title="Add an API key in Settings → AI">off</span>
              )}
            </div>
            {f.ai_rewrite && aiStatus?.available && (
              <div className="field" style={{ margin: 0 }}>
                <label>Tone</label>
                <select className="select" value={f.ai_tone} onChange={(e) => setF({ ...f, ai_tone: e.target.value })}>
                  <option value="friendly">Friendly</option>
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                  <option value="enthusiastic">Enthusiastic</option>
                </select>
              </div>
            )}
            {!aiStatus?.available && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                Connect an Anthropic API key in <strong>Settings → AI</strong> to enable this.
              </div>
            )}
          </div>
        </>
      )}

      {/* STEP 3 — Pacing: safe sending + review */}
      {step === 3 && (
        <>
          <div className="review">
            <div><span>Template</span><strong>{templateName}</strong></div>
            <div><span>Audience</span><strong>{listName + (estimate != null ? ` · ≈${estimate}` : '')}</strong></div>
            <div><span>Send from</span><strong>{senderLabel}</strong></div>
            <div><span>Start</span><strong>{f.schedule_when ? new Date(f.schedule_when).toLocaleString() : 'Manual'}</strong></div>
            <div><span>AI rewrite</span><strong>{f.ai_rewrite && aiStatus?.available ? `On · ${f.ai_tone}` : 'Off'}</strong></div>
          </div>

          <div className="card" style={{ background: 'var(--surface-2)', padding: 16, margin: '0 0 6px', border: 'none' }}>
            <div className="flex" style={{ gap: 8, marginBottom: 12 }}>
              <Icon.shield style={{ width: 16, color: 'var(--brand-700)' }} />
              <strong style={{ fontSize: 13 }}>Safe pacing (anti-ban)</strong>
            </div>
            <div className="row">
              <div className="field" style={{ margin: 0 }}>
                <label>Daily limit</label>
                <input type="number" className="input" value={f.daily_limit} onChange={(e) => setF({ ...f, daily_limit: +e.target.value })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Min gap (sec)</label>
                <input type="number" className="input" value={f.min_delay_sec} onChange={(e) => setF({ ...f, min_delay_sec: +e.target.value })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Max gap (sec)</label>
                <input type="number" className="input" value={f.max_delay_sec} onChange={(e) => setF({ ...f, max_delay_sec: +e.target.value })} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Window start</label>
                <input type="time" className="input" value={f.window_start} onChange={(e) => setF({ ...f, window_start: e.target.value })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Window end</label>
                <input type="time" className="input" value={f.window_end} onChange={(e) => setF({ ...f, window_end: e.target.value })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Timezone</label>
                <input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
              </div>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
