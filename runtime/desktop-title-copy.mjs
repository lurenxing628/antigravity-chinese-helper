import { execFile } from 'node:child_process';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { appendNativeResources } from './backend-metadata.mjs';
import { prepareSignedNativeCopy } from './native-copy.mjs';
import { CHINESE_TITLE_PROMPT, applyNativeTitlePatch, collectNativeTitlePatch } from './native-title.mjs';

const exec = promisify(execFile);

function buildDesktopTitleCopy(original) {
  const title = collectNativeTitlePatch(original);
  const {binary, address} = appendNativeResources(original, Buffer.from(title.value));
  applyNativeTitlePatch(binary, title, address);
  return {binary};
}

async function fileIdentity(path) {
  const {dev, ino, size, mtimeNs, ctimeNs} = await stat(path, {bigint:true});
  return [dev, ino, size, mtimeNs, ctimeNs].join('-');
}

export async function prepareDesktopTitleCopy({officialBackendPath, stateDir}) {
  const sourcePath = await realpath(officialBackendPath);
  const source = await fileIdentity(sourcePath);
  const directory = join(resolve(stateDir), 'desktop-title');
  const binaryPath = join(directory, 'language_server');
  const receiptPath = join(directory, 'copy.json');
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt?.format === 1 && receipt.source === source && receipt.prompt === CHINESE_TITLE_PROMPT &&
        receipt.artifact === await fileIdentity(binaryPath)) {
      return {binaryPath:await realpath(binaryPath)};
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const prepared = await prepareSignedNativeCopy({sourcePath, destinationPath:binaryPath, async transform(original) {
    if (source !== await fileIdentity(sourcePath)) throw new Error('Antigravity 后端已更新，请重新启动');
    return buildDesktopTitleCopy(original);
  }});
  // A valid signature alone does not establish that macOS will start the
  // executable. Discover launch failures before Desktop selects this copy.
  await exec(prepared.binaryPath, ['--stamp'], {timeout:10000});
  // Only signed files are published. A missing or interrupted receipt simply
  // rebuilds the copy, even after a helper reinstall or a prompt downgrade.
  const receipt = {format:1, source, prompt:CHINESE_TITLE_PROMPT, artifact:await fileIdentity(prepared.binaryPath)};
  await writeFile(receiptPath, JSON.stringify(receipt), {mode:0o600});
  return prepared;
}
