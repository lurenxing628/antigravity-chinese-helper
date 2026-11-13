import assert from 'node:assert/strict';
import { constants, readFileSync } from 'node:fs';
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
const appStoragePath = '/fixture/Antigravity/app_storage.json';
const receipt = {appPid:101, backendPid:202, inspectorUrl:'ws://127.0.0.1:9229/fixture', officialBackendPath, helperBackendPath};
const fixtureLayout = { format:1, profile:'fixture-layout' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

// Execute the real manager with in-memory files and fake external boundaries.
// No subprocess, application, inspector or instrumentation is started by these tests.
function fixture({targetTokens = 400000, mainSettings, savedReceipt = null, running = [], connectError = null,
  attachError = null, readyError = null, holdReady = false, files:existingFiles = null} = {}) {
  const source = readFileSync(moduleUrl, 'utf8').replace(/^import .*;\n/gm, '')
    .replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));
  const files = existingFiles ?? new Map([[configPath, JSON.stringify({targetTokens})]]);
  if (savedReceipt) files.set(receiptPath, JSON.stringify(savedReceipt));
  if (mainSettings !== undefined) files.set(appStoragePath, JSON.stringify(mainSettings));
  const events = [], writes = [], sessions = [], runtimes = [], statuses = [];
  const behavior = {running:[...running], connectError, attachError, readyError, holdReady,
    writeError:null, configureError:null, configureGate:null, disposeGate:null, disposeError:null, killError:null,
    attachGate:null, openingGate:null, restoreGate:null, restoreError:null, statusError:null,
    accessError:null, installationWriteError:null, mainReadError:null};
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
    const notify = () => options.onChange?.(snapshot());
    const runtime = {
      options, state, getStatus:snapshot,
      async attach(pid, {descriptor} = {}) {
        events.push({type:'attach', pid, descriptor, hasReceipt:files.has(receiptPath)});
        const gate = behavior.attachGate; behavior.attachGate = null;
        if (gate) await gate.promise;
        if (state.disposed) throw new Error('fixture runtime disposed');
        if (behavior.attachError) throw behavior.attachError;
        if (behavior.installationWriteError) {
          behavior.writeError = behavior.installationWriteError;
          behavior.installationWriteError = null;
        }
        await options.onInstallation({pid, descriptor:descriptor ?? `0x${pid.toString(16)}0000`});
        events.push({type:'native-install', pid, receipt:JSON.parse(files.get(receiptPath))});
        state.attached = true; state.pid = pid; notify();
        return snapshot();
      },
      disconnect() { state.attached = false; state.pid = null; notify(); },
      async setLimit(tokens) {
        events.push({type:'configure', tokens});
        const gate = behavior.configureGate; behavior.configureGate = null;
        if (gate) await gate.promise;
        state.targetTokens = tokens;
        const error = behavior.configureError; behavior.configureError = null;
        if (error) throw error;
        notify();
        return snapshot();
      },
      async status() {
        events.push({type:'status'});
        if (behavior.statusError) throw behavior.statusError;
        return snapshot();
      },
      async dispose() {
        events.push({type:'runtime-dispose'});
        state.disposed = true; state.attached = false; notify();
        const error = behavior.disposeError; behavior.disposeError = null;
        if (behavior.disposeGate) await behavior.disposeGate.promise;
        if (error) throw error;
        return snapshot();
      }
    };
    runtimes.push(runtime); events.push({type:'runtime-create', options});
    return runtime;
  }
  async function sessionFor(kind, options) {
    const openingGate = behavior.openingGate; behavior.openingGate = null;
    if (openingGate) await openingGate.promise;
    events.push({type:kind, options});
    const appPid = kind === 'connect' ? options.appPid : 301 + 2 * launchSequence++;
    const backendPid = kind === 'connect' ? options.backendPid : appPid + 1;
    if (kind === 'launch') behavior.running.push([appPid, appExecutable], [backendPid, helperBackendPath]);
    const ready = deferred();
    const controller = new AbortController();
    const session = {
      appPid, phase:'starting', error:null, paused:true, restored:false,
      process:kind === 'connect' ? null : {pid:appPid, exitCode:null, signalCode:null,
        kill() { assert.fail('manager must not kill the app'); }},
      ready:ready.promise,
      getStatus:() => ({phase:session.phase, appPid, backendPid,
        inspectorUrl:receipt.inspectorUrl, error:session.error}),
      transition(phase, error = null) {
        session.phase = phase; session.error = error?.message ?? null;
        if (phase === 'exiting' || phase === 'exited' || phase === 'failed') {
          controller.abort(); session.paused = false;
          ready.reject(error ?? new Error('fixture App exiting'));
        }
        options.onStateChange(session.getStatus(), session);
      },
      async restart(pid) {
        session.transition('attaching');
        behavior.running = behavior.running.filter(([current]) => current !== backendPid);
        behavior.running.push([pid, helperBackendPath]);
        await options.onBackendSpawn(pid, {signal:controller.signal, sequence:2, appPid, inspectorUrl:receipt.inspectorUrl});
        session.transition('running');
      },
      async restore() {
        events.push({type:'restore', kind}); controller.abort();
        session.transition('restoring');
        const gate = behavior.restoreGate; behavior.restoreGate = null;
        if (gate) await gate.promise;
        if (behavior.restoreError) throw behavior.restoreError;
        if (session.phase !== 'exiting' && session.phase !== 'exited') {
          session.restored = true; session.paused = false; session.transition('restored');
        }
        ready.reject(new Error('fixture session restored before ready'));
      }
    };
    ready.promise.catch(() => {});
    sessions.push(session);
    session.transition('starting');
    if (kind === 'connect' && behavior.connectError) {
      session.transition('failed', behavior.connectError);
      throw Object.assign(behavior.connectError, {session});
    }
    Promise.resolve().then(async () => {
      session.transition('attaching');
      await options.onBackendSpawn(backendPid, {signal:controller.signal, sequence:1,
        appPid, inspectorUrl:receipt.inspectorUrl});
      if (behavior.readyError) throw behavior.readyError;
      if (controller.signal.aborted || behavior.holdReady) return;
      session.paused = false; session.transition('running'); ready.resolve(backendPid);
    }).catch(error => {
      if (!controller.signal.aborted) session.transition('failed', error);
      ready.reject(error);
    });
    return session;
  }
  const context = vm.createContext({
    execFile, promisify, join, resolve, relative, sep, constants, homedir:() => '/fixture/home',
    process:{pid:303, env:{FROM_PROCESS:'host', SHARED_ENV:'host'}, kill(pid, signal) {
      events.push({type:'kill', pid, signal});
      assert.equal(signal, 'SIGKILL');
      assert.equal(behavior.running.find(([current]) => current === pid)?.[1], helperBackendPath,
        'only the recorded helper backend may be terminated');
      const error = behavior.killError; behavior.killError = null;
      if (!error || error.code === 'ESRCH') {
        behavior.running = behavior.running.filter(([current]) => current !== pid);
        behavior.disposeGate?.resolve();
      }
      if (error) throw error;
      return true;
    }},
    readFile:async path => {
      events.push({type:'read', path});
      if (path === appStoragePath && behavior.mainReadError) throw behavior.mainReadError;
      if (!files.has(path)) throw absent(path);
      return files.get(path);
    },
    access:async (path, mode) => {
      events.push({type:'access', path, mode});
      if (behavior.accessError) throw behavior.accessError;
    },
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
    prepareBackendCopy:async options => { events.push({type:'prepare', options}); return {binaryPath:helperBackendPath, buildCL:'1017595969', layout:fixtureLayout}; },
    inspectBackendBinary:async path => { events.push({type:'inspect', path}); return fixtureLayout; },
    createBackendRuntime,
    launchBackendApp:options => sessionFor('launch', options),
    connectBackendApp:options => sessionFor('connect', options),
    setTimeout, clearTimeout, AbortController, URL,
  });
  vm.runInContext(`${source}\nglobalThis.createManager = createBackendManager;`, context, {filename:'runtime/backend-manager.mjs'});
  const manager = context.createManager({stateDir, runtimeDir, appPath, appStoragePath, onChange:status => statuses.push(status)});
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
  assert.match(refused.message, /覆盖未启用/);
  assert.equal(running.count('prepare'), 0);
  assert.equal(running.count('launch'), 0);
  assert.deepEqual(running.events.filter(event => event.command === '/usr/bin/open').map(event => event.args), [[appPath]]);

  const normal = fixture({targetTokens:null}); t.after(() => normal.manager.dispose());
  await normal.manager.ready; await normal.manager.launch();
  assert.deepEqual(normal.events.filter(event => event.command === '/usr/bin/open').map(event => event.args), [[appPath]]);
  assert.equal(normal.count('prepare'), 0);
  assert.equal(normal.count('launch'), 0);
  assert.equal(normal.count('runtime-create'), 0);

  for (const afterExit of [[], [[101, '/Applications/Other.app/Contents/MacOS/Other']], [[202, '/fixture/reused-backend']]]) {
    const ended = fixture({savedReceipt:receipt, running:[[101, appExecutable], [202, helperBackendPath]]});
    t.after(() => ended.manager.dispose());
    await ended.manager.ready;
    assert.equal(ended.sessions[0].process, null, 'reconnected sessions have no ChildProcess exit event');
    ended.behavior.running = [...afterExit];
    ended.sessions[0].transition('failed', new Error('fixture Inspector closed'));
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
    assert.equal(ended.count('kill'), 0, 'missing or reused backend PIDs are never terminated');
    for (const [oldPid, oldPath] of afterExit) assert.ok(
      ended.behavior.running.some(([pid, path]) => pid === oldPid && path === oldPath),
      'the process reusing an old PID remains untouched');
  }
});

