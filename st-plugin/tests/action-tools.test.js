'use strict';

const { ACTION_TOOLS, ST_SIDE_TOOLS, buildActionPrompt, parseActionBlocks, isToolEnabled } = require('../action-tools');

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

    test('contains send_message and file_write; does not contain old platform-specific tools (#59)', () => {
        const types = ACTION_TOOLS.map(t => t.type);
        expect(types).toContain('send_message');
        expect(types).toContain('file_write');
        expect(types).not.toContain('discord_post');
        expect(types).not.toContain('discord_dm');
        expect(types).not.toContain('telegram_post');
    });

    test('send_message has channel, content, and recipient parameters (#59)', () => {
        const tool = ACTION_TOOLS.find(t => t.type === 'send_message');
        expect(tool).toBeDefined();
        const paramNames = tool.parameters.map(p => p.name);
        expect(paramNames).toContain('channel');
        expect(paramNames).toContain('content');
        expect(paramNames).toContain('recipient');
    });

    test('send_message and file_write use shared definitions — old platform-specific tools absent (#59)', () => {
        const types = ACTION_TOOLS.map(t => t.type);
        expect(types).not.toContain('discord_post');
        expect(types).not.toContain('discord_dm');
        expect(types).not.toContain('telegram_post');
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

    test('write_memory has entry_key, content, tier, and keywords parameters (#84)', () => {
        const tool = ST_SIDE_TOOLS.find(t => t.type === 'write_memory');
        expect(tool).toBeDefined();
        const paramNames = tool.parameters.map(p => p.name);
        expect(paramNames).toContain('entry_key');
        expect(paramNames).toContain('content');
        expect(paramNames).toContain('tier');
        expect(paramNames).toContain('keywords');
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

    test('lists configured channel names in the send_message block (#234)', () => {
        const prompt = buildActionPrompt(ACTION_TOOLS, { channels: ['discord', 'telegram'] });
        expect(prompt).toContain('Configured channels');
        expect(prompt).toContain('discord');
        expect(prompt).toContain('telegram');
    });

    test('send_message example uses a real configured channel name when provided (#234)', () => {
        const prompt = buildActionPrompt(ACTION_TOOLS, { channels: ['discord', 'telegram'] });
        const blockRe = /<action>(\{[^}]*"type":"send_message"[^}]*\})<\/action>/;
        const match = blockRe.exec(prompt);
        expect(match).not.toBeNull();
        const parsed = JSON.parse(match[1]);
        expect(parsed.channel).toBe('discord');
    });

    test('warns when no channels are configured (#234)', () => {
        const prompt = buildActionPrompt(ACTION_TOOLS, { channels: [] });
        expect(prompt).toMatch(/No channels are configured/i);
        // No channel-name list line in this case
        expect(prompt).not.toContain('Configured channels:');
    });

    test('no-options call still works and warns (no channels) (#234)', () => {
        const prompt = buildActionPrompt(ACTION_TOOLS);
        expect(prompt).toContain('send_message');
        expect(prompt).toMatch(/No channels are configured/i);
        // Backward-compatible example with the generic placeholder
        const blockRe = /<action>(\{[^}]*"type":"send_message"[^}]*\})<\/action>/;
        const parsed = JSON.parse(blockRe.exec(prompt)[1]);
        expect(parsed.channel).toBe('CHANNEL');
    });

    test('only the send_message block carries the channels line, not other tools (#234)', () => {
        const prompt = buildActionPrompt([...ACTION_TOOLS, ...ST_SIDE_TOOLS], { channels: ['discord'] });
        const lines = prompt.split('\n');
        const channelLineIdx = lines.findIndex(l => l.includes('Configured channels'));
        expect(channelLineIdx).toBeGreaterThan(-1);
        // The channels line must sit within the send_message block — i.e. after the
        // send_message header and before the next tool header (file_write/write_memory).
        const sendIdx = lines.findIndex(l => l.startsWith('send_message —'));
        const fileWriteIdx = lines.findIndex(l => l.startsWith('file_write —'));
        expect(channelLineIdx).toBeGreaterThan(sendIdx);
        expect(channelLineIdx).toBeLessThan(fileWriteIdx);
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
        // write_memory and send_message should appear in the combined output
        expect(prompt).toContain('write_memory');
        expect(prompt).toContain('send_message');
    });
});

