import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';

export const uploads = Router();

export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 10 * 1024 * 1024;

// Accept a base64 data URL (keeps express.json; no multipart dependency).
uploads.post('/', (req, res) => {
  const { dataUrl } = req.body || {};
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return res.status(400).json({ error: 'Provide an image file' });
  const ext = EXT[m[1].toLowerCase()];
  if (!ext) return res.status(400).json({ error: 'Only JPG, PNG, WEBP or GIF images' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_BYTES) return res.status(400).json({ error: 'Image too large (max 10MB)' });
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ url: '/api/uploads/' + name, filename: name, size: buf.length });
});

// Serve an uploaded image (cookie is sent automatically by same-origin <img>).
uploads.get('/:file', (req, res) => {
  const name = path.basename(req.params.file); // no path traversal
  const fp = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).end();
  const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[
    path.extname(name).slice(1).toLowerCase()
  ];
  if (type) res.type(type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(fp).pipe(res);
});
