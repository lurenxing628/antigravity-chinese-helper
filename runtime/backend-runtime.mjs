import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import hook from './backend-hook.js';
import { promisify } from 'node:util';
import { parseBackendMetadata, prepareBackendMetadata } from './backend-metadata.mjs';
import { deriveBackendLayout } from './backend-layout.mjs';

const exec = promisify(execFile);
const { emitStubs } = hook;
export const defaultMachExecutablePath = fileURLToPath(new URL('../Antigravity汉化助手.app/Contents/MacOS/AntigravityBackendMach', import.meta.url));
const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.security.get-task-allow</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>
`;

/** Symbols, the owned LC_NOTE slot and the Go instruction/GC contract travel together. */
export async function inspectBackendBinary(binaryPath) {
  const binary = await readFile(binaryPath);
  const metadata = parseBackendMetadata(binary);
  if (!metadata.budgetSlot) throw new Error('后台副本缺少 LC_NOTE 预算预留区，请正常退出 Antigravity 后通过助手重新启动');
  return deriveBackendLayout(binary, metadata);
}

/** Prepare an independently signed copy; the official installation is read-only. */
export async function prepareBackendCopy({ officialBackendPath, stateDir }) {
  const official = await realpath(officialBackendPath);
  const { stdout } = await exec(official, ['--stamp'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const buildCL = stdout.match(/^Built at CL: (\d+)\r?$/m)?.[1];
  if (!buildCL) throw new Error('后台未返回有效的构建编号');
  // 只解析实际将启动的副本，解析结果随副本交给连接流程复用。

  const folder = join(resolve(stateDir), 'backend', buildCL);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(folder, '.prepare-'));
  const binaryPath = join(folder, 'language_server');
  const temporaryBinary = join(temporary, 'language_server');
  const entitlementsPath = join(temporary, 'entitlements.plist');
  try {
    await copyFile(official, temporaryBinary);
    await chmod(temporaryBinary, 0o755);
    const binary = await readFile(temporaryBinary);
    const layout = deriveBackendLayout(binary, prepareBackendMetadata(binary));
    await writeFile(temporaryBinary, binary);
    await writeFile(entitlementsPath, entitlements, { mode: 0o600 });
    await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlementsPath, temporaryBinary],
      { timeout: 30000, maxBuffer: 1024 * 1024 });
    await exec('/usr/bin/codesign', ['--verify', '--strict', temporaryBinary], { timeout: 30000, maxBuffer: 1024 * 1024 });
    await rename(temporaryBinary, binaryPath);
    return { binaryPath: await realpath(binaryPath), buildCL, layout };
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

function nativeStatus(result) {
  if (!result.stateHex) return result;
  const state = Buffer.from(result.stateHex, 'hex');
  const u32 = offset => state.readUInt32LE(offset);
  const reasons = ['unobserved', 'applied', 'default', 'missing-checkpoint', 'disabled-checkpoint', 'missing-capacity', 'changed-model'];
  return { ...result, targetTokens:u32(0) || null, parentLimit:u32(4) || null, active:u32(52) !== 0,
    lastBudget:u32(20) ? { before:u32(12), applied:u32(8), capacity:u32(16) || null,
      result:reasons[u32(20)] ?? 'unknown', modelBefore:u32(28), modelAfter:u32(24),
      customBefore:u32(32), customAfter:u32(36) } : null };
}

/** The runner owns preferences; each Mach command takes control briefly and exits. */
export function createBackendRuntime({ machExecutablePath = defaultMachExecutablePath, expectedBinaryPath,
  layout, targetTokens = null, onChange, onInstallation }) {
  let limit = contextLimit(targetTokens);
  let connection = null, disposed = false, lastError = null, detachedReason = null;
  let pending = Promise.resolve();
  const enqueue = action => {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  };
  const assertActive = () => { if (disposed) throw new Error('后端运行时已退出'); };
  const snapshot = native => ({
    attached:Boolean(!disposed && connection?.initialized && connection.active && !lastError), pid:connection?.pid ?? null,
    expectedBinaryPath, targetTokens:limit, disposed, detachedReason, lastError, native:native ?? null,
  });
  const getStatus = () => snapshot();
  const publish = () => onChange?.(getStatus());
  const siteRvas = () => ['reset', 'observe', 'final', 'consume'].map(name => String(layout.sites[name].rva));
  async function command(current, operation, args = []) {
    try {
      const { stdout } = await exec(machExecutablePath,
        [operation, String(current.pid), expectedBinaryPath, ...args.map(String)],
        { timeout:15000, killSignal:'SIGKILL', maxBuffer:1024 * 1024 });
      return nativeStatus(JSON.parse(stdout));
    } catch (error) {
      if (error.stderr?.includes('TARGET_EXITED')) error.code = 'TARGET_EXITED';
      if (error.stderr?.trim()) error.message = error.stderr.trim();
      throw error;
    }
  }
  function failed(current, error) {
    if (connection !== current) return;
    lastError = error.message;
    if (error.code === 'TARGET_EXITED') {
      connection = null;
      detachedReason = 'process-terminated';
      lastError = null;
    }
    publish();
  }
  async function release(current) {
    if (!current) return;
    current.initialized = false;
    publish();
    if (current.descriptor) {
      try { await command(current, 'remove', [current.descriptor]); }
      catch (error) {
        if (error.code !== 'TARGET_EXITED') { failed(current, error); throw error; }
      }
    }
    if (connection === current) { connection = null; publish(); }
  }
  async function readStatus() {
    const current = connection;
    if (disposed || !current?.initialized) return snapshot();
    try {
      const native = await command(current, 'inspect', [...siteRvas(), current.descriptor]);
      current.initialized = native.initialized;
      current.active = native.active;
      lastError = native.initialized && native.active ? null : '后台预算跳转已断开';
      return snapshot(native);
    } catch (error) { failed(current, error); return snapshot(); }
  }
  async function install(current, prepared) {
    const generated = emitStubs({ base:prepared.base, code:prepared.code, data:prepared.data, layout,
      capacity:layout.budgetSlot.capacity });
    const manifest = Buffer.alloc(200);
    manifest.write('AGHPLAN2');
    for (const [offset, field] of [[8,'base'], [16,'code'], [24,'data']]) manifest.writeBigUInt64LE(BigInt(prepared[field]), offset);
    manifest.writeUInt32LE(prepared.generation, 32);
    manifest.writeUInt32LE(generated.code.length, 36);
    for (const [index, site] of generated.sites.entries()) {
      const offset = 40 + index * 40;
      manifest.writeBigUInt64LE(BigInt(site.address), offset);
      for (const [wordIndex, word] of layout.sites[site.name].originalWords.entries()) manifest.writeUInt32LE(word, offset + 8 + wordIndex * 4);
      manifest.writeUInt32LE(site.branchWord, offset + 24);
    }
    const temporary = await mkdtemp(join(tmpdir(), 'agh-mach-install-'));
    try {
      const planPath = join(temporary, 'plan.bin'), codePath = join(temporary, 'code.bin');
      await Promise.all([writeFile(planPath, manifest, { mode:0o600 }), writeFile(codePath, generated.code, { mode:0o600 })]);
      assertActive();
      return await command(current, 'install', [planPath, codePath, limit ?? 0]);
    } finally { await rm(temporary, { recursive:true, force:true }); }
  }
  return {
    getStatus,
    attach(pid, { descriptor } = {}) {
      return enqueue(async () => {
        assertActive();
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('需要有效的后端 PID');
        if (connection?.pid === pid && connection.initialized && connection.active && !lastError) return readStatus();
        await release(connection);
        assertActive();
        lastError = detachedReason = null;
        const current = { pid, descriptor:descriptor ?? null, initialized:false, active:false };
        connection = current;
        try {
          let prepared = await command(current, 'inspect', [...siteRvas(), ...(descriptor ? [descriptor] : [])]);
          current.descriptor = prepared.descriptor;
          assertActive();
          if (!prepared.descriptor) prepared = await command(current, 'prepare', siteRvas());
          current.descriptor = prepared.descriptor;
          assertActive();
          // Receipt saves only this location. Live description and branches are authoritative.
          await onInstallation?.({ pid, descriptor:current.descriptor });
          assertActive();
          // Adoption validates the immutable code through the same installer as
          // a first connection. A new generator must never replace live stubs.
          const native = await install(current, prepared);
          assertActive();
          current.initialized = native.initialized;
          current.active = native.active;
          if (!current.initialized || !current.active) throw new Error('后台预算安装未完成');
          publish();
          return snapshot(native);
        } catch (error) {
          if (!disposed) failed(current, error);
          try { await release(current); }
          catch (cleanup) { error.message += `；撤销失败：${cleanup.message}`; }
          throw error;
        }
      });
    },
    setLimit(tokens) {
      return enqueue(async () => {
        assertActive();
        const next = contextLimit(tokens), current = connection;
        let native;
        if (current?.initialized) {
          try {
            native = await command(current, 'configure', [current.descriptor, next ?? 0]);
            current.active = native.active;
          }
          catch (error) { failed(current, error); throw error; }
        }
        assertActive();
        limit = next;
        lastError = null;
        publish();
        return snapshot(native);
      });
    },
    status() { return enqueue(readStatus); },
    detach() {
      return enqueue(async () => { await release(connection); return snapshot(); });
    },
    dispose() {
      disposed = true;
      publish();
      return enqueue(async () => { await release(connection); return snapshot(); });
    },
  };
}
