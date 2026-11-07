import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Empty, Loading } from '../ui.jsx';

/* ---------------- Block model ---------------- */
const BLOCKS = {
  greeting: { label: 'Greeting', icon: 'hand', make: () => ({ text: '{Hi|Hello|Hey} {{first_name}},' }) },
  text: { label: 'Text', icon: 'type', make: () => ({ text: '' }) },
  image: { label: 'Image', icon: 'image', make: () => ({ url: '', filename: '' }) },
  bullets: { label: 'Bullet list', icon: 'list', make: () => ({ items: ['', ''] }) },
  spin: { label: 'Spin text', icon: 'shuffle', make: () => ({ options: ['', ''] }) },
  cta: { label: 'Button / Link', icon: 'pointer', make: () => ({ label: '👉 Learn more', url: 'https://' }) },
  signoff: { label: 'Sign-off', icon: 'edit', make: () => ({ text: '— Team' }) },
  optout: { label: 'Opt-out', icon: 'shield', make: () => ({ text: 'Reply STOP to opt out.' }) },
};
const PALETTE = ['greeting', 'text', 'image', 'bullets', 'spin', 'cta', 'signoff', 'optout'];

let seq = 0;
const newBlock = (type) => ({ id: `b${Date.now()}_${seq++}`, type, ...BLOCKS[type].make() });

function compileBlock(b) {
  switch (b.type) {
    case 'greeting':
    case 'text':
    case 'signoff':
    case 'optout':
      return (b.text || '').trim();
    case 'bullets':
      return (b.items || []).map((s) => s.trim()).filter(Boolean).map((s) => `• ${s}`).join('\n');
    case 'spin': {
      const o = (b.options || []).map((s) => s.trim()).filter(Boolean);
      return o.length ? `{${o.join('|')}}` : '';
    }
    case 'cta':
      return [(b.label || '').trim(), (b.url || '').trim()].filter(Boolean).join('\n');
    default:
      return '';
  }
}
const compileAll = (blocks) =>
  blocks.map(compileBlock).map((s) => s.trim()).filter(Boolean).join('\n\n');

// Turn an AI-generated message into clean builder blocks: a Greeting (if the first
// line is a greeting) + a Text body. Avoids a second greeting stacking on the default.
function splitDraft(text) {
  const lines = text.split(/\n/);
  const first = (lines[0] || '').trim();
  const looksLikeGreeting =
    /^(hi|hello|hey|dear|good\s+(morning|afternoon|evening))\b/i.test(first) && first.length <= 60;
  if (looksLikeGreeting && lines.length > 1) {
    const rest = lines.slice(1).join('\n').trim();
    const out = [{ ...newBlock('greeting'), text: first }];
    if (rest) out.push({ ...newBlock('text'), text: rest });
    return out;
  }
  return [{ ...newBlock('text'), text }];
}

