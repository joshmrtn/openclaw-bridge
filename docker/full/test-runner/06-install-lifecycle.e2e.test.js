/**
 * Full E2E — install/uninstall + setup scripts.
 * One of the split full-e2e suites; shared helpers live in helpers.js and are
 * exposed as globals by test-common.js. Run serially via --runInBand.
 */

'use strict';

require('./test-common');

describe('setup.sh integration', () => {
  test('bridge plugin is reachable at expected routes', async () => {
    const r = await stFetch('/status');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('plugin', 'openclaw-bridge');
  });

  test('character listing returns test characters', async () => {
    const r = await stFetch('/characters');
    expect(r.status).toBe(200);
    const chars = r.body.characters || r.body;
    expect(Array.isArray(chars)).toBe(true);
    expect(chars.some(c => c.name === 'TestBot' || c === 'TestBot')).toBe(true);
  });

  test('verify.sh reports all checks pass after setup', () => {
    const output = execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/verify.sh --st-url http://localhost:8000`,
      { timeout: 30000 },
    ).toString();
    expect(output).toContain('0 failed');
  }, 30000);
});

// ── verify.sh individual checks ──────────────────────────────────────────────
// The setup.sh integration block above checks the happy-path summary
// ("0 failed"). These tests drill into the specific [OK]/[FAIL]/[WARN] lines
// that verify.sh emits for each individual check.
describe('verify.sh individual checks', () => {
  // Helper: runs verify.sh inside the ST container and returns stdout regardless
  // of exit code (exit 1 on FAIL would otherwise throw from execSync).
  function runVerify(args) {
    try {
      return execSync(
        `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
        `bash /repo/scripts/verify.sh ${args}`,
        { stdio: 'pipe', timeout: 30000 },
      ).toString();
    } catch (err) {
      return Buffer.isBuffer(err.stdout) ? err.stdout.toString() : String(err.stdout || '');
    }
  }

  test('[OK] Plugin loaded appears when plugin is reachable', () => {
    const output = runVerify('--st-url http://localhost:8000');
    expect(output).toMatch(/\[OK\]\s+Plugin loaded/);
  }, 30000);

  test('[OK] WS clients connected appears when headless client is up', () => {
    const output = runVerify('--st-url http://localhost:8000');
    expect(output).toMatch(/\[OK\]\s+WS clients connected/);
  }, 30000);

  test('[FAIL] Plugin not loaded appears when ST URL is wrong', () => {
    const output = runVerify('--st-url http://localhost:9999');
    expect(output).toMatch(/\[FAIL\]/);
    expect(output).not.toMatch(/0 failed/);
  }, 30000);

  test('[OK] Character linked and active appears when --character names a linked character', () => {
    // Use link-character.sh inside the container: it handles its own CSRF (immune to
    // stale test-runner session after an ST restart). Unlink then re-link so the
    // fresh creation defaults to active:true regardless of prior state.
    execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/link-character.sh --plugin-url http://localhost:8000 --character TestBot --unlink`,
      { stdio: 'pipe', timeout: 15000 },
    );
    execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/link-character.sh --plugin-url http://localhost:8000 --character TestBot --agent default`,
      { stdio: 'pipe', timeout: 15000 },
    );
    const output = runVerify('--st-url http://localhost:8000 --character TestBot');
    expect(output).toMatch(/\[OK\]\s+Character 'TestBot' linked and active/);
  }, 30000);

  test('[FAIL] Character not linked appears when --character names an unknown character', () => {
    const output = runVerify('--st-url http://localhost:8000 --character NoSuchCharacterXYZ');
    expect(output).toMatch(/\[FAIL\]/);
    expect(output).toContain("NoSuchCharacterXYZ");
  }, 30000);
});

