import { useEffect, useState } from 'react';
import { AppProvider, useApp } from './store.jsx';
import { Icon } from './icons.jsx';
import { api } from './api.js';
import AuthGate from './AuthGate.jsx';

import Overview from './pages/Overview.jsx';
import Contacts from './pages/Contacts.jsx';
import Templates from './pages/Templates.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Warmup from './pages/Warmup.jsx';
import Conversations from './pages/Conversations.jsx';
import Gateway from './pages/Gateway.jsx';
import Audit from './pages/Audit.jsx';
import Settings from './pages/Settings.jsx';
import Authentication from './pages/Authentication.jsx';
import SuperAdmin from './pages/SuperAdmin.jsx';
import Team from './pages/Team.jsx';
import Developer from './pages/Developer.jsx';

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'grid', group: 'Operations' },
  { id: 'contacts', label: 'Contacts & Leads', icon: 'users', group: 'Operations' },
  { id: 'templates', label: 'Templates', icon: 'template', group: 'Operations' },
  { id: 'campaigns', label: 'Campaigns', icon: 'megaphone', group: 'Operations' },
  { id: 'warmup', label: 'Warmup', icon: 'flame', group: 'Operations' },
  { id: 'conversations', label: 'Conversations', icon: 'chat', group: 'Operations' },
  { id: 'gateway', label: 'WhatsApp Gateway', icon: 'gateway', group: 'System' },
  { id: 'developer', label: 'Developer', icon: 'code', group: 'System' },
  { id: 'audit', label: 'Audit Logs', icon: 'logs', group: 'System' },
  { id: 'settings', label: 'Settings', icon: 'settings', group: 'System' },
  { id: 'team', label: 'Team', icon: 'users', group: 'System' },
  { id: 'auth', label: 'Authentication', icon: 'shield', group: 'System' },
  { id: 'superadmin', label: 'Super Admin', icon: 'crown', group: 'System' },
];

const PAGES = {
  overview: Overview,
  contacts: Contacts,
  templates: Templates,
  campaigns: Campaigns,
  warmup: Warmup,
  conversations: Conversations,
  gateway: Gateway,
  developer: Developer,
  audit: Audit,
  settings: Settings,
  auth: Authentication,
  team: Team,
  superadmin: SuperAdmin,
};

const TITLES = {
  overview: ['Dashboard', 'Live view of your campaigns, chats and numbers'],
  contacts: ['Contacts & Leads', 'Your audience database'],
  templates: ['Message Templates', 'Reusable messages with variables & spin text'],
  campaigns: ['Campaigns', 'Paced, window-aware outreach runs'],
  warmup: ['Number Warmup', 'Build organic activity before cold outreach'],
  conversations: ['Conversations', 'Replies and human handoffs'],
  gateway: ['WhatsApp Gateway', 'Link, unlink and choose your default number'],
  developer: ['Developer', 'API keys and guides to send WhatsApp messages from your own software'],
  audit: ['Audit Logs', 'Every action, send and reply'],
  settings: ['Settings', 'Pacing, limits and safety controls'],
  auth: ['Authentication', 'Your account'],
  team: ['Team', 'Add members and choose what each one can open'],
  superadmin: ['Super Admin', 'Every workspace, every person — the whole platform'],
};

function connLabel(status) {
  if (status === 'connected') return { text: 'Connected', cls: 'on' };
  if (status === 'qr') return { text: 'Awaiting QR scan', cls: 'warn' };
  if (status === 'connecting') return { text: 'Connecting…', cls: 'warn' };
  return { text: 'Disconnected', cls: 'off' };
}

