import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { CdpClient } from '../runtime/cdp.mjs';

const runnerUrl = new URL('../runtime/runner.mjs', import.meta.url);
// Run the real runner functions without invoking main or opening a local socket.
const runnerSource = readFileSync(runnerUrl, 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/^import .*;\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(runnerUrl.href))
  .split('\nmain().catch(')[0];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  sent = [];

  send(data) { this.sent.push(JSON.parse(data)); }
  reply(id, result = {}) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) }));
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

function runner(connect = () => { throw new Error('Unexpected connection'); }) {
  const context = vm.createContext({
    CdpClient: { connect }, dirname, join, fileURLToPath,
    homedir: () => '/mock-home',
    process: { env: { ANTIGRAVITY_HELPER_SHUTDOWN_TIMEOUT_MS: '9000' }, pid: 123, exitCode: null },
    readFile: async () => '9222\n',
    writeFile: async () => {}, unlink: async () => {},
    fetch: async () => ({ ok: true, json: async () => [{
      id: 'new-window', type: 'page', url: 'https://127.0.0.1/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/new-window',
    }] }),
    URL, AbortSignal, setTimeout, clearTimeout, clearInterval,
  });
  vm.runInContext(runnerSource + `\n globalThis.runnerTest = {
    sessions, stop, discover, disconnect,
    setDiscoverySettled(value) { discoverySettled = value; },
    setBundle(value) { bundle = value; },
  };`, context, { filename: 'runtime/runner.mjs' });
  return context.runnerTest;
}

test('stop cancels ordinary work and sends cleanup before discovery or script removal completes', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  const operation = client.call('Runtime.evaluate', { expression: 'ordinary-work' });
  const cancelled = assert.rejects(operation, /CDP request cancelled/);
  const session = { client, operation, scriptId: 'installed-script', navigationTimer: null };
  const discovery = deferred();
  const helper = runner();
  helper.sessions.set('existing-window', session);
  helper.setDiscoverySettled(discovery.promise);
  // Discovery may already be disconnecting this session when shutdown starts.
  const disconnecting = helper.disconnect(session, true);

  const stopped = helper.stop();
  assert.strictEqual(helper.stop(), stopped, 'Repeated stop must share the cleanup promise');
  let finished = false;
  stopped.then(() => { finished = true; });

  try {
    await cancelled;
    await nextTurn();
    const uninstall = socket.sent.find((request) => request.params.expression?.includes('.uninstall?.()'));
    const remove = socket.sent.find((request) => request.method === 'Page.removeScriptToEvaluateOnNewDocument');
    assert.ok(uninstall, 'Uninstall must be sent without waiting for discovery to settle');
    assert.ok(remove, 'Script removal must be sent alongside uninstall');
    assert.equal(finished, false);
    assert.strictEqual(helper.disconnect(session, true), disconnecting);

    // The cancelled request ID must stay retired while cleanup requests are active.
    socket.reply(socket.sent[0].id, { result: { value: 'late ordinary response' } });
    socket.reply(uninstall.id, { result: { value: true } });
    discovery.resolve();
    await nextTurn();
    assert.equal(finished, false, 'A late response must not resolve the pending script removal');

    socket.reply(remove.id);
    await stopped;
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    discovery.resolve();
    client.close();
    await stopped;
  }
});

test('a connection completed after shutdown is closed without installing a renderer', async () => {
  const connection = deferred();
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  let connecting = false;
  const helper = runner(() => { connecting = true; return connection.promise; });
  const discovering = helper.discover();
  await nextTurn();
  assert.equal(connecting, true);

  const stopped = helper.stop();
  connection.resolve(client);
  await Promise.all([discovering, stopped]);
  assert.equal(socket.sent.length, 0, 'Shutdown must prevent identification and installation after connection');
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(helper.sessions.size, 0);
});

test('shutdown preserves a pending registration identifier and removes it without installing', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  const helper = runner(async () => client);
  const expression = 'globalThis.mockRendererInstalled = true';
  helper.setBundle({ expression });
  const discovering = helper.discover();
  let stopped;

  try {
    // Let discovery identify the window, enable Page, then enter installNow.
    for (const method of ['Runtime.evaluate', 'Page.enable', 'Runtime.evaluate']) {
      await nextTurn();
      const request = socket.sent.at(-1);
      assert.equal(request?.method, method);
      socket.reply(request.id, method === 'Runtime.evaluate' ? { result: { value: true } } : {});
    }
    await nextTurn();
    const registration = socket.sent.at(-1);
    assert.equal(registration.method, 'Page.addScriptToEvaluateOnNewDocument');

    const ordinary = client.call('Runtime.evaluate', { expression: 'ordinary-work' });
    const cancelled = assert.rejects(ordinary, /CDP request cancelled/);
    stopped = helper.stop();
    await cancelled;
    await nextTurn();
    assert.equal(client.connected, true, 'Registration must retain its connection until its response');
    assert.equal(socket.sent.some((request) => request.params.expression?.includes('.uninstall?.()')), false);

    socket.reply(registration.id, { identifier: 'late-registration-id' });
    await nextTurn();
    const uninstall = socket.sent.find((request) => request.params.expression?.includes('.uninstall?.()'));
    const remove = socket.sent.find((request) => request.method === 'Page.removeScriptToEvaluateOnNewDocument');
    assert.ok(uninstall, 'The registered window must still receive uninstall');
    assert.equal(remove?.params.identifier, 'late-registration-id', 'Cleanup must retain the late script ID');
    assert.equal(socket.sent.some((request) => request.params.expression === expression), false,
      'Shutdown must prevent renderer evaluation after registration completes');

    socket.reply(uninstall.id, { result: { value: true } });
    socket.reply(remove.id);
    await Promise.all([discovering, stopped]);
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    client.close();
    await Promise.allSettled([discovering, stopped]);
  }
});