/* ---------------- Page ---------------- */
export default function Templates() {
  const { toast } = useApp();
  const [list, setList] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [builder, setBuilder] = useState(null); // {} for new, template for edit

  const load = async () => {
    try {
      setList(await api.get('/templates'));
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    load();
  }, []);

  async function remove(t) {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    await api.del('/templates/' + t.id);
    toast('Template deleted');
    load();
  }
  async function duplicate(t) {
    await api.post('/templates', {
      name: t.name + ' (copy)',
      body: t.body,
      category: t.category,
      blocks: t.blocks || null,
      media_url: t.media_url || null,
    });
    toast('Template duplicated', 'success');
    load();
  }

  return (
    <>
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn primary" onClick={() => setBuilder({})}>
          <Icon.plus /> New template
        </button>
      </div>

      {!loaded ? (
        <div className="card">
          <Loading label="Loading templates…" />
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          <Empty
            icon="template"
            title="No templates yet"
            action={
              <button className="btn primary" onClick={() => setBuilder({})}>
                <Icon.plus /> Build your first message
              </button>
            }
          >
            Drag blocks to build a message — greeting, text, bullet points, buttons — no typing code.
          </Empty>
        </div>
      ) : (
        <div className="grid-cards">
          {list.map((t) => (
            <div className="card camp-card" key={t.id}>
              <div className="flex between">
                <span className="badge gray">{t.category}</span>
                <div className="flex" style={{ gap: 2 }}>
                  <button className="btn ghost sm" title="Duplicate" onClick={() => duplicate(t)}>
                    <Icon.copy />
                  </button>
                  <button className="btn ghost sm" title="Edit" onClick={() => setBuilder(t)}>
                    <Icon.edit />
                  </button>
                  <button className="btn ghost sm" title="Delete" onClick={() => remove(t)}>
                    <Icon.trash />
                  </button>
                </div>
              </div>
              <h3 style={{ margin: '12px 0 8px', fontSize: 16 }}>{t.name}</h3>
              <div className="phone" style={{ minHeight: 0, padding: 12 }}>
                <div className="bubble out" style={{ maxWidth: '100%' }}>
                  {t.media_url && (
                    <img src={t.media_url} alt="" style={{ width: '100%', borderRadius: 8, marginBottom: t.body ? 6 : 0, display: 'block' }} />
                  )}
                  {t.body?.slice(0, 180) || (t.media_url ? '' : '—')}
                  {t.body?.length > 180 ? '…' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {builder && (
        <Builder
          tpl={builder}
          onClose={() => setBuilder(null)}
          onSaved={() => {
            setBuilder(null);
            load();
          }}
        />
      )}
    </>
  );
}

/* ---------------- Builder ---------------- */
function Builder({ tpl, onClose, onSaved }) {
  const { toast } = useApp();
  const isEdit = !!tpl.id;

  const [name, setName] = useState(tpl.name || '');
  const [category, setCategory] = useState(tpl.category || 'general');
  const [blocks, setBlocks] = useState(() => {
    if (Array.isArray(tpl.blocks) && tpl.blocks.length)
      return tpl.blocks.map((b) => ({ ...b, id: b.id || `b${Date.now()}_${seq++}` }));
    if (tpl.body) return [{ ...newBlock('text'), text: tpl.body }];
    return [newBlock('greeting'), newBlock('text')];
  });
  const [preview, setPreview] = useState([]);
  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [canvasOver, setCanvasOver] = useState(false);
  const [ai, setAi] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  const dragNew = useRef(null); // type being dragged from palette
  const dragMove = useRef(null); // id being reordered

  const compiled = compileAll(blocks);
  const mediaUrl = blocks.find((b) => b.type === 'image' && b.url)?.url || null;

  useEffect(() => {
    (async () => {
      try {
        setAi(await api.get('/ai/status'));
      } catch {}
    })();
  }, []);

  // Is the canvas just the untouched starter (greeting + empty text) or empty?
  function canvasIsStarter(bs) {
    return bs.every(
      (b) =>
        (b.type === 'greeting' && b.text === '{Hi|Hello|Hey} {{first_name}},') ||
        (b.type === 'text' && !b.text.trim()) ||
        (b.type === 'bullets' && (b.items || []).every((x) => !x.trim())) ||
        (b.type === 'spin' && (b.options || []).every((x) => !x.trim()))
    );
  }

  async function generateAi() {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const r = await api.post('/ai/draft', { prompt: aiPrompt.trim() });
      const text = (r.text || '').trim();
      const aiBlocks = splitDraft(text);
      setBlocks((bs) => {
        // Replace the starter blocks; otherwise append below existing content.
        if (bs.length === 0 || canvasIsStarter(bs)) return aiBlocks;
        return [...bs, ...aiBlocks];
      });
      setAiOpen(false);
      setAiPrompt('');
      toast('AI message created', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    setAiBusy(false);
  }

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!compiled.trim()) return setPreview([]);
      try {
        const r = await api.post('/templates/preview', { body: compiled });
        setPreview(r.samples.slice(0, 2));
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [compiled]);

  /* block ops */
  const patch = (id, p) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...p } : b)));
  const removeBlock = (id) => setBlocks((bs) => bs.filter((b) => b.id !== id));
  const addBlock = (type) => setBlocks((bs) => [...bs, newBlock(type)]);
  const insertBefore = (type, beforeId) =>
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === beforeId);
      const copy = [...bs];
      copy.splice(i < 0 ? copy.length : i, 0, newBlock(type));
      return copy;
    });
  const move = (id, dir) =>
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= bs.length) return bs;
      const copy = [...bs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  const reorder = (fromId, toId) =>
    setBlocks((bs) => {
      if (fromId === toId) return bs;
      const from = bs.findIndex((b) => b.id === fromId);
      const to = bs.findIndex((b) => b.id === toId);
      if (from < 0 || to < 0) return bs;
      const copy = [...bs];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      return copy;
    });

  /* drag handlers */
  const onBlockDrop = (targetId) => {
    if (dragMove.current) reorder(dragMove.current, targetId);
    else if (dragNew.current) insertBefore(dragNew.current, targetId);
    reset();
  };
  const reset = () => {
    dragNew.current = null;
    dragMove.current = null;
    setDragId(null);
    setDropTarget(null);
    setCanvasOver(false);
  };

  async function save() {
    if (!name.trim()) return toast('Name your template', 'error');
    if (!compiled.trim() && !mediaUrl) return toast('Add some content or an image', 'error');
    try {
      const payload = {
        name: name.trim(),
        category: category.trim() || 'general',
        body: compiled,
        blocks,
        media_url: mediaUrl,
      };
      if (isEdit) await api.put('/templates/' + tpl.id, payload);
      else await api.post('/templates', payload);
      toast('Template saved', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="builder-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="builder-head">
          <Icon.template style={{ width: 20, color: 'var(--brand-700)' }} />
          <input
            className="input"
            placeholder="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input"
            style={{ maxWidth: 150 }}
            placeholder="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <div className="spacer" />
          {ai?.available && (
            <button className="btn" onClick={() => setAiOpen((o) => !o)}>
              <Icon.sparkles /> Write with AI
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            <Icon.check /> Save template
          </button>
        </div>

        {aiOpen && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              padding: '12px 22px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--surface-2)',
            }}
          >
            <input
              className="input"
              autoFocus
              placeholder="Describe the message — e.g. 'short intro offering 20% off home cleaning this week'"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') generateAi();
              }}
            />
            <button className="btn primary" onClick={generateAi} disabled={aiBusy}>
              <Icon.sparkles /> {aiBusy ? 'Writing…' : 'Generate'}
            </button>
          </div>
        )}

        <div className="builder-grid">
          {/* Palette */}
          <div className="builder-col palette">
            <div className="palette-title">Drag a block →</div>
            {PALETTE.map((type) => {
              const B = BLOCKS[type];
              const I = Icon[B.icon];
              return (
                <div
                  key={type}
                  className="palette-item"
                  draggable
                  onDragStart={(e) => {
                    dragNew.current = type;
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('text/plain', type);
                  }}
                  onDragEnd={reset}
                  onClick={() => addBlock(type)}
                  title={`Add ${B.label}`}
                >
                  <I />
                  {B.label}
                </div>
              );
            })}
            <div className="palette-hint">
              Click a block to add it, or drag it onto the canvas. Drag the ⋮⋮ handle to reorder.
            </div>
          </div>

          {/* Canvas */}
          <div
            className={`builder-col canvas ${canvasOver ? 'dragover' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragNew.current) setCanvasOver(true);
            }}
            onDragLeave={() => setCanvasOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragNew.current) addBlock(dragNew.current);
              reset();
            }}
          >
            {blocks.length === 0 ? (
              <div className="canvas-empty">
                Drop blocks here to build your message
              </div>
            ) : (
              blocks.map((b, i) => (
                <BlockCard
                  key={b.id}
                  block={b}
                  index={i}
                  total={blocks.length}
                  dragging={dragId === b.id}
                  isDropTarget={dropTarget === b.id}
                  onPatch={(p) => patch(b.id, p)}
                  onRemove={() => removeBlock(b.id)}
                  onMove={(d) => move(b.id, d)}
                  onDragStart={() => {
                    dragMove.current = b.id;
                    setDragId(b.id);
                  }}
                  onDragEnd={reset}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragMove.current || dragNew.current) setDropTarget(b.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onBlockDrop(b.id);
                  }}
                />
              ))
            )}
          </div>

          {/* Preview */}
          <div className="builder-col preview-col">
            <div className="palette-title">Live preview</div>
            <div className="phone">
              {preview.length === 0 && !mediaUrl ? (
                <div className="muted" style={{ fontSize: 12.5, textAlign: 'center', padding: 20 }}>
                  Your message preview appears here.
                </div>
              ) : (
                (preview.length ? preview : ['']).map((p, i) => (
                  <div key={i} className="bubble out" style={{ maxWidth: '100%', marginBottom: 8 }}>
                    {mediaUrl && (
                      <img
                        src={mediaUrl}
                        alt=""
                        style={{ width: '100%', borderRadius: 8, marginBottom: p ? 6 : 0, display: 'block' }}
                      />
                    )}
                    {p}
                  </div>
                ))
              )}
            </div>
            <div className="palette-hint">
              Variables like <code>{'{{first_name}}'}</code> are filled per contact. Spin text{' '}
              <code>{'{a|b}'}</code> varies each send to look human and reduce spam risk.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- One block ---------------- */
function BlockCard({
  block,
  index,
  total,
  dragging,
  isDropTarget,
  onPatch,
  onRemove,
  onMove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}) {
  const B = BLOCKS[block.type];
  const I = Icon[B.icon];
  return (
    <div
      className={`block ${dragging ? 'dragging' : ''} ${isDropTarget && !dragging ? 'drop-target' : ''}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="block-head">
        <span
          className="block-handle"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', block.id);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          title="Drag to reorder"
        >
          <Icon.grip />
        </span>
        <span className="block-title">
          <I /> {B.label}
        </span>
        <div className="block-ctrls">
          <button onClick={() => onMove(-1)} disabled={index === 0} title="Move up">
            <Icon.chevronUp />
          </button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} title="Move down">
            <Icon.chevronDown />
          </button>
          <button onClick={onRemove} title="Remove">
            <Icon.trash />
          </button>
        </div>
      </div>
      <div className="block-body">
        <BlockEditor block={block} onPatch={onPatch} />
      </div>
    </div>
  );
}

