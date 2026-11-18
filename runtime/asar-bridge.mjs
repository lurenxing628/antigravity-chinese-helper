import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CDP_BRIDGE_MARKER = '/*__AGH_CDP_BRIDGE_V1__*/';
const CDP_BRIDGE_SNIPPET = `${CDP_BRIDGE_MARKER}try{const{app:_a}=require("electron");if(_a&&_a.commandLine&&!_a.commandLine.hasSwitch("remote-debugging-port"))_a.commandLine.appendSwitch("remote-debugging-port","0");}catch{}`;
const INTEGRITY_BLOCK_SIZE = 4194304;

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function computeIntegrity(buffer) {
  const blocks = [];
  if (buffer.length === 0) {
    blocks.push(sha256Hex(buffer));
  } else {
    for (let offset = 0; offset < buffer.length; offset += INTEGRITY_BLOCK_SIZE) {
      blocks.push(sha256Hex(buffer.subarray(offset, Math.min(buffer.length, offset + INTEGRITY_BLOCK_SIZE))));
    }
  }
  return {
    algorithm: 'SHA256',
    hash: sha256Hex(buffer),
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

function resolveAsarNode(header, relativePath) {
  let normalized = String(relativePath || '').split(String.fromCharCode(92)).join('/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.startsWith('/')) normalized = normalized.slice(1);
  const parts = normalized.split('/').filter(Boolean);
  let current = header;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !current.files || !(part in current.files)) {
      return null;
    }
    current = current.files[part];
  }
  return current && !current.files ? { path: parts.join('/'), entry: current } : null;
}

function collectPackedEntries(node, prefix, out) {
  if (!node || typeof node !== 'object' || !node.files) return;
  for (const [name, child] of Object.entries(node.files)) {
    const childPath = prefix ? `${prefix}/${name}` : name;
    if (child.files) {
      collectPackedEntries(child, childPath, out);
    } else if (!child.unpacked && child.link === undefined && child.offset !== undefined) {
      out.push({ path: childPath, entry: child, origOffset: Number(child.offset), origSize: Number(child.size) });
    }
  }
}

export function injectBridgeCode(sourceText) {
  if (sourceText.includes(CDP_BRIDGE_MARKER)) {
    return { text: sourceText, alreadyPatched: true };
  }
  const lf = String.fromCharCode(10);
  const cr = String.fromCharCode(13);
  const lines = sourceText.split(lf);
  if (lines.length > 0 && /^\s*(?:"use strict"|'use strict');?\s*$/.test(lines[0].replace(cr, ''))) {
    const eol = lines[0].endsWith(cr) ? cr + lf : lf;
    const first = lines[0].endsWith(cr) ? lines[0].slice(0, -1) : lines[0];
    const rest = lines.slice(1).join(lf);
    return {
      text: first + eol + CDP_BRIDGE_SNIPPET + eol + rest,
      alreadyPatched: false,
    };
  }
  return {
    text: CDP_BRIDGE_SNIPPET + lf + sourceText,
    alreadyPatched: false,
  };
}

export function readAsarHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    throw new Error('Invalid ASAR buffer: too short');
  }
  const sizePickleLen = buffer.readUInt32LE(0);
  const headerPayloadSize = buffer.readUInt32LE(4);
  const headerPickleLen = buffer.readUInt32LE(8);
  const jsonByteLength = buffer.readUInt32LE(12);
  if (sizePickleLen !== 4 || headerPayloadSize < 8 + jsonByteLength || headerPickleLen !== headerPayloadSize - 4) {
    throw new Error('Invalid ASAR pickle header');
  }
  const dataOffset = 8 + headerPayloadSize;
  if (16 + jsonByteLength > buffer.length || dataOffset > buffer.length) {
    throw new Error('Invalid ASAR header bounds');
  }
  const header = JSON.parse(buffer.subarray(16, 16 + jsonByteLength).toString('utf8'));
  return { header, dataOffset };
}

export function patchAsarBuffer(buffer) {
  const { header, dataOffset } = readAsarHeader(buffer);
  let version = null;
  const pkgTarget = resolveAsarNode(header, 'package.json');
  let mainRelPath = 'dist/main.js';
  if (pkgTarget && !pkgTarget.entry.unpacked && pkgTarget.entry.offset !== undefined) {
    const pkgStart = dataOffset + Number(pkgTarget.entry.offset);
    const pkgEnd = pkgStart + Number(pkgTarget.entry.size);
    const pkgJson = JSON.parse(buffer.subarray(pkgStart, pkgEnd).toString('utf8'));
    if (typeof pkgJson?.version === 'string' && pkgJson.version.trim()) {
      version = pkgJson.version.trim();
    }
    if (typeof pkgJson?.main === 'string' && pkgJson.main.trim()) {
      mainRelPath = pkgJson.main.trim();
    }
  }

  const mainTarget = resolveAsarNode(header, mainRelPath);
  if (!mainTarget || mainTarget.entry.unpacked || mainTarget.entry.offset === undefined) {
    throw new Error(`ASAR main entry not packed or missing: ${mainRelPath}`);
  }

  const origMainStart = dataOffset + Number(mainTarget.entry.offset);
  const origMainEnd = origMainStart + Number(mainTarget.entry.size);
  const origMainText = buffer.subarray(origMainStart, origMainEnd).toString('utf8');
  const injected = injectBridgeCode(origMainText);
  if (injected.alreadyPatched) {
    return { patched: false, alreadyPatched: true, version, mainPath: mainTarget.path, buffer };
  }

  const nextMainBuf = Buffer.from(injected.text, 'utf8');
  const packed = [];
  collectPackedEntries(header, '', packed);
  packed.sort((a, b) => a.origOffset - b.origOffset);

  const chunks = [];
  let cursor = 0;
  for (const item of packed) {
    if (item.entry === mainTarget.entry) {
      item.entry.offset = String(cursor);
      item.entry.size = nextMainBuf.length;
      if (item.entry.integrity) {
        item.entry.integrity = computeIntegrity(nextMainBuf);
      }
      chunks.push(nextMainBuf);
      cursor += nextMainBuf.length;
    } else {
      const slice = buffer.subarray(dataOffset + item.origOffset, dataOffset + item.origOffset + item.origSize);
      item.entry.offset = String(cursor);
      chunks.push(slice);
      cursor += slice.length;
    }
  }

  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const alignedJsonSize = Math.ceil(jsonBuf.length / 4) * 4;
  const headerPicklePayloadSize = 4 + alignedJsonSize;
  const headerPayloadSize = 4 + headerPicklePayloadSize;
  const headerBuf = Buffer.alloc(16 + alignedJsonSize);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(headerPayloadSize, 4);
  headerBuf.writeUInt32LE(headerPicklePayloadSize, 8);
  headerBuf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerBuf, 16);

  const nextBuffer = Buffer.concat([headerBuf, ...chunks]);
  return { patched: true, alreadyPatched: false, version, mainPath: mainTarget.path, buffer: nextBuffer };
}

