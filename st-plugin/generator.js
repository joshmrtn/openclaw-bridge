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

async function assembleMessages(characterName, incomingText, opts = {}) {
    const charDir = opts.charDir;
    const loreDir = opts.loreDir;
    const chatsDir = opts.chatsDir;

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
    const incomingMsg = { role: 'user', content: incomingText };

    const assembled = [systemMsg, ...loreMsgs, ...historyMsgs, incomingMsg];
    return assembled;
}

async function generate(characterName, incomingText, opts = {}) {
    // assemble
    const assembled = await assembleMessages(characterName, incomingText, opts);

    // write incoming message to chat history
    const incomingSt = chatHistory.constructStMessage({ role: 'user', content: incomingText });
    await chatHistory.appendMessage(characterName, incomingSt, opts.chatsDir);

    // stubbed LLM response
    const responseText = '[MOCK RESPONSE]';
    const responseSt = chatHistory.constructStMessage({ role: 'assistant', content: responseText });
    await chatHistory.appendMessage(characterName, responseSt, opts.chatsDir);

    return { response: responseText, assembled };
}

module.exports = { assembleMessages, generate };