// ── link-character.sh round-trip ─────────────────────────────────────────────
// Proves that link-character.sh --unlink removes a character link and the
// normal link command restores it. Runs the real script inside the ST container
// (bash/curl/python3 are available there from setup.sh / the Dockerfile).
describe('link-character.sh round-trip', () => {
  test('unlink removes Narrator link; re-link restores it', async () => {
    // 1. Verify Narrator is linked before we start.
    const before = await stFetch('/characters');
    expect(before.status).toBe(200);
    const beforeList = Array.isArray(before.body) ? before.body : before.body.characters || [];
    const narratorBefore = beforeList.find(c => c.name === 'Narrator');
    expect(narratorBefore).toBeDefined();
    expect(narratorBefore.link).toBeTruthy();

    // 2. Unlink Narrator via the real link-character.sh script inside the ST container.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh ` +
      `--unlink --character Narrator --token e2e-test-token --plugin-url http://localhost:8000`,
      { timeout: 15000 },
    );

    // 3. Verify the link is gone.
    const afterUnlink = await stFetch('/characters');
    expect(afterUnlink.status).toBe(200);
    const afterUnlinkList = Array.isArray(afterUnlink.body) ? afterUnlink.body : afterUnlink.body.characters || [];
    const narratorAfterUnlink = afterUnlinkList.find(c => c.name === 'Narrator');
    expect(narratorAfterUnlink?.link).toBeFalsy();

    // 4. Re-link Narrator.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh ` +
      `--character Narrator --agent default --token e2e-test-token --plugin-url http://localhost:8000`,
      { timeout: 15000 },
    );

    // 5. Verify the link is restored.
    const afterRelink = await stFetch('/characters');
    expect(afterRelink.status).toBe(200);
    const afterRelinkList = Array.isArray(afterRelink.body) ? afterRelink.body : afterRelink.body.characters || [];
    const narratorAfterRelink = afterRelinkList.find(c => c.name === 'Narrator');
    expect(narratorAfterRelink?.link).toBeTruthy();
    expect(narratorAfterRelink.link.oc_agent_id).toBe('default');
  }, 30000);
});

// ── link-character.sh --channel flags (#60) ───────────────────────────────────
// Verifies that --channel/--channel-id/--channel-target/--remove-channel flags
// correctly mutate the channels array in character-links.json via the plugin API.
// Uses Narrator (already linked) so we don't disturb TestBot's message-path tests.
describe('link-character.sh --channel flags (#60)', () => {
  const BASE_CMD =
    `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh ` +
    `--character Narrator --agent default --token e2e-test-token --plugin-url http://localhost:8000`;

  async function getNarratorLink() {
    const r = await stFetch('/characters/Narrator/link');
    expect(r.status).toBe(200);
    return r.body.link;
  }

  beforeEach(async () => {
    // Reset: clear any channels left by a previous test.
    await stFetch('/characters/Narrator/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', channels: null }),
    });
  });

  test('--channel adds a channel entry to the link (#60)', async () => {
    execSync(
      `${BASE_CMD} --channel discord --channel-id discord-narratorbot --channel-target 111222333`,
      { timeout: 15000 },
    );

    const link = await getNarratorLink();
    expect(Array.isArray(link.channels)).toBe(true);
    const ch = link.channels.find(c => c.name === 'discord');
    expect(ch).toBeDefined();
    expect(ch.channel_id).toBe('discord-narratorbot');
    expect(ch.target).toBe('111222333');
  }, 30000);

  test('--channel without --channel-target omits target field (#60)', async () => {
    execSync(
      `${BASE_CMD} --channel telegram --channel-id telegram-narratorbot`,
      { timeout: 15000 },
    );

    const link = await getNarratorLink();
    const ch = link.channels.find(c => c.name === 'telegram');
    expect(ch).toBeDefined();
    expect(ch.channel_id).toBe('telegram-narratorbot');
    expect(ch).not.toHaveProperty('target');
  }, 30000);

  test('second --channel call merges without clobbering existing channels (#60)', async () => {
    // Add discord first.
    execSync(
      `${BASE_CMD} --channel discord --channel-id discord-narratorbot --channel-target 111`,
      { timeout: 15000 },
    );
    // Add telegram in a separate call — should not remove discord.
    execSync(
      `${BASE_CMD} --channel telegram --channel-id telegram-narratorbot`,
      { timeout: 15000 },
    );

    const link = await getNarratorLink();
    expect(link.channels).toHaveLength(2);
    expect(link.channels.find(c => c.name === 'discord')).toBeDefined();
    expect(link.channels.find(c => c.name === 'telegram')).toBeDefined();
  }, 30000);

  test('--remove-channel removes a single entry without clobbering others (#60)', async () => {
    // Set up two channels.
    execSync(
      `${BASE_CMD} --channel discord --channel-id discord-narratorbot ` +
      `--channel telegram --channel-id telegram-narratorbot`,
      { timeout: 15000 },
    );

    // Remove telegram only.
    execSync(`${BASE_CMD} --remove-channel telegram`, { timeout: 15000 });

    const link = await getNarratorLink();
    expect(link.channels.find(c => c.name === 'discord')).toBeDefined();
    expect(link.channels.find(c => c.name === 'telegram')).toBeUndefined();
  }, 30000);
});

