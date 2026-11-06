import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { timeAgo } from '../ui.jsx';

export default function Warmup() {
  const { toast, onBus } = useApp();
  const [status, setStatus] = useState(null);
  const [s, setS] = useState(null);
  const [log, setLog] = useState([]);
  const [aiAvail, setAiAvail] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [adding, setAdding] = useState(false);

  const loadStatus = async () => {
    try {
      setStatus(await api.get('/warmup/status'));
    } catch {}
  };
  const loadLog = async () => {
    try {
      setLog(await api.get('/warmup/log'));
    } catch {}
  };
  const loadCfg = async () => setS(await api.get('/settings'));

  useEffect(() => {
    loadStatus();
    loadLog();
    loadCfg();
    api.get('/ai/status').then((r) => setAiAvail(r.available)).catch(() => {});
    const t = setInterval(loadStatus, 3000);
    const t2 = setInterval(loadLog, 8000);
    const off = onBus((ev, data) => {
      if (ev === 'pool:update' && data) setStatus((st) => (st ? { ...st, accounts: data } : st));
      if (ev === 'warmup:update') {
        loadStatus();
        loadLog();
      }
    });
    return () => {
      clearInterval(t);
      clearInterval(t2);
      off();
    };
  }, []);

  async function addNumber() {
    setAdding(true);
    try {
      await api.post('/warmup/accounts', {});
      toast('Scan the QR to link this number', 'info');
      loadStatus();
    } catch (e) {
      toast(e.message, 'error');
    }
    setAdding(false);
  }
  async function removeNumber(id) {
    if (!confirm('Unlink this number from warm-up?')) return;
    await api.del('/warmup/accounts/' + id);
    toast('Number removed');
    loadStatus();
  }
  async function reconnect(id) {
    await api.post(`/warmup/accounts/${id}/reconnect`);
    toast('Reconnecting…');
    loadStatus();
  }
  async function toggle() {
    try {
      if (status.active) {
        await api.post('/warmup/stop');
        toast('Warm-up paused');
      } else {
        await api.post('/warmup/start');
        toast('Mutual warm-up started 🔥', 'success');
      }
      loadStatus();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function runOne() {
    const r = await api.post('/warmup/run');
    if (r.sent) toast('Warm-up chat sent', 'success');
    else if (r.need_two) toast('Need at least 2 connected numbers', 'error');
    else if (r.done_for_today) toast("Today's target reached", 'info');
    else if (r.outside_window) toast('Outside the warm-up window', 'info');
    else if (r.inactive) toast('Turn warm-up on first', 'info');
    else toast('Nothing to send right now', 'info');
    loadStatus();
    loadLog();
  }
  async function saveCfg() {
    setSavingCfg(true);
    try {
      await api.put('/settings', {
        warmupDailyStart: s.warmupDailyStart,
        warmupDailyStep: s.warmupDailyStep,
        warmupDailyMax: s.warmupDailyMax,
        warmupMinGap: s.warmupMinGap,
        warmupMaxGap: s.warmupMaxGap,
        warmupWindowStart: s.warmupWindowStart,
        warmupWindowEnd: s.warmupWindowEnd,
        warmupUseAi: s.warmupUseAi,
      });
      toast('Schedule saved', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    setSavingCfg(false);
  }

  if (!status || !s) return null;
  const accounts = status.accounts || [];
  const pct = status.dailyTarget ? Math.min(100, Math.round((status.sentToday / status.dailyTarget) * 100)) : 0;
  const setCfg = (k, v) => setS({ ...s, [k]: v });

  return (
    <>
      {/* Status hero */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-pad">
          <div className="flex between" style={{ alignItems: 'flex-start' }}>
            <div className="flex" style={{ gap: 14 }}>
              <div className="ico" style={{ position: 'static', width: 48, height: 48, borderRadius: 14, background: status.active ? 'var(--warn-soft)' : 'var(--surface-2)', color: status.active ? '#d97706' : 'var(--text-faint)' }}>
                <Icon.flame style={{ width: 24 }} />
              </div>
              <div>
                <div className="flex" style={{ gap: 8 }}>
                  <h2 style={{ fontSize: 20 }}>Mutual Number Warm-up</h2>
                  <span className={`badge ${status.active ? 'green' : 'gray'}`}>{status.active ? '● Running' : 'Paused'}</span>
                </div>
                <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                  {status.connected} of {accounts.length} numbers connected · Day {status.day} · {status.dailyTarget} msgs/day target · window {status.windowStart}–{status.windowEnd}
                </div>
              </div>
            </div>
            <div className="flex" style={{ gap: 8 }}>
              <button className="btn" onClick={runOne} disabled={status.connected < 2}><Icon.send /> Test one chat</button>
              <button className={`btn ${status.active ? 'warn' : 'primary'}`} onClick={toggle} disabled={accounts.length < 2}>
                {status.active ? <><Icon.pause /> Pause</> : <><Icon.play /> Start warm-up</>}
              </button>
            </div>
          </div>

          <div className="flex between" style={{ fontSize: 12.5, margin: '18px 0 6px' }}>
            <span className="muted">Today's progress</span>
            <span className="muted">{status.sentToday} / {status.dailyTarget} messages</span>
          </div>
          <div className="progress"><span style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#f59e0b,#f97316)' }} /></div>
          <div className="mini-stats" style={{ marginTop: 16 }}>
            <div className="mini-stat"><div className="v">{status.day}</div><div className="l">Day</div></div>
            <div className="mini-stat"><div className="v" style={{ color: '#d97706' }}>{status.sentToday}</div><div className="l">Sent today</div></div>
            <div className="mini-stat"><div className="v">{status.total}</div><div className="l">Total</div></div>
            <div className="mini-stat"><div className="v">{status.connected}</div><div className="l">Connected</div></div>
          </div>
          {accounts.length < 2 && (
            <div className="auth-note" style={{ marginTop: 14 }}>
              Link at least <strong>2 numbers</strong> below (ideally 3–5) — they'll message each other to build organic activity.
            </div>
          )}
        </div>
      </div>

      {/* Linked numbers */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.gateway style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Linked numbers</h3><div className="sub">Scan a QR for each number you want to warm up</div></div>
          <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={addNumber} disabled={adding}>
            <Icon.plus /> {adding ? 'Adding…' : 'Add number'}
          </button>
        </div>
        <div className="card-pad">
          {accounts.length === 0 ? (
            <div className="empty">
              <div className="emoji"><Icon.flame /></div>
              <h3>No numbers linked yet</h3>
              <p style={{ maxWidth: 440, margin: '0 auto' }}>Add 3–5 numbers you own. Each one scans a QR (like WhatsApp Web). Then they chat with each other automatically.</p>
              <div style={{ marginTop: 16 }}><button className="btn primary" onClick={addNumber} disabled={adding}><Icon.plus /> Add your first number</button></div>
            </div>
          ) : (
            <div className="grid-cards">
              {accounts.map((a, i) => (
                <NumberCard key={a.id} acct={a} index={i} onRemove={() => removeNumber(a.id)} onReconnect={() => reconnect(a.id)} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid-2">
        {/* Schedule */}
        <div className="card">
          <div className="card-head">
            <Icon.settings style={{ width: 18, color: 'var(--brand-700)' }} />
            <div><h3>Warm-up schedule</h3><div className="sub">Start slow, ramp up daily</div></div>
          </div>
          <div className="card-pad" style={{ paddingTop: 4 }}>
            <div className="setting-row"><div><div className="st-label">Start / day</div><div className="st-desc">Messages on day one.</div></div><input type="number" className="input" style={{ width: 90 }} value={s.warmupDailyStart} onChange={(e) => setCfg('warmupDailyStart', +e.target.value)} /></div>
            <div className="setting-row"><div><div className="st-label">Increase / day</div><div className="st-desc">Added to the daily target each day.</div></div><input type="number" className="input" style={{ width: 90 }} value={s.warmupDailyStep} onChange={(e) => setCfg('warmupDailyStep', +e.target.value)} /></div>
            <div className="setting-row"><div><div className="st-label">Max / day</div><div className="st-desc">Daily ceiling across all numbers.</div></div><input type="number" className="input" style={{ width: 90 }} value={s.warmupDailyMax} onChange={(e) => setCfg('warmupDailyMax', +e.target.value)} /></div>
            <div className="setting-row"><div><div className="st-label">Gap between chats</div><div className="st-desc">Random wait, seconds.</div></div><div className="flex" style={{ gap: 6 }}><input type="number" className="input" style={{ width: 80 }} value={s.warmupMinGap} onChange={(e) => setCfg('warmupMinGap', +e.target.value)} /><span className="muted">to</span><input type="number" className="input" style={{ width: 80 }} value={s.warmupMaxGap} onChange={(e) => setCfg('warmupMaxGap', +e.target.value)} /></div></div>
            <div className="setting-row"><div><div className="st-label">Active window</div><div className="st-desc">Only warm up during these hours.</div></div><div className="flex" style={{ gap: 6 }}><input type="time" className="input" style={{ width: 110 }} value={s.warmupWindowStart} onChange={(e) => setCfg('warmupWindowStart', e.target.value)} /><span className="muted">–</span><input type="time" className="input" style={{ width: 110 }} value={s.warmupWindowEnd} onChange={(e) => setCfg('warmupWindowEnd', e.target.value)} /></div></div>
            {aiAvail && (
              <div className="setting-row">
                <div><div className="st-label">Use AI for chats ✨</div><div className="st-desc">Groq writes natural, non-repeating conversations instead of built-in phrases.</div></div>
                <label className="switch"><input type="checkbox" checked={s.warmupUseAi !== false} onChange={(e) => setCfg('warmupUseAi', e.target.checked)} /><span className="slider" /></label>
              </div>
            )}
            <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button className="btn primary" onClick={saveCfg} disabled={savingCfg}><Icon.check /> {savingCfg ? 'Saving…' : 'Save schedule'}</button></div>
          </div>
        </div>

        {/* Activity feed */}
        <div className="card">
          <div className="card-head">
            <Icon.chat style={{ width: 18, color: 'var(--brand-700)' }} />
            <div><h3>Recent warm-up chats</h3><div className="sub">Live conversations between your numbers</div></div>
          </div>
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {log.length === 0 ? (
              <div className="empty" style={{ padding: 40 }}><div className="emoji"><Icon.chat /></div><h3>No chats yet</h3><p>Start warm-up with 2+ connected numbers.</p></div>
            ) : (
              log.map((m) => (
                <div key={m.id} className="log-row">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5 }}><strong>+{m.from_phone}</strong> <span className="muted">→</span> <strong>+{m.to_phone}</strong></div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{m.body}</div>
                  </div>
                  <div className="log-time">{timeAgo(m.created_at)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ background: 'var(--surface-2)', border: 'none', marginTop: 18 }}>
        <div className="card-pad">
          <div className="flex" style={{ gap: 8, marginBottom: 6 }}>
            <Icon.flame style={{ width: 16, color: '#d97706' }} />
            <strong style={{ fontSize: 13 }}>How mutual warm-up works</strong>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Link 3–5 numbers you own. The app connects to each (via its own QR, like WhatsApp Web) and then
            has them send friendly, varied messages <em>to one another</em> — with real back-and-forth replies —
            slowly ramping up each day inside your chosen hours. This builds a natural activity history so the
            numbers look like genuine, active accounts before you ever run cold campaigns.
          </p>
        </div>
      </div>
    </>
  );
}

function NumberCard({ acct, index, onRemove, onReconnect }) {
  const st = acct.status;
  return (
    <div className="camp-card" style={{ position: 'relative' }}>
      <div className="flex between">
        <strong style={{ fontSize: 14 }}>{acct.label || `Number ${index + 1}`}</strong>
        <button className="btn ghost sm" onClick={onRemove} title="Remove"><Icon.trash /></button>
      </div>

      {st === 'connected' && (
        <div style={{ textAlign: 'center', padding: '14px 0 4px' }}>
          <div className="pulse-ring" style={{ width: 60, height: 60, margin: '0 auto 12px' }}><Icon.check style={{ width: 26 }} /></div>
          <div style={{ fontWeight: 700 }}>{acct.me?.name || 'Connected'}</div>
          <div className="muted" style={{ fontSize: 13 }}>+{acct.me?.phone}</div>
          <span className="badge green" style={{ marginTop: 8 }}>● Connected</span>
        </div>
      )}

      {st === 'qr' && acct.qr && (
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <div className="qr-box" style={{ width: 200, height: 200, margin: '0 auto' }}>
            <img src={acct.qr} alt="QR" style={{ width: 180, height: 180 }} />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>WhatsApp → Linked Devices → Link a device → scan</div>
        </div>
      )}

      {st === 'connecting' && (
        <div style={{ textAlign: 'center', padding: '30px 0' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />
          <div className="muted" style={{ fontSize: 13 }}>Connecting… QR appears shortly</div>
        </div>
      )}

      {st === 'disconnected' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <span className="badge gray">Disconnected</span>
          <div style={{ marginTop: 12 }}><button className="btn sm" onClick={onReconnect}><Icon.link /> Reconnect</button></div>
          {acct.lastError && <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>{acct.lastError}</div>}
        </div>
      )}
    </div>
  );
}
