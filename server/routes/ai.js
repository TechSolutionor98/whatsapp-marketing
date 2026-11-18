import { Router } from 'express';
import { getSetting, audit } from '../db/mongo.js';
import { aiAvailable, aiModel, aiProviderName, draftMessage, rewriteMessage } from '../ai.js';

export const ai = Router();

ai.get('/status', (_req, res) => {
  res.json({
    available: aiAvailable(), // provider is usable (key present, or Ollama local)
    enabled: getSetting('aiEnabled', false), // send-time rewriting on
    provider: aiProviderName(),
    model: aiModel(),
  });
});

// Draft a new message from a description (used by the template builder).
ai.post('/draft', async (req, res) => {
  const { prompt, tone } = req.body || {};
  if (!prompt?.trim()) return res.status(400).json({ error: 'Describe what you want to say' });
  if (!aiAvailable()) return res.status(400).json({ error: 'AI is not configured — add your key in Settings → AI' });
  try {
    const text = await draftMessage(prompt.trim(), { tone });
    audit('system', 'AI drafted a message');
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sample rewrite — lets the user preview the per-recipient variation.
ai.post('/rewrite', async (req, res) => {
  const { text, tone, name } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Nothing to rewrite' });
  if (!aiAvailable()) return res.status(400).json({ error: 'AI is not configured — add your key in Settings → AI' });
  try {
    const out = await rewriteMessage(text.trim(), { name: name || 'Ayesha Khan' }, { tone });
    res.json({ text: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
