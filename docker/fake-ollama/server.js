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
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '11434', 10);
const MODEL = 'fake-model';

let defaultResponse = process.env.DEFAULT_RESPONSE || 'This is a fake LLM response for testing.';
const scenarioQueue = [];

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
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
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body);
            const stream = parsed.stream !== false;
            const text = scenarioQueue.length > 0 ? scenarioQueue.shift() : defaultResponse;
            console.log(`[fake-ollama] ${isChat ? 'chat' : 'generate'} → "${text.slice(0, 60)}"`);
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
