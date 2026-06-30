import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Mock the OC SDK — it is not present in node_modules; the real implementation
// is injected at runtime by the OpenClaw host process.
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
    definePluginEntry: vi.fn(() => ({})),
}));

import { resolveWorkspacePath, readWorkspaceFile } from "../index.ts";

describe("resolveWorkspacePath (#265)", () => {
    const root = "/home/u/.openclaw/characters/Frog/workspace";

    it("resolves a relative path inside the workspace", () => {
        const { target, escaped } = resolveWorkspacePath(root, "notes/journal.md");
        expect(target).toBe(`${root}/notes/journal.md`);
        expect(escaped).toBe(false);
    });

    it("flags a traversal escape", () => {
        expect(resolveWorkspacePath(root, "../../etc/passwd").escaped).toBe(true);
        expect(resolveWorkspacePath(root, "../sibling").escaped).toBe(true);
    });

    it("treats the workspace root itself as non-escaping", () => {
        expect(resolveWorkspacePath(root, "").escaped).toBe(false);
    });
});

describe("readWorkspaceFile (#265)", () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "oc-ws-"));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("reads back a previously written file", async () => {
        await writeFile(join(root, "journal.md"), "dear diary, found the cookies", "utf8");
        const { outcome, content } = await readWorkspaceFile(root, "journal.md");
        expect(outcome).toBe("read");
        expect(content).toContain("found the cookies");
    });

    it("blocks a path that escapes the workspace", async () => {
        const { outcome, content } = await readWorkspaceFile(root, "../../etc/passwd");
        expect(outcome).toBe("blocked");
        expect(content).toBeNull();
    });

    it("reports a missing file without throwing", async () => {
        const { outcome, content } = await readWorkspaceFile(root, "nope.md");
        expect(outcome).toBe("not found");
        expect(content).toBeNull();
    });

    it("truncates very large files", async () => {
        await mkdir(join(root, "sub"), { recursive: true });
        await writeFile(join(root, "sub", "big.txt"), "x".repeat(10000), "utf8");
        const { outcome, content } = await readWorkspaceFile(root, "sub/big.txt", 100);
        expect(outcome).toBe("read");
        expect(content!.length).toBeLessThan(200);
        expect(content).toContain("truncated");
    });
});
