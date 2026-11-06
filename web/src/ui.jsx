import { Icon } from './icons.jsx';

export function Modal({ title, onClose, children, footer, wide }) {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal"
        style={wide ? { maxWidth: 720 } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="x-btn" onClick={onClose}>
            <Icon.x />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon = 'inbox', title, children, action }) {
  const I = Icon[icon] || Icon.inbox;
  return (
    <div className="empty">
      <div className="emoji">
        <I />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function Badge({ kind = 'gray', dot, children }) {
  return <span className={`badge ${kind} ${dot ? 'dot-badge' : ''}`}>{children}</span>;
}

const STATUS_MAP = {
  active: 'green',
  running: 'green',
  sent: 'green',
  completed: 'blue',
  scheduled: 'blue',
  draft: 'gray',
  queued: 'gray',
  paused: 'amber',
  opted_out: 'red',
  bounced: 'red',
  failed: 'red',
  replied: 'blue',
};
export function StatusBadge({ status }) {
  return (
    <Badge kind={STATUS_MAP[status] || 'gray'} dot>
      {String(status).replace('_', ' ')}
    </Badge>
  );
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function clockTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function initials(name, phone) {
  if (name && name.trim()) {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }
  return (phone || '?').slice(-2);
}
