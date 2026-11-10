import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';

const moduleUrl = new URL('../runtime/backend-manager.mjs', import.meta.url);
const appPath = '/Applications/Antigravity.app';
const appExecutable = join(appPath, 'Contents/MacOS/Antigravity');
const officialBackendPath = join(appPath, 'Contents/Resources/bin/language_server');
const stateDir = '/fixture/state', runtimeDir = '/fixture/runtime';
const helperBackendPath = join(stateDir, 'backend/1017595969/language_server');
const configPath = join(stateDir, 'backend-context.json');
const receiptPath = join(stateDir, 'backend-session.json');
const receipt = {appPid:101, backendPid:202, inspectorUrl:'ws://127.0.0.1:9229/fixture', officialBackendPath, helperBackendPath};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

// Execute the real manager with in-memory files and fake external boundaries.
// No subprocess, application, inspector or instrumentation is started by these tests.
function fixture({targetTokens = 400000, savedReceipt = null, running = [], connectError = null,
  attachError = null, readyError = null, holdReady = false, files:existingFiles = null} = {}) {
  const source = readFileSync(moduleUrl, 'utf8').replace(/^import .*;\n/gm, '')
    .replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));
  const files = existingFiles ?? new Map([[configPath, JSON.stringify({targetTokens})]]);
  if (savedReceipt) files.set(receiptPath, JSON.stringify(savedReceipt));
  const events = [], writes = [], sessions = [], runtimes = [], statuses = [];
  const behavior = {running:[...running], connectError, attachError, readyError, holdReady,
    writeError:null, configureError:null, configureGate:null};
  let temporary = 0, launchSequence = 0;
  const absent = path => Object.assign(new Error(`ENOENT: ${path}`), {code:'ENOENT'});
  const execFile = (command, args, _options, callback) => {
    if (typeof _options === 'function') callback = _options;
    events.push({type:'exec', command, args:[...args]});
    let stdout = '';
    if (command === '/bin/ps') stdout = behavior.running.map(([pid, path]) => `${pid} ${path}`).join('\n');
    else if (command === '/usr/bin/plutil') stdout = JSON.stringify({LSEnvironment:{FROM_PLIST:'bundle', SHARED_ENV:'bundle'}});
    else if (command !== '/usr/bin/open') return callback(new Error(`Unexpected command: ${command}`));
    callback(null, stdout, '');
  };
  execFile[promisify.custom] = (...args) => new Promise((yes, no) => {
    execFile(...args, (error, stdout, stderr) => error ? no(error) : yes({stdout, stderr}));
  });
  function createBackendRuntime(options) {
    const state = {attached:false, pid:null, targetTokens:options.targetTokens, disposed:false, lastError:null};
    const snapshot = () => ({...state, expectedBinaryPath:options.expectedBinaryPath});
    const runtime = {
      options, state,
      async attach(pid) {
        events.push({type:'attach', pid, hasReceipt:files.has(receiptPath)});
        if (behavior.attachError) throw behavior.attachError;
        state.attached = true; state.pid = pid;
        return snapshot();
      },
      async setLimit(tokens) {
        events.push({type:'configure', tokens});
        const gate = behavior.configureGate; behavior.configureGate = null;
        if (gate) await gate.promise;
        state.targetTokens = tokens;
        const error = behavior.configureError; behavior.configureError = null;
        if (error) throw error;
        return snapshot();
      },
      async status() { return snapshot(); },
      async dispose() { events.push({type:'runtime-dispose'}); state.disposed = true; state.attached = false; return snapshot(); }
    };
    runtimes.push(runtime); events.push({type:'runtime-create', options});
    return runtime;
  }
  async function sessionFor(kind, options) {
    events.push({type:kind, options});
    const appPid = kind === 'connect' ? options.appPid : 301 + 2 * launchSequence++;
    const backendPid = kind === 'connect' ? options.backendPid : appPid + 1;
    if (kind === 'launch') behavior.running.push([appPid, appExecutable], [backendPid, helperBackendPath]);
    const ready = deferred();
    const controller = new AbortController();
    const session = {
      appPid, phase:'attaching', paused:true, restored:false,
      process:kind === 'connect' ? null : {pid:appPid, exitCode:null, signalCode:null,
        kill() { assert.fail('manager must not kill the app'); }},
      ready:ready.promise,
      getStatus:() => ({phase:session.phase, appPid, backendPid,
        inspectorUrl:receipt.inspectorUrl, error:null}),
      async restore() {
        events.push({type:'restore', kind}); controller.abort();
        session.restored = true; session.paused = false; session.phase = 'restored';
        ready.reject(new Error('fixture session restored before ready'));
      }
    };
    ready.promise.catch(() => {});
    sessions.push(session);
    if (kind === 'connect' && behavior.connectError) {
      session.phase = 'failed'; ready.reject(behavior.connectError);
      throw Object.assign(behavior.connectError, {session});
    }
    Promise.resolve().then(async () => {
      await options.onBackendSpawn?.(backendPid, {signal:controller.signal, sequence:1,
        appPid, inspectorUrl:receipt.inspectorUrl});
      if (behavior.readyError) throw behavior.readyError;
      if (session.restored || behavior.holdReady) return;
      session.paused = false; session.phase = 'running'; ready.resolve(backendPid);
    }).catch(error => { if (!session.restored) session.phase = 'failed'; ready.reject(error); });
    return session;
  }
  const require = Object.assign(() => { throw new Error('No real module loading is allowed'); }, {resolve:path => path});
  const context = vm.createContext({
    execFile, promisify, join, resolve, relative, sep, homedir:() => '/fixture/home', createRequire:() => require,
    process:{pid:303, env:{FROM_PROCESS:'host', SHARED_ENV:'host'}, kill() { assert.fail('manager must not kill a process'); }},
    readFile:async path => { if (!files.has(path)) throw absent(path); return files.get(path); },
    writeFile:async (path, value, options) => {
      writes.push({path, value:String(value), options}); events.push({type:'write', path});
      const error = behavior.writeError; behavior.writeError = null;
      if (error) throw error;
      files.set(path, String(value));
    },
    mkdir:async () => {}, mkdtemp:async prefix => `${prefix}${++temporary}`,
    realpath:async path => resolve(path),
    rename:async (from, to) => { if (!files.has(from)) throw absent(from); files.set(to, files.get(from)); files.delete(from); },
    rm:async path => { for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key); },
    prepareBackendCopy:async options => { events.push({type:'prepare', options}); return {binaryPath:helperBackendPath, buildCL:'1017595969'}; },
    createBackendRuntime,
    launchBackendApp:options => sessionFor('launch', options),
    connectBackendApp:options => sessionFor('connect', options),
    setTimeout, clearTimeout, AbortController, URL,
  });
  vm.runInContext(`${source}\nglobalThis.createManager = createBackendManager;`, context, {filename:'runtime/backend-manager.mjs'});
  const manager = context.createManager({stateDir, runtimeDir, appPath, onChange:status => statuses.push(status)});
  return {manager, behavior, events, writes, files, sessions, runtimes, statuses,
    count:type => events.filter(event => event.type === type).length,
    savedLimit:() => JSON.parse(files.get(configPath)).targetTokens};
}

