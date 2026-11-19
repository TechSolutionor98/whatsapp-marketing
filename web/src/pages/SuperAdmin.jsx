import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Loading, timeAgo, initials } from '../ui.jsx';
import { roleName } from './Authentication.jsx';

// Pages the super admin can give or take away (Authentication — your own account — is always open).
const PAGE_LIST = [
  ['overview', 'Overview'],
  ['contacts', 'Contacts & Leads'],
  ['templates', 'Templates'],
  ['campaigns', 'Campaigns'],
  ['warmup', 'Warmup'],
  ['conversations', 'Conversations'],
  ['gateway', 'WhatsApp Gateway'],
  ['audit', 'Audit Logs'],
  ['settings', 'Settings'],
];
const pageName = Object.fromEntries(PAGE_LIST);

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" aria-label={label} checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}

function Stat({ label, value, hint, icon, color, warn }) {
  const I = Icon[icon];
  return (
    <div className={`stat ${warn ? 'accent-red' : ''}`}>
      <div className={`ico ${color}`}><I /></div>
      <div className="label">{label}</div>
      <div className="value sa-value">{value}</div>
      <div className="hint">{hint}</div>
    </div>
  );
}

export default function SuperAdmin({ go }) {
  const { user, toast, onBus } = useApp();
  const [state, setState] = useState(null); // { users, system }
  const [numbers, setNumbers] = useState([]);
  const [activity, setActivity] = useState([]);
  const [editing, setEditing] = useState(null); // a user, or 'new'
  const [pwFor, setPwFor] = useState(null);
  const [busy, setBusy] = useState('');

  const load = async () => {
    const [s, n, a] = await Promise.allSettled([
      api.get('/admin/state'),
      api.get('/conversations/accounts'),
      api.get('/audit?limit=12'),
    ]);
    if (s.status === 'fulfilled') setState(s.value);
    else if (!state) toast(s.reason?.message || 'Could not load', 'error');
    if (n.status === 'fulfilled') setNumbers(n.value);
    if (a.status === 'fulfilled') setActivity(a.value);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    const off = onBus((ev) => {
      if (ev === 'pool:update' || ev === 'wa:status' || ev === 'stats:dirty') load();
    });
    return () => {
      clearInterval(t);
      off?.();
    };
  }, []);

  // Run an action, show its result, then refresh everything.
  async function act(key, fn, ok) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy('');
    load();
  }

  const setSystem = (patch, ok) => act('sys', () => api.put('/admin/system', patch), ok);
  const emergency = () => {
    if (!confirm('Stop everything now?\n\n• Campaign sending is paused\n• Warm-up is stopped\n• AI auto-reply is turned off on every number\n\nYou can switch each one back on here.')) return;
    act('stop', () => api.post('/admin/emergency-stop'), 'Everything stopped');
  };
  const setNumberAi = (a, on) =>
    act('ai' + a.id, () => api.post(`/conversations/accounts/${a.id}/autoreply`, { enabled: on }), `AI auto-reply ${on ? 'on' : 'off'} for ${a.label || '+' + a.phone}`);

  const suspend = (u, on) => {
    if (on && !confirm(`Suspend ${u.name} (${u.email})?\n\nThey're signed out at once and can't sign in until you re-activate them.`)) return;
    act('u' + u.id, () => api.post(`/admin/users/${u.id}/suspend`, { suspended: on }), on ? `${u.name} suspended` : `${u.name} re-activated`);
  };
  const signOut = (u) => {
    if (!confirm(`Sign ${u.name} out on every device?`)) return;
    act('u' + u.id, () => api.post(`/admin/users/${u.id}/signout`), `${u.name} was signed out everywhere`);
  };
  const remove = (u) => {
    if (!confirm(`Delete ${u.name} (${u.email})? This can't be undone.`)) return;
    act('u' + u.id, () => api.del(`/auth/users/${u.id}`), `${u.name} deleted`);
  };

  if (!state) return <Loading label="Loading Super Admin…" minHeight={300} />;

  const { users, system } = state;
  const others = users.filter((u) => u.role !== 'owner');
  const admins = others.filter((u) => u.role === 'admin').length;
  const suspended = others.filter((u) => u.suspended).length;
  const connected = numbers.filter((n) => n.connected).length;
  const aiOn = numbers.filter((n) => n.auto_reply).length;

  return (
    <div className="sa">
      <div className="stat-grid">
        <Stat label="Team" value={users.length} hint={`${admins} admin${admins === 1 ? '' : 's'} · ${others.length - admins} member${others.length - admins === 1 ? '' : 's'}${suspended ? ` · ${suspended} suspended` : ''}`} icon="users" color="green" />
        <Stat label="WhatsApp numbers" value={`${connected}/${numbers.length}`} hint="connected" icon="phone" color="blue" />
        <Stat label="Campaign sending" value={system.sendingPaused ? 'Paused' : 'Running'} hint={system.sendingPaused ? 'Nothing is being sent' : 'Campaigns send on schedule'} icon={system.sendingPaused ? 'pause' : 'send'} color={system.sendingPaused ? 'red' : 'green'} warn={system.sendingPaused} />
        <Stat label="AI auto-reply" value={`${aiOn}/${numbers.length}`} hint="numbers answering with AI" icon="sparkles" color="violet" />
      </div>

      <div className="sa-grid">
        {/* System switches */}
        <div className="card">
          <div className="card-head">
            <Icon.bolt style={{ width: 18, color: 'var(--brand-700)' }} />
            <div><h3>Control center</h3><div className="sub">Switch any part of the app on or off — it applies at once.</div></div>
          </div>
          <div className="card-pad sa-rows">
            <div className="setting-row">
              <div>
                <div className="st-label">Campaign sending</div>
                <div className="st-desc">{system.sendingPaused ? 'Paused — no campaign sends anything until you turn this back on (stays paused after a restart).' : 'Running — campaigns send inside their schedule.'}</div>
              </div>
              <Toggle label="Campaign sending" checked={!system.sendingPaused} disabled={busy === 'sys'} onChange={(on) => setSystem({ sendingPaused: !on }, on ? 'Campaign sending resumed' : 'Campaign sending paused')} />
            </div>
            <div className="setting-row">
              <div>
                <div className="st-label">Warm-up chats</div>
                <div className="st-desc">{system.warmupActive ? 'On — your warm-up numbers chat with each other.' : `Off.${system.warmupNumbers < 2 ? ' Link at least 2 numbers on the Warmup page to start it.' : ''}`}</div>
              </div>
              <Toggle label="Warm-up chats" checked={system.warmupActive} disabled={busy === 'sys' || (!system.warmupActive && system.warmupNumbers < 2)} onChange={(on) => setSystem({ warmupActive: on }, on ? 'Warm-up started' : 'Warm-up stopped')} />
            </div>
            <div className="setting-row">
              <div>
                <div className="st-label">AI auto-reply on every number</div>
                <div className="st-desc">On for {aiOn} of {numbers.length} numbers. Set each number on its own on the right.</div>
              </div>
              <div className="flex" style={{ gap: 6 }}>
                <button className="btn sm" disabled={busy === 'sys'} onClick={() => setSystem({ autoReply: true }, 'AI auto-reply on for every number')}>All on</button>
                <button className="btn sm" disabled={busy === 'sys'} onClick={() => setSystem({ autoReply: false }, 'AI auto-reply off for every number')}>All off</button>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="st-label">Team sign-in</div>
                <div className="st-desc">{system.teamLocked ? 'Paused — only you can use the app. Everyone else was signed out and cannot sign in.' : 'Open — your team can sign in and use the pages you allow.'}</div>
              </div>
              <Toggle
                label="Team sign-in"
                checked={!system.teamLocked}
                disabled={busy === 'sys'}
                onChange={(on) => {
                  if (!on && !confirm('Pause sign-in for everyone except you? They are signed out at once.')) return;
                  setSystem({ teamLocked: !on }, on ? 'Team sign-in re-opened' : 'Team sign-in paused — only you can use the app');
                }}
              />
            </div>
            <div className="setting-row sa-stop">
              <div>
                <div className="st-label">Emergency stop</div>
                <div className="st-desc">Pause campaign sending, stop warm-up and turn AI auto-reply off on every number — all at once.</div>
              </div>
              <button className="btn danger" onClick={emergency} disabled={busy === 'stop'}>
                <Icon.pause /> {busy === 'stop' ? 'Stopping…' : 'Stop everything'}
              </button>
            </div>
          </div>
        </div>

        {/* Numbers */}
        <div className="card">
          <div className="card-head">
            <Icon.phone style={{ width: 18, color: 'var(--brand-700)' }} />
            <div style={{ flex: 1, minWidth: 0 }}><h3>WhatsApp numbers</h3><div className="sub">AI auto-reply for each number</div></div>
            <button className="btn sm" onClick={() => go?.('gateway')}>Manage</button>
          </div>
          <div className="sa-nums">
            {numbers.length === 0 ? (
              <div className="card-pad muted" style={{ fontSize: 13 }}>No numbers linked yet.</div>
            ) : (
              numbers.map((n) => (
                <div key={n.id} className="sa-num">
                  <span className={`wa-tab-dot ${n.connected ? 'on' : 'connecting'}`} title={n.connected ? 'Connected' : 'Not connected'} />
                  <div className="sa-num-main">
                    <div className="sa-num-name">
                      {n.label || (n.id === 'main' ? 'Main number' : '+' + n.phone)}
                      {n.default && <span className="wa-tab-default">Default</span>}
                    </div>
                    <div className="sa-num-sub">{n.phone ? '+' + n.phone : 'not linked'} · {n.connected ? 'connected' : 'offline'}</div>
                  </div>
                  <span className="sa-num-ai">AI</span>
                  <Toggle label={`AI auto-reply for ${n.label || n.phone}`} checked={n.auto_reply} disabled={busy === 'ai' + n.id} onChange={(on) => setNumberAi(n, on)} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Team & access */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.users style={{ width: 18, color: 'var(--brand-700)' }} />
          <div style={{ flex: 1, minWidth: 0 }}><h3>Team &amp; access</h3><div className="sub">Choose what each person can open. Changes apply at once — even to people already signed in.</div></div>
          <button className="btn primary sm" onClick={() => setEditing('new')}><Icon.plus /> Add person</button>
        </div>
        <div className="table-wrap">
          <table className="sa-table">
            <thead>
              <tr><th>Person</th><th>Role</th><th>Can open</th><th>Status</th><th>Last sign-in</th><th></th></tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const owner = u.role === 'owner';
                const me = u.id === user.id;
                return (
                  <tr key={u.id} className={u.suspended ? 'sa-suspended' : ''}>
                    <td>
                      <div className="flex" style={{ gap: 10 }}>
                        <div className="avatar" style={{ width: 32, height: 32, fontSize: 12 }}>{initials(u.name, u.email)}</div>
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-strong">{u.name} {me && <span className="chip">you</span>}</div>
                          <div className="cell-muted" style={{ fontSize: 12 }}>{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className={`badge ${owner ? 'green' : u.role === 'admin' ? 'blue' : 'gray'}`}>{roleName(u.role)}</span></td>
                    <td className="sa-pages">
                      {u.allPages ? (
                        <span className="chip">Everything</span>
                      ) : u.pages.length === 0 ? (
                        <span className="chip sa-none">Only their account</span>
                      ) : (
                        <span title={u.pages.map((p) => pageName[p]).join(', ')}>
                          {u.pages.slice(0, 3).map((p) => <span key={p} className="chip">{pageName[p]}</span>)}
                          {u.pages.length > 3 && <span className="chip">+{u.pages.length - 3}</span>}
                        </span>
                      )}
                    </td>
                    <td>{u.suspended ? <span className="badge red">Suspended</span> : <span className="badge green">Active</span>}</td>
                    <td className="cell-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}</td>
                    <td>
                      {owner ? (
                        <span className="cell-muted" style={{ fontSize: 12 }}>Full control</span>
                      ) : (
                        <div className="sa-actions">
                          <button className="btn sm" onClick={() => setEditing(u)} disabled={busy === 'u' + u.id}><Icon.edit /> Access</button>
                          <button className="btn sm ghost" onClick={() => setPwFor(u)} title="Set a new password">Password</button>
                          <button className="btn sm ghost" onClick={() => signOut(u)} title="Sign out on every device">Sign out</button>
                          {u.suspended ? (
                            <button className="btn sm" onClick={() => suspend(u, false)}>Activate</button>
                          ) : (
                            <button className="btn sm ghost sa-warn" onClick={() => suspend(u, true)}>Suspend</button>
                          )}
                          <button className="btn sm ghost" onClick={() => remove(u)} title="Delete"><Icon.trash /></button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent activity */}
      <div className="card">
        <div className="card-head">
          <Icon.logs style={{ width: 18, color: 'var(--brand-700)' }} />
          <div style={{ flex: 1 }}><h3>Recent activity</h3><div className="sub">What happened last, from the audit log</div></div>
          <button className="btn sm" onClick={() => go?.('audit')}>View all</button>
        </div>
        {activity.length === 0 ? (
          <div className="card-pad muted" style={{ fontSize: 13 }}>Nothing yet.</div>
        ) : (
          activity.map((l) => (
            <div key={l.id} className="log-row">
              <span className={`log-level lvl-${l.level}`} />
              <span className="log-type" style={{ minWidth: 92 }}>{l.type}</span>
              <div style={{ flex: 1 }}>{l.message}</div>
              <div className="log-time">{timeAgo(l.created_at)}</div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <PersonModal
          person={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {pwFor && <PasswordModal person={pwFor} onClose={() => setPwFor(null)} onSaved={() => { setPwFor(null); load(); }} />}
    </div>
  );
}

// Add a person, or change someone's name, role and pages.
function PersonModal({ person, onClose, onSaved }) {
  const { toast } = useApp();
  const isNew = !person;
  const [f, setF] = useState({
    name: person?.name || '',
    email: '',
    password: '',
    role: person?.role || 'member',
    pages: person ? [...person.pages] : PAGE_LIST.map(([id]) => id),
  });
  const [saving, setSaving] = useState(false);
  const toggle = (id) => setF((x) => ({ ...x, pages: x.pages.includes(id) ? x.pages.filter((p) => p !== id) : [...x.pages, id] }));

  async function save() {
    setSaving(true);
    try {
      if (isNew) await api.post('/auth/register', f);
      else await api.put(`/admin/users/${person.id}`, { name: f.name, role: f.role, pages: f.pages });
      toast(isNew ? `${f.name || f.email} added` : 'Access saved', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
    setSaving(false);
  }

  return (
    <Modal
      title={isNew ? 'Add a person' : `Access for ${person.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving || (isNew && (!f.email || f.password.length < 6))}>
            {saving ? 'Saving…' : isNew ? 'Add person' : 'Save access'}
          </button>
        </>
      }
    >
      <div className="row">
        <div className="field">
          <label>Name</label>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Role</label>
          <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="member">Member</option>
            <option value="admin">Admin — can also add and remove members</option>
          </select>
        </div>
      </div>
      {isNew && (
        <div className="row">
          <div className="field">
            <label>Email</label>
            <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </div>
          <div className="field">
            <label>Temporary password</label>
            <input className="input" type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="At least 6 characters" />
          </div>
        </div>
      )}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center' }}>
          Can open
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, pages: PAGE_LIST.map(([id]) => id) })}>All</button>
            <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, pages: [] })}>None</button>
          </span>
        </label>
        <div className="sa-checks">
          {PAGE_LIST.map(([id, label]) => (
            <label key={id} className={`sa-check ${f.pages.includes(id) ? 'on' : ''}`}>
              <input type="checkbox" checked={f.pages.includes(id)} onChange={() => toggle(id)} />
              {label}
            </label>
          ))}
        </div>
        <div className="hint">Their own account page (name, password) is always available. Only you can open Super Admin.</div>
      </div>
    </Modal>
  );
}

function PasswordModal({ person, onClose, onSaved }) {
  const { toast } = useApp();
  const [pw, setPw] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await api.post(`/admin/users/${person.id}/password`, { password: pw });
      toast(`New password set for ${person.name} — they were signed out`, 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
    setSaving(false);
  }
  return (
    <Modal
      title={`New password for ${person.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving || pw.length < 6}>{saving ? 'Saving…' : 'Set password'}</button>
        </>
      }
    >
      <div className="field">
        <label>New password</label>
        <input className="input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 6 characters" autoFocus />
        <div className="hint">{person.email} is signed out on every device and must sign in with this password. Share it with them.</div>
      </div>
    </Modal>
  );
}
