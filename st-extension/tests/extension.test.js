const fs = require('fs');
const path = require('path');

test('st-extension index.js exists', () => {
    const p = path.join(__dirname, '..', 'index.js');
    expect(fs.existsSync(p)).toBe(true);
});

// Pure copy of the function under test — avoids importing browser globals.
function stripInstructTemplate(text) {
    if (!text || typeof text !== 'string') return text;

    let s = text;

    const chatMlAssistant = s.lastIndexOf('<|im_start|>assistant');
    if (chatMlAssistant !== -1) {
        const afterNewline = s.indexOf('\n', chatMlAssistant);
        s = afterNewline !== -1 ? s.slice(afterNewline + 1) : s.slice(chatMlAssistant + 21);
    }

    const llama3Header = s.lastIndexOf('<|start_header_id|>assistant<|end_header_id|>');
    if (llama3Header !== -1) {
        const afterHeader = s.indexOf('\n\n', llama3Header);
        s = afterHeader !== -1 ? s.slice(afterHeader + 2) : s.slice(llama3Header + 45);
    }

    const lastInstClose = s.lastIndexOf('[/INST]');
    if (lastInstClose !== -1) {
        s = s.slice(lastInstClose + 7);
    }

    const alpacaAssistant = s.lastIndexOf('### Assistant:');
    if (alpacaAssistant !== -1) {
        const afterNewline = s.indexOf('\n', alpacaAssistant);
        s = afterNewline !== -1 ? s.slice(afterNewline + 1) : s.slice(alpacaAssistant + 14);
    }

    s = s.replace(/<\|im_end\|>/g, '')
         .replace(/<\|im_start\|>/g, '')
         .replace(/<\|endoftext\|>/g, '')
         .replace(/<\|eot_id\|>/g, '')
         .replace(/<\/s>/g, '')
         .replace(/^<s>/g, '');

    return s.trim();
}

describe('stripInstructTemplate', () => {
    it('passes through clean text unchanged', () => {
        expect(stripInstructTemplate('Hello there!')).toBe('Hello there!');
    });

    it('handles null/undefined gracefully', () => {
        expect(stripInstructTemplate(null)).toBeNull();
        expect(stripInstructTemplate(undefined)).toBeUndefined();
        expect(stripInstructTemplate('')).toBe('');
    });

    it('strips ChatML assistant block', () => {
        const raw = '<|im_start|>user\nHi<|im_end|>\n<|im_start|>assistant\nHello from the model<|im_end|>';
        expect(stripInstructTemplate(raw)).toBe('Hello from the model');
    });

    it('strips ChatML with only assistant block', () => {
        const raw = '<|im_start|>assistant\nJust the reply<|im_end|>';
        expect(stripInstructTemplate(raw)).toBe('Just the reply');
    });

    it('strips stray im_end token', () => {
        expect(stripInstructTemplate('Clean text<|im_end|>')).toBe('Clean text');
    });

    it('strips Llama 3 assistant header', () => {
        const raw = '<|start_header_id|>assistant<|end_header_id|>\n\nHere is my answer<|eot_id|>';
        expect(stripInstructTemplate(raw)).toBe('Here is my answer');
    });

    it('strips Mistral/Llama instruct [/INST]', () => {
        const raw = '[INST] Say hello [/INST] Hello world';
        expect(stripInstructTemplate(raw)).toBe('Hello world');
    });

    it('strips multi-turn Mistral instruct taking last response', () => {
        const raw = '[INST] First [/INST] First reply [INST] Second [/INST] Second reply';
        expect(stripInstructTemplate(raw)).toBe('Second reply');
    });

    it('strips Alpaca ### Assistant: prefix', () => {
        const raw = '### Human: Hi\n### Assistant:\nNice to meet you';
        expect(stripInstructTemplate(raw)).toBe('Nice to meet you');
    });

    it('strips BOS/EOS tokens', () => {
        expect(stripInstructTemplate('<s>Hello</s>')).toBe('Hello');
        expect(stripInstructTemplate('<s>Hello')).toBe('Hello');
        expect(stripInstructTemplate('Hello</s>')).toBe('Hello');
    });

    it('strips <|endoftext|>', () => {
        expect(stripInstructTemplate('Done talking<|endoftext|>')).toBe('Done talking');
    });

    it('trims surrounding whitespace', () => {
        expect(stripInstructTemplate('  hello  ')).toBe('hello');
    });

    it('preserves newlines inside the response body', () => {
        const raw = '<|im_start|>assistant\nLine one\nLine two<|im_end|>';
        expect(stripInstructTemplate(raw)).toBe('Line one\nLine two');
    });
});
