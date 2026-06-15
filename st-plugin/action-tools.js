'use strict';

const ACTION_TOOLS = [
    {
        type: 'discord_post',
        description: 'Post a message to a Discord channel or thread',
        parameters: [
            { name: 'channel_id', description: 'The Discord channel ID or name to post to' },
            { name: 'content', description: 'The message text to post' },
        ],
    },
    {
        type: 'discord_dm',
        description: 'Send a direct message to a specific Discord user',
        parameters: [
            { name: 'user_id', description: 'The Discord user ID to send the DM to' },
            { name: 'content', description: 'The message text to send' },
        ],
    },
    {
        type: 'telegram_post',
        description: 'Post a message to a Telegram chat or channel',
        parameters: [
            { name: 'channel_id', description: 'The Telegram chat ID to post to' },
            { name: 'content', description: 'The message text to post' },
        ],
    },
    {
        type: 'file_write',
        description: 'Write content to a file in your workspace',
        parameters: [
            { name: 'path', description: 'Relative file path within your workspace' },
            { name: 'content', description: 'The text content to write' },
        ],
    },
];

function buildActionPrompt(tools) {
    if (!tools || tools.length === 0) return '';
    const lines = [
        '---',
        'You may take outbound actions by including action blocks anywhere in your response.',
        'Action blocks are hidden from the conversation and executed automatically.',
        '',
        'Available actions:',
        '',
    ];
    for (const tool of tools) {
        lines.push(`${tool.type} — ${tool.description}`);
        const exampleParams = Object.fromEntries(
            tool.parameters.map(p => [p.name, p.name.toUpperCase()])
        );
        const example = JSON.stringify({ type: tool.type, ...exampleParams });
        lines.push(`  <action>${example}</action>`);
        lines.push('');
    }
    lines.push('---');
    return lines.join('\n');
}

const ST_SIDE_TOOLS = [
    {
        type: 'write_memory',
        description: "Write or update a persistent memory entry in this character's lorebook. " +
            "Use entry_key='core_facts' for the always-active Tier 1 memory (injected every generation — keep it concise). " +
            "Call this whenever the user shares information the character should remember permanently.",
        parameters: [
            { name: 'entry_key', description: "Unique identifier for this memory, e.g. 'core_facts' or 'user_prefs'" },
            { name: 'content', description: 'The memory content to store. For core_facts: one subject per line with comma-separated facts.' },
            { name: 'tier', description: 'Memory tier: 1 = always active (core facts), 2 = keyword-triggered recall' },
        ],
    },
];

const ACTION_BLOCK_RE = /<action>([\s\S]*?)<\/action>/g;

function parseActionBlocks(text) {
    const actions = [];
    const cleanText = text.replace(ACTION_BLOCK_RE, (_, json) => {
        try {
            const action = JSON.parse(json.trim());
            if (action && typeof action.type === 'string') {
                actions.push(action);
            } else {
                console.warn('[openclaw-bridge] <action> block missing type field, skipping');
            }
        } catch (e) {
            console.warn('[openclaw-bridge] Malformed <action> block, skipping:', e.message);
        }
        return '';
    }).trim();
    return { actions, text: cleanText };
}

module.exports = { ACTION_TOOLS, ST_SIDE_TOOLS, buildActionPrompt, parseActionBlocks };
