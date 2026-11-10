// Explicit integration check against an isolated copy; never uses the live App.
// node tests/backend-native.integration.mjs [path/to/frida]
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBackendApp } from '../runtime/backend-launch.mjs';
import { prepareBackendCopy, createBackendRuntime } from '../runtime/backend-runtime.mjs';

const require = createRequire(import.meta.url);
const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime');
const stateDir = await mkdtemp(join(tmpdir(), 'agh-native-budget-'));
const officialBackendPath = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
const fixturePath = join(stateDir, 'main.cjs');
const pidPath = join(stateDir, 'backend.pid');
const readyPath = join(stateDir, 'ready-consumed.json');
const exitPath = join(stateDir, 'backend-exit.json');
const logPath = join(stateDir, 'backend.log');
const fridaModulePath = process.argv[2] ?? process.env.ANTIGRAVITY_HELPER_FRIDA
  ?? join(homedir(), '.local/share/mcp-tools/frida-mcp/node_modules/frida');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const isRunning = pid => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
let session, runtime, backendPid;
let startupGateVerified = false;
try {
  const { binaryPath } = await prepareBackendCopy({officialBackendPath, stateDir});
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const backendArgs = ['--standalone','--headless','--disable_telemetry', `--gemini_dir=${join(stateDir, 'data')}`,
    `--http_server_port=${port}`, '--csrf_token=isolated-budget-check', '--override_model_name=gemini-2.5-pro-windsurf',
    '--cloud_code_endpoint=http://127.0.0.1:9','--api_server_url=http://127.0.0.1:9',
    '--analytics_server_url=http://127.0.0.1:9','--inference_api_server_url=http://127.0.0.1:9'];
  await writeFile(fixturePath, `const cp = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');
// Exercise the production replacement of this exact official executable path.
const child = cp.spawn(${JSON.stringify(officialBackendPath)}, ${JSON.stringify(backendArgs)}, {stdio:['ignore','pipe','pipe']});
fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
let consumedReady = false;
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => fs.appendFileSync(${JSON.stringify(logPath)}, chunk));
  readline.createInterface({input:stream, crlfDelay:Infinity}).on('line', line => {
    const match = /listening on \\w+ port at (\\d+) for HTTP(S)?\\b/i.exec(line);
    if (!consumedReady && match) {
      consumedReady = true;
      fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({pid:child.pid, port:Number(match[1]), protocol:match[2] ? 'https' : 'http'}));
    }
  });
}
child.once('error', error => {
  fs.appendFileSync(${JSON.stringify(logPath)}, error.stack + '\\n');
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  fs.writeFileSync(${JSON.stringify(exitPath)}, JSON.stringify({code, signal}));
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill('SIGTERM'));
`);
  // Cold Frida imports hid the original spawn/dyld race. Warm both operations
  // before launch so attachment starts as soon as the production gate permits it.
  const fridaModule = await import(pathToFileURL(require.resolve(fridaModulePath)).href);
  await (fridaModule.default ?? fridaModule).getLocalDevice();
  runtime = createBackendRuntime({
    fridaModulePath, hookSourcePath:join(runtimeDir, 'backend-hook.js'),
    expectedBinaryPath:binaryPath, targetTokens:512000,
  });
  session = await launchBackendApp({
    enabled:true, appExecutable:process.execPath, appArgs:[fixturePath],
    officialBackendPath, helperBackendPath:binaryPath,
    onBackendSpawn:async pid => {
      backendPid = pid;
      assert.equal(existsSync(readyPath), false, 'Fixture must not consume native readiness before attachment');
      await runtime.attach(pid);
      assert.equal((await runtime.status()).attached, true);
      assert.equal(existsSync(readyPath), false, 'Production gate must hold readiness until native attachment finishes');
      startupGateVerified = true;
    },
  });
  let startupWatch;
  try {
    const deadline = Date.now() + 60000;
    const startupFailure = new Promise((_, reject) => {
      startupWatch = setInterval(() => {
        if (existsSync(exitPath)) reject(new Error('Native backend exited before attachment completed'));
        else if (Date.now() >= deadline) reject(new Error('Native readiness/attachment timed out'));
      }, 100);
    });
    assert.equal(await Promise.race([session.ready, startupFailure]), backendPid);
  } finally {
    clearInterval(startupWatch);
  }
  assert.equal(startupGateVerified, true);
  for (let attempt = 0; !existsSync(readyPath); attempt++) {
    assert(attempt < 150 && isRunning(session.appPid) && !existsSync(exitPath), 'Fixture did not consume released native readiness');
    await delay(100);
  }
  // The first native readiness line can announce HTTPS before our HTTP RPC port.
  const consumedReady = JSON.parse(await readFile(readyPath, 'utf8'));
  assert.equal(consumedReady.pid, backendPid);
  assert(Number.isInteger(consumedReady.port) && consumedReady.port > 0 && consumedReady.port <= 65535);
  assert(['http', 'https'].includes(consumedReady.protocol));
  if (consumedReady.protocol === 'http') assert.equal(consumedReady.port, port);
  const rpc = async (method, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`, {
      method:'POST', headers:{'Content-Type':'application/json','X-Codeium-Csrf-Token':'isolated-budget-check'},
      body:JSON.stringify(body), signal:AbortSignal.timeout(15000),
    });
    const value = await response.json();
    assert.equal(response.status, 200, `${method}: ${JSON.stringify(value)}`);
    return value;
  };
  for (let attempt = 0; ; attempt++) {
    try { await rpc('GetStatus'); break; }
    catch (error) {
      if (attempt === 100 || existsSync(exitPath)) throw error;
      await delay(100);
    }
  }
  const {cascadeId:parent} = await rpc('StartCascade', {source:1});
  const {cascadeId:ordinary} = await rpc('StartCascade', {source:16, parentConversationId:parent, subagentDescriptor:{typeName:'research'}});
  const {cascadeId:self} = await rpc('StartCascade', {source:16, parentConversationId:parent, subagentDescriptor:{typeName:'self'}});
  const {cascadeId:nested} = await rpc('StartCascade', {source:16, parentConversationId:ordinary, subagentDescriptor:{typeName:'budget-probe'}});
  const resolveConfig = (cascadeId, limit = 256000) => rpc('GetSlashCommands', {cascadeId, cascadeConfig:{
    // The native offline --override_model_name flag selects BYOM (326).
    plannerConfig:{planModel:326}, checkpointConfig:{enabled:true, maxTokenLimit:limit},
  }});
  await resolveConfig(parent, 300000);
  assert.equal((await runtime.status()).native.parentLimit, 300000);
  for (const id of [ordinary, self, nested]) {
    await resolveConfig(id);
    const {lastBudget} = (await runtime.status()).native;
    assert.equal(lastBudget.before, 256000);
    assert.equal(lastBudget.applied, 512000);
    assert.equal(lastBudget.result, 'applied');
  }
  await runtime.setLimit(2000000);
  await resolveConfig(ordinary);
  const capped = (await runtime.status()).native.lastBudget;
  assert(capped.capacity > 512000 && capped.capacity < 2000000);
  assert.equal(capped.applied, capped.capacity);
  await runtime.setLimit(null);
  await resolveConfig(ordinary);
  assert.equal((await runtime.status()).native.lastBudget.applied, 256000);
  await runtime.setLimit(512000);
  let next = 0;
  await Promise.all(Array.from({length:6}, async () => {
    while (next++ < 500) await resolveConfig(ordinary);
  }));
  assert.equal((await runtime.status()).native.lastBudget.applied, 512000);
  assert.equal(existsSync(exitPath), false, 'Native process must survive concurrent Go stack growth');
  assert.equal(isRunning(backendPid), true);
  await runtime.detach();
  await resolveConfig(ordinary);
  await runtime.attach(backendPid);
  await runtime.setLimit(768000);
  await resolveConfig(ordinary);
  assert.equal((await runtime.status()).native.lastBudget.applied, 768000);
  await resolveConfig(parent, 300000);
  assert.equal((await runtime.status()).native.parentLimit, 300000);
  console.log(JSON.stringify({startupGateVerified, parentLimit:300000, childLimit:512000, clampedLimit:capped.capacity,
    restoredDefault:256000, concurrentResolutions:500, reattachedLimit:768000}));
} catch (error) {
  session ??= error.session;
  if (existsSync(logPath)) console.error((await readFile(logPath, 'utf8')).slice(-524288));
  throw error;
} finally {
  await runtime?.dispose().catch(() => {});
  await session?.restore().catch(() => {});
  backendPid ??= existsSync(pidPath) ? Number(await readFile(pidPath, 'utf8')) : null;
  // These PIDs come only from this fixture and its one private backend spawn.
  // Keep the fallback outside the fixture so a paused/crashed main cannot orphan LS.
  const ownedPids = [...new Set([backendPid, session?.appPid].filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of ownedPids) {
      try { process.kill(pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (let attempt = 0; attempt < 50 && ownedPids.some(isRunning); attempt++) await delay(100);
    if (!ownedPids.some(isRunning)) break;
  }
  try { assert.equal(ownedPids.some(isRunning), false, 'Isolated fixture and backend must both exit'); }
  finally { await rm(stateDir, {recursive:true, force:true}); }
}
