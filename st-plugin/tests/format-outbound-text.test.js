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
    return text
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
});