// ── update.sh lifecycle (#69) ────────────────────────────────────────────────
// Tests the update.sh deployment steps inside the existing sillytavern-full
// container. The container has no .git directory (excluded by .dockerignore),
// so all tests pass --skip-pull. OC-copy tests pre-create a fake OC install dir.
//
// Scenarios covered:
//   1. Stale ST install refreshed — update.sh restores a removed plugin file
//   2. Pending migration runs — schema version advances from 0 → 1
//   3. OC dist copy — update.sh copies dist/ into a pre-created fake OC dir
//   4. Idempotency — second run exits 0 and does not change schema version
describe('update.sh lifecycle (#69)', () => {
  const UPDATE_FLAGS = '--skip-pull --st-path /home/node/app --yes';
  const DATA_DIR = '/repo/data/openclaw-bridge';

  // Restore schema-version.txt to a known good state after each test so
  // tests that mutate it don't poison later ones.
  afterEach(() => {
    try {
      execSync(
        `docker exec ${SILLYTAVERN_CONTAINER} sh -c 'printf "1" > ${DATA_DIR}/schema-version.txt'`,
        { timeout: 5000 },
      );
    } catch { /* best-effort */ }
  });

  test('stale ST install is refreshed and verify.sh passes after update', async () => {
    // Pre-condition: plugin is healthy.
    const before = await stFetch('/status');
    expect(before.status).toBe(200);

    // Simulate a stale install by removing the plugin's main entry point.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} rm /home/node/app/plugins/openclaw-bridge/index.js`,
      { timeout: 5000 },
    );

    // Run update.sh — it should restore the file.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 120000 },
    );

    // File must be back on disk.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f /home/node/app/plugins/openclaw-bridge/index.js`,
      { timeout: 5000 },
    );

    // Restart ST and confirm the plugin loads.
    execSync(`docker restart ${SILLYTAVERN_CONTAINER}`, { timeout: 30000 });

    await waitFor(async () => {
      try { const r = await stFetch('/status'); return r.status !== 200; }
      catch { return true; }
    }, { timeoutMs: 15000, intervalMs: 500, label: 'ST to go offline after update restart' });

    await waitFor(async () => {
      try { const r = await stFetch('/status'); return r.status === 200; }
      catch { return false; }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'plugin to reload after update' });

    // Wait for headless WS client so verify.sh doesn't fail on client count.
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status === 200 && (r.body.connected_ws_clients ?? 0) > 0;
      } catch { return false; }
    }, { timeoutMs: 120000, intervalMs: 3000, label: 'headless WS to reconnect after update restart' });

    const verifyOut = execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/verify.sh --st-url http://localhost:8000`,
      { timeout: 30000 },
    ).toString();
    expect(verifyOut).toContain('0 failed');
  }, 300000);

  test('pending migration runs and schema version advances', () => {
    // Reset schema version to 0 to simulate a pending migration.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} sh -c 'printf "0" > ${DATA_DIR}/schema-version.txt'`,
      { timeout: 5000 },
    );

    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 60000 },
    );

    const versionRaw = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${DATA_DIR}/schema-version.txt`,
      { timeout: 5000 },
    ).toString().trim();

    expect(parseInt(versionRaw, 10)).toBeGreaterThanOrEqual(1);
  }, 90000);

  test('OC dist copy works when install dir exists', () => {
    // Use the node user's home — the container runs as node, so $HOME=/home/node
    // even when docker exec is given -u root. Using the correct home ensures
    // update.sh's $HOME/.openclaw/... path resolves to the dir we create here.
    const fakeOcDir = '/home/node/.openclaw/extensions/openclaw-bridge/dist';

    // Pre-create a fake OC install dir and place a sentinel file in it.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} sh -c ` +
      `'mkdir -p ${fakeOcDir} && printf "stale" > ${fakeOcDir}/index.js'`,
      { timeout: 5000 },
    );

    // Run update.sh without --skip-oc so the dist copy step fires.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS}`,
      { timeout: 200000 },
    );

    // The copied file must be the real compiled output, not our "stale" sentinel.
    const content = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${fakeOcDir}/index.js`,
      { timeout: 5000 },
    ).toString();
    expect(content).not.toBe('stale');
    expect(content.length).toBeGreaterThan(100);
  }, 240000);

  test('OC update mirrors the whole tree: stale src refreshed and orphans removed (#242)', () => {
    const ocRoot = '/home/node/.openclaw/extensions/openclaw-bridge';

    // Simulate a real installed plugin gone stale: an out-of-date src/index.ts
    // (which OC's security scanner reads) plus an orphan dist file that no
    // longer exists upstream. A whole-install-dir copy from a fresh
    // `openclaw plugins install --force` lays down src/, dist/, configs, etc.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} sh -c ` +
      `'mkdir -p ${ocRoot}/src ${ocRoot}/dist && ` +
      `printf "stale-sentinel" > ${ocRoot}/src/index.ts && ` +
      `printf "orphan" > ${ocRoot}/dist/orphan.js && ` +
      `printf "stale" > ${ocRoot}/dist/index.js'`,
      { timeout: 5000 },
    );

    // Run update.sh without --skip-oc so the OC mirror step fires.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS}`,
      { timeout: 200000 },
    );

    // src/index.ts must be refreshed to the real source, not our stale sentinel.
    const src = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${ocRoot}/src/index.ts`,
      { timeout: 5000 },
    ).toString();
    expect(src).not.toContain('stale-sentinel');
    expect(src.length).toBeGreaterThan(100);

    // The orphan dist file must be gone (deletion-aware mirror).
    expect(() => execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f ${ocRoot}/dist/orphan.js`,
      { timeout: 5000 },
    )).toThrow();

    // The real compiled dist must be present, not our stale sentinel.
    const dist = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${ocRoot}/dist/index.js`,
      { timeout: 5000 },
    ).toString();
    expect(dist).not.toBe('stale');
    expect(dist.length).toBeGreaterThan(100);
  }, 240000);

  test('ST update removes orphaned plugin files (#242)', () => {
    const pluginDir = '/home/node/app/plugins/openclaw-bridge';

    // Pre-seed an orphan file that does not exist in the repo.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} sh -c 'printf "orphan" > ${pluginDir}/orphan-file.js'`,
      { timeout: 5000 },
    );

    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 120000 },
    );

    // The orphan must be gone (deletion-aware mirror).
    expect(() => execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f ${pluginDir}/orphan-file.js`,
      { timeout: 5000 },
    )).toThrow();

    // A real plugin file must still be present.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f ${pluginDir}/index.js`,
      { timeout: 5000 },
    );
  }, 180000);

  test('idempotency — second run exits 0 and schema version is unchanged', () => {
    // First run: everything already current.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 60000 },
    );

    const versionAfterFirst = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${DATA_DIR}/schema-version.txt`,
      { timeout: 5000 },
    ).toString().trim();

    // Second run: must succeed without error.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 60000 },
    );

    const versionAfterSecond = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${DATA_DIR}/schema-version.txt`,
      { timeout: 5000 },
    ).toString().trim();

    expect(versionAfterSecond).toBe(versionAfterFirst);
  }, 150000);
});

