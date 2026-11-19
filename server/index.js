import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { PORT, ROOT, WA_AUTH_DIR } from './config.js';
import { connectMongo } from './db/mongo.js';
import { sseHandler } from './events.js';
import { requireAuth, requireOwner } from './auth.js';
import { checkAccess } from './access.js';
import { auth } from './routes/auth.js';
import { admin } from './routes/admin.js';
import { contacts } from './routes/contacts.js';
import { lists } from './routes/lists.js';
import { templates } from './routes/templates.js';
import { campaigns } from './routes/campaigns.js';
import { conversations } from './routes/conversations.js';
import { ai } from './routes/ai.js';
import { warmup } from './routes/warmup.js';
import { uploads } from './routes/uploads.js';
import { system } from './routes/system.js';
import { connectWhatsApp } from './whatsapp/client.js';
import { startCatalogSync } from './catalog.js';
import { catalogs } from './routes/catalogs.js';
import { startWorker } from './worker/sender.js';
import { startWarmupWorker } from './worker/warmup.js';

// An error inside one request (Express 4 doesn't catch async ones) must not restart the whole
// server — that would drop every linked WhatsApp number for a moment.
process.on('unhandledRejection', (e) => console.error('  Unhandled error (server kept running):', e?.stack || e));

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' })); // room for base64 image uploads
app.use(cookieParser());

// ---- Public endpoints ----
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', auth);

// ---- Everything below requires a valid session, and access to the page it belongs to ----
app.use('/api', requireAuth, checkAccess);
app.use('/api/admin', requireOwner, admin); // Super Admin page

app.get('/api/events', sseHandler);
app.use('/api/contacts', contacts);
app.use('/api/lists', lists);
app.use('/api/templates', templates);
app.use('/api/campaigns', campaigns);
app.use('/api/conversations', conversations);
app.use('/api/ai', ai);
app.use('/api/catalogs', catalogs);
app.use('/api/warmup', warmup);
app.use('/api/uploads', uploads);
app.use('/api', system);

// Serve the built frontend in production (web/dist), if present.
const dist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`\n  WhatsApp Marketing server → http://localhost:${PORT}`);
  if (!fs.existsSync(dist)) {
    console.log('  (dev) frontend runs separately on Vite — open its URL');
  }
  connectMongo(); // auth store (self-retries if not up yet)
  startWorker();
  startWarmupWorker();
  startCatalogSync(); // product catalog for AI replies (if a product URL is set)
  // Auto-reconnect if a linked WhatsApp session already exists on disk.
  if (fs.existsSync(WA_AUTH_DIR) && fs.readdirSync(WA_AUTH_DIR).length > 0) {
    console.log('  Existing WhatsApp session found — reconnecting…');
    connectWhatsApp();
  }
});
