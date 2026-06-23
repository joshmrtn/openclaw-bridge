/**
 * Full E2E — health & protocol smoke.
 * One of the split full-e2e suites; shared helpers live in helpers.js and are
 * exposed as globals by test-common.js. Run serially via --runInBand.
 */

'use strict';

require('./test-common');

describe('ST plugin health', () => {
  test('bridge plugin status is reachable', async () => {
    const r = await stFetch('/status');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('plugin', 'openclaw-bridge');
  });

  test('headless client is connected', async () => {
    const r = await stFetch('/health');
    expect(r.status).toBe(200);
    expect(r.body.clients.headless).toBeGreaterThanOrEqual(1);
    expect(r.body.headless.isRunning).toBe(true);
  });
});

describe('OC gateway health', () => {
  test('OC gateway /healthz returns 200', async () => {
    const r = await fetch(`${OC_URL}/healthz`);
    expect(r.status).toBe(200);
  });
});

describe('qa-bus protocol', () => {
  test('health endpoint returns ok', async () => {
    const r = await fetch(`${QA_BUS_URL}/health`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('reset clears state', async () => {
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: 'test-conv', kind: 'direct' },
      senderId: 'test-user',
      text: 'test message',
    });
    await post(`${QA_BUS_URL}/v1/reset`, {});
    const r = await fetch(`${QA_BUS_URL}/v1/state`);
    expect(r.body.events).toHaveLength(0);
    expect(r.body.messages).toHaveLength(0);
  });

  test('inbound message appears in state', async () => {
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: 'test-conv', kind: 'direct' },
      senderId: 'test-user',
      senderName: 'Test User',
      text: 'ping',
    });
    const r = await fetch(`${QA_BUS_URL}/v1/state`);
    expect(r.body.events).toHaveLength(1);
    expect(r.body.events[0].kind).toBe('inbound-message');
    expect(r.body.events[0].message.text).toBe('ping');
  });
});
