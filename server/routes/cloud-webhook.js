// Meta's webhook for official WhatsApp numbers (public: Meta calls it, no sign-in).
//   GET  → the callback check: answer hub.challenge when hub.verify_token is one of ours.
//   POST → messages people send + delivery/read receipts, signed with the app secret.
// Mounted in index.js BEFORE the JSON body parser: the signature is over the raw bytes.
import { Router } from 'express';
import { verifyWebhook, receiveWebhook } from '../whatsapp/cloud.js';

export const cloudWebhook = Router();

cloudWebhook.get('/', async (req, res) => {
  try {
    const challenge = await verifyWebhook(req.query);
    if (challenge === null) return res.sendStatus(403);
    res.type('text/plain').send(challenge);
  } catch {
    res.sendStatus(500);
  }
});

cloudWebhook.post('/', async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    res.sendStatus(await receiveWebhook(raw, req.get('x-hub-signature-256')));
  } catch {
    res.sendStatus(500);
  }
});
