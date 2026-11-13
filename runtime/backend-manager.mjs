import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createBackendRuntime, inspectBackendBinary, prepareBackendCopy } from './backend-runtime.mjs';
import { connectBackendApp, launchBackendApp } from './backend-launch.mjs';

const exec = promisify(execFile);
export const antigravityDataDirectories = ['Antigravity', 'antigravity'].map(name =>
  join(homedir(), 'Library', 'Application Support', name));
const savedMessage = '已保存。正常退出 Antigravity 后，点击“Antigravity 汉化助手”图标启动。';
const runningMessage = '已切到正在运行的 Antigravity，但本次子代理上下文覆盖未启用。请正常退出后，点击“Antigravity 汉化助手”图标重新启动。';
const mainSavedMessage = '主代理上下文已保存，但本次预算适配未启用。请正常退出 Antigravity 后，点击“Antigravity 汉化助手”图标重新启动。';
const mainStoragePrefix = 'antigravityChineseHelper.contextLimit.';

function validLimit(tokens) {
  return tokens === null || Number.isSafeInteger(tokens) && tokens > 0 && tokens <= 4294967295;
}

/** Own the shared native budget lifecycle; main preferences stay in nativeStorage. */
export function createBackendManager({ stateDir, runtimeDir, appPath = '/Applications/Antigravity.app', appStoragePath, onChange }) {
  const directory = resolve(stateDir);
  const settingsPath = join(directory, 'backend-context.json');
  const receiptPath = join(directory, 'backend-session.json');
  const mainSettingsPaths = appStoragePath ? [resolve(appStoragePath)]
    : antigravityDataDirectories.map(path => join(path, 'app_storage.json'));
  const machExecutablePath = join(runtimeDir, '..', 'Antigravity汉化助手.app', 'Contents', 'MacOS', 'AntigravityBackendMach');
  const appExecutable = join(appPath, 'Contents', 'MacOS', 'Antigravity');
  const officialBackendPath = join(appPath, 'Contents', 'Resources', 'bin', 'language_server');
  let targetTokens = null, owner = null, disposed = false, disposal;
  let pending = Promise.resolve();
  let error = null;
  let mainOverrides = false, mainSettingsError = null;

  const getStatus = () => {
    const native = owner?.runtime.getStatus();
    const nativeReady = !disposed && Boolean(owner && !owner.appGone && !owner.ending &&
      owner.session?.getStatus().phase === 'running' && native.attached && !native.disposed && !native.lastError);
    const active = targetTokens !== null && nativeReady;
    return { targetTokens, active, nativeReady, mainOverrides, error: error ?? mainSettingsError,
      mainMessage: mainSettingsError ?? (mainOverrides && !nativeReady ? mainSavedMessage : ''),
      message: targetTokens === null ? '使用子代理默认上下文' : active ? '' : savedMessage };
  };
  function publish({ error: nextError = error } = {}) {
    error = nextError;
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
  async function refreshMainSettings() {
    try {
      let present = false;
      for (const path of mainSettingsPaths) {
        let contents;
        try { contents = await readFile(path, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const items = contents.trim() ? JSON.parse(contents) : {};
        if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('Invalid nativeStorage object');
        present = Object.entries(items).some(([key, value]) => key.startsWith(mainStoragePrefix) && validLimit(Number(value)));
        break;
      }
      mainOverrides = present;
      mainSettingsError = null;
      return true;
    } catch {
      // The shared file can contain other native preferences. Report the
      // boundary failure without returning its JSON or a parser's excerpt.
      mainSettingsError = '无法读取 Antigravity 的主代理上下文设置，请检查本地存储后重试。';
      return false;
    }
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
      try { process.kill(owned.backendPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    // A missing or reused PID also means the original native target has gone.
    owned.backendGone = true;
  }

  function endOwner(owned, failure = null, session = null) {
    if (!owned) return Promise.resolve(null);
    if (owner !== owned) return Promise.resolve(null);
    if (session) owned.session = session;
    const phase = owned.session?.getStatus().phase;
    if (phase === 'exiting' || phase === 'exited') failure = null;
    // 回收必须先于等待原生清理启动，否则残留后台与 dispose 会互相等待。
    const reaping = reapOrphanedBackend(owned).then(() => null, error => error);
    if (!owned.ending) {
      owned.ending = Promise.resolve().then(async () => {
        let cleanupError = null;
        try {
          if (!owned.session && owned.opening) {
            try { owned.session = await owned.opening; }
            catch (error) { owned.session = error.session ?? null; }
          }
          const reapError = await reaping;
          if (reapError) throw reapError;
          const currentPhase = owned.session?.getStatus().phase;
          // Exit already closed Inspector. Restore only a still-live App.
          if (!owned.appGone && currentPhase !== 'exiting' && currentPhase !== 'exited') {
            try { await owned.session?.restore(); } catch (error) { cleanupError = error; }
          }
          await reapOrphanedBackend(owned);
          // 写入失败已由启动路径报告；这里只等待落盘结束，保证 receipt 写删顺序。
          if (owned.receiptWrite) await owned.receiptWrite.catch(() => {});
        } catch (error) { cleanupError ??= error; }
        try { await owned.runtime.dispose(); }
        catch (error) {
          // An executor can lose the target while its App exit is being handled.
          if (!owned.appGone || !owned.backendGone) cleanupError ??= error;
        }
        return { failure, cleanupError };
      });
      publish({ error: failure?.message ?? null });
    } else if (phase === 'exiting' || phase === 'exited') publish({ error: null });
    owned.ending = owned.ending.then(async ({ failure, cleanupError }) => {
      try {
        if (owner !== owned) return { failure, cleanupError };
        const reapError = await reaping;
        if (reapError) throw reapError;
        // 进程资源已消失后，旧的恢复/卸载失败不再阻止新会话；文件删除错误仍按本次结果报告。
        if (owned.appGone && owned.backendGone) cleanupError = null;
        if (owner === owned && owned.appGone) await rm(receiptPath, { force: true });
      } catch (error) { cleanupError ??= error; }
      if (owner === owned) {
        const phase = owned.session?.getStatus().phase;
        const original = owned.appGone || phase === 'exiting' || phase === 'exited' ? null : failure?.message;
        publish({ error: cleanupError ? `${original ? `${original}；` : ''}恢复正常执行失败：${cleanupError.message}` : original ?? null });
        if (owned.appGone && !cleanupError) owner = null;
      }
      return { failure, cleanupError };
    });
    return owned.ending.then(result => result.cleanupError);
  }
  function createOwner(helperBackendPath, executable, layout, appPid = null, backendPid = null, receipt = null) {
    const owned = { session: null, opening: null, receiptWrite: null, receipt, ending: null, appPid, backendPid,
      appExecutable: executable, helperBackendPath };
    owned.runtime = createBackendRuntime({ machExecutablePath,
      expectedBinaryPath: helperBackendPath, layout, targetTokens,
      async onInstallation({ pid, descriptor }) {
        if (disposed || owner !== owned || owned.ending || owned.backendPid !== pid) throw new Error('子代理上下文连接已取消');
        owned.receipt = { ...owned.receipt, nativeDescriptor: descriptor };
        owned.receiptWrite = writeJson(receiptPath, owned.receipt);
        await owned.receiptWrite;
      },
      onChange() { if (owner === owned) publish(); } });
    owner = owned;
    return owned;
  }
  function callbacks(owned, official, helper) {
    return {
      async onBackendSpawn(pid, { signal, appPid, inspectorUrl }) {
        if (disposed || owner !== owned || owned.ending || signal.aborted) throw new Error('子代理上下文连接已取消');
        owned.appPid = appPid;
        owned.backendPid = pid;
        // The receipt locates the native installation; its description and live
        // branches remain the authority when another helper reconnects.
        const nativeDescriptor = owned.receipt?.backendPid === pid ? owned.receipt.nativeDescriptor : undefined;
        owned.receipt = { appPid, backendPid: pid, inspectorUrl, officialBackendPath: official, helperBackendPath: helper,
          ...(nativeDescriptor === undefined ? {} : { nativeDescriptor }) };
        owned.receiptWrite = writeJson(receiptPath, owned.receipt);
        await owned.receiptWrite;
        if (disposed || owner !== owned || owned.ending || signal.aborted) throw new Error('子代理上下文连接已取消');
        const result = await owned.runtime.attach(pid, { descriptor: nativeDescriptor });
        if (disposed || owner !== owned || owned.ending || signal.aborted) throw new Error('子代理上下文连接已取消');
        if (!result.attached || result.lastError) throw new Error(result.lastError || '未能连接助手的后端副本');
      },
      onStateChange(status, session) {
        if (owner !== owned) return;
        owned.session = session;
        if (status.phase === 'failed' || status.phase === 'exiting' || status.phase === 'exited' || status.phase === 'restored') {
          void endOwner(owned, status.error ? new Error(status.error) : null);
        } else publish();
      },
    };
  }
  async function initialize() {
    try {
      const saved = await readJson(settingsPath);
      if (saved && !validLimit(saved.targetTokens)) throw new Error('已保存的子代理上下文设置无效');
      targetTokens = saved?.targetTokens ?? null;
      if (!await refreshMainSettings()) return publish();
      publish({ error: null });
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
      const owned = createOwner(helper, executable, layout, receipt.appPid, receipt.backendPid, receipt);
      try {
        owned.opening = connectBackendApp({ enabled: true, ...receipt, helperBackendPath: helper,
          ...callbacks(owned, receipt.officialBackendPath, helper) });
        const session = await owned.opening;
        owned.session = session;
        if (disposed || owned.ending) { await endOwner(owned); return getStatus(); }
        await session.ready;
        if (!disposed && owner === owned && !owned.ending) publish({ error: null });
      } catch (error) {
        await endOwner(owned, error, error.session);
      }
    } catch (error) { publish({ error: error.message }); }
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
    mainSettingsChanged() {
      return serial(async () => {
        if (disposed) return getStatus();
        const refreshed = await refreshMainSettings();
        if (!refreshed) { publish(); throw new Error(mainSettingsError); }
        return publish();
      });
    },
    refresh() {
      return serial(async () => {
        const owned = owner;
        if (disposed || !owned) return getStatus();
        if (owned.ending) {
          await reapOrphanedBackend(owned);
          if (owned.appGone) await endOwner(owned);
          return getStatus();
        }
        const gate = owned.session.getStatus();
        if (gate.phase === 'failed' || gate.phase === 'exiting' || gate.phase === 'exited' || gate.phase === 'restored') {
          void endOwner(owned, gate.error ? new Error(gate.error) : null);
          return getStatus();
        }
        if (gate.phase !== 'running' || !owned.runtime.getStatus().attached) return getStatus();
        try {
          const native = await owned.runtime.status();
          if (native.lastError) throw new Error(native.lastError);
          return publish();
        } catch (error) {
          void endOwner(owned, error);
          return getStatus();
        }
      });
    },
    setLimit(tokens) {
      return serial(async () => {
        if (disposed) return getStatus();
        if (!validLimit(tokens)) return publish({ error: '子代理上下文上限必须为正整数 token，或恢复默认' });
        const previous = targetTokens, owned = owner && !owner.ending ? owner : null;
        try {
          if (owned) {
            const applied = await owned.runtime.setLimit(tokens);
            if (applied.lastError) throw new Error(applied.lastError);
          }
          await writeJson(settingsPath, { targetTokens: tokens });
          targetTokens = tokens;
          return publish({ error: null });
        } catch (error) {
          if (owned && owner === owned && !owned.ending) {
            try { await owned.runtime.setLimit(previous); }
            catch (rollback) { await endOwner(owned, new Error(`${error.message}；恢复原设置失败：${rollback.message}`)); return getStatus(); }
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
          const orphanError = await orphanCleanup;
          if (orphanError) throw orphanError;
          if (!await refreshMainSettings()) {
            publish();
            return { launched: false, message: mainSettingsError };
          }
          const executable = await realpath(appExecutable);
          const running = [...(await processes()).values()].includes(executable);
          if (owner?.session?.getStatus().phase === 'exiting' && !owner.appGone) {
            return { launched: false, message: 'Antigravity 正在退出，请退出完成后再启动。' };
          }
          if (running) {
            await exec('/usr/bin/open', [appPath], { timeout: 10000 });
            const status = getStatus();
            return { launched: false, message: status.mainMessage || (targetTokens === null || status.active ? '' : runningMessage) };
          }
          if (disposed) return { launched: false, message: '汉化助手已退出' };
          const cleanupError = await endOwner(owner);
          if (cleanupError) throw cleanupError;
          if (disposed) return { launched: false, message: '汉化助手已退出' };
          if (targetTokens === null && !mainOverrides) {
            await exec('/usr/bin/open', [appPath], { timeout: 10000 });
            publish({ error: null });
            return { launched: true, message: '' };
          }
          const official = await realpath(officialBackendPath);
          await access(machExecutablePath, constants.X_OK);
          const prepared = await prepareBackendCopy({ officialBackendPath: official, stateDir: directory });
          const helper = prepared.binaryPath;
          const environment = await appEnvironment();
          if (disposed) return { launched: false, message: '汉化助手已退出' };
          const owned = createOwner(helper, executable, prepared.layout);
          try {
            owned.opening = launchBackendApp({ enabled: true, appExecutable: executable,
              officialBackendPath: official, helperBackendPath: helper, env: environment,
              ...callbacks(owned, official, helper) });
            const session = await owned.opening;
            owned.session = session;
            if (disposed || owned.ending) {
              await endOwner(owned);
              return { launched: false, message: getStatus().error || (disposed ? '汉化助手已退出' : 'Antigravity 正在退出或连接已结束。') };
            }
            await session.ready;
            if (disposed || owner !== owned || owned.ending) {
              await endOwner(owned);
              return { launched: false, message: getStatus().error || 'Antigravity 正在退出或连接已结束。' };
            }
            publish({ error: null });
            return { launched: true, message: '' };
          } catch (error) {
            await endOwner(owned, error, error.session);
            return { launched: false, message: getStatus().error || (disposed ? '汉化助手已退出' : 'Antigravity 正在退出或连接已结束。') };
          }
        } catch (error) {
          publish({ error: error.message });
          return { launched: false, message: error.message };
        }
      });
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      // Do not queue restore behind launch.ready: an owned spawn pause may be
      // precisely what is keeping that promise pending.
      const interruption = endOwner(owner);
      disposal = (async () => {
        const failure = await interruption;
        await ready;
        await pending;
        const laterFailure = await endOwner(owner);
        publish({ error: (failure ?? laterFailure)?.message ?? null });
        return getStatus();
      })();
      return disposal;
    },
  };
}
