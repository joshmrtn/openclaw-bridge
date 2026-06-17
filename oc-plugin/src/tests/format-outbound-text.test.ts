import { vi, describe, it, expect } from "vitest";

// Mock the OC SDK — it is not present in node_modules; the real implementation
// is injected at runtime by the OpenClaw host process.
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
    definePluginEntry: vi.fn(() => ({})),
}));

import { formatOutboundText } from "../index.ts";

// linkEntry fixture that always enables markdown stripping regardless of channelId
const strippingEntry = {
    oc_agent_id: "test-agent",
    active: true,
    owner_user_ids: [],
    formatting: { strip_asterisk_markup: true },
};

// linkEntry fixture that disables stripping (control group)
const noStripEntry = {
    oc_agent_id: "test-agent",
    active: true,
    owner_user_ids: [],
    formatting: { strip_asterisk_markup: false },
};

const ch = "discord-testbot";

describe("formatOutboundText", () => {
    describe("pass-through when stripping is disabled", () => {
        it("returns text unchanged for non-telegram channel with no explicit config", () => {
            const text = "**bold** and _italic_";
            expect(formatOutboundText(text, ch, noStripEntry)).toBe(text);
        });

        it("strips for telegram channel with no explicit config", () => {
            expect(
                formatOutboundText("**hello**", "telegram-mybot", {
                    oc_agent_id: "a",
                    active: true,
                    owner_user_ids: [],
                }),
            ).toBe("hello");
        });
    });

    describe("inline markdown stripping", () => {
        it("removes bold markers", () => {
            expect(formatOutboundText("**bold text**", ch, strippingEntry)).toBe("bold text");
        });

        it("removes italic asterisk markers", () => {
            expect(formatOutboundText("*italic*", ch, strippingEntry)).toBe("italic");
        });

        it("removes italic underscore markers", () => {
            expect(formatOutboundText("_italic_", ch, strippingEntry)).toBe("italic");
        });

        it("removes markdown links", () => {
            expect(formatOutboundText("[click here](https://example.com)", ch, strippingEntry)).toBe("click here");
        });

        it("collapses double spaces", () => {
            expect(formatOutboundText("hello  world", ch, strippingEntry)).toBe("hello world");
        });
    });

    describe("block-level markdown stripping", () => {
        it("strips heading markers", () => {
            expect(formatOutboundText("## Hello", ch, strippingEntry)).toBe("Hello");
        });

        it("strips blockquotes", () => {
            expect(formatOutboundText("> quoted text", ch, strippingEntry)).toBe("quoted text");
        });

        it("removes table separator rows", () => {
            const input = "| Name | Age |\n|------|-----|\n| Frog | 3   |";
            const result = formatOutboundText(input, ch, strippingEntry);
            expect(result).not.toContain("|------|-----|");
            expect(result).toContain("Name | Age");
            expect(result).toContain("Frog | 3");
        });

        it("removes table separator rows with colons", () => {
            const sep = "| :--: | ---: |";
            const input = `| Col |\n${sep}\n| Val |`;
            const result = formatOutboundText(input, ch, strippingEntry);
            expect(result).not.toContain(sep);
        });

        it("formats table data rows into pipe-separated text", () => {
            const input = "| Frog | green | small |";
            expect(formatOutboundText(input, ch, strippingEntry)).toBe("Frog | green | small");
        });
    });

    describe("ReDoS safety", () => {
        it("handles a line of many pipes with no closing delimiter well within 100ms", () => {
            // Pathological for the original /^\s*\|[-:\s|]+\|\s*$/ pattern:
            // many pipe chars followed by a char outside the allowed set forces
            // the engine to try every split position before failing.
            const pathological = "|" + "|".repeat(5000) + "x";
            const input = `before\n${pathological}\nafter`;
            const start = performance.now();
            const result = formatOutboundText(input, ch, strippingEntry);
            const elapsed = performance.now() - start;
            expect(elapsed).toBeLessThan(100);
            // The long line is kept as-is (length > TABLE_LINE_MAX)
            expect(result).toContain(pathological);
        });

        it("handles many dashes with no closing pipe well within 100ms", () => {
            const pathological = "| " + "-".repeat(5000) + "a";
            const input = `before\n${pathological}\nafter`;
            const start = performance.now();
            formatOutboundText(input, ch, strippingEntry);
            expect(performance.now() - start).toBeLessThan(100);
        });

        it("passes long lines (> 500 chars) through without stripping table markup", () => {
            const longSep = "|" + "-".repeat(501) + "|";
            const result = formatOutboundText(longSep, ch, strippingEntry);
            expect(result).toBe(longSep);
        });
    });
});
