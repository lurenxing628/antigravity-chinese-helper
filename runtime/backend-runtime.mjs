import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const supportedBuildCL = '1017595969';
const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.security.get-task-allow</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>
`;

/** Prepare an independently signed copy; the official installation is read-only. */
export async function prepareBackendCopy({ officialBackendPath, stateDir }) {
  const official = await realpath(officialBackendPath);
  const { stdout } = await exec(official, ['--stamp'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const buildCL = stdout.match(/^Built at CL: (\d+)\r?$/m)?.[1];
  if (buildCL !== supportedBuildCL) {
    throw new Error(`不支持的后端版本：${buildCL ?? '未返回 CL'}；当前仅支持 CL ${supportedBuildCL}`);
  }

  const folder = join(resolve(stateDir), 'backend', buildCL);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(folder, '.prepare-'));
  const binaryPath = join(folder, 'language_server');
  const temporaryBinary = join(temporary, 'language_server');
  const entitlementsPath = join(temporary, 'entitlements.plist');
  try {
    await copyFile(official, temporaryBinary);
    await chmod(temporaryBinary, 0o755);
    await writeFile(entitlementsPath, entitlements, { mode: 0o600 });
    await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlementsPath, temporaryBinary],
      { timeout: 30000, maxBuffer: 1024 * 1024 });
    await exec('/usr/bin/codesign', ['--verify', '--strict', temporaryBinary], { timeout: 30000, maxBuffer: 1024 * 1024 });
    await rename(temporaryBinary, binaryPath);
    return { binaryPath, buildCL };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function contextLimit(tokens) {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 4294967295)) {
    throw new RangeError('上下文上限必须为正整数 token；null 表示停用覆盖');
  }
  return tokens;
}

/** Own one local Frida session without depending on an MCP server or session ID. */
export function createBackendRuntime({ fridaModulePath, hookSourcePath, expectedBinaryPath, targetTokens = null }) {
  let limit = contextLimit(targetTokens);
  let connection = null;
  let disposed = false;
  let lastError = null;
  let detachedReason = null;
  let pending = Promise.resolve();
  let fridaPromise;

  const enqueue = action => {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  };
  const assertActive = () => {
    if (disposed) throw new Error('后端运行时已退出');
  };
  const loadFrida = () => fridaPromise ??= import(pathToFileURL(require.resolve(fridaModulePath)).href)
    .then(module => module.default ?? module);
  const snapshot = native => ({
    attached: Boolean(connection?.initialized && !connection.session.isDetached()),
    pid: connection?.pid ?? null,
    expectedBinaryPath,
    targetTokens: limit,
    disposed,
    detachedReason,
    lastError,
    native: native ?? null,
  });

  async function release(current) {
    if (!current) return;
    if (connection === current) connection = null;
    current.session.detached.disconnect(current.onDetached);
    let failure;
    if (current.script && !current.script.isDestroyed) {
      try { await current.script.exports.dispose(); } catch (error) { failure = error; }
      try { await current.script.unload(); } catch (error) { failure ??= error; }
    }
    if (!current.session.isDetached()) {
      try { await current.session.detach(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }

  async function readStatus() {
    const current = connection;
    if (!current?.initialized || current.session.isDetached() || current.script.isDestroyed) return snapshot();
    try {
      return snapshot(await current.script.exports.status());
    } catch (error) {
      lastError = error.message;
      return snapshot();
    }
  }

  return {
    attach(pid) {
      return enqueue(async () => {
        assertActive();
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('需要有效的后端 PID');
        if (connection?.pid === pid && connection.initialized && !connection.session.isDetached()) return readStatus();
        await release(connection);
        lastError = detachedReason = null;
        const [frida, source, binaryPath] = await Promise.all([
          loadFrida(), readFile(hookSourcePath, 'utf8'), realpath(expectedBinaryPath),
        ]);
        let current;
        try {
          const device = await frida.getLocalDevice();
          // The launcher waits for the native listening-port event before this
          // call. A returned ChildProcess PID alone does not mean dyld is ready.
          const session = await device.attach(pid);
          current = { pid, session, script: null, initialized: false, onDetached: null };
          current.onDetached = reason => {
            if (connection !== current) return;
            connection = null;
            detachedReason = String(reason);
          };
          session.detached.connect(current.onDetached);
          connection = current;
          current.script = await session.createScript(source, { runtime: frida.ScriptRuntime.V8 });
          await current.script.load();
          // initialize verifies Process.mainModule.path and the supported native
          // instructions before installing hooks. Loading alone installs none.
          await current.script.exports.initialize(binaryPath, limit);
          current.initialized = true;
          return readStatus();
        } catch (error) {
          lastError = error.message;
          // Always unload and detach after a failed initialization; report its
          // original validation error even if an exited process also rejects cleanup.
          await release(current).catch(() => {});
          throw error;
        }
      });
    },
    setLimit(tokens) {
      return enqueue(async () => {
        assertActive();
        const next = contextLimit(tokens);
        if (connection?.initialized && !connection.session.isDetached()) {
          try { await connection.script.exports.configure(next); }
          catch (error) { lastError = error.message; throw error; }
        }
        limit = next;
        lastError = null;
        return readStatus();
      });
    },
    status() { return enqueue(readStatus); },
    detach() {
      return enqueue(async () => {
        try { await release(connection); }
        catch (error) { lastError = error.message; throw error; }
        return snapshot();
      });
    },
    dispose() {
      disposed = true;
      return enqueue(async () => {
        try { await release(connection); }
        catch (error) { lastError = error.message; throw error; }
        return snapshot();
      });
    },
  };
}
