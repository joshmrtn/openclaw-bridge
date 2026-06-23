/**
 * fake-openai — one OpenAI-compatible mock LLM for all openclaw-bridge E2E tiers.
 *
 * Both SillyTavern (chat_completion_source: "custom") and OpenClaw (api:
 * openai-completions) speak the OpenAI API, so a single server stands in for the
 * LLM everywhere — replacing the old fake-ollama (ST) + mock-llm (OC agent) split.
 *
 * Endpoints:
 *   GET  /v1/models            → model list (single "fake-model" entry)
 *   POST /v1/chat/completions  → chat completion (SSE stream or JSON)
 *   POST /scenario             → { response } sticky reply (until /reset or next /scenario)
 *   POST /error-once           → next completion returns HTTP 500
 *   GET  /pending-count        → { count } requests held by a delay scenario
 *   GET  /request-count        → { count } monotonic total completion requests seen
 *   GET  /last-prompt          → { raw } the last completion request body
 *   POST /reset                → clear sticky scenario + control flags
 *   GET  /healthz              → { ok: true }
 *
 * Roles distinguished by request shape:
 *   - ST generation: plain messages, no tools → returns the primed scenario text.
 *   - OC agent: messages + a `generate_response` tool, no prior tool result → returns
 *     an assistant tool_call (the brain-drives-body path); with a tool result present
 *     → returns acknowledgement text.
 *
 * Sticky-scenario sentinels (mirror fake-ollama):
 *   __INVALID_BODY__  → emit a malformed SSE/JSON body (parser-error path)
 *   __DELAY_MS:N__    → hold the request N ms, then return defaultResponse
 */

'use strict';

const http = require('http');
const { randomUUID } = require('crypto');

const PORT = parseInt(process.env.PORT || '11436', 10);
const MODEL = process.env.MODEL || 'fake-model';
const OC_CHARACTER = process.env.OC_CHARACTER || 'TestBot';
const OC_CHANNEL = process.env.OC_CHANNEL || 'qa-channel';

let defaultResponse = process.env.DEFAULT_RESPONSE || 'This is a fake LLM response for testing.';
// When set, scan the system prompt for these character names and prepend
// [persona:NAME] to the response, enabling persona-bleed assertions.
const echoMarkers = (process.env.ECHO_CHARACTER_MARKERS || '').split(',').filter(Boolean);

let stickyScenario = null;
let nextErrorOnce = false;
let pendingDelayCount = 0;
let lastPromptRaw = null;
// Monotonic count of every /v1/chat/completions request that has arrived. Tests poll
// GET /request-count and wait for it to stop changing to detect generation quiescence
// (no heartbeat/stray pipeline in flight) deterministically, instead of fixed sleeps.
let requestsSeen = 0;

// ── helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function json(res, status, data) {
    const payload = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}

function detectPersonaMarker(messages) {
    if (echoMarkers.length === 0) return null;
    const text = (messages || []).filter(m => m.role === 'system').map(m => m.content || '').join(' ');
    for (const name of echoMarkers) {
        if (text.includes(name)) return name;
    }
    return null;
}

function lastUserText(messages) {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            const c = messages[i].content;
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map(p => p.text || '').join(' ');
        }
    }
    return '';
}

const hasGenerateResponseTool = tools =>
    Array.isArray(tools) && tools.some(t => (t.function && t.function.name) === 'generate_response' || t.name === 'generate_response');
const hasToolResult = messages =>
    Array.isArray(messages) && messages.some(m => m.role === 'tool');

// ── chat-completion responses ────────────────────────────────────────────────

