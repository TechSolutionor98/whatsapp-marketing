import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Empty, Loading, StatusBadge, clockTime, timeAgo, initials } from '../ui.jsx';

function Ticks({ status }) {
  if (status === 'read') return <span style={{ color: '#53bdeb' }}>✓✓</span>;
  if (status === 'delivered') return <span>✓✓</span>;
  return <span>✓</span>; // sent / unknown
}

// Get the header's action slot so page-specific controls render up in the top bar.
function useHeaderSlot() {
  const [node, setNode] = useState(null);
  useEffect(() => {
    setNode(document.getElementById('topbar-slot'));
  }, []);
  return node;
}

function asDate(iso) {
  if (!iso) return null;
  return new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
}
function sameDay(a, b) {
  return a && b && a.toDateString() === b.toDateString();
}
// "Today" / "Yesterday" / "5 Nov" divider label for a message.
function dayDivider(iso) {
  const d = asDate(iso);
  if (!d) return '';
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });
}

export default function Conversations({ go }) {
  const { toast, onBus, wa } = useApp();
  const [threads, setThreads] = useState([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(null); // contactId
  const [thread, setThread] = useState(null); // {contact, messages}
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [aiAvail, setAiAvail] = useState(false);
  const [autoReply, setAutoReply] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accounts, setAccounts] = useState([{ id: 'main', label: 'Main number', phone: null, connected: false }]);
  const [account, setAccount] = useState('main'); // active account tab
  const msgsRef = useRef(null);

  const loadAccounts = async () => {
    try {
      const a = await api.get('/conversations/accounts');
      if (a.length) setAccounts(a);
    } catch {}
  };

  async function renameTab(a) {
    const name = prompt('Name this number (so you remember which WhatsApp it is)', a.label || '');
    if (name == null) return;
    try {
      await api.put(`/conversations/accounts/${a.id}/label`, { label: name.trim() });
      loadAccounts();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  useEffect(() => {
    (async () => {
      try {
        setAiAvail((await api.get('/ai/status')).available);
        setAutoReply(!!(await api.get('/settings')).autoReplyEnabled);
      } catch {}
    })();
    loadAccounts();
    const t = setInterval(loadAccounts, 15000);
    return () => clearInterval(t);
  }, []);

  async function toggleAutoReply() {
    const v = !autoReply;
    setAutoReply(v);
    try {
      await api.put('/settings', { autoReplyEnabled: v });
      toast(v ? 'AI auto-reply is ON' : 'AI auto-reply is OFF', v ? 'success' : 'info');
    } catch (e) {
      toast(e.message, 'error');
      setAutoReply(!v);
    }
  }

  const loadThreads = async () => {
    const params = new URLSearchParams({ account });
    if (filter) params.set('filter', filter);
    try {
      setThreads(await api.get('/conversations?' + params));
    } finally {
      setThreadsLoaded(true);
    }
  };
  const loadThread = async (id) => {
    if (!id) return;
    const t = await api.get(`/conversations/${id}?account=${account}`);
    setThread(t);
    setTimeout(() => {
      if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
    }, 50);
  };

  useEffect(() => {
    loadThreads();
  }, [filter, account]);
  // Switching account closes the open thread (it belongs to a different number).
  useEffect(() => {
    setActive(null);
    setThread(null);
  }, [account]);
  useEffect(() => {
    loadThread(active);
  }, [active]);

  // Live refresh on inbound/outbound events.
  useEffect(() => {
    return onBus((ev, data) => {
      if (ev === 'message:in' || ev === 'message:out') {
        loadThreads();
        if (active && (!data.contactId || data.contactId === active)) loadThread(active);
      }
      if (ev === 'message:status' && active) loadThread(active);
    });
  }, [active, filter, account]);

  async function send() {
    if (!draft.trim() || !thread) return;
    setSending(true);
    try {
      await api.post(`/conversations/${thread.contact.id}/reply`, { body: draft, account });
      setDraft('');
      loadThread(thread.contact.id);
      loadThreads();
    } catch (e) {
      toast(e.message, 'error');
    }
    setSending(false);
  }

  async function resolve() {
    await api.post(`/conversations/${thread.contact.id}/resolve`);
    toast('Handoff resolved', 'success');
    loadThread(thread.contact.id);
    loadThreads();
  }

  const activeAcct = accounts.find((a) => a.id === account);
  const acctConnected = account === 'main' ? wa.status === 'connected' : !!activeAcct?.connected;

  const q = search.trim().toLowerCase();
  const shown = !q
    ? threads
    : threads.filter(
        (t) =>
          (t.name || '').toLowerCase().includes(q) ||
          (t.phone || '').includes(search.trim()) ||
          (t.last_message || '').toLowerCase().includes(q)
      );

  const headerSlot = useHeaderSlot();
  const controls = (
    <div className="conv-header-ctrls">
      <div className="wa-filters">
        {[['', 'All'], ['unread', 'Unread'], ['groups', 'Groups'], ['handoff', 'Needs human']].map(([v, label]) => (
          <button key={v || 'all'} className={`wa-pill ${filter === v ? 'active' : ''}`} onClick={() => setFilter(v)}>
            {v === 'handoff' && <Icon.warn style={{ width: 13, verticalAlign: '-2px' }} />} {label}
          </button>
        ))}
      </div>
      {aiAvail && (
        <>
          <button
            className={`btn sm ${autoReply ? 'primary' : ''}`}
            onClick={toggleAutoReply}
            title="When on, AI answers incoming replies automatically"
          >
            <Icon.sparkles /> AI auto-reply: {autoReply ? 'On' : 'Off'}
          </button>
          <button className="btn sm" onClick={() => setShowAiSettings(true)} title="AI auto-reply settings">
            <Icon.settings />
          </button>
        </>
      )}
    </div>
  );

  return (
    <>
      {headerSlot ? createPortal(controls, headerSlot) : null}
      {showAiSettings && (
        <AiReplySettings
          onClose={() => setShowAiSettings(false)}
          onSaved={(enabled) => { setShowAiSettings(false); if (enabled !== undefined) setAutoReply(enabled); }}
        />
      )}

      <div className="wa-tabs">
        {accounts.map((a) => (
          <button
            key={a.id}
            className={`wa-tab ${account === a.id ? 'active' : ''} ${a.connected ? '' : 'off'}`}
            onClick={() => setAccount(a.id)}
            onDoubleClick={() => renameTab(a)}
            title={`${a.phone ? '+' + a.phone : 'Not linked'} · double-click to rename`}
          >
            <span className={`wa-tab-dot ${a.connected ? 'on' : ''}`} />
            <span className="wa-tab-label">
              {a.label || (a.id === 'main' ? 'Main number' : 'Number')}
              {a.phone ? ` · +${a.phone}` : ''}
            </span>
          </button>
        ))}
        <button className="wa-tab add" onClick={() => setShowAddAccount(true)} title="Link another WhatsApp number for chats">
          <Icon.plus />
        </button>
      </div>
      {showAddAccount && (
        <AddAccountModal
          onClose={() => setShowAddAccount(false)}
          onLinked={(id) => { setShowAddAccount(false); loadAccounts(); if (id) setAccount(id); }}
        />
      )}

      <div className="chat-layout">
        <div className="thread-list">
          <div className="thread-search">
            <Icon.search />
            <input
              className="input"
              placeholder="Search chats…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!threadsLoaded ? (
            <Loading label="Loading chats…" minHeight={200} />
          ) : threads.length === 0 ? (
            <div style={{ padding: 30 }}>
              <Empty icon="chat" title="No conversations">
                Replies and your WhatsApp chats appear here.
              </Empty>
            </div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 30 }}>
              <Empty icon="search" title="No matches">No chat matches “{search}”.</Empty>
            </div>
          ) : (
            shown.map((t) => (
              <div
                key={t.id}
                className={`thread-item ${active === t.id ? 'active' : ''}`}
                onClick={() => setActive(t.id)}
              >
                <div className="avatar lg">{initials(t.name, t.phone)}</div>
                <div className="thread-main">
                  <div className="thread-row1">
                    <span className="thread-name-txt">
                      {t.is_group === 1 && <Icon.users style={{ width: 13, opacity: 0.6, verticalAlign: '-2px', marginRight: 4 }} />}
                      {t.name || (t.is_group ? 'Group chat' : '+' + t.phone)}
                    </span>
                    <span className={`thread-time ${t.unread > 0 ? 'unread' : ''}`}>{timeAgo(t.last_at)}</span>
                  </div>
                  <div className="thread-row2">
                    <span className="thread-preview">
                      {t.last_direction === 'out' && <span className="preview-tick"><Ticks status={t.last_status} /> </span>}
                      {t.is_group === 1 && t.last_direction === 'in' && t.last_sender ? (
                        <span className="preview-sender">{t.last_sender}: </span>
                      ) : null}
                      {t.last_message}
                    </span>
                    <span className="thread-end">
                      {t.handoff === 1 && <span className="badge amber" style={{ padding: '0 6px' }}>handoff</span>}
                      {t.unread > 0 && <span className="unread-badge">{t.unread}</span>}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="chat-panel">
          {!thread ? (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-soft)' }}>
              <Icon.chat style={{ width: 40, opacity: 0.4 }} />
              <p style={{ marginTop: 10 }}>Select a conversation</p>
            </div>
          ) : (
            <>
              <div className="chat-head">
                <div className="avatar">{initials(thread.contact.name, thread.contact.phone)}</div>
                <div style={{ flex: 1 }}>
                  <strong>
                    {thread.contact.name || (thread.contact.is_group ? 'Group chat' : '+' + thread.contact.phone)}
                  </strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {thread.contact.is_group ? (
                      <><Icon.users style={{ width: 12, verticalAlign: '-2px' }} /> Group</>
                    ) : (
                      <>+{thread.contact.phone} · <StatusBadge status={thread.contact.status} /></>
                    )}
                  </div>
                </div>
                {thread.contact.handoff === 1 && (
                  <button className="btn primary sm" onClick={resolve}><Icon.check /> Resolve handoff</button>
                )}
              </div>

              <div className="chat-msgs" ref={msgsRef}>
                {thread.messages.map((m, i) => {
                  const prev = thread.messages[i - 1];
                  const showDay = !prev || !sameDay(asDate(prev.created_at), asDate(m.created_at));
                  return (
                    <Fragment key={m.id}>
                      {showDay && (
                        <div className="chat-day"><span>{dayDivider(m.created_at)}</span></div>
                      )}
                      <div className={`bubble ${m.direction}`}>
                        {thread.contact.is_group === 1 && m.direction === 'in' && m.sender ? (
                          <div className="bubble-sender">{m.sender}</div>
                        ) : null}
                        {m.media_url && (
                          <img src={m.media_url} alt="" style={{ width: '100%', borderRadius: 8, marginBottom: m.body ? 6 : 0, display: 'block' }} />
                        )}
                        {m.body}
                        {m.ai_auto && (
                          <span className="chip" style={{ marginLeft: 6, fontSize: 9.5, padding: '0 6px' }}>AI</span>
                        )}
                        <div className="time">
                          {clockTime(m.created_at)} {m.direction === 'out' && <Ticks status={m.status} />}
                        </div>
                      </div>
                    </Fragment>
                  );
                })}
              </div>

              <div className="chat-compose">
                <textarea
                  className="compose-input"
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={acctConnected ? 'Type a message' : 'This number is not connected'}
                  disabled={!acctConnected}
                />
                <button className="compose-send" onClick={send} disabled={sending || !draft.trim()} title="Send">
                  <Icon.send />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// AI auto-reply settings — toggle, human-like delay window, and business context.
function AiReplySettings({ onClose, onSaved }) {
  const { toast } = useApp();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/settings');
        setS({
          autoReplyEnabled: !!r.autoReplyEnabled,
          autoReplyMinSec: r.autoReplyMinSec ?? 5,
          autoReplyMaxSec: r.autoReplyMaxSec ?? 30,
          autoReplyInstructions: r.autoReplyInstructions || '',
        });
      } catch (e) {
        toast(e.message, 'error');
      }
    })();
  }, []);

  async function save() {
    const min = Math.max(0, +s.autoReplyMinSec || 0);
    const max = Math.max(min, +s.autoReplyMaxSec || min);
    setBusy(true);
    try {
      await api.put('/settings', { ...s, autoReplyMinSec: min, autoReplyMaxSec: max });
      toast('AI reply settings saved', 'success');
      onSaved(s.autoReplyEnabled);
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }

  return (
    <Modal
      title="AI auto-reply settings"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy || !s}><Icon.check /> {busy ? 'Saving…' : 'Save'}</button></>}
    >
      {!s ? (
        <Loading label="Loading…" minHeight={160} />
      ) : (
        <>
          <div className="card" style={{ background: 'var(--surface-2)', padding: 14, border: 'none', marginBottom: 14 }}>
            <div className="flex between">
              <div className="flex" style={{ gap: 8 }}>
                <Icon.sparkles style={{ width: 16, color: 'var(--brand-700)' }} />
                <div>
                  <strong style={{ fontSize: 13 }}>Auto-reply to incoming messages</strong>
                  <div className="muted" style={{ fontSize: 11.5 }}>AI answers replies for you automatically.</div>
                </div>
              </div>
              <label className="switch">
                <input type="checkbox" checked={s.autoReplyEnabled} onChange={(e) => setS({ ...s, autoReplyEnabled: e.target.checked })} />
                <span className="slider" />
              </label>
            </div>
          </div>

          <div className="row">
            <div className="field" style={{ margin: 0 }}>
              <label>Reply after (min seconds)</label>
              <input type="number" min="0" className="input" value={s.autoReplyMinSec} onChange={(e) => setS({ ...s, autoReplyMinSec: e.target.value })} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Reply after (max seconds)</label>
              <input type="number" min="0" className="input" value={s.autoReplyMaxSec} onChange={(e) => setS({ ...s, autoReplyMaxSec: e.target.value })} />
            </div>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            AI waits a random time in this range before replying, so it looks human (not instant).
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label>Business context for the AI (optional)</label>
            <textarea
              className="textarea"
              style={{ minHeight: 90 }}
              value={s.autoReplyInstructions}
              onChange={(e) => setS({ ...s, autoReplyInstructions: e.target.value })}
              placeholder="e.g. We sell restaurant POS systems. Offer a demo, be friendly, never quote prices — ask them to book a call."
            />
            <div className="hint">Tells the AI who you are and how to answer.</div>
          </div>
        </>
      )}
    </Modal>
  );
}

