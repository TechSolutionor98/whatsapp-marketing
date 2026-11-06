import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';

const MODEL_HINTS = {
  groq: 'e.g. openai/gpt-oss-20b (fast) or openai/gpt-oss-120b (best). See console.groq.com for your models.',
  gemini: 'e.g. gemini-2.0-flash or gemini-1.5-flash',
  ollama: 'e.g. llama3.2 — must be pulled first: ollama pull llama3.2',
  custom: 'the exact model name your endpoint expects',
};

function Toggle({ checked, onChange }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}

function Num({ value, onChange, suffix, width = 90 }) {
  return (
    <div className="flex" style={{ gap: 6 }}>
      <input type="number" className="input" style={{ width }} value={value} onChange={(e) => onChange(+e.target.value)} />
      {suffix && <span className="muted" style={{ fontSize: 12 }}>{suffix}</span>}
    </div>
  );
}

export default function Settings() {
  const { toast } = useApp();
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);

  useEffect(() => {
    (async () => {
      setS(await api.get('/settings'));
      try {
        setAiStatus(await api.get('/ai/status'));
      } catch {}
    })();
  }, []);

  if (!s) return null;
  const set = (k, v) => setS({ ...s, [k]: v });

  async function save() {
    setSaving(true);
    try {
      await api.put('/settings', s);
      toast('Settings saved', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    setSaving(false);
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.bolt style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Pacing &amp; limits</h3><div className="sub">Default rhythm for new campaigns</div></div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="setting-row">
            <div><div className="st-label">Daily send cap</div><div className="st-desc">Hard ceiling of messages per day across the account.</div></div>
            <Num value={s.dailyLimit} onChange={(v) => set('dailyLimit', v)} suffix="msgs/day" />
          </div>
          <div className="setting-row">
            <div><div className="st-label">Delay between messages</div><div className="st-desc">Each send waits a random gap in this range — mimics human typing.</div></div>
            <div className="flex" style={{ gap: 8 }}>
              <Num value={s.minDelaySec} onChange={(v) => set('minDelaySec', v)} width={70} />
              <span className="muted">to</span>
              <Num value={s.maxDelaySec} onChange={(v) => set('maxDelaySec', v)} suffix="sec" width={70} />
            </div>
          </div>
          <div className="setting-row">
            <div><div className="st-label">Simulate typing</div><div className="st-desc">Show "typing…" before each message for a natural feel.</div></div>
            <Toggle checked={s.typingSimulation} onChange={(v) => set('typingSimulation', v)} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.clock style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Sending window</h3><div className="sub">Only send during waking hours</div></div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="setting-row">
            <div><div className="st-label">Active hours</div><div className="st-desc">Messages only go out between these local times.</div></div>
            <div className="flex" style={{ gap: 8 }}>
              <input type="time" className="input" style={{ width: 120 }} value={s.windowStart} onChange={(e) => set('windowStart', e.target.value)} />
              <span className="muted">to</span>
              <input type="time" className="input" style={{ width: 120 }} value={s.windowEnd} onChange={(e) => set('windowEnd', e.target.value)} />
            </div>
          </div>
          <div className="setting-row">
            <div><div className="st-label">Timezone</div><div className="st-desc">IANA name, e.g. Asia/Karachi, Europe/London.</div></div>
            <input className="input" style={{ width: 200 }} value={s.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <Icon.shield style={{ width: 18, color: 'var(--brand-700)' }} />
          <div><h3>Warm-up &amp; safety</h3><div className="sub">Protect a fresh number from bans</div></div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="setting-row">
            <div><div className="st-label">Gradual warm-up</div><div className="st-desc">Start low and ramp daily volume until the cap is reached.</div></div>
            <Toggle checked={s.warmupEnabled} onChange={(v) => set('warmupEnabled', v)} />
          </div>
          {s.warmupEnabled && (
            <div className="setting-row">
              <div><div className="st-label">Warm-up curve</div><div className="st-desc">Day-1 allowance, then increase this much each day.</div></div>
              <div className="flex" style={{ gap: 8 }}>
                <Num value={s.warmupStart} onChange={(v) => set('warmupStart', v)} suffix="start" width={70} />
                <span className="muted">+</span>
                <Num value={s.warmupStep} onChange={(v) => set('warmupStep', v)} suffix="/day" width={70} />
              </div>
            </div>
          )}
          <div className="setting-row">
            <div><div className="st-label">Handoff on reply</div><div className="st-desc">The instant a lead replies, pause automation and flag a human.</div></div>
            <Toggle checked={s.handoffOnReply} onChange={(v) => set('handoffOnReply', v)} />
          </div>
          <div className="setting-row">
            <div><div className="st-label">Opt-out keywords</div><div className="st-desc">Replies starting with these auto-unsubscribe the contact.</div></div>
            <input
              className="input"
              style={{ width: 260 }}
              value={(s.stopKeywords || []).join(', ')}
              onChange={(e) => set('stopKeywords', e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))}
            />
          </div>
        </div>
      </div>

      <AiCard s={s} set={set} status={aiStatus} />

      <div className="flex" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={save} disabled={saving}>
          <Icon.check /> {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

function AiCard({ s, set, status }) {
  const { toast } = useApp();
  const [sample, setSample] = useState('');
  const [testing, setTesting] = useState(false);
  const configured = status?.available;

  async function preview() {
    setTesting(true);
    setSample('');
    try {
      const r = await api.post('/ai/rewrite', {
        text: 'Hi {{first_name}}, just checking if you are still interested in our offer. Reply STOP to opt out.',
        tone: s.aiTone,
      });
      setSample(r.text);
    } catch (e) {
      toast(e.message, 'error');
    }
    setTesting(false);
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        <Icon.sparkles style={{ width: 18, color: 'var(--brand-700)' }} />
        <div>
          <h3>AI message variation</h3>
          <div className="sub">Rewrite every send uniquely so your number stays safe</div>
        </div>
        <span
          className={`badge ${configured ? 'green' : 'amber'}`}
          style={{ marginLeft: 'auto' }}
        >
          {configured ? '● Connected' : 'Not configured'}
        </span>
      </div>
      <div className="card-pad" style={{ paddingTop: 4 }}>
        {!configured && (
          <div className="auth-note" style={{ marginBottom: 4 }}>
            {s.aiProvider === 'ollama' ? (
              <>
                Start a local Ollama server (<code>ollama serve</code>) and pull a model
                (e.g. <code>ollama pull llama3.2</code>). No key needed.
              </>
            ) : (
              <>
                Add your free key to <code>.env</code> as <code>AI_API_KEY=…</code> and restart
                the server. Get a free Groq key (no card) at <code>console.groq.com/keys</code>.
              </>
            )}
          </div>
        )}
        <div className="setting-row">
          <div>
            <div className="st-label">Rewrite each message with AI</div>
            <div className="st-desc">
              Every recipient gets a unique, human-sounding version of your template — the strongest
              defense against spam detection. Falls back to the original if AI is unavailable.
            </div>
          </div>
          <Toggle checked={s.aiEnabled} onChange={(v) => set('aiEnabled', v)} />
        </div>
        <div className="setting-row">
          <div>
            <div className="st-label">Provider</div>
            <div className="st-desc">Groq is free & fast. Gemini uses a free key. Ollama runs locally (no key).</div>
          </div>
          <select className="select" style={{ width: 240 }} value={s.aiProvider || 'groq'} onChange={(e) => set('aiProvider', e.target.value)}>
            <option value="groq">Groq — free & fast (recommended)</option>
            <option value="gemini">Google Gemini — free key</option>
            <option value="ollama">Ollama — 100% local</option>
            <option value="custom">Custom endpoint</option>
          </select>
        </div>
        {s.aiProvider === 'custom' && (
          <div className="setting-row" style={{ display: 'block' }}>
            <div className="st-label" style={{ marginBottom: 8 }}>Custom base URL (OpenAI-compatible)</div>
            <input className="input" placeholder="https://your-endpoint/v1" value={s.aiBaseUrl || ''} onChange={(e) => set('aiBaseUrl', e.target.value)} />
          </div>
        )}
        <div className="setting-row">
          <div>
            <div className="st-label">Model</div>
            <div className="st-desc">{MODEL_HINTS[s.aiProvider] || MODEL_HINTS.groq}</div>
          </div>
          <input className="input" style={{ width: 260 }} value={s.aiModel || ''} placeholder="llama-3.3-70b-versatile" onChange={(e) => set('aiModel', e.target.value)} />
        </div>
        <div className="setting-row">
          <div>
            <div className="st-label">Tone</div>
            <div className="st-desc">How the rewritten messages should sound.</div>
          </div>
          <select className="select" style={{ width: 180 }} value={s.aiTone} onChange={(e) => set('aiTone', e.target.value)}>
            <option value="friendly">Friendly</option>
            <option value="professional">Professional</option>
            <option value="casual">Casual</option>
            <option value="enthusiastic">Enthusiastic</option>
          </select>
        </div>
        <div className="setting-row" style={{ display: 'block' }}>
          <div className="st-label" style={{ marginBottom: 8 }}>Extra guidance (optional)</div>
          <textarea
            className="textarea"
            style={{ minHeight: 70 }}
            placeholder="e.g. Always mention we're a local Karachi business. Never over-promise."
            value={s.aiInstructions || ''}
            onChange={(e) => set('aiInstructions', e.target.value)}
          />
        </div>

        {configured && (
          <>
            <div className="setting-row">
              <div>
                <div className="st-label">Auto-reply to incoming messages ✨</div>
                <div className="st-desc">
                  When a lead replies, AI answers automatically using the chat history. Falls back to a
                  human handoff if AI can't respond.
                </div>
              </div>
              <Toggle checked={s.autoReplyEnabled} onChange={(v) => set('autoReplyEnabled', v)} />
            </div>
            {s.autoReplyEnabled && (
              <div className="setting-row" style={{ display: 'block' }}>
                <div className="st-label" style={{ marginBottom: 8 }}>Auto-reply guidance (business context)</div>
                <textarea
                  className="textarea"
                  style={{ minHeight: 90 }}
                  placeholder="e.g. We're Grabatoz, an electronics store in Karachi. Answer product & delivery questions politely. For prices or orders you're unsure about, say a team member will follow up."
                  value={s.autoReplyInstructions || ''}
                  onChange={(e) => set('autoReplyInstructions', e.target.value)}
                />
              </div>
            )}
          </>
        )}
        {configured && (
          <div style={{ marginTop: 14 }}>
            <button className="btn sm" onClick={preview} disabled={testing}>
              <Icon.sparkles /> {testing ? 'Generating…' : 'Preview a variation'}
            </button>
            {sample && (
              <div className="phone" style={{ marginTop: 12, minHeight: 0 }}>
                <div className="bubble out" style={{ maxWidth: '100%' }}>{sample}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
