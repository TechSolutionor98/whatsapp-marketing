import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Empty, Loading, StatusBadge, clockTime, timeAgo, initials } from '../ui.jsx';

// What to call a chat: its name, else its number — never an @lid (WhatsApp's id for a
// contact whose number it hasn't shared with this device), which only looks like a number.
function chatTitle(c) {
  if (c?.name) return c.name;
  if (c?.is_group) return 'Group chat';
  if (c?.lid_only) return 'Unknown contact';
  return '+' + c?.phone;
}
const chatInitials = (c) => initials(c?.name, c?.lid_only || c?.is_group ? '' : c?.phone);

// WhatsApp text formatting: *bold*, _italic_, ~strike~, ```mono``` and clickable links.
// Built as React nodes (never innerHTML), so message text can't inject markup.
const WA_FMT = /(https?:\/\/[^\s<]+)|(?<!\w)\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)|(?<!\w)~([^~\n]+)~(?!\w)|```([^`]+)```/g;
function formatWa(text) {
  if (!text) return text;
  const out = [];
  let last = 0;
  let k = 0;
  WA_FMT.lastIndex = 0;
  for (let m = WA_FMT.exec(text); m; m = WA_FMT.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<a key={k++} href={m[1]} target="_blank" rel="noreferrer noopener">{m[1]}</a>);
    else if (m[2]) out.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3]) out.push(<em key={k++}>{m[3]}</em>);
    else if (m[4]) out.push(<s key={k++}>{m[4]}</s>);
    else if (m[5]) out.push(<code key={k++}>{m[5]}</code>);
    last = WA_FMT.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

// Photo / sticker / video / GIF / voice note / audio / document / location inside a bubble.
// Files stream from /api/conversations/media/:id (fetched + decrypted from WhatsApp on first
// view); photos and videos show WhatsApp's tiny inline preview until the full file loads.
function MessageMedia({ m, onLoad }) {
  const [failed, setFailed] = useState(false);
  const url = `/api/conversations/media/${m.id}`;
  const preview = m.thumb ? `data:image/jpeg;base64,${m.thumb}` : undefined;
  if (m.type === 'location' && m.location) {
    return (
      <a className="msg-loc" href={`https://maps.google.com/?q=${m.location.lat},${m.location.lng}`} target="_blank" rel="noreferrer noopener">
        <span className="msg-loc-pin">📍</span>
        <span>
          <b>{m.location.name || 'Location'}</b>
          <small>Open in Google Maps</small>
        </span>
      </a>
    );
  }
  if (!m.media) return null;
  if (failed) {
    return (
      <div className="msg-media-missing">
        {preview && m.type !== 'sticker' ? <img src={preview} alt="" /> : null}
        <span>{m.body} · no longer available on WhatsApp</span>
      </div>
    );
  }
  const ratio = m.w && m.h ? `${m.w} / ${m.h}` : undefined;
  switch (m.type) {
    case 'image':
      return (
        <a className="msg-img" href={url} target="_blank" rel="noreferrer noopener" style={{ aspectRatio: ratio, backgroundImage: preview ? `url(${preview})` : undefined }}>
          <img src={url} alt="" loading="lazy" onLoad={onLoad} onError={() => setFailed(true)} />
        </a>
      );
    case 'sticker':
      return <img className="msg-sticker" src={url} alt="Sticker" loading="lazy" onLoad={onLoad} onError={() => setFailed(true)} />;
    case 'gif':
      return <video className="msg-video" src={url} poster={preview} style={{ aspectRatio: ratio }} autoPlay loop muted playsInline onLoadedData={onLoad} onError={() => setFailed(true)} />;
    case 'video':
      return <video className="msg-video" src={url} poster={preview} style={{ aspectRatio: ratio }} controls preload="none" playsInline onError={() => setFailed(true)} />;
    case 'voice':
    case 'audio':
      return (
        <div className={`msg-audio ${m.type}`}>
          <span className="msg-audio-ico">{m.type === 'voice' ? '🎤' : '🎵'}</span>
          <audio src={url} controls preload="none" onError={() => setFailed(true)} />
          {m.seconds ? <span className="msg-audio-dur">{fmtDur(m.seconds)}</span> : null}
        </div>
      );
    case 'document':
      return (
        <a className="msg-doc" href={url} target="_blank" rel="noreferrer noopener" download={m.file_name || true}>
          <span className="msg-doc-ico">📄</span>
          <span className="msg-doc-name">{m.file_name || 'Document'}</span>
          {m.size ? <em>{fmtSize(m.size)}</em> : null}
        </a>
      );
    default:
      return null;
  }
}

