import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { initials, PasswordInput } from '../ui.jsx';

export const roleName = (role) => (role === 'owner' ? 'Super admin' : role === 'admin' ? 'Admin' : 'Member');

export default function Authentication({ go }) {
  const { user, logout, toast, workspace } = useApp();
  const isOwner = user?.role === 'owner';
  const isAdmin = user?.role === 'admin'; // admins manage members; the super admin manages everyone (Super Admin page)
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [savingPw, setSavingPw] = useState(false);

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
            <PasswordInput value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} autoComplete="current-password" />
          </div>
          <div className="row">
            <div className="field">
              <label>New password</label>
              <PasswordInput value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} autoComplete="new-password" />
            </div>
            <div className="field">
              <label>Confirm new</label>
              <PasswordInput value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
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
            <div><h3>You're the super admin</h3><div className="sub">Add people to the open workspace on the Team page, or manage every business on Super Admin.</div></div>
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => go?.('team')}>
              Team
            </button>
            <button className="btn primary sm" onClick={() => go?.('superadmin')}>
              Open Super Admin
            </button>
          </div>
        </div>
      )}

      {/* The team (and what each person can open) is on the Team page */}
      {isAdmin && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">
            <Icon.users style={{ width: 18, color: 'var(--brand-700)' }} />
            <div><h3>Your team</h3><div className="sub">Add members{workspace ? ` to ${workspace.name}` : ''} and choose what each one can open.</div></div>
            <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={() => go?.('team')}>
              Open Team
            </button>
          </div>
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

    </div>
  );
}