// Which workspace (business) this tab works in. The super admin switches between all of them;
// everyone else sees the one they belong to.
function WorkspaceSwitch({ go }) {
  const { user, workspace, workspaces, switchWorkspace } = useApp();
  const [open, setOpen] = useState(false);
  if (!workspace) return null;
  const owner = user?.role === 'owner';
  if (!owner) {
    return (
      <div className="ws-switch static" title="Your workspace">
        <span className="ws-ico"><Icon.briefcase /></span>
        <span className="ws-name">{workspace.name}</span>
      </div>
    );
  }
  return (
    <div className="ws-wrap">
      <button className={`ws-switch ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)} title="Switch workspace">
        <span className="ws-ico"><Icon.briefcase /></span>
        <span className="ws-text">
          <span className="ws-cap">Workspace</span>
          <span className="ws-name">{workspace.name}</span>
        </span>
        <Icon.chevronDown className="ws-caret" />
      </button>
      {open && (
        <>
          <div className="ws-backdrop" onClick={() => setOpen(false)} />
          <div className="ws-menu" role="menu">
            {workspaces.map((w) => (
              <button
                key={w.id}
                role="menuitem"
                className={`ws-item ${w.id === workspace.id ? 'current' : ''}`}
                onClick={() => {
                  setOpen(false);
                  if (w.id !== workspace.id) switchWorkspace(w.id);
                }}
              >
                <span className="ws-item-name">{w.name}</span>
                {w.suspended && <span className="ws-tag off">Suspended</span>}
                {w.id === workspace.id && <Icon.check className="ws-tick" />}
              </button>
            ))}
            <button
              className="ws-item manage"
              onClick={() => {
                setOpen(false);
                go('superadmin');
              }}
            >
              <Icon.crown /> Manage workspaces
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Sidebar({ page, go }) {
  const { wa, stats, user, logout, can } = useApp();
  const conn = connLabel(wa.status);
  const nav = NAV.filter((n) => can(n.id)); // only the pages this user may open
  const groups = [...new Set(nav.map((n) => n.group))];
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">
          <img src="/logo.png" alt="Tech Watsapi" />
        </div>
      </div>

      <WorkspaceSwitch go={go} />

      {groups.map((g) => (
        <div key={g}>
          <div className="nav-section">{g}</div>
          {nav.filter((n) => n.group === g).map((n) => {
            const I = Icon[n.icon];
            const active = page === n.id;
            return (
              <button
                key={n.id}
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => go(n.id)}
              >
                <I />
                <span>{n.label}</span>
                {n.id === 'conversations' && stats.handoffs > 0 && (
                  <span className="nav-badge">{stats.handoffs}</span>
                )}
                {n.id === 'gateway' && wa.status !== 'connected' && (
                  <span className={`dot ${conn.cls}`} style={{ marginLeft: 'auto' }} />
                )}
              </button>
            );
          })}
        </div>
      ))}

      <div className="sidebar-foot">
        <div className="acct">
          <span className={`dot ${conn.cls}`} />
          {wa.me ? wa.me.name || '+' + wa.me.phone : 'No number linked'}
        </div>
        <div className="sb-user">
          <div className="avatar" style={{ width: 32, height: 32, fontSize: 12 }}>
            {(user?.name || user?.email || '?').slice(0, 2).toUpperCase()}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="sb-user-name">{user?.name}</div>
            <div className="sb-user-email">{user?.email}</div>
          </div>
          <button className="sb-logout" title="Sign out" onClick={logout}>
            <Icon.logout />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ page, go }) {
  const { wa, refreshStats, refreshWa, toast, can } = useApp();
  const [busy, setBusy] = useState(false);
  const conn = connLabel(wa.status);
  const [title, sub] = TITLES[page] || ['', ''];

  async function runCycle() {
    setBusy(true);
    try {
      const r = await api.post('/worker/cycle');
      if (r.sent) toast('Message sent this cycle', 'success');
      else if (r.paused) toast('Sending is paused (Super Admin → Campaign sending)', 'info');
      else if (r.reason === 'not_connected') toast('Link WhatsApp first', 'error');
      else if (r.info?.reason === 'global_cap') toast('Daily safety cap reached', 'info');
      else toast('Nothing eligible to send right now', 'info');
      refreshStats();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }

  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        <div className="page-sub">{sub}</div>
      </div>
      <div className="topbar-actions">
        {/* Pages can inject their own controls here (e.g. Conversations filters). */}
        <span id="topbar-slot" className="topbar-slot" />
        <button
          className="conn-pill"
          onClick={() => can('gateway') && go('gateway')}
          title="WhatsApp connection"
        >
          <span className={`dot ${conn.cls}`} />
          {conn.text}
        </button>
        <button className="btn" onClick={() => { refreshStats(); refreshWa(); toast('Refreshed'); }}>
          <Icon.refresh /> Refresh
        </button>
        {can('campaigns') && (
          <button className="btn primary" onClick={runCycle} disabled={busy}>
            <Icon.bolt /> {busy ? 'Running…' : 'Run Worker Cycle'}
          </button>
        )}
      </div>
    </div>
  );
}

function Shell() {
  const [page, setPage] = useState(
    () => (window.location.hash.replace('#/', '') || 'overview')
  );
  const go = (id) => {
    window.location.hash = `/${id}`;
    setPage(id);
  };
  useEffect(() => {
    const onHash = () => setPage(window.location.hash.replace('#/', '') || 'overview');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // A page this user may not open (or an unknown one) → their first allowed page.
  const { can } = useApp();
  const allowed = !!PAGES[page] && can(page);
  useEffect(() => {
    if (!allowed) go(NAV.find((n) => can(n.id))?.id || 'auth');
  }, [allowed]);

  const Page = allowed ? PAGES[page] : null;
  const { workspace, user } = useApp();
  return (
    <div className="app">
      <Sidebar page={page} go={go} />
      <div className="main">
        <Topbar page={page} go={go} />
        <div className="content">
          {workspace?.suspended && user?.role === 'owner' && page !== 'superadmin' && (
            <div className="ws-banner">
              <Icon.pause /> <strong>{workspace.name} is suspended.</strong> Its team can't sign in and nothing is sent
              automatically. Re-activate it on the Super Admin page.
            </div>
          )}
          {Page && <Page key={workspace?.id || 'ws'} go={go} />}
        </div>
      </div>
    </div>
  );
}

function Root() {
  const { user, authChecked } = useApp();
  if (!authChecked) {
    return (
      <div className="auth-screen">
        <div className="spinner" />
      </div>
    );
  }
  if (!user) return <AuthGate />;
  return <Shell />;
}

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}
