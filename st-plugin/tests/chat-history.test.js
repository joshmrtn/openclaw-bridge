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
        const charDir = path.join(tmpDir, 'Gerard');
        fs.mkdirSync(charDir, { recursive: true });
        fs.copyFileSync(sampleFile, path.join(charDir, 'initial.jsonl'));
    });

    afterEach(() => {
        // remove tmpDir recursively
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('readLatestChat returns messages array', async () => {
        const msgs = await chatHistory.readLatestChat('Gerard', tmpDir);
        expect(Array.isArray(msgs)).toBe(true);
        expect(msgs.length).toBe(2);
        expect(msgs[0].role).toBe('user');
        expect(msgs[1].role).toBe('assistant');
    });

    test('appendMessage appends and readLatestChat reflects it', async () => {
        const newMsg = chatHistory.constructStMessage({ role: 'assistant', content: 'Mock reply' });
        await chatHistory.appendMessage('Gerard', newMsg, tmpDir);
        const msgs = await chatHistory.readLatestChat('Gerard', tmpDir);
        expect(msgs.length).toBe(3);
        expect(msgs[2].content).toBe('Mock reply');
    });

    test('concurrent appends do not corrupt file', async () => {
        const writers = [];
        for (let i = 0; i < 10; i++) {
            const m = chatHistory.constructStMessage({ role: 'assistant', content: `C${i}` });
            writers.push(chatHistory.appendMessage('Gerard', m, tmpDir));
        }
        await Promise.all(writers);
        const msgs = await chatHistory.readLatestChat('Gerard', tmpDir);
        expect(msgs.length).toBe(12); // 2 original + 10 appended
        const contents = msgs.slice(2).map(m => m.content);
        for (let i = 0; i < 10; i++) expect(contents).toContain(`C${i}`);
    });
});