describe('tool description disambiguation (#268)', () => {
    test('file_write description steers journaling away from write_memory', () => {
        const tool = ACTION_TOOLS.find(t => t.type === 'file_write');
        expect(tool).toBeDefined();
        expect(tool.description.toLowerCase()).toContain('journal');
    });

    test('write_memory description warns against journaling and points to file_write', () => {
        const tool = ST_SIDE_TOOLS.find(t => t.type === 'write_memory');
        expect(tool).toBeDefined();
        expect(tool.description.toLowerCase()).toContain('do not use this for journaling');
        expect(tool.description).toContain('file_write');
    });

    test('buildActionPrompt surfaces the disambiguation to the OC path', () => {
        const prompt = buildActionPrompt([...ACTION_TOOLS, ...ST_SIDE_TOOLS]).toLowerCase();
        expect(prompt).toContain('journal');
        expect(prompt).toContain('do not use this for journaling');
    });
});

describe('read_file tool (#265)', () => {
    test('read_file is an OC-path action tool with a path parameter', () => {
        const tool = ACTION_TOOLS.find(t => t.type === 'read_file');
        expect(tool).toBeDefined();
        const paramNames = tool.parameters.map(p => p.name);
        expect(paramNames).toContain('path');
    });

    test('read_file description sets the next-turn expectation', () => {
        const tool = ACTION_TOOLS.find(t => t.type === 'read_file');
        expect(tool.description.toLowerCase()).toContain('next');
    });

    test('read_file appears in the OC-path prompt', () => {
        const prompt = buildActionPrompt(ACTION_TOOLS);
        expect(prompt).toContain('read_file');
    });
});

describe('isToolEnabled — per-character allowlist (#264)', () => {
    test('default ON: enabled when the link has no tools field', () => {
        expect(isToolEnabled(null, 'write_memory')).toBe(true);
        expect(isToolEnabled({}, 'write_memory')).toBe(true);
        expect(isToolEnabled({ tools: {} }, 'write_memory')).toBe(true);
    });

    test('a tool is disabled ONLY when explicitly set to false', () => {
        expect(isToolEnabled({ tools: { write_memory: false } }, 'write_memory')).toBe(false);
    });

    test('explicit true is enabled', () => {
        expect(isToolEnabled({ tools: { write_memory: true } }, 'write_memory')).toBe(true);
    });

    test('disabling one tool does not affect others', () => {
        const link = { tools: { write_memory: false } };
        expect(isToolEnabled(link, 'write_memory')).toBe(false);
        expect(isToolEnabled(link, 'send_message')).toBe(true);
        expect(isToolEnabled(link, 'file_write')).toBe(true);
        expect(isToolEnabled(link, 'read_file')).toBe(true);
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

    test('block at very start of text is parsed and stripped; trailing text preserved (#195)', () => {
        const input = '<action>{"type":"discord_post","channel_id":"c","content":"Hi"}</action> Response text here.';
        const result = parseActionBlocks(input);
        expect(result.actions).toEqual([{ type: 'discord_post', channel_id: 'c', content: 'Hi' }]);
        expect(result.text).toBe('Response text here.');
        expect(result.text).not.toContain('<action>');
    });

    test('block at very end of text is parsed and stripped; leading text preserved (#195)', () => {
        const input = 'Response text here. <action>{"type":"discord_post","channel_id":"c","content":"Hi"}</action>';
        const result = parseActionBlocks(input);
        expect(result.actions).toEqual([{ type: 'discord_post', channel_id: 'c', content: 'Hi' }]);
        expect(result.text).toBe('Response text here.');
        expect(result.text).not.toContain('<action>');
    });

    test('block with unicode and special characters in content is parsed correctly (#195)', () => {
        const content = 'Héllo wörld 🐸 — "quoted" & <escaped>';
        const input = `<action>{"type":"send_message","channel":"qa","content":${JSON.stringify(content)}}</action>`;
        const result = parseActionBlocks(input);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0].content).toBe(content);
        expect(result.text).toBe('');
        expect(result.text).not.toContain('<action>');
    });
});
