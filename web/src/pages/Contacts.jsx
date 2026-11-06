import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Modal, Empty, StatusBadge, timeAgo } from '../ui.jsx';

export default function Contacts() {
  const { toast, refreshStats } = useApp();
  const [list, setList] = useState([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [edit, setEdit] = useState(null);

  const load = async () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    setList(await api.get('/contacts?' + params));
  };
  useEffect(() => {
    load();
  }, [q, status]);

  async function remove(c) {
    if (!confirm(`Delete ${c.name || c.phone}?`)) return;
    await api.del('/contacts/' + c.id);
    toast('Contact deleted');
    load();
    refreshStats();
  }

  return (
    <>
      <div className="toolbar">
        <div className="search">
          <Icon.search />
          <input
            className="input"
            placeholder="Search name or number…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="select" style={{ maxWidth: 170 }} value={status} onChange={(e) => setStatus(e.target.value)}>
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
        {list.length === 0 ? (
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
        ) : (
          <div className="table-wrap">
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
                      {c.name || <span className="cell-muted">Unknown</span>}
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
        )}
      </div>

      {showAdd && <AddModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); refreshStats(); }} />}
      {edit && <EditModal contact={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); load(); refreshStats(); }} />}
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

function ImportModal({ onClose, onDone }) {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
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

  return (
    <Modal
      title="Bulk import contacts"
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={run} disabled={busy}>{busy ? 'Importing…' : 'Import'}</button></>}
    >
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
    </Modal>
  );
}
