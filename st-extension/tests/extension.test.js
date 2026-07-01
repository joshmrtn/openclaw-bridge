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
// withGenerationLock
// Pure copy — parameterised on `state` so tests can inject an isolated lock
// promise without the full extension STATE object.
// ---------------------------------------------------------------------------
function withGenerationLock(state, task, timeoutMs) {
    let wrappedTask = task;
    if (timeoutMs) {
        wrappedTask = (...args) => {
            let timeoutHandle;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutHandle = setTimeout(
                    () => reject(new Error(`[openclaw-bridge] generateForCharacter timed out after ${timeoutMs}ms`)),
                    timeoutMs
                );
            });
            return Promise.race([task(...args), timeoutPromise])
                .finally(() => clearTimeout(timeoutHandle));
        };
    }
    const next = state.generationLock.then(wrappedTask, wrappedTask);
    state.generationLock = next.catch((err) => {
        console.error('[openclaw-bridge] Generation lock task threw:', err);
    });
    return next;
}

describe('withGenerationLock', () => {
    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); });

    it('resolves the return value when the task succeeds', async () => {
        const state = { generationLock: Promise.resolve() };
        const result = await withGenerationLock(state, async () => 'hello');
        expect(result).toBe('hello');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs an error when the task throws', async () => {
        const state = { generationLock: Promise.resolve() };
        const err = new Error('gen failed');
        await expect(withGenerationLock(state, async () => { throw err; })).rejects.toThrow('gen failed');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Generation lock'), err);
    });

    it('keeps the lock chain usable after a failed task', async () => {
        const state = { generationLock: Promise.resolve() };
        const results = [];
        const first = withGenerationLock(state, async () => { throw new Error('boom'); });
        const second = withGenerationLock(state, async () => { results.push('second'); });
        await Promise.allSettled([first, second]);
        expect(results).toEqual(['second']);
    });

    it('serialises concurrent calls from different characters — second does not start until first resolves', async () => {
        const state = { generationLock: Promise.resolve() };
        const order = [];

        let resolveFirst;
        const firstGate = new Promise(res => { resolveFirst = res; });

        // First call: enters immediately, blocks on firstGate
        const first = withGenerationLock(state, async () => {
            order.push('first-start');
            await firstGate;
            order.push('first-end');
            return 'frog';
        });

        // Second call: queued behind first
        const second = withGenerationLock(state, async () => {
            order.push('second-start');
            return 'toad';
        });

        // Let first complete, then await both
        resolveFirst();
        await Promise.all([first, second]);

        expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    });

    it('rejects a hung task when timeoutMs fires and releases the lock for the next waiter', async () => {
        const state = { generationLock: Promise.resolve() };
        const order = [];

        // Task that never settles — simulates a hung Generate() call
        const hung = withGenerationLock(
            state,
            () => new Promise(() => {}), // never resolves
            50 // 50ms timeout
        );

        // Second task queued behind the hung one
        const next = withGenerationLock(state, async () => { order.push('ran'); return 'ok'; });

        await expect(hung).rejects.toThrow(/timed out/);
        await expect(next).resolves.toBe('ok');
        expect(order).toEqual(['ran']);
    }, 5000);

    it('does not fire timeout when task completes before the deadline', async () => {
        const state = { generationLock: Promise.resolve() };
        const result = await withGenerationLock(
            state,
            async () => 'fast',
            500 // 500ms timeout — task finishes long before this
        );
        expect(result).toBe('fast');
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

// ---------------------------------------------------------------------------
// generateForCharacter — name override and restoration logic
// Pure copies of the two pieces of generateForCharacter() that manage the
// temporary setCharacterName() call:
//   1. applyNameOverride  — mirrors lines 890–913
//   2. restoreCharacterName — mirrors the finally block lines 1040–1051
// Both are parameterised so no browser globals are needed.
// ---------------------------------------------------------------------------

function applyNameOverride(characterName, setFn, globalSetFn) {
    let nameOverridden = false;
    if (typeof setFn === 'function') {
        try {
            setFn(characterName);
            nameOverridden = true;
        } catch (e) {
            console.warn('[openclaw-bridge] setCharacterName failed:', e);
        }
    } else if (typeof globalSetFn === 'function') {
        try {
            globalSetFn(characterName);
            nameOverridden = true;
        } catch (e) {
            console.warn('[openclaw-bridge] global setCharacterName failed:', e);
        }
    }
    return nameOverridden;
}

// NOTE: this copy reflects the FIXED guard (typeof previousName2 === 'string').
// The source was updated to match — the test exists to prevent regression.
function restoreCharacterName(nameOverridden, previousName2, setFn) {
    if (nameOverridden && typeof setFn === 'function') {
        if (typeof previousName2 === 'string') {
            try {
                setFn(previousName2);
            } catch (e) {
                console.warn('[openclaw-bridge] Failed to restore name2:', e);
            }
        }
    }
}

describe('generateForCharacter — name override', () => {
    let warnSpy;
    beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('calls setFn with characterName and returns nameOverridden=true on success', () => {
        const setFn = jest.fn();
        const result = applyNameOverride('Frog', setFn, null);
        expect(setFn).toHaveBeenCalledWith('Frog');
        expect(result).toBe(true);
    });

    it('returns nameOverridden=false and warns when setFn throws', () => {
        const setFn = jest.fn(() => { throw new Error('ST not ready'); });
        const result = applyNameOverride('Frog', setFn, null);
        expect(result).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('setCharacterName failed'),
            expect.any(Error),
        );
    });

    it('falls back to globalSetFn when setFn is not a function', () => {
        const globalSetFn = jest.fn();
        const result = applyNameOverride('Toad', undefined, globalSetFn);
        expect(globalSetFn).toHaveBeenCalledWith('Toad');
        expect(result).toBe(true);
    });

    it('returns nameOverridden=false and warns when globalSetFn throws', () => {
        const globalSetFn = jest.fn(() => { throw new Error('global not ready'); });
        const result = applyNameOverride('Toad', undefined, globalSetFn);
        expect(result).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('global setCharacterName failed'),
            expect.any(Error),
        );
    });

    it('returns nameOverridden=false when neither setFn nor globalSetFn is available', () => {
        const result = applyNameOverride('Frog', undefined, undefined);
        expect(result).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

describe('generateForCharacter — name restoration (finally block)', () => {
    let warnSpy;
    beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('restores previousName2 when nameOverridden is true and previousName2 is a string', () => {
        const setFn = jest.fn();
        restoreCharacterName(true, 'Frog', setFn);
        expect(setFn).toHaveBeenCalledWith('Frog');
    });

    it('does not call setFn when previousName2 is undefined', () => {
        const setFn = jest.fn();
        restoreCharacterName(true, undefined, setFn);
        expect(setFn).not.toHaveBeenCalled();
    });

    it('does not call setFn when previousName2 is null', () => {
        const setFn = jest.fn();
        restoreCharacterName(true, null, setFn);
        expect(setFn).not.toHaveBeenCalled();
    });

    it('does not call setFn when nameOverridden is false', () => {
        const setFn = jest.fn();
        restoreCharacterName(false, 'Frog', setFn);
        expect(setFn).not.toHaveBeenCalled();
    });

    it('does not throw when setFn is not a function', () => {
        expect(() => restoreCharacterName(true, 'Frog', null)).not.toThrow();
        expect(() => restoreCharacterName(true, 'Frog', undefined)).not.toThrow();
    });

    it('catches and warns when setFn throws during restoration', () => {
        const setFn = jest.fn(() => { throw new Error('restore failed'); });
        restoreCharacterName(true, 'Frog', setFn);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to restore name2'),
            expect.any(Error),
        );
    });
});

// ---------------------------------------------------------------------------
// generateForCharacter — generateQuietPrompt dispatch
// Pure copy of the generateQuietPrompt branch in generateForCharacter()
// (~lines 890-909 of src/index.js), parameterised to remove browser globals.
// ---------------------------------------------------------------------------

async function dispatchGenerateQuietPrompt(generateQuietPrompt, message, chid) {
    return generateQuietPrompt({
        quietPrompt: message,
        forceChId: chid,
        skipWIAN: false,
        quietToLoud: true,
        removeReasoning: false,
        trimToSentence: false,
    });
}

describe('generateForCharacter — generateQuietPrompt dispatch', () => {
    it('passes forceChId to generateQuietPrompt', async () => {
        const mock = jest.fn().mockResolvedValue('Ribbit!');
        await dispatchGenerateQuietPrompt(mock, 'hello', 3);
        expect(mock).toHaveBeenCalledWith(expect.objectContaining({ forceChId: 3 }));
    });

    it('propagates the error when generateQuietPrompt throws — does not silently retry without forceChId', async () => {
        const err = new Error('generateQuietPrompt failed');
        const mock = jest.fn().mockRejectedValue(err);
        await expect(dispatchGenerateQuietPrompt(mock, 'hello', 3)).rejects.toThrow('generateQuietPrompt failed');
        expect(mock).toHaveBeenCalledTimes(1);
    });
});

// Pure copy of withCharacterLock for concurrent-action tests (#125)
function makeCharacterLockEnv() {
    const characterLocks = new Map();
    const pendingActions = new Map();
    const pendingStSideActions = new Map();

    function withCharacterLock(characterName, task) {
        const previous = characterLocks.get(characterName) || Promise.resolve();
        const next = previous.then(task, task);
        characterLocks.set(characterName, next.catch(() => {}));
        return next;
    }

    // Simulates the BUGGY path: set called before lock acquired
    async function handleBuggy(character, generateFn) {
        pendingActions.set(character, []);
        pendingStSideActions.set(character, []);
        const response = await withCharacterLock(character, () => generateFn(pendingActions, pendingStSideActions, character));
        return { response, actions: pendingActions.get(character) || [] };
    }

    // Simulates the FIXED path: set called inside the lock task
    async function handleFixed(character, generateFn) {
        const response = await withCharacterLock(character, async () => {
            pendingActions.set(character, []);
            pendingStSideActions.set(character, []);
            return generateFn(pendingActions, pendingStSideActions, character);
        });
        return { response, actions: pendingActions.get(character) || [] };
    }

    return { pendingActions, pendingStSideActions, handleBuggy, handleFixed };
}

describe('pendingActions reset ordering under concurrent requests (#125)', () => {
    it('buggy path: request B set() wipes actions queued during A generation', async () => {
        const { pendingActions, handleBuggy } = makeCharacterLockEnv();

        let resolveA;
        const genA = (_pm, _s, _c) => new Promise(resolve => { resolveA = () => resolve('response-A'); });
        const genB = (_pm, _s, _c) => Promise.resolve('response-B');

        const promiseA = handleBuggy('Frog', genA);
        await Promise.resolve(); // let genA start and set resolveA

        // Tool call fires during A's generation — action lands in A's array
        pendingActions.get('Frog').push('action-from-A');
        expect(pendingActions.get('Frog')).toEqual(['action-from-A']);

        // B arrives concurrently — its set() runs synchronously, wiping A's array
        const promiseB = handleBuggy('Frog', genB);
        expect(pendingActions.get('Frog')).toEqual([]); // B wiped A's action!

        resolveA();
        const resultA = await promiseA;
        await promiseB;

        // A reads back the map after the lock and gets an empty array — action lost
        expect(resultA.actions).toEqual([]);
    });

    it('fixed path: request B set() is inside lock so A actions survive (#125)', async () => {
        const { pendingActions, handleFixed } = makeCharacterLockEnv();

        let resolveA;
        const genA = (_pm, _s, _c) => new Promise(resolve => { resolveA = () => resolve('response-A'); });
        const genB = (_pm, _s, _c) => Promise.resolve('response-B');

        const promiseA = handleFixed('Frog', genA);
        await Promise.resolve(); // let lockTaskA start (runs set() then genA, sets resolveA)

        // Tool call fires during A's generation
        pendingActions.get('Frog').push('action-from-A');

        // B arrives — its set() is inside the lock so it's deferred until A completes
        const promiseB = handleFixed('Frog', genB);
        expect(pendingActions.get('Frog')).toEqual(['action-from-A']); // still A's array

        resolveA();
        const resultA = await promiseA;
        await promiseB;

        // A's action survived
        expect(resultA.actions).toEqual(['action-from-A']);
    });
});

// ── #235: live chat incremental append (decision logic) ──────────────────────
// Pure copies of the decision helpers from src/index.js — keep these identical to
// the source. They decide whether a chat_updated event appends incrementally,
// reloads, badges, or is skipped, without touching the browser.
function decideChatUpdate({ updatedChid, currentChid, atBottom, canAppend, alreadyApplied }) {
    if (updatedChid === -1 || currentChid !== updatedChid) return 'skip';
    if (alreadyApplied) return 'duplicate';
    if (!atBottom) return 'badge';
    return canAppend ? 'append' : 'reload';
}

function canAppendIncrementally(payload, context) {
    return Array.isArray(payload?.appended)
        && payload.appended.length > 0
        && Array.isArray(context?.chat)
        && typeof context?.addOneMessage === 'function';
}

function isUpdateAlreadyApplied(payload, context) {
    const appended = payload?.appended;
    const chat = context?.chat;
    if (!Array.isArray(appended) || appended.length === 0) return false;
    if (!Array.isArray(chat) || chat.length === 0) return false;
    const lastAppendedId = appended[appended.length - 1]?.exchange_id;
    if (!lastAppendedId) return false;
    return chat[chat.length - 1]?.exchange_id === lastAppendedId;
}

describe('decideChatUpdate (#235)', () => {
    const base = { updatedChid: 2, currentChid: 2, atBottom: true, canAppend: true, alreadyApplied: false };

    it('skips when not viewing the updated character', () => {
        expect(decideChatUpdate({ ...base, currentChid: 1 })).toBe('skip');
    });

    it('skips when the character is not found (chid -1)', () => {
        expect(decideChatUpdate({ ...base, updatedChid: -1, currentChid: -1 })).toBe('skip');
    });

    it('reports duplicate when the update is already applied', () => {
        expect(decideChatUpdate({ ...base, alreadyApplied: true })).toBe('duplicate');
    });

    it('badges when scrolled up', () => {
        expect(decideChatUpdate({ ...base, atBottom: false })).toBe('badge');
    });

    it('appends when at bottom and append is safe', () => {
        expect(decideChatUpdate(base)).toBe('append');
    });

    it('reloads when at bottom but append is not safe', () => {
        expect(decideChatUpdate({ ...base, canAppend: false })).toBe('reload');
    });

    it('prefers duplicate over badge even when scrolled up', () => {
        expect(decideChatUpdate({ ...base, atBottom: false, alreadyApplied: true })).toBe('duplicate');
    });
});

describe('canAppendIncrementally (#235)', () => {
    const ctx = { chat: [], addOneMessage() {} };

    it('true when payload has entries and context supports it', () => {
        expect(canAppendIncrementally({ appended: [{ mes: 'a' }] }, ctx)).toBe(true);
    });

    it('false when appended is empty (e.g. a deduped write)', () => {
        expect(canAppendIncrementally({ appended: [] }, ctx)).toBe(false);
    });

    it('false when appended is missing (older plugin payload)', () => {
        expect(canAppendIncrementally({}, ctx)).toBe(false);
    });

    it('false when context lacks addOneMessage', () => {
        expect(canAppendIncrementally({ appended: [{ mes: 'a' }] }, { chat: [] })).toBe(false);
    });

    it('false when context.chat is not an array', () => {
        expect(canAppendIncrementally({ appended: [{ mes: 'a' }] }, { addOneMessage() {} })).toBe(false);
    });
});

describe('isUpdateAlreadyApplied (#235)', () => {
    it('true when the chat tail already has the last appended exchange_id', () => {
        const payload = { appended: [{ exchange_id: 'x1' }, { exchange_id: 'x1' }] };
        const context = { chat: [{ exchange_id: 'old' }, { exchange_id: 'x1' }] };
        expect(isUpdateAlreadyApplied(payload, context)).toBe(true);
    });

    it('false when the chat tail has a different exchange_id', () => {
        const payload = { appended: [{ exchange_id: 'x2' }] };
        const context = { chat: [{ exchange_id: 'x1' }] };
        expect(isUpdateAlreadyApplied(payload, context)).toBe(false);
    });

    it('false when appended entries have no exchange_id (e.g. heartbeat lines)', () => {
        const payload = { appended: [{ mes: '[Heartbeat]' }] };
        const context = { chat: [{ mes: '[Heartbeat]' }] };
        expect(isUpdateAlreadyApplied(payload, context)).toBe(false);
    });

    it('false when chat is empty', () => {
        expect(isUpdateAlreadyApplied({ appended: [{ exchange_id: 'x1' }] }, { chat: [] })).toBe(false);
    });
});

// ── #234: External Presence "no channels configured" warning ─────────────────
// Pure copy of the source helper (avoids browser globals), plus a source-presence
// guard so this is a real red→green for the implementation.
function shouldWarnNoChannels({ active, channelCount }) {
    return Boolean(active) && channelCount === 0;
}

describe('shouldWarnNoChannels (#234)', () => {
    it('warns when enabled with zero channels', () => {
        expect(shouldWarnNoChannels({ active: true, channelCount: 0 })).toBe(true);
    });

    it('does not warn when channels are configured', () => {
        expect(shouldWarnNoChannels({ active: true, channelCount: 2 })).toBe(false);
    });

    it('does not warn when not enabled, even with zero channels', () => {
        expect(shouldWarnNoChannels({ active: false, channelCount: 0 })).toBe(false);
    });

    it('source defines shouldWarnNoChannels and an updateChannelWarning wiring', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
        expect(src).toContain('function shouldWarnNoChannels');
        expect(src).toContain('updateChannelWarning');
    });
});

// ── #234: runtime toast on send_message misconfig ────────────────────────────
// Pure copy of the source handler (reads globals, which the test stubs), plus a
// source-presence guard that config_warning is dispatched on all three transports.
function handleConfigWarning(payload) {
    if (globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE === 'headless') return; // no UI in headless
    const message = payload && payload.message;
    if (!message) return;
    if (globalThis.toastr && typeof globalThis.toastr.warning === 'function') {
        globalThis.toastr.warning(message, 'OpenClaw Bridge');
    }
}

describe('handleConfigWarning (#234)', () => {
    const origType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE;
    afterEach(() => {
        globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = origType;
        delete globalThis.toastr;
    });

    it('shows a warning toast with the message in a UI client', () => {
        globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'ui';
        const warning = jest.fn();
        globalThis.toastr = { warning };
        handleConfigWarning({ message: "channel 'general' is not configured" });
        expect(warning).toHaveBeenCalledWith("channel 'general' is not configured", 'OpenClaw Bridge');
    });

    it('does nothing in a headless client', () => {
        globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'headless';
        const warning = jest.fn();
        globalThis.toastr = { warning };
        handleConfigWarning({ message: 'anything' });
        expect(warning).not.toHaveBeenCalled();
    });

    it('is a no-op when the payload has no message', () => {
        globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'ui';
        const warning = jest.fn();
        globalThis.toastr = { warning };
        handleConfigWarning({});
        expect(warning).not.toHaveBeenCalled();
    });

    it('source defines handleConfigWarning and dispatches config_warning on WS/SSE/HTTP', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
        expect(src).toContain('function handleConfigWarning');
        const occurrences = (src.match(/config_warning/g) || []).length;
        expect(occurrences).toBeGreaterThanOrEqual(3);
    });
});

// #264: per-character tool allowlist toggles in the management panel.
// Pure copies of the panel helpers (no browser globals), plus a source-presence guard.
function toolEnabledForUi(link, type) {
    return !(link && link.tools && link.tools[type] === false);
}
function collectToolToggles(toggleEls) {
    const tools = {};
    for (const el of toggleEls) {
        const type = el && el.dataset && el.dataset.tool;
        if (type) tools[type] = Boolean(el.checked);
    }
    return tools;
}

describe('management panel tool allowlist (#264)', () => {
    test('default ON: a tool is enabled unless explicitly disabled', () => {
        expect(toolEnabledForUi(null, 'write_memory')).toBe(true);
        expect(toolEnabledForUi({ tools: {} }, 'write_memory')).toBe(true);
        expect(toolEnabledForUi({ tools: { write_memory: true } }, 'write_memory')).toBe(true);
        expect(toolEnabledForUi({ tools: { write_memory: false } }, 'write_memory')).toBe(false);
    });

    test('collectToolToggles builds a full type→boolean map from the checkboxes', () => {
        const toggles = [
            { dataset: { tool: 'send_message' }, checked: true },
            { dataset: { tool: 'write_memory' }, checked: false },
        ];
        expect(collectToolToggles(toggles)).toEqual({ send_message: true, write_memory: false });
    });

    test('source builds tool toggles, derives them from the tool defs, and sends tools in the save body', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
        expect(src).toContain('function toolEnabledForUi');
        expect(src).toContain('function collectToolToggles');
        expect(src).toContain('openclaw-bridge-tool-toggle');
        expect(src).toMatch(/tools,/);
    });
});