function chatId() { return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`; }

function streamCompletion(res, text) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const id = chatId();
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    for (const token of text.match(/\S+\s*/g) || [text]) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: token }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

function jsonCompletion(res, text) {
    json(res, 200, {
        id: chatId(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
}

function toolCallCompletion(res, stream, args) {
    const id = chatId();
    const toolCall = { id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`, type: 'function', function: { name: 'generate_response', arguments: args } };
    if (!stream) {
        return json(res, 200, {
            id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
        });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const path = new URL(req.url || '/', 'http://localhost').pathname;

    if (method === 'GET' && (path === '/healthz' || path === '/health' || path === '/')) {
        return json(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/v1/models') {
        return json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'fake-openai' }] });
    }
    if (method === 'GET' && path === '/pending-count') {
        return json(res, 200, { count: pendingDelayCount });
    }
    if (method === 'GET' && path === '/request-count') {
        return json(res, 200, { count: requestsSeen });
    }
    if (method === 'GET' && path === '/last-prompt') {
        return lastPromptRaw === null ? json(res, 404, { error: 'no prompt yet' }) : json(res, 200, { raw: lastPromptRaw });
    }
    if (method === 'POST' && path === '/reset') {
        stickyScenario = null; nextErrorOnce = false; lastPromptRaw = null;
        return json(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/error-once') {
        nextErrorOnce = true;
        return json(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/scenario') {
        try {
            const { response } = JSON.parse(await readBody(req));
            if (typeof response !== 'string') return json(res, 400, { error: 'response must be a string' });
            stickyScenario = response;
            return json(res, 200, { ok: true });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
        requestsSeen++;
        if (nextErrorOnce) {
            nextErrorOnce = false;
            console.log('[fake-openai] error-once → 500');
            return json(res, 500, { error: { message: 'injected error for testing', type: 'server_error' } });
        }
        let parsed;
        try {
            const body = await readBody(req);
            lastPromptRaw = body;
            parsed = JSON.parse(body);
        } catch (err) { return json(res, 400, { error: { message: err.message } }); }

        const stream = parsed.stream === true;
        const messages = parsed.messages || [];

        // OC agent path: a generate_response tool is offered.
        if (hasGenerateResponseTool(parsed.tools)) {
            if (hasToolResult(messages)) {
                const text = 'Done.';
                console.log('[fake-openai] OC agent turn 2 (tool result) → text');
                return stream ? streamCompletion(res, text) : jsonCompletion(res, text);
            }
            const userText = lastUserText(messages);
            const cleanText = userText.replace(/^\[(GUEST|OWNER)\]\s*\S+\s*:\s*/i, '').trim() || userText;
            const userIdMatch = /([\w.-]+:[\w.-]+)/.exec(userText);
            const args = JSON.stringify({
                character: OC_CHARACTER, message: cleanText, channel: OC_CHANNEL,
                user_id: userIdMatch ? userIdMatch[1] : 'qa:test-user',
            });
            console.log(`[fake-openai] OC agent turn 1 → generate_response(${cleanText.slice(0, 40)})`);
            return toolCallCompletion(res, stream, args);
        }

        // ST generation path: plain messages, return the primed scenario.
        const base = stickyScenario !== null ? stickyScenario : defaultResponse;
        const delayMatch = typeof base === 'string' && base.match(/^__DELAY_MS:(\d+)__$/);
        if (delayMatch) {
            pendingDelayCount++;
            try { await new Promise(r => setTimeout(r, parseInt(delayMatch[1], 10))); }
            finally { pendingDelayCount--; }
            const marker0 = detectPersonaMarker(messages);
            const text0 = marker0 ? `[persona:${marker0}] ${defaultResponse}` : defaultResponse;
            return stream ? streamCompletion(res, text0) : jsonCompletion(res, text0);
        }
        if (base === '__INVALID_BODY__') {
            console.log('[fake-openai] invalid-body scenario');
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: }{not valid json\n\n');
            return res.end();
        }
        const marker = detectPersonaMarker(messages);
        const text = marker ? `[persona:${marker}] ${base}` : base;
        console.log(`[fake-openai] ST generate marker=${marker || 'none'} stream=${stream} → "${text.slice(0, 60)}"`);
        return stream ? streamCompletion(res, text) : jsonCompletion(res, text);
    }

    json(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[fake-openai] listening on :${PORT} (model: ${MODEL})`);
});
