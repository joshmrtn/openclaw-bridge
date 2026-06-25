import { vi, describe, it, expect } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
    definePluginEntry: vi.fn(() => ({})),
}));

import { extractSenderName, cacheSender, lookupSender } from "../index.ts";

describe("extractSenderName", () => {
    it("reads the name from event.metadata.senderName (message_received shape)", () => {
        expect(extractSenderName({ metadata: { senderName: "Josh" } })).toBe("Josh");
    });

    it("reads the name from a top-level event.senderName (inbound_claim shape)", () => {
        expect(extractSenderName({ senderName: "Josh" })).toBe("Josh");
    });

    it("prefers metadata.senderName over a top-level senderName", () => {
        expect(extractSenderName({ senderName: "old", metadata: { senderName: "new" } })).toBe("new");
    });

    it("returns null for whitespace-only names", () => {
        expect(extractSenderName({ metadata: { senderName: "   " } })).toBeNull();
    });

    it("returns null when no name is present", () => {
        expect(extractSenderName({ metadata: { senderId: "123" } })).toBeNull();
        expect(extractSenderName({})).toBeNull();
        expect(extractSenderName(null)).toBeNull();
    });

    it("returns null for non-string names", () => {
        expect(extractSenderName({ metadata: { senderName: 42 } })).toBeNull();
    });
});

describe("cacheSender / lookupSender", () => {
    it("round-trips a name under the channelId+senderId key", () => {
        const cache = new Map();
        cacheSender("discord-frog", "123", "Josh", { now: 1000, cache });
        expect(lookupSender("discord-frog", "123", cache)?.name).toBe("Josh");
    });

    it("misses when channelId or senderId differ (key is the pair)", () => {
        const cache = new Map();
        cacheSender("discord-frog", "123", "Josh", { now: 1000, cache });
        expect(lookupSender("discord-toad", "123", cache)).toBeNull();
        expect(lookupSender("discord-frog", "999", cache)).toBeNull();
    });

    it("returns null (no write) when channelId or senderId is missing", () => {
        const cache = new Map();
        expect(cacheSender(undefined, "123", "Josh", { cache })).toBeNull();
        expect(cacheSender("discord-frog", undefined, "Josh", { cache })).toBeNull();
        expect(cache.size).toBe(0);
    });

    it("preserves an existing avatar when a later call refreshes only the name", () => {
        const cache = new Map();
        cacheSender("discord-frog", "123", "Josh", { avatarUrl: "http://a/x.png", now: 1, cache });
        cacheSender("discord-frog", "123", "Joshua", { now: 2, cache });
        const entry = lookupSender("discord-frog", "123", cache);
        expect(entry?.name).toBe("Joshua");
        expect(entry?.avatarUrl).toBe("http://a/x.png");
    });

    it("preserves an existing name when a later call fills only the avatar", () => {
        const cache = new Map();
        cacheSender("discord-frog", "123", "Josh", { now: 1, cache });
        cacheSender("discord-frog", "123", null, { avatarUrl: "http://a/x.png", now: 2, cache });
        const entry = lookupSender("discord-frog", "123", cache);
        expect(entry?.name).toBe("Josh");
        expect(entry?.avatarUrl).toBe("http://a/x.png");
    });

    it("lookupSender returns null for missing ids", () => {
        const cache = new Map();
        expect(lookupSender(undefined, "123", cache)).toBeNull();
        expect(lookupSender("discord-frog", undefined, cache)).toBeNull();
    });
});
