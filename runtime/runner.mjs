#!/usr/bin/env node
import { createServer, request } from 'node:http';
import { readFile, writeFile, mkdir, stat, chmod, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpClient } from './cdp.mjs';
import { createBackendManager } from './backend-manager.mjs';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const stateDir = join(homedir(), 'Library/Application Support/AntigravityChineseHelper');
const socketPath = join(stateDir, 'helper.sock');
const pidPath = join(stateDir, 'runner.pid');
const statusPath = join(stateDir, 'status.json');
const sourcePath = join(runtimeDir, 'renderer.js');
const swarmSourcePath = join(runtimeDir, 'swarm-renderer.js');
const dictionaryPath = join(runtimeDir, 'translations.json');
const helperKey = '__antigravityChineseHelper';
const backendBinding = '__aghBackendRequest';
const backendBridgeKey = '__antigravitySubagentContext';
const requestedShutdownTimeoutMs = Number(process.env.ANTIGRAVITY_HELPER_SHUTDOWN_TIMEOUT_MS ?? 8000);
const shutdownTimeoutMs = Number.isFinite(requestedShutdownTimeoutMs) && requestedShutdownTimeoutMs > 0 ? requestedShutdownTimeoutMs : 8000;
// Keep the returned script ID so shutdown can remove a registration in flight.
const shutdownPreservedMethods = ['Page.addScriptToEvaluateOnNewDocument'];
const knownApp = `location.protocol === 'https:' && location.hostname === '127.0.0.1' && globalThis.top === globalThis && typeof globalThis.electronNative?.getZoomLevel === 'function' && typeof globalThis.nativeStorage?.getItems === 'function'`;
const swarmLocation = `location.protocol === 'plugin:' && /^swarm--swarm_board-\\d+$/.test(location.hostname) && location.pathname === '/'`;
const knownSwarm = `(${swarmLocation}) && typeof globalThis.sidecar === 'object' && globalThis.sidecar !== null && Boolean(document.querySelector('[data-testid="swarm-loading"],[data-testid="swarm-board"],[data-testid="swarm-empty-state"]'))`;
const sessions = new Map();
const rejectedTargets = new Map();
let bundle;
let stopping = false;
let discovering = false;
let discoveryClient = null;
let discoverySettled = Promise.resolve();
let shutdownPromise = null;
let shutdownDeadline = null;
let reloading = false;
let reloadPromise = null;
let tickPromise = null;
let bundleError = null;
let currentPort;
let lastError = null;
let appReachable = false;
let lastHealth = 0;
let interval;
let server;
let backend;
const startedAt = new Date().toISOString();

// Only numeric preferences and runtime status cross this bridge. Launching the
// App is a separate, explicit menu action on the local helper socket.
function installBackendBridge() {
  if (globalThis.__antigravitySubagentContext) return;
  const pending = new Map(), listeners = new Set();
  let nextId = 0;
  function request(method, tokens) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('子代理上下文服务未响应，请重新加载助手后重试')); }, 15000);
      pending.set(id, {resolve, reject, timer});
      try { globalThis.__aghBackendRequest(JSON.stringify({id, method, tokens})); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error('子代理上下文服务未连接')); }
    });
  }
  const bridge = {
    getStatus:() => request('status'),
    setLimit:tokens => request('set-limit', tokens),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    update(status) { for (const listener of listeners) { try { listener(status); } catch {} } },
    settle({id, result, error}) {
      const item = pending.get(id); if (!item) return;
      pending.delete(id); clearTimeout(item.timer);
      error ? item.reject(new Error(error)) : item.resolve(result);
    },
    dispose() {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('子代理上下文服务已断开')); }
      pending.clear(); listeners.clear();
      if (globalThis.__antigravitySubagentContext === bridge) delete globalThis.__antigravitySubagentContext;
    },
  };
  globalThis.__antigravitySubagentContext = bridge;
}

async function publishBackendStatus() {
  const status = backend?.getStatus();
  if (!status || stopping) return;
  await Promise.allSettled([...sessions.values()].filter(session => session.kind !== 'swarm').map(session => evaluate(session.client,
    `(() => { if (${knownApp}) globalThis.${backendBridgeKey}?.update(${JSON.stringify(status)}); })()`)));
  await saveStatus().catch(() => {});
}