test('startup validates helper processes, reconnects after disposal and never retries a failed connection during refresh', async t => {
  const processes = [[101, appExecutable], [202, helperBackendPath]];
  const valid = fixture({savedReceipt:receipt, running:processes});
  t.after(() => valid.manager.dispose());
  await valid.manager.ready;
  assert.equal(valid.count('connect'), 1);
  await valid.manager.refresh(); await valid.manager.refresh();
  assert.equal(valid.count('connect'), 1, 'refresh only checks an existing runtime');
  await valid.manager.dispose();
  assert.equal(valid.sessions[0].restored, true);
  assert.equal(valid.runtimes[0].state.disposed, true);
  assert.equal(valid.files.has(receiptPath), true, 'helper shutdown retains ownership of a still-running app');
  const restarted = fixture({files:valid.files, running:processes}); t.after(() => restarted.manager.dispose());
  await restarted.manager.ready;
  assert.equal(restarted.count('connect'), 1);
  assert.equal(restarted.manager.getStatus().active, true);

  const invalidCases = [
    {savedReceipt:{...receipt, helperBackendPath:officialBackendPath}, running:[[101, appExecutable], [202, officialBackendPath]]},
    {savedReceipt:receipt, running:[[101, `${appExecutable} Helper`], [202, helperBackendPath]]},
    {savedReceipt:receipt, running:[[101, appExecutable], [202, `${helperBackendPath}-other`]]},
  ];
  for (const scenario of invalidCases) {
    const invalid = fixture(scenario); t.after(() => invalid.manager.dispose());
    await invalid.manager.ready; await invalid.manager.refresh();
    assert.equal(invalid.count('connect'), 0, 'a receipt cannot authorize a different or official process');
    assert.equal(invalid.count('attach'), 0);
    assert.equal(invalid.files.has(receiptPath), false, 'invalid ownership records are removed');
  }
  const failed = fixture({savedReceipt:receipt, running:processes, connectError:new Error('fixture connection failed')});
  t.after(() => failed.manager.dispose());
  await failed.manager.ready; await failed.manager.refresh(); await failed.manager.refresh();
  assert.equal(failed.count('connect'), 1, 'a failed startup attempt is not retried by status polling');
  assert.equal(failed.sessions[0].restored, true, 'a failed connection must still restore the live owned app');
  assert.equal(failed.files.has(receiptPath), true);
  const retry = fixture({files:failed.files, running:processes}); t.after(() => retry.manager.dispose());
  await retry.manager.ready; await retry.manager.refresh();
  assert.equal(retry.count('connect'), 1, 'a new helper instance may make one fresh connection attempt');
  assert.equal(retry.manager.getStatus().active, true);
});