// Link a conversation-only WhatsApp number (not used for campaigns or warm-up).
function AddAccountModal({ onClose, onLinked }) {
  const { toast } = useApp();
  const [label, setLabel] = useState('');
  const [id, setId] = useState(null);
  const [qr, setQr] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const r = await api.post('/conversations/accounts', { label: label.trim() });
      setId(r.id);
      setStatus('connecting');
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }

  // Poll for the QR + connection once a slot is created.
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.get(`/conversations/accounts/${id}/qr`);
        if (stop) return;
        setQr(s.qr);
        setStatus(s.status);
        if (s.status === 'connected') {
          toast('Number linked ✓', 'success');
          onLinked(id);
        }
      } catch {}
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [id]);

  async function cancel() {
    // Remove the pending slot if it never connected.
    if (id && status !== 'connected') {
      try { await api.del(`/conversations/accounts/${id}`); } catch {}
    }
    onClose();
  }

  return (
    <Modal
      title="Add a WhatsApp number"
      onClose={cancel}
      footer={<button className="btn" onClick={cancel}>Close</button>}
    >
      {!id ? (
        <>
          <div className="field">
            <label>Label (optional)</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Support line" />
            <div className="hint">This number is only for Conversations + AI replies — it won't be used for campaigns or warm-up.</div>
          </div>
          <button className="btn primary" onClick={start} disabled={busy}>
            <Icon.gateway /> {busy ? 'Starting…' : 'Generate QR'}
          </button>
        </>
      ) : (
        <div style={{ textAlign: 'center' }}>
          {status === 'connected' ? (
            <div className="auth-note">Linked! You can close this.</div>
          ) : qr ? (
            <>
              <img src={qr} alt="WhatsApp QR" style={{ width: 260, height: 260, borderRadius: 12 }} />
              <div className="hint" style={{ marginTop: 10 }}>
                On the phone for this number: <strong>WhatsApp → Linked Devices → Link a device</strong>, then scan this code.
              </div>
            </>
          ) : (
            <Loading label="Preparing QR…" minHeight={200} />
          )}
        </div>
      )}
    </Modal>
  );
}
