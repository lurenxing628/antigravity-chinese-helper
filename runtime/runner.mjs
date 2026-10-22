#!/usr/bin/env node
import { createServer, request } from 'node:http';
import { readFile, writeFile, mkdir, stat, chmod, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpClient } from './cdp.mjs';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const stateDir = join(homedir(), 'Library/Application Support/AntigravityChineseHelper');
const socketPath = join(stateDir, 'helper.sock');
const pidPath = join(stateDir, 'runner.pid');
const statusPath = join(stateDir, 'status.json');
const sourcePath = join(runtimeDir, 'renderer.js');
const dictionaryPath = join(runtimeDir, 'translations.json');
const helperKey = '__antigravityChineseHelper';
const knownApp = `location.protocol === 'https:' && location.hostname === '127.0.0.1' && globalThis.top === globalThis && typeof globalThis.electronNative?.getZoomLevel === 'function' && typeof globalThis.nativeStorage?.getItems === 'function'`;
const sessions = new Map();
const rejectedTargets = new Map();
let bundle;
let stopping = false;
let discovering = false;
let discoverySettled = Promise.resolve();
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
const startedAt = new Date().toISOString();

function snapshot() {
  const connected = [...sessions.values()].filter((session) => session.client.connected);
  const error = bundleError ?? lastError;
  return {
    running: !stopping,
    pid: process.pid,
    startedAt,
    status: stopping ? 'stopped' : error ? 'error' : connected.length ? 'running' : 'waiting',
    state: stopping ? 'stopped' : connected.length ? 'connected' : appReachable ? 'waiting-for-window' : 'waiting-for-app',
    translatedWindows: connected.length,
    connectedWindows: connected.length,
    rendererVersion: connected.map((session) => session.version).find(Boolean) ?? null,
    dictionaryLoadedAt: bundle?.loadedAt ?? null,
    lastError: error,
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

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed');
  return result.result?.value;
}

async function loadBundle() {
  const [source, dictionaryText, sourceStat, dictionaryStat] = await Promise.all([
    readFile(sourcePath, 'utf8'), readFile(dictionaryPath, 'utf8'), stat(sourcePath), stat(dictionaryPath),
  ]);
  // Parse before replacing a working bundle so a half-written dictionary leaves it active.
  const dictionary = JSON.parse(dictionaryText);
  if (!dictionary || typeof dictionary !== 'object') throw new Error('Dictionary must be an object or array');
  const expression = `(() => {
    const install = () => {
      if (!(${knownApp})) return;
      if (globalThis.${helperKey}) return;
      globalThis.${helperKey} = (${source.trim().replace(/;\s*$/, '')})(${JSON.stringify(dictionary)});
    };
    if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1' || globalThis.top !== globalThis) return;
    install();
    // Page.domContentEventFired retries after the native preload bridge is ready.
    // Keeping the retry in the runner lets --stop cancel it completely.
  })()`;
  // Syntax validation never executes the renderer in Node.
  new Function(expression);
  return { expression, sourceMtime: sourceStat.mtimeMs, dictionaryMtime: dictionaryStat.mtimeMs, loadedAt: new Date().toISOString() };
}

async function installNow(session, replace) {
  if (session.closing || stopping) return false;
  const { client } = session;
  if (!(await evaluate(client, `Boolean(${knownApp})`))) return false;
  if (replace) {
    if (session.scriptId) await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId });
    session.scriptId = null;
    await evaluate(client, `(() => { if (${knownApp}) { globalThis.${helperKey}?.uninstall?.(); delete globalThis.${helperKey}; } })()`);
  }
  if (!session.scriptId) {
    const result = await client.call('Page.addScriptToEvaluateOnNewDocument', { source: bundle.expression });
    session.scriptId = result.identifier;
  }
  await evaluate(client, bundle.expression);
  const info = await evaluate(client, `(() => { const helper = globalThis.${helperKey}; return { active: Boolean(helper), version: typeof helper?.version === 'string' ? helper.version : null }; })()`);
  session.version = info?.version ?? null;
  return Boolean(info?.active);
}

