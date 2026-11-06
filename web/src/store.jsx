import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { api, subscribe } from './api.js';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
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

  const refreshAuth = useCallback(async () => {
    try {
      const r = await api.get('/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
      await fetchStatus();
    } finally {
      setAuthChecked(true);
    }
  }, [fetchStatus]);

  const login = useCallback(async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    setUser(r.user);
    return r;
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

  // Live data + SSE only while authenticated.
  useEffect(() => {
    if (!user) return;
    refreshStats();
    refreshWa();
    const unsub = subscribe((ev, data) => {
      if (ev === 'wa:status') setWa(data);
      if (ev === 'stats:dirty' || ev === 'message:in' || ev === 'message:out') refreshStats();
      listeners.current.forEach((cb) => cb(ev, data));
    });
    const poll = setInterval(refreshStats, 20000);
    return () => {
      unsub();
      clearInterval(poll);
    };
  }, [user, refreshStats, refreshWa]);

  return (
    <AppCtx.Provider
      value={{
        user,
        authChecked,
        authStatus,
        login,
        register,
        logout,
        refreshAuth,
        fetchStatus,
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
