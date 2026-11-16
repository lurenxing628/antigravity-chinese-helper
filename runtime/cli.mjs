#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { appendNativeResources, inspectNativeBinary, prepareBackendMetadata, reserveBackendBudget } from './backend-metadata.mjs';
import { deriveBackendLayout } from './backend-layout.mjs';
import { createBackendRuntime, inspectBackendBinary } from './backend-runtime.mjs';
import { collectCliLocalizationPatches, applyCliLocalizationPatches, collectCliDisplayLabels, applyCliDisplayLabels } from './cli-localization.mjs';
import { prepareSignedNativeCopy } from './native-copy.mjs';
import { collectCliMainContextPatch, applyCliMainContextPatch } from './cli-context.mjs';
import { collectCliTitleLocalizationPatch, applyCliTitleLocalizationPatch } from './cli-title-localization.mjs';
import { collectCliDisplayStrings, applyCliDisplayStrings,
  collectCliSettingsDisplayStrings, applyCliContentDisplayStrings } from './cli-display.mjs';
import { withCliHud } from './cli-hud.mjs';
import { collectCliNoticeDisplayStrings, applyCliNoticeDisplayStrings } from './cli-notice-localization.mjs';
import { collectCliStatusLocalizationPatches, applyCliStatusLocalizationPatches,
  collectCliSummaryNounDisplayStrings, collectCliUsageDisplayStrings } from './cli-status-localization.mjs';

import { CONTEXT_OVERRIDES_ENABLED } from './context-policy.mjs';

const exec = promisify(execFile);
const runtimeDir = dirname(fileURLToPath(import.meta.url));
export const defaultCliStateDir = join(homedir(), 'Library', 'Application Support', 'AntigravityChineseHelper', 'cli');
const dictionaryPath = join(runtimeDir, 'translations.json');
const valueFlags = new Set(['--add-dir', '--agent', '--conversation', '--effort', '--input-format', '--json-schema',
  '--log-file', '--mode', '--model', '--output-format', '--print', '--prompt', '-p', '--print-timeout', '--project',
  '--prompt-interactive', '-i', '--settings']);

export function parseContextK(value) {
  if (value === 'default') return null;
  const match = /^(\d+)([kKmM]?)$/.exec(value ?? '');
  const tokens = match && Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1000000 : 1000);
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 2147483647) {
    throw new Error('上下文请填正整数 K（例如 500 或 500K），也可填 1M；default 表示恢复默认');
  }
  return tokens;
}

export function parseCliArguments(argv, { contextOverridesEnabled = CONTEXT_OVERRIDES_ENABLED } = {}) {
  const args = [], overrides = {};
  let help = false, collect = false, version = false, command = null;
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--') {
      // Everything after -- belongs to agy, including option-looking prompts.
      args.push(...argv.slice(index + 1));
      version ||= nativeVersionFlag(argv.slice(index + 1));
      command ??= nativeCommand(argv.slice(index + 1));
      break;
    }
    if (!contextOverridesEnabled && ['--main-context', '--subagent-context'].includes(item.split('=')[0])) throw new Error('上下文调节功能已停用，CLI 使用原生默认上下文');
    const key = item === '--main-context' ? 'mainTokens' : item === '--subagent-context' ? 'subagentTokens' : null;
    if (key) { overrides[key] = parseContextK(argv[++index]); continue; }
    if (item === '--help' || item === '-h') { help = true; continue; }
    if (item === '--collect-cli') { collect = true; continue; }
    if (item === '--version') version = true;
    if (command === null && !item.startsWith('-')) command = item;
    args.push(item);
    if (valueFlags.has(item) && index + 1 < argv.length) args.push(argv[++index]);
  }
  if (!contextOverridesEnabled && (command === 'context' || nativeTokens(args).some(item => ['--main-context', '--subagent-context'].includes(item.split('=')[0])))) {
    throw new Error('上下文调节功能已停用，CLI 使用原生默认上下文');
  }
  return { args, overrides, help, collect, version, command };
}

function nativeTokens(args) {
  const tokens = [];
  for (let index = 0; index < args.length; index++) {
    tokens.push(args[index]);
    if (valueFlags.has(args[index])) index++;
  }
  return tokens;
}
const nativeVersionFlag = args => nativeTokens(args).includes('--version');
const nativeCommand = args => nativeTokens(args).find(item => !item.startsWith('-')) ?? null;

