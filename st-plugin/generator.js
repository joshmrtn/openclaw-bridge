const path = require('path');
const characterLoader = require('./character-loader');
const lore = require('./lorebook-loader');
const chatHistory = require('./chat-history');

async function _findCharacterMeta(name, charDir) {
    const list = await characterLoader.listCharacters(charDir);
    const found = list.find(c => {
        const base = require('path').parse(c.name).name;
        return base.toLowerCase() === name.toLowerCase();
    });
    if (!found) throw new Error('Character not found');
    return found.meta || {};
}

function _toStMessages(historyArray) {
    return historyArray.map(h => {
        const role = h.role || 'user';
        const content = h.content || (typeof h === 'string' ? h : JSON.stringify(h));
        return { role, content };
    });
}

function _buildIncomingContent(incomingText, images = []) {
    if (!Array.isArray(images) || images.length === 0) {
        return incomingText;
    }

    return [
        { type: 'text', text: incomingText },
        ...images.map(image => ({
            type: 'image_url',
            image_url: { url: image },
        })),
    ];
}

async function assembleMessages(characterName, incomingText, opts = {}) {
    const charDir = opts.charDir;
    const loreDir = opts.loreDir;
    const chatsDir = opts.chatsDir;
    const images = Array.isArray(opts.images) ? opts.images : [];

    const meta = await _findCharacterMeta(characterName, charDir);
    const charDescription = meta.description || meta.meta?.description || meta.name || '';

    // system prompt
    const systemMsg = { role: 'system', content: `Character: ${charDescription}` };

    // lorebook entries
    const matchedLore = await lore.matchLorebookEntries(incomingText, characterName, { baseDir: loreDir });
    const loreMsgs = matchedLore.map(e => ({ role: 'system', content: `Lore: ${e.text || e.content || ''}` }));

    // chat history
    const history = await chatHistory.readLatestChat(characterName, chatsDir);
    const historyMsgs = _toStMessages(history);

    // incoming message as the last user message
    const incomingMsg = { role: 'user', content: _buildIncomingContent(incomingText, images) };

    const assembled = [systemMsg, ...loreMsgs, ...historyMsgs, incomingMsg];
    return assembled;
}

async function generate(characterName, incomingText, opts = {}) {
    // assemble
    const assembled = await assembleMessages(characterName, incomingText, opts);
    const incomingContent = _buildIncomingContent(incomingText, Array.isArray(opts.images) ? opts.images : []);

    // write incoming message to chat history
    const incomingSt = chatHistory.constructStMessage({ role: 'user', content: incomingContent });
    await chatHistory.appendMessage(characterName, incomingSt, opts.chatsDir);

    // stubbed LLM response
    const responseText = '[MOCK RESPONSE]';
    const responseSt = chatHistory.constructStMessage({ role: 'assistant', content: responseText });
    await chatHistory.appendMessage(characterName, responseSt, opts.chatsDir);

    return { response: responseText, assembled };
}

module.exports = { assembleMessages, generate };