function Ticks({ status }) {
  if (status === 'read') return <span style={{ color: '#53bdeb' }}>✓✓</span>;
  if (status === 'delivered') return <span>✓✓</span>;
  return <span>✓</span>; // sent / unknown
}

const PinIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
    <path d="M16 3a1 1 0 0 1 .7 1.71L15 6.41V11l2.3 2.29A1 1 0 0 1 16.59 15H13v5a1 1 0 1 1-2 0v-5H7.41a1 1 0 0 1-.71-1.71L9 11V6.41L7.3 4.71A1 1 0 0 1 8 3h8z" />
  </svg>
);

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
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accounts, setAccounts] = useState([{ id: 'main', label: 'Main number', phone: null, connected: false }]);
  const [account, setAccount] = useState('main'); // active account tab
  const [syncingChats, setSyncingChats] = useState(false); // polling a just-connected number
  const msgsRef = useRef(null);
  const stickRef = useRef(true); // keep the chat pinned to its newest message while at the bottom
  const restoreRef = useRef(null); // scroll position to restore after prepending older messages
  const olderBusy = useRef(false);

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

  async function removeTab(a) {
    if (!confirm(`Remove ${a.label || '+' + a.phone} from Conversations? This unlinks the number from the app.`)) return;
    try {
      await api.del(`/conversations/accounts/${a.id}`);
      toast('Number removed');
      if (account === a.id) setAccount('main');
      loadAccounts();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function pinChat(t) {
    try {
      await api.post(`/conversations/${t.id}/pin`, { pinned: !t.pinned });
      loadThreads();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  useEffect(() => {
    (async () => {
      try {
        setAiAvail((await api.get('/ai/status')).available);
      } catch {}
    })();
    loadAccounts();
    const t = setInterval(loadAccounts, 8000);
    return () => clearInterval(t);
  }, []);

  async function toggleAutoReply() {
    const v = !autoReply;
    try {
      await api.post(`/conversations/accounts/${account}/autoreply`, { enabled: v });
      await loadAccounts();
      toast(v ? 'AI auto-reply ON for this number' : 'AI auto-reply OFF for this number', v ? 'success' : 'info');
    } catch (e) {
      toast(e.message, 'error');
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
  // Load a chat's newest page. A live refresh merges into what's shown, keeping older
  // pages already loaded (scrolled up), instead of replacing them.
  const loadThread = async (id, { reset = false } = {}) => {
    if (!id) return;
    const t = await api.get(`/conversations/${id}?account=${account}`);
    if (reset) stickRef.current = true; // a freshly opened chat starts at its newest message
    setThread((prev) => {
      if (reset || !prev || prev.contact.id !== t.contact.id) return t;
      const first = t.messages[0]?.created_at;
      const ids = new Set(t.messages.map((m) => m.id));
      const older = first ? prev.messages.filter((m) => m.created_at < first && !ids.has(m.id)) : [];
      return { ...t, messages: [...older, ...t.messages], has_more: older.length ? prev.has_more : t.has_more };
    });
  };

  // Scrolled to the top → fetch the previous page and keep the view where it was.
  const loadOlder = async () => {
    if (!thread?.has_more || olderBusy.current || !thread.messages.length) return;
    olderBusy.current = true;
    const el = msgsRef.current;
    try {
      const before = encodeURIComponent(thread.messages[0].created_at);
      const t = await api.get(`/conversations/${thread.contact.id}?account=${account}&before=${before}`);
      if (el) restoreRef.current = { h: el.scrollHeight, top: el.scrollTop };
      setThread((p) => {
        if (!p || p.contact.id !== t.contact.id) return p;
        const ids = new Set(p.messages.map((m) => m.id));
        return { ...p, messages: [...t.messages.filter((m) => !ids.has(m.id)), ...p.messages], has_more: t.has_more };
      });
    } finally {
      olderBusy.current = false;
    }
  };

  const onMsgsScroll = (e) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; // at the bottom?
    if (el.scrollTop < 120) loadOlder();
  };
  // Media finished loading → it grew the chat; stay at the bottom if we were there.
  const onMediaLoad = () => {
    const el = msgsRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(() => {
    const el = msgsRef.current;
    if (!el || !thread) return;
    if (restoreRef.current) {
      el.scrollTop = el.scrollHeight - restoreRef.current.h + restoreRef.current.top; // older page prepended
      restoreRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thread]);

  useEffect(() => {
    loadThreads();
  }, [filter, account]);
  // Switching account closes the open thread (it belongs to a different number).
  useEffect(() => {
    setActive(null);
    setThread(null);
  }, [account]);
  useEffect(() => {
    loadThread(active, { reset: true });
  }, [active]);

  // Live refresh on inbound/outbound events.
  useEffect(() => {
    return onBus((ev, data) => {
      // A number connected/disconnected/linked — refresh the tab list immediately.
      if (ev === 'pool:update' || ev === 'wa:status') loadAccounts();
      if (ev === 'message:in' || ev === 'message:out') {
        loadThreads();
        loadAccounts(); // refresh the syncing indicator as history batches land
        if (active && (!data.contactId || data.contactId === active)) loadThread(active);
      }
      if (ev === 'message:status' && active) loadThread(active);
    });
  }, [active, filter, account]);

  // A just-connected number is still syncing its history in the background. Poll briefly
  // so its chats appear on their own, instead of needing a manual Refresh. (Computed
  // inline from `accounts`/`wa` so it doesn't reference values declared further below.)
  useEffect(() => {
    const acct = accounts.find((a) => a.id === account);
    const connected = account === 'main' ? wa.status === 'connected' : !!acct?.connected;
    if (!connected || threads.length > 0) {
      setSyncingChats(false);
      return;
    }
    setSyncingChats(true); // show the "Syncing your chats…" loader while we wait
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      loadThreads();
      loadAccounts();
      if (n >= 15) { clearInterval(t); setSyncingChats(false); } // ~45s, then give up
    }, 3000);
    return () => clearInterval(t);
  }, [account, accounts, wa.status, threads.length]);

  async function send() {
    if (!draft.trim() || !thread) return;
    setSending(true);
    try {
      await api.post(`/conversations/${thread.contact.id}/reply`, { body: draft, account });
      setDraft('');
      stickRef.current = true; // jump to the message just sent
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
  const autoReply = !!activeAcct?.auto_reply; // this number's own AI auto-reply state

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
        <AiReplySettings onClose={() => setShowAiSettings(false)} onSaved={() => setShowAiSettings(false)} />
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
            <span className={`wa-tab-dot ${a.connected ? 'on' : 'connecting'}`} title={a.connected ? 'Connected' : 'Connecting…'} />
            <span className="wa-tab-label">
              {a.label || (a.id === 'main' ? 'Main number' : 'Number')}
              {a.phone ? ` · +${a.phone}` : ''}
            </span>
            {a.syncing && <span className="wa-spin" title="Syncing chats…" />}
            {a.id !== 'main' && (
              <span
                className="wa-tab-x"
                title="Remove this number"
                onClick={(e) => { e.stopPropagation(); removeTab(a); }}
              >
                ✕
              </span>
            )}
          </button>
        ))}
        <button className="wa-tab add" onClick={() => setShowAddAccount(true)} title="Link another WhatsApp number for chats">
          <Icon.plus />
        </button>
      </div>
      {showAddAccount && (
        <AddAccountModal
          onClose={() => setShowAddAccount(false)}
          onLinked={(id) => {
            setShowAddAccount(false);
            if (id) setAccount(id);
            // The new number takes a moment to register server-side — refresh the tab
            // list a few times so it appears without a manual page reload.
            let n = 0;
            const iv = setInterval(() => { loadAccounts(); if (++n >= 8) clearInterval(iv); }, 1500);
          }}
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
          {activeAcct?.syncing && threads.length > 0 && (
            <div className="sync-banner"><span className="wa-spin" /> Syncing more chats…</div>
          )}
          {!threadsLoaded ? (
            <Loading label="Loading chats…" minHeight={200} />
          ) : threads.length === 0 ? (
            activeAcct?.syncing || syncingChats ? (
              <Loading label="Syncing your chats…" minHeight={200} />
            ) : (
              <div style={{ padding: 30 }}>
                <Empty icon="chat" title="No conversations">
                  Replies and your WhatsApp chats appear here.
                </Empty>
              </div>
            )
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
                <div className="avatar lg">{chatInitials(t)}</div>
                <div className="thread-main">
                  <div className="thread-row1">
                    <span className="thread-name-txt">
                      {t.is_group === 1 && <Icon.users style={{ width: 13, opacity: 0.6, verticalAlign: '-2px', marginRight: 4 }} />}
                      {chatTitle(t)}
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
                      <button
                        className={`thread-pin ${t.pinned ? 'on' : ''}`}
                        title={t.pinned ? 'Unpin' : 'Pin'}
                        onClick={(e) => { e.stopPropagation(); pinChat(t); }}
                      >
                        <PinIcon />
                      </button>
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
                <div className="avatar">{chatInitials(thread.contact)}</div>
                <div style={{ flex: 1 }}>
                  <strong>
                    {chatTitle(thread.contact)}
                  </strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {thread.contact.is_group ? (
                      <><Icon.users style={{ width: 12, verticalAlign: '-2px' }} /> Group</>
                    ) : (
                      <>{thread.contact.lid_only ? 'Number hidden by WhatsApp' : '+' + thread.contact.phone} · <StatusBadge status={thread.contact.status} /></>
                    )}
                  </div>
                </div>
                {thread.contact.handoff === 1 && (
                  <button className="btn primary sm" onClick={resolve}><Icon.check /> Resolve handoff</button>
                )}
              </div>

              <div className="chat-msgs" ref={msgsRef} onScroll={onMsgsScroll}>
                {thread.has_more ? <div className="chat-older"><span className="wa-spin" /> Loading older messages…</div> : null}
                {thread.messages.map((m, i) => {
                  const prev = thread.messages[i - 1];
                  const showDay = !prev || !sameDay(asDate(prev.created_at), asDate(m.created_at));
                  const rich = m.media === 1 || m.type === 'location';
                  const text = rich ? m.caption : m.body; // media: show its caption, not the "📷 Photo" label
                  const reacts = m.reactions || [];
                  return (
                    <Fragment key={m.id}>
                      {showDay && (
                        <div className="chat-day"><span>{dayDivider(m.created_at)}</span></div>
                      )}
                      <div className={`bubble ${m.direction}${m.type === 'sticker' && m.media ? ' sticker' : ''}${rich ? ' rich' : ''}${reacts.length ? ' has-reacts' : ''}`}>
                        {thread.contact.is_group === 1 && m.direction === 'in' && m.sender ? (
                          <div className="bubble-sender">{m.sender}</div>
                        ) : null}
                        {m.media_url && (
                          <img src={m.media_url} alt="" onLoad={onMediaLoad} style={{ width: '100%', borderRadius: 8, marginBottom: m.body ? 6 : 0, display: 'block' }} />
                        )}
                        {rich && <MessageMedia m={m} onLoad={onMediaLoad} />}
                        {text ? <div className="bubble-text">{formatWa(text)}</div> : null}
                        {m.ai_auto && (
                          <span className="chip" style={{ marginLeft: 6, fontSize: 9.5, padding: '0 6px' }}>AI</span>
                        )}
                        <div className="time">
                          {clockTime(m.created_at)} {m.direction === 'out' && <Ticks status={m.status} />}
                        </div>
                        {reacts.length ? (
                          <div className="bubble-reacts" title={reacts.map((r) => r.emoji).join(' ')}>
                            {[...new Set(reacts.map((r) => r.emoji))].slice(0, 3).join('')}
                            {reacts.length > 1 ? <span>{reacts.length}</span> : null}
                          </div>
                        ) : null}
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
      await api.put('/settings', { autoReplyMinSec: min, autoReplyMaxSec: max, autoReplyInstructions: s.autoReplyInstructions });
      toast('AI reply settings saved', 'success');
      onSaved();
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
          <div className="hint" style={{ marginBottom: 12 }}>
            Turn AI auto-reply <strong>on or off per number</strong> using the toggle on each tab. These timing &amp; context settings apply to all numbers.
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
    // Only discard if it was never scanned (still showing a QR). If it's linking or
    // linked, keep it — its tab appears on its own once connected.
    if (id && (status === 'qr' || status === '')) {
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
