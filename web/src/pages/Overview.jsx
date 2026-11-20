import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { StatusBadge, Empty, Loading, timeAgo, initials } from '../ui.jsx';

// Chart colours (validated together for colour-blind separation and contrast on white).
const SENT = '#059669';
const RECEIVED = '#2a78d6';

const fmt = (n) => (n ?? 0).toLocaleString();
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const sum = (a) => a.reduce((n, x) => n + x, 0);
const dayLabel = (key, opts = { day: 'numeric', month: 'short' }) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });

// ---- Small pieces ----

// A 14-point trend line in a quiet grey; today is the coloured dot.
function Spark({ values, color }) {
  if (!values?.length || !values.some((v) => v > 0)) return null;
  const W = 112, H = 30, P = 4;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [P + (i * (W - 2 * P)) / (values.length - 1), H - P - (v / max) * (H - 2 * P)]);
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="ov-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="#b9c4d2" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="4" fill={color} stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

function Delta({ now, before, upIsGood = true }) {
  if (!now && !before) return <span className="ov-delta flat">No activity in the last 2 weeks</span>;
  if (!before) return <span className="ov-delta up">New this week</span>;
  const d = Math.round(((now - before) / before) * 100);
  if (d === 0) return <span className="ov-delta flat">Same as the week before</span>;
  const good = d > 0 === upIsGood;
  return (
    <span className={`ov-delta ${good ? 'up' : 'down'}`}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d)}% <span className="ov-delta-vs">vs the week before</span>
    </span>
  );
}

function Kpi({ label, value, icon, color, children, spark, sparkColor, onClick, accent }) {
  const I = Icon[icon];
  const press = onClick
    ? { role: 'button', tabIndex: 0, onClick, onKeyDown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) }
    : {};
  return (
    <div className={`stat ov-kpi ${accent ? 'accent-red' : ''} ${onClick ? 'ov-click' : ''}`} {...press}>
      <div className={`ico ${color}`}><I /></div>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="hint">{children}</div>
      {spark && <Spark values={spark} color={sparkColor} />}
    </div>
  );
}

// A filled share of a whole, on a lighter track of the same colour.
function Meter({ label, value, of, tone = 'green', note }) {
  const p = pct(value, of);
  return (
    <div className="ov-meter">
      <div className="ov-meter-top">
        <span>{label}</span>
        <strong>{of ? `${p}%` : '—'}</strong>
      </div>
      <div className={`ov-meter-track ${tone}`}>
        <span style={{ width: `${p}%` }} />
      </div>
      <div className="ov-meter-note">{note ?? `${fmt(value)} of ${fmt(of)}`}</div>
    </div>
  );
}

// ---- Messages per day: grouped columns, sent vs received ----

