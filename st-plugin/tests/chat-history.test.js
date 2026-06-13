const fs = require('fs');
const path = require('path');
const os = require('os');

const chatHistory = require('../chat-history');

describe('chat-history', () => {
    const fixtureDir = path.join(__dirname, 'fixtures');
    const sampleFile = path.join(fixtureDir, 'sample-chat.jsonl');
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
        const charDir = path.join(tmpDir, 'Frog');
        fs.mkdirSync(charDir, { recursive: true });
        fs.copyFileSync(sampleFile, path.join(charDir, 'initial.jsonl'));
    });

    afterEach(() => {
        // remove tmpDir recursively
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('readLatestChat returns messages array', async () => {
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(Array.isArray(msgs)).toBe(true);
        expect(msgs.length).toBe(2);
        expect(msgs[0].role).toBe('user');
        expect(msgs[1].role).toBe('assistant');
    });

    test('appendMessage appends and readLatestChat reflects it', async () => {
        const newMsg = chatHistory.constructStMessage({ role: 'assistant', content: 'Mock reply' });
        await chatHistory.appendMessage('Frog', newMsg, tmpDir);
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(msgs.length).toBe(3);
        expect(msgs[2].mes).toBe('Mock reply');
    });

    test('concurrent appends do not corrupt file', async () => {
        const writers = [];
        for (let i = 0; i < 10; i++) {
            const m = chatHistory.constructStMessage({ role: 'assistant', content: `C${i}` });
            writers.push(chatHistory.appendMessage('Frog', m, tmpDir));
        }
        await Promise.all(writers);
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(msgs.length).toBe(12); // 2 original + 10 appended
        const contents = msgs.slice(2).map(m => m.mes);
        for (let i = 0; i < 10; i++) expect(contents).toContain(`C${i}`);
    });

    test('readLatestChat returns empty array when no files exist', async () => {
        const msgs = await chatHistory.readLatestChat('NoSuchChar', tmpDir);
        expect(msgs).toEqual([]);
    });

    test('appendMessage creates a new file when no chat exists for character', async () => {
        const msg = chatHistory.constructStMessage({ role: 'assistant', content: 'First ever message' });
        await chatHistory.appendMessage('BrandNew', msg, tmpDir);
        const msgs = await chatHistory.readLatestChat('BrandNew', tmpDir);
        expect(msgs.length).toBe(1);
        expect(msgs[0].mes).toBe('First ever message');
    });

    test('appendMessage handles file that does not end with a newline', async () => {
        // Simulate ST's join('\\n') save format — no trailing newline
        const charDir = path.join(tmpDir, 'Frog');
        const filePath = path.join(charDir, 'initial.jsonl');
        const existing = fs.readFileSync(filePath, 'utf8').trimEnd();
        fs.writeFileSync(filePath, existing); // strip trailing newline

        const msg = chatHistory.constructStMessage({ role: 'assistant', content: 'After no-newline' });
        await chatHistory.appendMessage('Frog', msg, tmpDir);

        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        expect(lines.length).toBe(3); // 2 original + 1 appended
        // every line must be valid JSON on its own
        expect(() => lines.forEach(l => JSON.parse(l))).not.toThrow();
    });

    test('buildExternalChatContent returns plain string when no images', () => {
        const result = chatHistory.buildExternalChatContent('Hello there', []);
        expect(result).toBe('Hello there');
    });

    test('buildExternalChatContent returns multimodal array when images present', () => {
        const result = chatHistory.buildExternalChatContent('Look at this', ['http://example.com/img.png']);
        expect(result).toEqual([
            { type: 'text', text: 'Look at this' },
            { type: 'image_url', image_url: { url: 'http://example.com/img.png' } },
        ]);
    });

    test('appendExternalChatToHistory appends user and assistant entries to existing file', async () => {
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Hey Frog', images: [], user_id: 'discord:123' },
            'Hello back',
            tmpDir,
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(msgs.length).toBe(4); // 2 original + user + assistant
        const user = msgs[2];
        const assistant = msgs[3];
        expect(user.is_user).toBe(true);
        expect(user.mes).toBe('Hey Frog');
        expect(user.user_id).toBe('discord:123');
        expect(assistant.is_user).toBe(false);
        expect(assistant.mes).toBe('Hello back');
        expect(assistant.name).toBe('Frog');
    });

    test('appendExternalChatToHistory uses ExternalChat as name when no user_name provided', async () => {
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Hello', images: [], user_id: 'discord:123' },
            'Hi',
            tmpDir,
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(msgs[2].name).toBe('ExternalChat');
    });

    test('appendExternalChatToHistory builds display name from user_name and channel', async () => {
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Hello', images: [], user_id: 'discord:123', user_name: 'Josh', channel: 'discord' },
            'Hi',
            tmpDir,
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(msgs[2].name).toBe('Josh (Discord)');
    });

    test('appendExternalChatToHistory uses user_name alone when no channel provided', async () => {
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Hello', images: [], user_id: 'discord:123', user_name: 'Josh' },
            'Hi',
            tmpDir,
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(msgs[2].name).toBe('Josh');
    });

    test('appendExternalChatToHistory sets force_avatar when user_avatar provided', async () => {
        const avatarUrl = 'https://cdn.discordapp.com/avatars/123/abc.png';
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Hello', images: [], user_id: 'discord:123', user_avatar: avatarUrl },
            'Hi',
            tmpDir,
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(msgs[2].force_avatar).toBe(avatarUrl);
    });

    test('appendExternalChatToHistory bootstraps a new file with ST header when no chat exists', async () => {
        await chatHistory.appendExternalChatToHistory(
            'FreshChar',
            { message: 'First message', images: [], user_id: null },
            'First response',
            tmpDir,
        );
        const msgs = await chatHistory.readLatestChat('FreshChar', tmpDir);
        // header entry + user entry + assistant entry
        expect(msgs.length).toBe(3);
        expect(msgs[0].chat_metadata).toBeDefined();
        expect(msgs[1].is_user).toBe(true);
        expect(msgs[2].is_user).toBe(false);
    });

    test('appendExternalChatToHistory stores exchange_id in both written entries', async () => {
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Hey', images: [], user_id: 'discord:123' },
            'Hello back',
            tmpDir,
            null,
            'test-exchange-abc'
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        expect(msgs[2].exchange_id).toBe('test-exchange-abc');
        expect(msgs[3].exchange_id).toBe('test-exchange-abc');
    });

    test('appendExternalChatToHistory skips duplicate write when exchange_id already written (R3.3)', async () => {
        const exchangeId = 'dedup-xyz';
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Once', images: [], user_id: 'discord:1' },
            'Response once',
            tmpDir,
            null,
            exchangeId
        );
        // Retry with the same exchange_id — should be a no-op
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Once', images: [], user_id: 'discord:1' },
            'Response once',
            tmpDir,
            null,
            exchangeId
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        // 2 original + 1 user + 1 assistant = 4; NOT 6
        expect(msgs.length).toBe(4);
    });

    test('appendExternalChatToHistory skips write when exchange_id found in partial state (R3.2 recovery)', async () => {
        const exchangeId = 'partial-scenario';
        // Simulate: user entry was written (e.g. crash happened after user write, before assistant write)
        const partialUser = chatHistory.constructStMessage({
            role: 'user', content: 'Partial', name: 'ExternalChat', exchange_id: exchangeId,
        });
        await chatHistory.appendMessage('Frog', partialUser, tmpDir);

        // Retry — the exchange_id is already in the file, so the whole write is skipped
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'Partial', images: [], user_id: null },
            'Should not appear',
            tmpDir,
            null,
            exchangeId
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        // 2 original + 1 partial user only — assistant entry was NOT added again
        expect(msgs.length).toBe(3);
        expect(msgs[2].mes).toBe('Partial');
        expect(msgs[2].is_user).toBe(true);
    });

    test('appendExternalChatToHistory without exchangeId writes normally on every call', async () => {
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'No dedup', images: [], user_id: 'discord:1' },
            'Response',
            tmpDir,
        );
        await chatHistory.appendExternalChatToHistory(
            'Frog',
            { message: 'No dedup', images: [], user_id: 'discord:1' },
            'Response',
            tmpDir,
        );
        const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
        // No exchange_id means no dedup — both writes go through: 2 + 2 + 2 = 6
        expect(msgs.length).toBe(6);
    });
});