/* text helpers for formatting / variable insertion */
function surround(ref, value, onChange, mark) {
  const el = ref.current;
  if (!el) return onChange(value + mark + mark);
  const s = el.selectionStart,
    e = el.selectionEnd;
  const next = value.slice(0, s) + mark + value.slice(s, e) + mark + value.slice(e);
  onChange(next);
  requestAnimationFrame(() => {
    el.focus();
    el.selectionStart = s + mark.length;
    el.selectionEnd = e + mark.length;
  });
}
function insertToken(ref, value, onChange, token) {
  const el = ref.current;
  if (!el) return onChange(value + token);
  const s = el.selectionStart;
  const next = value.slice(0, s) + token + value.slice(s);
  onChange(next);
  requestAnimationFrame(() => {
    el.focus();
    el.selectionStart = el.selectionEnd = s + token.length;
  });
}

function RichText({ value, onChange, placeholder, vars = true }) {
  const ref = useRef(null);
  return (
    <>
      <div className="fmt-bar">
        <button type="button" title="Bold" onClick={() => surround(ref, value, onChange, '*')}>
          B
        </button>
        <button type="button" title="Italic" onClick={() => surround(ref, value, onChange, '_')} style={{ fontStyle: 'italic' }}>
          I
        </button>
      </div>
      <textarea
        ref={ref}
        className="textarea"
        style={{ minHeight: 70 }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {vars && (
        <div className="var-chips">
          {['{{first_name}}', '{{name}}', '{Hi|Hello|Hey}'].map((tok) => (
            <span key={tok} className="chip" onClick={() => insertToken(ref, value, onChange, tok)}>
              + {tok.replace(/[{}]/g, '').slice(0, 14)}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function BlockEditor({ block, onPatch }) {
  switch (block.type) {
    case 'greeting':
    case 'text':
      return (
        <RichText
          value={block.text}
          onChange={(text) => onPatch({ text })}
          placeholder={block.type === 'greeting' ? 'Hi {{first_name}},' : 'Write your message…'}
        />
      );
    case 'image':
      return <ImageBlock block={block} onPatch={onPatch} />;
    case 'signoff':
      return (
        <input className="input" value={block.text} placeholder="— Your name / brand" onChange={(e) => onPatch({ text: e.target.value })} />
      );
    case 'optout':
      return (
        <input className="input" value={block.text} placeholder="Reply STOP to opt out." onChange={(e) => onPatch({ text: e.target.value })} />
      );
    case 'bullets':
      return (
        <ListEditor
          items={block.items}
          onChange={(items) => onPatch({ items })}
          placeholder="Bullet point"
          addLabel="+ Add point"
        />
      );
    case 'spin':
      return (
        <>
          <ListEditor
            items={block.options}
            onChange={(options) => onPatch({ options })}
            placeholder="Variation"
            addLabel="+ Add variation"
          />
          <div className="palette-hint" style={{ marginTop: 2 }}>
            Each recipient gets one of these at random.
          </div>
        </>
      );
    case 'cta':
      return (
        <>
          <input className="input" style={{ marginBottom: 6 }} value={block.label} placeholder="Button text (e.g. 👉 Book a call)" onChange={(e) => onPatch({ label: e.target.value })} />
          <input className="input" value={block.url} placeholder="https://your-link.com" onChange={(e) => onPatch({ url: e.target.value })} />
        </>
      );
    default:
      return null;
  }
}

function ImageBlock({ block, onPatch }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);

  function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast('Please choose an image file', 'error');
    if (file.size > 10 * 1024 * 1024) return toast('Image too large (max 10MB)', 'error');
    setBusy(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await api.post('/uploads', { dataUrl: reader.result, filename: file.name });
        onPatch({ url: r.url, filename: file.name });
      } catch (err) {
        toast(err.message, 'error');
      }
      setBusy(false);
    };
    reader.onerror = () => {
      toast('Could not read the file', 'error');
      setBusy(false);
    };
    reader.readAsDataURL(file);
  }

  if (block.url) {
    return (
      <div>
        <img src={block.url} alt="" style={{ width: '100%', maxHeight: 220, objectFit: 'contain', borderRadius: 10, background: 'var(--surface-2)' }} />
        <div className="flex" style={{ gap: 6, marginTop: 8 }}>
          <label className="btn sm" style={{ cursor: 'pointer' }}>
            Replace<input type="file" accept="image/*" hidden onChange={onFile} />
          </label>
          <button className="btn ghost sm" onClick={() => onPatch({ url: '', filename: '' })}>
            <Icon.trash /> Remove
          </button>
        </div>
        <div className="palette-hint" style={{ marginTop: 6 }}>Sent as an image; your text blocks become the caption.</div>
      </div>
    );
  }
  return (
    <label className="btn" style={{ width: '100%', justifyContent: 'center', cursor: 'pointer', padding: 14 }}>
      <Icon.upload /> {busy ? 'Uploading…' : 'Upload image (JPG / PNG / WEBP)'}
      <input type="file" accept="image/*" hidden onChange={onFile} disabled={busy} />
    </label>
  );
}

function ListEditor({ items, onChange, placeholder, addLabel }) {
  const set = (i, v) => onChange(items.map((x, idx) => (idx === i ? v : x)));
  const add = () => onChange([...items, '']);
  const del = (i) => onChange(items.filter((_, idx) => idx !== i));
  return (
    <>
      {items.map((it, i) => (
        <div className="bullet-row" key={i}>
          <input className="input" value={it} placeholder={placeholder} onChange={(e) => set(i, e.target.value)} />
          <button className="mini-x" onClick={() => del(i)} title="Remove">
            <Icon.x />
          </button>
        </div>
      ))}
      <button className="add-line" onClick={add}>
        {addLabel}
      </button>
    </>
  );
}
