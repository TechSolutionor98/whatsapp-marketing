import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Loading, timeAgo, initials } from '../ui.jsx';
import { roleName } from './Authentication.jsx';
import { RulesPanel, DefaultsPanel } from './SuperAdminRules.jsx';

const TABS = [
  ['workspaces', 'Workspaces', 'briefcase'],
  ['people', 'People', 'users'],
  ['rules', 'Rules & controls', 'shield'],
  ['defaults', 'New workspace settings', 'settings'],
  ['activity', 'Activity', 'logs'],
];

// The platform: every workspace (each business using the app — e.g. Tech Solutionor, or a
// customer you give access), every person in them, and switches that apply everywhere.

// Pages the super admin can give or take away (Authentication — your own account — is always open).
const PAGE_LIST = [
  ['overview', 'Overview'],
  ['contacts', 'Contacts & Leads'],
  ['templates', 'Templates'],
  ['campaigns', 'Campaigns'],
  ['warmup', 'Warmup'],
  ['conversations', 'Conversations'],
  ['gateway', 'WhatsApp Gateway'],
  ['developer', 'Developer + Docs'],
  ['audit', 'Audit Logs'],
  ['settings', 'Settings'],
];
const pageName = Object.fromEntries(PAGE_LIST);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

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

export default function SuperAdmin() {
  const { user, workspace, toast, onBus, switchWorkspace, refreshAuth } = useApp();
  const [state, setState] = useState(null); // { workspaces, users, platform, current }
  const [activity, setActivity] = useState([]);
  const [manage, setManage] = useState(null); // workspace id
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // a person, or 'new'
  const [pwFor, setPwFor] = useState(null);
  const [wsFilter, setWsFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [tab, setTabState] = useState(() => {
    try {
      return sessionStorage.getItem('pulse_sa_tab') || 'workspaces';
    } catch {
      return 'workspaces';
    }
  });
  const setTab = (t) => {
    setTabState(t);
    try {
      sessionStorage.setItem('pulse_sa_tab', t);
    } catch {}
  };

  const load = async () => {
    const [s, a] = await Promise.allSettled([api.get('/admin/state'), api.get('/admin/activity?limit=15')]);
    if (s.status === 'fulfilled') setState(s.value);
    else toast(s.reason?.message || 'Could not load', 'error');
    if (a.status === 'fulfilled') setActivity(a.value);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    const off = onBus((ev) => {
      if (ev === 'admin:update' || ev === 'pool:update' || ev === 'wa:status') load();
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
    refreshAuth(); // workspace names / suspensions in the sidebar
  }

  const setPlatform = (patch, ok) => act('plat', () => api.put('/admin/system', patch), ok);
  const stopAll = () => {
    if (!confirm('Stop everything in EVERY workspace now?\n\n• Campaign sending is paused\n• Warm-up is stopped\n• AI auto-reply is turned off on every number\n\nYou can switch each one back on per workspace.')) return;
    act('stopall', () => api.post('/admin/emergency-stop'), 'Everything stopped in every workspace');
  };
  const approve = (w) => act('ws' + w.id, () => api.post(`/admin/workspaces/${w.id}/suspend`, { suspended: false }), `${w.name} approved — they can sign in now`);
  const suspendUser = (u, on) => {
    if (on && !confirm(`Suspend ${u.name} (${u.email})?\n\nThey're signed out at once and can't sign in until you re-activate them.`)) return;
    act('u' + u.id, () => api.post(`/admin/users/${u.id}/suspend`, { suspended: on }), on ? `${u.name} suspended` : `${u.name} re-activated`);
  };
  const signOut = (u) => {
    if (!confirm(`Sign ${u.name} out on every device?`)) return;
    act('u' + u.id, () => api.post(`/admin/users/${u.id}/signout`), `${u.name} was signed out everywhere`);
  };
  const removeUser = (u) => {
    if (!confirm(`Delete ${u.name} (${u.email})? This can't be undone.`)) return;
    act('u' + u.id, () => api.del(`/auth/users/${u.id}`), `${u.name} deleted`);
  };

  const people = useMemo(() => {
    const list = state?.users || [];
    return wsFilter ? list.filter((u) => u.ws === wsFilter) : list;
  }, [state, wsFilter]);

  if (!state) return <Loading label="Loading Super Admin…" minHeight={300} />;

  const { workspaces, users, platform } = state;
  const others = users.filter((u) => u.role !== 'owner');
  const pendingWs = workspaces.filter((w) => w.pending).length;
  const suspendedWs = workspaces.filter((w) => w.suspended && !w.pending).length;
  const wsRows = [...workspaces].sort((a, b) => (b.pending ? 1 : 0) - (a.pending ? 1 : 0)); // waiting for approval first
  const numbers = workspaces.reduce((n, w) => n + w.numbers.length, 0);
  const connected = workspaces.reduce((n, w) => n + w.numbers.filter((x) => x.connected).length, 0);
  const sentToday = workspaces.reduce((n, w) => n + (w.sentToday || 0), 0);
  const managing = manage ? workspaces.find((w) => w.id === manage) : null;

  return (
    <div className="sa">
      <div className="stat-grid">
        <Stat label="Workspaces" value={workspaces.length} hint={pendingWs ? `${pendingWs} waiting for your approval` : suspendedWs ? `${suspendedWs} suspended` : 'businesses on the platform'} icon="briefcase" color="green" warn={pendingWs > 0} />
        <Stat label="People" value={others.length} hint={`in ${plural(workspaces.length, 'workspace')} · plus you`} icon="users" color="blue" />
        <Stat label="WhatsApp numbers" value={`${connected}/${numbers}`} hint="connected, all workspaces" icon="phone" color="violet" />
        <Stat label="Sent today" value={sentToday.toLocaleString()} hint={platform.sendingPaused ? 'Sending is paused everywhere' : 'campaign messages, all workspaces'} icon={platform.sendingPaused ? 'pause' : 'send'} color={platform.sendingPaused ? 'red' : 'green'} warn={platform.sendingPaused} />
      </div>

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

      {tab === 'rules' && <RulesPanel onSaved={load} />}
      {tab === 'defaults' && <DefaultsPanel workspaces={workspaces} />}

      {/* Workspaces */}
      {tab === 'workspaces' && (
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.briefcase style={{ width: 18, color: 'var(--brand-700)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>Workspaces</h3>
            <div className="sub">Each business gets its own workspace — its own numbers, contacts, campaigns, chats, settings and team. Nobody sees another workspace.</div>
          </div>
          <button className="btn primary sm" onClick={() => setCreating(true)}><Icon.plus /> New workspace</button>
        </div>
        <div className="table-wrap">
          <table className="sa-table sa-ws-table">
            <thead>
              <tr><th>Workspace</th><th>Team</th><th>Numbers</th><th>Contacts</th><th>Campaigns</th><th>Sent today</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {wsRows.map((w) => {
                const on = w.numbers.filter((n) => n.connected).length;
                const here = w.id === workspace?.id;
                return (
                  <tr key={w.id} className={w.pending ? 'sa-pending' : w.suspended ? 'sa-suspended' : ''}>
                    <td>
                      <div className="sa-ws-name">
                        {w.name}
                        {here && <span className="chip">open now</span>}
                        {w.main && <span className="chip sa-orig" title="The workspace that was using the app before workspaces existed. It has the original main number.">original</span>}
                        {w.signup_email && <span className="chip" title="Created from the public sign-up">signed up</span>}
                      </div>
                      <div className="cell-muted" style={{ fontSize: 12 }}>
                        since {new Date(w.created_at || Date.now()).toLocaleDateString()}
                        {w.signup_email ? ` · by ${w.signup_email}` : ''}
                      </div>
                    </td>
                    <td>{plural(w.team, 'person', 'people')}</td>
                    <td>
                      <span className={on ? '' : 'cell-muted'}>{on}/{w.numbers.length}</span>
                      <span className="cell-muted"> connected</span>
                    </td>
                    <td>{w.contacts.toLocaleString()}</td>
                    <td>{w.campaignsRunning ? <span className="badge green">{w.campaignsRunning} running</span> : <span className="cell-muted">none running</span>}</td>
                    <td>{w.sentToday.toLocaleString()}</td>
                    <td>
                      <div className="sa-status">
                        {w.pending ? <span className="badge amber">Waiting for approval</span> : w.suspended ? <span className="badge red">Suspended</span> : <span className="badge green">Active</span>}
                        {!w.suspended && w.sendingPaused && <span className="badge amber">Sending paused</span>}
                      </div>
                    </td>
                    <td>
                      <div className="sa-actions">
                        {w.pending && (
                          <button className="btn sm primary" onClick={() => approve(w)} disabled={busy === 'ws' + w.id} title="Let them sign in and use their workspace">
                            <Icon.check /> Approve
                          </button>
                        )}
                        {!here && (
                          <button className="btn sm" onClick={() => switchWorkspace(w.id)} title={`Work in ${w.name}`}>
                            Open
                          </button>
                        )}
                        <button className="btn sm primary" onClick={() => setManage(w.id)}>Manage</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      )}

      {/* Platform switches */}
      {tab === 'rules' && (
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.bolt style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Platform controls</h3><div className="sub">These apply to every workspace at once. Each workspace's own switches are under Manage.</div></div>
        </div>
        <div className="card-pad sa-rows">
          <div className="setting-row">
            <div>
              <div className="st-label">Campaign sending — all workspaces</div>
              <div className="st-desc">{platform.sendingPaused ? 'Paused everywhere — no workspace sends campaign messages until you turn this back on.' : 'Allowed — each workspace sends on its own schedule (unless paused there).'}</div>
            </div>
            <Toggle label="Campaign sending, all workspaces" checked={!platform.sendingPaused} disabled={busy === 'plat'} onChange={(on) => setPlatform({ sendingPaused: !on }, on ? 'Sending allowed again in every workspace' : 'Sending paused in every workspace')} />
          </div>
          <div className="setting-row">
            <div>
              <div className="st-label">Public sign-up</div>
              <div className="st-desc">
                {platform.signup === 'approval'
                  ? 'Anyone can sign up from the sign-in screen. Their new workspace waits until you approve it (Workspaces tab).'
                  : platform.signup === 'off'
                    ? 'Closed — only you (and workspace admins, for their own team) can create accounts.'
                    : 'Open — anyone can sign up from the sign-in screen and starts at once in their own new workspace, with your default settings and rules.'}
              </div>
            </div>
            <select
              className="select sa-signup"
              aria-label="Public sign-up"
              value={platform.signup || 'open'}
              disabled={busy === 'plat'}
              onChange={(e) => setPlatform({ signup: e.target.value }, { open: 'Sign-up is open', approval: 'New sign-ups now wait for your approval', off: 'Sign-up is closed' }[e.target.value])}
            >
              <option value="open">Open</option>
              <option value="approval">Needs my approval</option>
              <option value="off">Closed</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <div className="st-label">Sign-in — everyone</div>
              <div className="st-desc">{platform.teamLocked ? 'Paused — only you can use the app. Everyone else, in every workspace, was signed out.' : 'Open — people can sign in to their workspace.'}</div>
            </div>
            <Toggle
              label="Sign-in for everyone"
              checked={!platform.teamLocked}
              disabled={busy === 'plat'}
              onChange={(on) => {
                if (!on && !confirm('Pause sign-in for everyone except you, in every workspace? They are signed out at once.')) return;
                setPlatform({ teamLocked: !on }, on ? 'Sign-in re-opened for everyone' : 'Sign-in paused — only you can use the app');
              }}
            />
          </div>
          <div className="setting-row sa-stop">
            <div>
              <div className="st-label">Emergency stop — all workspaces</div>
              <div className="st-desc">Pause campaign sending, stop warm-up and turn AI auto-reply off on every number of every workspace.</div>
            </div>
            <button className="btn danger" onClick={stopAll} disabled={busy === 'stopall'}>
              <Icon.pause /> {busy === 'stopall' ? 'Stopping…' : 'Stop everything'}
            </button>
          </div>
        </div>
      </div>

      )}

      {/* People */}
      {tab === 'people' && (
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head sa-people-head">
          <Icon.users style={{ width: 18, color: 'var(--brand-700)' }} />
          <div style={{ flex: 1, minWidth: 0 }}><h3>People</h3><div className="sub">Everyone on the platform. Choose which workspace each person works in and what they can open — changes apply at once.</div></div>
          <select className="select sa-filter" value={wsFilter} onChange={(e) => setWsFilter(e.target.value)} aria-label="Show people of">
            <option value="">All workspaces</option>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button className="btn primary sm" onClick={() => setEditing('new')}><Icon.plus /> Add person</button>
        </div>
        <div className="table-wrap">
          <table className="sa-table">
            <thead>
              <tr><th>Person</th><th>Workspace</th><th>Role</th><th>Can open</th><th>Status</th><th>Last sign-in</th><th></th></tr>
            </thead>
            <tbody>
              {people.length === 0 && (
                <tr><td colSpan={7} className="cell-muted" style={{ textAlign: 'center', padding: 22 }}>Nobody in this workspace yet — add their first person.</td></tr>
              )}
              {people.map((u) => {
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
                    <td>{owner ? <span className="cell-muted">All workspaces</span> : <span className="sa-wsname">{u.wsName || '—'}</span>}</td>
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
                            <button className="btn sm" onClick={() => suspendUser(u, false)}>Activate</button>
                          ) : (
                            <button className="btn sm ghost sa-warn" onClick={() => suspendUser(u, true)}>Suspend</button>
                          )}
                          <button className="btn sm ghost" onClick={() => removeUser(u)} title="Delete"><Icon.trash /></button>
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

      )}

      {/* Recent activity */}
      {tab === 'activity' && (
      <div className="card">
        <div className="card-head">
          <Icon.logs style={{ width: 18, color: 'var(--brand-700)' }} />
          <div style={{ flex: 1 }}><h3>Recent super admin activity</h3><div className="sub">Workspaces, people and switches you changed — across every workspace</div></div>
        </div>
        {activity.length === 0 ? (
          <div className="card-pad muted" style={{ fontSize: 13 }}>Nothing yet.</div>
        ) : (
          activity.map((l) => (
            <div key={l.id} className="log-row">
              <span className={`log-level lvl-${l.level}`} />
              <span className="log-type sa-log-ws" title={l.wsName}>{l.wsName}</span>
              <div style={{ flex: 1 }}>{l.message}</div>
              <div className="log-time">{timeAgo(l.created_at)}</div>
            </div>
          ))
        )}
      </div>
      )}

      {creating && (
        <NewWorkspaceModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
            refreshAuth();
          }}
        />
      )}
      {managing && (
        <ManageWorkspaceModal
          w={managing}
          here={managing.id === workspace?.id}
          onClose={() => setManage(null)}
          onChanged={() => {
            load();
            refreshAuth();
          }}
          onDeleted={() => {
            setManage(null);
            if (managing.id === workspace?.id) switchWorkspace('default', 'superadmin');
            else {
              load();
              refreshAuth();
            }
          }}
          onOpen={() => switchWorkspace(managing.id)}
        />
      )}
      {editing && (
        <PersonModal
          person={editing === 'new' ? null : editing}
          workspaces={workspaces}
          defaultWs={wsFilter || workspace?.id}
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

// A new workspace for a business, optionally with its first admin (who can then add their team).
function NewWorkspaceModal({ onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: '', adminName: '', email: '', password: '' });
  const [saving, setSaving] = useState(false);
  const withAdmin = !!(f.email || f.password || f.adminName);
  async function save() {
    setSaving(true);
    try {
      const r = await api.post('/admin/workspaces', {
        name: f.name,
        admin: withAdmin ? { name: f.adminName, email: f.email, password: f.password } : null,
      });
      toast(`Workspace "${r.workspace.name}" created${r.admin ? ` — ${r.admin.email} can sign in now` : ''}`, 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
    setSaving(false);
  }
  return (
    <Modal
      title="New workspace"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving || !f.name.trim() || (withAdmin && (!f.email || f.password.length < 6))}>
            {saving ? 'Creating…' : 'Create workspace'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Business name</label>
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Osumprises" autoFocus />
        <div className="hint">It starts empty: its own WhatsApp numbers, contacts, templates, campaigns, chats, catalogs and settings.</div>
      </div>
      <div className="sa-sub-head">Their first admin <span className="muted">(optional — you can add people later)</span></div>
      <div className="row">
        <div className="field">
          <label>Name</label>
          <input className="input" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} />
        </div>
        <div className="field">
          <label>Email</label>
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>Temporary password</label>
        <input className="input" type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="At least 6 characters" />
        <div className="hint">They sign in with this, see only this workspace, and can add members to it. Share it with them.</div>
      </div>
    </Modal>
  );
}

// Everything about one workspace: name, its switches, its numbers' AI, suspend, delete.
function ManageWorkspaceModal({ w, here, onClose, onChanged, onDeleted, onOpen }) {
  const { toast } = useApp();
  const [name, setName] = useState(w.name);
  const [busy, setBusy] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const aiOn = w.numbers.filter((n) => n.auto_reply).length;

  async function act(key, fn, ok) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy('');
  }
  const sys = (patch, ok) => act('sys', () => api.put(`/admin/workspaces/${w.id}/system`, patch), ok);
  const numberAi = (n, on) =>
    act('ai' + n.id, () => api.post(`/admin/workspaces/${w.id}/numbers/${n.id}/autoreply`, { enabled: on }), `AI auto-reply ${on ? 'on' : 'off'} for ${n.label || '+' + n.phone}`);
  const suspend = (on) => {
    if (on && !confirm(`Suspend ${w.name}?\n\n• Its team is signed out and can't sign in\n• No campaigns, warm-up or AI replies go out\n• Its numbers stay linked and chats keep arriving\n\nYou can re-activate it any time.`)) return;
    act('susp', () => api.post(`/admin/workspaces/${w.id}/suspend`, { suspended: on }), on ? `${w.name} suspended` : `${w.name} re-activated`);
  };
  const stop = () => {
    if (!confirm(`Stop everything in ${w.name}?\n\nCampaign sending is paused, warm-up stopped and AI auto-reply turned off on its numbers.`)) return;
    act('stop', () => api.post(`/admin/workspaces/${w.id}/emergency-stop`), `Everything stopped in ${w.name}`);
  };
  async function del() {
    setBusy('del');
    try {
      await api.del(`/admin/workspaces/${w.id}`, { confirm: confirmName });
      toast(`${w.name} deleted`, 'success');
      onDeleted();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy('');
  }

  return (
    <Modal title={w.name} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Close</button>{!here && <button className="btn primary" onClick={onOpen}>Open {w.name}</button>}</>}>
      <div className="sa-m-row">
        <div className="field" style={{ flex: 1, margin: 0 }}>
          <label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn" disabled={busy === 'name' || !name.trim() || name.trim() === w.name} onClick={() => act('name', () => api.put(`/admin/workspaces/${w.id}`, { name: name.trim() }), 'Workspace renamed')}>
          Rename
        </button>
      </div>

      <div className="sa-sub-head">Switches</div>
      <div className="sa-rows sa-m-box">
        <div className="setting-row">
          <div>
            <div className="st-label">Campaign sending</div>
            <div className="st-desc">{w.sendingPaused ? 'Paused — its campaigns send nothing until you turn this back on.' : 'Running — its campaigns send inside their schedule.'}</div>
          </div>
          <Toggle label="Campaign sending" checked={!w.sendingPaused} disabled={busy === 'sys'} onChange={(on) => sys({ sendingPaused: !on }, on ? 'Campaign sending resumed' : 'Campaign sending paused')} />
        </div>
        <div className="setting-row">
          <div>
            <div className="st-label">Warm-up chats</div>
            <div className="st-desc">{w.warmupActive ? 'On — its warm-up numbers chat with each other.' : `Off.${w.warmupNumbers < 2 ? ' It needs at least 2 warm-up numbers (Warmup page).' : ''}`}</div>
          </div>
          <Toggle label="Warm-up chats" checked={w.warmupActive} disabled={busy === 'sys' || (!w.warmupActive && w.warmupNumbers < 2)} onChange={(on) => sys({ warmupActive: on }, on ? 'Warm-up started' : 'Warm-up stopped')} />
        </div>
        <div className="setting-row">
          <div>
            <div className="st-label">AI auto-reply</div>
            <div className="st-desc">
              On for {aiOn} of {plural(w.numbers.length, 'number')}. {w.ai?.provider === 'groq' ? 'Groq' : w.ai?.provider === 'gemini' ? 'Gemini' : w.ai?.provider}{' '}
              {w.ai?.key === 'own' ? 'with its own API key.' : w.ai?.key === 'platform' ? 'with your API key.' : w.ai?.key === 'local' ? '(local).' : '— no API key yet, so AI is off.'}
            </div>
          </div>
          <div className="flex" style={{ gap: 6 }}>
            <button className="btn sm" disabled={busy === 'sys' || !w.numbers.length} onClick={() => sys({ autoReply: true }, 'AI auto-reply on for every number')}>All on</button>
            <button className="btn sm" disabled={busy === 'sys' || !w.numbers.length} onClick={() => sys({ autoReply: false }, 'AI auto-reply off for every number')}>All off</button>
          </div>
        </div>
      </div>

      <div className="sa-sub-head">WhatsApp numbers</div>
      <div className="sa-m-box">
        {w.numbers.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, padding: '12px 14px' }}>No numbers linked yet — they're linked on this workspace's WhatsApp Gateway page.</div>
        ) : (
          w.numbers.map((n) => (
            <div key={n.id} className="sa-num">
              <span className={`wa-tab-dot ${n.connected ? 'on' : 'connecting'}`} title={n.connected ? 'Connected' : 'Not connected'} />
              <div className="sa-num-main">
                <div className="sa-num-name">
                  {n.label || n.name || (n.main ? 'Main number' : '+' + n.phone)}
                  {n.default && <span className="wa-tab-default">Default</span>}
                </div>
                <div className="sa-num-sub">{n.phone ? '+' + n.phone : 'not linked'} · {n.connected ? 'connected' : 'offline'}</div>
              </div>
              <span className="sa-num-ai">AI</span>
              <Toggle label={`AI auto-reply for ${n.label || n.phone}`} checked={n.auto_reply} disabled={busy === 'ai' + n.id} onChange={(on) => numberAi(n, on)} />
            </div>
          ))
        )}
      </div>

      <DeveloperBox w={w} onChanged={onChanged} />

      <div className="sa-sub-head">Access</div>
      <div className="sa-rows sa-m-box">
        <div className="setting-row">
          <div>
            <div className="st-label">{w.suspended ? 'Suspended' : 'Active'}</div>
            <div className="st-desc">
              {w.suspended
                ? "Its team can't sign in and nothing is sent automatically. Chats keep arriving."
                : `${plural(w.team, 'person', 'people')} can sign in and use the pages you allow them.`}
            </div>
          </div>
          {w.suspended ? (
            <button className="btn primary sm" disabled={busy === 'susp'} onClick={() => suspend(false)}>Re-activate</button>
          ) : (
            <button className="btn sm sa-warn" disabled={busy === 'susp'} onClick={() => suspend(true)}>Suspend</button>
          )}
        </div>
        <div className="setting-row sa-stop">
          <div>
            <div className="st-label">Emergency stop</div>
            <div className="st-desc">Pause its campaign sending, stop its warm-up and turn AI auto-reply off on its numbers.</div>
          </div>
          <button className="btn danger sm" disabled={busy === 'stop'} onClick={stop}><Icon.pause /> Stop everything</button>
        </div>
      </div>

      {!w.main && (
        <div className="sa-danger">
          <div className="st-label">Delete this workspace</div>
          <div className="st-desc">
            Unlinks its WhatsApp numbers and permanently deletes its contacts, chats, campaigns, templates, catalogs,
            settings, logs and its {plural(w.team, 'person', 'people')}. This can't be undone. Type <strong>{w.name}</strong> to confirm.
          </div>
          <div className="sa-m-row" style={{ marginTop: 10 }}>
            <input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={w.name} aria-label="Type the workspace name to confirm" />
            <button className="btn danger" disabled={busy === 'del' || confirmName.trim() !== w.name} onClick={del}>
              <Icon.trash /> {busy === 'del' ? 'Deleting…' : 'Delete workspace'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// One workspace's Developer API: on/off, its API number, how fast it sends, and its queue.
function DeveloperBox({ w, onChanged }) {
  const { toast } = useApp();
  const a = w.api || { off: false, keys: 0, number: null, sending: { per_batch: 1, gap_seconds: 3, max_queue: 500 }, bounds: { per_batch: [1, 50], gap_seconds: [0, 3600], max_queue: [10, 5000] }, queued: 0, sentToday: 0 };
  const [f, setF] = useState(a.sending);
  const [busy, setBusy] = useState('');
  useEffect(() => setF(a.sending), [a.sending.per_batch, a.sending.gap_seconds, a.sending.max_queue]);
  const dirty = Number(f.per_batch) !== a.sending.per_batch || Number(f.gap_seconds) !== a.sending.gap_seconds || Number(f.max_queue) !== a.sending.max_queue;
  async function put(key, body, ok) {
    setBusy(key);
    try {
      const r = await api.put(`/admin/workspaces/${w.id}/developer`, body);
      toast([ok, ...(r.notes || [])].filter(Boolean).join(' — '), 'success');
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy('');
  }
  const field = (k, label, [lo, hi], suffix) => (
    <label className="sa-dev-field">
      <span>{label}</span>
      <span className="flex" style={{ gap: 6 }}>
        <input className="input" type="number" min={lo} max={hi} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} aria-label={label} />
        <span className="muted" style={{ fontSize: 12 }}>{suffix}</span>
      </span>
      <span className="muted" style={{ fontSize: 11.5 }}>{lo}–{hi}</span>
    </label>
  );
  return (
    <>
      <div className="sa-sub-head">Developer API</div>
      <div className="sa-rows sa-m-box">
        <div className="setting-row">
          <div>
            <div className="st-label">Developer API for this workspace</div>
            <div className="st-desc">
              {a.off
                ? 'Off — its keys are refused and its queue waits (messages expire after 24 hours).'
                : `On — ${plural(a.keys, 'API key')}, ${plural(a.sentToday, 'message')} sent through the API today.`}
            </div>
          </div>
          <Toggle label="Developer API for this workspace" checked={!a.off} disabled={busy === 'off'} onChange={(on) => put('off', { apiOff: !on }, on ? 'Developer API switched on' : 'Developer API switched off')} />
        </div>
        <div className="setting-row">
          <div>
            <div className="st-label">API number</div>
            <div className="st-desc">
              {a.number?.phone
                ? `+${a.number.phone} · ${a.number.connected ? 'connected' : 'offline'} — used only for the API.`
                : a.number
                  ? 'Waiting for a QR scan on its Developer page.'
                  : 'None — its API sends from its default WhatsApp Gateway number.'}
            </div>
          </div>
          {a.number && (
            <button
              className="btn sm sa-warn"
              disabled={busy === 'unlink'}
              onClick={() => confirm(`Unlink ${a.number.phone ? '+' + a.number.phone : 'the API number'} from ${w.name}?\n\nIts keys on "Automatic" will send from the default Gateway number, and messages waiting for this number are cancelled.`) && put('unlink', { unlinkApiNumber: true }, 'API number unlinked')}
            >
              Unlink
            </button>
          )}
        </div>
        <div className="setting-row sa-dev-send">
          <div>
            <div className="st-label">Sending settings</div>
            <div className="st-desc">What its Developer page shows; inside your rules for every workspace.</div>
          </div>
          <div className="sa-dev-fields">
            {field('per_batch', 'At a time', a.bounds.per_batch, 'msgs')}
            {field('gap_seconds', 'Then wait', a.bounds.gap_seconds, 'sec')}
            {field('max_queue', 'Queue up to', a.bounds.max_queue, 'msgs')}
            <button className="btn sm primary" disabled={!dirty || busy === 'send'} onClick={() => put('send', { sending: { per_batch: Number(f.per_batch), gap_seconds: Number(f.gap_seconds), max_queue: Number(f.max_queue) } }, 'Sending settings saved')}>
              Save
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <div className="st-label">Queue</div>
            <div className="st-desc">{a.queued ? `${plural(a.queued, 'message')} waiting to go out.` : 'Nothing waiting.'}</div>
          </div>
          <button
            className="btn sm sa-warn"
            disabled={!a.queued || busy === 'q'}
            onClick={() => confirm(`Cancel all ${a.queued} waiting API messages in ${w.name}? They won't be sent.`) && put('q', { cancelQueue: true }, 'Queue cleared')}
          >
            Cancel all
          </button>
        </div>
      </div>
    </>
  );
}

// Add a person, or change someone's workspace, name, role and pages.
function PersonModal({ person, workspaces, defaultWs, onClose, onSaved }) {
  const { toast } = useApp();
  const isNew = !person;
  const [f, setF] = useState({
    name: person?.name || '',
    email: '',
    password: '',
    ws: person?.ws || defaultWs || workspaces[0]?.id || '',
    role: person?.role || 'member',
    pages: person ? [...person.pages] : PAGE_LIST.map(([id]) => id),
  });
  const [saving, setSaving] = useState(false);
  const toggle = (id) => setF((x) => ({ ...x, pages: x.pages.includes(id) ? x.pages.filter((p) => p !== id) : [...x.pages, id] }));
  const moving = !isNew && f.ws !== person.ws;

  async function save() {
    if (moving && !confirm(`Move ${person.name} to ${workspaces.find((w) => w.id === f.ws)?.name}? They're signed out and will only see that workspace from now on.`)) return;
    setSaving(true);
    try {
      if (isNew) await api.post('/auth/register', f);
      else await api.put(`/admin/users/${person.id}`, { name: f.name, role: f.role, pages: f.pages, ws: f.ws });
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
          <button className="btn primary" onClick={save} disabled={saving || !f.ws || (isNew && (!f.email || f.password.length < 6))}>
            {saving ? 'Saving…' : isNew ? 'Add person' : 'Save access'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Workspace</label>
        <select className="select" value={f.ws} onChange={(e) => setF({ ...f, ws: e.target.value })}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}{w.suspended ? ' (suspended)' : ''}</option>)}
        </select>
        <div className="hint">{moving ? 'They will be moved: signed out, and from then on they only see the new workspace.' : 'They only ever see this workspace — its numbers, contacts, campaigns and chats.'}</div>
      </div>
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