async function resolveExistingPath(candidate) {
  if (!candidate) return null;
  try {
    await access(candidate, constants.F_OK);
    return await realpath(candidate);
  } catch {
    return null;
  }
}

export async function resolveAsarPath({ executablePath, appPath, env = process.env, home = homedir() } = {}) {
  const explicitExe = executablePath || (appPath && appPath !== '/Applications/Antigravity.app' ? appPath : null) || env?.ANTIGRAVITY_APP_PATH;
  if (explicitExe) {
    const resolved = /\.exe$/i.test(explicitExe)
      ? await resolveExistingPath(explicitExe)
      : (await resolveExistingPath(join(explicitExe, 'Antigravity.exe')) ?? await resolveExistingPath(explicitExe));
    if (resolved) {
      const asar = join(dirname(resolved), 'resources', 'app.asar');
      if (await resolveExistingPath(asar)) return asar;
    }
  }
  const local = env?.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const candidates = [
    join(local, 'Programs', 'antigravity', 'resources', 'app.asar'),
    join(local, 'Programs', 'Antigravity', 'resources', 'app.asar'),
    join(local, 'Antigravity', 'resources', 'app.asar'),
    env?.ProgramFiles ? join(env.ProgramFiles, 'Antigravity', 'resources', 'app.asar') : null,
    env?.['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'Antigravity', 'resources', 'app.asar') : null,
  ];
  for (const candidate of candidates) {
    const resolved = await resolveExistingPath(candidate);
    if (resolved) return resolved;
  }
  return null;
}

async function pruneOldBackups(stateDir, keepName) {
  if (!stateDir) return;
  try {
    const entries = await readdir(stateDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile() && /^app\.asar\..+\.bak$/i.test(ent.name) && ent.name !== keepName) {
        await unlink(join(stateDir, ent.name)).catch(() => {});
      }
    }
  } catch { /* Non-fatal cleanup. */ }
}

async function replaceFileAtomically(targetPath, buffer) {
  const tempPath = `${targetPath}.agh-tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, buffer);
  try {
    await rename(tempPath, targetPath);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EEXIST')) {
      try {
        await copyFile(tempPath, targetPath);
        await unlink(tempPath).catch(() => {});
        return;
      } catch (copyErr) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw copyErr;
      }
    }
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function ensureAntigravityCdpBridge({
  executablePath,
  appPath,
  stateDir,
  env = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') {
    return { patched: false, alreadyPatched: false, skipped: true };
  }
  const asarPath = await resolveAsarPath({ executablePath, appPath, env, home });
  if (!asarPath) {
    return { patched: false, alreadyPatched: false, missing: true };
  }
  const fileInfo = await stat(asarPath);
  const rawBuffer = await readFile(asarPath);
  const result = patchAsarBuffer(rawBuffer);
  if (result.alreadyPatched) {
    return {
      patched: false,
      alreadyPatched: true,
      asarPath,
      version: result.version,
      mtimeMs: fileInfo.mtimeMs,
      size: fileInfo.size,
    };
  }

  if (stateDir) {
    const resolvedStateDir = resolve(stateDir);
    await mkdir(resolvedStateDir, { recursive: true });
    const backupTag = (result.version || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
    const backupName = `app.asar.${backupTag}.bak`;
    const backupPath = join(resolvedStateDir, backupName);
    if (!(await resolveExistingPath(backupPath))) {
      await writeFile(backupPath, rawBuffer);
      await pruneOldBackups(resolvedStateDir, backupName);
    }
  }

  await replaceFileAtomically(asarPath, result.buffer);
  const nextInfo = await stat(asarPath);
  return {
    patched: true,
    alreadyPatched: false,
    asarPath,
    version: result.version,
    mtimeMs: nextInfo.mtimeMs,
    size: nextInfo.size,
  };
}

const isEntryCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryCli && process.argv.includes('--patch')) {
  const defaultStateDir = process.env.ANTIGRAVITY_HELPER_STATE_DIR
    || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'AntigravityChineseHelper');
  ensureAntigravityCdpBridge({ stateDir: defaultStateDir })
    .then((res) => {
      process.stdout.write(JSON.stringify(res) + String.fromCharCode(10));
    })
    .catch((err) => {
      process.stderr.write((err?.message || String(err)) + String.fromCharCode(10));
      process.exitCode = 1;
    });
}
