import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpClient } from './cdp.mjs';

const adapterKey = '__antigravityChineseBackendAdapter';
const adapterSource = 'antigravity-chinese-helper://backend-launch';
const exec = promisify(execFile);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Startup/attachment can fail before the caller receives the session handle.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function inspectorPorts(pid, signal) {
  let stdout;
  try {
    ({ stdout } = await exec('/usr/sbin/lsof', [
      '-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn',
    ], { signal, maxBuffer: 128 * 1024 }));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    // lsof uses exit 1 when this newly spawned PID has no listening socket yet.
    if (error.code === 1 && !error.stderr?.trim()) return [];
    throw new Error('Could not inspect application listening sockets', { cause: error });
  }
  const ports = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^n127\.0\.0\.1:(\d+)$/.exec(line);
    const port = match && Number(match[1]);
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

async function inspectorAtPort(port, signal) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal, redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); return null; }
  const targets = await response.json();
  if (!Array.isArray(targets)) return null;
  for (const target of targets) {
    if (target.type !== 'node' || typeof target.webSocketDebuggerUrl !== 'string') continue;
    let url;
    try { url = new URL(target.webSocketDebuggerUrl); } catch { continue; }
    if (url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.port === String(port) &&
        !url.username && !url.password && !url.search && !url.hash && /^\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
      return url.href;
    }
  }
  return null;
}

async function waitForInspector(child, timeoutMs) {
  const controller = new AbortController();
  const { signal } = controller;
  const timeout = new Error('Main inspector startup timed out');
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  const onError = error => controller.abort(error);
  const onExit = () => controller.abort(new Error('Application exited before its main inspector opened'));
  child.once('error', onError);
  child.once('exit', onExit);
  try {
    while (!signal.aborted) {
      // A failed spawn has no PID; keep its error listener until Node reports it.
      if (Number.isInteger(child.pid) && child.pid > 0) {
        for (const port of await inspectorPorts(child.pid, signal)) {
          const remaining = Math.ceil(deadline - performance.now());
          if (remaining <= 0) throw timeout;
          try {
            // One unrelated listener must not consume the whole startup budget.
            const probe = AbortSignal.any([signal, AbortSignal.timeout(Math.min(500, remaining))]);
            const url = await inspectorAtPort(port, probe);
            signal.throwIfAborted();
            if (url) return url;
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            // The owned process may also expose Chromium CDP or its host bridge.
            // Only a validated Node inspector endpoint is accepted.
          }
        }
      }
      await delay(100, undefined, { signal });
    }
    throw signal.reason;
  } catch (error) {
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(timer);
    child.off('error', onError);
    child.off('exit', onExit);
  }
}

