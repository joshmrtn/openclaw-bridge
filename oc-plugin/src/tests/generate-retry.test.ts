import { vi, describe, it, expect } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
    definePluginEntry: vi.fn(() => ({})),
}));

import {
    isTransientGenerateStatus,
    parseBackoffSchedule,
    generateWithRetry,
    buildUnavailableText,
    decideInboundDelivery,
} from "../index.ts";

describe("isTransientGenerateStatus", () => {
    it("treats 429/502/503/504 as transient", () => {
        for (const s of [429, 502, 503, 504]) {
            expect(isTransientGenerateStatus(s)).toBe(true);
        }
    });
    it("treats 200 and deterministic 4xx/5xx as non-transient", () => {
        for (const s of [200, 400, 401, 404, 500]) {
            expect(isTransientGenerateStatus(s)).toBe(false);
        }
    });
});

describe("parseBackoffSchedule", () => {
    it("parses a comma-separated list of positive ms values", () => {
        expect(parseBackoffSchedule("1000,3000")).toEqual([1000, 3000]);
    });
    it("falls back to the default when unset, empty, or invalid", () => {
        expect(parseBackoffSchedule(undefined)).toEqual([1000, 3000]);
        expect(parseBackoffSchedule("")).toEqual([1000, 3000]);
        expect(parseBackoffSchedule("abc")).toEqual([1000, 3000]);
    });
    it("drops non-positive entries", () => {
        expect(parseBackoffSchedule("0,500,-1,2000")).toEqual([500, 2000]);
    });
});

describe("generateWithRetry", () => {
    const noSleep = vi.fn(async () => {});

    it("returns immediately on 200 without retrying", async () => {
        const post = vi.fn(async () => ({ status: 200, body: { response: "hi" } }));
        const sleep = vi.fn(async () => {});
        const res = await generateWithRetry(post, { schedule: [1000, 3000], sleep });
        expect(res.status).toBe(200);
        expect(post).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it("retries a transient status then succeeds, sleeping per the schedule", async () => {
        let n = 0;
        const post = vi.fn(async () => (++n < 2 ? { status: 503, body: {} } : { status: 200, body: { response: "ok" } }));
        const sleep = vi.fn(async () => {});
        const res = await generateWithRetry(post, { schedule: [1000, 3000], sleep });
        expect(res.status).toBe(200);
        expect(post).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(1000);
    });

    it("exhausts the schedule on persistent transient failure and returns the last result", async () => {
        const post = vi.fn(async () => ({ status: 503, body: { error: "busy" } }));
        const sleep = vi.fn(async () => {});
        const res = await generateWithRetry(post, { schedule: [1000, 3000], sleep });
        expect(res.status).toBe(503);
        expect(post).toHaveBeenCalledTimes(3); // initial + 2 retries
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("does not retry a non-transient failure", async () => {
        const post = vi.fn(async () => ({ status: 400, body: { error: "bad" } }));
        const sleep = vi.fn(async () => {});
        const res = await generateWithRetry(post, { schedule: [1000, 3000], sleep });
        expect(res.status).toBe(400);
        expect(post).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it("retries a thrown error then succeeds", async () => {
        let n = 0;
        const post = vi.fn(async () => {
            if (++n < 2) throw new Error("ECONNRESET");
            return { status: 200, body: { response: "ok" } };
        });
        const res = await generateWithRetry(post, { schedule: [1000, 3000], sleep: noSleep });
        expect(res.status).toBe(200);
        expect(post).toHaveBeenCalledTimes(2);
    });

    it("returns a synthetic status 0 result when every attempt throws", async () => {
        const post = vi.fn(async () => { throw new Error("ETIMEDOUT"); });
        const res = await generateWithRetry(post, { schedule: [1000, 3000], sleep: noSleep });
        expect(res.status).toBe(0);
        expect(post).toHaveBeenCalledTimes(3);
        expect(String(res.body?.error ?? "")).toContain("ETIMEDOUT");
    });
});

describe("buildUnavailableText", () => {
    it("uses the link's fallback_message verbatim when set", () => {
        expect(buildUnavailableText("Frog", 503, { fallback_message: "brb!" })).toBe("brb!");
    });
    it("builds a default message naming the character and status code", () => {
        const t = buildUnavailableText("Frog", 503, {});
        expect(t).toContain("Frog");
        expect(t).toContain("503");
    });
    it("uses connection wording for a network failure (status 0)", () => {
        const t = buildUnavailableText("Frog", 0, {});
        expect(t).toContain("Frog");
        expect(t.toLowerCase()).toContain("connection");
        expect(t).not.toContain("error 0");
    });
});

describe("decideInboundDelivery", () => {
    it("delivers a reply on 200 with non-empty response", () => {
        const d = decideInboundDelivery({ status: 200, body: { response: "hello" } }, "Frog", {});
        expect(d).toEqual({ kind: "reply", text: "hello" });
    });
    it("stays silent on 200 with empty/missing response", () => {
        expect(decideInboundDelivery({ status: 200, body: { response: "" } }, "Frog", {})).toEqual({ kind: "silent" });
        expect(decideInboundDelivery({ status: 200, body: {} }, "Frog", {})).toEqual({ kind: "silent" });
    });
    it("returns an unavailable message on a transient failure", () => {
        const d = decideInboundDelivery({ status: 503, body: {} }, "Frog", {});
        expect(d.kind).toBe("unavailable");
        expect((d as any).text).toContain("503");
    });
    it("returns an unavailable message on a non-transient failure", () => {
        const d = decideInboundDelivery({ status: 400, body: {} }, "Frog", {});
        expect(d.kind).toBe("unavailable");
    });
    it("returns an unavailable message on a network failure (status 0)", () => {
        const d = decideInboundDelivery({ status: 0, body: { error: "x" } }, "Frog", {});
        expect(d.kind).toBe("unavailable");
    });
});
