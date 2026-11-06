import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { PORT, ROOT, WA_AUTH_DIR } from './config.js';
import { connectMongo } from './db/mongo.js';
import { sseHandler } from './events.js';
import { requireAuth } from './auth.js';
import { auth } from './routes/auth.js';
import { contacts } from './routes/contacts.js';
import { templates } from './routes/templates.js';
import { campaigns } from './routes/campaigns.js';
import { conversations } from './routes/conversations.js';
import { ai } from './routes/ai.js';
import { warmup } from './routes/warmup.js';
import { uploads } from './routes/uploads.js';
import { system } from './routes/system.js';
import { connectWhatsApp } from './whatsapp/client.js';
import { startWorker } from './worker/sender.js';
import { startWarmupWorker } from './worker/warmup.js';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' })); // room for base64 image uploads
app.use(cookieParser());

// ---- Public endpoints ----
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', auth);

// ---- Everything below requires a valid session ----
app.use('/api', requireAuth);

app.get('/api/events', sseHandler);
app.use('/api/contacts', contacts);
app.use('/api/templates', templates);
app.use('/api/campaigns', campaigns);
app.use('/api/conversations', conversations);
app.use('/api/ai', ai);
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
  // Auto-reconnect if a linked WhatsApp session already exists on disk.
  if (fs.existsSync(WA_AUTH_DIR) && fs.readdirSync(WA_AUTH_DIR).length > 0) {
    console.log('  Existing WhatsApp session found — reconnecting…');
    connectWhatsApp();
  }
});
