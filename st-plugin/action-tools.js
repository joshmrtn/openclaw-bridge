'use strict';

const { ACTION_TOOL_DEFS, ST_SIDE_TOOL_DEFS } = require('../shared/tool-defs');

function _toOcPathFormat(defs) {
    return defs.map(def => ({
        type: def.type,
        description: def.description,
        parameters: def.parameters.map(p => ({ name: p.name, description: p.description })),
    }));
}

const ACTION_TOOLS = _toOcPathFormat(ACTION_TOOL_DEFS);

// options.channels — the character's configured channel names (#234). Surfaced in the
// send_message block so the model targets a valid channel instead of guessing a platform
// display name. send_message is the only channel-aware tool, so the listing is special-cased
// to its block; all other tools render unchanged.
function buildActionPrompt(tools, options = {}) {
    if (!tools || tools.length === 0) return '';
    const channels = Array.isArray(options.channels) ? options.channels.filter(Boolean) : [];
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
        // Make the send_message example directly copyable by using a real configured channel.
        if (tool.type === 'send_message' && channels.length > 0) {
            exampleParams.channel = channels[0];
        }
        const example = JSON.stringify({ type: tool.type, ...exampleParams });
        lines.push(`  <action>${example}</action>`);
        if (tool.type === 'send_message') {
            lines.push(channels.length > 0
                ? `  Configured channels: ${channels.join(', ')}. Use one of these exact names for the "channel" parameter.`
                : '  No channels are configured — send_message will fail until a channel is set up.');
        }
        lines.push('');
    }
    lines.push('---');
    return lines.join('\n');
}

const ST_SIDE_TOOLS = _toOcPathFormat(ST_SIDE_TOOL_DEFS);

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