// Size of an element (re-measured when it is shown again, e.g. after the table view).
function useSize(ref, shown) {
  const [size, setSize] = useState({ w: 640, h: 240 });
  useEffect(() => {
    if (!shown || !ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(260, Math.floor(e.contentRect.width)), h: Math.floor(e.contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref, shown]);
  return size;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const step0 = v / 4;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  return step * 4;
}

// Column with a 4px rounded top, square on the baseline.
function colPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function DailyChart({ days }) {
  const wrap = useRef(null);
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const { w: width, h: boxH } = useSize(wrap, !table);
  const H = Math.min(440, Math.max(230, boxH)), M = { t: 12, r: 6, b: 28, l: 40 };
  const pw = width - M.l - M.r, ph = H - M.t - M.b;
  const top = niceMax(Math.max(...days.map((d) => Math.max(d.sent, d.received)), 0));
  const ticks = [0, 1, 2, 3, 4].map((i) => (top / 4) * i);
  const band = pw / days.length;
  const bw = Math.max(3, Math.min(24, (band - 10) / 2));
  const y = (v) => M.t + ph - (v / top) * ph;
  const every = band >= 44 ? 1 : band >= 22 ? 2 : 3;
  const empty = !days.some((d) => d.sent || d.received);
  const totals = { sent: sum(days.map((d) => d.sent)), received: sum(days.map((d) => d.received)) };
  const h = hover != null ? days[hover] : null;

  return (
    <div className="card ov-chart-card">
      <div className="card-head">
        <Icon.send style={{ width: 18, color: 'var(--brand-700)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>Messages, last 14 days</h3>
          <div className="sub">{fmt(totals.sent)} sent · {fmt(totals.received)} received</div>
        </div>
        <button className="btn sm ghost" onClick={() => setTable(!table)}>{table ? 'Chart' : 'Table'}</button>
      </div>
      <div className="card-pad ov-chart-pad">
        <div className="ov-legend">
          <span><i style={{ background: SENT }} /> Sent</span>
          <span><i style={{ background: RECEIVED }} /> Received</span>
        </div>
        {table ? (
          <div className="table-wrap ov-table">
            <table>
              <thead><tr><th>Day</th><th>Sent</th><th>Received</th></tr></thead>
              <tbody>
                {[...days].reverse().map((d) => (
                  <tr key={d.day}><td>{dayLabel(d.day, { weekday: 'short', day: 'numeric', month: 'short' })}</td><td>{fmt(d.sent)}</td><td>{fmt(d.received)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div ref={wrap} className="ov-chart" onMouseLeave={() => setHover(null)}>
            <svg width={width} height={H} role="img" aria-label={`Messages per day for the last 14 days: ${fmt(totals.sent)} sent, ${fmt(totals.received)} received`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#d4dce7' : '#eef1f5'} strokeWidth="1" />
                  <text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="ov-axis">{fmt(t)}</text>
                </g>
              ))}
              {days.map((d, i) => {
                const x0 = M.l + i * band;
                const gx = x0 + (band - (bw * 2 + 2)) / 2;
                const hs = (d.sent / top) * ph, hr = (d.received / top) * ph;
                const isToday = i === days.length - 1;
                return (
                  <g
                    key={d.day}
                    tabIndex={0}
                    className="ov-band"
                    aria-label={`${dayLabel(d.day)}: ${d.sent} sent, ${d.received} received`}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                  >
                    <rect x={x0} y={M.t} width={band} height={ph} fill={hover === i ? '#f3f6fa' : 'transparent'} rx="6" />
                    {hs > 0 && <path d={colPath(gx, y(d.sent), bw, hs)} fill={SENT} />}
                    {hr > 0 && <path d={colPath(gx + bw + 2, y(d.received), bw, hr)} fill={RECEIVED} />}
                    {(i % every === (days.length - 1) % every) && (
                      <text x={x0 + band / 2} y={H - 8} textAnchor="middle" className={`ov-axis ${isToday ? 'today' : ''}`}>
                        {isToday ? 'Today' : dayLabel(d.day)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {empty && <div className="ov-chart-empty">No messages in the last 14 days yet</div>}
            {h && (
              <div className="ov-tip" style={{ left: Math.min(Math.max(M.l + hover * band + band / 2, 80), width - 80) }}>
                <div className="ov-tip-day">{dayLabel(h.day, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                <div className="ov-tip-row"><i style={{ background: SENT }} /><strong>{fmt(h.sent)}</strong> sent</div>
                <div className="ov-tip-row"><i style={{ background: RECEIVED }} /><strong>{fmt(h.received)}</strong> received</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Getting started (until a workspace has done the basics) ----

const STEPS = [
  ['number', 'Link a WhatsApp number', 'Scan a QR code from WhatsApp → Linked Devices.', 'gateway', 'Link a number'],
  ['contacts', 'Add your contacts', 'Import an Excel or CSV file, or add people one by one.', 'contacts', 'Add contacts'],
  ['template', 'Write your message', 'Use {{first_name}} and spin text so every message is different.', 'templates', 'New template'],
  ['campaign', 'Start a campaign', 'Pick a message and who gets it. It sends at a safe pace.', 'campaigns', 'New campaign'],
  ['ai', 'Turn on AI replies', 'Add your AI key in Settings → AI so the assistant can answer chats.', 'settings', 'Add AI key'],
];

function GettingStarted({ setup, wsId, go, can }) {
  const key = `pulse.setupHidden.${wsId}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const steps = STEPS.filter(([id]) => id !== 'ai' || setup.aiAllowed);
  const done = steps.filter(([id]) => setup[id]).length;
  if (hidden || done === steps.length) return null;
  const next = steps.find(([id]) => !setup[id])?.[0];
  const hide = () => {
    try {
      localStorage.setItem(key, '1');
    } catch {}
    setHidden(true);
  };
  return (
    <div className="card ov-setup">
      <div className="ov-setup-head">
        <div>
          <h3>Get started</h3>
          <div className="sub">{done} of {steps.length} done. Finish these and your WhatsApp marketing is running.</div>
        </div>
        <button className="btn sm ghost" onClick={hide} title="Hide this checklist">Hide</button>
      </div>
      <div className="progress ov-setup-bar"><span style={{ width: `${pct(done, steps.length)}%` }} /></div>
      <div className="ov-steps">
        {steps.map(([id, title, desc, page, cta], i) => {
          const ok = !!setup[id];
          return (
            <div key={id} className={`ov-step ${ok ? 'done' : ''} ${id === next ? 'next' : ''}`}>
              <div className="ov-step-n">{ok ? <Icon.check /> : i + 1}</div>
              <div className="ov-step-body">
                <div className="ov-step-title">{title}</div>
                <div className="ov-step-desc">{desc}</div>
                {!ok && can(page) && (
                  <button className={`btn sm ${id === next ? 'primary' : ''}`} onClick={() => go(page)}>{cta}</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- The page ----

export default function Overview({ go }) {
  const { stats, workspace, can, user } = useApp();
  const [ov, setOv] = useState(null);
  const [camps, setCamps] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const last = useRef(0);

  const loadOverview = async () => {
    last.current = Date.now();
    try {
      setOv(await api.get('/overview'));
    } catch {}
  };
  const loadLists = async () => {
    try {
      const [c, l] = await Promise.all([api.get('/campaigns'), api.get('/audit?limit=8')]);
      setCamps(c);
      setLogs(l);
    } catch {}
    setLoaded(true);
  };
  useEffect(() => {
    loadOverview();
    loadLists();
    const t1 = setInterval(loadLists, 10000);
    const t2 = setInterval(loadOverview, 30000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);
  // Live: the headline stats update on every message; refresh the rest at most every 5s.
  useEffect(() => {
    if (Date.now() - last.current > 5000) loadOverview();
  }, [stats]);

  const days = ov?.days || [];
  const sentSeries = days.map((d) => d.sent);
  const recSeries = days.map((d) => d.received);
  const recNow = sum(recSeries.slice(7));
  const recBefore = sum(recSeries.slice(0, 7));
  const order = { running: 0, scheduled: 1, paused: 2 };
  const showcase = [...camps].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)).slice(0, 3);
  const del = ov?.delivery;
  const s = ov?.sending;
  const firstName = (user?.name || '').split(' ')[0];

  return (
    <div className="ov">
      <div className="ov-hello">
        <div>
          <h2>{firstName ? `Hi ${firstName}` : 'Welcome back'}, here's {workspace?.name || 'your workspace'} today</h2>
          <div className="sub">
            {s ? (
              <>
                <span className={`ov-dot ${s.paused ? 'off' : 'on'}`} />
                {s.paused ? 'Campaign sending is paused' : s.running ? `Sending: ${s.running} campaign${s.running === 1 ? '' : 's'} running` : 'Ready to send: no campaign running'}
                {s.windowStart && s.windowEnd ? ` · hours ${s.windowStart}–${s.windowEnd}${s.timezone ? ` (${s.timezone})` : ''}` : ''}
                {s.minDelaySec ? ` · at least ${s.minDelaySec}s between messages` : ''}
                {s.maxPerNumberDay ? ` · up to ${s.maxPerNumberDay}/day per number` : ''}
              </>
            ) : (
              'Loading today’s numbers…'
            )}
          </div>
        </div>
        <div className="ov-actions">
          {can('campaigns') && <button className="btn primary sm" onClick={() => go('campaigns')}><Icon.plus /> New campaign</button>}
          {can('contacts') && <button className="btn sm" onClick={() => go('contacts')}><Icon.upload /> Import contacts</button>}
          {can('conversations') && <button className="btn sm" onClick={() => go('conversations')}><Icon.chat /> Inbox</button>}
        </div>
      </div>

      {ov?.setup && <GettingStarted setup={ov.setup} wsId={workspace?.id || 'default'} go={go} can={can} />}

      <div className="stat-grid">
        <Kpi label="Total leads" value={fmt(stats.totalLeads)} icon="users" color="green">
          {ov ? (ov.leadsNew7 ? <span className="ov-delta up">+{fmt(ov.leadsNew7)} added this week</span> : 'Eligible for campaigns') : 'Eligible for campaigns'}
        </Kpi>
        <Kpi label="Messages sent" value={fmt(stats.messagesSent)} icon="send" color="blue" spark={sentSeries} sparkColor={SENT}>
          {fmt(stats.sentToday)} sent today
        </Kpi>
        <Kpi label="Replies, last 7 days" value={ov ? fmt(recNow) : '—'} icon="chat" color="violet" spark={recSeries} sparkColor={RECEIVED}>
          {ov ? <Delta now={recNow} before={recBefore} /> : 'Messages people sent you'}
        </Kpi>
        <Kpi
          label="Needs a person"
          value={fmt(stats.handoffs)}
          icon="hand"
          color={stats.handoffs > 0 ? 'red' : 'green'}
          accent={stats.handoffs > 0}
          onClick={can('conversations') ? () => go('conversations') : undefined}
        >
          {stats.handoffs > 0 ? 'Chats waiting for your team →' : 'Nobody is waiting'}
        </Kpi>
      </div>

      <div className="ov-row ov-row-wide">
        {ov ? <DailyChart days={days} /> : <div className="card"><Loading label="Loading chart…" minHeight={300} /></div>}

        <div className="card">
          <div className="card-head">
            <Icon.check style={{ width: 18, color: 'var(--brand-700)' }} />
            <div>
              <h3>Campaign delivery</h3>
              <div className="sub">Campaign messages, last 30 days</div>
            </div>
          </div>
          <div className="card-pad">
            {!del ? (
              <Loading label="Loading…" minHeight={200} />
            ) : (
              <>
                <div className="ov-big">
                  <strong>{fmt(del.sent)}</strong> campaign messages sent
                </div>
                <Meter label="Delivered" value={del.delivered} of={del.sent} />
                <Meter label="Read" value={del.read} of={del.sent} />
                <Meter label="Not sent (rejected)" value={del.failed} of={del.sent} tone="red" />
                <div className="ov-facts">
                  <div><strong>{fmt(ov.queued)}</strong><span>Waiting to send</span></div>
                  <div><strong>{fmt(stats.failedBounced)}</strong><span>Failed / not on WhatsApp</span></div>
                  <div><strong>{fmt(ov.optedOut)}</strong><span>Opted out</span></div>
                  <div><strong>{fmt(ov.aiToday)}</strong><span>AI replies today</span></div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid-2 ov-row">
        <div className="card">
          <div className="card-head">
            <Icon.megaphone style={{ width: 18, color: 'var(--brand-700)' }} />
            <div>
              <h3>Campaigns</h3>
              <div className="sub">Live delivery progress</div>
            </div>
            {can('campaigns') && <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => go('campaigns')}>All campaigns</button>}
          </div>
          <div className="card-pad">
            {!loaded ? (
              <Loading label="Loading…" minHeight={160} />
            ) : showcase.length === 0 ? (
              <Empty icon="megaphone" title="No campaigns yet" action={can('campaigns') && <button className="btn primary" onClick={() => go('campaigns')}><Icon.plus /> Create campaign</button>}>
                Build your first paced campaign.
              </Empty>
            ) : (
              showcase.map((c) => (
                <div key={c.id} className="ov-camp">
                  <div className="flex between">
                    <div className="flex" style={{ gap: 8, minWidth: 0 }}>
                      <StatusBadge status={c.status} />
                      <strong className="ov-ellipsis">{c.name}</strong>
                    </div>
                    <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmt(c.progress.done)}/{fmt(c.progress.total)} ({c.progress.percent}%)
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, margin: '6px 0 8px' }}>
                    <Icon.clock style={{ width: 13, verticalAlign: '-2px' }} />{' '}
                    {c.status === 'scheduled' && c.scheduled_at ? `Starts ${new Date(c.scheduled_at).toLocaleString()} · ` : ''}
                    {c.window_start}–{c.window_end} · {c.daily_limit}/day · {c.timezone}
                  </div>
                  <div className="progress"><span style={{ width: `${c.progress.percent}%` }} /></div>
                  <div className="mini-stats ov-mini5">
                    <div className="mini-stat"><div className="v">{fmt(c.progress.queued)}</div><div className="l">Queued</div></div>
                    <div className="mini-stat"><div className="v" style={{ color: 'var(--brand-700)' }}>{fmt(c.progress.sent)}</div><div className="l">Sent</div></div>
                    <div className="mini-stat"><div className="v">{fmt(c.progress.read)}</div><div className="l">Read</div></div>
                    <div className="mini-stat"><div className="v" style={{ color: 'var(--info)' }}>{fmt(c.progress.replied)}</div><div className="l">Replied</div></div>
                    <div className="mini-stat"><div className="v" style={{ color: c.progress.failed ? 'var(--danger)' : undefined }}>{fmt(c.progress.failed)}</div><div className="l">Failed</div></div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {!ov ? (
          <div className="card"><Loading label="Loading…" minHeight={260} /></div>
        ) : ov.numbers ? (
          <div className="card">
            <div className="card-head">
              <Icon.phone style={{ width: 18, color: 'var(--brand-700)' }} />
              <div>
                <h3>Your WhatsApp numbers</h3>
                <div className="sub">
                  {ov.numbers.filter((n) => n.connected).length} of {ov.numbers.length} connected
                  {ov.sending.maxPerNumberDay ? ` · campaign limit ${ov.sending.maxPerNumberDay}/day each` : ''}
                </div>
              </div>
              {can('gateway') && <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => go('gateway')}>Manage</button>}
            </div>
            {ov.numbers.length === 0 ? (
              <div className="card-pad">
                <Empty icon="phone" title="No number linked yet" action={can('gateway') && <button className="btn primary" onClick={() => go('gateway')}><Icon.plus /> Link a number</button>}>
                  Link a WhatsApp number by scanning a QR code. It takes a few seconds.
                </Empty>
              </div>
            ) : (
              <div className="ov-nums">
                {ov.numbers.map((n) => {
                  const cap = ov.sending.maxPerNumberDay;
                  return (
                    <div key={n.id} className="ov-num">
                      <span className={`ov-num-dot ${n.connected ? 'on' : n.syncing ? 'sync' : 'off'}`} title={n.connected ? 'Connected' : 'Not connected'} />
                      <div className="ov-num-who">
                        <div className="ov-num-name">
                          <span className="ov-ellipsis">{n.label || `+${n.phone}`}</span>
                          {n.default && <span className="chip">Default</span>}
                          {n.autoReply && <span className="chip ov-ai"><Icon.sparkles /> AI on</span>}
                        </div>
                        <div className="ov-num-sub">+{n.phone} · {n.connected ? 'Connected' : n.syncing ? 'Syncing…' : 'Not connected'}</div>
                      </div>
                      <div className="ov-num-load">
                        <div className="ov-num-count"><strong>{fmt(n.sentToday)}</strong> sent today</div>
                        {cap > 0 && (
                          <>
                            <div className={`ov-meter-track thin ${n.campaignToday >= cap ? 'red' : 'green'}`} title={`${n.campaignToday} of ${cap} campaign messages today`}>
                              <span style={{ width: `${Math.min(100, pct(n.campaignToday, cap))}%` }} />
                            </div>
                            <div className="ov-num-cap">{n.campaignToday}/{cap} campaign</div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <RecentActivity loaded={loaded} logs={logs} go={go} can={can} />
        )}
      </div>

      {ov?.numbers && (
        <div className={ov?.waiting ? 'grid-2 ov-row' : 'ov-row'}>
          {ov?.waiting && (
            <div className="card">
              <div className="card-head">
                <Icon.hand style={{ width: 18, color: 'var(--brand-700)' }} />
                <div>
                  <h3>Waiting for a person</h3>
                  <div className="sub">Chats the AI handed to your team</div>
                </div>
                {can('conversations') && <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => go('conversations')}>Open inbox</button>}
              </div>
              {ov.waiting.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="check" title="All caught up">Nobody is waiting for a reply right now.</Empty>
                </div>
              ) : (
                <div>
                  {ov.waiting.map((w) => (
                    <button key={w.id} className="ov-wait" onClick={() => go('conversations')}>
                      <div className="avatar" style={{ width: 36, height: 36, fontSize: 12.5 }}>{initials(w.name, w.phone)}</div>
                      <div className="ov-wait-body">
                        <div className="ov-wait-top">
                          <strong className="ov-ellipsis">{w.name || `+${w.phone}`}</strong>
                          <span className="muted">{w.at ? timeAgo(w.at) : ''}</span>
                        </div>
                        <div className="ov-wait-msg">{w.last || 'No message text'}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <RecentActivity loaded={loaded} logs={logs} go={go} can={can} />
        </div>
      )}
    </div>
  );
}

function RecentActivity({ loaded, logs, go, can }) {
  return (
    <div className="card">
      <div className="card-head">
        <Icon.logs style={{ width: 18, color: 'var(--brand-700)' }} />
        <div>
          <h3>Recent activity</h3>
          <div className="sub">Latest events</div>
        </div>
        {can('audit') && <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => go('audit')}>View all</button>}
      </div>
      <div>
        {!loaded ? (
          <Loading label="Loading…" minHeight={160} />
        ) : logs.length === 0 ? (
          <Empty icon="logs" title="No activity yet">Events will appear here as things happen.</Empty>
        ) : (
          logs.map((l) => (
            <div key={l.id} className="log-row">
              <span className={`log-level lvl-${l.level}`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ov-log-msg">{l.message}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  <span className="log-type">{l.type}</span> · {timeAgo(l.created_at)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