// #250: channel read-back builds { name, channel_id, kind, id } and requires all four.
// Pure copy of the per-row build/validation logic in the management panel save handler.
function buildChannelEntry(name, channelId, kind, id) {
    name = (name || '').trim();
    channelId = (channelId || '').trim();
    kind = (kind || '').trim();
    id = (id || '').trim();
    if (!name || !channelId || (kind !== 'dm' && kind !== 'channel') || !id) {
        return { ok: false };
    }
    return { ok: true, entry: { name, channel_id: channelId, kind, id } };
}

describe('management panel channel read-back (#250)', () => {
    test('builds a dm entry from name + channel_id + kind + recipient id', () => {
        expect(buildChannelEntry('dm', 'discord', 'dm', '1509')).toEqual({
            ok: true,
            entry: { name: 'dm', channel_id: 'discord', kind: 'dm', id: '1509' },
        });
    });

    test('builds a channel entry', () => {
        expect(buildChannelEntry('the-pond', 'discord', 'channel', '4455')).toEqual({
            ok: true,
            entry: { name: 'the-pond', channel_id: 'discord', kind: 'channel', id: '4455' },
        });
    });

    test('rejects a missing recipient id', () => {
        expect(buildChannelEntry('dm', 'discord', 'dm', '')).toEqual({ ok: false });
    });

    test('rejects an invalid kind', () => {
        expect(buildChannelEntry('dm', 'discord', 'bogus', '1509')).toEqual({ ok: false });
    });

    test('source uses the kind selector + recipient input and builds the new shape', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
        expect(src).toContain('openclaw-bridge-channel-kind');
        expect(src).toContain('openclaw-bridge-channel-recipient');
        expect(src).toContain('channels.push({ name, channel_id: channelId, kind, id })');
    });
});
