import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { api, subscribe, getWorkspace, setWorkspace } from './api.js';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [workspace, setWs] = useState(null); // { id, name, suspended, main } — the one this tab works in
  const [workspaces, setWorkspaces] = useState([]); // super admin: every workspace
  const [limits, setLimits] = useState({}); // the super admin's rules for every workspace
  const [authChecked, setAuthChecked] = useState(false);
  const [authStatus, setAuthStatus] = useState(null); // { mongoConnected, hasUsers, error }
  const [wa, setWa] = useState({ status: 'disconnected', qr: null, me: null });
  const [stats, setStats] = useState({});
  const [toasts, setToasts] = useState([]);
  const listeners = useRef(new Set());

  const toast = useCallback((message, type = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api.get('/stats'));
    } catch {}
  }, []);
  const refreshWa = useCallback(async () => {
    try {
      setWa(await api.get('/wa/status'));
    } catch {}
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      setAuthStatus(await api.get('/auth/status'));
    } catch {
      setAuthStatus({ mongoConnected: false, hasUsers: false });
    }
  }, []);

  // Who is signed in and which workspace this tab shows (the server corrects a workspace that
  // no longer exists, or one a non-super-admin can't open).
  const applySession = useCallback((r) => {
    setUser((prev) => (JSON.stringify(prev) === JSON.stringify(r.user) ? prev : r.user));
    if (r.workspace) {
      setWs((prev) => (JSON.stringify(prev) === JSON.stringify(r.workspace) ? prev : r.workspace));
      if (r.user?.role === 'owner' && getWorkspace() !== r.workspace.id) setWorkspace(r.workspace.id);
    }
    setWorkspaces((prev) => {
      const next = r.workspaces || [];
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
    if (r.limits) setLimits((prev) => (JSON.stringify(prev) === JSON.stringify(r.limits) ? prev : r.limits));
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      applySession(await api.get('/auth/me'));
    } catch {
      setUser(null);
      await fetchStatus();
    } finally {
      setAuthChecked(true);
    }
  }, [fetchStatus, applySession]);

  const login = useCallback(async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    applySession(r);
    return r;
  }, [applySession]);

  // Public sign-up: a new business gets its own workspace. When the super admin approves new
  // sign-ups first, nobody is signed in yet (r.pending).
  const signup = useCallback(async (payload) => {
    const r = await api.post('/auth/signup', payload);
    if (r.user) {
      window.location.hash = '/overview';
      applySession(r);
    }
    return r;
  }, [applySession]);

  // The code from the sign-up email → the account is created (and signed in, unless it
  // waits for the super admin's approval).
  const verifySignup = useCallback(async (email, code) => {
    const r = await api.post('/auth/signup/verify', { email, code });
    if (r.user) {
      window.location.hash = '/overview';
      applySession(r);
    }
    return r;
  }, [applySession]);

  // Forgot password: the emailed code + a new password → signed in (unless the account or
  // its workspace can't be used right now).
  const resetPassword = useCallback(async (email, code, password) => {
    const r = await api.post('/auth/reset', { email, code, password });
    if (r.user) {
      window.location.hash = '/overview';
      applySession(r);
    }
    return r;
  }, [applySession]);

  // Super admin: open another workspace. A fresh load guarantees nothing from the previous
  // workspace stays on screen.
  const switchWorkspace = useCallback((id, page = 'overview') => {
    setWorkspace(id);
    window.location.hash = `/${page}`;
    window.location.reload();
  }, []);

  const register = useCallback(async (payload) => {
    const r = await api.post('/auth/register', payload);
    if (r.bootstrapped && r.user) setUser(r.user);
    return r;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {}
    setUser(null);
    fetchStatus();
  }, [fetchStatus]);

  // Can this user open a page? The super admin (owner) can open everything; everyone else
  // gets the pages the super admin gave them. Your own account page is always open.
  const can = useCallback(
    (page) => {
      if (!user) return false;
      if (page === 'auth') return true;
      if (page === 'superadmin') return user.role === 'owner';
      if (page === 'team') return user.role === 'owner' || user.role === 'admin'; // admins manage their team
      return user.role === 'owner' || (user.pages || []).includes(page);
    },
    [user]
  );

  const onBus = useCallback((cb) => {
    listeners.current.add(cb);
    return () => listeners.current.delete(cb);
  }, []);

  // Initial auth check.
  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  // If a session expires mid-use, drop to the login screen.
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      fetchStatus();
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [fetchStatus]);

  // Pick up changes the super admin makes (pages, role) without signing out and in again.
  const signedIn = !!user;
  useEffect(() => {
    if (!signedIn) return;
    const recheck = async () => {
      try {
        applySession(await api.get('/auth/me'));
      } catch {}
    };
    const t = setInterval(recheck, 60000);
    window.addEventListener('auth:changed', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      clearInterval(t);
      window.removeEventListener('auth:changed', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, [signedIn, applySession]);

  // Live data + SSE only while authenticated.
  useEffect(() => {
    if (!user) return;
    refreshStats();
    refreshWa();
    let waTimer = null;
    const unsub = subscribe((ev, data) => {
      if (ev === 'wa:status') setWa((prev) => ({ ...data, main: true, workerPaused: prev.workerPaused }));
      // A workspace without the main number: its connection is its own numbers' status.
      if (ev === 'pool:update') {
        clearTimeout(waTimer);
        waTimer = setTimeout(refreshWa, 800);
      }
      if (ev === 'stats:dirty' || ev === 'message:in' || ev === 'message:out') refreshStats();
      listeners.current.forEach((cb) => cb(ev, data));
    });
    const poll = setInterval(refreshStats, 20000);
    return () => {
      unsub();
      clearInterval(poll);
      clearTimeout(waTimer);
    };
  }, [user, refreshStats, refreshWa]);

  return (
    <AppCtx.Provider
      value={{
        user,
        workspace,
        workspaces,
        switchWorkspace,
        limits,
        authChecked,
        authStatus,
        login,
        signup,
        verifySignup,
        resetPassword,
        register,
        logout,
        refreshAuth,
        fetchStatus,
        can,
        wa,
        stats,
        toast,
        refreshStats,
        refreshWa,
        onBus,
      }}
    >
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.type === 'error' ? 'err' : t.type === 'success' ? 'ok' : ''}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}
