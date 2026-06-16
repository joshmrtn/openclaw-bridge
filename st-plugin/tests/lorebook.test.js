const fs = require('fs');
const os = require('os');
const path = require('path');
const { upsertMemoryEntry, readLorebook, lorebookPath, AUTO_MEMORY_PREFIX } = require('../lorebook');

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-lorebook-test-'));
}

describe('lorebook', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = makeTmpDir();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('creates a new lorebook file with a Tier 1 always-active entry (R11.1, R11.4)', () => {
        const result = upsertMemoryEntry('Frog', { entry_key: 'core_facts', content: 'Josh: software engineer' }, tmpDir);

        expect(result.created).toBe(true);
        expect(result.tier).toBe(1);
        expect(result.entry_key).toBe('core_facts');

        const book = readLorebook('Frog', tmpDir);
        expect(book).not.toBeNull();
        const entries = Object.values(book.entries);
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        expect(entry.content).toBe('Josh: software engineer');
        expect(entry.constant).toBe(true); // always-active = no keyword match needed
        expect(entry.comment).toBe(`${AUTO_MEMORY_PREFIX}::core_facts`);
        expect(entry.extensions['openclaw-bridge'].entry_key).toBe('core_facts');
        expect(entry.extensions['openclaw-bridge'].tier).toBe(1);
    });

    test('updates an existing entry in place without appending duplicates (R11.2)', () => {
        upsertMemoryEntry('Frog', { entry_key: 'core_facts', content: 'First version' }, tmpDir);
        const result = upsertMemoryEntry('Frog', { entry_key: 'core_facts', content: 'Updated version' }, tmpDir);

        expect(result.created).toBe(false);

        const book = readLorebook('Frog', tmpDir);
        const entries = Object.values(book.entries);
        expect(entries).toHaveLength(1); // no duplicate
        expect(entries[0].content).toBe('Updated version');
    });

    test('creates Tier 2 keyword-triggered entry with correct fields', () => {
        upsertMemoryEntry('Frog', {
            entry_key: 'conversation_bridge',
            content: 'Josh talked about the bridge project',
            tier: 2,
            keywords: 'bridge, openclaw, project',
        }, tmpDir);

        const book = readLorebook('Frog', tmpDir);
        const entry = Object.values(book.entries)[0];
        expect(entry.constant).toBe(false); // keyword-triggered
        expect(entry.key).toEqual(['bridge', 'openclaw', 'project']);
        expect(entry.extensions['openclaw-bridge'].tier).toBe(2);
    });

    test('multiple entries get distinct UIDs', () => {
        upsertMemoryEntry('Frog', { entry_key: 'core_facts', content: 'fact 1' }, tmpDir);
        upsertMemoryEntry('Frog', { entry_key: 'episode_one', content: 'episode 1', tier: 2, keywords: 'test' }, tmpDir);

        const book = readLorebook('Frog', tmpDir);
        const uids = Object.values(book.entries).map(e => e.uid);
        expect(new Set(uids).size).toBe(2);
    });

    test('does not modify entries without the openclaw-bridge marker (R11.3)', () => {
        const filePath = lorebookPath('Frog', tmpDir);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Simulate a manually-authored lorebook entry (no openclaw-bridge marker)
        const authorEntry = {
            uid: 0,
            comment: 'Author-written entry about frogs',
            content: 'Original author content',
            constant: false,
            key: ['frog'],
            extensions: {},
        };
        fs.writeFileSync(filePath, JSON.stringify({ entries: { '0': authorEntry } }), 'utf8');

        // Write an auto-memory entry — should NOT touch uid 0
        upsertMemoryEntry('Frog', { entry_key: 'core_facts', content: 'auto memory' }, tmpDir);

        const book = readLorebook('Frog', tmpDir);
        const entries = Object.entries(book.entries);
        expect(entries).toHaveLength(2);

        const preserved = book.entries['0'];
        expect(preserved.content).toBe('Original author content'); // unchanged
        expect(preserved.comment).toBe('Author-written entry about frogs'); // unchanged
    });

    test('readLorebook returns null when file does not exist', () => {
        const result = readLorebook('NonExistent', tmpDir);
        expect(result).toBeNull();
    });

    test('throws when entry_key is missing', () => {
        expect(() => upsertMemoryEntry('Frog', { content: 'test' }, tmpDir)).toThrow('entry_key and content are required');
    });

    test('lorebookPath sanitizes special characters in character name', () => {
        const p = path.basename(lorebookPath('Char/With:Special*Chars', tmpDir));
        expect(p).not.toMatch(/[/:*?"<>|]/);
    });

    test('comment substring match does not claim an author entry — check is exact equality (R11.3)', () => {
        const filePath = lorebookPath('Frog', tmpDir);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Author entry whose comment CONTAINS the prefix pattern but is not an exact match —
        // the kind of comment that a loose substring check would incorrectly claim.
        const authorEntry = {
            uid: 0,
            comment: `see ${AUTO_MEMORY_PREFIX}::frogs for details`,
            content: 'Author content — must not be overwritten',
            constant: false,
            key: [],
            extensions: {},
        };
        fs.writeFileSync(filePath, JSON.stringify({ entries: { '0': authorEntry } }), 'utf8');

        upsertMemoryEntry('Frog', { entry_key: 'frogs', content: 'auto memory content' }, tmpDir);

        const book = readLorebook('Frog', tmpDir);
        // Author entry must be completely untouched
        expect(book.entries['0'].content).toBe('Author content — must not be overwritten');
        expect(book.entries['0'].comment).toBe(`see ${AUTO_MEMORY_PREFIX}::frogs for details`);
        // A new auto-memory entry must have been created separately with the exact prefix format
        const autoEntry = Object.values(book.entries).find(
            e => e?.extensions?.['openclaw-bridge']?.entry_key === 'frogs',
        );
        expect(autoEntry).toBeDefined();
        expect(autoEntry.comment).toBe(`${AUTO_MEMORY_PREFIX}::frogs`);
        expect(autoEntry.content).toBe('auto memory content');
    });
});