test('重复打开只聚焦已有窗口，默认设置不准备后台副本', async t => {
  const active = fixture();
  t.after(() => active.manager.dispose());
  await active.manager.ready;
  const [first, repeated] = await Promise.all([active.manager.launch(), active.manager.launch()]);
  assert.equal(first.launched, true);
  assert.equal(repeated.launched, false);
  assert.equal(repeated.message, '');
  assert.equal(active.count('launch'), 1);
  assert.equal(active.count('prepare'), 1);
  assert.deepEqual(active.events.filter(event => event.command === '/usr/bin/open').map(event => event.args), [[appPath]]);

  const defaultRunning = fixture({targetTokens:null, running:[[101, appExecutable]]});
  t.after(() => defaultRunning.manager.dispose());
  await defaultRunning.manager.ready;
  const focused = await defaultRunning.manager.launch();
  assert.equal(focused.launched, false);
  assert.equal(focused.message, '');
  assert.equal(defaultRunning.count('prepare'), 0);
  assert.equal(defaultRunning.count('runtime-create'), 0);
  assert.deepEqual(defaultRunning.events.filter(event => event.command === '/usr/bin/open').map(event => event.args), [[appPath]]);
});

test('a later launch reaps an orphan before the serial queue can finish its pending native disposal', {timeout:2000}, async t => {
  const f = fixture({savedReceipt:receipt, running:[[101, appExecutable], [202, helperBackendPath]]});
  const gate = deferred();
  t.after(async () => { gate.resolve(); await f.manager.dispose(); });
  await f.manager.ready;
  f.behavior.disposeGate = gate;
  f.behavior.disposeError = new Error('fixture native target was destroyed');
  f.sessions[0].transition('failed', new Error('fixture Inspector closed'));
  const refreshing = f.manager.refresh();
  await nextTurn();
  assert.equal(f.count('runtime-dispose'), 1);
  assert.equal(f.count('kill'), 0, 'Inspector loss cannot terminate a still-running App or its backend');

  // The first release saw a live App. It exits while native cleanup is pending.
  f.behavior.running = [[202, helperBackendPath]];
  const launched = await f.manager.launch();
  assert.equal(launched.launched, true, 'launch must reap before waiting behind refresh in the serial queue');
  assert.equal((await refreshing).active, false);
  assert.deepEqual(f.events.filter(event => event.type === 'kill'), [{type:'kill', pid:202, signal:'SIGKILL'}]);
  assert.equal(f.manager.getStatus().active, true);
  assert.equal(f.manager.getStatus().error, null, 'an ended native target cannot keep the old owner stuck');
  assert.equal(JSON.parse(f.files.get(receiptPath)).appPid, 301);
});

