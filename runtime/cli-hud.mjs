#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCliHud } from './cli-hud-render.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const shellQuote = (value, platform = process.platform) => {
  const isWindowsStyle = (platform === 'win32' && !value.startsWith('/')) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
  return isWindowsStyle ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
};

/** The official statusLine interface owns drawing, resizing and refreshes. */
export function cliHudSettings({ nodePath = process.execPath, hudPath = scriptPath, platform = process.platform } = {}) {
  return { type:'command', command:`${shellQuote(nodePath, platform)} --experimental-sqlite --disable-warning=ExperimentalWarning ${shellQuote(hudPath, platform)}`,
    enabled:true, padding:0, stack_with_default:false };
}

/** Merge only the session settings supplied on this command line. */
export async function withCliHud(args, { valueFlags = new Set(), ...options } = {}) {
  const forwarded = [], settingsValues = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { forwarded.push(...args.slice(index)); break; }
    if (arg === '--settings' || arg.startsWith('--settings=')) {
      const value = arg === '--settings' ? args[++index] : arg.slice('--settings='.length);
      if (value === undefined) throw new Error('--settings 缺少 JSON 或文件路径');
      settingsValues.push(value);
    } else {
      forwarded.push(arg);
      if (valueFlags.has(arg) && index + 1 < args.length) forwarded.push(args[++index]);
    }
  }
  let settings = {};
  for (const value of settingsValues) {
    let parsed;
    try {
      const text = value.trim().startsWith('{') ? value : await readFile(/^~[\\/]/.test(value) ? join(homedir(),value.slice(2)) : resolve(value),'utf8');
      parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    } catch { throw new Error('无法读取 --settings：请提供 JSON 对象或有效的设置文件'); }
    settings = { ...settings, ...parsed };
  }
  // An explicit per-session statusLine remains the caller's choice.
  if (!Object.hasOwn(settings,'statusLine')) settings.statusLine = cliHudSettings(options);
  return ['--settings',JSON.stringify(settings),...forwarded];
}

function quotaBucket(bucket, now) {
  if (!bucket || bucket.disabled) return undefined;
  const remaining = number(bucket.remaining_fraction);
  const parsedTime = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
  const seconds = number(bucket.reset_in_seconds);
  return { remainingPercent:remaining === null ? null : Math.max(0,Math.min(100,remaining * 100)),
    resetsAt:Number.isFinite(parsedTime) ? parsedTime : seconds === null ? null : now + seconds * 1000 };
}

/** Adapt the native JSON; cumulative input is never used as context size. */
export function cliHudSnapshot(data = {}, metrics = {}, { now = Date.now() } = {}) {
  const context = data.context_window ?? {}, usage = context.current_usage;
  const rawWindow = number(context.context_window_size), window = rawWindow > 0 ? rawWindow : null;
  const usedPercentage = number(context.used_percentage);
  const usageParts = usage && ['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'].map(key => number(usage[key]));
  const used = window !== null && usedPercentage !== null ? Math.round(window * usedPercentage / 100)
    : number(metrics.context?.used) ?? (usageParts?.every(value => value !== null)
      ? usageParts[0] + usageParts[2] + usageParts[3] : null);
  const model = data.model ?? {}, workspace = data.workspace ?? {};
  const cwd = workspace.current_dir || data.cwd || process.cwd();
  const family = /gemini|orchestrator/i.test(`${model.id ?? ''} ${model.display_name ?? ''}`) ? 'gemini' : '3p';
  const fiveHour = quotaBucket(data.quota?.[`${family}-5h`],now);
  const weekly = quotaBucket(data.quota?.[`${family}-weekly`],now);
  const subagents = metrics.subagentMetrics;
  return {
    model:model.display_name || model.id || null, effort:model.effort ?? null,
    context:{used,window:number(metrics.context?.window) ?? window,compactAt:number(metrics.context?.compactAt)},
    input:number(metrics.input),output:number(metrics.output),
    cacheRead:number(metrics.cacheRead),tps:number(metrics.tps),ttftMs:number(metrics.ttftMs),
    subagentMetrics:subagents ? {inputTokens:number(subagents.input),outputTokens:number(subagents.output),
      tps:number(subagents.tps),ttftMs:number(subagents.ttftMs),cacheHitRate:number(subagents.cacheHitRate)} : null,
    edits:metrics.edits ?? null,activeMs:number(metrics.activeMs),isActive:metrics.isActive ?? false,
    project:basename(workspace.project_dir || cwd),branch:data.vcs?.branch || null,
    quota:fiveHour || weekly ? {fiveHour,weekly} : undefined,now,
  };
}

export function cliHudDatabasePath(data, home = homedir()) {
  const id = data?.conversation_id;
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? join(home,'.gemini','antigravity-cli','conversations',`${id}.db`) : null;
}

async function gitBranch(cwd) {
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    const dotGit = join(folder,'.git');
    try {
      const info = await stat(dotGit);
      let gitDir = dotGit;
      if (info.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit,'utf8'));
        if (!pointer) return null;
        gitDir = resolve(folder,pointer[1].trim());
      }
      const head = (await readFile(join(gitDir,'HEAD'),'utf8')).trim();
      return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? head.slice(0,7);
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    if (dirname(folder) === folder) return null;
  }
}

export function helperStateRoot({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env?.ANTIGRAVITY_HELPER_STATE_DIR) return resolve(env.ANTIGRAVITY_HELPER_STATE_DIR);
  return platform === 'win32'
    ? join(env?.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'AntigravityChineseHelper')
    : join(home, 'Library', 'Application Support', 'AntigravityChineseHelper');
}

export async function runCliHud(input) {
  const data = JSON.parse(input);
  const cacheDir = join(helperStateRoot(),'cli','hud-cache');
  let metrics = {};
  const databasePath = cliHudDatabasePath(data);
  if (databasePath) {
    try {
      const { collectCliHudMetrics } = await import('./cli-hud-metrics.mjs');
      metrics = await collectCliHudMetrics({databasePath,cacheDir,
        isActive:/^(working|tool_use|reviewing)$/.test(data.agent_state),
        runId:process.env.ANTIGRAVITY_HELPER_CLI_HUD_RUN});
    } catch { /* A new conversation may not have a database yet. Native data still renders. */ }
  }
  const snapshot = cliHudSnapshot(data,metrics);
  snapshot.branch ??= await gitBranch(data.workspace?.current_dir || data.cwd || process.cwd());
  return renderCliHud(snapshot,{columns:number(data.terminal_width) ?? process.stdout.columns ?? 80});
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try { process.stdout.write(`${await runCliHud(input)}\n`); }
  catch (error) { console.error(`状态栏：${error.message}`); process.exitCode = 1; }
}
