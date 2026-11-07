import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Empty, Loading, StatusBadge, clockTime, timeAgo, initials } from '../ui.jsx';

function Ticks({ status }) {
  if (status === 'read') return <span style={{ color: '#53bdeb' }}>✓✓</span>;
  if (status === 'delivered') return <span>✓✓</span>;
  return <span>✓</span>; // sent / unknown
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

export default function Conversations() {
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
  const msgsRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        setAiAvail((await api.get('/ai/status')).available);
        setAutoReply(!!(await api.get('/settings')).autoReplyEnabled);
      } catch {}
    })();
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
    const params = filter ? '?filter=' + filter : '';
    try {
      setThreads(await api.get('/conversations' + params));
    } finally {
      setThreadsLoaded(true);
    }
  };
  const loadThread = async (id) => {
    if (!id) return;
    const t = await api.get('/conversations/' + id);
    setThread(t);
    setTimeout(() => {
      if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
    }, 50);
  };

  useEffect(() => {
    loadThreads();
  }, [filter]);
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
  }, [active, filter]);

  async function send() {
    if (!draft.trim() || !thread) return;
    setSending(true);
    try {
      await api.post(`/conversations/${thread.contact.id}/reply`, { body: draft });
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

  const q = search.trim().toLowerCase();
  const shown = !q
    ? threads
    : threads.filter(
        (t) =>
          (t.name || '').toLowerCase().includes(q) ||
          (t.phone || '').includes(search.trim()) ||
          (t.last_message || '').toLowerCase().includes(q)
      );

  return (
    <>
      <div className="toolbar">
        <div className="flex" style={{ gap: 6 }}>
          <button className={`btn sm ${filter === '' ? 'primary' : ''}`} onClick={() => setFilter('')}>All</button>
          <button className={`btn sm ${filter === 'handoff' ? 'primary' : ''}`} onClick={() => setFilter('handoff')}>
            <Icon.warn /> Needs human
          </button>
        </div>
        <div className="spacer" />
        {aiAvail && (
          <button
            className={`btn sm ${autoReply ? 'primary' : ''}`}
            onClick={toggleAutoReply}
            title="When on, AI answers incoming replies automatically"
          >
            <Icon.sparkles /> AI auto-reply: {autoReply ? 'On' : 'Off'}
          </button>
        )}
      </div>

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
                <div className="avatar">{initials(t.name, t.phone)}</div>
                <div className="thread-main">
                  <div className="thread-name">
                    {t.is_group === 1 && <Icon.users style={{ width: 13, flex: 'none', opacity: 0.65 }} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.name || (t.is_group ? 'Group chat' : '+' + t.phone)}
                    </span>
                    {t.handoff === 1 && <span className="badge amber">handoff</span>}
                  </div>
                  <div className="thread-preview">
                    {t.last_direction === 'out' && <span style={{ color: 'var(--brand-700)' }}>You: </span>}
                    {t.last_message}
                  </div>
                </div>
                <div className="cell-muted" style={{ fontSize: 11 }}>{timeAgo(t.last_at)}</div>
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
                        {thread.contact.is_group && m.direction === 'in' && m.sender && (
                          <div className="bubble-sender">{m.sender}</div>
                        )}
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
                  className="textarea"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={wa.status === 'connected' ? 'Type a reply…' : 'Connect WhatsApp to reply'}
                  disabled={wa.status !== 'connected'}
                />
                <button className="btn primary" onClick={send} disabled={sending || !draft.trim()}>
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
