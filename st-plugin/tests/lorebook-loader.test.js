const fs = require('fs');
const path = require('path');
const os = require('os');

const lore = require('../lorebook-loader');

describe('lorebook-loader', () => {
    let tmpDir;
    const fixtureDir = path.join(__dirname, 'fixtures', 'lorebooks');

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-test-'));
        // copy fixture tree into tmpDir
        const target = path.join(tmpDir);
        fs.mkdirSync(target, { recursive: true });
        // copy character dir
        const srcChar = path.join(fixtureDir, 'Gerard');
        const dstChar = path.join(target, 'Gerard');
        fs.mkdirSync(dstChar, { recursive: true });
        fs.copyFileSync(path.join(srcChar, 'lorebook.json'), path.join(dstChar, 'lorebook.json'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns matched entries for message (two matches)', async () => {
        const matches = await lore.matchLorebookEntries('hello there, I like tea', 'Gerard', { baseDir: tmpDir });
        // should match e2 (hello) and e1 (tea) in insertion order
        expect(matches.length).toBeGreaterThanOrEqual(2);
        const ids = matches.map(m => m.id);
        expect(ids).toEqual(expect.arrayContaining(['e2','e1']));
    });

    test('case-insensitive matching works', async () => {
        const matches = await lore.matchLorebookEntries('HELLO', 'Gerard', { baseDir: tmpDir });
        expect(matches.some(m => m.id === 'e2' || m.id === 'e4')).toBe(true);
    });

    test('no match returns empty array', async () => {
        const matches = await lore.matchLorebookEntries('xyz-nomatch', 'Gerard', { baseDir: tmpDir });
        expect(Array.isArray(matches)).toBe(true);
        expect(matches.length).toBe(0);
    });

    test('malformed file is skipped gracefully', async () => {
        // create malformed file
        const badDir = path.join(tmpDir, 'Bad');
        fs.mkdirSync(badDir);
        fs.writeFileSync(path.join(badDir, 'lorebook.json'), '{ this is : not json');
        const matches = await lore.matchLorebookEntries('anything', 'Bad', { baseDir: tmpDir });
        expect(Array.isArray(matches)).toBe(true);
        expect(matches.length).toBe(0);
    });
});
