import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { localizeCliReleaseNoteLine } from './cli-release-notes.mjs';
import { localizeCliNativeHelp } from './cli-native-help.mjs';

// Only native administration commands are routed here. Plugin JSON keeps the
// original executable and both streams, even during a CLI compatibility rebuild.
export function cliOutputCommand(args, valueFlags = new Set()) {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '--' || /^(?:-p|--print|--prompt|-i|--prompt-interactive)(?:=|$)/.test(args[index])) return null;
    index += valueFlags.has(args[index]) ? 2 : 1;
  }
  const [name, action] = args.slice(index, index + 2);
  const command = name === 'agent' ? 'agents' : name;
  if (command === 'plugin' || command === 'plugins') {
    if (['list', 'validate'].includes(action) && args.slice(index + 2).some(arg => arg === '--json' || arg === '-json')) {
      return {command:'plugin', action, machineOutput:true};
    }
    return {command:'plugin', action};
  }
  if (command === 'remote-control' && action === 'serve') return null;
  return ['mcp', 'remote-control', 'models', 'agents', 'changelog', 'update', 'install'].includes(command) ? {command, action} : null;
}

function messageLookup(dictionary, group) {
  const prefix = 'cli-command:' + group + ':';
  const exact = new Map(), templates = [];
  for (const [key, text] of Object.entries(dictionary.strings ?? dictionary)) {
    if (!key.startsWith(prefix) || typeof text !== 'string') continue;
    const source = key.slice(prefix.length);
    const pieces = source.split(/\{\d+\}/);
    if (pieces.length === 1) exact.set(source, text);
    else {
      const pattern = pieces.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*?)');
      templates.push({ specificity:pieces.join('').length, pattern:new RegExp('^' + pattern + '$', 'u'), text });
    }
  }
  // Try more specific formats before a nested value can absorb their suffix.
  templates.sort((a, b) => b.specificity - a.specificity);
  return source => {
    if (exact.has(source)) return exact.get(source);
    for (const { pattern, text } of templates) {
      const match = pattern.exec(source);
      if (match) return text.replace(/\{(\d+)\}/g, (slot, index) => match[index] ?? slot);
    }
    return source;
  };
}

function translateMcpTable(header, line) {
  // Go's tabwriter pads by rune count. Read status at the positions established
  // by the header, so a command or server name containing 'enabled' stays intact.
  const chars = Array.from(line);
  const status = chars.slice(header.status, header.command).join('').trimEnd();
  if (status !== 'enabled' && status !== 'disabled') return line;
  const state = status === 'enabled' ? '已启用' : '已停用';
  return chars.slice(0, header.status).join('') + state + ' '.repeat(Math.max(1, header.command - header.status - 6)) +
    chars.slice(header.command).join('');
}

const componentNames = {skill:'技能', agent:'智能体', rule:'规则', hook:'钩子', 'MCP server':'MCP 服务器', mcpServer:'MCP 服务器', sidecar:'Sidecar'};

export function commandLineTranslator(command, action, dictionary) {
  const lookup = messageLookup(dictionary, command), common = messageLookup(dictionary, 'common');
  const finding = command === 'plugin' && action === 'validate' ? messageLookup(dictionary, 'plugin-finding') : null;
  let table;
  return (line, stderr) => {
    if (!stderr && command === 'changelog') return localizeCliReleaseNoteLine(line);
    if (stderr && line.startsWith('Error: ')) {
      const reason = line.slice(7);
      return '错误：' + common(lookup(reason));
    }
    if (!stderr && command === 'mcp' && action === 'list') {
      if (/^NAME +TYPE +STATUS +COMMAND\/URL$/.test(line)) {
        table = { status:line.indexOf('STATUS'), command:line.indexOf('COMMAND/URL') };
        return line.replace('NAME', '名称').replace('TYPE', '类型').replace('STATUS', '状态  ').replace('COMMAND/URL', '命令/URL');
      }
      if (table) return translateMcpTable(table, line);
    }
    if (command === 'update' && !stderr) {
      const status = /^(\S+ )(.+)$/.exec(line);
      if (status && !/\w/.test(status[1])) return status[1] + lookup(status[2]);
    }
    if (finding && !stderr) {
      const issue = /^( +[✗⚠·] .+?: )(.+)$/.exec(line);
      if (issue) return issue[1] + finding(issue[2]);
    }
    if (!stderr && command === 'plugin' && action === 'list') {
      if (line.startsWith('    Components: ')) {
        const counts = line.slice(16).split(', ').map(item => {
          const match = /^(\d+) (skill|agent|rule|hook|MCP server|sidecar)s?$/.exec(item);
          return match ? componentNames[match[2]] + ' ' + match[1] : item;
        });
        return lookup('    Components: ' + counts.join('、'));
      }
      const row = /^(- .+) \((enabled|disabled)(, .*)?\)$/.exec(line);
      if (row) return row[1] + '（' + (row[2] === 'enabled' ? '已启用' : '已停用') + (row[3] ?? '') + '）';
    }
    if (!stderr && command === 'plugin' && ['install', 'import'].includes(action)) {
      const component = /^( +✔ )(skills|agents|rules|hooks|MCP servers|mcpServers|sidecars) +: (\d+) installed(.*)$/.exec(line);
      if (component) return component[1] + componentNames[component[2].slice(0,-1)] + '：已安装 ' + component[3] + component[4];
    }
    return common(lookup(line));
  };
}

async function forwardOutput(input, output, translate, stderr, dictionary) {
  input.setEncoding('utf8');
  await pipeline(input, async function* (source) {
    let pending = '', help = '';
    for await (const chunk of source) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (stderr && (help || /^Usage(?: of |: )/.test(line))) help += line + '\n';
        else yield translate(line, stderr) + '\n';
      }
    }
    if (help) yield localizeCliNativeHelp(help + pending, dictionary).replace(/^Error: (.*)$/gm, line => translate(line, true));
    else if (pending) yield translate(pending, stderr);
  }, output, {end:false});
}

export async function runCliOutputCommand(binaryPath, args, {command, action, machineOutput}, dictionary) {
  // stdout from these commands contains agent and model identifiers.
  const diagnosticsOnly = ['agents', 'models'].includes(command);
  const env = ['install','update','remote-control'].includes(command) ? process.env : {...process.env, AGY_CLI_DISABLE_AUTO_UPDATE:'true'};
  const stdio = machineOutput ? 'inherit' : ['inherit', diagnosticsOnly ? 'inherit' : 'pipe', 'pipe'];
  const child = spawn(binaryPath, args, {env, stdio});
  const term = () => child.kill('SIGTERM'), hup = () => child.kill('SIGHUP');
  process.on('SIGTERM', term);
  process.on('SIGHUP', hup);
  try {
    const exit = new Promise((resolve,reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
    if (machineOutput) return await exit;
    const translate = commandLineTranslator(command, action, dictionary);
    const [code] = await Promise.all([exit,
      child.stdout && forwardOutput(child.stdout, process.stdout, translate, false, dictionary),
      forwardOutput(child.stderr, process.stderr, translate, true, dictionary)]);
    return code;
  } catch (error) {
    if (error.code !== 'EPIPE') throw error;
    child.kill('SIGPIPE');
    return 141;
  } finally {
    process.off('SIGTERM', term);
    process.off('SIGHUP', hup);
  }
}
