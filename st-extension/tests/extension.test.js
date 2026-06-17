const fs = require('fs');
const path = require('path');

test('st-extension index.js exists', () => {
    const p = path.join(__dirname, '..', 'index.js');
    expect(fs.existsSync(p)).toBe(true);
});

// Pure copy of the function under test — avoids importing browser globals.
function stripInstructTemplate(text) {
    if (!text || typeof text !== 'string') return text;

    let s = text;

    const chatMlAssistant = s.lastIndexOf('<|im_start|>assistant');
    if (chatMlAssistant !== -1) {
        const afterNewline = s.indexOf('\n', chatMlAssistant);
        s = afterNewline !== -1 ? s.slice(afterNewline + 1) : s.slice(chatMlAssistant + 21);
    }

    const llama3Header = s.lastIndexOf('<|start_header_id|>assistant<|end_header_id|>');
    if (llama3Header !== -1) {
        const afterHeader = s.indexOf('\n\n', llama3Header);
        s = afterHeader !== -1 ? s.slice(afterHeader + 2) : s.slice(llama3Header + 45);
    }

    const lastInstClose = s.lastIndexOf('[/INST]');
    if (lastInstClose !== -1) {
        s = s.slice(lastInstClose + 7);
    }

    const alpacaAssistant = s.lastIndexOf('### Assistant:');
    if (alpacaAssistant !== -1) {
        const afterNewline = s.indexOf('\n', alpacaAssistant);
        s = afterNewline !== -1 ? s.slice(afterNewline + 1) : s.slice(alpacaAssistant + 14);
    }

    s = s.replace(/<\|im_end\|>/g, '')
         .replace(/<\|im_start\|>/g, '')
         .replace(/<\|endoftext\|>/g, '')
         .replace(/<\|eot_id\|>/g, '')
         .replace(/<\/s>/g, '')
         .replace(/^<s>/g, '');

    return s.trim();
}

describe('stripInstructTemplate', () => {
    it('passes through clean text unchanged', () => {
        expect(stripInstructTemplate('Hello there!')).toBe('Hello there!');
    });

    it('handles null/undefined gracefully', () => {
        expect(stripInstructTemplate(null)).toBeNull();
        expect(stripInstructTemplate(undefined)).toBeUndefined();
        expect(stripInstructTemplate('')).toBe('');
    });

    it('strips ChatML assistant block', () => {
        const raw = '<|im_start|>user\nHi<|im_end|>\n<|im_start|>assistant\nHello from the model<|im_end|>';
        expect(stripInstructTemplate(raw)).toBe('Hello from the model');
    });

    it('strips ChatML with only assistant block', () => {
        const raw = '<|im_start|>assistant\nJust the reply<|im_end|>';
        expect(stripInstructTemplate(raw)).toBe('Just the reply');
    });

    it('strips stray im_end token', () => {
        expect(stripInstructTemplate('Clean text<|im_end|>')).toBe('Clean text');
    });

    it('strips Llama 3 assistant header', () => {
        const raw = '<|start_header_id|>assistant<|end_header_id|>\n\nHere is my answer<|eot_id|>';
        expect(stripInstructTemplate(raw)).toBe('Here is my answer');
    });

    it('strips Mistral/Llama instruct [/INST]', () => {
        const raw = '[INST] Say hello [/INST] Hello world';
        expect(stripInstructTemplate(raw)).toBe('Hello world');
    });

    it('strips multi-turn Mistral instruct taking last response', () => {
        const raw = '[INST] First [/INST] First reply [INST] Second [/INST] Second reply';
        expect(stripInstructTemplate(raw)).toBe('Second reply');
    });

    it('strips Alpaca ### Assistant: prefix', () => {
        const raw = '### Human: Hi\n### Assistant:\nNice to meet you';
        expect(stripInstructTemplate(raw)).toBe('Nice to meet you');
    });

    it('strips BOS/EOS tokens', () => {
        expect(stripInstructTemplate('<s>Hello</s>')).toBe('Hello');
        expect(stripInstructTemplate('<s>Hello')).toBe('Hello');
        expect(stripInstructTemplate('Hello</s>')).toBe('Hello');
    });

    it('strips <|endoftext|>', () => {
        expect(stripInstructTemplate('Done talking<|endoftext|>')).toBe('Done talking');
    });

    it('trims surrounding whitespace', () => {
        expect(stripInstructTemplate('  hello  ')).toBe('hello');
    });

    it('preserves newlines inside the response body', () => {
        const raw = '<|im_start|>assistant\nLine one\nLine two<|im_end|>';
        expect(stripInstructTemplate(raw)).toBe('Line one\nLine two');
    });
});