// Initial launch supplies lexical require; reconnect runs in the global context.
// This function must remain self-contained: its source runs inside Electron.
function installSpawnAdapter(config, pausedChild) {
  const load = typeof require === 'function' ? require : process.mainModule?.require.bind(process.mainModule);
  if (!load) throw new Error('Main-process CommonJS loader is unavailable');
  const childProcess = load('child_process');
  const { StringDecoder } = load('string_decoder');
  const previous = globalThis[config.key];
  const sequence = previous?.sequence ?? 0;
  const pending = previous?.pending ?? null;
  const previousSourceURL = previous?.sourceURL;
  previous?.uninstall();
  const original = childProcess.spawn;
  const state = { owner: config.owner, sourceURL: config.sourceURL, sequence, pending, active: true };
  const waiting = new Set();
  // This is the same readiness line used by the original languageServer.js.
  const portPattern = /listening on \w+ port at (\d+) for HTTP(S)?\b/i;
  // A partial line needs a real following character to establish the word
  // boundary. A temporary end-of-chunk must not turn "HTTPX" into "HTTP".
  const partialPortPattern = /listening on \w+ port at (\d+) for HTTP(S)?\b./i;
  function watchBackendReady(child, childSequence) {
    let finished = false;
    const subscriptions = [];
    const cleanup = () => {
      finished = true;
      for (const [stream, listener] of subscriptions) stream.off('data', listener);
      child.off('exit', cleanup);
      child.off('close', cleanup);
      waiting.delete(cleanup);
    };
    function helperBackendReady() {
      if (finished) return;
      cleanup();
      if (!state.active || child.exitCode !== null || child.signalCode !== null) return;
      state.pending = { pid: child.pid, sequence: childSequence, stage: 'ready' };
      // The Go server has reached its own ready log, so native startup has run.
      // This listener runs before the original pipe/readline listeners receive
      // this exact chunk. Await instrumentation before they consume its port.
      debugger;
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const decoder = new StringDecoder('utf8');
      let tail = '', lineMatched = false;
      const onData = chunk => {
        if (finished || !state.active) return;
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        const lines = (tail + text).split(/[\r\n]/);
        for (let index = 0; index < lines.length - 1; index++) {
          if (lineMatched || portPattern.test(lines[index])) { helperBackendReady(); return; }
          lineMatched = false;
        }
        const partial = lines[lines.length - 1];
        lineMatched ||= partialPortPattern.test(partial);
        // Keep a bounded fragment per stream. Remember an already-confirmed
        // match separately if a very long line extends past the retained tail.
        tail = partial.slice(-8192);
      };
      subscriptions.push([stream, onData]);
      stream.prependListener('data', onData);
    }
    waiting.add(cleanup);
    child.once('exit', cleanup);
    child.once('close', cleanup);
    // Do not add an 'error' listener: native spawn errors retain their original
    // handling, including an unhandled error when the app did not handle it.
    state.pending = { pid: child.pid, sequence: childSequence, stage: 'starting' };
  }
  function helperBackendSpawn(command, args, options) {
    if (!state.active || command !== config.officialBackendPath ||
        !Array.isArray(args) || !args.includes('--standalone')) {
      return original.apply(this, arguments);
    }
    const child = original.call(this, config.helperBackendPath, [...args, ...config.backendArgs], options);
    // A failed native spawn has no PID. Preserve its ordinary error lifecycle.
    if (!child.pid) return child;
    watchBackendReady(child, ++state.sequence);
    return child;
  }
  state.uninstall = () => {
    state.active = false;
    for (const cleanup of waiting) cleanup();
    if (childProcess.spawn === helperBackendSpawn) childProcess.spawn = original;
    if (globalThis[config.key] === state) delete globalThis[config.key];
  };
  childProcess.spawn = helperBackendSpawn;
  globalThis[config.key] = state;
  const waitingForReady = pausedChild?.pid && previousSourceURL === config.pausedSourceURL && pausedChild.pid === pending?.pid;
  if (waitingForReady) watchBackendReady(pausedChild, ++state.sequence);
  return { sequence, previousSourceURL, waitingForReady: Boolean(waitingForReady) };
}

async function validateBackendOptions({ enabled, officialBackendPath, helperBackendPath, backendArgs, onBackendSpawn }) {
  if (enabled !== true) throw new Error('Backend adaptation must be explicitly enabled');
  if (typeof onBackendSpawn !== 'function') throw new TypeError('onBackendSpawn is required');
  for (const path of [officialBackendPath, helperBackendPath]) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Executable paths must be absolute');
    await access(path, constants.X_OK);
  }
  if (helperBackendPath === officialBackendPath) throw new Error('Use a helper-owned backend copy');
  if (!Array.isArray(backendArgs) || backendArgs.some(arg => typeof arg !== 'string')) {
    throw new TypeError('Backend arguments must be an array of strings');
  }
}

