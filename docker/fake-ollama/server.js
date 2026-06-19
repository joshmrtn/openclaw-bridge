/**
 * fake-ollama — minimal Ollama API server for openclaw-bridge E2E tests.
 *
 * Implements the Ollama HTTP API so SillyTavern treats it as a real model.
 * Responses come from a scripted scenario set via POST /scenario, or from
 * the DEFAULT_RESPONSE env var, or a built-in fallback string.
 *
 * Endpoints:
 *   GET  /api/tags      → model list (single "fake-model" entry)
 *   GET  /api/version   → {"version":"0.1.0"}
 *   POST /api/generate  → generate (streaming NDJSON)
 *   POST /api/chat      → chat (streaming NDJSON)
 *   POST /scenario      → { response } set next scripted response
 *   POST /error-once    → next generate/chat request returns HTTP 500
 *   GET  /pending-count → { count } of requests currently held by a delay scenario
 *   POST /reset         → clear scenario queue and all control flags
 *
 * Special sentinel values for scenario responses:
 *   __INVALID_NDJSON__       → write garbled bytes (not valid JSON)
 *   __DELAY_MS:N__           → delay N milliseconds, then return defaultResponse
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '11434', 10);
const MODEL = 'fake-model';

let defaultResponse = process.env.DEFAULT_RESPONSE || 'This is a fake LLM response for testing.';
// When set, fake-ollama scans incoming prompts for these character names and
// prepends [persona:NAME] to the response, enabling bleed-detection assertions.
const echoMarkers = (process.env.ECHO_CHARACTER_MARKERS || '').split(',').filter(Boolean);
const scenarioQueue = [];

// Control flags for failure-path testing (all reset by POST /reset)
let nextErrorOnce = false;
let pendingDelayCount = 0;

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function detectPersonaMarker(body, isChat) {
    if (echoMarkers.length === 0) return null;
    // Collect all text from the request to search for known character names
    let text = '';
    if (isChat) {
        const systemMsg = (body.messages || []).find(m => m.role === 'system');
        text = systemMsg?.content || '';
    } else {
        text = (body.system || '') + ' ' + (body.prompt || '');
    }
    for (const name of echoMarkers) {
        if (text.includes(name)) return name;
    }
    return null;
}

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function streamText(res, text, isChat) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });

    // Stream token by token (split on spaces for simplicity)
    const tokens = text.match(/\S+\s*/g) || [text];
    for (const token of tokens) {
        const chunk = isChat
            ? { model: MODEL, created_at: new Date().toISOString(), message: { role: 'assistant', content: token }, done: false }
            : { model: MODEL, created_at: new Date().toISOString(), response: token, done: false };
        res.write(JSON.stringify(chunk) + '\n');
    }

    const done = isChat
        ? { model: MODEL, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, total_duration: 1000000, eval_count: tokens.length }
        : { model: MODEL, created_at: new Date().toISOString(), response: '', done: true, total_duration: 1000000, eval_count: tokens.length };
    res.write(JSON.stringify(done) + '\n');
    res.end();
}

function nonStreamText(res, text, isChat) {
    const body = isChat
        ? { model: MODEL, created_at: new Date().toISOString(), message: { role: 'assistant', content: text }, done: true }
        : { model: MODEL, created_at: new Date().toISOString(), response: text, done: true };
    json(res, 200, body);
}

const server = http.createServer(async (req, res) => {
    const { method } = req;
    const path = new URL(req.url, `http://localhost`).pathname;

    if (method === 'GET' && path === '/api/tags') {
        return json(res, 200, {
            models: [{
                name: MODEL, model: MODEL,
                modified_at: new Date().toISOString(),
                size: 1, digest: 'sha256:fake',
                details: { format: 'gguf', family: 'fake', parameter_size: '1B', quantization_level: 'Q4_0' },
            }],
        });
    }

    if (method === 'GET' && (path === '/api/version' || path === '/')) {
        return json(res, 200, { version: '0.1.0' });
    }

    if (method === 'GET' && path === '/pending-count') {
        return json(res, 200, { count: pendingDelayCount });
    }

    if (method === 'POST' && path === '/reset') {
        scenarioQueue.length = 0;
        nextErrorOnce = false;
        // pendingDelayCount is live state; requests still in-flight at reset will decrement it naturally
        return json(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/error-once') {
        nextErrorOnce = true;
        return json(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/scenario') {
        try {
            const body = await readBody(req);
            const { response } = JSON.parse(body);
            if (typeof response !== 'string') return json(res, 400, { error: 'response must be a string' });
            scenarioQueue.push(response);
            return json(res, 200, { queued: true, queueLength: scenarioQueue.length });
        } catch {
            return json(res, 400, { error: 'invalid JSON' });
        }
    }

    if (method === 'POST' && (path === '/api/generate' || path === '/api/chat')) {
        const isChat = path === '/api/chat';

        // error-once: return 500 before doing anything else
        if (nextErrorOnce) {
            nextErrorOnce = false;
            console.log('[fake-ollama] error-once triggered — returning 500');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'injected error for testing' }));
        }

        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body);
            const stream = parsed.stream !== false;
            const base = scenarioQueue.length > 0 ? scenarioQueue.shift() : defaultResponse;

            // __INVALID_NDJSON__: return garbled bytes that cannot be parsed as NDJSON
            if (base === '__INVALID_NDJSON__') {
                console.log('[fake-ollama] invalid-ndjson scenario triggered');
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
                res.write('}{not valid json at all\n');
                res.write('more garbage }}}}{\n');
                return res.end();
            }

            // __DELAY_MS:N__: hold the request for N ms then respond with defaultResponse
            const delayMatch = typeof base === 'string' && base.match(/^__DELAY_MS:(\d+)__$/);
            if (delayMatch) {
                const delayMs = parseInt(delayMatch[1], 10);
                console.log(`[fake-ollama] delay scenario: holding for ${delayMs}ms`);
                pendingDelayCount++;
                try {
                    await new Promise(r => setTimeout(r, delayMs));
                } finally {
                    pendingDelayCount--;
                }
                const marker = detectPersonaMarker(parsed, isChat);
                const text = marker ? `[persona:${marker}] ${defaultResponse}` : defaultResponse;
                console.log(`[fake-ollama] delay complete → "${text.slice(0, 80)}"`);
                return stream ? streamText(res, text, isChat) : nonStreamText(res, text, isChat);
            }

            const marker = detectPersonaMarker(parsed, isChat);
            const text = marker ? `[persona:${marker}] ${base}` : base;
            console.log(`[fake-ollama] ${isChat ? 'chat' : 'generate'} marker=${marker || 'none'} → "${text.slice(0, 80)}"`);
            return stream ? streamText(res, text, isChat) : nonStreamText(res, text, isChat);
        } catch (err) {
            return json(res, 400, { error: err.message });
        }
    }

    res.writeHead(404);
    res.end();
});

server.listen(PORT, () => {
    console.log(`[fake-ollama] listening on :${PORT} (model: ${MODEL})`);
});
