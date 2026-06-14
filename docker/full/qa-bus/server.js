/**
 * qa-bus — standalone HTTP message bus for openclaw-bridge full E2E tests.
 *
 * Implements the OC qa-bus protocol so openclaw's qa-channel extension can poll
 * for inbound messages and post outbound responses without needing the full OC
 * qa-lab service running.
 *
 * Protocol:
 *   GET  /health                   → { ok: true }
 *   GET  /v1/state                 → full snapshot (conversations, events, messages)
 *   POST /v1/poll                  → long-poll for new events; body: { accountId?, cursor?, timeoutMs? }
 *   POST /v1/inbound/message       → inject inbound message (test → OC direction)
 *   POST /v1/outbound/message      → record outbound message (OC → user direction)
 *   POST /v1/reset                 → clear all state
 *
 * OC's qa-channel polls /v1/poll every 250 ms with the last cursor.
 * Test code injects via /v1/inbound/message and reads responses via /v1/state.
 */

'use strict';

const http = require('http');
const { randomUUID } = require('crypto');

const PORT = parseInt(process.env.PORT || '15000', 10);
const DEFAULT_ACCOUNT_ID = 'default';

// ── In-memory state ──────────────────────────────────────────────────────────

let cursor = 0;
const events = [];
const messages = new Map();
const conversations = new Map();

// Pending long-poll resolvers: { resolve, timer }
const waiters = [];

function settleWaiters() {
  while (waiters.length > 0) {
    const w = waiters.shift();
    clearTimeout(w.timer);
    w.resolve();
  }
}

function waitForCursorAdvance(afterCursor, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    waiters.push({ resolve, timer });
  });
}

// ── State helpers ─────────────────────────────────────────────────────────────

function normalizeAccountId(raw) {
  const t = (raw || '').trim();
  return t || DEFAULT_ACCOUNT_ID;
}

function ensureConversation(conv) {
  const existing = conversations.get(conv.id);
  if (existing) return existing;
  const created = { id: conv.id, kind: conv.kind || 'direct', title: conv.title };
  conversations.set(conv.id, created);
  return created;
}

function createMessage({ direction, accountId, conversation, senderId, senderName, text, timestamp, threadId, replyToId, attachments }) {
  const conv = ensureConversation(conversation);
  const msg = {
    id: randomUUID(),
    accountId,
    direction,
    conversation: { ...conv },
    senderId: senderId || 'unknown',
    senderName,
    text: text || '',
    timestamp: timestamp || Date.now(),
    threadId,
    replyToId,
    attachments: attachments || [],
    reactions: [],
  };
  messages.set(msg.id, msg);
  return msg;
}

function pushEvent(kind, accountId, payload) {
  cursor += 1;
  const event = { cursor, kind, accountId, ...payload };
  events.push(event);
  settleWaiters();
  return event;
}

function pollEvents({ accountId, cursor: fromCursor, limit }) {
  const acc = normalizeAccountId(accountId);
  const startCursor = (typeof fromCursor === 'number' && fromCursor >= 0) ? fromCursor : 0;
  const effectiveLimit = Math.max(1, Math.min(limit || 100, 500));
  const matches = events
    .filter(e => e.accountId === acc && e.cursor > startCursor)
    .slice(0, effectiveLimit);
  return { cursor, events: matches };
}

function getSnapshot() {
  return {
    cursor,
    conversations: Array.from(conversations.values()),
    messages: Array.from(messages.values()),
    events: [...events],
  };
}

function resetState() {
  cursor = 0;
  events.length = 0;
  messages.clear();
  conversations.clear();
  settleWaiters();
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ── Request handler ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (method === 'GET' && path === '/health') {
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && path === '/v1/state') {
    return json(res, 200, getSnapshot());
  }

  // All other /v1/ routes require POST
  if (!path.startsWith('/v1/')) {
    return json(res, 404, { error: 'not found' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, e.statusCode || 400, { error: e.message });
  }

  try {
    if (method === 'POST' && path === '/v1/reset') {
      resetState();
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/v1/inbound/message') {
      const accountId = normalizeAccountId(body.accountId);
      const msg = createMessage({
        direction: 'inbound',
        accountId,
        conversation: body.conversation || { id: 'default', kind: 'direct' },
        senderId: body.senderId,
        senderName: body.senderName,
        text: body.text,
        timestamp: body.timestamp,
        threadId: body.threadId,
        replyToId: body.replyToId,
        attachments: body.attachments,
      });
      pushEvent('inbound-message', accountId, { message: { ...msg, conversation: { ...msg.conversation } } });
      return json(res, 200, { message: msg });
    }

    if (method === 'POST' && path === '/v1/outbound/message') {
      // OC's qa-channel posts here when sending a response
      const accountId = normalizeAccountId(body.accountId);
      const target = (body.to || '').trim();

      // Parse target (dm:id, channel:id, group:id, thread:conv/thread)
      let convId = target, convKind = 'direct', threadId;
      if (target.startsWith('thread:')) {
        const rest = target.slice(7);
        const slash = rest.indexOf('/');
        if (slash > 0) {
          convId = rest.slice(0, slash);
          threadId = rest.slice(slash + 1);
          convKind = 'channel';
        }
      } else if (target.startsWith('channel:')) {
        convId = target.slice(8);
        convKind = 'channel';
      } else if (target.startsWith('group:')) {
        convId = target.slice(6);
        convKind = 'group';
      } else if (target.startsWith('dm:')) {
        convId = target.slice(3);
        convKind = 'direct';
      }

      const msg = createMessage({
        direction: 'outbound',
        accountId,
        conversation: { id: convId, kind: convKind },
        senderId: body.senderId || 'openclaw',
        senderName: body.senderName || 'OpenClaw',
        text: body.text,
        timestamp: body.timestamp,
        threadId: body.threadId || threadId,
        replyToId: body.replyToId,
        attachments: body.attachments,
      });
      pushEvent('outbound-message', accountId, { message: { ...msg, conversation: { ...msg.conversation } } });
      return json(res, 200, { message: msg });
    }

    if (method === 'POST' && path === '/v1/poll') {
      // OC's qa-channel polls this with { accountId, cursor, timeoutMs }
      const accountId = normalizeAccountId(body.accountId);
      const timeoutMs = Math.max(0, Math.min(body.timeoutMs || 0, 30000));
      const fromCursor = typeof body.cursor === 'number' ? body.cursor : 0;

      const initial = pollEvents({ accountId, cursor: fromCursor });
      if (initial.events.length > 0 || timeoutMs === 0) {
        return json(res, 200, initial);
      }

      // Long-poll: wait for new events
      try {
        await waitForCursorAdvance(fromCursor, timeoutMs);
      } catch {
        // timeout — return whatever's available
      }
      return json(res, 200, pollEvents({ accountId, cursor: fromCursor }));
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[qa-bus] error:', e.message);
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[qa-bus] listening on :${PORT}`);
});
