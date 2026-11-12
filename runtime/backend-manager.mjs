import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createBackendRuntime, inspectBackendBinary, prepareBackendCopy } from './backend-runtime.mjs';
import { connectBackendApp, launchBackendApp } from './backend-launch.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const savedMessage = '已保存。正常退出 Antigravity 后，点击“Antigravity 汉化助手”图标启动。';
const runningMessage = '已切到正在运行的 Antigravity，但本次子代理上下文覆盖未启用。请正常退出后，点击“Antigravity 汉化助手”图标重新启动。';

function validLimit(tokens) {
  return tokens === null || Number.isSafeInteger(tokens) && tokens > 0 && tokens <= 4294967295;
}

/** Own persisted subagent preferences and only app sessions launched by this helper. */
export function createBackendManager({ stateDir, runtimeDir, appPath = '/Applications/Antigravity.app', onChange }) {
  const directory = resolve(stateDir);
  const settingsPath = join(directory, 'backend-context.json');
  const receiptPath = join(directory, 'backend-session.json');
  const appExecutable = join(appPath, 'Contents', 'MacOS', 'Antigravity');
  const officialBackendPath = join(appPath, 'Contents', 'Resources', 'bin', 'language_server');
  let targetTokens = null, owner = null, disposed = false, disposal;
  let pending = Promise.resolve();
  let status = { targetTokens: null, active: false, error: null, message: '使用子代理默认上下文' };

  const getStatus = () => ({ ...status });
  function publish({ active = status.active, error = status.error } = {}) {
    status = { targetTokens, active: targetTokens !== null && active, error,
      message: targetTokens === null ? '使用子代理默认上下文' : active ? '' : savedMessage };
    if (!disposed) {
      // A closing renderer must not turn a committed setting into a failed save.
      try { onChange?.(getStatus())?.catch?.(() => {}); } catch {}
    }
    return getStatus();
  }
  async function readJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function writeJson(path, value) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(directory, '.backend-write-'));
    try {
      const file = join(temporary, 'value.json');
      await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await rename(file, path);
    } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
  }
  async function processes() {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const result = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match) result.set(Number(match[1]), match[2].trim());
    }
    return result;
  }
  function fridaModulePath() {
    const candidates = [process.env.ANTIGRAVITY_HELPER_FRIDA, join(directory, 'runtime-deps', 'node_modules', 'frida'),
      join(homedir(), '.local', 'share', 'mcp-tools', 'frida-mcp', 'node_modules', 'frida')];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try { return require.resolve(candidate); } catch {}
    }
    throw new Error('未找到 Frida 运行库。请配置 ANTIGRAVITY_HELPER_FRIDA，或将 frida 安装到助手的 runtime-deps 目录。');
  }
  async function appEnvironment() {
    const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')],
      { timeout: 5000, maxBuffer: 1024 * 1024 });
    const environment = JSON.parse(stdout).LSEnvironment ?? {};
    return { ...process.env, ...environment };
  }
  async function inspectReceipt(receipt) {
    if (!receipt || !Number.isSafeInteger(receipt.appPid) || receipt.appPid <= 0 ||
        !Number.isSafeInteger(receipt.backendPid) || receipt.backendPid <= 0) return null;
    let inspector;
    try { inspector = new URL(receipt.inspectorUrl); } catch { return null; }
    if (inspector.protocol !== 'ws:' || inspector.hostname !== '127.0.0.1' || !inspector.port) return null;
    const [app, official, helper, backendFolder, current] = await Promise.all([
      realpath(appExecutable), realpath(officialBackendPath), realpath(receipt.helperBackendPath),
      realpath(join(directory, 'backend')), processes(),
    ]);
    const ownedPath = relative(backendFolder, helper).split(sep);
    if (receipt.officialBackendPath !== official || helper === official || ownedPath.length !== 2 ||
        !/^\d+$/.test(ownedPath[0]) || ownedPath[1] !== 'language_server') return null;
    return { appPid: receipt.appPid, backendPid: receipt.backendPid, appExecutable: app, helperBackendPath: helper,
      matches: current.get(receipt.appPid) === app && current.get(receipt.backendPid) === helper };
  }

  async function reapOrphanedBackend(owned) {
    if (!owned) return;
    const appPid = owned.session?.appPid ?? owned.appPid;
    if (!Number.isSafeInteger(appPid) || appPid <= 0) return;
    const current = await processes();
    if (current.get(appPid) === owned.appExecutable) return;
    owned.appGone = true;
    if (owned.backendGone || !Number.isSafeInteger(owned.backendPid) || owned.backendPid <= 0) return;
    if (current.get(owned.backendPid) === owned.helperBackendPath) {
      // Once its App has exited, only this recorded helper copy is ours to reap.
      // Killing it also releases Frida requests stuck in its last native thread.
      try { process.kill(owned.backendPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    // A missing or reused PID also means the original native target has gone.
    owned.backendGone = true;
  }

  async function releaseOwned(owned) {
    if (!owned) return;
    owned.cancelled = true;
    // An earlier release may already be waiting on this now-orphaned backend.
    await reapOrphanedBackend(owned);
    if (owned.releasing) return owned.releasing;
    owned.releasing = (async () => {
      let failure;
      // Release an owned Inspector pause before waiting for native detachment.
      // A dead or replaced PID is no longer ours to resume or reconnect to.
      if (!owned.appGone) {
        try { await owned.session?.restore(); } catch (error) { failure = error; }
      }
      // The App may have exited while its Inspector was being restored.
      await reapOrphanedBackend(owned);
      try { await owned.runtime.dispose(); } catch (error) { failure ??= error; }
      // An exited target has no live hooks left to restore. Frida can report
      // its destruction before its detached notification reaches this runner.
      if (owned.appGone && owned.backendGone) failure = null;
      if (owner === owned) {
        if (owned.appGone) {
          try { await rm(receiptPath, { force: true }); } catch (error) { failure ??= error; }
        }
        if (!failure) owner = null;
      }
      if (failure) throw failure;
      return { appGone: Boolean(owned.appGone) };
    })();
    try { return await owned.releasing; }
    catch (error) { owned.releasing = null; throw error; }
  }
  async function failOwned(owned, error, session) {
    if (session) owned.session = session;
    if (owner !== owned) return;
    publish({ active: false, error: error.message });
    try {
      const result = await releaseOwned(owned);
      if (result?.appGone) publish({ active: false, error: null });
    }
    catch (cleanup) { publish({ active: false, error: `${error.message}；恢复正常执行失败：${cleanup.message}` }); }
  }
  function createOwner(helperBackendPath, executable, layout, appPid = null, backendPid = null) {
    const owned = { session: null, cancelled: false, attaching: false, releasing: null, appPid, backendPid,
      appExecutable: executable, helperBackendPath,
      runtime: createBackendRuntime({ fridaModulePath: fridaModulePath(), hookSourcePath: join(runtimeDir, 'backend-hook.js'),
        expectedBinaryPath: helperBackendPath, layout, targetTokens }) };
    owner = owned;
    return owned;
  }
  function callbacks(owned, official, helper) {
    return {
      async onBackendSpawn(pid, { signal, appPid, inspectorUrl }) {
        owned.appPid = appPid;
        owned.backendPid = pid;
        if (disposed || owned.cancelled || signal.aborted) throw new Error('子代理上下文连接已取消');
        owned.attaching = true;
        try {
          // This records ownership, not successful instrumentation. Keep it even
          // if the first attach fails so a helper reload can validate and reconnect.
          await writeJson(receiptPath, { appPid, backendPid: pid, inspectorUrl, officialBackendPath: official, helperBackendPath: helper });
          if (disposed || owned.cancelled || signal.aborted) throw new Error('子代理上下文连接已取消');
          const result = await owned.runtime.attach(pid);
          if (!result.attached || result.lastError) throw new Error(result.lastError || '未能连接助手的后端副本');
          if (disposed || owned.cancelled || signal.aborted) throw new Error('子代理上下文连接已取消');
          publish({ active: true, error: null });
        } finally { owned.attaching = false; }
      },
      onError(error, session) {
        if (owner === owned && !owned.cancelled) void failOwned(owned, error, session);
      },
    };
  }
  async function initialize() {
    try {
      const saved = await readJson(settingsPath);
      if (saved && !validLimit(saved.targetTokens)) throw new Error('已保存的子代理上下文设置无效');
      targetTokens = saved?.targetTokens ?? null;
      publish({ active: false, error: null });
      const receipt = await readJson(receiptPath);
      if (!receipt || disposed) return getStatus();
      let candidate;
      try { candidate = await inspectReceipt(receipt); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!candidate?.matches) {
        await reapOrphanedBackend(candidate);
        await rm(receiptPath, { force: true });
        return getStatus();
      }
      const { helperBackendPath: helper, appExecutable: executable } = candidate;
      const layout = await inspectBackendBinary(helper);
      if (disposed) return getStatus();
      const owned = createOwner(helper, executable, layout, receipt.appPid, receipt.backendPid);
      try {
        const session = await connectBackendApp({ enabled: true, ...receipt, helperBackendPath: helper,
          ...callbacks(owned, receipt.officialBackendPath, helper) });
        owned.session = session;
        if (disposed || owned.cancelled) throw new Error('子代理上下文连接已取消');
        await session.ready;
        if (!disposed && !owned.cancelled) publish({ active: true, error: null });
      } catch (error) {
        await failOwned(owned, error, error.session);
      }
    } catch (error) { publish({ active: false, error: error.message }); }
    return getStatus();
  }
  const ready = initialize();
  function serial(action) {
    const result = pending.then(async () => { await ready; return action(); });
    pending = result.catch(() => {});
    return result;
  }

  return {
    ready,
    getStatus,
    refresh() {
      return serial(async () => {
        const owned = owner;
        if (disposed || !owned || owned.cancelled || owned.attaching) return getStatus();
        const gate = owned.session?.getStatus();
        if (gate?.phase === 'failed' || gate?.phase === 'exited' || gate?.phase === 'restored') {
          await failOwned(owned, new Error(gate.error || '助手后端连接已结束，请退出 Antigravity 后通过助手重新启动'));
          return getStatus();
        }
        try {
          const native = await owned.runtime.status();
          if (!native.attached || native.lastError) throw new Error(native.lastError || '助手后端已断开，请退出 Antigravity 后通过助手重新启动');
          return publish({ active: true, error: null });
        } catch (error) {
          await failOwned(owned, error);
          return getStatus();
        }
      });
    },
    setLimit(tokens) {
      return serial(async () => {
        if (disposed) return getStatus();
        if (!validLimit(tokens)) return publish({ error: '子代理上下文上限必须为正整数 token，或恢复默认' });
        const previous = targetTokens, owned = owner && !owner.cancelled ? owner : null;
        let applied;
        try {
          if (owned) {
            applied = await owned.runtime.setLimit(tokens);
            if (applied.lastError) throw new Error(applied.lastError);
          }
          await writeJson(settingsPath, { targetTokens: tokens });
          targetTokens = tokens;
          return publish({ active: Boolean(owned && !owned.cancelled && applied?.attached), error: null });
        } catch (error) {
          if (owned && !owned.cancelled) {
            try { await owned.runtime.setLimit(previous); }
            catch (rollback) { await failOwned(owned, new Error(`${error.message}；恢复原设置失败：${rollback.message}`)); return getStatus(); }
          }
          return publish({ error: `保存失败，原设置已保留：${error.message}` });
        }
      });
    },
    launch() {
      // Refresh may be waiting on an old native dispose inside the serial queue.
      // Reap outside that queue so a new launch can release it after the App exits.
      const orphanCleanup = disposed ? Promise.resolve(null)
        : reapOrphanedBackend(owner).then(() => null, error => error);
      return serial(async () => {
        if (disposed) return { launched: false, message: '汉化助手已退出' };
        try {
          const cleanupError = await orphanCleanup;
          if (cleanupError) throw cleanupError;
          const executable = await realpath(appExecutable);
          if ([...(await processes()).values()].includes(executable)) {
            await exec('/usr/bin/open', [appPath], { timeout: 10000 });
            const active = status.active && owner && !owner.appGone;
            return { launched: false, message: targetTokens === null || active ? '' : runningMessage };
          }
          if (disposed) return { launched: false, message: '汉化助手已退出' };
          await releaseOwned(owner);
          if (targetTokens === null) {
            await exec('/usr/bin/open', [appPath], { timeout: 10000 });
            publish({ active: false, error: null });
            return { launched: true, message: '' };
          }
          const official = await realpath(officialBackendPath);
          // Resolve dependencies before creating a copy or starting the app.
          fridaModulePath();
          const prepared = await prepareBackendCopy({ officialBackendPath: official, stateDir: directory });
          const helper = prepared.binaryPath;
          const environment = await appEnvironment();
          if (disposed) return { launched: false, message: '汉化助手已退出' };
          const owned = createOwner(helper, executable, prepared.layout);
          try {
            const session = await launchBackendApp({ enabled: true, appExecutable: executable,
              officialBackendPath: official, helperBackendPath: helper, env: environment,
              ...callbacks(owned, official, helper) });
            owned.session = session;
            if (disposed || owned.cancelled) throw new Error('子代理上下文启动已取消');
            await session.ready;
            if (disposed || owned.cancelled) throw new Error('子代理上下文启动已取消');
            publish({ active: true, error: null });
            return { launched: true, message: '' };
          } catch (error) {
            await failOwned(owned, error, error.session);
            return { launched: false, message: status.error || error.message };
          }
        } catch (error) {
          publish({ active: false, error: error.message });
          return { launched: false, message: error.message };
        }
      });
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      // Do not queue restore behind launch.ready: an owned spawn pause may be
      // precisely what is keeping that promise pending.
      const interruption = owner?.session ? releaseOwned(owner) : Promise.resolve();
      disposal = (async () => {
        let error;
        try { await interruption; } catch (failure) { error = failure; }
        await ready;
        await pending;
        try { await releaseOwned(owner); } catch (failure) { error ??= failure; }
        publish({ active: false, error: error?.message ?? null });
        return getStatus();
      })();
      return disposal;
    },
  };
}
