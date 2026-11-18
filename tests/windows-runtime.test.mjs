import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';
import { resolveAntigravityDataDirectories } from '../runtime/backend-manager.mjs';
import { cliHudSettings } from '../runtime/cli-hud.mjs';
import { findCliExecutable } from '../runtime/cli.mjs';

const exec = promisify(execFile);
const runnerPath = new URL('../runtime/runner.mjs', import.meta.url);

test('Windows data directory discovery includes Roaming, LocalAppData, and explicit override', () => {
  const dirs = resolveAntigravityDataDirectories({
    platform: 'win32',
    home: 'C:\\Users\\Demo',
    env: {
      APPDATA: 'C:\\Users\\Demo\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local',
      ANTIGRAVITY_DATA_DIR: 'D:\\Custom\\AntigravityData',
    },
  });
  assert.equal(dirs[0].endsWith('AntigravityData'), true);
  assert.ok(dirs.some(dir => dir.includes('Roaming') && dir.endsWith('Antigravity')));
  assert.ok(dirs.some(dir => dir.includes('Local') && dir.endsWith('Antigravity')));
});

test('Windows CLI HUD settings double-quote Windows paths and findCliExecutable resolves .exe and .cmd', async () => {
  const winHud = cliHudSettings({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    hudPath: 'C:\\Users\\Demo\\AppData\\Local\\AntigravityChineseHelper\\cli\\cli-hud.mjs',
    platform: 'win32',
  });
  assert.match(winHud.command, /^"C:\\Program Files\\nodejs\\node\.exe" --experimental-sqlite --disable-warning=ExperimentalWarning "C:\\Users\\Demo\\/);

  const dir = await mkdtemp(join(tmpdir(), 'agh-win-cli-'));
  try {
    const fakeCmd = join(dir, 'agy.cmd');
    await writeFile(fakeCmd, '@echo off\r\necho 1.5.9\r\n');
    const resolved = await findCliExecutable(undefined, {
      platform: 'win32',
      home: dir,
      pathDelimiter: ';',
      env: { PATH: `C:\\NonExistent;${dir}`, LOCALAPPDATA: dir },
    });
    assert.equal(resolved.toLowerCase(), fakeCmd.toLowerCase());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows backend manager launches detached executable when closed and focuses when running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-win-mgr-'));
  try {
    const fakeExe = join(dir, 'Antigravity.exe');
    await writeFile(fakeExe, 'stub');

    const moduleUrl = new URL('../runtime/backend-manager.mjs', import.meta.url);
    const source = (await readFile(moduleUrl, 'utf8'))
      .replace(/\r\n/g, '\n')
      .replace(/^import .*;\n/gm, '')
      .replace(/^export /gm, '')
      .replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));

    let running = false;
    const calls = [];
    const spawned = [];
    const execFileMock = (cmd, args, _opts, cb) => {
      if (typeof _opts === 'function') cb = _opts;
      calls.push({ cmd, args });
      if (cmd === 'tasklist.exe') {
        cb(null, running ? '"Antigravity.exe","4321","Console","1","120,000 K"\r\n' : 'INFO: No tasks are running.\r\n', '');
      } else if (cmd === 'powershell.exe') {
        cb(null, '', '');
      } else {
        cb(new Error(`Unexpected command: ${cmd}`));
      }
    };
    execFileMock[promisify.custom] = (...a) => new Promise((yes, no) => {
      execFileMock(...a, (err, stdout, stderr) => err ? no(err) : yes({ stdout, stderr }));
    });

    const { access, mkdir, mkdtemp: mkd, readFile: rf, realpath, rename, rm: rmFn, stat, writeFile: wf } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join: pJoin, relative, resolve, sep } = await import('node:path');

    const ctx = vm.createContext({
      execFile: execFileMock,
      spawn(executable, args, options) {
        spawned.push({ executable, args, options });
        return {
          pid: 9876,
          once(event, fn) { if (event === 'spawn') setImmediate(fn); },
          unref() {},
        };
      },
      promisify,
      constants,
      access, mkdir, mkdtemp: mkd, readFile: rf, realpath, rename, rm: rmFn, stat, writeFile: wf,
      ensureAntigravityCdpBridge: async () => ({ patched: false }),
      resolveAsarPath: async () => null,
      homedir, join: pJoin, relative, resolve, sep,
      createBackendRuntime: () => {}, inspectBackendBinary: () => {}, prepareBackendCopy: () => {},
      connectBackendApp: () => {}, launchBackendApp: () => {}, restoreBackendApp: () => {},
      CONTEXT_OVERRIDES_ENABLED: false,
      process: { platform: 'win32', env: { ANTIGRAVITY_APP_PATH: fakeExe } },
      Date, setTimeout, clearTimeout, URL,
    });
    vm.runInContext(`${source}\nglobalThis.createManager = createBackendManager;`, ctx);

    const manager = ctx.createManager({
      stateDir: dir,
      runtimeDir: dir,
      platform: 'win32',
      env: { ANTIGRAVITY_APP_PATH: fakeExe },
      home: dir,
    });

    await manager.ready;
    assert.equal(manager.getStatus().contextOverridesEnabled, false);

    const firstLaunch = await manager.launch();
    assert.deepEqual({ ...firstLaunch }, { launched: true, message: '' });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].options.detached, true);

    running = true;
    const secondLaunch = await manager.launch();
    assert.deepEqual({ ...secondLaunch }, { launched: false, message: '' });
    assert.equal(spawned.length, 1, 'already running app must be focused rather than spawned again');
    assert.ok(calls.some(call => call.cmd === 'powershell.exe'));

    await manager.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Minimal RFC 6455 WebSocket upgrade server for isolated mock CDP testing. */
