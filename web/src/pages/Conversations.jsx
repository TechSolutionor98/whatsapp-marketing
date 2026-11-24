import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Empty, Loading, StatusBadge } from '../ui.jsx';

// What to call a chat: its name, else its number — never an @lid (WhatsApp's id for a
// contact whose number it hasn't shared with this device), which only looks like a number.
// Like WhatsApp: a contact saved on THIS number shows its saved name; anyone else shows their
// phone number, with their own WhatsApp name as a grey "~Name" (pushName()) — never as if saved.
function chatTitle(c) {
  if (c?.name) return c.name;
  if (c?.is_group) return 'Group chat';
  if (c?.lid_only) return c?.push_name ? `~${c.push_name}` : 'Unknown contact';
  return fmtPhone(c?.phone);
}
// A number the way WhatsApp writes it: "+971 55 968 2523", "+92 325 7847744". Countries
// without a known pattern stay "+<digits>".
const PHONE_GROUPS = [
  ['971', [2, 3, 4]],
  ['966', [2, 3, 4]],
  ['92', [3, 7]],
  ['91', [5, 5]],
  ['44', [4, 6]],
  ['1', [3, 3, 4]],
];
export function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  for (const [cc, groups] of PHONE_GROUPS) {
    if (!d.startsWith(cc)) continue;
    const rest = d.slice(cc.length);
    if (rest.length !== groups.reduce((a, b) => a + b, 0)) break;
    let i = 0;
    return `+${cc} ${groups.map((n) => rest.slice(i, (i += n))).join(' ')}`;
  }
  return `+${d}`;
}
// Round avatar like WhatsApp's: the name's first letter, a person for a bare number, people
// for a group.
function ChatAvatar({ c, size = '' }) {
  const letter = String(c?.name || (c?.lid_only ? c?.push_name : '') || '')
    .trim()
    .match(/[\p{L}\p{N}]/u)?.[0]
    ?.toUpperCase();
  return (
    <div className={`wa-avatar ${size}`} aria-hidden="true">
      {c?.is_group ? <Icon.users /> : letter || <Icon.user />}
    </div>
  );
}
// Chat-list time like WhatsApp: "3:09 PM" today, "Yesterday", the weekday this week, else the date.
function listTime(iso) {
  const d = asDate(iso);
  if (!d) return '';
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString();
}
// A message's time: "2:55 PM" (no leading zero, like WhatsApp).
function msgTime(iso) {
  const d = asDate(iso);
  return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}
// The "~Name" shown beside a number for someone not saved on this phone.
const pushName = (c) => (!c?.name && !c?.is_group && !c?.lid_only && c?.push_name ? `~${c.push_name}` : '');

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
  // WhatsApp refused it (e.g. admins-only group) — it was never delivered.
  if (status === 'failed') return <span className="msg-failed" title="Not sent — WhatsApp rejected this message">! Not sent</span>;
  const two = status === 'read' || status === 'delivered';
  const label = status === 'read' ? 'Read' : status === 'delivered' ? 'Delivered' : 'Sent';
  return (
    <svg className={`wa-ticks${status === 'read' ? ' read' : ''}`} viewBox="0 0 18 11" width="18" height="11" role="img" aria-label={label}>
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={two ? 'M1.2 5.8l2.9 2.9 6.4-7.4' : 'M3.5 5.8l2.9 2.9 6.4-7.4'} />
        {two && <path d="M7.6 8.1l.6.6 6.4-7.4" />}
      </g>
    </svg>
  );
}

