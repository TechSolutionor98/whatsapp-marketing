import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Loading } from '../ui.jsx';
import { LinkChoiceModal, OfficialNumberModal, OfficialSetupModal } from './OfficialNumber.jsx';

// All WhatsApp numbers are linked, unlinked and renamed here, and one is picked as the
// default (Conversations opens on it). The Conversations page only shows their tabs.
export default function Gateway() {
  const { wa, toast, refreshWa, onBus, workspace } = useApp();
  // Only the original workspace has the "main number"; every other workspace links its own
  // numbers below, and its default number is its main one.
  const hasMain = workspace?.main !== false;
  const [busy, setBusy] = useState(false);
  const [numbers, setNumbers] = useState(null); // every number with a Conversations tab
  const [adding, setAdding] = useState(false); // QR link window
  const [choosing, setChoosing] = useState(false); // QR or official API?
  const [official, setOfficial] = useState(false); // official API connect window
  const [setupFor, setSetupFor] = useState(null); // an official number's setup window

  const loadNumbers = async () => {
    try {
      setNumbers(await api.get('/conversations/accounts'));
    } catch {
      setNumbers((n) => n || []);
    }
  };
  useEffect(() => {
    loadNumbers();
    const t = setInterval(loadNumbers, 8000);
    const off = onBus((ev) => {
      if (ev === 'pool:update' || ev === 'wa:status') loadNumbers();
    });
    return () => {
      clearInterval(t);
      off?.();
    };
  }, []);

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
    if (!confirm('Unlink the main WhatsApp number? You will need to scan again.')) return;
    await api.post('/wa/logout');
    toast('WhatsApp unlinked');
    refreshWa();
    loadNumbers();
  }

  const nameOf = (a) => a.label || (a.id === 'main' ? 'Main number' : a.phone ? `+${a.phone}` : 'Number');

  async function makeDefault(a) {
    try {
      await api.put(`/conversations/accounts/${a.id}/default`);
      toast(`${nameOf(a)} is now the default number`, 'success');
      loadNumbers();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function rename(a) {
    const name = prompt('Name this number (so you remember which WhatsApp it is)', a.label || '');
    if (name == null) return;
    try {
      await api.put(`/conversations/accounts/${a.id}/label`, { label: name.trim() });
      loadNumbers();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function unlink(a) {
    if (a.id === 'main') return logout();
    const again = a.kind === 'cloud' ? 'Its messages stop arriving here. It stays registered with Meta, and you can connect it again with its details.' : 'You can link it again any time by scanning its QR code.';
    if (!confirm(`Unlink ${nameOf(a)}${a.label && a.phone ? ` (+${a.phone})` : ''} from the app? ${again}`)) return;
    try {
      await api.del(`/conversations/accounts/${a.id}`);
      toast('Number unlinked');
      loadNumbers();
      refreshWa();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  const mainLinked = wa.status === 'connected';
  const def = (numbers || []).find((n) => n.default) || null;

  return (
    <>
      <div className="card card-pad">
        {!hasMain ? (
          numbers === null ? (
            <Loading label="Loading numbers…" minHeight={160} />
          ) : !def ? (
            <div className="empty">
              <div className="emoji"><Icon.gateway /></div>
              <h3>No WhatsApp number linked yet</h3>
              <p style={{ maxWidth: 440, margin: '0 auto' }}>
                Link {workspace?.name ? `${workspace.name}'s` : 'your'} WhatsApp by scanning a QR code (free, like WhatsApp Web), or connect an
                official WhatsApp Business number through Meta's API. The first number becomes the default: campaigns send from it and
                Conversations opens on it.
              </p>
              <div style={{ marginTop: 18 }}>
                <button className="btn primary" onClick={() => setChoosing(true)}>
                  <Icon.link /> Connect WhatsApp
                </button>
              </div>
            </div>
          ) : (
            <div className="qr-stage">
              <div style={{ display: 'grid', placeItems: 'center' }}>
                <div className={def.connected ? 'pulse-ring' : 'pulse-ring off'}>
                  {def.connected ? <Icon.check style={{ width: 40 }} /> : <div className="spinner" />}
                </div>
              </div>
              <div>
                <span className={`badge ${def.connected ? 'green' : 'amber'}`} style={{ marginBottom: 10 }}>
                  {def.connected ? '● Connected · Default number' : 'Reconnecting… · Default number'}
                </span>
                <h2 style={{ fontSize: 22, margin: '6px 0' }}>{def.label || def.name || `+${def.phone}`}</h2>
                <p className="muted" style={{ fontSize: 14 }}>
                  Number <strong>+{def.phone}</strong> {def.connected ? 'is linked and ready.' : 'is reconnecting.'} Campaigns send from it
                  unless you pick another number, and Conversations opens on it.
                </p>
                <div className="flex" style={{ marginTop: 20 }}>
                  <button className="btn" onClick={() => setChoosing(true)}><Icon.plus /> Link another number</button>
                </div>
              </div>
            </div>
          )
        ) : wa.status === 'connected' ? (
          <div className="qr-stage">
            <div style={{ display: 'grid', placeItems: 'center' }}>
              <div className="pulse-ring">
                <Icon.check style={{ width: 40 }} />
              </div>
            </div>
            <div>
              <span className="badge green" style={{ marginBottom: 10 }}>● Connected · Main number</span>
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
            <h3>No main number linked</h3>
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

      {(hasMain || numbers?.length > 0) && (
      <div className="card num-card">
        <div className="card-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>Your WhatsApp numbers</h3>
            <div className="sub">
              Link, unlink or rename numbers here. Conversations opens on the default number{hasMain ? '' : ', and campaigns send from it unless you pick another'}.
            </div>
          </div>
          <button className="btn primary sm" onClick={() => setChoosing(true)}>
            <Icon.plus /> Link another number
          </button>
        </div>
        {numbers === null ? (
          <Loading label="Loading numbers…" minHeight={120} />
        ) : (
          <div className="num-list">
            {numbers.map((a) => {
              const isMain = a.id === 'main';
              const isCloud = a.kind === 'cloud';
              const conn = isMain ? mainLinked : a.connected; // main: same status as the card above
              const state = conn ? 'Connected' : isMain ? 'Not linked' : isCloud ? 'Check its setup' : 'Reconnecting…';
              const name = nameOf(a);
              return (
                <div key={a.id} className={`num-row ${a.default ? 'is-default' : ''}`}>
                  <span className={`wa-tab-dot ${conn ? 'on' : isMain ? '' : 'connecting'}`} title={state} />
                  <div className="num-main">
                    <div className="num-name">
                      <span className="num-label">{name}</span>
                      {a.default && <span className="badge green num-default">Default</span>}
                      {isCloud && <span className="badge blue" title="Connected through Meta's WhatsApp Cloud API">Official API</span>}
                      {isCloud && a.cloud?.quality && <span className="chip" title="Meta's quality rating for this number">quality: {a.cloud.quality.toLowerCase()}</span>}
                    </div>
                    <div className="num-sub">
                      {a.phone && name !== `+${a.phone}` ? `+${a.phone} · ` : ''}{state} ·{' '}
                      {isMain ? 'campaigns, warm-up and chats' : !hasMain && a.default ? 'campaigns, chats and AI replies' : 'chats and AI replies'}
                      {isCloud && !a.cloud?.webhook_ok && <span className="num-warn"> · webhook not set up yet (no incoming messages)</span>}
                    </div>
                  </div>
                  <div className="num-actions">
                    {!a.default && a.phone && (
                      <button className="btn sm" onClick={() => makeDefault(a)} title="Open Conversations on this number">
                        Make default
                      </button>
                    )}
                    {isCloud && (
                      <button className="btn sm" onClick={() => setSetupFor(a.id)} title="Webhook, token and status">
                        <Icon.settings /> Setup
                      </button>
                    )}
                    <button className="btn sm ghost" onClick={() => rename(a)} title="Rename">
                      <Icon.edit /> Rename
                    </button>
                    {(!isMain || mainLinked) && (
                      <button className="btn sm danger" onClick={() => unlink(a)} title="Unlink this number from the app">
                        <Icon.logout /> Unlink
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {choosing && (
        <LinkChoiceModal
          onClose={() => setChoosing(false)}
          onPick={(how) => {
            setChoosing(false);
            if (how === 'cloud') setOfficial(true);
            else setAdding(true);
          }}
        />
      )}
      {official && <OfficialNumberModal onClose={() => { setOfficial(false); loadNumbers(); }} onDone={loadNumbers} />}
      {setupFor && <OfficialSetupModal id={setupFor} onClose={() => { setSetupFor(null); loadNumbers(); }} onChanged={loadNumbers} />}

      {adding && (
        <AddNumberModal
          onClose={() => setAdding(false)}
          onLinked={() => {
            setAdding(false);
            // The new number takes a moment to register server-side — refresh a few times.
            let n = 0;
            const iv = setInterval(() => { loadNumbers(); if (++n >= 8) clearInterval(iv); }, 1500);
          }}
        />
      )}
    </>
  );
}

// Link another number (for Conversations + AI replies). Its QR shows as soon as the window opens.
function AddNumberModal({ onClose, onLinked }) {
  const { toast, onBus } = useApp();
  const [label, setLabel] = useState('');
  const [id, setId] = useState(null);
  const [qr, setQr] = useState(null);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState('');
  const startedRef = useRef(false);
  const linkedRef = useRef(false);
  const sawQrRef = useRef(false); // a QR was shown → a later 'connecting' means it was scanned

  // Start the WhatsApp session as soon as the window opens, so the QR is ready by the time
  // you look at it (≈1 s). The label is optional and can be typed while the QR shows.
  useEffect(() => {
    if (startedRef.current) return; // guard against a double mount creating two numbers
    startedRef.current = true;
    api
      .post('/conversations/accounts', { label: '' })
      .then((r) => {
        setId(r.id);
        setStatus('connecting');
      })
      .catch((e) => setFailed(e.message));
  }, []);

  // Save the label as it's typed (debounced) — uses the normal rename endpoint.
  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => api.put(`/conversations/accounts/${id}/label`, { label: label.trim() }).catch(() => {}), 500);
    return () => clearTimeout(t);
  }, [label, id]);

  // QR + link status: refresh the moment the server says something changed (live event),
  // with a short poll as a fallback if the live connection drops.
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.get(`/conversations/accounts/${id}/qr`);
        if (stop) return;
        if (s.qr) sawQrRef.current = true;
        setQr(s.qr);
        setStatus(s.status);
        if (s.status === 'connected' && !linkedRef.current) {
          linkedRef.current = true;
          toast('Number linked ✓ — its chats are loading in Conversations', 'success');
          onLinked(id);
        }
      } catch {}
    };
    tick();
    const off = onBus((ev) => {
      if (ev === 'pool:update') tick();
    });
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
      off?.();
    };
  }, [id]);

  async function cancel() {
    // Only discard if it was never scanned (still showing a QR). If it's linking or
    // linked, keep it — it appears in the list on its own once connected.
    const scanned = sawQrRef.current && status === 'connecting'; // linking in progress — keep it
    if (id && !linkedRef.current && !scanned) {
      try { await api.del(`/conversations/accounts/${id}`); } catch {}
    }
    onClose();
  }

  return (
    <Modal
      title="Link another WhatsApp number"
      onClose={cancel}
      footer={<button className="btn" onClick={cancel}>{status === 'connected' ? 'Done' : 'Close'}</button>}
    >
      <div className="field">
        <label>Label (optional)</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Support line" />
        <div className="hint">This number is only for Conversations + AI replies — it won't be used for campaigns or warm-up.</div>
      </div>
      <div style={{ textAlign: 'center' }}>
        {failed ? (
          <div className="auth-error">{failed}</div>
        ) : status === 'connected' ? (
          <div className="auth-note">Linked! Its chats are loading in Conversations — you can close this.</div>
        ) : qr ? (
          <>
            <img src={qr} alt="WhatsApp QR" style={{ width: 260, height: 260, borderRadius: 12 }} />
            <div className="hint" style={{ marginTop: 10 }}>
              On the phone for this number: <strong>WhatsApp → Linked Devices → Link a device</strong>, then scan this code.
              Keep WhatsApp open on the phone until the chats appear.
            </div>
          </>
        ) : (
          <Loading label={sawQrRef.current ? 'Scanned — linking…' : 'Preparing QR…'} minHeight={260} />
        )}
      </div>
    </Modal>
  );
}