function startMockCdpServer(pageContext, targetType = 'page') {
  const scripts = new Map();
  let nextScriptId = 0;
  const sockets = new Set();

  function sendFrame(socket, payloadObj) {
    const data = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x81, data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    socket.write(Buffer.concat([header, data]));
  }

  const httpServer = createServer((req, res) => {
    if (req.url === '/json/list') {
      const port = httpServer.address().port;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{
        id: 'mock-win-1',
        type: targetType,
        url: 'https://127.0.0.1/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/mock-win-1`,
      }]));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));

    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskBytes = masked ? 4 : 0;
        if (buffer.length < offset + maskBytes + length) return;
        const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length));
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        buffer = buffer.subarray(offset + maskBytes + length);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode !== 0x1) continue;
        const msg = JSON.parse(payload.toString('utf8'));
        try {
          if (msg.method === 'Runtime.evaluate') {
            const value = vm.runInContext(msg.params.expression, pageContext);
            sendFrame(socket, { id: msg.id, result: { result: { value } } });
          } else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
            const identifier = `s-${++nextScriptId}`;
            scripts.set(identifier, msg.params.source);
            sendFrame(socket, { id: msg.id, result: { identifier } });
          } else if (msg.method === 'Page.removeScriptToEvaluateOnNewDocument') {
            scripts.delete(msg.params.identifier);
            sendFrame(socket, { id: msg.id, result: {} });
          } else {
            sendFrame(socket, { id: msg.id, result: {} });
          }
        } catch (err) {
          sendFrame(socket, { id: msg.id, result: { exceptionDetails: { text: err.message } } });
        }
      }
    });
  });

  return {
    scripts,
    async listen() {
      await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
      return httpServer.address().port;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise(resolve => httpServer.close(resolve));
    },
  };
}

