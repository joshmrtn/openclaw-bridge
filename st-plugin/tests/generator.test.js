const fs = require('fs');
const path = require('path');
const os = require('os');

const gen = require('../generator');
const chatHistory = require('../chat-history');

describe('generator (mock)', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-test-'));
        // create characters dir and place a simple character fixture
        const chars = path.join(tmpDir, 'characters');
        fs.mkdirSync(chars, { recursive: true });
        const sample = { name: 'Gerard', description: 'Gerard is warm and likes tea.' };
        fs.writeFileSync(path.join(chars, 'Gerard.json'), JSON.stringify(sample));

        // lorebooks (no-op here; lore is handled by ST Generate in the extension)
        const loreDir = path.join(tmpDir, 'lorebooks', 'Gerard');
        fs.mkdirSync(loreDir, { recursive: true });

        // chats
        const chats = path.join(tmpDir, 'chats', 'Gerard');
        fs.mkdirSync(chats, { recursive: true });
        fs.writeFileSync(path.join(chats, 'initial.jsonl'), '{"role":"user","content":"Hi"}\n');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('assembleMessages includes system, lore, history, and incoming', async () => {
        const assembled = await gen.assembleMessages('Gerard', 'Do you like tea?', { charDir: path.join(tmpDir, 'characters'), loreDir: path.join(tmpDir, 'lorebooks'), chatsDir: path.join(tmpDir, 'chats') });
        expect(Array.isArray(assembled)).toBe(true);
        expect(assembled[0].role).toBe('system');
        const contents = assembled.map(m => m.content).join(' ');
        expect(contents).toMatch(/Gerard is warm/);
        // lore is injected by ST Generate; plugin no longer includes lorebook text here
        expect(contents).toMatch(/Hi/);
        expect(assembled[assembled.length - 1].content).toMatch(/tea\?/);
    });

    test('assembleMessages passes through images as multimodal content', async () => {
        const assembled = await gen.assembleMessages('Gerard', 'Look at this', {
            charDir: path.join(tmpDir, 'characters'),
            loreDir: path.join(tmpDir, 'lorebooks'),
            chatsDir: path.join(tmpDir, 'chats'),
            images: ['data:image/jpeg;base64,abc123'],
        });

        const last = assembled[assembled.length - 1];
        expect(last.role).toBe('user');
        expect(Array.isArray(last.content)).toBe(true);
        expect(last.content[0]).toEqual({ type: 'text', text: 'Look at this' });
        expect(last.content[1]).toEqual({
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,abc123' },
        });
    });

    test('generate appends incoming and mock response to chat history', async () => {
        const opts = { charDir: path.join(tmpDir, 'characters'), loreDir: path.join(tmpDir, 'lorebooks'), chatsDir: path.join(tmpDir, 'chats') };
        const result = await gen.generate('Gerard', 'Do you like tea?', opts);
        expect(result.response).toBe('[MOCK RESPONSE]');

        const msgs = await chatHistory.readLatestChat('Gerard', opts.chatsDir);
        const last = msgs.slice(-2);
        expect(last[0].mes).toBe('Do you like tea?');
        expect(last[1].mes).toBe('[MOCK RESPONSE]');
    });

    test('generate preserves multimodal incoming content in chat history', async () => {
        const opts = {
            charDir: path.join(tmpDir, 'characters'),
            loreDir: path.join(tmpDir, 'lorebooks'),
            chatsDir: path.join(tmpDir, 'chats'),
            images: ['data:image/jpeg;base64,abc123'],
        };

        await gen.generate('Gerard', 'Look at this', opts);

        const msgs = await chatHistory.readLatestChat('Gerard', opts.chatsDir);
        const last = msgs.slice(-2);
        expect(Array.isArray(last[0].mes)).toBe(true);
        expect(last[0].mes[0]).toEqual({ type: 'text', text: 'Look at this' });
        expect(last[0].mes[1]).toEqual({
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,abc123' },
        });
        expect(last[1].mes).toBe('[MOCK RESPONSE]');
    });
});