test('limit changes are serialized, stored privately and rolled back on write or runtime failure', async t => {
  const f = fixture({savedReceipt:receipt, running:[[101, appExecutable], [202, helperBackendPath]]});
  t.after(() => f.manager.dispose());
  await f.manager.ready;
  const changesStart = f.events.length;
  const gate = deferred(); f.behavior.configureGate = gate;
  const first = f.manager.setLimit(500000), second = f.manager.setLimit(600000);
  await nextTurn();
  assert.deepEqual(f.events.slice(changesStart).filter(event => event.type === 'configure').map(event => event.tokens), [500000]);
  assert.equal(f.savedLimit(), 400000, 'a pending runtime change is not committed to disk');
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.savedLimit(), 600000);
  assert.equal(f.manager.getStatus().targetTokens, 600000);
  assert.ok(f.writes.length > 0);
  assert.ok(f.writes.every(write => write.options?.mode === 0o600), 'settings and receipts are owner-only files');

  f.behavior.writeError = new Error('fixture disk full');
  const writeFailure = await f.manager.setLimit(700000);
  assert.match(writeFailure.error, /fixture disk full/);
  assert.equal(f.savedLimit(), 600000);
  assert.equal(f.manager.getStatus().targetTokens, 600000);
  assert.equal(f.runtimes.at(-1).state.targetTokens, 600000);
  assert.deepEqual(f.events.filter(event => event.type === 'configure').slice(-2).map(event => event.tokens), [700000, 600000]);

  f.behavior.configureError = new Error('fixture configure failed');
  const runtimeFailure = await f.manager.setLimit(800000);
  assert.match(runtimeFailure.error, /fixture configure failed/);
  assert.equal(f.savedLimit(), 600000);
  assert.equal(f.manager.getStatus().targetTokens, 600000);
  assert.equal(f.runtimes.at(-1).state.targetTokens, 600000);
});