// The picture on the empty chat pane (drawn for this app): a phone with a chat on it.
function ChatsArt() {
  return (
    <svg viewBox="0 0 220 150" width="220" height="150" aria-hidden="true">
      <rect x="30" y="18" width="160" height="112" rx="14" fill="#fff" stroke="#111b21" strokeWidth="2.5" />
      <rect x="30" y="18" width="160" height="26" rx="14" fill="#d9fdd3" stroke="#111b21" strokeWidth="2.5" />
      <rect x="31.5" y="32" width="157" height="11" fill="#d9fdd3" />
      <circle cx="48" cy="31" r="6" fill="#1daa61" />
      <rect x="60" y="27" width="44" height="7" rx="3.5" fill="#111b21" opacity=".75" />
      <rect x="46" y="56" width="78" height="20" rx="8" fill="#f7f5f3" stroke="#111b21" strokeWidth="2" />
      <rect x="96" y="84" width="80" height="20" rx="8" fill="#d9fdd3" stroke="#111b21" strokeWidth="2" />
      <rect x="54" y="63" width="50" height="5" rx="2.5" fill="#111b21" opacity=".55" />
      <rect x="104" y="91" width="54" height="5" rx="2.5" fill="#15603e" opacity=".7" />
      <path d="M160 107l3 3 6-7" fill="none" stroke="#007bfc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M182 22l4-9M192 30l9-4M188 14l3-3" stroke="#1daa61" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const PinIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
    <path d="M16 3a1 1 0 0 1 .7 1.71L15 6.41V11l2.3 2.29A1 1 0 0 1 16.59 15H13v5a1 1 0 1 1-2 0v-5H7.41a1 1 0 0 1-.71-1.71L9 11V6.41L7.3 4.71A1 1 0 0 1 8 3h8z" />
  </svg>
);

// ---- Message menu (WhatsApp's: react, reply, copy, forward, pin, star, delete) ----
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const MORE_REACTIONS = ['🔥', '🎉', '👏', '😍', '🤔', '😡', '👌', '✅', '💯', '🙌', '😊', '😅', '🤝', '💐', '⭐', '👀', '😎', '🥳', '🤣', '😇', '💪', '🙂', '👋', '😘'];
const ico = { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const ReplyIco = () => (<svg {...ico}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v4" /></svg>);
const ForwardIco = () => (<svg {...ico}><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0-6 6v4" /></svg>);
const SmileIco = () => (<svg {...ico}><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" /></svg>);
const StarIco = ({ filled }) => (<svg {...ico} fill={filled ? 'currentColor' : 'none'}><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>);
const CaretIco = () => (<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6.7 9.3 5.3 5.3 5.3-5.3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>);
const isPinnedNow = (m) => !!m?.pinned_until && new Date(m.pinned_until).getTime() > Date.now();
// What a message says, as text (its caption for media; nothing once deleted).
const msgText = (m) => (m?.deleted ? '' : (m?.media === 1 || m?.type === 'location' ? m?.caption : m?.body) || '');
const msgLabel = (m) => msgText(m) || (m?.deleted ? 'Deleted message' : m?.body || 'Message');

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button role="menuitem" className={`wa-menu-item${danger ? ' danger' : ''}`} onClick={onClick}>
      <span className="wa-menu-ico">{icon}</span>
      {label}
    </button>
  );
}

function MessageMenu({ at, m, can, myReaction, onReact, onAction, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [more, setMore] = useState(false);
  const [pinStep, setPinStep] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8));
    const top = at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.top - r.height - 4) : at.y;
    setPos({ left, top });
  }, [at.x, at.y, at.top, more, pinStep]);
  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    ref.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const react = (e) => onReact(myReaction === e ? '' : e);
  return (
    <div ref={ref} className="wa-menu" role="menu" aria-label="Message options" style={pos ? { left: pos.left, top: pos.top } : { left: at.x, top: at.y, visibility: 'hidden' }}>
      {can.react && (
        <div className="wa-react-bar" role="group" aria-label="React">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} className={`wa-react ${myReaction === e ? 'on' : ''}`} onClick={() => react(e)} aria-label={`React with ${e}`}>{e}</button>
          ))}
          <button className={`wa-react more ${more ? 'on' : ''}`} onClick={() => setMore((v) => !v)} aria-label="More reactions" aria-expanded={more}>
            <Icon.plus />
          </button>
        </div>
      )}
      {can.react && more && (
        <div className="wa-react-grid">
          {MORE_REACTIONS.map((e) => (
            <button key={e} className={`wa-react ${myReaction === e ? 'on' : ''}`} onClick={() => react(e)} aria-label={`React with ${e}`}>{e}</button>
          ))}
        </div>
      )}
      <div className="wa-menu-list">
        {pinStep ? (
          <>
            <div className="wa-menu-label">Pin for everyone, for:</div>
            {[[1, '24 hours'], [7, '7 days'], [30, '30 days']].map(([d, l]) => (
              <MenuItem key={d} icon={<PinIcon />} label={l} onClick={() => onAction('pin', { pin: true, days: d })} />
            ))}
          </>
        ) : (
          <>
            {can.reply && <MenuItem icon={<ReplyIco />} label="Reply" onClick={() => onAction('reply')} />}
            {can.copy && <MenuItem icon={<Icon.copy />} label="Copy" onClick={() => onAction('copy')} />}
            {can.react && <MenuItem icon={<SmileIco />} label="React" onClick={() => setMore(true)} />}
            {can.forward && <MenuItem icon={<ForwardIco />} label="Forward" onClick={() => onAction('forward')} />}
            {can.pin && (isPinnedNow(m)
              ? <MenuItem icon={<PinIcon />} label="Unpin" onClick={() => onAction('pin', { pin: false })} />
              : <MenuItem icon={<PinIcon />} label="Pin" onClick={() => setPinStep(true)} />)}
            <MenuItem icon={<StarIco filled={!!m.starred} />} label={m.starred ? 'Unstar' : 'Star'} onClick={() => onAction('star', { star: !m.starred })} />
            <div className="wa-menu-sep" />
            <MenuItem icon={<Icon.trash />} label="Delete" danger onClick={() => onAction('delete')} />
          </>
        )}
      </div>
    </div>
  );
}