async function readObject(path, missing = {}) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return missing;
    throw new Error(`无法读取配置：${path}`);
  }
}

async function writeObject(path, value) {
  const folder = dirname(path);
  await mkdir(folder, { recursive:true, mode:0o700 });
  const temporary = await mkdtemp(join(folder, '.write-'));
  try {
    const file = join(temporary, 'value.json');
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode:0o600 });
    await rename(file, path);
  } finally { await rm(temporary, { recursive:true, force:true }); }
}

export async function readCliContext(stateDir, { contextOverridesEnabled = CONTEXT_OVERRIDES_ENABLED } = {}) {
  if (!contextOverridesEnabled) return { mainTokens:null, subagentTokens:null };
  const value = await readObject(join(stateDir, 'context.json'));
  const result = { mainTokens:value.mainTokens ?? null, subagentTokens:value.subagentTokens ?? null };
  for (const tokens of Object.values(result)) {
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 2147483647)) {
      throw new Error('CLI 上下文配置中的 token 数无效');
    }
  }
  return result;
}

export async function findCliExecutable(candidate = process.env.ANTIGRAVITY_HELPER_CLI) {
  const candidates = candidate ? [candidate] : [...(process.env.PATH ?? '').split(':').filter(Boolean).map(path => join(path, 'agy')),
    join(homedir(), '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  for (const path of new Set(candidates)) {
    try { await access(path, constants.X_OK); return await realpath(path); }
    catch (error) { if (candidate) throw new Error(`无法运行 Antigravity CLI：${candidate}`); }
  }
  throw new Error('未找到 agy；请先安装官方 Antigravity CLI，或用 ANTIGRAVITY_HELPER_CLI 指定路径');
}

export async function prepareCliCopy({ officialCliPath, stateDir, translationsPath = dictionaryPath, mainTokens = null, contextOverridesEnabled = CONTEXT_OVERRIDES_ENABLED }) {
  if (!contextOverridesEnabled) mainTokens = null;
  const [sourcePath, sourceStat, dictionaryStat] = await Promise.all([
    realpath(officialCliPath), stat(officialCliPath), stat(translationsPath),
  ]);
  const { stdout } = await exec(sourcePath, ['--version'], { timeout:10000, maxBuffer:65536 });
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('Antigravity CLI 未返回有效版本号');
  const source = { path:sourcePath, size:sourceStat.size, modified:sourceStat.mtimeMs };
  const dictionary = { size:dictionaryStat.size, modified:dictionaryStat.mtimeMs };
  const adapter = Math.max(...await Promise.all(['cli.mjs', 'context-policy.mjs', 'cli-context.mjs', 'cli-localization.mjs', 'cli-display.mjs',
    'cli-notice-localization.mjs', 'cli-status-localization.mjs', 'cli-title-localization.mjs', 'backend-metadata.mjs']
    .map(async file => (await stat(join(runtimeDir, file))).mtimeMs)));
  const folder = join(resolve(stateDir), 'builds', version), binaryPath = join(folder, 'agy');
  const receiptPath = join(folder, 'copy.json');
  const receipt = await readObject(receiptPath, null);
  if (receipt && JSON.stringify(receipt.source) === JSON.stringify(source) &&
      JSON.stringify(receipt.dictionary) === JSON.stringify(dictionary) && receipt.adapter === adapter && receipt.mainTokens === mainTokens && receipt.contextOverridesEnabled === contextOverridesEnabled) {
    try {
      return { binaryPath:await realpath(binaryPath), version, localization:receipt.localization,
        layout:contextOverridesEnabled ? await inspectBackendBinary(binaryPath) : null };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const translations = await readObject(translationsPath);
  const prepared = await prepareSignedNativeCopy({ sourcePath, destinationPath:binaryPath,
    transform(original) {
      const metadata = inspectNativeBinary(original);
      const plan = collectCliLocalizationPatches(original, translations, metadata);
      const labels = collectCliDisplayLabels(original, translations, metadata);
      const status = collectCliStatusLocalizationPatches(original, translations, metadata);
      const title = collectCliTitleLocalizationPatch(original, metadata);
      const lookups = [
        {plan:collectCliDisplayStrings(original, translations, metadata), apply:applyCliDisplayStrings},
        {plan:collectCliSettingsDisplayStrings(original, translations, metadata), apply:applyCliContentDisplayStrings},
        {plan:collectCliUsageDisplayStrings(original, translations, metadata), apply:applyCliContentDisplayStrings},
        {plan:collectCliSummaryNounDisplayStrings(original, translations, metadata), apply:applyCliDisplayStrings},
        {plan:collectCliNoticeDisplayStrings(original, translations, metadata), apply:applyCliNoticeDisplayStrings},
      ];
      const main = collectCliMainContextPatch(original, metadata, mainTokens, { contextOverridesEnabled });
      if (!plan.patches.length) throw new Error('当前 CLI 的文案入口与词库不匹配，尚不能准备汉化副本');
      const strings = new Map(), chunks = [];
      let size = 0;
      for (const translated of [...plan.patches.map(patch => patch.translated), ...status.patches.map(patch => patch.translated),
        ...labels.labels.map(label => label.translated), ...lookups.flatMap(({plan}) => plan.entries.flatMap(entry =>
          plan.matchContent ? [entry.original, entry.translated] : [entry.translated])),
        title.value, ...(main ? [main.value] : [])]) {
        if (strings.has(translated)) continue;
        strings.set(translated, size);
        const bytes = Buffer.from(`${translated}\0`, 'utf8');
        chunks.push(bytes); size += bytes.length;
      }
      let resourceSize = Math.ceil(size / 16) * 16;
      for (const lookup of lookups) {
        lookup.tableOffset = resourceSize;
        resourceSize += lookup.plan.entries.length * 16;
      }
      const resources = appendNativeResources(original, Buffer.concat([...chunks,
        Buffer.alloc(resourceSize - size)]));
      const allocateString = bytes => resources.address + strings.get(bytes.toString('utf8'));
      applyCliLocalizationPatches(resources.binary, plan, allocateString);
      applyCliTitleLocalizationPatch(resources.binary, title, resources.address + strings.get(title.value));
      if (main) applyCliMainContextPatch(resources.binary, main, resources.address + strings.get(main.value));
      const uiCapacity = 6720, slot = reserveBackendBudget(resources.binary, { trailingBytes:uiCapacity });
      const statusUi = applyCliStatusLocalizationPatches(resources.binary, status, allocateString, {
        codeAddress:metadata.imageBase + slot.rva + slot.size,
        codeFileOffset:slot.rva + slot.size, capacity:uiCapacity,
      });
      let displayOffset = Math.ceil(statusUi.codeBytes / 16) * 16;
      const ui = applyCliDisplayLabels(resources.binary, labels, {
        codeAddress:metadata.imageBase + slot.rva + slot.size + displayOffset,
        codeFileOffset:slot.rva + slot.size + displayOffset, capacity:uiCapacity - displayOffset, allocateString,
      });
      displayOffset = Math.ceil((displayOffset + ui.codeBytes) / 16) * 16;
      for (const lookup of lookups) {
        const rendered = lookup.apply(resources.binary, lookup.plan, {
          codeAddress:metadata.imageBase + slot.rva + slot.size + displayOffset,
          codeFileOffset:slot.rva + slot.size + displayOffset, capacity:uiCapacity - displayOffset,
          tableAddress:resources.address + lookup.tableOffset, allocateString,
        });
        rendered.table.copy(resources.binary, resources.fileOffset + lookup.tableOffset);
        displayOffset = Math.ceil((displayOffset + rendered.codeSize) / 16) * 16;
      }
      const layout = contextOverridesEnabled ? deriveBackendLayout(resources.binary, prepareBackendMetadata(resources.binary)) : null;
      const originals = [...plan.patches.map(patch => patch.original), ...status.patches.map(patch => patch.original),
        ...labels.labels.map(label => label.original), ...lookups.flatMap(({plan}) => plan.entries.map(entry => entry.original))];
      return { binary:resources.binary, layout,
        localization:{ translated:new Set(originals).size,
          references:plan.patches.length + status.patches.length + labels.sites.length + lookups.reduce((sum, {plan}) => sum + plan.entries.length, 0),
          missing:plan.missing.length + labels.missing.length + status.missing.length +
            lookups.reduce((sum,{plan}) => sum + (plan.missing?.length ?? 0),0) } };
    },
  });
  await writeObject(receiptPath, { source, dictionary, adapter, mainTokens, contextOverridesEnabled, localization:prepared.localization });
  return { ...prepared, version };
}

export async function ensureCliTools(stateDir) {
  const folder = join(resolve(stateDir), 'native');
  await mkdir(folder, { recursive:true, mode:0o700 });
  const paths = {};
  for (const [name, source] of [['machExecutablePath', 'backend-mach.c'], ['launchExecutablePath', 'cli-launch.c']]) {
    const sourcePath = join(runtimeDir, source), binaryPath = join(folder, source.replace(/\.c$/, ''));
    let current = false;
    try { current = (await stat(binaryPath)).mtimeMs >= (await stat(sourcePath)).mtimeMs; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!current) {
      const temporary = await mkdtemp(join(folder, '.compile-'));
      try {
        const file = join(temporary, 'tool');
        await exec('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', sourcePath, '-o', file],
          { timeout:30000, maxBuffer:1024 * 1024 });
        await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file],
          { timeout:30000, maxBuffer:1024 * 1024 });
        await rename(file, binaryPath);
      } finally { await rm(temporary, { recursive:true, force:true }); }
    }
    paths[name] = await realpath(binaryPath);
  }
  return paths;
}