test('launch respects running apps and clears exited or replaced owners before a later startup', async t => {
  const running = fixture({running:[[101, appExecutable]]}); t.after(() => running.manager.dispose());
  await running.manager.ready;
  const refused = await running.manager.launch();
  assert.equal(refused.message, 'Antigravity 正在运行。请先退出，再从此菜单启动，以启用子代理上下文设置。');
  assert.equal(running.count('prepare'), 0);
  assert.equal(running.count('launch'), 0);
  assert.equal(running.events.some(event => event.command === '/usr/bin/open'), false);

  const normal = fixture({targetTokens:null}); t.after(() => normal.manager.dispose());
  await normal.manager.ready; await normal.manager.launch();
  assert.deepEqual(normal.events.filter(event => event.command === '/usr/bin/open').map(event => event.args), [[appPath]]);
  assert.equal(normal.count('prepare'), 0);
  assert.equal(normal.count('launch'), 0);
  assert.equal(normal.count('runtime-create'), 0);

  for (const afterExit of [[], [[101, '/Applications/Other.app/Contents/MacOS/Other']]]) {
    const ended = fixture({savedReceipt:receipt, running:[[101, appExecutable], [202, helperBackendPath]]});
    t.after(() => ended.manager.dispose());
    await ended.manager.ready;
    assert.equal(ended.sessions[0].process, null, 'reconnected sessions have no ChildProcess exit event');
    ended.sessions[0].phase = 'failed'; ended.behavior.running = [...afterExit];
    const status = await ended.manager.refresh();
    assert.equal(ended.count('restore'), 0, 'a missing or reused PID must not be resumed or reconnected');
    assert.equal(ended.runtimes[0].state.disposed, true);
    assert.equal(ended.files.has(receiptPath), false);
    assert.equal(status.active, false);
    assert.equal(status.error, null, 'normal app exit is not a persistent service error');
    await ended.manager.refresh();
    assert.equal(ended.count('runtime-dispose'), 1, 'the exited owner is removed');
    const relaunched = await ended.manager.launch();
    assert.equal(relaunched.launched, true);
    assert.equal(ended.count('launch'), 1);
    assert.equal(ended.manager.getStatus().active, true);
    assert.equal(ended.sessions[0].restored, false);
    if (afterExit.length) assert.ok(ended.behavior.running.some(([pid, path]) => pid === 101 && path === afterExit[0][1]),
      'the process reusing the old PID remains untouched');
  }
});

test('enabled launch forwards bundle environment and restores owned sessions on failure or disposal', async () => {
  const success = fixture();
  await success.manager.ready; await success.manager.launch();
  const options = success.events.find(event => event.type === 'launch')?.options;
  assert.ok(options);
  assert.equal(options.env.FROM_PLIST, 'bundle');
  assert.equal(options.env.FROM_PROCESS, 'host');
  assert.equal(options.env.SHARED_ENV, 'bundle');
  assert.equal(success.count('attach'), 1);
  await success.manager.dispose();
  assert.equal(success.sessions[0].restored, true);
  assert.equal(success.sessions[0].paused, false);
  assert.equal(success.runtimes[0].state.disposed, true);
  assert.equal(success.files.has(receiptPath), true);

  for (const failure of [{attachError:new Error('fixture attach failed')}, {readyError:new Error('fixture ready failed')}]) {
    const f = fixture(failure);
    await f.manager.ready;
    const result = await f.manager.launch();
    assert.equal(result.launched, false);
    assert.match(result.message, /fixture (attach|ready) failed/);
    assert.match(f.manager.getStatus().error, /fixture (attach|ready) failed/);
    assert.equal(f.sessions[0].restored, true);
    assert.equal(f.sessions[0].paused, false, 'a failed owned launch cannot leave Electron paused');
    assert.equal(f.runtimes[0].state.disposed, true);
    assert.equal(f.files.has(receiptPath), true, 'the live app receipt survives native attachment or readiness failure');
    await f.manager.dispose();
    if (failure.attachError) {
      assert.equal(f.events.find(event => event.type === 'attach').hasReceipt, true,
        'the owned launch is recorded before its first native attachment attempt');
      const restarted = fixture({files:f.files, running:f.behavior.running});
      await restarted.manager.ready;
      assert.equal(restarted.count('connect'), 1, 'a new helper can reconnect after the first native attachment failed');
      assert.equal(restarted.manager.getStatus().active, true);
      await restarted.manager.dispose();
    }
  }

  const waiting = fixture({holdReady:true});
  await waiting.manager.ready;
  const launching = waiting.manager.launch();
  await nextTurn();
  assert.equal(waiting.sessions[0].paused, true);
  const stopping = waiting.manager.dispose();
  assert.strictEqual(waiting.manager.dispose(), stopping, 'concurrent disposal shares the same cleanup');
  await nextTurn();
  assert.equal(waiting.sessions[0].restored, true, 'disposal restores the session before awaiting launch.ready');
  const [launchResult, stopped] = await Promise.all([launching, stopping]);
  assert.equal(launchResult.launched, false);
  assert.equal(stopped.active, false);
  assert.equal(stopped.error, null);
  assert.equal(waiting.sessions[0].paused, false);
  assert.equal(waiting.runtimes[0].state.disposed, true);
  assert.equal(waiting.files.has(receiptPath), true);
});
