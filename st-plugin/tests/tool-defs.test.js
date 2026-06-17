'use strict';

const { ACTION_TOOL_DEFS, ST_SIDE_TOOL_DEFS } = require('../../shared/tool-defs');

function assertDefShape(def) {
    expect(typeof def.type).toBe('string');
    expect(def.type.length).toBeGreaterThan(0);
    expect(typeof def.displayName).toBe('string');
    expect(def.displayName.length).toBeGreaterThan(0);
    expect(typeof def.description).toBe('string');
    expect(def.description.length).toBeGreaterThan(0);
    expect(Array.isArray(def.parameters)).toBe(true);
    for (const p of def.parameters) {
        expect(typeof p.name).toBe('string');
        expect(p.name.length).toBeGreaterThan(0);
        expect(typeof p.type).toBe('string');
        expect(p.type.length).toBeGreaterThan(0);
        expect(typeof p.description).toBe('string');
        expect(p.description.length).toBeGreaterThan(0);
        expect(typeof p.required).toBe('boolean');
    }
}

describe('ACTION_TOOL_DEFS', () => {
    test('is a non-empty array', () => {
        expect(Array.isArray(ACTION_TOOL_DEFS)).toBe(true);
        expect(ACTION_TOOL_DEFS.length).toBeGreaterThan(0);
    });

    test('every entry has required fields with correct types', () => {
        for (const def of ACTION_TOOL_DEFS) {
            assertDefShape(def);
        }
    });

    test('contains send_message and file_write; no old platform-specific tools', () => {
        const types = ACTION_TOOL_DEFS.map(d => d.type);
        expect(types).toContain('send_message');
        expect(types).toContain('file_write');
        expect(types).not.toContain('discord_post');
        expect(types).not.toContain('discord_dm');
        expect(types).not.toContain('telegram_post');
    });

    test('send_message has channel (required), content (required), recipient (optional)', () => {
        const def = ACTION_TOOL_DEFS.find(d => d.type === 'send_message');
        expect(def).toBeDefined();
        const byName = Object.fromEntries(def.parameters.map(p => [p.name, p]));
        expect(byName.channel?.required).toBe(true);
        expect(byName.content?.required).toBe(true);
        expect(byName.recipient?.required).toBe(false);
    });
});

describe('ST_SIDE_TOOL_DEFS', () => {
    test('is a non-empty array', () => {
        expect(Array.isArray(ST_SIDE_TOOL_DEFS)).toBe(true);
        expect(ST_SIDE_TOOL_DEFS.length).toBeGreaterThan(0);
    });

    test('every entry has required fields with correct types', () => {
        for (const def of ST_SIDE_TOOL_DEFS) {
            assertDefShape(def);
        }
    });

    test('contains write_memory', () => {
        const types = ST_SIDE_TOOL_DEFS.map(d => d.type);
        expect(types).toContain('write_memory');
    });

    test('write_memory has entry_key and content (required); tier and keywords (optional)', () => {
        const def = ST_SIDE_TOOL_DEFS.find(d => d.type === 'write_memory');
        expect(def).toBeDefined();
        const byName = Object.fromEntries(def.parameters.map(p => [p.name, p]));
        expect(byName.entry_key?.required).toBe(true);
        expect(byName.content?.required).toBe(true);
        expect(byName.tier?.required).toBe(false);
        expect(byName.keywords?.required).toBe(false);
    });

    test('no type overlaps with ACTION_TOOL_DEFS', () => {
        const ocTypes = new Set(ACTION_TOOL_DEFS.map(d => d.type));
        for (const def of ST_SIDE_TOOL_DEFS) {
            expect(ocTypes.has(def.type)).toBe(false);
        }
    });
});