async function handleBackendRequest(session, event) {
  if (event.name !== backendBinding || stopping) return;
  let request;
  try { request = JSON.parse(event.payload); } catch { return; }
  if (!Number.isSafeInteger(request?.id) || request.id < 1 || !['status','set-limit'].includes(request.method)) return;
  const inContext = expression => session.client.call('Runtime.evaluate', {
    contextId:event.executionContextId, expression, returnByValue:true, awaitPromise:true,
  });
  // A binding may also exist in embedded frames. Only the native top-level App
  // document is allowed to change the helper's preference.
  const identity = await inContext(`Boolean(${knownApp})`);
  if (identity.result?.value !== true) return;
  let result, error;
  try {
    await backend.ready;
    result = request.method === 'status' ? backend.getStatus() : await backend.setLimit(request.tokens);
  } catch (failure) { error = failure.message || '无法保存子代理上下文设置'; }
  await inContext(`globalThis.${backendBridgeKey}?.settle(${JSON.stringify({id:request.id, result, error})})`);
}

function snapshot() {
  const connected = [...sessions.values()].filter((session) => session.client.connected);
  const windows = connected.filter(session => session.kind !== 'swarm');
  const error = bundleError ?? lastError;
  return {
    running: !stopping,
    pid: process.pid,
    startedAt,
    status: stopping ? 'stopped' : error ? 'error' : connected.length ? 'running' : 'waiting',
    state: stopping ? 'stopped' : connected.length ? 'connected' : appReachable ? 'waiting-for-window' : 'waiting-for-app',
    translatedWindows: windows.length,
    connectedWindows: windows.length,
    translatedSidecars: connected.filter(session => session.kind === 'swarm' && session.version).length,
    rendererVersion: windows.map((session) => session.version).find(Boolean) ?? connected.map(session => session.version).find(Boolean) ?? null,
    dictionaryLoadedAt: bundle?.loadedAt ?? null,
    lastError: error,
    subagentContext: backend?.getStatus() ?? null,
  };
}

async function saveStatus() {
  // This file intentionally contains no target URLs, titles, page text, or conversations.
  await writeFile(statusPath, `${JSON.stringify(snapshot(), null, 2)}\n`, { mode: 0o600 });
}

