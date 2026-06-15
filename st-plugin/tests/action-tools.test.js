'use strict';

const { ACTION_TOOLS, ST_SIDE_TOOLS, buildActionPrompt, parseActionBlocks } = require('../action-tools');

describe('ACTION_TOOLS registry', () => {
    test('is a non-empty array', () => {
        expect(Array.isArray(ACTION_TOOLS)).toBe(true);
        expect(ACTION_TOOLS.length).toBeGreaterThan(0);
    });

    test('every entry has required fields with correct types', () => {
        for (const tool of ACTION_TOOLS) {
            expect(typeof tool.type).toBe('string');
            expect(tool.type.length).toBeGreaterThan(0);
            expect(typeof tool.description).toBe('string');
            expect(tool.description.length).toBeGreaterThan(0);
            expect(Array.isArray(tool.parameters)).toBe(true);
            for (const param of tool.parameters) {
                expect(typeof param.name).toBe('string');
                expect(param.name.length).toBeGreaterThan(0);
                expect(typeof param.description).toBe('string');
                expect(param.description.length).toBeGreaterThan(0);
            }
        }
    });

    test('contains the four expected action types', () => {
        const types = ACTION_TOOLS.map(t => t.type);
        expect(types).toContain('discord_post');
        expect(types).toContain('discord_dm');
        expect(types).toContain('telegram_post');
        expect(types).toContain('file_write');
    });
});

describe('ST_SIDE_TOOLS registry', () => {
    test('is a non-empty array', () => {
        expect(Array.isArray(ST_SIDE_TOOLS)).toBe(true);
        expect(ST_SIDE_TOOLS.length).toBeGreaterThan(0);
    });

    test('every entry has required fields with correct types', () => {
        for (const tool of ST_SIDE_TOOLS) {
            expect(typeof tool.type).toBe('string');
            expect(tool.type.length).toBeGreaterThan(0);
            expect(typeof tool.description).toBe('string');
            expect(tool.description.length).toBeGreaterThan(0);
            expect(Array.isArray(tool.parameters)).toBe(true);
            for (const param of tool.parameters) {
                expect(typeof param.name).toBe('string');
                expect(param.name.length).toBeGreaterThan(0);
                expect(typeof param.description).toBe('string');
                expect(param.description.length).toBeGreaterThan(0);
            }
        }
    });

    test('contains write_memory', () => {
        const types = ST_SIDE_TOOLS.map(t => t.type);
        expect(types).toContain('write_memory');
    });

    test('write_memory has entry_key, content, and tier parameters', () => {
        const tool = ST_SIDE_TOOLS.find(t => t.type === 'write_memory');
        expect(tool).toBeDefined();
        const paramNames = tool.parameters.map(p => p.name);
        expect(paramNames).toContain('entry_key');
        expect(paramNames).toContain('content');
        expect(paramNames).toContain('tier');
    });

    test('ST_SIDE_TOOLS and ACTION_TOOLS have no overlapping types', () => {
        const ocTypes = new Set(ACTION_TOOLS.map(t => t.type));
        for (const tool of ST_SIDE_TOOLS) {
            expect(ocTypes.has(tool.type)).toBe(false);
        }
    });
});

