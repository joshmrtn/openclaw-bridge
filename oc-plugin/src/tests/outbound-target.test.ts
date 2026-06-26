import { vi, describe, it, expect } from "vitest";

// Mock the OC SDK — it is not present in node_modules; the real implementation
// is injected at runtime by the OpenClaw host process.
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
    definePluginEntry: vi.fn(() => ({})),
}));

import { resolveSendTarget, buildOutboundTarget } from "../index.ts";

describe("resolveSendTarget (#250)", () => {
    it("prefers ctx.channelId over the action's configured channel_id", () => {
        // The original #250 bug: a stale configured "discord-frog" matched no adapter.
        expect(
            resolveSendTarget({ channel_id: "discord-frog", target: "user:1" }, { channelId: "discord" })
        ).toEqual({ channelId: "discord", to: "user:1" });
    });

    it("falls back to action.channel_id when ctx has no channelId", () => {
        expect(
            resolveSendTarget({ channel_id: "discord", target: "channel:9" }, {})
        ).toEqual({ channelId: "discord", to: "channel:9" });
    });

    it("uses a fully-formed recipient override as the target when present", () => {
        expect(
            resolveSendTarget(
                { channel_id: "discord", target: "user:1", recipient: "channel:42" },
                { channelId: "discord" }
            )
        ).toEqual({ channelId: "discord", to: "channel:42" });
    });

    it("returns empty strings when nothing is provided", () => {
        expect(resolveSendTarget({}, {})).toEqual({ channelId: "", to: "" });
    });
});

describe("buildOutboundTarget (#250)", () => {
    it("builds a DM target (user:<id>) for kind=dm", () => {
        expect(buildOutboundTarget("dm", "1509676499979079794")).toBe("user:1509676499979079794");
    });

    it("builds a channel target (channel:<id>) for kind=channel", () => {
        expect(buildOutboundTarget("channel", "444555666")).toBe("channel:444555666");
    });

    it("defaults to a channel target when kind is missing (back-compat)", () => {
        expect(buildOutboundTarget(undefined, "444555666")).toBe("channel:444555666");
    });

    it("is idempotent for an already-prefixed id", () => {
        expect(buildOutboundTarget("dm", "user:1")).toBe("user:1");
        expect(buildOutboundTarget("channel", "channel:9")).toBe("channel:9");
    });

    it("returns empty string for a missing/blank id", () => {
        expect(buildOutboundTarget("dm", undefined)).toBe("");
        expect(buildOutboundTarget("channel", "  ")).toBe("");
    });
});