function createBackendController({
  child = null, appPid, officialBackendPath, helperBackendPath, backendArgs,
  onBackendSpawn, onError, timeoutMs,
}) {
  const firstBackend = deferred();
  const firstPause = deferred();
  const owner = randomUUID();
  const sourceURL = `${adapterSource}/${owner}`;
  const scripts = new Map();
  let client, inspectorUrl, pause = null, attachment = null;
  let active = true, installed = false, handlingSpawns = false, waitingForInitialPause = false, restorePromise;
  let verifiedTarget = false, identityRejected = false;
  let status = { phase: 'starting', appPid, backendPid: null, sequence: 0, error: null };

  const fail = error => {
    if (!active || status.phase === 'failed') return;
    status = { ...status, phase: 'failed', error: error.message };
    firstBackend.reject(error);
    firstPause.reject(error);
    try { onError?.(error, session); } catch { /* The caller owns reporting. */ }
  };
  const evaluate = async (expression, frame) => {
    const result = frame
      ? await client.call('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: true })
      : await client.call('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Main-process adapter evaluation failed');
    return result.result?.value;
  };
  const resume = async ownedPause => {
    if (pause !== ownedPause) return;
    await client.call('Debugger.resume');
    if (pause === ownedPause) pause = null;
  };
  const attachBackend = async (pending, ownedPause = null) => {
    attachment?.abort();
    const controller = new AbortController();
    attachment = controller;
    status = { ...status, phase: 'attaching', backendPid: pending.pid, sequence: pending.sequence, error: null };
    try {
      await onBackendSpawn(pending.pid, {
        signal: controller.signal, sequence: pending.sequence, stage: pending.stage ?? 'spawn', appPid, inspectorUrl,
      });
      if (!active || attachment !== controller || controller.signal.aborted || ownedPause && pause !== ownedPause) return;
      if (ownedPause) await resume(ownedPause);
      if (!active || attachment !== controller || controller.signal.aborted) return;
      if (status.sequence === pending.sequence && !pause) status = { ...status, phase: 'running', error: null };
      firstBackend.resolve(pending.pid);
    } catch (error) {
      if (active && attachment === controller && !controller.signal.aborted) throw error;
    } finally {
      if (attachment === controller) attachment = null;
    }
  };
  const readPending = async ownedPause => {
    const state = await evaluate(`(() => {const s = globalThis[${JSON.stringify(adapterKey)}]; return s && {owner:s.owner,pending:s.pending};})()`, ownedPause.frame);
    if (!active || pause !== ownedPause) return;
    if (state?.owner !== owner) throw new Error('Backend adapter is now managed by another connection');
    const pending = state.pending;
    if (!Number.isInteger(pending?.pid) || pending.pid <= 0 || !Number.isInteger(pending.sequence)) throw new Error('Backend spawn pause did not contain a child PID');
    return pending;
  };
  const handleBackendPause = async ownedPause => {
    const pending = await readPending(ownedPause);
    if (!pending) return;
    if (pending.sequence <= status.sequence) throw new Error('Backend spawn sequence did not advance');
    await attachBackend(pending, ownedPause);
  };
  const watchClient = () => {
    client.on('Debugger.scriptParsed', event => scripts.set(event.scriptId, event.url));
    client.on('Debugger.resumed', () => { pause = null; });
    client.on('Debugger.paused', event => {
      const frame = event.callFrames?.[0];
      if (!frame) return;
      const source = frame.url || scripts.get(frame.location.scriptId);
      const owned = waitingForInitialPause || source === sourceURL && ['helperBackendReady', 'helperBackendSpawn'].includes(frame.functionName);
      pause = { frame, source, owned };
      if (waitingForInitialPause) firstPause.resolve(pause);
      else if (owned && active && handlingSpawns) void handleBackendPause(pause).catch(fail);
    });
    client.on('close', () => {
      attachment?.abort();
      if (active) fail(new Error('Main inspector disconnected; backend adaptation is no longer managed'));
    });
  };
  const connectMain = async () => {
    verifiedTarget = false;
    client = await CdpClient.connect(inspectorUrl, timeoutMs);
    pause = null;
    scripts.clear();
    watchClient();
    await client.call('Runtime.enable');
    if (!waitingForInitialPause && await evaluate('process.pid') !== appPid) {
      identityRejected = true;
      const error = new Error('Saved inspector does not belong to the expected application PID');
      fail(error);
      client.close();
      throw error;
    }
    verifiedTarget = !waitingForInitialPause;
    await client.call('Debugger.enable');
  };
  const install = async (frame, legacyPause = null) => {
    const config = { key: adapterKey, owner, sourceURL, officialBackendPath, helperBackendPath, backendArgs,
      pausedSourceURL: legacyPause?.source };
    const childExpression = legacyPause ? 'child' : 'undefined';
    const expression = `(${installSpawnAdapter.toString()})(${JSON.stringify(config)},${childExpression})\n//# sourceURL=${sourceURL}`;
    const state = await evaluate(expression, frame);
    if (!Number.isInteger(state?.sequence)) throw new Error('Backend adapter was not installed');
    installed = true;
    status = { ...status, sequence: state.sequence };
    return state;
  };

  const session = {
    process: child,
    appPid,
    get inspectorUrl() { return inspectorUrl; },
    ready: firstBackend.promise,
    getStatus: () => ({ ...status }),
    getConnectionInfo: () => ({ appPid, inspectorUrl, backendPid: status.backendPid }),
    restore() {
      if (restorePromise) return restorePromise;
      active = false;
      attachment?.abort();
      firstBackend.reject(new Error('Backend adapter was restored before becoming ready'));
      restorePromise = (async () => {
        if (identityRejected || !verifiedTarget && !child) {
          client?.close();
          throw new Error('Cannot restore an unverified main process');
        }
        if (child && (child.exitCode !== null || child.signalCode !== null)) return;
        if (!client?.connected) {
          if (!inspectorUrl) throw new Error('Main inspector is unavailable; startup cannot be released');
          // A dropped inspector connection must not turn into a false successful
          // restore while its in-memory wrapper is still replacing processes.
          await connectMain();
        }
        if (client?.connected) {
          const result = installed ? await evaluate(`(() => {
            const state = globalThis[${JSON.stringify(adapterKey)}];
            if (!state) return 'absent';
            if (state.owner !== ${JSON.stringify(owner)}) return 'replaced';
            state.uninstall(); return 'removed';
          })()`) : 'absent';
          installed = false;
          // An earlier controller must not uninstall or resume its successor.
          if (result !== 'replaced') {
            if (pause?.owned) await resume(pause);
            if (!pause) {
              await client.call('Debugger.disable');
              await client.call('Runtime.runIfWaitingForDebugger');
            }
          }
          client.close();
        }
        // Swift Process.terminate() signals the helper runner's process group.
        // The app has its own group; these handles must not hold the runner open
        // after the adapter is restored while the independent app keeps running.
        child?.unref();
        status = { ...status, phase: 'restored', error: null };
      })().catch(error => {
        status = { ...status, phase: 'failed', error: `Adapter restore failed: ${error.message}` };
        restorePromise = undefined;
        throw error;
      });
      return restorePromise;
    },
  };
  child?.once('exit', () => {
    active = false;
    attachment?.abort();
    const error = new Error('Application exited before backend attachment completed');
    firstBackend.reject(error);
    firstPause.reject(error);
    status = { ...status, phase: 'exited' };
    client?.close();
  });

  return {
    async initialize(url, backendPid = null) {
      try {
        inspectorUrl = await url;
        waitingForInitialPause = backendPid === null;
        await connectMain();
        if (waitingForInitialPause) {
          await client.call('Runtime.runIfWaitingForDebugger');
          const timer = setTimeout(() => firstPause.reject(new Error('Initial main-process pause timed out')), timeoutMs);
          let initial;
          try { initial = await firstPause.promise; } finally { clearTimeout(timer); }
          if (!active) throw new Error('Application stopped during adapter startup');
          if (await evaluate('process.pid', initial.frame) !== appPid) throw new Error('Main inspector application PID changed');
          verifiedTarget = true;
          await install(initial.frame);
          waitingForInitialPause = false;
          handlingSpawns = true;
          status = { ...status, phase: 'waiting-for-backend' };
          await resume(initial);
        } else {
          // An old helper can have disappeared while its wrapper was paused.
          // Preserve that owned PID across replacement and finish its attachment.
          const legacyPause = pause?.frame.functionName === 'helperBackendSpawn' && pause.source?.startsWith(adapterSource) ? pause : null;
          const state = await install(legacyPause?.frame, legacyPause);
          if (pause && pause.source === state.previousSourceURL && ['helperBackendReady', 'helperBackendSpawn'].includes(pause.frame.functionName)) pause.owned = true;
          handlingSpawns = true;
          const ownedPause = pause?.owned ? pause : null;
          if (state.waitingForReady && ownedPause) {
            status = { ...status, phase: 'waiting-for-backend', backendPid };
            await resume(ownedPause);
          } else {
            const pending = ownedPause ? await readPending(ownedPause) : { pid: backendPid, sequence: state.sequence, stage: 'reconnect' };
            if (pending) await attachBackend(pending, ownedPause);
          }
          await session.ready;
        }
        return session;
      } catch (error) {
        fail(error);
        // Preserve access to recovery without ending any application process.
        error.session = session;
        throw error;
      }
    },
  };
}

/**
 * Launch a NEW app only after the caller confirms that no instance is running.
 * onBackendSpawn(pid, {signal, sequence, appPid, inspectorUrl}) must install the
 * native adapter before resolving and honor cancellation. For a new backend,
 * Electron pauses before consuming the LS's own ready line, after native startup.
 *
 * Returns a session with ready (first attachment), getConnectionInfo, getStatus
 * and restore. onError also reports later failures. Failure retains any owned
 * spawn pause for restore to release. restore never kills an app or removes
 * native instrumentation: the caller owns that cleanup. Importing does nothing.
 */
export async function launchBackendApp({
  enabled, appExecutable, officialBackendPath, helperBackendPath,
  appArgs = [], backendArgs = [], env = process.env,
  onBackendSpawn, onError, timeoutMs = 15000,
}) {
  await validateBackendOptions({ enabled, officialBackendPath, helperBackendPath, backendArgs, onBackendSpawn });
  if (typeof appExecutable !== 'string' || !isAbsolute(appExecutable)) throw new TypeError('Application executable must be absolute');
  await access(appExecutable, constants.X_OK);
  if (!Array.isArray(appArgs) || appArgs.some(arg => typeof arg !== 'string')) throw new TypeError('Application arguments must be an array of strings');
  if (appArgs.some(arg => /^--(?:inspect|debug)(?:-|=|$)/.test(arg))) throw new Error('Main inspector arguments are managed by the launcher');
  const child = spawn(appExecutable, ['--inspect-brk=127.0.0.1:0', ...appArgs], {
    // The app outlives this helper. Its console must never retain a pipe whose
    // reader disappears when the helper exits, causing an unhandled EPIPE.
    stdio: 'ignore', env, detached: true,
  });
  const controller = createBackendController({ child, appPid: child.pid ?? null, officialBackendPath,
    helperBackendPath, backendArgs, onBackendSpawn, onError, timeoutMs });
  return controller.initialize(waitForInspector(child, timeoutMs));
}

/**
 * Reconnect only to a caller-validated receipt for its previously authorized app
 * and helper-owned backend. The caller checks current executable paths; this
 * module verifies the inspector's PID before installing anything. No process is
 * started, stopped or deliberately paused. The current backend is reattached
 * before this returns; subsequent backend spawns reuse the same debugger gate.
 * process is null; appPid/inspectorUrl/getConnectionInfo support receipt storage.
 */
export async function connectBackendApp({
  enabled, inspectorUrl, appPid, backendPid, officialBackendPath, helperBackendPath,
  backendArgs = [], onBackendSpawn, onError, timeoutMs = 15000,
}) {
  await validateBackendOptions({ enabled, officialBackendPath, helperBackendPath, backendArgs, onBackendSpawn });
  if (!Number.isInteger(appPid) || appPid <= 0 || !Number.isInteger(backendPid) || backendPid <= 0) {
    throw new TypeError('Saved application and backend PIDs are required');
  }
  if (typeof inspectorUrl !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+$/.test(inspectorUrl)) {
    throw new TypeError('Saved main inspector must be a loopback WebSocket URL');
  }
  const controller = createBackendController({ appPid, officialBackendPath, helperBackendPath,
    backendArgs, onBackendSpawn, onError, timeoutMs });
  return controller.initialize(inspectorUrl, backendPid);
}
