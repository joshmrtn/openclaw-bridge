const fs = require('fs');
const os = require('os');
const path = require('path');

describe('link-state', () => {
    let tmpDir;
    let previousPath;

    beforeEach(() => {
        jest.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-link-state-'));
        previousPath = process.env.OPENCLAW_BRIDGE_LINKS_PATH;
        process.env.OPENCLAW_BRIDGE_LINKS_PATH = path.join(tmpDir, 'character-links.json');
    });

    afterEach(() => {
        if (previousPath === undefined) {
            delete process.env.OPENCLAW_BRIDGE_LINKS_PATH;
        } else {
            process.env.OPENCLAW_BRIDGE_LINKS_PATH = previousPath;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('upsert creates and reads link state', async () => {
        const linkState = require('../link-state');

        const written = await linkState.upsertLink('Frog', {
            oc_agent_id: 'frog',
            active: true,
        });

        expect(written).toEqual({
            oc_agent_id: 'frog',
            active: true,
            owner_user_ids: [],
        });
        expect(linkState.getLink('Frog')).toEqual({
            oc_agent_id: 'frog',
            active: true,
            owner_user_ids: [],
        });
    });

    test('remove deletes existing links', async () => {
        const linkState = require('../link-state');

        await linkState.upsertLink('Frog', {
            oc_agent_id: 'frog',
            active: true,
        });

        expect(await linkState.removeLink('Frog')).toBe(true);
        expect(linkState.getLink('Frog')).toBeNull();
    });

    test('upsertLink stores heartbeat config and getLink returns it (#32)', async () => {
        const linkState = require('../link-state');

        const hb = { enabled: true, channel_id: 'discord-bot', interval_ms: 3600000 };
        const written = await linkState.upsertLink('Frog', {
            oc_agent_id: 'frog',
            active: true,
            heartbeat: hb,
        });

        expect(written.heartbeat).toEqual(hb);
        expect(linkState.getLink('Frog').heartbeat).toEqual(hb);
    });

    test('upsertLink without heartbeat field preserves existing heartbeat config (#32)', async () => {
        const linkState = require('../link-state');

        const hb = { enabled: true, channel_id: 'discord-bot', interval_ms: 3600000 };
        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: true, heartbeat: hb });

        // Second upsert — no heartbeat field in patch
        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: false });

        const link = linkState.getLink('Frog');
        expect(link.active).toBe(false);
        expect(link.heartbeat).toEqual(hb);
    });

    test('upsertLink with heartbeat: null removes existing heartbeat config (#32)', async () => {
        const linkState = require('../link-state');

        await linkState.upsertLink('Frog', {
            oc_agent_id: 'frog',
            active: true,
            heartbeat: { enabled: true, channel_id: 'discord-bot' },
        });

        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', heartbeat: null });

        const link = linkState.getLink('Frog');
        expect(link.heartbeat).toBeUndefined();
    });

    test('upsertLink stores channels and getLink returns them (#59)', async () => {
        const linkState = require('../link-state');

        const channels = [
            { name: 'discord', channel_id: 'discord-frog', target: '111222333' },
        ];
        const written = await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: true, channels });

        expect(written.channels).toEqual(channels);
        expect(linkState.getLink('Frog').channels).toEqual(channels);
    });

    test('upsertLink without channels field preserves existing channels (#59)', async () => {
        const linkState = require('../link-state');

        const channels = [{ name: 'discord', channel_id: 'discord-frog', target: '111' }];
        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: true, channels });

        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: false });

        const link = linkState.getLink('Frog');
        expect(link.active).toBe(false);
        expect(link.channels).toEqual(channels);
    });

    test('upsertLink with channels: null removes channels (#59)', async () => {
        const linkState = require('../link-state');

        await linkState.upsertLink('Frog', {
            oc_agent_id: 'frog',
            active: true,
            channels: [{ name: 'discord', channel_id: 'discord-frog', target: '111' }],
        });

        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', channels: null });

        const link = linkState.getLink('Frog');
        expect(link.channels).toBeUndefined();
    });

    test('getLink returns undefined channels when none configured (#59)', async () => {
        const linkState = require('../link-state');

        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: true });

        const link = linkState.getLink('Frog');
        expect(link.channels).toBeUndefined();
    });

    test('concurrent upsertLink calls for different characters both survive (#80)', async () => {
        const linkState = require('../link-state');

        await Promise.all([
            linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: true }),
            linkState.upsertLink('Toad', { oc_agent_id: 'toad', active: true }),
        ]);

        expect(linkState.getLink('Frog')).toMatchObject({ oc_agent_id: 'frog' });
        expect(linkState.getLink('Toad')).toMatchObject({ oc_agent_id: 'toad' });
    });

    test('concurrent upsertLink then removeLink both complete without corruption (#80)', async () => {
        const linkState = require('../link-state');

        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: true });
        await linkState.upsertLink('Toad', { oc_agent_id: 'toad', active: true });

        await Promise.all([
            linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: false }),
            linkState.removeLink('Toad'),
        ]);

        expect(linkState.getLink('Frog')).toMatchObject({ active: false });
        expect(linkState.getLink('Toad')).toBeNull();
    });

    test('writeState leaves no .tmp file after successful write (#124)', async () => {
        const linkState = require('../link-state');
        const linksPath = process.env.OPENCLAW_BRIDGE_LINKS_PATH;

        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: true });

        expect(fs.existsSync(linksPath + '.tmp')).toBe(false);
    });

    test('writeState overwrites stale .tmp file left by a previous crash (#124)', async () => {
        const linksPath = process.env.OPENCLAW_BRIDGE_LINKS_PATH;
        fs.mkdirSync(path.dirname(linksPath), { recursive: true });
        fs.writeFileSync(linksPath + '.tmp', 'stale corrupted data');

        const linkState = require('../link-state');
        await linkState.upsertLink('Frog', { oc_agent_id: 'frog', active: true });

        expect(fs.existsSync(linksPath + '.tmp')).toBe(false);
        expect(linkState.getLink('Frog')).toMatchObject({ oc_agent_id: 'frog' });
    });

    test('writeState preserves original file when rename fails (#124)', async () => {
        const linksPath = process.env.OPENCLAW_BRIDGE_LINKS_PATH;
        fs.mkdirSync(path.dirname(linksPath), { recursive: true });
        fs.writeFileSync(linksPath, JSON.stringify({ Frog: { oc_agent_id: 'frog', active: true, owner_user_ids: [] } }, null, 2));

        const origRename = fs.promises.rename;
        fs.promises.rename = jest.fn().mockRejectedValue(new Error('ENOSPC: no space left on device'));

        const linkState = require('../link-state');

        await expect(
            linkState.upsertLink('Toad', { oc_agent_id: 'toad', active: true })
        ).rejects.toThrow('ENOSPC');

        fs.promises.rename = origRename;

        const content = JSON.parse(fs.readFileSync(linksPath, 'utf8'));
        expect(content).toHaveProperty('Frog');
        expect(content).not.toHaveProperty('Toad');
    });
});
