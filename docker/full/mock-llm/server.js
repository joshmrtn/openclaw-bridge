/**
 * mock-llm — OpenAI Responses API mock for openclaw-bridge full E2E tests.
 *
 * OC uses the OpenAI Responses API (POST /v1/responses, SSE streaming).
 * For the bridge E2E, we need OC's agent to call the character-bridge skill's
 * generate_response tool. This mock deterministically does that: when it sees
 * the generate_response tool in the request, it calls it; when it gets the
 * tool result, it returns a simple text response.
 *
 * Endpoints:
 *   GET  /healthz            → { ok: true }
 *   POST /v1/responses       → SSE stream (OpenAI Responses API format)
 */

'use strict';

const http = require('http');
const { randomUUID } = require('crypto');

const PORT = parseInt(process.env.PORT || '11435', 10);
const CHARACTER_NAME = process.env.CHARACTER_NAME || 'TestBot';
const CHANNEL = process.env.CHANNEL || 'qa-channel';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sse(res, events) {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Extract last user text from the Responses API input array */
function extractLastUserText(input) {
  if (!Array.isArray(input)) return '';
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.role !== 'user') continue;
    if (typeof item.content === 'string') return item.content;
    if (Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block.type === 'input_text' && typeof block.text === 'string') return block.text;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
      }
    }
  }
  return '';
}

/** Check if the input contains a tool result (meaning we're on turn 2+) */
function hasToolOutput(input) {
  if (!Array.isArray(input)) return false;
  return input.some(item =>
    item.type === 'function_call_output' ||
    item.role === 'tool' ||
    (Array.isArray(item.content) && item.content.some(b => b.type === 'tool_result'))
  );
}

/** Check if generate_response is in the tools list */
function hasGenerateResponseTool(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some(t => t.name === 'generate_response' || (t.function && t.function.name === 'generate_response'));
}

/** Extract user_id from the last user message text (looks for qa:sender pattern) */
function extractUserId(text) {
  // Look for patterns like "[GUEST] qa:sender:" or just use default
  const match = /(?:GUEST|OWNER\]?\s+)?([\w:.-]+)(?:\s*:)?/i.exec(text);
  return (match && match[1].includes(':')) ? match[1] : 'qa:test-user';
}


function buildFunctionCallSse(callId, fcId, args) {
  const item = {
    type: 'function_call',
    id: fcId,
    call_id: callId,
    name: 'generate_response',
    arguments: args,
  };
  return [
    { type: 'response.output_item.added', item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: fcId, output_index: 0, delta: args },
    { type: 'response.output_item.done', item },
  ];
}

function buildTextSse(msgId, text) {
  return [
    {
      type: 'response.output_item.added',
      item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] },
    },
    { type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text },
    {
      type: 'response.output_item.done',
      item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
    },
  ];
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const path = new URL(req.url || '/', `http://localhost`).pathname;

  if (method === 'GET' && (path === '/healthz' || path === '/health')) {
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && path === '/v1/responses') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }

    const input = body.input || [];
    const tools = body.tools || [];
    const responseId = `resp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    console.log(`[mock-llm] received request — tools: [${tools.map(t => t.name || (t.function && t.function.name) || '?').join(', ')}]`);
    if (tools.length > 0) console.log(`[mock-llm] first tool structure: ${JSON.stringify(tools[0]).slice(0, 200)}`);
    console.log(`[mock-llm] input types: [${input.map(i => i.type || i.role || '?').join(', ')}]`);

    // Turn 2+: tool output received → return simple text acknowledgment
    if (hasToolOutput(input)) {
      const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const text = 'Done.';
      const events = [
        ...buildTextSse(msgId, text),
        {
          type: 'response.completed',
          response: {
            id: responseId,
            status: 'completed',
            output: [{ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
            usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
          },
        },
      ];
      return sse(res, events);
    }

    // Turn 1: user message with generate_response tool → call the tool
    if (hasGenerateResponseTool(tools)) {
      const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const fcId = `fc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const userText = extractLastUserText(input);
      const userId = extractUserId(userText);
      const cleanText = userText.replace(/^\[(GUEST|OWNER)\]\s*\S+\s*:\s*/i, '').trim() || userText;

      const args = JSON.stringify({
        character: CHARACTER_NAME,
        message: cleanText,
        channel: CHANNEL,
        user_id: userId,
      });

      const item = {
        type: 'function_call',
        id: fcId,
        call_id: callId,
        name: 'generate_response',
        arguments: args,
      };

      const events = [
        { type: 'response.output_item.added', item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: fcId, output_index: 0, delta: args },
        { type: 'response.output_item.done', item },
        {
          type: 'response.completed',
          response: {
            id: responseId,
            status: 'completed',
            output: [item],
            usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
          },
        },
      ];
      console.log(`[mock-llm] turn 1 → generate_response(character=${CHARACTER_NAME}, message="${cleanText.slice(0, 60)}")`);
      return sse(res, events);
    }

    // Fallback: return a simple text response
    const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const text = '[mock-llm] I received your message.';
    const events = [
      ...buildTextSse(msgId, text),
      {
        type: 'response.completed',
        response: {
          id: responseId,
          status: 'completed',
          output: [{ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      },
    ];
    return sse(res, events);
  }

  // Minimal endpoint stubs so OC doesn't error on startup probes
  if (path === '/v1/models' || path === '/v1/embeddings') {
    return json(res, 200, { object: 'list', data: [] });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-llm] listening on :${PORT} (character=${CHARACTER_NAME})`);
});
