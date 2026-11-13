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

function runner(connect = () => { throw new Error('Unexpected connection'); }, overrides = {}) {
  const context = vm.createContext({
    CdpClient: { connect }, dirname, join, fileURLToPath,
    homedir: () => '/mock-home',
    antigravityDataDirectories: ['Antigravity', 'antigravity'].map(name =>
      join('/mock-home', 'Library/Application Support', name)),
    process: { env: { ANTIGRAVITY_HELPER_SHUTDOWN_TIMEOUT_MS: '9000' }, pid: 123, exitCode: null },
    readFile: async () => '9222\n',
    writeFile: async () => {}, unlink: async () => {},
    fetch: async () => ({ ok: true, json: async () => [{
      id: 'new-window', type: 'page', url: 'https://127.0.0.1/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/new-window',
    }] }),
    URL, AbortSignal, setTimeout, clearTimeout, clearInterval,
    ...overrides,
  });
  vm.runInContext(runnerSource + `\n globalThis.runnerTest = {
    sessions, stop, discover, disconnect, install, reload, loadBundle, snapshot, eligibleTarget, tick, publishBackendStatus,
    installBackendBridge, handleBackendRequest,
    setDiscoverySettled(value) { discoverySettled = value; },
    setBundle(value) { bundle = value; },
    setBackend(value) { backend = value; },
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

test('Swarm frames use their own renderer lifecycle without receiving the main App settings bridge', async () => {
  const source = `(function installSwarm(dictionary) {
    globalThis.starts = (globalThis.starts ?? 0) + 1;
    globalThis.display = dictionary.strings.Board;
    return {version:'sidecar-v1',refresh(next) { globalThis.display = next.strings.Board; },
      uninstall() { globalThis.restores = (globalThis.restores ?? 0) + 1; globalThis.display = 'Board'; }};
  })`;
  const files = { 'renderer.js':'(function() { throw new Error("Main App renderer must not run in Swarm"); })',
    'swarm-renderer.js':source, 'translations.json':JSON.stringify({strings:{Board:'看板'}}) };
  const mtimes = {'renderer.js':1,'swarm-renderer.js':2,'translations.json':3};
  const target = { id:'swarm', type:'iframe', url:'plugin://swarm--swarm_board-5000/?token=fixture',
    webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/swarm' };
  let loaded = false;
  const page = vm.createContext({location:{protocol:'plugin:',hostname:'swarm--swarm_board-5000',pathname:'/'},
    top:{},sidecar:{},document:{readyState:'loading',querySelector:() => loaded ? {} : null}});
  const calls = [], handlers = new Map();
  let nextScript = 0;
  const client = {connected:true,
    async call(method,params) {
      calls.push({method,params});
      if (method === 'Runtime.evaluate') return {result:{value:vm.runInContext(params.expression,page)}};
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return {identifier:`script-${++nextScript}`};
      return {};
    },
    on(name,handler) { handlers.set(name,handler); },cancelPending() {},
    close() { this.connected=false;handlers.get('close')?.(); },
  };
  const basename = path => String(path).split('/').at(-1);
  const helper = runner(async () => client, {
    readFile:async path => files[basename(path)] ?? '9222\n',
    stat:async path => ({mtimeMs:mtimes[basename(path)]}),
    fetch:async () => ({ok:true,json:async () => [target]}),
  });
  assert.equal(helper.eligibleTarget(target,9222),true);
  for (const unrelated of [
    {...target,type:'page'},
    {...target,url:'plugin://other--swarm_board-5000/'},
    {...target,url:'plugin://swarm--swarm_board-5000/unrelated'},
    {...target,webSocketDebuggerUrl:'ws://outside.invalid:9222/devtools/page/swarm'},
  ]) assert.equal(helper.eligibleTarget(unrelated,9222),false);
  helper.setBundle(await helper.loadBundle());
  try {
    await helper.discover();
    const session = helper.sessions.get('swarm');
    assert.ok(session,'a loading Swarm frame keeps its DOM-ready installation');
    assert.equal(page.__antigravityChineseHelper,undefined);
    assert.equal(helper.snapshot().translatedSidecars,0);
    assert.equal(calls.some(call => call.method === 'Runtime.addBinding'),false);
    loaded=true;page.document.readyState='complete';
    handlers.get('Page.domContentEventFired')();
    await new Promise(resolve => setTimeout(resolve,120));
    const first = page.__antigravityChineseHelper;
    assert.equal(first.version,'sidecar-v1');assert.equal(page.display,'看板');
    assert.equal(page.__antigravitySubagentContext,undefined);
    assert.equal(helper.snapshot().connectedWindows,0);
    assert.equal(helper.snapshot().translatedSidecars,1);

    files['translations.json']=JSON.stringify({strings:{Board:'共享看板'}});mtimes['translations.json']++;
    await helper.reload();
    assert.equal(page.__antigravityChineseHelper,first,'a dictionary refresh retains the instance');
    assert.equal(page.display,'共享看板');assert.equal(page.starts,1);
    mtimes['renderer.js']++;
    await helper.reload();
    assert.equal(page.__antigravityChineseHelper,first,'a main renderer edit does not reinstall Swarm');
    files['swarm-renderer.js']=source.replace('sidecar-v1','sidecar-v2');mtimes['swarm-renderer.js']++;
    await helper.reload();
    assert.equal(page.__antigravityChineseHelper.version,'sidecar-v2');
    assert.equal(page.starts,2);assert.equal(page.restores,1);
    await helper.stop();
    assert.equal(page.__antigravityChineseHelper,undefined);
    assert.equal(page.display,'Board');assert.equal(page.restores,2);
    assert.ok(calls.some(call => call.method === 'Page.removeScriptToEvaluateOnNewDocument'));
  } finally { await helper.stop(); }
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
    // Let discovery identify the native window, bind settings, then enter installNow.
    for (const method of ['Runtime.evaluate', 'Runtime.addBinding', 'Page.enable', 'Runtime.evaluate']) {
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

test('页面不可达时仍检查后台，菜单状态不等待失联页面响应', async () => {
  for (const missingPort of [true, false]) {
    let status = {targetTokens:512000, active:true, error:null, message:''};
    const written = [];
    const helper = runner(undefined, {
      readFile:async () => {
        if (missingPort) throw Object.assign(new Error('没有页面调试端口'), {code:'ENOENT'});
        return '9222\n';
      },
      fetch:async () => { throw new Error('页面调试连接已关闭'); },
      stat:async () => ({mtimeMs:1}),
      writeFile:async (_path, contents) => { written.push(JSON.parse(contents)); },
    });
    helper.setBundle({sourceMtime:1, swarm:{sourceMtime:1}, dictionaryMtime:1});
    helper.setBackend({
      getStatus:() => status,
      async refresh() { status = {...status, active:false, message:'已保存，等待下次启动'}; },
    });
    await helper.tick();
    assert.equal(helper.snapshot().subagentContext.active, false);
    assert.equal(helper.snapshot().state, 'waiting-for-app');
    const response = deferred();
    helper.sessions.set('失联的旧窗口', {kind:'main', client:{connected:false, call:() => response.promise}});
    const publishing = helper.publishBackendStatus();
    await nextTurn();
    assert.equal(written.at(-1).subagentContext.active, false, '本机菜单状态不被页面消息阻塞');
    response.resolve({});
    await publishing;
  }
});

test('主设置通知只发送变更信号，manager重读后经同一bridge返回native状态', async () => {
  const helper = runner();
  const status = {targetTokens:null, active:false, nativeReady:true, mainOverrides:true, mainMessage:''};
  const operations = [];
  helper.setBackend({
    ready:Promise.resolve(),
    getStatus() { operations.push('status'); return status; },
    async setLimit(tokens) { operations.push(['set-limit', tokens]); return status; },
    async mainSettingsChanged() { operations.push('main-settings-changed'); return status; },
  });
  const page = vm.createContext({setTimeout, clearTimeout,
    location:{protocol:'https:',hostname:'127.0.0.1'},
    electronNative:{getZoomLevel() {}}, nativeStorage:{getItems() {}},
  });
  vm.runInContext('globalThis.top = globalThis;', page);
  const requests = [];
  const session = {client:{async call(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    assert.equal(params.contextId, 7);
    return {result:{value:vm.runInContext(params.expression, page)}};
  }}};
  page.__aghBackendRequest = payload => {
    requests.push(JSON.parse(payload));
    void helper.handleBackendRequest(session, {name:'__aghBackendRequest', payload, executionContextId:7});
  };
  vm.runInContext(`(${helper.installBackendBridge.toString()})();`, page);
  const bridge = page.__antigravitySubagentContext;
  try {
    const result = await bridge.mainSettingsChanged();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), status);
    assert.deepEqual(requests, [{id:1, method:'main-settings-changed'}], '主额度值和存在性不跨bridge复制');
    assert.deepEqual(operations, ['main-settings-changed']);
    await bridge.getStatus();
    await bridge.setLimit(512000);
    assert.deepEqual(operations, ['main-settings-changed', 'status', ['set-limit', 512000]]);
  } finally { bridge.dispose(); }
});

test('主设置通知不能在binding缺失时返回已生效，也不能从嵌入页面触发manager', async () => {
  const helper = runner();
  let notified = 0;
  helper.setBackend({ready:Promise.resolve(), async mainSettingsChanged() { notified++; return {}; }});
  const page = vm.createContext({setTimeout, clearTimeout});
  vm.runInContext(`(${helper.installBackendBridge.toString()})();`, page);
  const bridge = page.__antigravitySubagentContext;
  try { await assert.rejects(bridge.mainSettingsChanged(), /上下文服务未连接/); }
  finally { bridge.dispose(); }
  let calls = 0;
  const session = {client:{async call(method) {
    assert.equal(method, 'Runtime.evaluate'); calls++;
    return {result:{value:false}};
  }}};
  await helper.handleBackendRequest(session, {name:'__aghBackendRequest',
    payload:JSON.stringify({id:1, method:'main-settings-changed'}), executionContextId:8});
  assert.equal(calls, 1, '只检查发起页身份，不向非原生顶层页面settle');
  assert.equal(notified, 0);
});
