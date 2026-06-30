'use strict';

// Single source of truth for all bridge tool definitions.
// Plain JSON-serializable data — no browser globals.
// Consumed by action-tools.js (OC path) and st-extension/src/index.js (ST UI path).
//
// Parameter shape: { name, type, description, required }
// action-tools.js derives the OC-path array format from this.
// The extension derives the ST registerFunctionTool() format from this.

const ACTION_TOOL_DEFS = [
    {
        type: 'send_message',
        displayName: 'Send Message',
        description: "Send a message to a configured channel on behalf of this character. " +
            "Omit recipient to post to the channel's default target; include recipient to send a direct message to that user.",
        parameters: [
            { name: 'channel', type: 'string', description: 'Name of the configured channel to send on (e.g. "discord", "telegram").', required: true },
            { name: 'content', type: 'string', description: 'The message text to send.', required: true },
            { name: 'recipient', type: 'string', description: '(Optional) Platform user ID for direct messages. Omit to post to the configured channel target.', required: false },
        ],
    },
    {
        type: 'file_write',
        displayName: 'Write File',
        description: "Save freeform text to a file in your private workspace — journals, notes, drafts, " +
            "longer writing. Files are NOT injected into your prompt, so they don't bloat your context. " +
            "Use this (not write_memory) for diary or journal entries. Read them back later with read_file.",
        parameters: [
            { name: 'path', type: 'string', description: 'Relative file path within the workspace.', required: true },
            { name: 'content', type: 'string', description: 'The text content to write.', required: true },
        ],
    },
    {
        type: 'read_file',
        displayName: 'Read File',
        description: "Read back a file you previously saved with file_write (journals, notes, drafts). " +
            "The file content is added to your context on your NEXT message, not immediately — so reach for " +
            "it a turn before you need it, e.g. \"let me check my notes\".",
        parameters: [
            { name: 'path', type: 'string', description: 'Relative file path within the workspace to read.', required: true },
        ],
    },
];

const ST_SIDE_TOOL_DEFS = [
    {
        type: 'write_memory',
        displayName: 'Write Memory',
        description: "Store a SHORT, durable fact you must always recall (the user's name, key preferences). " +
            'Use entry_key="core_facts" for the always-active Tier 1 memory — it is injected into EVERY ' +
            'message, so keep it tiny. Use a descriptive key for Tier 2 episode memories that fire on keywords. ' +
            'Do NOT use this for journaling or long notes — use file_write for those. ' +
            'Updates the existing entry in place; never creates duplicates.',
        parameters: [
            { name: 'entry_key', type: 'string', description: 'Unique identifier for this memory, e.g. "core_facts" or "conversation_bridge_project".', required: true },
            { name: 'content', type: 'string', description: 'The memory content to store. For core_facts: one subject per line with comma-separated facts.', required: true },
            { name: 'tier', type: 'number', description: '1 = always injected (no keywords, default), 2 = keyword-triggered. Use 1 for core facts, 2 for episode memories.', required: false },
            { name: 'keywords', type: 'string', description: 'Comma-separated trigger keywords for tier 2 entries. Ignored for tier 1.', required: false },
        ],
    },
];

module.exports = { ACTION_TOOL_DEFS, ST_SIDE_TOOL_DEFS };