// ── uninstall.sh lifecycle (#40) ─────────────────────────────────────────────
// Answers definitively: can a user follow the installation instructions to get
// a working system, and after running uninstall.sh is everything put back
// exactly as it was before?
//
// Steps:
//   1. Verify plugin is healthy (pre-condition)
//   2. Run uninstall.sh — assert installed dirs are gone from disk
//   3. Run setup.sh — assert dirs are restored on disk
//   4. Restart ST and assert the reinstalled plugin loads and returns 200
//
// Note: we verify uninstall via disk state (test -d) rather than checking for
// HTTP 404 after restart. The container entrypoint always runs setup.sh on
// startup, so a restart would immediately reinstall — that is correct Docker E2E
// setup behaviour and does not represent how a real user uninstall works.
// The disk assertions are the definitive check: if the files are gone,
// the plugin is uninstalled; if they are back, it is reinstalled.
describe('setup.sh → uninstall.sh lifecycle (#40)', () => {
  test('uninstall removes plugin from disk; reinstall restores it', async () => {
    // 1. Pre-condition: plugin is healthy.
    const before = await stFetch('/status');
    expect(before.status).toBe(200);

    // 2. Uninstall inside the ST container (non-interactive: --st-path + --yes).
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/uninstall.sh` +
      ` --st-path /home/node/app --yes`,
      { timeout: 30000 },
    );

    // Assert plugin and extension directories are gone from disk.
    expect(() =>
      execSync(
        `docker exec ${SILLYTAVERN_CONTAINER} test -d /home/node/app/plugins/openclaw-bridge`,
        { timeout: 5000 },
      )
    ).toThrow(); // test -d exits 1 when absent → execSync throws

    expect(() =>
      execSync(
        `docker exec ${SILLYTAVERN_CONTAINER} test -d` +
        ` /home/node/app/public/scripts/extensions/openclaw-bridge`,
        { timeout: 5000 },
      )
    ).toThrow();

    // Assert things uninstall.sh must NOT touch are still intact.
    // Character cards (the .png and .json files placed by the user, not by setup.sh).
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f` +
      ` /home/node/app/data/default-user/characters/TestBot.png`,
      { timeout: 5000 },
    );
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f` +
      ` /home/node/app/data/default-user/characters/Narrator.png`,
      { timeout: 5000 },
    );
    // ST config.yaml and settings.json (owned by the user, never written by setup.sh).
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f /home/node/app/config/config.yaml`,
      { timeout: 5000 },
    );
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f` +
      ` /home/node/app/data/default-user/settings.json`,
      { timeout: 5000 },
    );

    // 3. Reinstall inside the ST container.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/setup.sh` +
      ` --st-path /home/node/app`,
      { timeout: 90000 },
    );

    // Assert directories are back on disk.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -d /home/node/app/plugins/openclaw-bridge`,
      { timeout: 5000 },
    ); // exits 0 when present — does not throw

    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -d` +
      ` /home/node/app/public/scripts/extensions/openclaw-bridge`,
      { timeout: 5000 },
    );

    // 4. Restart ST and confirm the reinstalled plugin loads correctly.
    execSync(`docker restart ${SILLYTAVERN_CONTAINER}`, { timeout: 30000 });

    await waitFor(async () => {
      try { const r = await stFetch('/status'); return r.status !== 200; }
      catch { return true; }
    }, { timeoutMs: 15000, intervalMs: 500, label: 'ST to go offline after lifecycle restart' });

    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status === 200;
      } catch { return false; }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'plugin to come back after reinstall' });

    const afterReinstall = await stFetch('/status');
    expect(afterReinstall.status).toBe(200);
    expect(afterReinstall.body).toHaveProperty('plugin', 'openclaw-bridge');

    // Wait for headless Playwright to reconnect — verify.sh fails if no WS clients.
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status === 200 && (r.body.connected_ws_clients ?? 0) > 0;
      } catch { return false; }
    }, { timeoutMs: 120000, intervalMs: 3000, label: 'headless WS client to reconnect after reinstall' });

    // verify.sh confirms the reinstalled setup is fully healthy end-to-end.
    const verifyOut = execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/verify.sh --st-url http://localhost:8000`,
      { timeout: 30000 },
    ).toString();
    expect(verifyOut).toContain('0 failed');
  }, 300000); // 5 min — one ST restart + npm install inside container
});

