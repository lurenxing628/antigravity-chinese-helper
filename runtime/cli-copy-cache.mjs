import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);

async function identity(path) {
  const file = await stat(path, {bigint:true});
  return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String);
}

async function cliVersion(path) {
  const {stdout} = await exec(path, ['--version'], {timeout:10000, maxBuffer:65536,
    env:{...process.env, AGY_CLI_DISABLE_AUTO_UPDATE:'true'}});
  const version = stdout.trim();
  if (!versionPattern.test(version)) throw new Error('Antigravity CLI 未返回有效版本号');
  return version;
}

function versionFolder(root, version, inputs) {
  const folder = join(root, version);
  return inputs.contextOverridesEnabled ? join(folder, `context-${inputs.mainTokens ?? 'default'}`) : folder;
}

async function activeCopy(folder, version) {
  try {
    // Resolve the pointer once: receipt and executable must come from the same publication.
    const directory = await realpath(join(folder, 'current'));
    const binaryPath = join(directory, 'agy');
    const receipt = JSON.parse(await readFile(join(directory, 'copy.json'), 'utf8'));
    if (receipt?.version === version && receipt.localization?.translated > 0 &&
        same(receipt.artifact, await identity(binaryPath))) return {receipt, binaryPath};
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

function launchInfo({receipt, binaryPath}) {
  return {binaryPath, version:receipt.version, layout:receipt.layout, localization:receipt.localization};
}

async function previousCopy(root, sourcePath, inputs, requireScreen) {
  let latest = null;
  for (const entry of await readdir(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || !versionPattern.test(entry.name)) continue;
    const candidate = await activeCopy(versionFolder(root, entry.name, inputs), entry.name);
    if (candidate && (!requireScreen || candidate.receipt.screenVerified) && (candidate.receipt.automatic || candidate.receipt.source?.path === sourcePath) &&
        (!latest || candidate.receipt.builtAt > latest.receipt.builtAt)) latest = candidate;
  }
  return latest;
}

async function publish(folder, directory) {
  const pending = join(directory, '.current');
  const previous = await readlink(join(folder, 'current')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (previous) {
    // Another terminal may already have selected the previous immutable executable.
    // Give it a fresh retention window before changing the pointer.
    const now = new Date();
    await utimes(join(folder, previous), now, now).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await symlink(basename(directory), pending);
  await rename(pending, join(folder, 'current'));
}

async function updatePublicPaths(folder, directory) {
  // Retain the documented per-version paths, including on migration from an old regular file.
  for (const file of ['agy', 'copy.json']) {
    const path = join(folder, file), target = `current/${file}`;
    const existing = await readlink(path).catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error;
    });
    if (existing === target) continue;
    const pending = join(directory, `.link-${file}`);
    await symlink(target, pending);
    await rename(pending, path);
  }
}

async function clearRetired(folder) {
  const current = await readlink(join(folder, 'current'));
  const cutoff = Date.now() - 86400000;
  for (const entry of await readdir(folder, {withFileTypes:true})) {
    if (!entry.isDirectory() || !/^\.copy-[a-z0-9]{6}$/i.test(entry.name) || entry.name === current) continue;
    const path = join(folder, entry.name);
    const info = await stat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info?.mtimeMs < cutoff) await rm(path, {recursive:true, force:true});
  }
}

class SourceChanged extends Error {}
class InvalidCandidate extends Error {}

async function prepare({officialCliPath, stateDir, inputs, build, allowFallback, isIncompatible, verifyCandidate}) {
  const sourcePath = await realpath(officialCliPath), stamp = await identity(sourcePath);
  const source = {path:sourcePath, stamp};
  const assertSource = async () => {
    if (!same(stamp, await identity(officialCliPath))) throw new SourceChanged('官方 CLI 正在更新，请重新启动 agy-zh');
  };
  const version = await cliVersion(sourcePath);
  await assertSource();
  const root = join(resolve(stateDir), 'builds'), folder = versionFolder(root, version, inputs);
  await mkdir(folder, {recursive:true, mode:0o700});
  const cached = await activeCopy(folder, version);
  if (cached && same(cached.receipt.source, source) && same(cached.receipt.inputs, inputs) &&
      (!allowFallback || cached.receipt.automatic) && (!verifyCandidate || cached.receipt.screenVerified)) return launchInfo(cached);

  const directory = await mkdtemp(join(folder, '.copy-')), destinationPath = join(directory, 'agy');
  let committed = false;
  try {
    const {layout = null, localization} = await build({sourcePath, destinationPath, version});
    if (!(localization?.translated > 0)) throw new InvalidCandidate('当前 CLI 未生成可用的汉化文案');
    let builtVersion;
    try { builtVersion = await cliVersion(destinationPath); }
    catch (error) { throw new InvalidCandidate('新版汉化副本无法启动', {cause:error}); }
    if (builtVersion !== version) throw new InvalidCandidate('汉化副本与官方 CLI 版本不一致');
    if (verifyCandidate) {
      try { await verifyCandidate(destinationPath); }
      catch (error) { throw new InvalidCandidate(error.message, {cause:error}); }
    }
    await assertSource();
    const receipt = {version, source, inputs, automatic:allowFallback, screenVerified:Boolean(verifyCandidate), artifact:await identity(destinationPath), builtAt:Date.now(), layout, localization};
    await writeFile(join(directory, 'copy.json'), `${JSON.stringify(receipt, null, 2)}\n`, {mode:0o600});
    await publish(folder, directory);
    committed = true;
    await updatePublicPaths(folder, directory);
    await clearRetired(folder);
    return launchInfo({receipt, binaryPath:await realpath(destinationPath)});
  } catch (error) {
    await assertSource();
    if (!allowFallback || !(error instanceof InvalidCandidate || isIncompatible(error))) throw error;
    const previous = await previousCopy(root, sourcePath, inputs, Boolean(verifyCandidate));
    if (!previous) throw error;
    return {...launchInfo(previous), fallback:{version, reason:error.message}};
  } finally {
    if (!committed) await rm(directory, {recursive:true, force:true});
  }
}

export async function prepareCachedCliCopy(options) {
  const args = {allowFallback:false, isIncompatible:() => false, ...options};
  try { return await prepare(args); }
  catch (error) { if (!(error instanceof SourceChanged)) throw error; }
  return prepare(args);
}