test('an App exit reaps only its recorded backend before disposal and accepts an ESRCH exit race', {timeout:2000}, async t => {
  const f = fixture({savedReceipt:receipt, running:[[101, appExecutable], [202, helperBackendPath]]});
  const gate = deferred();
  t.after(async () => { gate.resolve(); await f.manager.dispose(); });
  await f.manager.ready;
  f.behavior.running = [[202, helperBackendPath]];
  f.behavior.disposeGate = gate;
  f.behavior.killError = Object.assign(new Error('fixture backend already exited'), {code:'ESRCH'});
  f.sessions[0].transition('exited');
  const status = await f.manager.refresh();
  assert.equal(status.active, false);
  assert.equal(status.error, null);
  assert.equal(f.files.has(receiptPath), false);
  assert.ok(f.events.findIndex(event => event.type === 'kill') < f.events.findIndex(event => event.type === 'runtime-dispose'));
  assert.equal(f.count('restore'), 0);
  assert.equal((await f.manager.launch()).launched, true);
});

test('helper reload reaps a verified orphan before discarding its receipt', async t => {
  const f = fixture({savedReceipt:receipt, running:[[202, helperBackendPath]]});
  t.after(() => f.manager.dispose());
  await f.manager.ready;
  assert.deepEqual(f.events.filter(event => event.type === 'kill'), [{type:'kill', pid:202, signal:'SIGKILL'}]);
  assert.equal(f.files.has(receiptPath), false);
  assert.equal(f.count('connect'), 0);
  assert.equal(f.count('runtime-create'), 0);
  assert.equal(f.manager.getStatus().error, null);
  assert.equal((await f.manager.launch()).launched, true);
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

test('App退出通知不依赖refresh，exiting期间不聚焦、不重试、不kill', async t => {
  const f = fixture();
  const gate = deferred();
  t.after(async () => { gate.resolve(); await f.manager.dispose(); });
  await f.manager.ready; await f.manager.launch();
  f.behavior.disposeGate = gate;
  f.sessions[0].transition('exiting');
  assert.equal(f.manager.getStatus().active, false);
  assert.equal(f.statuses.at(-1).active, false);
  assert.equal(f.manager.getStatus().error, null);
  const again = await f.manager.launch();
  assert.equal(again.launched, false);
  assert.match(again.message, /正在退出/);
  assert.equal(f.count('restore'), 0);
  assert.equal(f.count('kill'), 0);
  assert.equal(f.count('launch'), 1);
  assert.equal(f.events.some(event => event.command === '/usr/bin/open'), false);
  gate.resolve();
  f.behavior.running = [];
  f.sessions[0].transition('exited');
  await f.manager.refresh();
  assert.equal(f.files.has(receiptPath), false);
  assert.equal(f.count('runtime-dispose'), 1);
  assert.equal(f.manager.getStatus().error, null);
});

test('native掉线立即inactive但保留launcher，官方重启可以重新attach', async t => {
  const f = fixture();
  t.after(() => f.manager.dispose());
  await f.manager.ready; await f.manager.launch();
  f.runtimes[0].disconnect();
  assert.equal(f.manager.getStatus().active, false);
  assert.equal(f.statuses.at(-1).active, false);
  await f.manager.refresh();
  assert.equal(f.count('restore'), 0);
  assert.equal(f.count('runtime-dispose'), 0);
  assert.equal(f.count('status'), 0, '已知断线不发健康RPC');
  await f.sessions[0].restart(402);
  assert.equal(f.manager.getStatus().active, true);
  assert.equal(f.runtimes[0].state.pid, 402);
  assert.equal(JSON.parse(f.files.get(receiptPath)).backendPid, 402);
  f.behavior.statusError = new Error('fixture health failed');
  await f.manager.refresh();
  await nextTurn();
  assert.equal(f.manager.getStatus().active, false);
  assert.match(f.manager.getStatus().error, /fixture health failed/);
  assert.equal(f.count('restore'), 1);
  assert.equal(f.count('runtime-dispose'), 1);
});

test('初始化attach期间退出后终态不复活，晚到旧owner事件不影响新owner', async t => {
  const f = fixture({savedReceipt:receipt, running:[[101, appExecutable], [202, helperBackendPath]]});
  const gate = deferred(); f.behavior.attachGate = gate;
  t.after(async () => { gate.resolve(); await f.manager.dispose(); });
  await nextTurn();
  const old = f.sessions[0];
  old.transition('exiting');
  assert.equal(f.manager.getStatus().active, false);
  f.behavior.running = [];
  old.transition('exited');
  gate.resolve();
  await f.manager.ready;
  assert.equal(f.manager.getStatus().error, null);
  assert.equal(f.count('restore'), 0);
  assert.equal(f.files.has(receiptPath), false);
  await f.manager.launch();
  const currentReceipt = f.files.get(receiptPath);
  old.transition('failed', new Error('late old failure'));
  f.runtimes[0].disconnect();
  await nextTurn();
  assert.equal(f.manager.getStatus().active, true);
  assert.equal(f.manager.getStatus().error, null);
  assert.equal(f.files.get(receiptPath), currentReceipt);
  assert.equal(f.count('runtime-dispose'), 1);
});

test('restore中退出不覆盖exited；活App恢复失败仍清理native并报告', async t => {
  const exiting = fixture();
  const gate = deferred();
  t.after(async () => { gate.resolve(); await exiting.manager.dispose(); });
  await exiting.manager.ready; await exiting.manager.launch();
  exiting.behavior.statusError = new Error('fixture health failed');
  exiting.behavior.restoreGate = gate;
  const refreshing = exiting.manager.refresh();
  await nextTurn();
  assert.equal(exiting.sessions[0].phase, 'restoring');
  assert.equal(exiting.manager.getStatus().active, false);
  exiting.behavior.running = [];
  exiting.sessions[0].transition('exited');
  gate.resolve();
  await refreshing;
  assert.equal(exiting.sessions[0].phase, 'exited');
  assert.equal(exiting.manager.getStatus().error, null);

  const failed = fixture();
  t.after(() => failed.manager.dispose());
  await failed.manager.ready; await failed.manager.launch();
  failed.behavior.restoreError = new Error('fixture restore failed');
  failed.sessions[0].transition('failed', new Error('fixture inspector failed'));
  await failed.manager.refresh();
  await nextTurn();
  assert.equal(failed.manager.getStatus().active, false);
  assert.match(failed.manager.getStatus().error, /fixture inspector failed.*fixture restore failed/);
  assert.equal(failed.count('runtime-dispose'), 1);
  assert.equal(failed.count('kill'), 0);
  failed.behavior.running = [];
  failed.sessions[0].transition('exited');
  await failed.manager.refresh();
  assert.equal((await failed.manager.launch()).launched, true, '旧进程已结束后不再要求恢复旧上下文');
  assert.equal(failed.manager.getStatus().error, null);
  assert.equal(failed.files.has(receiptPath), true);
});

test('dispose等待尚未交出session的opening并释放晚到资源', async () => {
  const f = fixture(), gate = deferred();
  await f.manager.ready;
  f.behavior.openingGate = gate;
  const launching = f.manager.launch();
  await nextTurn();
  const stopping = f.manager.dispose();
  assert.equal(f.manager.getStatus().active, false);
  gate.resolve();
  const [launched, stopped] = await Promise.all([launching, stopping]);
  assert.equal(launched.launched, false);
  assert.equal(stopped.active, false);
  assert.equal(stopped.error, null);
  assert.equal(f.count('restore'), 1);
  assert.equal(f.count('runtime-dispose'), 1);
});

test('退出后的孤儿回收不排在被它阻塞的原生清理之后', {timeout:2000}, async t => {
  for (const reconnect of [false, true]) {
    const f = reconnect ? fixture({savedReceipt:receipt, running:[[101, appExecutable], [202, helperBackendPath]]}) : fixture();
    const gate = deferred();
    t.after(async () => { gate.resolve(); await f.manager.dispose(); });
    await f.manager.ready;
    if (!reconnect) await f.manager.launch();
    f.behavior.disposeGate = gate;
    f.sessions[0].transition('exiting');
    await nextTurn();
    assert.equal(f.count('runtime-dispose'), 1);
    assert.equal(f.count('kill'), 0);
    await f.manager.refresh();
    assert.equal(f.manager.getStatus().active, false, 'App尚未退出时健康检查也必须返回，后续检查才能继续回收');
    f.behavior.running = f.behavior.running.filter(([, path]) => path !== appExecutable);
    if (!reconnect) f.sessions[0].transition('exited');
    await f.manager.refresh();
    assert.equal(f.count('kill'), 1, '只有回收该孤儿后台才能完成dispose');
    assert.equal(f.count('runtime-dispose'), 1);
    assert.equal(f.files.has(receiptPath), false);
    assert.equal(f.manager.getStatus().error, null);
  }
});

test('receipt写入失败不变成永久清理错误，磁盘恢复后能再次启动', async t => {
  const f = fixture();
  t.after(() => f.manager.dispose());
  await f.manager.ready;
  f.behavior.writeError = new Error('fixture receipt disk full');
  const failed = await f.manager.launch();
  assert.equal(failed.launched, false);
  assert.match(failed.message, /receipt disk full/);
  assert.doesNotMatch(failed.message, /恢复正常执行失败/);
  f.behavior.running = [];
  f.sessions[0].transition('exited');
  await f.manager.refresh();
  assert.equal((await f.manager.launch()).launched, true);
  assert.equal(f.manager.getStatus().active, true);
  assert.equal(f.manager.getStatus().error, null);
});

test('receipt只传递安装定位，重连沿用描述地址而后台重启重新定位', async t => {
  const savedReceipt = {...receipt, nativeDescriptor:'0x12340000'};
  const f = fixture({savedReceipt, running:[[101, appExecutable], [202, helperBackendPath]]});
  t.after(() => f.manager.dispose());
  await f.manager.ready;
  assert.equal(f.events.find(event => event.type === 'attach').descriptor, savedReceipt.nativeDescriptor);
  assert.equal(f.runtimes[0].options.machExecutablePath,
    join(runtimeDir, '..', 'Antigravity汉化助手.app', 'Contents', 'MacOS', 'AntigravityBackendMach'));
  assert.equal(f.runtimes[0].options.targetTokens, 400000, '额度从持久设置应用');
  const located = f.events.find(event => event.type === 'native-install').receipt;
  assert.equal(located.nativeDescriptor, savedReceipt.nativeDescriptor, '安装前先保存定位地址');
  assert.equal(Object.hasOwn(located, 'targetTokens'), false);
  assert.equal(Object.hasOwn(located, 'generation'), false);
  await f.sessions[0].restart(402);
  assert.equal(f.events.filter(event => event.type === 'attach').at(-1).descriptor, undefined);
  assert.equal(JSON.parse(f.files.get(receiptPath)).nativeDescriptor, '0x1920000');
});

test('执行器缺失在创建副本前失败，安装定位落盘失败不能发布额度', async t => {
  const missing = fixture();
  t.after(() => missing.manager.dispose());
  await missing.manager.ready;
  missing.behavior.accessError = new Error('fixture Mach executor missing');
  const unavailable = await missing.manager.launch();
  assert.equal(unavailable.launched, false);
  assert.match(unavailable.message, /Mach executor missing/);
  assert.equal(missing.count('prepare'), 0);
  assert.equal(missing.count('launch'), 0);

  const failed = fixture();
  t.after(() => failed.manager.dispose());
  await failed.manager.ready;
  failed.behavior.installationWriteError = new Error('fixture installation receipt disk full');
  const result = await failed.manager.launch();
  assert.equal(result.launched, false);
  assert.match(result.message, /installation receipt disk full/);
  assert.equal(failed.count('native-install'), 0);
  assert.equal(failed.manager.getStatus().active, false);
  assert.equal(failed.sessions[0].restored, true);
  assert.equal(failed.runtimes[0].state.disposed, true);
});

test('仅主额度也走同一副本启动与receipt重连，不另存主设置', async t => {
  const mainSettings = {'antigravityChineseHelper.contextLimit.1437':'512000', unrelated:'keep'};
  const f = fixture({targetTokens:null, mainSettings});
  t.after(() => f.manager.dispose());
  await f.manager.ready;
  assert.equal(f.manager.getStatus().mainOverrides, true);
  assert.equal(f.manager.getStatus().nativeReady, false);
  assert.match(f.manager.getStatus().mainMessage, /主代理上下文已保存.*预算适配未启用/);
  assert.equal((await f.manager.launch()).launched, true);
  const status = f.manager.getStatus();
  assert.equal(status.nativeReady, true);
  assert.equal(status.active, false, 'active继续只表示子代理额度覆盖');
  assert.equal(status.targetTokens, null);
  assert.equal(status.mainMessage, '');
  assert.equal(f.count('prepare'), 1);
  assert.equal(f.count('launch'), 1);
  assert.equal(f.runtimes[0].options.targetTokens, null);
  const savedReceipt = JSON.parse(f.files.get(receiptPath));
  assert.equal(Object.hasOwn(savedReceipt, 'mainOverrides'), false);
  assert.equal(Object.hasOwn(savedReceipt, 'mainLimits'), false);
  assert.equal(f.files.get(appStoragePath), JSON.stringify(mainSettings));
  assert.ok(f.writes.every(write => write.path !== appStoragePath), '主设置只有官方nativeStorage一份事实');
  assert.equal(f.savedLimit(), null);
  await f.manager.dispose();
  const reconnect = fixture({files:f.files, running:f.behavior.running});
  t.after(() => reconnect.manager.dispose());
  await reconnect.manager.ready;
  assert.equal(reconnect.count('connect'), 1);
  assert.equal(reconnect.count('prepare'), 0);
  assert.equal(reconnect.manager.getStatus().nativeReady, true);
  assert.equal(reconnect.manager.getStatus().active, false);
  assert.equal(reconnect.manager.getStatus().mainOverrides, true);
});

test('主设置通知重读同一存储但不自动重启，冷启动再读当前设置', async t => {
  const f = fixture({targetTokens:null, running:[[101, appExecutable]]});
  t.after(() => f.manager.dispose());
  await f.manager.ready;
  assert.equal(f.manager.getStatus().mainOverrides, false);
  f.files.set(appStoragePath, JSON.stringify({'antigravityChineseHelper.contextLimit.1437':'512000'}));
  const stored = await f.manager.mainSettingsChanged();
  assert.equal(stored.mainOverrides, true);
  assert.equal(stored.nativeReady, false);
  assert.match(stored.mainMessage, /重新启动/);
  assert.equal(f.count('launch'), 0);
  assert.equal(f.count('prepare'), 0);
  assert.equal(f.count('kill'), 0);
  const focused = await f.manager.launch();
  assert.equal(focused.launched, false);
  assert.match(focused.message, /主代理上下文已保存/);
  assert.equal(f.count('prepare'), 0);
  f.files.set(appStoragePath, '{}');
  const removed = await f.manager.mainSettingsChanged();
  assert.equal(removed.mainOverrides, false);
  assert.equal(removed.mainMessage, '');
  f.behavior.running = [];
  // A new saved value must be observed even without a live renderer notification.
  f.files.set(appStoragePath, JSON.stringify({'antigravityChineseHelper.contextLimit.1438':'512000'}));
  assert.equal((await f.manager.launch()).launched, true);
  assert.equal(f.manager.getStatus().nativeReady, true);
  assert.equal(f.manager.getStatus().mainOverrides, true);
  assert.equal(f.count('prepare'), 1);
});

test('恢复子代理默认保留主预算同一原生安装，子设置失败不污染主状态', async t => {
  const f = fixture({mainSettings:{'antigravityChineseHelper.contextLimit.1437':'512000'}});
  t.after(() => f.manager.dispose());
  await f.manager.ready; await f.manager.launch();
  f.behavior.writeError = new Error('fixture child settings disk full');
  const failed = await f.manager.setLimit(700000);
  assert.match(failed.error, /child settings disk full/);
  const mainStatus = await f.manager.mainSettingsChanged();
  assert.equal(mainStatus.nativeReady, true);
  assert.equal(mainStatus.mainMessage, '');
  assert.match(mainStatus.error, /child settings disk full/, '主通知不清除不相关子设置诊断');
  const restored = await f.manager.setLimit(null);
  assert.equal(restored.active, false);
  assert.equal(restored.nativeReady, true);
  assert.equal(restored.mainOverrides, true);
  assert.equal(restored.mainMessage, '');
  assert.equal(f.runtimes[0].state.targetTokens, null);
  assert.equal(f.count('runtime-create'), 1);
  assert.equal(f.count('runtime-dispose'), 0);
  assert.equal(f.count('restore'), 0);
});

test('主存储读取失败阻止误用默认启动，通知准确失败且不回显JSON', async t => {
  const f = fixture({targetTokens:null});
  t.after(() => f.manager.dispose());
  await f.manager.ready;
  f.files.set(appStoragePath, '{"private":"fixture-do-not-return');
  await assert.rejects(f.manager.mainSettingsChanged(), /无法读取 Antigravity 的主代理上下文设置/);
  const failed = f.manager.getStatus();
  assert.equal(failed.nativeReady, false);
  assert.match(failed.mainMessage, /无法读取/);
  assert.doesNotMatch(failed.error, /private|do-not-return/);
  const blocked = await f.manager.launch();
  assert.equal(blocked.launched, false);
  assert.match(blocked.message, /无法读取/);
  assert.equal(f.count('launch'), 0);
  assert.equal(f.events.some(event => event.command === '/usr/bin/open'), false);
  f.files.set(appStoragePath, JSON.stringify({
    unrelated:'512000', 'antigravityChineseHelper.contextLimit.1437':'invalid',
    'antigravityChineseHelper.contextLimit.1438':null,
  }));
  const recovered = await f.manager.mainSettingsChanged();
  assert.equal(recovered.mainOverrides, false);
  assert.equal(recovered.error, null);
  assert.equal(recovered.mainMessage, '');
  assert.equal((await f.manager.launch()).launched, true);
  assert.equal(f.count('prepare'), 0, '没有有效主/子额度时仍走普通启动');
});
