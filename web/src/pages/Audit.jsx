import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Empty, timeAgo } from '../ui.jsx';

const TYPES = ['', 'connection', 'send', 'reply', 'handoff', 'campaign', 'system'];

export default function Audit() {
  const [logs, setLogs] = useState([]);
  const [type, setType] = useState('');

  const load = async () => {
    const params = type ? '?type=' + type : '';
    setLogs(await api.get('/audit' + params));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 7000);
    return () => clearInterval(t);
  }, [type]);

  return (
    <>
      <div className="toolbar">
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
          {TYPES.map((t) => (
            <button key={t || 'all'} className={`btn sm ${type === t ? 'primary' : ''}`} onClick={() => setType(t)}>
              {t || 'All'}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn sm" onClick={load}><Icon.refresh /> Refresh</button>
      </div>

      <div className="card">
        {logs.length === 0 ? (
          <Empty icon="logs" title="No log entries">Engine activity will show up here.</Empty>
        ) : (
          logs.map((l) => (
            <div key={l.id} className="log-row">
              <span className={`log-level lvl-${l.level}`} />
              <span className="log-type" style={{ minWidth: 92 }}>{l.type}</span>
              <div style={{ flex: 1 }}>{l.message}</div>
              <div className="log-time">{timeAgo(l.created_at)}</div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