/** The C gate holds the first instruction until the shared budget engine is ready. */
export async function launchCliSession({ binaryPath, args, layout, subagentTokens, machExecutablePath,
  launchExecutablePath, env = process.env, stdio = ['inherit', 'inherit', 'inherit'], onReady,
  contextOverridesEnabled = CONTEXT_OVERRIDES_ENABLED }) {
  if (!contextOverridesEnabled) {
    const child = spawn(binaryPath, args, { env, stdio });
    const interrupt = () => {}, term = () => child.kill('SIGTERM'), hup = () => child.kill('SIGHUP');
    process.on('SIGINT', interrupt); process.on('SIGTERM', term); process.on('SIGHUP', hup);
    try {
      const exit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
      });
      await onReady?.({ pid:child.pid, runtime:null, child });
      return await exit;
    } finally {
      process.off('SIGINT', interrupt); process.off('SIGTERM', term); process.off('SIGHUP', hup);
    }
  }
  const child = spawn(launchExecutablePath, [binaryPath, ...args], { env, stdio:[...stdio, 'pipe', 'pipe'] });
  child.stdio[4].on('error', () => {}); // Closing the gate cancels an exited/stopped child.
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  const runtime = subagentTokens === null ? null : createBackendRuntime({
    machExecutablePath, expectedBinaryPath:binaryPath, layout, targetTokens:subagentTokens,
  });
  const interrupt = () => {};
  const terminate = signal => child.kill(signal);
  const term = () => terminate('SIGTERM'), hup = () => terminate('SIGHUP');
  process.on('SIGINT', interrupt); process.on('SIGTERM', term); process.on('SIGHUP', hup);
  const lines = createInterface({ input:child.stdio[3] });
  let timeout;
  try {
    const pid = await Promise.race([
      new Promise((resolve, reject) => {
        lines.once('line', line => {
          try {
            const { pid } = JSON.parse(line);
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid PID');
            resolve(pid);
          } catch { reject(new Error('CLI 启动器未返回有效进程编号')); }
        });
        lines.once('close', () => reject(new Error('CLI 在上下文设置前结束')));
      }),
      exit.then(() => { throw new Error('CLI 启动器提前结束'); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('CLI 启动超时')), 15000); }),
    ]);
    clearTimeout(timeout); lines.close();
    if (runtime) await runtime.attach(pid);
    await onReady?.({ pid, runtime, child });
    child.stdio[4].end('R');
    return await exit;
  } finally {
    clearTimeout(timeout); lines.close(); child.stdio[4].end();
    try { await runtime?.dispose(); }
    finally {
      await exit.catch(() => {});
      process.off('SIGINT', interrupt); process.off('SIGTERM', term); process.off('SIGHUP', hup);
    }
  }
}

