import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { StatusBadge, Empty, timeAgo } from '../ui.jsx';

function Stat({ label, value, hint, icon, color, accent }) {
  const I = Icon[icon];
  return (
    <div className={`stat ${accent ? 'accent-red' : ''}`}>
      <div className={`ico ${color}`}>
        <I />
      </div>
      <div className="label">{label}</div>
      <div className="value">{value ?? 0}</div>
      <div className="hint">{hint}</div>
    </div>
  );
}

export default function Overview({ go }) {
  const { stats } = useApp();
  const [camps, setCamps] = useState([]);
  const [logs, setLogs] = useState([]);

  const load = async () => {
    try {
      setCamps(await api.get('/campaigns'));
      setLogs(await api.get('/audit?limit=8'));
    } catch {}
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const running = camps.filter((c) => c.status === 'running');
  const showcase = running.length ? running : camps.slice(0, 2);

  return (
    <>
      <div className="stat-grid">
        <Stat label="Total Leads" value={stats.totalLeads} hint="Eligible in audience" icon="users" color="green" />
        <Stat label="Messages Sent" value={stats.messagesSent} hint={`${stats.sentToday || 0} sent today`} icon="send" color="blue" />
        <Stat label="Human Handoffs" value={stats.handoffs} hint="Awaiting a reply" icon="chat" color="violet" accent={stats.handoffs > 0} />
        <Stat label="Failed / Bounced" value={stats.failedBounced} hint="Not on WhatsApp / errors" icon="warn" color="red" />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <Icon.megaphone style={{ width: 18, color: 'var(--brand-700)' }} />
            <div>
              <h3>Active Campaigns</h3>
              <div className="sub">Live delivery progress</div>
            </div>
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => go('campaigns')}>
              All campaigns
            </button>
          </div>
          <div className="card-pad">
            {showcase.length === 0 ? (
              <Empty
                icon="megaphone"
                title="No campaigns yet"
                action={
                  <button className="btn primary" onClick={() => go('campaigns')}>
                    <Icon.plus /> Create campaign
                  </button>
                }
              >
                Build your first paced outreach run.
              </Empty>
            ) : (
              showcase.map((c) => (
                <div key={c.id} style={{ marginBottom: 18 }}>
                  <div className="flex between">
                    <div className="flex" style={{ gap: 8 }}>
                      <StatusBadge status={c.status} />
                      <strong>{c.name}</strong>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {c.progress.done}/{c.progress.total} ({c.progress.percent}%)
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, margin: '6px 0 8px' }}>
                    <Icon.clock style={{ width: 13, verticalAlign: '-2px' }} /> {c.window_start}–{c.window_end} · {c.daily_limit}/day · {c.timezone}
                  </div>
                  <div className="progress">
                    <span style={{ width: `${c.progress.percent}%` }} />
                  </div>
                  <div className="mini-stats">
                    <div className="mini-stat"><div className="v">{c.progress.queued}</div><div className="l">Queued</div></div>
                    <div className="mini-stat"><div className="v" style={{ color: 'var(--brand-700)' }}>{c.progress.sent}</div><div className="l">Sent</div></div>
                    <div className="mini-stat"><div className="v" style={{ color: 'var(--info)' }}>{c.progress.replied}</div><div className="l">Replies</div></div>
                    <div className="mini-stat"><div className="v" style={{ color: 'var(--danger)' }}>{c.progress.failed}</div><div className="l">Failed</div></div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <Icon.logs style={{ width: 18, color: 'var(--brand-700)' }} />
            <div>
              <h3>Recent Activity</h3>
              <div className="sub">Latest engine events</div>
            </div>
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => go('audit')}>
              View all
            </button>
          </div>
          <div>
            {logs.length === 0 ? (
              <Empty icon="logs" title="No activity yet">
                Events will appear here as the engine runs.
              </Empty>
            ) : (
              logs.map((l) => (
                <div key={l.id} className="log-row">
                  <span className={`log-level lvl-${l.level}`} />
                  <div style={{ flex: 1 }}>
                    <div>{l.message}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      <span className="log-type">{l.type}</span> · {timeAgo(l.created_at)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