// Forward a message to up to 5 chats of the same number.
function ForwardModal({ account, contactId, m, onClose, onDone }) {
  const { toast } = useApp();
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/conversations?account=${encodeURIComponent(account)}`)
      .then((r) => setList(Array.isArray(r) ? r : r.rows || []))
      .catch(() => setList([]));
  }, [account]);
  const needle = q.trim().toLowerCase();
  const shown = (list || []).filter((t) => !needle || chatTitle(t).toLowerCase().includes(needle) || (t.phone || '').includes(q.trim()) || (t.push_name || '').toLowerCase().includes(needle));
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 5 ? p : [...p, id]));
  async function send() {
    setBusy(true);
    try {
      const r = await api.post(`/conversations/${contactId}/messages/${m.id}/forward`, { account, to: picked });
      toast(`Forwarded to ${r.sent} chat${r.sent === 1 ? '' : 's'}${r.skipped?.length ? ` — not to ${r.skipped.join(', ')}` : ''}`, 'success');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }
  return (
    <Modal
      title="Forward message to"
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto' }}>{picked.length ? `${picked.length} selected` : 'Up to 5 chats'}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!picked.length || busy} onClick={send}><ForwardIco /> {busy ? 'Forwarding…' : 'Forward'}</button>
        </>
      }
    >
      <div className="wa-fwd-preview">{msgLabel(m)}</div>
      <div className="wa-search" style={{ margin: '12px 0' }}>
        <Icon.search />
        <input placeholder="Search chats" aria-label="Search chats" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="wa-fwd-list">
        {list === null ? <Loading label="Loading chats…" minHeight={120} /> : shown.length === 0 ? <div className="muted" style={{ padding: 16 }}>No chats</div> : shown.map((t) => (
          <label key={t.id} className={`wa-fwd-row ${picked.includes(t.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} disabled={!picked.includes(t.id) && picked.length >= 5} />
            <ChatAvatar c={t} size="md" />
            <span className="wa-fwd-name">{chatTitle(t)}{pushName(t) ? <span className="wa-row-push"> {pushName(t)}</span> : null}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

// History sync for one number, shown as a loading line under its tab: first WhatsApp sends
// the history (its own %), then the server saves what arrived (can take minutes on a big phone).
function syncLabel(s) {
  if (!s) return '';
  if (s.fetching) return s.progress != null ? `Syncing chats from WhatsApp… ${s.progress}%` : 'Syncing chats from WhatsApp…';
  const saved = s.saved ? ` · ${s.saved.toLocaleString()} messages so far` : '';
  return `Saving synced chats…${s.pending > 1 ? ` ${s.pending} batches left` : ''}${saved}`;
}
function TabSync({ sync }) {
  const pct = sync.fetching && sync.progress != null ? sync.progress : null;
  return (
    <span
      className="wa-tab-sync"
      role="progressbar"
      aria-label={syncLabel(sync)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
    >
      <span className={`wa-tab-sync-bar${pct == null ? ' indeterminate' : ''}`} style={pct == null ? undefined : { width: `${Math.max(3, pct)}%` }} />
    </span>
  );
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
  const { toast, onBus, wa, can } = useApp();
  const [threads, setThreads] = useState([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [counts, setCounts] = useState(null); // chip numbers: { all, unread, groups, handoff }
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(null); // contactId
  const [thread, setThread] = useState(null); // {contact, messages}
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [aiAvail, setAiAvail] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState(null); // active account tab — starts on the default number
  const accountsRef = useRef([]);
  const [syncingChats, setSyncingChats] = useState(false); // polling a just-connected number
  const msgsRef = useRef(null);
  const stickRef = useRef(true); // keep the chat pinned to its newest message while at the bottom
  const restoreRef = useRef(null); // scroll position to restore after prepending older messages
  const olderBusy = useRef(false);
  const [phoneOlder, setPhoneOlder] = useState(''); // '' | 'loading' | 'none'
  const [menu, setMenu] = useState(null); // message menu: { m, at: { x, y, top } }
  const [replyTo, setReplyTo] = useState(null); // the message being replied to (quoted)
  const [delMsg, setDelMsg] = useState(null); // "Delete message?" dialog
  const [fwdMsg, setFwdMsg] = useState(null); // forward picker
  const [flash, setFlash] = useState(null); // briefly highlight a message we jumped to
  const composeRef = useRef(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Numbers are linked/unlinked on the WhatsApp Gateway page; here they're only tabs. Opens on
  // the default number; if the open tab's number was unlinked, goes back to the default.
  const loadAccounts = async () => {
    let list = [];
    try {
      list = await api.get('/conversations/accounts');
    } catch {}
    const prev = accountsRef.current;
    if (list.length) {
      accountsRef.current = list;
      setAccounts(list);
    }
    setAccount((cur) => {
      if (!list.length) return cur || 'main';
      if (cur && list.some((a) => a.id === cur)) return cur;
      const phone = cur && prev.find((a) => a.id === cur)?.phone;
      const same = phone && list.find((a) => a.phone === phone); // same number, other link
      if (same) return same.id;
      return (list.find((a) => a.default) || list[0]).id;
    });
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
    if (!account) return;
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
    if (!account) return; // waiting for the number list (opens on the default number)
    const params = new URLSearchParams({ account, counts: '1' });
    if (filter) params.set('filter', filter);
    try {
      const r = await api.get('/conversations?' + params);
      setThreads(Array.isArray(r) ? r : r.rows || []);
      setCounts(Array.isArray(r) ? null : r.counts || null);
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

  // Everything stored is shown → ask the phone for older messages (WhatsApp Web's "get older
  // messages from your phone"), then wait for them to land and add them on top.
  const loadFromPhone = async () => {
    if (!thread?.messages.length || phoneOlder === 'loading') return;
    const cid = thread.contact.id;
    const before = thread.messages[0].created_at;
    setPhoneOlder('loading');
    try {
      await api.post(`/conversations/${cid}/older`, { account });
    } catch (e) {
      setPhoneOlder('');
      toast(e.message, 'error');
      return;
    }
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      let t;
      try {
        t = await api.get(`/conversations/${cid}?account=${account}&before=${encodeURIComponent(before)}`);
      } catch {
        continue;
      }
      if (t.messages.length) {
        const el = msgsRef.current;
        if (el) restoreRef.current = { h: el.scrollHeight, top: el.scrollTop };
        setThread((p) => {
          if (!p || p.contact.id !== cid) return p;
          const ids = new Set(p.messages.map((m) => m.id));
          return { ...p, messages: [...t.messages.filter((m) => !ids.has(m.id)), ...p.messages], has_more: t.has_more };
        });
        setPhoneOlder('');
        return;
      }
    }
    setPhoneOlder('none');
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

  // After every update: keep the view where the reader is. Older messages added above (scroll
  // up, "from your phone", or a live refresh that brought them in) must not make it jump.
  const lastLayoutRef = useRef({ first: null, h: 0 });
  useLayoutEffect(() => {
    const el = msgsRef.current;
    if (!el || !thread) return;
    const first = thread.messages[0]?.id || null;
    const prev = lastLayoutRef.current;
    if (restoreRef.current) {
      el.scrollTop = el.scrollHeight - restoreRef.current.h + restoreRef.current.top; // older page prepended
      restoreRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (prev.first && first !== prev.first && thread.messages.some((m) => m.id === prev.first)) {
      el.scrollTop += el.scrollHeight - prev.h; // messages appeared above → shift by their height
    }
    lastLayoutRef.current = { first, h: el.scrollHeight };
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
    setPhoneOlder('');
    setReplyTo(null);
    setMenu(null);
    // Opening a chat marks it read on this number — refresh the red counters on the tabs.
    loadThread(active, { reset: true })
      .then(() => {
        if (!active) return;
        loadAccounts();
        loadThreads();
      })
      .catch(() => {});
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
      await api.post(`/conversations/${thread.contact.id}/reply`, { body: draft, account, ...(replyTo ? { quoted_id: replyTo.id } : {}) });
      setDraft('');
      setReplyTo(null);
      stickRef.current = true; // jump to the message just sent
      loadThread(thread.contact.id);
      loadThreads();
    } catch (e) {
      toast(e.message, 'error');
    }
    setSending(false);
  }

  // ---- message menu actions ----
  async function msgAction(m, action, payload = {}) {
    try {
      await api.post(`/conversations/${thread.contact.id}/messages/${m.id}/${action}`, { account, ...payload });
      loadThread(thread.contact.id);
      loadThreads();
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  }
  // Who wrote a message, as WhatsApp labels it in a quote.
  function authorOf(m) {
    if (!m || m.direction === 'out') return 'You';
    if (thread?.contact.is_group) return m.sender || (m.sender_jid ? fmtPhone(m.sender_jid.split('@')[0]) : 'Someone');
    return chatTitle(thread?.contact);
  }
  function quoteAuthor(q) {
    if (q.from_me) return 'You';
    const orig = thread?.messages.find((x) => x.wa_message_id === q.id);
    if (orig) return authorOf(orig);
    if (thread?.contact.is_group) return q.participant && /^\d+@s\.whatsapp\.net$/.test(q.participant) ? fmtPhone(q.participant.split('@')[0]) : 'Someone';
    return chatTitle(thread?.contact);
  }
  const isCloudTab = () => activeAcct?.kind === 'cloud'; // a function: activeAcct is defined further down
  function capsOf(m) {
    const keyed = !!m.wa_message_id && !(thread?.contact.is_group && m.direction === 'in' && !m.sender_jid);
    const live = acctConnected && !isCloudTab();
    const canPost = !thread?.contact.read_only;
    return {
      reply: !m.deleted && keyed && live && canPost,
      copy: !!msgText(m),
      react: !m.deleted && keyed && live,
      forward: !m.deleted && live && !!(m.body || m.media === 1),
      pin: !m.deleted && keyed && live && canPost,
    };
  }
  const canDeleteForEveryone = (m) =>
    m && m.direction === 'out' && !m.deleted && !!m.wa_message_id && acctConnected && !isCloudTab() && Date.now() - (asDate(m.created_at)?.getTime() || 0) < 60 * 3600e3;
  function openMenu(e, m) {
    e.stopPropagation();
    const b = (e.currentTarget.closest('.bubble') || e.currentTarget).getBoundingClientRect();
    setMenu({ m, at: { x: m.direction === 'out' ? b.right - 240 : b.left, y: b.bottom + 4, top: b.top } });
  }
  async function onMenuAction(kind, payload) {
    const m = menu?.m;
    setMenu(null);
    if (!m) return;
    if (kind === 'reply') {
      setReplyTo(m);
      setTimeout(() => composeRef.current?.focus(), 0);
    } else if (kind === 'copy') {
      try {
        await navigator.clipboard.writeText(msgText(m));
        toast('Message copied', 'success');
      } catch {
        toast("Couldn't copy — select the text instead", 'error');
      }
    } else if (kind === 'forward') setFwdMsg(m);
    else if (kind === 'delete') setDelMsg(m);
    else if (kind === 'pin') {
      if (await msgAction(m, 'pin', payload)) toast(payload.pin ? 'Pinned for everyone in this chat' : 'Unpinned', 'success');
    } else if (kind === 'star') await msgAction(m, 'star', payload);
  }
  async function reactTo(emoji) {
    const m = menu?.m;
    setMenu(null);
    if (m) await msgAction(m, 'react', { emoji });
  }
  async function deleteMsg(scope) {
    const m = delMsg;
    setDelMsg(null);
    if (m && (await msgAction(m, 'delete', { scope }))) toast(scope === 'everyone' ? 'Deleted for everyone' : 'Deleted for you', 'success');
  }
  // Scroll to a message (a quote or the pinned bar) and flash it, like WhatsApp.
  function jumpTo(waId) {
    const el = waId && msgsRef.current?.querySelector(`[data-wa="${CSS.escape(waId)}"]`);
    if (!el) {
      toast('That message is further up — scroll up to load it', 'info');
      return;
    }
    stickRef.current = false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(waId);
    setTimeout(() => setFlash(null), 1600);
  }

  async function resolve() {
    await api.post(`/conversations/${thread.contact.id}/resolve`, { account });
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
          (t.push_name || '').toLowerCase().includes(q) ||
          (t.phone || '').includes(search.trim()) ||
          (t.last_message || '').toLowerCase().includes(q)
      );

  return (
    <>
      {showAiSettings && (
        <AiReplySettings
          account={account}
          accountInfo={accounts.find((a) => a.id === account)}
          onClose={() => setShowAiSettings(false)}
          onSaved={() => {
            setShowAiSettings(false);
            loadAccounts();
          }}
        />
      )}

      <div className="wa-tabs">
        {[...accounts].sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0)).map((a) => (
          <button
            key={a.id}
            className={`wa-tab ${account === a.id ? 'active' : ''} ${a.connected ? '' : 'off'}${a.sync ? ' syncing' : ''}`}
            onClick={() => setAccount(a.id)}
            onDoubleClick={() => renameTab(a)}
            title={`${a.phone ? '+' + a.phone : 'Not linked'}${a.sync ? ` · ${syncLabel(a.sync)}` : ''} · double-click to rename`}
          >
            <span className={`wa-tab-dot ${a.connected ? 'on' : 'connecting'}`} title={a.connected ? 'Connected' : 'Connecting…'} />
            <span className="wa-tab-label">
              {a.label || (a.id === 'main' ? 'Main number' : 'Number')}
              {a.phone ? ` · +${a.phone}` : ''}
            </span>
            {a.default && <span className="wa-tab-default" title="Default number — Conversations opens here. Change it on the WhatsApp Gateway page.">Default</span>}
            {a.unread_chats > 0 && (
              <span
                className="wa-tab-unread"
                title={`${a.unread_chats} unread chat${a.unread_chats === 1 ? '' : 's'}${a.unread_messages ? ` · ${a.unread_messages} new message${a.unread_messages === 1 ? '' : 's'}` : ''}`}
                aria-label={`${a.unread_chats} unread chats`}
              >
                {a.unread_chats > 99 ? '99+' : a.unread_chats}
              </span>
            )}
            {a.sync && (
              <span className="wa-tab-sync-text">
                {a.sync.fetching && a.sync.progress != null ? `${a.sync.progress}%` : a.sync.fetching ? 'Syncing…' : 'Saving…'}
              </span>
            )}
            {a.sync && <TabSync sync={a.sync} />}
          </button>
        ))}
        {can('gateway') && <button
          className="wa-tabs-manage"
          onClick={() => go?.('gateway')}
          title="Link or unlink numbers and choose the default on the WhatsApp Gateway page"
        >
          <Icon.gateway /> Manage numbers
        </button>}
      </div>

      <div className={`chat-layout wa-web${thread ? ' has-thread' : ''}`}>
        <div className="thread-list">
          <div className="wa-list-head">
            <h2 className="wa-list-title">Chats</h2>
            <div className="wa-list-actions">
              {aiAvail && (
                <button
                  className={`wa-ai-toggle ${autoReply ? 'on' : ''}`}
                  onClick={toggleAutoReply}
                  disabled={!account}
                  aria-pressed={autoReply}
                  title={autoReply ? 'AI auto-reply is on for this number — click to turn it off' : 'AI auto-reply is off — click to let AI answer incoming messages'}
                >
                  <Icon.sparkles /> AI {autoReply ? 'on' : 'off'}
                </button>
              )}
              {aiAvail && (
                <button className="wa-icon-btn" onClick={() => setShowAiSettings(true)} disabled={!account} title="AI auto-reply settings" aria-label="AI auto-reply settings">
                  <Icon.settings />
                </button>
              )}
              <button className="wa-icon-btn" onClick={() => { loadThreads(); loadAccounts(); }} title="Refresh chats" aria-label="Refresh chats">
                <Icon.refresh />
              </button>
            </div>
          </div>
          <div className="wa-search">
            <Icon.search />
            <input placeholder="Search chats" aria-label="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search && (
              <button className="wa-search-clear" onClick={() => setSearch('')} aria-label="Clear search"><Icon.x /></button>
            )}
          </div>
          <div className="wa-chips" role="tablist" aria-label="Filter chats">
            {[['', 'All'], ['unread', 'Unread'], ['groups', 'Groups'], ['handoff', 'Needs human']].map(([v, label]) => {
              const n = v && counts ? counts[v] : 0;
              return (
                <button key={v || 'all'} role="tab" aria-selected={filter === v} className={`wa-chip ${filter === v ? 'active' : ''}`} onClick={() => setFilter(v)}>
                  {label}
                  {n ? <span className="wa-chip-n">{n > 999 ? '999+' : n}</span> : null}
                </button>
              );
            })}
          </div>
          {activeAcct?.sync && threads.length > 0 && (
            <div className="wa-banner" role="status">
              <span className="wa-banner-icon"><Icon.refresh /></span>
              <div className="wa-banner-body">
                <div className="wa-banner-title">
                  {activeAcct.sync.fetching ? 'Syncing your chats' : 'Saving your chats'}
                  {activeAcct.sync.fetching && activeAcct.sync.progress != null ? ` · ${activeAcct.sync.progress}%` : ''}
                </div>
                <div className="wa-banner-text">
                  {activeAcct.sync.fetching
                    ? 'WhatsApp is sending this number’s chat history. Chats appear here as they arrive.'
                    : `Saving what WhatsApp sent${activeAcct.sync.saved ? ` — ${activeAcct.sync.saved.toLocaleString()} messages so far` : ''}${activeAcct.sync.pending > 1 ? `, ${activeAcct.sync.pending} batches left` : ''}.`}
                </div>
                <TabSync sync={activeAcct.sync} />
              </div>
            </div>
          )}
          <div className="wa-chat-scroll">
          {!threadsLoaded ? (
            <Loading label="Loading chats…" minHeight={200} />
          ) : threads.length === 0 ? (
            activeAcct?.syncing || syncingChats ? (
              <Loading label="Syncing your chats…" minHeight={200} />
            ) : (
              <div style={{ padding: 30 }}>
                <Empty icon="chat" title={filter ? 'No chats here' : 'No conversations'}>
                  {filter ? 'No chat matches this filter.' : 'Replies and your WhatsApp chats appear here.'}
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
                className={`thread-item wa-row ${active === t.id ? 'active' : ''} ${t.unread > 0 ? 'unread' : ''}`}
                onClick={() => setActive(t.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') setActive(t.id); }}
                role="button"
                tabIndex={0}
              >
                <ChatAvatar c={t} />
                <div className="wa-row-main">
                  <div className="wa-row-top">
                    <span className="wa-row-name">
                      <span className="wa-row-title">{chatTitle(t)}</span>
                      {pushName(t) ? <span className="wa-row-push">{pushName(t)}</span> : null}
                    </span>
                    <span className="wa-row-time">{listTime(t.last_at)}</span>
                  </div>
                  <div className="wa-row-bottom">
                    <span className="wa-row-preview">
                      {t.last_direction === 'out' && <Ticks status={t.last_status} />}
                      {t.is_group === 1 && t.last_direction === 'in' && t.last_sender ? (
                        <span className="wa-row-sender">{t.last_sender}: </span>
                      ) : null}
                      {t.last_deleted ? (
                        <span className="wa-row-deleted">⊘ {t.last_direction === 'out' ? 'You deleted this message' : 'This message was deleted'}</span>
                      ) : (
                        t.last_message
                      )}
                    </span>
                    <span className="wa-row-end">
                      {t.handoff === 1 && (
                        <span className="wa-row-handoff" title={t.handoff_reason === 'ai' ? "The AI couldn't answer this — reply yourself, then Resolve" : 'Waiting for your reply'}>
                          {t.handoff_reason === 'ai' ? 'Needs you' : 'Handoff'}
                        </span>
                      )}
                      {t.unread > 0 && <span className="wa-badge" aria-label={`${t.unread} unread`}>{t.unread}</span>}
                      <button
                        className={`wa-row-pin ${t.pinned ? 'on' : ''}`}
                        title={t.pinned ? 'Unpin chat' : 'Pin chat'}
                        aria-label={t.pinned ? 'Unpin chat' : 'Pin chat'}
                        onClick={(e) => { e.stopPropagation(); pinChat(t); }}
                      >
                        <PinIcon />
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
          </div>
        </div>

        <div className="chat-panel">
          {!thread ? (
            <div className="wa-empty">
              <div className="wa-empty-card">
                <ChatsArt />
                <h3>Pick a chat to start replying</h3>
                <p>
                  Messages to {activeAcct?.label || 'this number'}
                  {activeAcct?.phone ? ` (${fmtPhone(activeAcct.phone)})` : ''} arrive here as they come in. Your replies go out from this number.
                </p>
                {can('gateway') && (
                  <button className="wa-soft-btn" onClick={() => go?.('gateway')}>Manage numbers</button>
                )}
              </div>
              <div className="wa-quick">
                {[['contacts', 'Contacts', Icon.users], ['templates', 'Templates', Icon.template], ['campaigns', 'Campaigns', Icon.megaphone]]
                  .filter(([page]) => can(page))
                  .map(([page, label, Ico]) => (
                    <button key={page} className="wa-quick-btn" onClick={() => go?.(page)}>
                      <span className="wa-quick-icon"><Ico /></span>
                      {label}
                    </button>
                  ))}
                {aiAvail && (
                  <button className="wa-quick-btn" onClick={() => setShowAiSettings(true)} disabled={!account}>
                    <span className="wa-quick-icon"><Icon.sparkles /></span>
                    AI replies
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="chat-head">
                <button className="wa-back" onClick={() => { setActive(null); setThread(null); }} aria-label="Back to chats" title="Back to chats">
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z" fill="currentColor" /></svg>
                </button>
                <ChatAvatar c={thread.contact} size="md" />
                <div style={{ flex: 1 }}>
                  <strong>
                    {chatTitle(thread.contact)}
                  </strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {thread.contact.is_group ? (
                      <><Icon.users style={{ width: 12, verticalAlign: '-2px' }} /> Group</>
                    ) : (
                      <>
                        {thread.contact.lid_only
                          ? 'Number hidden by WhatsApp'
                          : thread.contact.name
                            ? fmtPhone(thread.contact.phone)
                            : pushName(thread.contact) || 'Not in your contacts'}{' '}
                        · <StatusBadge status={thread.contact.status} />
                      </>
                    )}
                  </div>
                </div>
                {thread.contact.handoff === 1 && (
                  <button className="btn primary sm" onClick={resolve}><Icon.check /> Resolve handoff</button>
                )}
              </div>

              {thread.pinned?.length ? (
                <div className="wa-pinbar">
                  <span className="wa-pinbar-ico"><PinIcon /></span>
                  <button className="wa-pinbar-text" onClick={() => jumpTo(thread.pinned[0].wa_message_id)} title="Go to the pinned message">
                    {msgLabel(thread.pinned[0])}
                  </button>
                  {thread.pinned.length > 1 ? <span className="wa-pinbar-n">+{thread.pinned.length - 1} more</span> : null}
                  {acctConnected && !isCloudTab() && !thread.contact.read_only ? (
                    <button className="wa-icon-btn sm" onClick={() => msgAction(thread.pinned[0], 'pin', { pin: false })} aria-label="Unpin" title="Unpin for everyone">
                      <Icon.x />
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="chat-msgs" ref={msgsRef} onScroll={onMsgsScroll}>
                {thread.has_more ? <div className="chat-older"><span className="wa-spin" /> Loading older messages…</div> : null}
                {!thread.has_more && thread.messages.length > 0 ? (
                  <div className="chat-older">
                    {phoneOlder === 'loading' ? (
                      <><span className="wa-spin" /> Getting older messages from your phone…</>
                    ) : (
                      <button className="link-btn" onClick={loadFromPhone}>
                        {phoneOlder === 'none'
                          ? 'Nothing older came from the phone — keep WhatsApp open on it and try again'
                          : 'Load older messages from your phone'}
                      </button>
                    )}
                  </div>
                ) : null}
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
                      <div
                        className={`bubble ${m.direction}${m.type === 'sticker' && m.media && !m.deleted ? ' sticker' : ''}${rich && !m.deleted ? ' rich' : ''}${reacts.length ? ' has-reacts' : ''}${m.deleted ? ' deleted' : ''}${flash && flash === m.wa_message_id ? ' flash' : ''}${menu?.m.id === m.id ? ' menu-open' : ''}`}
                        data-wa={m.wa_message_id || undefined}
                      >
                        {thread.contact.is_group === 1 && m.direction === 'in' && m.sender ? (
                          <div className="bubble-sender">{m.sender}</div>
                        ) : null}
                        {m.forwarded && !m.deleted ? <div className="wa-fwd"><ForwardIco /> Forwarded</div> : null}
                        {m.quoted && !m.deleted ? (
                          <button className="wa-quote" onClick={() => jumpTo(m.quoted.id)} title="Go to the original message">
                            <span className="wa-quote-who">{quoteAuthor(m.quoted)}</span>
                            <span className="wa-quote-text">{m.quoted.body || 'Message'}</span>
                          </button>
                        ) : null}
                        {m.deleted ? (
                          <div className="bubble-text wa-deleted">⊘ {m.direction === 'out' ? 'You deleted this message' : 'This message was deleted'}</div>
                        ) : (
                          <>
                            {m.media_url && (
                              <img src={m.media_url} alt="" onLoad={onMediaLoad} style={{ width: '100%', borderRadius: 8, marginBottom: m.body ? 6 : 0, display: 'block' }} />
                            )}
                            {rich && <MessageMedia m={m} onLoad={onMediaLoad} />}
                            {text ? <div className="bubble-text">{formatWa(text)}</div> : null}
                          </>
                        )}
                        {m.ai_auto && (
                          <span className="chip" style={{ marginLeft: 6, fontSize: 9.5, padding: '0 6px' }}>AI</span>
                        )}
                        <div className="time">
                          {m.starred ? <span className="wa-time-ico" title="Starred"><StarIco filled /></span> : null}
                          {isPinnedNow(m) ? <span className="wa-time-ico" title="Pinned"><PinIcon /></span> : null}
                          {msgTime(m.created_at)} {m.direction === 'out' && !m.deleted && <Ticks status={m.status} />}
                        </div>
                        {reacts.length ? (
                          <div className="bubble-reacts" title={reacts.map((r) => r.emoji).join(' ')}>
                            {[...new Set(reacts.map((r) => r.emoji))].slice(0, 3).join('')}
                            {reacts.length > 1 ? <span>{reacts.length}</span> : null}
                          </div>
                        ) : null}
                        <button className="wa-caret" onClick={(e) => openMenu(e, m)} aria-label="Message options" aria-haspopup="menu" title="Message options">
                          <CaretIco />
                        </button>
                        {capsOf(m).react ? (
                          <button className="wa-react-btn" onClick={(e) => openMenu(e, m)} aria-label="React" title="React">
                            <SmileIco />
                          </button>
                        ) : null}
                      </div>
                    </Fragment>
                  );
                })}
              </div>

              {thread.contact.read_only ? (
                <div className="chat-compose chat-readonly">Only admins can send messages</div>
              ) : (
              <>
              {replyTo && (
                <div className="wa-replybar">
                  <div className="wa-quote static">
                    <span className="wa-quote-who">{authorOf(replyTo)}</span>
                    <span className="wa-quote-text">{msgLabel(replyTo)}</span>
                  </div>
                  <button className="wa-icon-btn" onClick={() => setReplyTo(null)} aria-label="Cancel reply" title="Cancel reply">
                    <Icon.x />
                  </button>
                </div>
              )}
              <div className="chat-compose">
                <textarea
                  ref={composeRef}
                  className="compose-input"
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    } else if (e.key === 'Escape' && replyTo) {
                      setReplyTo(null);
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
            </>
          )}
        </div>
      </div>

      {menu && thread && (
        <MessageMenu
          at={menu.at}
          m={menu.m}
          can={capsOf(menu.m)}
          myReaction={(menu.m.reactions || []).find((r) => r.from === 'me')?.emoji || ''}
          onReact={reactTo}
          onAction={onMenuAction}
          onClose={closeMenu}
        />
      )}
      {delMsg && (
        <Modal
          title="Delete message?"
          onClose={() => setDelMsg(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDelMsg(null)}>Cancel</button>
              <button className="btn" onClick={() => deleteMsg('me')}>Delete for me</button>
              {canDeleteForEveryone(delMsg) && (
                <button className="btn danger" onClick={() => deleteMsg('everyone')}>Delete for everyone</button>
              )}
            </>
          }
        >
          <div className="wa-fwd-preview">{msgLabel(delMsg)}</div>
          <p className="muted" style={{ margin: '12px 0 0', fontSize: 14 }}>
            {canDeleteForEveryone(delMsg)
              ? 'Delete for everyone removes it from the chat on their phone too — they’ll see “This message was deleted”. Delete for me removes it only from this app and your phone.'
              : delMsg.direction === 'out' && !delMsg.deleted
                ? 'It’s too old to delete for everyone (WhatsApp allows about 2 days), or this number isn’t connected. Delete for me removes it from this app and your phone.'
                : 'This removes it from this app and your phone. The other person still has it.'}
          </p>
        </Modal>
      )}
      {fwdMsg && thread && (
        <ForwardModal
          account={account}
          contactId={thread.contact.id}
          m={fwdMsg}
          onClose={() => setFwdMsg(null)}
          onDone={() => {
            setFwdMsg(null);
            loadThreads();
          }}
        />
      )}
    </>
  );
}

// AI auto-reply settings — toggle, human-like delay window, and business context.
function AiReplySettings({ account, accountInfo, onClose, onSaved }) {
  const { toast } = useApp();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [catalogs, setCatalogs] = useState([]);
  const [catalogSel, setCatalogSel] = useState(accountInfo?.catalog_id || '');
  useEffect(() => {
    api.get('/catalogs').then(setCatalogs).catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/settings');
        setS({
          autoReplyEnabled: !!r.autoReplyEnabled,
          autoReplyMinSec: r.autoReplyMinSec ?? 3,
          autoReplyMaxSec: r.autoReplyMaxSec ?? 10,
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
      await api.put(`/conversations/accounts/${account}/catalog`, { catalog_id: catalogSel || null });
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
          <div className="field" style={{ marginBottom: 14 }}>
            <label>
              Product catalog for this number{accountInfo ? ` (${accountInfo.label || 'number'}${accountInfo.phone ? ' · +' + accountInfo.phone : ''})` : ''}
            </label>
            <select className="select" value={catalogSel} onChange={(e) => setCatalogSel(e.target.value)}>
              <option value="">
                {catalogs.length === 1 ? `Automatic — ${catalogs[0].name}` : catalogs.length ? 'Not chosen (no products)' : 'No catalogs yet'}
              </option>
              {catalogs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type === 'api' ? 'API' : 'manual'}, {c.count} product{c.count === 1 ? '' : 's'})
                </option>
              ))}
              <option value="none">Don't use products for this number</option>
            </select>
            <div className="hint">
              The AI answers product questions from this catalog. Add or edit catalogs in <strong>Settings → AI → Product catalogs</strong>.
            </div>
          </div>
          <div className="hint" style={{ marginBottom: 12 }}>
            Turn AI auto-reply <strong>on or off per number</strong> using the toggle on each tab. The timing &amp; context settings below apply to all numbers.
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
