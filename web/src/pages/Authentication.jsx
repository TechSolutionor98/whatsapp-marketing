import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Empty, Loading, timeAgo, initials } from '../ui.jsx';

export const roleName = (role) => (role === 'owner' ? 'Super admin' : role === 'admin' ? 'Admin' : 'Member');

export default function Authentication({ go }) {
  const { user, logout, toast, workspace } = useApp();
  const isOwner = user?.role === 'owner';
  const isAdmin = user?.role === 'admin'; // admins manage members; the super admin manages everyone (Super Admin page)
  const [users, setUsers] = useState([]);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [savingPw, setSavingPw] = useState(false);

  const loadUsers = async () => {
    if (!isAdmin) return;
    try {
      setUsers(await api.get('/auth/users'));
    } catch {}
    finally {
      setUsersLoaded(true);
    }
  };
  useEffect(() => {
    loadUsers();
  }, [isAdmin]);

  async function changePassword() {
    if (pw.newPassword !== pw.confirm) return toast('New passwords do not match', 'error');
    setSavingPw(true);
    try {
      await api.post('/auth/change-password', pw);
      toast('Password updated — other devices were signed out', 'success');
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (e) {
      toast(e.message, 'error');
    }
    setSavingPw(false);
  }

  async function removeUser(u) {
    if (!confirm(`Remove ${u.email}?`)) return;
    try {
      await api.del('/auth/users/' + u.id);
      toast('Account removed');
      loadUsers();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  const roleBadge = (role) =>
    role === 'owner' ? 'green' : role === 'admin' ? 'blue' : 'gray';

  return (
    <div style={{ maxWidth: 760 }}>
      {/* Account */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.user style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Your account</h3><div className="sub">Signed-in identity</div></div>
          <button className="btn danger sm" style={{ marginLeft: 'auto' }} onClick={logout}>
            <Icon.logout /> Sign out
          </button>
        </div>
        <div className="card-pad">
          <div className="flex" style={{ gap: 14 }}>
            <div className="avatar" style={{ width: 52, height: 52, fontSize: 18 }}>
              {initials(user?.name, user?.email)}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{user?.name}</div>
              <div className="muted">{user?.email}</div>
              <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className={`badge ${roleBadge(user?.role)}`}>{roleName(user?.role)}</span>
                {!isOwner && workspace && <span className="chip" title="Your workspace">{workspace.name}</span>}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Change password */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.shield style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Change password</h3><div className="sub">Use a strong, unique password</div></div>
        </div>
        <div className="card-pad">
          <div className="field">
            <label>Current password</label>
            <input className="input" type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          </div>
          <div className="row">
            <div className="field">
              <label>New password</label>
              <input className="input" type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
            </div>
            <div className="field">
              <label>Confirm new</label>
              <input className="input" type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </div>
          </div>
          <div className="flex" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" onClick={changePassword} disabled={savingPw || !pw.currentPassword || !pw.newPassword}>
              <Icon.check /> {savingPw ? 'Saving…' : 'Update password'}
            </button>
          </div>
        </div>
      </div>

      {/* The super admin manages the team on the Super Admin page */}
      {isOwner && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">
            <Icon.crown style={{ width: 18, color: 'var(--brand-700)' }} />
            <div><h3>You're the super admin</h3><div className="sub">Create a workspace for each business, add people to it, choose what each one can open, and control every workspace.</div></div>
            <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={() => go?.('superadmin')}>
              Open Super Admin
            </button>
          </div>
        </div>
      )}

      {/* Team (admins: members only) */}
      {isAdmin && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">
            <Icon.users style={{ width: 18, color: 'var(--brand-700)' }} />
            <div><h3>Team members{workspace ? ` · ${workspace.name}` : ''}</h3><div className="sub">You can add and remove members of your workspace. Admins are managed by the super admin.</div></div>
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setShowAdd(true)}>
              <Icon.plus /> Add member
            </button>
          </div>
          {!usersLoaded ? (
            <div className="card-pad"><Loading label="Loading team…" minHeight={140} /></div>
          ) : users.length === 0 ? (
            <div className="card-pad"><Empty icon="users" title="Just you so far">Invite teammates to share the workspace.</Empty></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td className="cell-strong">
                        {u.name} {u.id === user.id && <span className="chip">you</span>}
                      </td>
                      <td className="cell-muted">{u.email}</td>
                      <td><span className={`badge ${roleBadge(u.role)}`}>{roleName(u.role)}</span></td>
                      <td className="cell-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}</td>
                      <td>
                        {u.role === 'member' && u.id !== user.id && (
                          <button className="btn ghost sm" onClick={() => removeUser(u)} style={{ float: 'right' }}>
                            <Icon.trash />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Security notice */}
      <div className="card" style={{ background: 'var(--surface-2)', border: 'none' }}>
        <div className="card-pad">
          <div className="flex" style={{ gap: 8, marginBottom: 6 }}>
            <Icon.shield style={{ width: 16, color: 'var(--brand-700)' }} />
            <strong style={{ fontSize: 13 }}>Accounts are stored in MongoDB</strong>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Passwords are hashed with bcrypt and sessions use a signed, http-only cookie. If you host
            this beyond your machine, put it behind HTTPS.
          </p>
        </div>
      </div>

      {showAdd && <AddUser onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); loadUsers(); }} />}
    </div>
  );
}

function AddUser({ onClose, onSaved }) {
  const { toast } = useApp();
  // Admins add members; the page each member can open is set by the super admin.
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'member' });
  async function save() {
    try {
      await api.post('/auth/register', f);
      toast('Member added', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  return (
    <Modal
      title="Add team member"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Add member</button></>}
    >
      <div className="field"><label>Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="field"><label>Email</label><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      <div className="field"><label>Temporary password</label><input className="input" type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="At least 6 characters" /><div className="hint">Share it with them; they can change it after signing in.</div></div>
    </Modal>
  );
}
