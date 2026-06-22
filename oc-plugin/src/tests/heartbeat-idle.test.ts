import { vi, describe, it, expect } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
    definePluginEntry: vi.fn(() => ({})),
}));

import { shouldFireIdleHeartbeat } from "../index.ts";

const BASE_TIME = 1_000_000;

describe("shouldFireIdleHeartbeat", () => {
    it("returns false when idle detection is disabled (idleMs = 0)", () => {
        const state = { lastMessageAt: BASE_TIME - 10_000, idleHeartbeatFiredAt: 0 };
        expect(shouldFireIdleHeartbeat(state, 0, BASE_TIME)).toBe(false);
    });

    it("returns false when the channel has been active within the threshold", () => {
        const state = { lastMessageAt: BASE_TIME - 500, idleHeartbeatFiredAt: 0 };
        expect(shouldFireIdleHeartbeat(state, 1000, BASE_TIME)).toBe(false);
    });

    it("returns true when quiet for longer than the threshold and not yet fired", () => {
        const state = { lastMessageAt: BASE_TIME - 5000, idleHeartbeatFiredAt: 0 };
        expect(shouldFireIdleHeartbeat(state, 1000, BASE_TIME)).toBe(true);
    });

    it("returns false after the idle heartbeat has already fired for this idle period", () => {
        // idleHeartbeatFiredAt is set to the time of the fire, which is >= lastMessageAt
        const firedAt = BASE_TIME - 1000;
        const state = { lastMessageAt: BASE_TIME - 5000, idleHeartbeatFiredAt: firedAt };
        expect(shouldFireIdleHeartbeat(state, 1000, BASE_TIME)).toBe(false);
    });

    it("returns true again after a new message resets lastMessageAt past idleHeartbeatFiredAt", () => {
        // A new message arrived after the idle heartbeat fired → a future idle period should re-trigger.
        const firedAt = BASE_TIME - 10_000;
        const newMessageAt = BASE_TIME - 6_000; // arrived after the fire
        const state = { lastMessageAt: newMessageAt, idleHeartbeatFiredAt: firedAt };
        // Now the channel is quiet again: now - newMessageAt = 6000 >= idleMs (5000)
        // and idleHeartbeatFiredAt(BASE-10k) < lastMessageAt(BASE-6k): should fire
        expect(shouldFireIdleHeartbeat(state, 5000, BASE_TIME)).toBe(true);
    });
});