function ipc(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/${command}`, method: command === 'status' ? 'GET' : 'POST', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(result.error ?? 'Helper command failed'));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Helper command timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function evaluate(client, expression, timeoutMs) {
  const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed');
  return result.result?.value;
}

async function loadBundle() {
  const [source, swarmSource, dictionaryText, sourceStat, swarmSourceStat, dictionaryStat] = await Promise.all([
    readFile(sourcePath, 'utf8'), readFile(swarmSourcePath, 'utf8'), readFile(dictionaryPath, 'utf8'),
    stat(sourcePath), stat(swarmSourcePath), stat(dictionaryPath),
  ]);
  // Parse before replacing a working bundle so a half-written dictionary leaves it active.
  const dictionary = JSON.parse(dictionaryText);
  if (!dictionary || typeof dictionary !== 'object') throw new Error('Dictionary must be an object or array');
  const expression = `(() => {
    const install = () => {
      if (!(${knownApp})) return;
      (${installBackendBridge.toString()})();
      if (globalThis.${helperKey}) return;
      globalThis.${helperKey} = (${source.trim().replace(/;\s*$/, '')})(${JSON.stringify(dictionary)});
    };
    if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1' || globalThis.top !== globalThis) return;
    install();
    // Page.domContentEventFired retries after the native preload bridge is ready.
    // Keeping the retry in the runner lets --stop cancel it completely.
  })()`;
  const swarmExpression = `(() => {
    if (!(${knownSwarm}) || globalThis.${helperKey}) return;
    globalThis.${helperKey} = (${swarmSource.trim().replace(/;\s*$/, '')})(${JSON.stringify(dictionary)});
  })()`;
  // Syntax validation never executes the renderer in Node.
  new Function(expression);
  new Function(swarmExpression);
  return {
    expression, dictionary, sourceMtime: sourceStat.mtimeMs, dictionaryMtime: dictionaryStat.mtimeMs,
    swarm: {expression:swarmExpression, sourceMtime:swarmSourceStat.mtimeMs}, loadedAt:new Date().toISOString(),
  };
}

function sessionRenderer(session, activeBundle = bundle) {
  return session.kind === 'swarm' ? activeBundle.swarm : activeBundle;
}

function sessionIdentity(session) {
  return session.kind === 'swarm' ? swarmLocation : knownApp;
}

async function installNow(session, mode) {
  if (session.closing || stopping) return false;
  const { client } = session;
  const activeBundle = bundle;
  const renderer = sessionRenderer(session, activeBundle);
  const identity = sessionIdentity(session);
  if (!(await evaluate(client, `Boolean(${identity})`))) return false;
  if (mode !== 'ensure') {
    if (session.scriptId) await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId });
    session.scriptId = null;
  }
  if (mode === 'replace') {
    await evaluate(client, `(() => { if (${identity}) { globalThis.${helperKey}?.uninstall?.(); delete globalThis.${helperKey}; } })()`);
  }
  if (!session.scriptId) {
    const result = await client.call('Page.addScriptToEvaluateOnNewDocument', { source: renderer.expression });
    session.scriptId = result.identifier;
  }
  if (session.closing || stopping) return false;
  if (mode === 'refresh') {
    await evaluate(client, `(() => { if (${identity}) globalThis.${helperKey}?.refresh(${JSON.stringify(activeBundle.dictionary)}); })()`);
  }
  // Also installs into a document that navigated while the script was replaced.
  await evaluate(client, renderer.expression);
  const info = await evaluate(client, `(() => { const helper = globalThis.${helperKey}; return { active: Boolean(helper), version: typeof helper?.version === 'string' ? helper.version : null }; })()`);
  session.version = info?.version ?? null;
  if (info?.active) session.sourceMtime = renderer.sourceMtime;
  return Boolean(info?.active);
}

function install(session, mode = 'ensure') {
  session.operation = (session.operation ?? Promise.resolve()).catch(() => {}).then(() => installNow(session, mode));
  return session.operation;
}

function disconnect(session, restoreEnglish) {
  if (stopping && !session.cleanupStarted) session.client.cancelPending({ preserveMethods: shutdownPreservedMethods });
  if (session.disconnectPromise) return session.disconnectPromise;
  clearTimeout(session.navigationTimer);
  session.closing = true;
  session.disconnectPromise = (async () => {
    await session.operation?.catch(() => {});
    session.cleanupStarted = true;
    try {
      if (restoreEnglish && session.client.connected) {
        const timeoutMs = stopping ? Math.max(0, shutdownDeadline - Date.now()) : undefined;
        if (timeoutMs !== 0) {
          // Send both removals together: a slow request must not hold up uninstall.
          const cleanup = [evaluate(session.client, `(() => { if (${sessionIdentity(session)}) { globalThis.${helperKey}?.uninstall?.(); delete globalThis.${helperKey}; } if (${knownApp}) globalThis.${backendBridgeKey}?.dispose(); })()`, timeoutMs)];
          if (session.scriptId) cleanup.push(session.client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, timeoutMs));
          await Promise.allSettled(cleanup);
        }
      }
    } finally { session.client.close(); }
  })();
  return session.disconnectPromise;
}

function scheduleInstall(session) {
  clearTimeout(session.navigationTimer);
  session.navigationTimer = setTimeout(() => {
    if (!stopping && !reloading && session.client.connected) install(session).catch(() => { lastError = 'renderer-reconnect-failed'; });
  }, 100);
}

async function portFromApp() {
  const roots = ['Antigravity', 'antigravity'];
  for (const root of roots) {
    try {
      const contents = await readFile(join(homedir(), 'Library/Application Support', root, 'DevToolsActivePort'), 'utf8');
      const port = Number(contents.split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch { /* App is closed or has not created the endpoint yet. */ }
  }
  return null;
}

function targetKind(target) {
  try {
    const page = new URL(target.url);
    if (target.type === 'page' && page.protocol === 'https:' && page.hostname === '127.0.0.1') return 'app';
    if (target.type === 'iframe' && page.protocol === 'plugin:' && /^swarm--swarm_board-\d+$/.test(page.hostname) && page.pathname === '/') return 'swarm';
  } catch { /* Ignore unrelated or invalid targets. */ }
  return null;
}

function eligibleTarget(target, port) {
  if (!targetKind(target)) return false;
  try {
    const socket = new URL(target.webSocketDebuggerUrl);
    return socket.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(socket.hostname) && Number(socket.port) === port;
  } catch { return false; }
}

async function discover() {
  if (discovering || stopping || reloading) return;
  discovering = true;
  let resolveDiscovery;
  discoverySettled = new Promise((resolve) => { resolveDiscovery = resolve; });
  try {
    const port = await portFromApp();
    if (port !== currentPort) {
      await Promise.all([...sessions.values()].map((session) => disconnect(session, true)));
      sessions.clear();
      rejectedTargets.clear();
      currentPort = port;
    }
    if (!port) { appReachable = false; return; }
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error('CDP discovery unavailable');
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error('CDP target list invalid');
    appReachable = true;
    const eligible = targets.filter((target) => eligibleTarget(target, port));
    const activeIds = new Set(eligible.map((target) => target.id));
    for (const [id, session] of sessions) {
      if (!activeIds.has(id) || !session.client.connected) {
        await disconnect(session, true);
        sessions.delete(id);
      }
    }
    for (const target of eligible) {
      if (stopping || sessions.has(target.id) || (rejectedTargets.get(target.id) ?? 0) > Date.now()) continue;
      let client;
      let session;
      try {
        client = await CdpClient.connect(target.webSocketDebuggerUrl);
        discoveryClient = client;
        if (stopping) { client.close(); break; }
        const kind = targetKind(target);
        // The native bridge identifies the main App. Swarm's exact plugin
        // address also admits a loading document so its DOM-ready event can install.
        const identity = kind === 'swarm' ? swarmLocation : knownApp;
        if (!(await evaluate(client, `Boolean(${identity})`))) {
          rejectedTargets.set(target.id, Date.now() + 10000);
          client.close();
          continue;
        }
        session = { client, kind, scriptId: null, version: null, navigationTimer: null, closing: false, operation: Promise.resolve() };
        if (kind === 'app') {
          await client.call('Runtime.addBinding', {name:backendBinding});
          client.on('Runtime.bindingCalled', event => { void handleBackendRequest(session, event).catch(() => {}); });
        }
        await client.call('Page.enable');
        client.on('Page.domContentEventFired', () => scheduleInstall(session));
        client.on('Page.frameNavigated', (params) => { if (kind === 'swarm' || !params.frame?.parentId) scheduleInstall(session); });
        client.on('close', () => {
          clearTimeout(session.navigationTimer);
          if (sessions.get(target.id) === session) sessions.delete(target.id);
        });
        if (!(await install(session)) && !(kind === 'swarm' && await evaluate(client, `Boolean((${swarmLocation}) && document.readyState === 'loading')`)))
          throw new Error('Renderer did not initialize');
        if (stopping) { await disconnect(session, true); break; }
        sessions.set(target.id, session);
        lastError = null;
      } catch {
        if (session) await disconnect(session, true);
        else client?.close();
        if (!stopping) lastError = 'window-connect-failed';
      } finally {
        if (discoveryClient === client) discoveryClient = null;
      }
    }
    if (stopping) return;
    if (Date.now() - lastHealth >= 10000) {
      lastHealth = Date.now();
      await backend?.refresh();
      for (const [id, session] of sessions) {
        try {
          const active = await evaluate(session.client, `Boolean((${sessionIdentity(session)}) && globalThis.${helperKey})`);
          if (!active) await install(session);
        } catch {
          await disconnect(session, false);
          sessions.delete(id);
        }
      }
    }
    lastError = sessions.size ? null : lastError;
  } catch {
    appReachable = false;
    // Closing Antigravity is an expected waiting state, not an error to report.
  } finally {
    discovering = false;
    if (!stopping) await saveStatus().catch(() => {});
    resolveDiscovery();
  }
}

function reload() {
  if (reloadPromise) return reloadPromise;
  reloading = true;
  reloadPromise = (async () => {
    let nextBundle;
    try {
      // Load completely before replacing the working bundle or touching a page.
      nextBundle = await loadBundle();
    } catch (error) {
      bundleError = 'dictionary-reload-failed';
      await saveStatus().catch(() => {});
      throw error;
    }
    bundle = nextBundle;
    bundleError = null;
    await Promise.all([...sessions.values()].map(async (session) => {
      try { await install(session, session.sourceMtime === sessionRenderer(session).sourceMtime ? 'refresh' : 'replace'); }
      catch { lastError = 'renderer-reload-failed'; }
    }));
    await saveStatus();
    return snapshot();
  })().finally(() => {
    reloading = false;
    reloadPromise = null;
  });
  return reloadPromise;
}

function tick() {
  if (tickPromise) return tickPromise;
  if (stopping) return Promise.resolve();
  tickPromise = (async () => {
    try {
      const [sourceStat, swarmSourceStat, dictionaryStat] = await Promise.all([stat(sourcePath), stat(swarmSourcePath), stat(dictionaryPath)]);
      if (sourceStat.mtimeMs !== bundle.sourceMtime || swarmSourceStat.mtimeMs !== bundle.swarm.sourceMtime || dictionaryStat.mtimeMs !== bundle.dictionaryMtime) await reload();
    } catch { bundleError = 'dictionary-reload-failed'; }
    await discover();
  })().finally(() => { tickPromise = null; });
  return tickPromise;
}

function stop() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownDeadline = Date.now() + shutdownTimeoutMs;
  clearInterval(interval);
  // Reject pending installation work without closing its socket; cleanup needs it.
  discoveryClient?.cancelPending({ preserveMethods: shutdownPreservedMethods });
  shutdownPromise = (async () => {
    await Promise.all([
      discoverySettled,
      ...[...sessions.values()].map((session) => disconnect(session, true)),
      backend?.dispose(),
    ]);
    sessions.clear();
    await saveStatus().catch(() => {});
    await unlink(pidPath).catch(() => {});
    // Node owns removal of a bound Unix socket when this server closes.
    if (server) server.close();
    process.exitCode = 0;
  })();
  return shutdownPromise;
}

async function collect() {
  const windows = [];
  for (const session of sessions.values()) {
    if (session.kind === 'swarm') continue;
    try {
      const unknown = await evaluate(session.client, `(() => { if (!(${knownApp})) return []; return globalThis.${helperKey}?.collectUnknown?.() ?? []; })()`);
      // Renderer owns the UI-only selection: no DOM scan or conversation capture here.
      windows.push({ unknown });
    } catch { windows.push({ error: 'window-unavailable' }); }
  }
  return { windows };
}

async function startServer() {
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      let result;
      if (req.method === 'GET' && req.url === '/status') result = snapshot();
      else if (req.method === 'POST' && req.url === '/reload') result = await reload();
      else if (req.method === 'POST' && req.url === '/collect') result = await collect();
      else if (req.method === 'POST' && req.url === '/launch') { await backend.ready; result = await backend.launch(); }
      else if (req.method === 'POST' && req.url === '/stop') {
        await stop();
        res.end(JSON.stringify(snapshot()));
        return;
      } else {
        res.statusCode = 404;
        result = { error: 'unknown-command' };
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: req.url === '/launch' ? error.message : 'command-failed' }));
    }
  });
  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  try { await listen(); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    try {
      const existing = await ipc('status');
      process.stdout.write(`${JSON.stringify(existing, null, 2)}\n`);
      return false;
    } catch (probeError) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(probeError.code)) throw probeError;
      await unlink(socketPath).catch(() => {});
      await listen();
    }
  }
  await chmod(socketPath, 0o600);
  return true;
}

async function main() {
  const command = process.argv[2];
  if (command) {
    const commands = { '--status': 'status', '--stop': 'stop', '--collect': 'collect', '--reload': 'reload', '--launch':'launch' };
    if (!commands[command]) {
      process.stderr.write('用法：node runner.mjs [--status | --stop | --collect | --reload | --launch]\n');
      process.exitCode = 2;
      return;
    }
    try { process.stdout.write(`${JSON.stringify(await ipc(commands[command], command === '--launch' ? 90000 : 15000), null, 2)}\n`); }
    catch (error) {
      if (command === '--launch') { process.stderr.write(`${error.message || '无法启动 Antigravity'}\n`); process.exitCode = 1; }
      else if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) process.stdout.write(`${JSON.stringify({ running: false, status: 'stopped', state: 'stopped', translatedWindows: 0, connectedWindows: 0 }, null, 2)}\n`);
      else { process.stderr.write('汉化助手命令执行失败。\n'); process.exitCode = 1; }
    }
    return;
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  bundle = await loadBundle();
  if (!(await startServer())) return;
  backend = createBackendManager({stateDir, runtimeDir, onChange:() => { void publishBackendStatus(); }});
  await backend.ready;
  await writeFile(pidPath, `${process.pid}\n`, { mode: 0o600 });
  process.once('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
  process.once('SIGINT', () => stop().catch(() => { process.exitCode = 1; }));
  await discover();
  if (stopping) return;
  interval = setInterval(() => tick().catch(() => { lastError = 'helper-refresh-failed'; }), 2000);
  process.stdout.write('Antigravity 汉化助手已启动。\n');
}

main().catch(async () => {
  process.stderr.write('汉化助手启动失败，请检查 renderer.js、translations.json 和本机 Node.js。\n');
  if (server?.listening) await stop();
  process.exitCode = 1;
});
