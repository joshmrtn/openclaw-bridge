"use strict";

// Unit tests for the formatOutboundText logic (R6).
// The actual implementation lives in oc-plugin/src/index.ts; these tests
// verify the algorithm in isolation so they run under the existing Jest config.

function formatOutboundText(text, channelId, linkEntry) {
    const channelType = channelId.split("-")[0];
    let strip;
    if (linkEntry.formatting?.strip_asterisk_markup !== undefined) {
        strip = linkEntry.formatting.strip_asterisk_markup;
    } else {
        strip = channelType === "telegram";
    }
    if (!strip) return text;

    const lines = text.split("\n");
    const processed = lines
        .filter(line => !/^\s*\|[-:\s|]+\|\s*$/.test(line))
        .map(line => {
            if (/^\s*\|/.test(line) && /\|\s*$/.test(line.trim())) {
                return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
                    .split("|").map(c => c.trim()).filter(Boolean).join(" | ");
            }
            const hMatch = line.match(/^#{1,6}\s+(.*)/);
            if (hMatch) return hMatch[1];
            const bqMatch = line.match(/^>\s?(.*)/);
            if (bqMatch) return bqMatch[1];
            return line;
        });

    return processed
        .join("\n")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .replace(/\*([^*\n]+)\*/g, "$1")
        .replace(/_([^_\n]+)_/g, "$1")
        .replace(/ {2,}/g, " ")
        .trim();
}

const discordEntry = { oc_agent_id: "bot", active: true, owner_user_ids: [] };
const telegramEntry = { oc_agent_id: "bot", active: true, owner_user_ids: [] };
const explicitOnEntry = { oc_agent_id: "bot", active: true, owner_user_ids: [], formatting: { strip_asterisk_markup: true } };
const explicitOffEntry = { oc_agent_id: "bot", active: true, owner_user_ids: [], formatting: { strip_asterisk_markup: false } };

describe("formatOutboundText", () => {
    describe("Discord (default off)", () => {
        it("passes text through unchanged", () => {
            expect(formatOutboundText("Hello *world*", "discord-mybot", discordEntry)).toBe("Hello *world*");
        });

        it("passes plain text unchanged", () => {
            expect(formatOutboundText("Hello there", "discord-mybot", discordEntry)).toBe("Hello there");
        });
    });

    describe("Telegram (default on)", () => {
        it("strips asterisk markup", () => {
            expect(formatOutboundText("*Frog claps his hands* Hello!", "telegram-mybot", telegramEntry)).toBe("Frog claps his hands Hello!");
        });

        it("strips multiple asterisk spans", () => {
            expect(formatOutboundText("*waves* Hi! *sits down*", "telegram-mybot", telegramEntry)).toBe("waves Hi! sits down");
        });

        it("preserves inner text (semantic content not dropped)", () => {
            const result = formatOutboundText("*runs quickly* toward you", "telegram-mybot", telegramEntry);
            expect(result).toContain("runs quickly");
        });

        it("collapses extra spaces and trims", () => {
            const result = formatOutboundText("  *action*  text  ", "telegram-mybot", telegramEntry);
            expect(result).toBe("action text");
        });

        it("does not strip across newlines", () => {
            const input = "*line one\nline two*";
            expect(formatOutboundText(input, "telegram-mybot", telegramEntry)).toBe(input);
        });
    });

    describe("Explicit toggle overrides channel default", () => {
        it("Discord with strip_asterisk_markup:true — strips", () => {
            expect(formatOutboundText("*waves* hello", "discord-mybot", explicitOnEntry)).toBe("waves hello");
        });

        it("Telegram with strip_asterisk_markup:false — passes through", () => {
            expect(formatOutboundText("*waves* hello", "telegram-mybot", explicitOffEntry)).toBe("*waves* hello");
        });
    });

    describe("Bold markup (**text**)", () => {
        it("strips double-asterisk bold on Telegram", () => {
            expect(formatOutboundText("**Important!** Hello.", "telegram-mybot", telegramEntry)).toBe("Important! Hello.");
        });

        it("passes double-asterisk bold through on Discord", () => {
            expect(formatOutboundText("**Important!** Hello.", "discord-mybot", discordEntry)).toBe("**Important!** Hello.");
        });

        it("strips bold before italic to avoid partial match on ***text***", () => {
            expect(formatOutboundText("***both***", "telegram-mybot", telegramEntry)).toBe("both");
        });
    });

    describe("Underscore italic (_text_)", () => {
        it("strips underscore italic on Telegram", () => {
            expect(formatOutboundText("_quietly_ steps forward.", "telegram-mybot", telegramEntry)).toBe("quietly steps forward.");
        });

        it("passes underscore italic through on Discord", () => {
            expect(formatOutboundText("_quietly_ steps forward.", "discord-mybot", discordEntry)).toBe("_quietly_ steps forward.");
        });

        it("does not strip across newlines", () => {
            const input = "_line one\nline two_";
            expect(formatOutboundText(input, "telegram-mybot", telegramEntry)).toBe(input);
        });
    });

    describe("Edge cases", () => {
        it("empty string", () => {
            expect(formatOutboundText("", "telegram-mybot", telegramEntry)).toBe("");
        });

        it("no asterisks — unchanged", () => {
            expect(formatOutboundText("Just plain text.", "telegram-mybot", telegramEntry)).toBe("Just plain text.");
        });

        it("unpaired asterisk — unchanged", () => {
            expect(formatOutboundText("hello * there", "telegram-mybot", telegramEntry)).toBe("hello * there");
        });
    });

    describe("Headers (R6.4)", () => {
        it("strips h1 marker on Telegram", () => {
            expect(formatOutboundText("# Hello", "telegram-mybot", telegramEntry)).toBe("Hello");
        });

        it("strips h2 marker on Telegram", () => {
            expect(formatOutboundText("## Section Title", "telegram-mybot", telegramEntry)).toBe("Section Title");
        });

        it("strips h3 marker on Telegram", () => {
            expect(formatOutboundText("### Sub-section", "telegram-mybot", telegramEntry)).toBe("Sub-section");
        });

        it("passes headers through on Discord", () => {
            expect(formatOutboundText("# Hello", "discord-mybot", discordEntry)).toBe("# Hello");
        });

        it("preserves header content after stripping", () => {
            const result = formatOutboundText("## Frog's Thoughts\nHello there.", "telegram-mybot", telegramEntry);
            expect(result).toContain("Frog's Thoughts");
            expect(result).toContain("Hello there.");
        });
    });

    describe("Blockquotes (R6.4)", () => {
        it("strips blockquote marker on Telegram", () => {
            expect(formatOutboundText("> inner monologue", "telegram-mybot", telegramEntry)).toBe("inner monologue");
        });

        it("strips blockquote marker without space", () => {
            expect(formatOutboundText(">inner monologue", "telegram-mybot", telegramEntry)).toBe("inner monologue");
        });

        it("passes blockquotes through on Discord", () => {
            expect(formatOutboundText("> inner monologue", "discord-mybot", discordEntry)).toBe("> inner monologue");
        });

        it("preserves blockquote content after stripping", () => {
            const result = formatOutboundText("> I wonder about this.", "telegram-mybot", telegramEntry);
            expect(result).toContain("I wonder about this.");
        });
    });

    describe("Markdown links (R6.4)", () => {
        it("strips link keeping display text on Telegram", () => {
            expect(formatOutboundText("[click here](http://example.com)", "telegram-mybot", telegramEntry)).toBe("click here");
        });

        it("strips link in the middle of a sentence", () => {
            const result = formatOutboundText("Check out [this page](http://example.com) now.", "telegram-mybot", telegramEntry);
            expect(result).toBe("Check out this page now.");
        });

        it("passes links through on Discord", () => {
            expect(formatOutboundText("[click here](http://example.com)", "discord-mybot", discordEntry)).toBe("[click here](http://example.com)");
        });
    });

    describe("Tables (R6.4)", () => {
        it("strips separator row entirely on Telegram", () => {
            const result = formatOutboundText("|---|---|", "telegram-mybot", telegramEntry);
            expect(result).toBe("");
        });

        it("strips aligned separator row", () => {
            const result = formatOutboundText("| :--- | ---: |", "telegram-mybot", telegramEntry);
            expect(result).toBe("");
        });

        it("converts data row to pipe-separated text", () => {
            const result = formatOutboundText("| foo | bar |", "telegram-mybot", telegramEntry);
            expect(result).toBe("foo | bar");
        });

        it("converts full table preserving data content", () => {
            const table = "| Name | Value |\n|------|-------|\n| Frog | 42 |";
            const result = formatOutboundText(table, "telegram-mybot", telegramEntry);
            expect(result).toContain("Name | Value");
            expect(result).toContain("Frog | 42");
            expect(result).not.toContain("------");
        });

        it("passes tables through on Discord", () => {
            const row = "| foo | bar |";
            expect(formatOutboundText(row, "discord-mybot", discordEntry)).toBe(row);
        });
    });
});
