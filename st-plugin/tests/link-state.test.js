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

    test('upsert creates and reads link state', () => {
        const linkState = require('../link-state');

        const written = linkState.upsertLink('Gerard', {
            oc_agent_id: 'gerard',
            active: true,
        });

        expect(written).toEqual({
            oc_agent_id: 'gerard',
            active: true,
        });
        expect(linkState.getLink('Gerard')).toEqual({
            oc_agent_id: 'gerard',
            active: true,
        });
    });

    test('remove deletes existing links', () => {
        const linkState = require('../link-state');

        linkState.upsertLink('Gerard', {
            oc_agent_id: 'gerard',
            active: true,
        });

        expect(linkState.removeLink('Gerard')).toBe(true);
        expect(linkState.getLink('Gerard')).toBeNull();
    });
});
