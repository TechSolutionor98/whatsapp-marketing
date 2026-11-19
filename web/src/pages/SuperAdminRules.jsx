import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Loading } from '../ui.jsx';

// Super Admin → "Rules & controls" and "New workspace settings".

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" aria-label={label} checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}
function Num({ value, onChange, suffix, width = 90, min, label }) {
  return (
    <div className="flex" style={{ gap: 6 }}>
      <input type="number" aria-label={label} className="input" style={{ width }} value={value ?? ''} min={min ?? 0} onChange={(e) => onChange(e.target.value === '' ? '' : +e.target.value)} />
      {suffix && <span className="muted" style={{ fontSize: 12 }}>{suffix}</span>}
    </div>
  );
}
function Row({ label, desc, children }) {
  return (
    <div className="setting-row">
      <div>
        <div className="st-label">{label}</div>
        {desc && <div className="st-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}
function Section({ icon, title, sub, children }) {
  const I = Icon[icon];
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        <I style={{ width: 18, color: 'var(--brand-700)' }} />
        <div><h3>{title}</h3>{sub && <div className="sub">{sub}</div>}</div>
      </div>
      <div className="card-pad sa-rows">{children}</div>
    </div>
  );
}

// ---- Rules for every workspace ----
export function RulesPanel({ onSaved }) {
  const { toast, refreshAuth } = useApp();
  const [L, setL] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get('/admin/rules').then((r) => setL(r.limits)).catch((e) => toast(e.message, 'error'));
  }, []);
  if (!L) return <Loading label="Loading rules…" minHeight={200} />;
  const set = (k, v) => setL((x) => ({ ...x, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      const r = await api.put('/admin/limits', L);
      setL(r.limits);
      const f = r.fixed || {};
      toast(
        `Rules saved for every workspace${f.settings || f.campaigns ? ` — brought ${f.settings} workspace setting${f.settings === 1 ? '' : 's'} and ${f.campaigns} campaign value${f.campaigns === 1 ? '' : 's'} inside them` : ''}`,
        'success'
      );
      refreshAuth(); // the pages show the new rules
      onSaved?.();
    } catch (e) {
      toast(e.message, 'error');
    }
    setSaving(false);
  }

  return (
    <div className="sa-rules">
      <div className="sa-explain">
        <Icon.crown /> These rules apply to <strong>every workspace</strong>. Nobody can set a value outside them — the
        Settings page and campaigns are kept inside, and campaigns that are already running follow them at once. 0 or empty = no limit.
      </div>

      <Section icon="send" title="Campaign sending" sub="Keep every number safe from bans">
        <Row label="Minimum gap between messages" desc="Each number waits at least this long between two campaign messages.">
          <Num label="Minimum gap" value={L.minDelaySec} onChange={(v) => set('minDelaySec', v)} suffix="sec" />
        </Row>
        <Row label="Maximum messages a day, per number" desc="Campaign messages one WhatsApp number may send in a day. Replies to chats don't count.">
          <Num label="Maximum a day" value={L.maxPerNumberDay} onChange={(v) => set('maxPerNumberDay', v)} suffix="msgs/day" />
        </Row>
        <Row label="Allowed sending hours" desc="Campaigns never send outside these hours (in each campaign's time zone).">
          <div className="flex" style={{ gap: 8 }}>
            <input type="time" aria-label="Earliest" className="input" style={{ width: 120 }} value={L.windowStart || ''} onChange={(e) => set('windowStart', e.target.value)} />
            <span className="muted">to</span>
            <input type="time" aria-label="Latest" className="input" style={{ width: 120 }} value={L.windowEnd || ''} onChange={(e) => set('windowEnd', e.target.value)} />
            {(L.windowStart || L.windowEnd) && <button className="btn sm ghost" onClick={() => setL((x) => ({ ...x, windowStart: '', windowEnd: '' }))}>Any time</button>}
          </div>
        </Row>
        <Row label='Always show "typing…"' desc="Every campaign message shows typing first — workspaces can't turn it off.">
          <Toggle label="Always typing" checked={L.forceTyping} onChange={(v) => set('forceTyping', v)} />
        </Row>
        <Row label="Always ramp up new numbers" desc="A fresh number's daily volume always starts low and grows each day — workspaces can't turn it off.">
          <Toggle label="Always ramp up" checked={L.forceRamp} onChange={(v) => set('forceRamp', v)} />
        </Row>
      </Section>

      <Section icon="flame" title="Warm-up" sub="Numbers chatting with each other">
        <Row label="Maximum warm-up messages a day" desc="Per workspace.">
          <Num label="Warm-up maximum" value={L.warmupMaxPerDay} onChange={(v) => set('warmupMaxPerDay', v)} suffix="a day" />
        </Row>
        <Row label="Minimum gap between warm-up chats">
          <Num label="Warm-up gap" value={L.warmupMinGap} onChange={(v) => set('warmupMinGap', v)} suffix="sec" />
        </Row>
      </Section>

      <Section icon="briefcase" title="Workspace size" sub="What one business may have">
        <Row label="WhatsApp numbers per workspace" desc="Including warm-up numbers. Linking one more is refused once reached.">
          <Num label="Numbers per workspace" value={L.maxNumbers} onChange={(v) => set('maxNumbers', v)} suffix="numbers" />
        </Row>
        <Row label="People per workspace" desc="Team members a workspace can have.">
          <Num label="People per workspace" value={L.maxTeam} onChange={(v) => set('maxTeam', v)} suffix="people" />
        </Row>
      </Section>

      <Section icon="sparkles" title="AI" sub="Message variation, AI replies and AI warm-up chats">
        <Row label="Workspaces may use AI" desc={L.allowAi ? 'On — each workspace switches AI on or off for itself.' : 'Off — no workspace can use AI. Messages go out as written and chats are answered by people.'}>
          <Toggle label="Allow AI" checked={L.allowAi} onChange={(v) => set('allowAi', v)} />
        </Row>
      </Section>

      <div className="flex" style={{ justifyContent: 'flex-end', marginBottom: 18 }}>
        <button className="btn primary" onClick={save} disabled={saving}>
          <Icon.check /> {saving ? 'Saving…' : 'Save rules for every workspace'}
        </button>
      </div>
    </div>
  );
}

// ---- Settings every new workspace starts with ----
export function DefaultsPanel({ workspaces }) {
  const { toast } = useApp();
  const [d, setD] = useState(null);
  const [L, setL] = useState({});
  const [from, setFrom] = useState('');
  const [saving, setSaving] = useState('');
  useEffect(() => {
    api.get('/admin/rules').then((r) => { setD(r.defaults); setL(r.limits); }).catch((e) => toast(e.message, 'error'));
  }, []);
  if (!d) return <Loading label="Loading settings…" minHeight={200} />;
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));

  async function copyFrom() {
    if (!from) return;
    try {
      const s = await api.get(`/admin/workspaces/${from}/settings`);
      setD((x) => ({ ...x, ...s }));
      toast(`Copied from ${workspaces.find((w) => w.id === from)?.name} — press Save to keep it`);
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function save(applyAll) {
    if (applyAll && !confirm(`Give ALL ${workspaces.length} existing workspaces these settings too?\n\nTheir own values for these fields are replaced. (AI instructions, catalogs and numbers are not touched.)`)) return;
    setSaving(applyAll ? 'all' : 'new');
    try {
      const r = await api.put('/admin/defaults', d);
      setD(r.defaults);
      if (applyAll) {
        const a = await api.post('/admin/defaults/apply');
        toast(`Saved and applied to all ${a.workspaces} workspaces`, 'success');
      } else {
        toast(r.notes?.length ? `Saved — adjusted to your rules: ${r.notes.join('; ')}` : 'Saved — every new workspace starts with these', 'success');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
    setSaving('');
  }

  return (
    <div className="sa-rules">
      <div className="sa-explain">
        <Icon.briefcase /> Every <strong>new workspace</strong> starts with these settings (its team can change them later, inside your
        rules). You can also give them to all existing workspaces at once.
        <div className="sa-copy">
          <span>Start from a workspace:</span>
          <select className="select" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Copy settings from">
            <option value="">Choose…</option>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button className="btn sm" disabled={!from} onClick={copyFrom}>Copy its settings</button>
        </div>
      </div>

      <Section icon="bolt" title="Campaign pacing" sub="The rhythm new campaigns start with">
        <Row label="Daily send cap" desc={L.maxPerNumberDay ? `Your rule: at most ${L.maxPerNumberDay}` : null}>
          <Num label="Daily send cap" value={d.dailyLimit} onChange={(v) => set('dailyLimit', v)} suffix="msgs/day" />
        </Row>
        <Row label="Delay between messages" desc={L.minDelaySec ? `Your rule: at least ${L.minDelaySec} sec` : null}>
          <div className="flex" style={{ gap: 8 }}>
            <Num label="Shortest gap" value={d.minDelaySec} onChange={(v) => set('minDelaySec', v)} width={70} min={L.minDelaySec} />
            <span className="muted">to</span>
            <Num label="Longest gap" value={d.maxDelaySec} onChange={(v) => set('maxDelaySec', v)} suffix="sec" width={70} min={L.minDelaySec} />
          </div>
        </Row>
        <Row label="Active hours">
          <div className="flex" style={{ gap: 8 }}>
            <input type="time" aria-label="Start" className="input" style={{ width: 120 }} value={d.windowStart || ''} onChange={(e) => set('windowStart', e.target.value)} />
            <span className="muted">to</span>
            <input type="time" aria-label="End" className="input" style={{ width: 120 }} value={d.windowEnd || ''} onChange={(e) => set('windowEnd', e.target.value)} />
          </div>
        </Row>
        <Row label="Timezone" desc="IANA name, e.g. Asia/Karachi, Asia/Dubai">
          <input className="input" aria-label="Timezone" style={{ width: 200 }} value={d.timezone || ''} onChange={(e) => set('timezone', e.target.value)} />
        </Row>
        <Row label='Simulate "typing…"'>
          <Toggle label="Simulate typing" checked={d.typingSimulation || L.forceTyping} disabled={L.forceTyping} onChange={(v) => set('typingSimulation', v)} />
        </Row>
      </Section>

      <Section icon="shield" title="Safety" sub="Protect fresh numbers">
        <Row label="Gradual warm-up" desc="Start low and ramp the daily volume.">
          <Toggle label="Gradual warm-up" checked={d.warmupEnabled || L.forceRamp} disabled={L.forceRamp} onChange={(v) => set('warmupEnabled', v)} />
        </Row>
        <Row label="Warm-up curve" desc="Day-1 allowance, then this much more each day.">
          <div className="flex" style={{ gap: 8 }}>
            <Num label="Day 1" value={d.warmupStart} onChange={(v) => set('warmupStart', v)} suffix="start" width={70} />
            <span className="muted">+</span>
            <Num label="Each day" value={d.warmupStep} onChange={(v) => set('warmupStep', v)} suffix="/day" width={70} />
          </div>
        </Row>
        <Row label="Hand over to a person when a lead replies">
          <Toggle label="Handoff on reply" checked={d.handoffOnReply} onChange={(v) => set('handoffOnReply', v)} />
        </Row>
        <Row label="Opt-out keywords" desc="Replies starting with these unsubscribe the contact.">
          <input
            className="input"
            aria-label="Opt-out keywords"
            style={{ width: 260 }}
            value={(d.stopKeywords || []).join(', ')}
            onChange={(e) => set('stopKeywords', e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))}
          />
        </Row>
      </Section>

      <Section icon="flame" title="Warm-up chats" sub="Numbers chatting with each other">
        <Row label="Messages a day" desc="Day 1, growth per day, and the most.">
          <div className="flex" style={{ gap: 8 }}>
            <Num label="Warm-up day 1" value={d.warmupDailyStart} onChange={(v) => set('warmupDailyStart', v)} width={64} />
            <span className="muted">+</span>
            <Num label="Warm-up growth" value={d.warmupDailyStep} onChange={(v) => set('warmupDailyStep', v)} width={64} />
            <span className="muted">max</span>
            <Num label="Warm-up max" value={d.warmupDailyMax} onChange={(v) => set('warmupDailyMax', v)} width={64} />
          </div>
        </Row>
        <Row label="Gap between chats">
          <div className="flex" style={{ gap: 8 }}>
            <Num label="Warm-up shortest gap" value={d.warmupMinGap} onChange={(v) => set('warmupMinGap', v)} width={76} min={L.warmupMinGap} />
            <span className="muted">to</span>
            <Num label="Warm-up longest gap" value={d.warmupMaxGap} onChange={(v) => set('warmupMaxGap', v)} suffix="sec" width={76} />
          </div>
        </Row>
        <Row label="Warm-up hours">
          <div className="flex" style={{ gap: 8 }}>
            <input type="time" aria-label="Warm-up start" className="input" style={{ width: 120 }} value={d.warmupWindowStart || ''} onChange={(e) => set('warmupWindowStart', e.target.value)} />
            <span className="muted">to</span>
            <input type="time" aria-label="Warm-up end" className="input" style={{ width: 120 }} value={d.warmupWindowEnd || ''} onChange={(e) => set('warmupWindowEnd', e.target.value)} />
          </div>
        </Row>
      </Section>

      <Section icon="sparkles" title="AI" sub={L.allowAi ? 'What AI does in a new workspace' : 'AI is switched off by your rules'}>
        <Row label="AI message variation" desc="Rewrite each campaign message so no two are the same.">
          <Toggle label="AI variation" checked={d.aiEnabled && L.allowAi} disabled={!L.allowAi} onChange={(v) => set('aiEnabled', v)} />
        </Row>
        <Row label="AI chats during warm-up">
          <Toggle label="AI warm-up chats" checked={d.warmupUseAi && L.allowAi} disabled={!L.allowAi} onChange={(v) => set('warmupUseAi', v)} />
        </Row>
        <Row label="AI provider and model">
          <div className="flex" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <select className="select" aria-label="AI provider" style={{ width: 120 }} value={d.aiProvider || 'groq'} onChange={(e) => set('aiProvider', e.target.value)}>
              <option value="gemini">Gemini</option>
              <option value="groq">Groq</option>
            </select>
            <input className="input" aria-label="AI model" style={{ width: 200 }} value={d.aiModel || ''} onChange={(e) => set('aiModel', e.target.value)} />
          </div>
        </Row>
        <Row label="Tone">
          <select className="select" aria-label="Tone" style={{ width: 180 }} value={d.aiTone || 'friendly'} onChange={(e) => set('aiTone', e.target.value)}>
            <option value="friendly">Friendly</option>
            <option value="professional">Professional</option>
            <option value="casual">Casual</option>
            <option value="enthusiastic">Enthusiastic</option>
          </select>
        </Row>
        <Row label="AI reply delay" desc="How long the AI waits before answering a chat.">
          <div className="flex" style={{ gap: 8 }}>
            <Num label="Reply delay from" value={d.autoReplyMinSec} onChange={(v) => set('autoReplyMinSec', v)} width={64} />
            <span className="muted">to</span>
            <Num label="Reply delay to" value={d.autoReplyMaxSec} onChange={(v) => set('autoReplyMaxSec', v)} suffix="sec" width={64} />
          </div>
        </Row>
      </Section>

      <div className="flex sa-save-row">
        <button className="btn" onClick={() => save(true)} disabled={!!saving}>
          {saving === 'all' ? 'Applying…' : 'Save and apply to all workspaces'}
        </button>
        <button className="btn primary" onClick={() => save(false)} disabled={!!saving}>
          <Icon.check /> {saving === 'new' ? 'Saving…' : 'Save for new workspaces'}
        </button>
      </div>
    </div>
  );
}