describe('cold-start with no character-links.json', () => {
  test('plugin starts cleanly and allows fresh linking when links file is absent', async () => {
    // 1. Remove the shared links file — simulates a fresh install.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} rm -f /shared/character-links.json`,
      { timeout: 5000 },
    );

    // 2. Restart ST so the plugin re-initialises from scratch.
    execSync(`docker restart ${SILLYTAVERN_CONTAINER}`, { timeout: 30000 });

    // 3. Wait for ST to go offline.
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status !== 200;
      } catch {
        return true;
      }
    }, { timeoutMs: 15000, intervalMs: 500, label: 'ST to go offline after cold-start restart' });

    // 4. Wait for ST to come back up.
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status === 200;
      } catch {
        return false;
      }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'ST plugin to come back after cold-start' });

    // 5. Re-fetch CSRF token — it is invalidated by the restart.
    await fetchStCsrfState();

    // 6. Wait for headless client to reconnect.
    await waitFor(async () => {
      try {
        const r = await stFetch('/health');
        return r.status === 200 && r.body.headless?.isRunning === true;
      } catch {
        return false;
      }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'headless to reconnect after cold-start' });

    // 7. The plugin must report OK status (no crash on missing links file).
    const status = await stFetch('/status');
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('ok');

    // 8. Characters are visible but no links exist yet.
    const chars = await stFetch('/characters');
    expect(chars.status).toBe(200);
    const charList = Array.isArray(chars.body) ? chars.body : chars.body.characters || [];
    const linked = charList.filter(c => c.link);
    expect(linked).toHaveLength(0);

    // 9. Create a fresh link — proves first write works without a pre-existing file.
    const linkRes = await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    expect(linkRes.status).toBe(200);

    // 10. Verify the link is readable immediately after creation.
    const linkCheck = await stFetch('/characters/TestBot/link');
    expect(linkCheck.status).toBe(200);
    expect(linkCheck.body.link?.oc_agent_id).toBe('default');

    // 11. Restore Narrator link so any tests that run after this block still work.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh ` +
      `--character Narrator --agent default --token e2e-test-token --plugin-url http://localhost:8000`,
      { timeout: 15000 },
    );
  }, 300000); // 5 min — one ST restart + Playwright launch
});
