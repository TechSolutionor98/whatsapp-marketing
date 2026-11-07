import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Empty, StatusBadge, timeAgo } from '../ui.jsx';

export default function Contacts() {
  const { toast, refreshStats } = useApp();
  const LIMIT = 50;
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState(''); // debounced search term
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false); // has the first fetch returned yet?
  const [reloadKey, setReloadKey] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [edit, setEdit] = useState(null);

  const reload = () => setReloadKey((k) => k + 1);

  // Debounce the search box so we don't hit the server on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dq) params.set('q', dq);
      if (status) params.set('status', status);
      params.set('page', page);
      params.set('limit', LIMIT);
      const r = await api.get('/contacts?' + params);
      setList(r.items || []);
      setTotal(r.total || 0);
      setPages(r.pages || 1);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };
  useEffect(() => {
    load();
  }, [dq, status, page, reloadKey]);

  async function remove(c) {
    if (!confirm(`Delete ${c.name || c.phone}?`)) return;
    await api.del('/contacts/' + c.id);
    toast('Contact deleted');
    // If we just removed the last row on a page past the first, step back a page.
    if (list.length === 1 && page > 1) setPage((p) => p - 1);
    else reload();
    refreshStats();
  }

  const start = total === 0 ? 0 : (page - 1) * LIMIT + 1;
  const end = Math.min(total, page * LIMIT);
  const filtered = !!(dq || status);

  return (
    <>
      <div className="toolbar">
        <div className="search">
          <Icon.search />
          <input
            className="input"
            placeholder="Search name or number…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
        </div>
        <select className="select" style={{ maxWidth: 170 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="opted_out">Opted out</option>
          <option value="bounced">Bounced</option>
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() => setShowImport(true)}>
          <Icon.upload /> Import
        </button>
        <button className="btn primary" onClick={() => setShowAdd(true)}>
          <Icon.plus /> Add contact
        </button>
      </div>

      <div className="card">
        {!loaded ? (
          <div className="list-loading">
            <div className="spinner" />
            <span>Loading contacts…</span>
          </div>
        ) : list.length === 0 ? (
          filtered ? (
            <Empty icon="search" title="No matches">
              No contacts match {dq ? `“${dq}”` : 'this filter'}. Try a different search or status.
            </Empty>
          ) : (
            <Empty
              icon="users"
              title="No contacts yet"
              action={
                <div className="flex" style={{ justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setShowImport(true)}>
                    <Icon.upload /> Bulk import
                  </button>
                  <button className="btn primary" onClick={() => setShowAdd(true)}>
                    <Icon.plus /> Add one
                  </button>
                </div>
              }
            >
              Import a list or add leads one by one. Numbers need a country code.
            </Empty>
          )
        ) : (
          <>
          <div className={`table-wrap ${loading ? 'is-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Number</th>
                  <th>Tags</th>
                  <th>Status</th>
                  <th>Last activity</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td className="cell-strong">
                      {c.name || <span className="cell-muted">+{c.phone}</span>}
                      {c.handoff === 1 && (
                        <span className="badge amber" style={{ marginLeft: 8 }}>handoff</span>
                      )}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>+{c.phone}</td>
                    <td>
                      <div className="chips">
                        {(c.tags || '').split(',').filter(Boolean).map((t) => (
                          <span className="chip" key={t}>{t.trim()}</span>
                        ))}
                      </div>
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="cell-muted">{timeAgo(c.last_inbound_at || c.last_outbound_at || c.created_at)}</td>
                    <td>
                      <div className="flex" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn ghost sm" onClick={() => setEdit(c)}><Icon.edit /></button>
                        <button className="btn ghost sm" onClick={() => remove(c)}><Icon.trash /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <div className="pager-info">
              Showing {start}–{end} of {total.toLocaleString()}
            </div>
            <div className="pager-ctrls">
              <button className="btn sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <Icon.chevronDown style={{ width: 14, transform: 'rotate(90deg)' }} /> Prev
              </button>
              <span className="pager-page">Page {page} / {pages}</span>
              <button className="btn sm" disabled={page >= pages || loading} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                Next <Icon.chevronDown style={{ width: 14, transform: 'rotate(-90deg)' }} />
              </button>
            </div>
          </div>
          </>
        )}
      </div>

      {showAdd && <AddModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); setPage(1); reload(); refreshStats(); }} />}
      {edit && <EditModal contact={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); setPage(1); reload(); refreshStats(); }} />}
    </>
  );
}

function AddModal({ onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: '', phone: '', tags: '' });
  async function save() {
    try {
      await api.post('/contacts', f);
      toast('Contact added', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  return (
    <Modal
      title="Add contact"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}
    >
      <div className="field">
        <label>Name</label>
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ayesha Khan" />
      </div>
      <div className="field">
        <label>WhatsApp number</label>
        <input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="923001234567 (with country code)" />
        <div className="hint">Digits only or with +. Must include the country code.</div>
      </div>
      <div className="field">
        <label>Tags</label>
        <input className="input" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="lead, lahore, premium" />
        <div className="hint">Comma-separated. Used to target campaigns.</div>
      </div>
    </Modal>
  );
}

function EditModal({ contact, onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState({ ...contact });
  async function save() {
    try {
      await api.put('/contacts/' + contact.id, f);
      toast('Saved', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  return (
    <Modal
      title="Edit contact"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}
    >
      <div className="field"><label>Name</label><input className="input" value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="field"><label>Number</label><input className="input" value={'+' + f.phone} disabled /></div>
      <div className="field"><label>Tags</label><input className="input" value={f.tags || ''} onChange={(e) => setF({ ...f, tags: e.target.value })} /></div>
      <div className="field">
        <label>Status</label>
        <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="active">Active</option>
          <option value="opted_out">Opted out</option>
          <option value="bounced">Bounced</option>
        </select>
      </div>
      <div className="field"><label>Notes</label><textarea className="textarea" value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
    </Modal>
  );
}

/* ---------- Smart column detection for spreadsheet import ---------- */
const PHONE_HDR = /(phone|mobile|cell|whats\s*app|wa[\s_-]*(no|number)?|number|contact\s*(no|number)|tel|msisdn|digits)/i;
const NAME_HDR = /(name|customer|client|lead|person|recipient|full\s*name|contact\s*name|first\s*name)/i;
const TAG_HDR = /(tag|label|group|segment|category|city|region|type|source|list)/i;

function normDigits(v) {
  let d = String(v ?? '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d;
}
function looksLikePhone(v) {
  const d = normDigits(v);
  return d.length >= 7 && d.length <= 15;
}
function looksLikeName(v) {
  const s = String(v ?? '').trim();
  if (!s) return false;
  const letters = (s.match(/[A-Za-zÀ-ɏ؀-ۿ]/g) || []).length;
  const digits = (s.match(/\d/g) || []).length;
  return letters >= 2 && digits <= letters;
}

// Figure out, from the raw grid, which column is the name, which is the number,
// and whether row 0 is a header — using both the header words and the actual data.
function detectColumns(matrix) {
  const out = { headerRow: false, nameCol: -1, phoneCol: -1, tagsCol: -1, cols: 0 };
  if (!matrix.length) return out;
  const width = Math.max(0, ...matrix.map((r) => r.length));
  out.cols = width;
  const first = matrix[0] || [];
  const headerHits = first.filter((c) => {
    const s = String(c ?? '').trim();
    return s && (PHONE_HDR.test(s) || NAME_HDR.test(s) || TAG_HDR.test(s));
  }).length;
  // It's a header row if it has keyword cells and isn't itself full of phone numbers.
  out.headerRow = headerHits > 0 && !first.some(looksLikePhone);

  const dataRows = (out.headerRow ? matrix.slice(1) : matrix).slice(0, 300);
  const pScore = new Array(width).fill(-1);
  const nScore = new Array(width).fill(-1);
  for (let c = 0; c < width; c++) {
    let ph = 0, nm = 0, ne = 0;
    for (const row of dataRows) {
      const v = row[c];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      ne++;
      if (looksLikePhone(v)) ph++;
      else if (looksLikeName(v)) nm++;
    }
    if (ne > 0) {
      pScore[c] = ph / ne;
      nScore[c] = nm / ne;
    }
    const hdr = out.headerRow ? String(first[c] ?? '').trim() : '';
    if (hdr && PHONE_HDR.test(hdr)) pScore[c] = Math.max(pScore[c], 0) + 1;
    if (hdr && NAME_HDR.test(hdr)) nScore[c] = Math.max(nScore[c], 0) + 1;
  }
  // Number column: best-scoring, needs >30% phone-like data unless the header says so.
  let pc = -1, pbest = 0.3;
  for (let c = 0; c < width; c++) if (pScore[c] > pbest) { pbest = pScore[c]; pc = c; }
  out.phoneCol = pc;
  // Name column: best-scoring, excluding the number column.
  let nc = -1, nbest = 0.3;
  for (let c = 0; c < width; c++) {
    if (c === pc) continue;
    if (nScore[c] > nbest) { nbest = nScore[c]; nc = c; }
  }
  out.nameCol = nc;
  // Tags column: by header only, so we never hijack a data column.
  if (out.headerRow) {
    for (let c = 0; c < width; c++) {
      if (c === pc || c === nc) continue;
      if (TAG_HDR.test(String(first[c] ?? '').trim())) { out.tagsCol = c; break; }
    }
  }
  return out;
}

// Optional: turn a local number into international form using a default country code.
function applyCC(digits, cc) {
  cc = String(cc || '').replace(/\D/g, '');
  if (!cc || !digits) return digits;
  if (digits.startsWith('0')) return cc + digits.replace(/^0+/, '');
  if (digits.length < 11 && !digits.startsWith(cc)) return cc + digits;
  return digits;
}

function buildRows(matrix, map, defaultCC) {
  const { headerRow, nameCol, phoneCol, tagsCol } = map;
  const dataRows = headerRow ? matrix.slice(1) : matrix;
  const rows = [];
  const seen = new Set();
  let invalid = 0;
  for (const r of dataRows) {
    const rawPhone = phoneCol >= 0 ? r[phoneCol] : '';
    const name = nameCol >= 0 ? String(r[nameCol] ?? '').trim() : '';
    const tags = tagsCol >= 0 ? String(r[tagsCol] ?? '').trim() : '';
    if ((rawPhone === undefined || String(rawPhone).trim() === '') && !name) continue; // blank row
    let digits = applyCC(normDigits(rawPhone), defaultCC);
    if (digits.length < 7 || digits.length > 15) { invalid++; continue; }
    if (seen.has(digits)) continue;
    seen.add(digits);
    rows.push({ name, phone: digits, tags });
  }
  return { rows, invalid };
}

function colLabel(matrix, map, c) {
  if (c < 0) return '— none —';
  const letter = c < 26 ? String.fromCharCode(65 + c) : `#${c + 1}`;
  const hdr = map.headerRow ? String(matrix[0]?.[c] ?? '').trim() : '';
  return hdr ? `${hdr}  (col ${letter})` : `Column ${letter}`;
}

function ImportModal({ onClose, onDone }) {
  const { toast } = useApp();
  const [mode, setMode] = useState('file'); // 'file' | 'paste'
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  // paste mode
  const [text, setText] = useState('');

  // file mode
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [matrix, setMatrix] = useState(null);
  const [map, setMap] = useState(null);
  const [defaultCC, setDefaultCC] = useState('');
  const [parseError, setParseError] = useState('');
  const [drag, setDrag] = useState(false);

  const preview = useMemo(
    () => (matrix && map ? buildRows(matrix, map, defaultCC) : null),
    [matrix, map, defaultCC]
  );

  async function readFile(file) {
    if (!file) return;
    setParseError('');
    setFileName(file.name);
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error('That file has no sheets');
      const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
      if (!grid.length) throw new Error('That sheet looks empty');
      setMatrix(grid);
      setMap(detectColumns(grid));
    } catch (e) {
      setMatrix(null);
      setMap(null);
      setParseError(e.message || 'Could not read that file');
    }
  }

  function reset() {
    setMatrix(null);
    setMap(null);
    setFileName('');
    setParseError('');
    if (fileRef.current) fileRef.current.value = '';
  }

  async function runFile() {
    if (!preview?.rows.length) return toast('No valid numbers found to import', 'error');
    setBusy(true);
    try {
      // Merge each row's own tag (from the Tags column) with the batch tag so both apply.
      const rows = preview.rows.map((r) => ({
        ...r,
        tags: [r.tags, tags].map((s) => (s || '').trim()).filter(Boolean).join(', '),
      }));
      const r = await api.post('/contacts/import', { rows });
      toast(`Imported ${r.added} contacts (${r.skipped} skipped)`, 'success');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }

  async function runPaste() {
    if (!text.trim()) return toast('Paste some numbers first', 'error');
    setBusy(true);
    try {
      const r = await api.post('/contacts/import', { text, tags });
      toast(`Imported ${r.added} contacts (${r.skipped} skipped)`, 'success');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }

  const canImport = mode === 'file' ? !!preview?.rows.length : !!text.trim();

  return (
    <Modal
      title="Import contacts"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={mode === 'file' ? runFile : runPaste}
            disabled={busy || !canImport}
          >
            {busy
              ? 'Importing…'
              : mode === 'file' && preview
                ? `Import ${preview.rows.length} contact${preview.rows.length === 1 ? '' : 's'}`
                : 'Import'}
          </button>
        </>
      }
    >
      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={`seg-btn ${mode === 'file' ? 'active' : ''}`} onClick={() => setMode('file')}>
          <Icon.upload /> Excel / CSV file
        </button>
        <button className={`seg-btn ${mode === 'paste' ? 'active' : ''}`} onClick={() => setMode('paste')}>
          <Icon.list /> Paste a list
        </button>
      </div>

      {mode === 'file' && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv,.tsv"
            style={{ display: 'none' }}
            onChange={(e) => readFile(e.target.files?.[0])}
          />

          {!matrix && (
            <div
              className={`dropzone ${drag ? 'over' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files?.[0]); }}
            >
              <Icon.upload />
              <div className="dz-title">Drop your Excel or CSV here, or click to choose</div>
              <div className="hint">
                It reads the first sheet and figures out the name and number columns on its own.
                Supports .xlsx, .xls, .csv
              </div>
            </div>
          )}

          {parseError && <div className="auth-error" style={{ marginTop: 10 }}>{parseError}</div>}

          {matrix && map && (
            <>
              <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div className="flex" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
                  <Icon.check />
                  <span className="cell-strong" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
                  <span className="cell-muted">· {matrix.length} row{matrix.length === 1 ? '' : 's'}</span>
                </div>
                <button className="btn ghost sm" onClick={reset}><Icon.x /> Choose another</button>
              </div>

              <div className="map-grid">
                <MapSelect label="Name column" value={map.nameCol} onChange={(v) => setMap({ ...map, nameCol: v })} matrix={matrix} map={map} />
                <MapSelect label="Number column" value={map.phoneCol} onChange={(v) => setMap({ ...map, phoneCol: v })} matrix={matrix} map={map} required />
                <MapSelect label="Tags column (optional)" value={map.tagsCol} onChange={(v) => setMap({ ...map, tagsCol: v })} matrix={matrix} map={map} />
              </div>

              <div className="flex" style={{ gap: 16, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <label className="check">
                  <input type="checkbox" checked={map.headerRow} onChange={(e) => setMap({ ...map, headerRow: e.target.checked })} />
                  First row is a header
                </label>
                <div className="field" style={{ margin: 0 }}>
                  <input
                    className="input"
                    style={{ width: 230 }}
                    value={defaultCC}
                    onChange={(e) => setDefaultCC(e.target.value)}
                    placeholder="Default country code e.g. 92"
                  />
                </div>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                Country code is only used for local numbers (those starting with 0 or missing a code). Numbers already in full form are left as-is.
              </div>

              {map.phoneCol < 0 && (
                <div className="auth-error" style={{ marginTop: 12 }}>
                  Pick which column holds the WhatsApp number to continue.
                </div>
              )}

              {preview && map.phoneCol >= 0 && (
                <div style={{ marginTop: 16 }}>
                  <div className="flex" style={{ gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span className="badge green">{preview.rows.length} ready</span>
                    {preview.invalid > 0 && <span className="badge amber">{preview.invalid} skipped (no valid number)</span>}
                    <span className="cell-muted">Preview</span>
                  </div>
                  <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto' }}>
                    <table>
                      <thead>
                        <tr><th>Name</th><th>Number</th>{map.tagsCol >= 0 && <th>Tags</th>}</tr>
                      </thead>
                      <tbody>
                        {preview.rows.slice(0, 8).map((r, i) => (
                          <tr key={i}>
                            <td className="cell-strong">{r.name || <span className="cell-muted">+{r.phone}</span>}</td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>+{r.phone}</td>
                            {map.tagsCol >= 0 && <td className="cell-muted">{r.tags}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {preview.rows.length > 8 && <div className="hint" style={{ marginTop: 6 }}>…and {preview.rows.length - 8} more</div>}
                </div>
              )}
            </>
          )}

          <div className="field" style={{ marginTop: 16 }}>
            <label>Tag everyone in this batch (optional)</label>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="import-oct, cold-list" />
            <div className="hint">Applied on top of any Tags column above.</div>
          </div>
        </>
      )}

      {mode === 'paste' && (
        <>
          <div className="field">
            <label>Paste contacts</label>
            <textarea
              className="textarea"
              style={{ minHeight: 200, fontFamily: 'monospace', fontSize: 12.5 }}
              placeholder={`One per line. Any of:\n923001234567\nAyesha Khan, 923001234567\n923009998888, Bilal`}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="hint">Accepts "name, number" or "number, name" or just a number. Duplicates are merged.</div>
          </div>
          <div className="field">
            <label>Tag everyone in this batch (optional)</label>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="import-oct, cold-list" />
          </div>
        </>
      )}
    </Modal>
  );
}

function MapSelect({ label, value, onChange, matrix, map, required }) {
  const cols = [];
  for (let c = 0; c < map.cols; c++) cols.push(c);
  return (
    <div className="field" style={{ margin: 0 }}>
      <label>{label}</label>
      <select className="select" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {!required && <option value={-1}>— none —</option>}
        {required && value < 0 && <option value={-1}>— choose —</option>}
        {cols.map((c) => (
          <option key={c} value={c}>{colLabel(matrix, map, c)}</option>
        ))}
      </select>
    </div>
  );
}