function install(session, replace = false) {
  session.operation = (session.operation ?? Promise.resolve()).catch(() => {}).then(() => installNow(session, replace));
  return session.operation;
}

async function disconnect(session, restoreEnglish) {
  clearTimeout(session.navigationTimer);
  session.closing = true;
  await session.operation?.catch(() => {});
  if (restoreEnglish && session.client.connected) {
    if (session.scriptId) await session.client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }).catch(() => {});
    await evaluate(session.client, `(() => { if (${knownApp}) { globalThis.${helperKey}?.uninstall?.(); delete globalThis.${helperKey}; } })()`).catch(() => {});
  }
  session.client.close();
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

function eligibleTarget(target, port) {
  if (target.type !== 'page') return false;
  try {
    const page = new URL(target.url);
    if (page.protocol !== 'https:' || page.hostname !== '127.0.0.1') return false;
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
        // Native bridge identity excludes embedded localhost websites with the same origin.
        if (!(await evaluate(client, `Boolean(${knownApp})`))) {
          rejectedTargets.set(target.id, Date.now() + 10000);
          client.close();
          continue;
        }
        session = { client, scriptId: null, version: null, navigationTimer: null, closing: false, operation: Promise.resolve() };
        await client.call('Page.enable');
        client.on('Page.domContentEventFired', () => scheduleInstall(session));
        client.on('Page.frameNavigated', (params) => { if (!params.frame?.parentId) scheduleInstall(session); });
        client.on('close', () => {
          clearTimeout(session.navigationTimer);
          if (sessions.get(target.id) === session) sessions.delete(target.id);
        });
        if (!(await install(session))) throw new Error('Renderer did not initialize');
        sessions.set(target.id, session);
        lastError = null;
      } catch {
        if (session) await disconnect(session, true);
        else client?.close();
        if (!stopping) lastError = 'window-connect-failed';
      }
    }
    if (Date.now() - lastHealth >= 10000) {
      lastHealth = Date.now();
      for (const [id, session] of sessions) {
        try {
          const active = await evaluate(session.client, `Boolean((${knownApp}) && globalThis.${helperKey})`);
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
      try { await install(session, true); }
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
      const [sourceStat, dictionaryStat] = await Promise.all([stat(sourcePath), stat(dictionaryPath)]);
      if (sourceStat.mtimeMs !== bundle.sourceMtime || dictionaryStat.mtimeMs !== bundle.dictionaryMtime) await reload();
    } catch { bundleError = 'dictionary-reload-failed'; }
    await discover();
  })().finally(() => { tickPromise = null; });
  return tickPromise;
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  await discoverySettled;
  await Promise.all([...sessions.values()].map((session) => disconnect(session, true)));
  sessions.clear();
  await saveStatus().catch(() => {});
  await unlink(pidPath).catch(() => {});
  // Node owns removal of a bound Unix socket when this server closes.
  if (server) server.close();
  process.exitCode = 0;
}

async function collect() {
  const windows = [];
  for (const session of sessions.values()) {
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
      else if (req.method === 'POST' && req.url === '/stop') {
        await stop();
        res.end(JSON.stringify(snapshot()));
        return;
      } else {
        res.statusCode = 404;
        result = { error: 'unknown-command' };
      }
      res.end(JSON.stringify(result));
    } catch {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'command-failed' }));
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
    const commands = { '--status': 'status', '--stop': 'stop', '--collect': 'collect', '--reload': 'reload' };
    if (!commands[command]) {
      process.stderr.write('用法：node runner.mjs [--status | --stop | --collect | --reload]\n');
      process.exitCode = 2;
      return;
    }
    try { process.stdout.write(`${JSON.stringify(await ipc(commands[command]), null, 2)}\n`); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) process.stdout.write(`${JSON.stringify({ running: false, status: 'stopped', state: 'stopped', translatedWindows: 0, connectedWindows: 0 }, null, 2)}\n`);
      else { process.stderr.write('汉化助手命令执行失败。\n'); process.exitCode = 1; }
    }
    return;
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  bundle = await loadBundle();
  if (!(await startServer())) return;
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