// ---------------------------------------------------------------------------
// withCharacterLock
// Pure copy — avoids importing browser globals.
// Parameterised on `state` so tests can inject an isolated Map without needing
// the full extension STATE object.
// ---------------------------------------------------------------------------
function withCharacterLock(state, characterName, task) {
    const previous = state.characterLocks.get(characterName) || Promise.resolve();
    const next = previous.then(task, task);
    state.characterLocks.set(characterName, next.catch((err) => {
        console.error('[openclaw-bridge] Character lock task threw:', err);
    }));
    return next;
}

describe('withCharacterLock', () => {
    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); });

    it('logs an error when the queued task throws', async () => {
        const state = { characterLocks: new Map() };
        const err = new Error('task failed');

        await expect(
            withCharacterLock(state, 'Alice', async () => { throw err; })
        ).rejects.toThrow('task failed');

        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Character lock'),
            err
        );
    });

    it('keeps the lock chain usable after a failed task', async () => {
        const state = { characterLocks: new Map() };
        const results = [];

        const first = withCharacterLock(state, 'Alice', async () => { throw new Error('boom'); });
        const second = withCharacterLock(state, 'Alice', async () => { results.push('second'); });

        await Promise.allSettled([first, second]);
        expect(results).toEqual(['second']);
    });

    it('resolves the return value when the task succeeds', async () => {
        const state = { characterLocks: new Map() };

        const result = await withCharacterLock(state, 'Alice', async () => 'ok');
        expect(result).toBe('ok');
        expect(errorSpy).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// sendSocketMessage
// Pure copy — avoids importing browser globals.
// Parameterised on `state` so tests can inject a mock socket.
// WS_OPEN mirrors WebSocket.OPEN === 1 from the browser spec.
// ---------------------------------------------------------------------------
const WS_OPEN = 1;

function sendSocketMessage(state, payload) {
    if (!state.socket || state.socket.readyState !== WS_OPEN) return;
    try {
        state.socket.send(JSON.stringify(payload));
    } catch (err) {
        console.error('[openclaw-bridge] Socket send failed:', err.message);
        try { state.socket.close(); } catch (_) {}
    }
}

describe('sendSocketMessage', () => {
    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); });

    it('logs an error and closes the socket when send() throws', () => {
        const mockSocket = {
            readyState: WS_OPEN,
            send: jest.fn(() => { throw new Error('InvalidStateError'); }),
            close: jest.fn(),
        };

        sendSocketMessage({ socket: mockSocket }, { type: 'test' });

        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Socket send failed'),
            expect.stringContaining('InvalidStateError')
        );
        expect(mockSocket.close).toHaveBeenCalled();
    });

    it('serialises the payload and sends it on success', () => {
        const mockSocket = {
            readyState: WS_OPEN,
            send: jest.fn(),
            close: jest.fn(),
        };
        const payload = { type: 'generate_response', requestId: 'abc' };

        sendSocketMessage({ socket: mockSocket }, payload);

        expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify(payload));
        expect(mockSocket.close).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does nothing when the socket is not open', () => {
        const mockSocket = {
            readyState: 3, // CLOSED
            send: jest.fn(),
            close: jest.fn(),
        };

        sendSocketMessage({ socket: mockSocket }, { type: 'test' });

        expect(mockSocket.send).not.toHaveBeenCalled();
    });

    it('does nothing when there is no socket', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sendSocketMessage({ socket: null }, { type: 'test' });
        expect(errorSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