export function cliHelp(contextOverridesEnabled = CONTEXT_OVERRIDES_ENABLED) {
  if (!contextOverridesEnabled) return `Antigravity CLI 汉化助手\n命令：agy-zh / agyzh / agyz\n\n用法：\n  agy-zh                  启动中文 CLI\n  agy-zh --collect-cli     列出当前词库缺少的固定文案\n\n原生参数放在 -- 后传入，例如 agy-zh -- --continue。\n上下文使用官方原生默认值。\n直接运行 agy 仍使用官方原版。`;
  return `Antigravity CLI 汉化助手\n命令：agy-zh / agyzh / agyz\n\n用法：\n  agy-zh                                  启动中文 CLI\n  agy-zh context                          查看上下文设置\n  agy-zh context --main 500 --subagent 500  保存主、子代理各 500K\n  agy-zh context --main default --subagent default\n                                          恢复原生默认\n  agy-zh --main-context 500 --subagent-context 500 -- [agy 参数]\n                                          仅本次使用指定上下文\n  agy-zh --collect-cli                     列出当前词库缺少的固定文案\n\n上下文数字以 K 为单位，1K = 1000 tokens；也可写 1M。\n保存的上下文用于下次启动。\n原生参数放在 -- 后传入，例如 agy-zh -- --continue。\n直接运行 agy 仍使用官方原版。`;
}