describe('buildActionPrompt', () => {
    test('returns empty string for empty array', () => {
        expect(buildActionPrompt([])).toBe('');
    });

    test('returns empty string for null/undefined', () => {
        expect(buildActionPrompt(null)).toBe('');
        expect(buildActionPrompt(undefined)).toBe('');
    });

    test('output is wrapped in --- delimiters', () => {
        const prompt = buildActionPrompt(ACTION_TOOLS);
        const lines = prompt.split('\n');
        expect(lines[0]).toBe('---');
        expect(lines[lines.length - 1]).toBe('---');
    });

    test('output contains each tool type and description', () => {
        const prompt = buildActionPrompt(ACTION_TOOLS);
        for (const tool of ACTION_TOOLS) {
            expect(prompt).toContain(tool.type);
            expect(prompt).toContain(tool.description);
        }
    });

    test('output contains a valid <action> example for each tool', () => {
        const prompt = buildActionPrompt(ACTION_TOOLS);
        for (const tool of ACTION_TOOLS) {
            // Each tool should have an example block that parses as valid JSON
            const blockRe = new RegExp(`<action>(\\{[^}]*"type":"${tool.type}"[^}]*\\})<\\/action>`);
            const match = blockRe.exec(prompt);
            expect(match).not.toBeNull();
            const parsed = JSON.parse(match[1]);
            expect(parsed.type).toBe(tool.type);
            // All parameter names should appear as keys
            for (const param of tool.parameters) {
                expect(parsed).toHaveProperty(param.name);
            }
        }
    });

    test('works with a single custom tool', () => {
        const tools = [{
            type: 'test_action',
            description: 'A test action',
            parameters: [{ name: 'foo', description: 'The foo param' }],
        }];
        const prompt = buildActionPrompt(tools);
        expect(prompt).toContain('test_action');
        expect(prompt).toContain('A test action');
        expect(prompt).toContain('<action>');
        const parsed = JSON.parse(prompt.match(/<action>(.+?)<\/action>/)[1]);
        expect(parsed.type).toBe('test_action');
        expect(parsed).toHaveProperty('foo');
    });

    test('combined ACTION_TOOLS + ST_SIDE_TOOLS produces a single prompt with all types', () => {
        const combined = [...ACTION_TOOLS, ...ST_SIDE_TOOLS];
        const prompt = buildActionPrompt(combined);
        for (const tool of combined) {
            expect(prompt).toContain(tool.type);
            expect(prompt).toContain(tool.description);
        }
        // Only one --- header and one --- footer
        const lines = prompt.split('\n');
        expect(lines[0]).toBe('---');
        expect(lines[lines.length - 1]).toBe('---');
        // write_memory should appear in the combined output
        expect(prompt).toContain('write_memory');
        expect(prompt).toContain('discord_post');
    });
});

describe('parseActionBlocks', () => {
    test('empty string returns empty actions and empty text', () => {
        const result = parseActionBlocks('');
        expect(result.actions).toEqual([]);
        expect(result.text).toBe('');
    });

    test('text with no blocks returns original text unchanged', () => {
        const input = 'Hello, I am Frog. Ribbit!';
        const result = parseActionBlocks(input);
        expect(result.actions).toEqual([]);
        expect(result.text).toBe(input);
    });

    test('one valid block is parsed and stripped from text', () => {
        const input = 'Sure! <action>{"type":"discord_post","channel_id":"123","content":"Hi"}</action>';
        const result = parseActionBlocks(input);
        expect(result.actions).toEqual([{ type: 'discord_post', channel_id: '123', content: 'Hi' }]);
        expect(result.text).toBe('Sure!');
        expect(result.text).not.toContain('<action>');
    });

    test('multiple blocks are all parsed and stripped', () => {
        const input = 'Doing stuff <action>{"type":"discord_post","channel_id":"1","content":"A"}</action> and also <action>{"type":"discord_dm","user_id":"u1","content":"B"}</action>';
        const result = parseActionBlocks(input);
        expect(result.actions).toHaveLength(2);
        expect(result.actions[0].type).toBe('discord_post');
        expect(result.actions[1].type).toBe('discord_dm');
        expect(result.text).not.toContain('<action>');
        expect(result.text).toContain('Doing stuff');
        expect(result.text).toContain('and also');
    });

    test('malformed JSON inside block is skipped with warning; block is still stripped', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const input = 'Hello <action>NOT_JSON</action> world';
        const result = parseActionBlocks(input);
        expect(result.actions).toEqual([]);
        expect(result.text).not.toContain('<action>');
        expect(result.text).toContain('Hello');
        expect(result.text).toContain('world');
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('block mid-sentence preserves surrounding text', () => {
        const input = 'I will post a message.<action>{"type":"discord_post","channel_id":"c","content":"Hi"}</action> Done.';
        const result = parseActionBlocks(input);
        expect(result.text).toContain('I will post a message.');
        expect(result.text).toContain('Done.');
        expect(result.text).not.toContain('<action>');
    });

    test('block with unknown type is included (executeCharacterActions handles defaults)', () => {
        const input = '<action>{"type":"future_action","param":"value"}</action>';
        const result = parseActionBlocks(input);
        expect(result.actions).toEqual([{ type: 'future_action', param: 'value' }]);
    });

    test('block with JSON missing type field is skipped with warning', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const input = '<action>{"channel_id":"123","content":"Hi"}</action>';
        const result = parseActionBlocks(input);
        expect(result.actions).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('multiline JSON body in block is parsed correctly', () => {
        const input = '<action>{\n  "type": "file_write",\n  "path": "out.txt",\n  "content": "hello"\n}</action>';
        const result = parseActionBlocks(input);
        expect(result.actions).toEqual([{ type: 'file_write', path: 'out.txt', content: 'hello' }]);
    });
});
