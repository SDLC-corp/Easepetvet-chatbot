import { Router } from 'express';
import { handleChatMessage, ChatServiceError } from '../chat/chat.service.js';
import { captureLead, saveSessionEmail } from '../chat/lead.service.js';
import { describeChain } from '../chat/provider-chain.js';
import { config } from '../config/env.js';
import { logger } from '../shared/logger/logger.js';

// Chat API routes. Routes validate input and shape responses; business logic
// lives in the chat service.

const router = Router();

const VALID_AUDIENCES = ['pet_parent', 'vet', 'unknown'];
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 200;
const MAX_PHONE_LENGTH = 40;
// Pragmatic email shape check (not full RFC). Rejects obvious garbage; the real
// validation is the user receiving anything sent there.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    chat: true,
    answerMode: config.chat.answerMode,
    chain: describeChain(),
  });
});

router.post('/lead', async (req, res) => {
  const body = req.body ?? {};

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required.' });
  }
  const name = body.name.trim();
  if (name.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `name must be ${MAX_NAME_LENGTH} characters or fewer.` });
  }

  if (typeof body.email !== 'string' || body.email.trim().length === 0) {
    return res.status(400).json({ error: 'email is required.' });
  }
  const email = body.email.trim();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'email must be a valid email address.' });
  }

  let phone = null;
  if (body.phone !== undefined && body.phone !== null && body.phone !== '') {
    if (typeof body.phone !== 'string') {
      return res.status(400).json({ error: 'phone must be a string.' });
    }
    phone = body.phone.trim();
    if (phone.length > MAX_PHONE_LENGTH) {
      return res.status(400).json({ error: `phone must be ${MAX_PHONE_LENGTH} characters or fewer.` });
    }
  }

  if (typeof body.audience !== 'string' || !VALID_AUDIENCES.includes(body.audience)) {
    return res.status(400).json({ error: `audience must be one of ${VALID_AUDIENCES.join(', ')}.` });
  }

  if (body.sessionId !== undefined && body.sessionId !== null && typeof body.sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId must be a string.' });
  }

  try {
    const result = await captureLead({
      name,
      email,
      phone,
      audience: body.audience,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    });
    return res.status(201).json({ ...result, captured: true });
  } catch (err) {
    if (err instanceof ChatServiceError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error({ err }, 'Lead capture failed');
    return res.status(500).json({ error: 'Internal error saving your details.' });
  }
});

router.post('/message', async (req, res) => {
  const body = req.body ?? {};

  if (typeof body.message !== 'string') {
    return res.status(400).json({ error: 'message is required and must be a string.' });
  }
  const message = body.message.trim();
  if (message.length === 0) {
    return res.status(400).json({ error: 'message must not be empty.' });
  }
  // Per-message length limit (chars OR words). Rejected before any store/retrieval/AI.
  const words = message.split(/\s+/).filter(Boolean).length;
  if (message.length > config.chat.maxMessageChars || words > config.chat.maxMessageWords) {
    return res.status(400).json({
      error: `Message is too long. Please keep your question under ${config.chat.maxMessageWords} words or ${config.chat.maxMessageChars} characters.`,
    });
  }
  if (body.sessionId !== undefined && body.sessionId !== null && typeof body.sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId must be a string.' });
  }

  let audience = 'unknown';
  if (body.audience !== undefined && body.audience !== null) {
    if (typeof body.audience !== 'string' || !VALID_AUDIENCES.includes(body.audience)) {
      return res.status(400).json({ error: `audience must be one of ${VALID_AUDIENCES.join(', ')}.` });
    }
    audience = body.audience;
  }

  try {
    const result = await handleChatMessage({
      message,
      audience,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ChatServiceError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error({ err }, 'Chat message failed');
    return res.status(500).json({ error: 'Internal error handling the chat message.' });
  }
});

// Optional in-chat email capture. Attaches an email to an existing session.
router.post('/email', async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) {
    return res.status(400).json({ error: 'sessionId is required.' });
  }
  if (typeof body.email !== 'string') {
    return res.status(400).json({ error: 'email is required.' });
  }
  const email = body.email.trim();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'email must be a valid email address.' });
  }
  try {
    const result = await saveSessionEmail({ sessionId: body.sessionId, email });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ChatServiceError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error({ err }, 'Save session email failed');
    return res.status(500).json({ error: 'Internal error saving your email.' });
  }
});

export default router;