async function contextCommand(argv, stateDir, contextOverridesEnabled) {
  const value = await readCliContext(stateDir, { contextOverridesEnabled });
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index] === '--main' ? 'mainTokens' : argv[index] === '--subagent' ? 'subagentTokens' : null;
    if (!key) throw new Error('context 支持 --main 和 --subagent，例如 context --main 500 --subagent 500');
    value[key] = parseContextK(argv[++index]);
  }
  if (argv.length) await writeObject(join(stateDir, 'context.json'), value);
  const label = tokens => tokens === null ? '原生默认' : `${tokens / 1000}K`;
  console.log(`主 Agent：${label(value.mainTokens)}\nSub Agent：${label(value.subagentTokens)}${argv.length ? '\n已保存，下次启动 CLI 生效。' : ''}`);
}

export async function main(argv = process.argv.slice(2), { stateDir = defaultCliStateDir,
  contextOverridesEnabled = CONTEXT_OVERRIDES_ENABLED } = {}) {
  if (argv[0] === 'context' && !contextOverridesEnabled) throw new Error('上下文调节功能已停用，CLI 使用原生默认上下文');
  if (argv[0] === 'context') { await contextCommand(argv.slice(1), stateDir, contextOverridesEnabled); return 0; }
  const parsed = parseCliArguments(argv, { contextOverridesEnabled });
  if (parsed.help) { console.log(cliHelp(contextOverridesEnabled)); return 0; }
  const officialCliPath = await findCliExecutable();
  if (parsed.collect) {
    const [binary, dictionary] = await Promise.all([readFile(officialCliPath), readObject(dictionaryPath)]);
    const metadata = inspectNativeBinary(binary);
    const plan = collectCliLocalizationPatches(binary, dictionary, metadata);
    const labels = collectCliDisplayLabels(binary, dictionary, metadata);
    const status = collectCliStatusLocalizationPatches(binary, dictionary, metadata);
    const settings = collectCliSettingsDisplayStrings(binary, dictionary, metadata);
    console.log(JSON.stringify({ translated:plan.patches.length + labels.labels.length + status.patches.length + settings.entries.length,
      missing:[...plan.missing, ...labels.missing, ...status.missing, ...settings.missing] }, null, 2));
    return 0;
  }
  // Commands that install/update the executable or own a background service
  // must retain the official program path and lifecycle.
  if (['install', 'update', 'remote-control', 'mic-serve'].includes(parsed.command) || parsed.version) {
    const child = spawn(officialCliPath, parsed.args, { stdio:'inherit' });
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('CLI 汉化目前支持 macOS arm64');
  const context = { ...await readCliContext(stateDir, { contextOverridesEnabled }), ...parsed.overrides };
  const prepared = await prepareCliCopy({ officialCliPath, stateDir, mainTokens:context.mainTokens, contextOverridesEnabled });
  const tools = contextOverridesEnabled ? await ensureCliTools(stateDir) : {};
  const printMode = nativeTokens(parsed.args).some(arg => /^(?:-p|--print|--prompt)(?:=|$)/.test(arg));
  const interactive = parsed.command === null && !printMode;
  const args = interactive ? await withCliHud(parsed.args,{valueFlags}) : parsed.args;
  const env = interactive ? {...process.env,ANTIGRAVITY_HELPER_CLI_HUD_RUN:`${process.pid}-${Date.now()}`} : process.env;
  return await launchCliSession({ ...prepared, ...tools, args, env, subagentTokens:context.subagentTokens, contextOverridesEnabled });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(`CLI 汉化助手：${error.message}`); process.exitCode = 1;
  });
}
