import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';

export default function Gateway() {
  const { wa, toast, refreshWa } = useApp();
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      await api.post('/wa/connect');
      toast('Starting WhatsApp link…');
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }
  async function logout() {
    if (!confirm('Unlink this WhatsApp number? You will need to scan again.')) return;
    await api.post('/wa/logout');
    toast('WhatsApp unlinked');
    refreshWa();
  }

  return (
    <div className="card card-pad">
      {wa.status === 'connected' ? (
        <div className="qr-stage">
          <div style={{ display: 'grid', placeItems: 'center' }}>
            <div className="pulse-ring">
              <Icon.check style={{ width: 40 }} />
            </div>
          </div>
          <div>
            <span className="badge green" style={{ marginBottom: 10 }}>● Connected</span>
            <h2 style={{ fontSize: 22, margin: '6px 0' }}>{wa.me?.name || 'WhatsApp linked'}</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              Number <strong>+{wa.me?.phone}</strong> is linked and ready. The paced sender will
              deliver queued messages inside each campaign's window.
            </p>
            <div className="flex" style={{ marginTop: 20 }}>
              <button className="btn danger" onClick={logout}><Icon.logout /> Unlink number</button>
            </div>
            <div className="card" style={{ background: 'var(--surface-2)', border: 'none', padding: 16, marginTop: 20 }}>
              <div className="flex" style={{ gap: 8 }}>
                <Icon.shield style={{ width: 16, color: 'var(--brand-700)' }} />
                <strong style={{ fontSize: 13 }}>Keep this number healthy</strong>
              </div>
              <ul className="muted" style={{ fontSize: 13, margin: '10px 0 0 18px', lineHeight: 1.8 }}>
                <li>Keep your phone online — this links as a companion device.</li>
                <li>Warm up slowly; let limits ramp over the first days.</li>
                <li>Always include an opt-out; replies pause automation instantly.</li>
              </ul>
            </div>
          </div>
        </div>
      ) : wa.status === 'qr' && wa.qr ? (
        <div className="qr-stage">
          <div className="qr-box">
            <img src={wa.qr} alt="WhatsApp QR code" />
          </div>
          <div>
            <h2 style={{ fontSize: 20, marginBottom: 16 }}>Link your WhatsApp</h2>
            <div className="step"><div className="step-num">1</div><div>Open <strong>WhatsApp</strong> on your phone.</div></div>
            <div className="step"><div className="step-num">2</div><div>Tap <strong>Settings → Linked Devices → Link a device</strong>.</div></div>
            <div className="step"><div className="step-num">3</div><div>Point your phone at this QR code to scan it.</div></div>
            <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              The code refreshes automatically. This uses the official WhatsApp multi-device link —
              no third-party API.
            </p>
          </div>
        </div>
      ) : wa.status === 'connecting' ? (
        <div className="empty">
          <div className="spinner" style={{ margin: '0 auto 18px' }} />
          <h3>Connecting to WhatsApp…</h3>
          <p>Preparing a secure link. A QR code will appear in a moment.</p>
        </div>
      ) : (
        <div className="empty">
          <div className="emoji"><Icon.gateway /></div>
          <h3>No number linked</h3>
          <p style={{ maxWidth: 420, margin: '0 auto' }}>
            Connect your WhatsApp by scanning a QR code — just like WhatsApp Web. Your number stays
            yours; we never use the paid Business API.
          </p>
          <div style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={connect} disabled={busy}>
              <Icon.link /> {busy ? 'Starting…' : 'Connect WhatsApp'}
            </button>
          </div>
          {wa.lastError && <p className="muted" style={{ marginTop: 14, fontSize: 12 }}>Last: {wa.lastError}</p>}
        </div>
      )}
    </div>
  );
}
