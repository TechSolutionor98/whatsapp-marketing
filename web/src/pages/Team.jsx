import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Loading, Empty, timeAgo, initials } from '../ui.jsx';
import { roleName } from './Authentication.jsx';

// The people of the open workspace and what each one can open. Changes apply at once — even
// to someone who is signed in right now.
export const PAGE_LIST = [
  ['overview', 'Overview', 'Dashboard and live numbers'],
  ['contacts', 'Contacts & Leads', 'Add, import and edit contacts'],
  ['templates', 'Templates', 'Write message templates'],
  ['campaigns', 'Campaigns', 'Create, start and pause campaigns'],
  ['warmup', 'Warmup', 'Number warm-up'],
  ['conversations', 'Conversations', 'Read and answer chats'],
  ['gateway', 'WhatsApp Gateway', 'Link and unlink numbers'],
  ['audit', 'Audit Logs', 'See what happened'],
  ['settings', 'Settings', 'Limits, AI and catalogs'],
];
const pageName = Object.fromEntries(PAGE_LIST.map(([id, label]) => [id, label]));

export default function Team() {
  const { user, workspace, toast } = useApp();
  const [data, setData] = useState(null); // { workspace, grantable, canAddAdmins, people }
  const [editing, setEditing] = useState(null); // a person, or 'new'
  const [pwFor, setPwFor] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setData(await api.get('/team'));
      setError('');
    } catch (e) {
      setError(e.message); // never pretend the team is empty when it couldn't be loaded
    }
  };
  useEffect(() => {
    load();
  }, []);

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
  const suspend = (u, on) => {
    if (on && !confirm(`Suspend ${u.name}?\n\nThey're signed out at once and can't sign in until you re-activate them.`)) return;
    act(u.id, () => api.post(`/team/${u.id}/suspend`, { suspended: on }), on ? `${u.name} suspended` : `${u.name} re-activated`);
  };
  const signOut = (u) => {
    if (!confirm(`Sign ${u.name} out on every device?`)) return;
    act(u.id, () => api.post(`/team/${u.id}/signout`), `${u.name} was signed out`);
  };
  const remove = (u) => {
    if (!confirm(`Remove ${u.name} (${u.email}) from the team? Their account is deleted.`)) return;
    act(u.id, () => api.del(`/team/${u.id}`), `${u.name} removed`);
  };

  if (!data && error) {
    return (
      <div className="card card-pad">
        <Empty icon="users" title="Couldn't load the team" action={<button className="btn" onClick={load}><Icon.refresh /> Try again</button>}>
          {error}
        </Empty>
      </div>
    );
  }
  if (!data) return <Loading label="Loading team…" minHeight={260} />;
  const people = data.people || [];
  const active = people.filter((p) => !p.suspended).length;

  return (
    <div className="team">
      <div className="card">
        <div className="card-head team-head">
          <Icon.users style={{ width: 18, color: 'var(--brand-700)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>Team · {data.workspace || workspace?.name}</h3>
            <div className="sub">
              {people.length ? `${people.length} ${people.length === 1 ? 'person' : 'people'} · ${active} active. ` : ''}
              Add people and choose exactly what each one can open — it applies at once, even if they're signed in.
            </div>
          </div>
          <button className="btn primary" onClick={() => setEditing('new')}><Icon.plus /> Add member</button>
        </div>

        {people.length === 0 ? (
          <div className="card-pad">
            <Empty icon="users" title="No team members yet" action={<button className="btn primary" onClick={() => setEditing('new')}><Icon.plus /> Add your first member</button>}>
              Add the people who work with you and pick what each one can open — for example only Conversations for an agent.
            </Empty>
          </div>
        ) : (
          <div className="team-list">
            {people.map((u) => (
              <div key={u.id} className={`team-row ${u.suspended ? 'off' : ''}`}>
                <div className="avatar" style={{ width: 38, height: 38, fontSize: 13 }}>{initials(u.name, u.email)}</div>
                <div className="team-who">
                  <div className="team-name">
                    {u.name}
                    {u.you && <span className="chip">you</span>}
                    <span className={`badge ${u.role === 'admin' ? 'blue' : 'gray'}`}>{roleName(u.role)}</span>
                    {u.suspended && <span className="badge red">Suspended</span>}
                  </div>
                  <div className="team-email">{u.email} · {u.lastLoginAt ? `signed in ${timeAgo(u.lastLoginAt)}` : 'never signed in'}</div>
                  <div className="team-pages">
                    {u.allPages ? (
                      <span className="chip team-all">Can open everything</span>
                    ) : u.pages.length === 0 ? (
                      <span className="chip sa-none">Can only open their own account</span>
                    ) : (
                      u.pages.map((p) => <span key={p} className="chip">{pageName[p]}</span>)
                    )}
                  </div>
                </div>
                <div className="team-actions">
                  {u.manageable ? (
                    <>
                      <button className="btn sm primary" onClick={() => setEditing(u)} disabled={busy === u.id}><Icon.edit /> Access</button>
                      <button className="btn sm ghost" onClick={() => setPwFor(u)}>Password</button>
                      <button className="btn sm ghost" onClick={() => signOut(u)}>Sign out</button>
                      {u.suspended ? (
                        <button className="btn sm" onClick={() => suspend(u, false)}>Activate</button>
                      ) : (
                        <button className="btn sm ghost sa-warn" onClick={() => suspend(u, true)}>Suspend</button>
                      )}
                      <button className="btn sm ghost" onClick={() => remove(u)} title="Remove from the team"><Icon.trash /></button>
                    </>
                  ) : (
                    <span className="cell-muted" style={{ fontSize: 12 }}>{u.you ? 'This is you' : 'Managed by the super admin'}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <MemberModal
          person={editing === 'new' ? null : editing}
          grantable={data.grantable}
          canAddAdmins={data.canAddAdmins}
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

// Add a member, or change someone's name, role and what they can open.
function MemberModal({ person, grantable, canAddAdmins, onClose, onSaved }) {
  const { toast } = useApp();
  const isNew = !person;
  const [f, setF] = useState({
    name: person?.name || '',
    email: '',
    password: '',
    role: person?.role || 'member',
    pages: person ? [...person.pages] : [...grantable],
  });
  const [saving, setSaving] = useState(false);
  const can = new Set(grantable);
  const toggle = (id) => setF((x) => ({ ...x, pages: x.pages.includes(id) ? x.pages.filter((p) => p !== id) : [...x.pages, id] }));

  async function save() {
    setSaving(true);
    try {
      if (isNew) await api.post('/team', f);
      else await api.put(`/team/${person.id}`, { name: f.name, role: f.role, pages: f.pages });
      toast(isNew ? `${f.name || f.email} added to the team` : 'Access saved', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
    setSaving(false);
  }

  return (
    <Modal
      title={isNew ? 'Add a team member' : `Access for ${person.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving || (isNew && (!f.email || f.password.length < 6))}>
            {saving ? 'Saving…' : isNew ? 'Add member' : 'Save access'}
          </button>
        </>
      }
    >
      <div className="row">
        <div className="field">
          <label>Name</label>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus={isNew} />
        </div>
        {canAddAdmins ? (
          <div className="field">
            <label>Role</label>
            <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="member">Member</option>
              <option value="admin">Admin — can also manage the team</option>
            </select>
          </div>
        ) : (
          <div className="field">
            <label>Role</label>
            <input className="input" value="Member" disabled />
          </div>
        )}
      </div>
      {isNew && (
        <div className="row">
          <div className="field">
            <label>Email (they sign in with it)</label>
            <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="input" type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="At least 6 characters" />
          </div>
        </div>
      )}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center' }}>
          What they can open
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, pages: [...new Set([...f.pages, ...grantable])] })}>Select all</button>
            <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, pages: f.pages.filter((p) => !can.has(p)) })}>Clear</button>
          </span>
        </label>
        <div className="team-checks">
          {PAGE_LIST.map(([id, label, desc]) => {
            const allowed = can.has(id);
            return (
              <label key={id} className={`team-check ${f.pages.includes(id) ? 'on' : ''} ${allowed ? '' : 'locked'}`} title={allowed ? '' : "You can't give this page — you can't open it yourself"}>
                <input type="checkbox" checked={f.pages.includes(id)} disabled={!allowed} onChange={() => toggle(id)} />
                <span>
                  <span className="team-check-name">{label}</span>
                  <span className="team-check-desc">{desc}</span>
                </span>
              </label>
            );
          })}
        </div>
        <div className="hint">Their own account page (name, password) is always open to them.</div>
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
      await api.post(`/team/${person.id}/password`, { password: pw });
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
        <div className="hint">{person.email} is signed out everywhere and signs in with this password. Share it with them.</div>
      </div>
    </Modal>
  );
}