test('Windows runner connects over Named Pipe IPC, translates mock CDP window, deduplicates, and restores English on --stop', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-win-pipe-'));
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'userdata');
  const runtimeCopy = join(root, 'runtime');
  await mkdtemp(join(root, 'init-'));

  const { mkdir } = await import('node:fs/promises');
  await mkdir(stateDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(runtimeCopy, { recursive: true });

  // Copy minimal runtime modules with a lightweight test renderer so the runner executes end-to-end in isolation.
  for (const name of ['runner.mjs', 'cdp.mjs', 'asar-bridge.mjs', 'backend-manager.mjs', 'context-policy.mjs', 'backend-runtime.mjs', 'backend-launch.mjs', 'backend-hook.js', 'backend-metadata.mjs', 'backend-layout.mjs', 'native-copy.mjs']) {
    const content = await readFile(new URL(`../runtime/${name}`, import.meta.url), 'utf8');
    await writeFile(join(runtimeCopy, name), content);
  }
  await writeFile(join(runtimeCopy, 'renderer.js'), `(function(dictionary) {
    globalThis.__translatedTitle = dictionary.strings.Settings;
    return {
      version: '0.3.41-test',
      refresh(next) { globalThis.__translatedTitle = next.strings.Settings; },
      collectUnknown() { return ['Untranslated Label']; },
      uninstall() { globalThis.__translatedTitle = 'Settings'; }
    };
  })`);
  await writeFile(join(runtimeCopy, 'swarm-renderer.js'), `(function() { return { version: '0.3.41-swarm', refresh() {}, uninstall() {} }; })`);
  await writeFile(join(runtimeCopy, 'translations.json'), JSON.stringify({ strings: { Settings: '设置' } }));

  const page = vm.createContext({
    location: { protocol: 'https:', hostname: '127.0.0.1' },
    electronNative: { getZoomLevel() {} },
    nativeStorage: { getItems() {} },
    __translatedTitle: 'Settings',
  });
  vm.runInContext('globalThis.top = globalThis', page);

  const cdp = startMockCdpServer(page, 'other');
  const port = await cdp.listen();
  await writeFile(join(dataDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/mock\n`);

  const env = {
    ...process.env,
    ANTIGRAVITY_HELPER_STATE_DIR: stateDir,
    ANTIGRAVITY_DATA_DIR: dataDir,
    LOCALAPPDATA: root,
    APPDATA: root,
  };
  const isolatedRunner = join(runtimeCopy, 'runner.mjs');
  let child;

  try {
    child = spawn(process.execPath, [isolatedRunner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });

    for (let i = 0; i < 60 && !stdout.includes('汉化助手已启动'); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert.match(stdout, /汉化助手已启动/);
    assert.equal(page.__translatedTitle, '设置');

    const statusRes = await exec(process.execPath, [isolatedRunner, '--status'], { env });
    const status = JSON.parse(statusRes.stdout);
    assert.equal(status.running, true);
    assert.equal(status.status, 'running');
    assert.equal(status.translatedWindows, 1);

    // Duplicate runner startup on Windows Named Pipe must return existing status and exit 0.
    const dupRes = await exec(process.execPath, [isolatedRunner], { env });
    assert.equal(JSON.parse(dupRes.stdout).pid, child.pid);

    // Hot reload dictionary over Named Pipe.
    await writeFile(join(runtimeCopy, 'translations.json'), JSON.stringify({ strings: { Settings: '偏好设置' } }));
    const reloadRes = await exec(process.execPath, [isolatedRunner, '--reload'], { env });
    assert.equal(JSON.parse(reloadRes.stdout).translatedWindows, 1);
    assert.equal(page.__translatedTitle, '偏好设置');

    // Collect unknown labels over Named Pipe.
    const collectRes = await exec(process.execPath, [isolatedRunner, '--collect'], { env });
    assert.deepEqual(JSON.parse(collectRes.stdout), { windows: [{ unknown: ['Untranslated Label'] }] });

    // Graceful stop restores English and removes navigation script.
    const exited = once(child, 'exit');
    const stopRes = await exec(process.execPath, [isolatedRunner, '--stop'], { env });
    assert.equal(JSON.parse(stopRes.stdout).status, 'stopped');
    const [exitCode] = await exited;
    assert.equal(exitCode, 0);
    assert.equal(page.__translatedTitle, 'Settings');
    assert.equal(page.__antigravityChineseHelper, undefined);
    assert.equal(cdp.scripts.size, 0);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await cdp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('asar-bridge patches Electron main entry, preserves unpacked/non-contiguous files, recomputes SHA256 integrity, and re-patches on version update', async () => {
  const { CDP_BRIDGE_MARKER, ensureAntigravityCdpBridge, patchAsarBuffer, readAsarHeader } = await import('../runtime/asar-bridge.mjs');
  const root = await mkdtemp(join(tmpdir(), 'agh-asar-test-'));
  try {
    function buildSyntheticAsar(version, mainCode) {
      const pkgBytes = Buffer.from(JSON.stringify({ name: 'antigravity', version, main: './dist/main.js' }), 'utf8');
      const mainBytes = Buffer.from(mainCode, 'utf8');
      const extraBytes = Buffer.from('hello-antigravity', 'utf8');
      const hashHex = (buf) => createHash('sha256').update(buf).digest('hex');
      const headerObj = {
        files: {
          'package.json': { size: pkgBytes.length, offset: '0', integrity: { algorithm: 'SHA256', hash: hashHex(pkgBytes), blockSize: 4194304, blocks: [hashHex(pkgBytes)] } },
          native: { files: { 'addon.node': { size: 128, unpacked: true } } },
          dist: {
            files: {
              'main.js': { size: mainBytes.length, offset: String(pkgBytes.length), integrity: { algorithm: 'SHA256', hash: hashHex(mainBytes), blockSize: 4194304, blocks: [hashHex(mainBytes)] } },
              'extra.txt': { size: extraBytes.length, offset: String(pkgBytes.length + mainBytes.length), integrity: { algorithm: 'SHA256', hash: hashHex(extraBytes), blockSize: 4194304, blocks: [hashHex(extraBytes)] } },
            },
          },
        },
      };
      const jsonBytes = Buffer.from(JSON.stringify(headerObj), 'utf8');
      const aligned = Math.ceil(jsonBytes.length / 4) * 4;
      const prefix = Buffer.alloc(16 + aligned);
      prefix.writeUInt32LE(4, 0);
      prefix.writeUInt32LE(8 + aligned, 4);
      prefix.writeUInt32LE(4 + aligned, 8);
      prefix.writeUInt32LE(jsonBytes.length, 12);
      jsonBytes.copy(prefix, 16);
      return Buffer.concat([prefix, pkgBytes, mainBytes, extraBytes]);
    }

    const v1Raw = buildSyntheticAsar('2.32.0', '"use strict";\nconst { app } = require("electron");\napp.whenReady();\n');
    const first = patchAsarBuffer(v1Raw);
    assert.equal(first.patched, true);
    assert.equal(first.version, '2.32.0');

    const { header, dataOffset } = readAsarHeader(first.buffer);
    const patchedMainEntry = header.files.dist.files['main.js'];
    const patchedMainText = first.buffer.subarray(dataOffset + Number(patchedMainEntry.offset), dataOffset + Number(patchedMainEntry.offset) + patchedMainEntry.size).toString('utf8');
    assert.ok(patchedMainText.includes(CDP_BRIDGE_MARKER));
    assert.equal(patchedMainEntry.integrity.hash, createHash('sha256').update(Buffer.from(patchedMainText, 'utf8')).digest('hex'));

    const extraEntry = header.files.dist.files['extra.txt'];
    const extraText = first.buffer.subarray(dataOffset + Number(extraEntry.offset), dataOffset + Number(extraEntry.offset) + extraEntry.size).toString('utf8');
    assert.equal(extraText, 'hello-antigravity');
    assert.equal(header.files.native.files['addon.node'].unpacked, true);

    const idempotent = patchAsarBuffer(first.buffer);
    assert.equal(idempotent.patched, false);
    assert.equal(idempotent.alreadyPatched, true);

    // End-to-end auto-migration across simulated Antigravity overwrite update (2.32.0 -> 2.33.0)
    const appDir = join(root, 'app');
    const resDir = join(appDir, 'resources');
    const stateDir = join(root, 'state');
    const { mkdir, readdir } = await import('node:fs/promises');
    await mkdir(resDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const fakeExe = join(appDir, 'Antigravity.exe');
    const asarFile = join(resDir, 'app.asar');
    await writeFile(fakeExe, 'stub');
    await writeFile(asarFile, v1Raw);

    const mig1 = await ensureAntigravityCdpBridge({ executablePath: fakeExe, stateDir, platform: 'win32' });
    assert.equal(mig1.patched, true);
    assert.ok((await readdir(stateDir)).includes('app.asar.2.32.0.bak'));

    // Simulate official installer overwriting app.asar with unpatched v2.33.0
    const v2Raw = buildSyntheticAsar('2.33.0', 'import { app } from "electron";\nconsole.log("v2.33.0");\n');
    await writeFile(asarFile, v2Raw);
    const mig2 = await ensureAntigravityCdpBridge({ executablePath: fakeExe, stateDir, platform: 'win32' });
    assert.equal(mig2.patched, true);
    assert.equal(mig2.version, '2.33.0');
    const stateFiles = await readdir(stateDir);
    assert.ok(stateFiles.includes('app.asar.2.33.0.bak'));
    assert.ok(!stateFiles.includes('app.asar.2.32.0.bak'), 'old backup cleaned up so only latest version backup remains');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
