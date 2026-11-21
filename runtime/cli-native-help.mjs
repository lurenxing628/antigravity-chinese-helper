const subcommandHelp = new Map([
  ['mcp', new Set(['add', 'remove', 'list', 'enable', 'disable'])],
  ['plugin', new Set(['validate'])],
  ['plugins', new Set(['validate'])],
  ['remote-control', new Set(['start', 'status', 'stop'])],
]);
const commandValueFlags = new Set(['--app-data-dir', '--app_data_dir', '--cli_dir_name', '--cli_log_file',
  '--cloud_code_endpoint', '--gemini-dir', '--gemini_dir', '--ide-mcp-port', '--ide_mcp_port',
  '--override_user_agent_name', '--dir', '--addr', '--env', '-e', '--header', '-H', '--type', '-t', '--name']);
// These actions require operands. With just the action name the native CLI
// prints a usage error on stderr; keep its original arguments and exit code.
const requiresOperand = {
  mcp: ['add', 'remove', 'enable', 'disable'],
  plugin: ['install', 'uninstall', 'enable', 'disable', 'link'],
};

/** Return a command that can only display help, or null for normal CLI invocations. */
export function nativeCliHelpArgs(args, valueFlags = new Set()) {
  if (args[0] === 'help') return args.slice(0, 2);
  if (subcommandHelp.has(args[0]) && (args.length === 1 ||
      (args.length === 2 && requiresOperand[args[0] === 'plugins' ? 'plugin' : args[0]]?.includes(args[1])))) {
    return args;
  }
  const names = [];
  const rootHelp = [];
  let helpAfter = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (valueFlags.has(arg) || commandValueFlags.has(arg)) { index++; continue; }
    if (!names.length && /^--?help(?:full|short|xml)$/.test(arg)) { rootHelp.push(arg); continue; }
    // At the top level Go treats -help=VALUE as a search pattern. Preserve
    // the pattern and the native diagnostic when it matches no flags.
    if (names.length === 0 && /^--?help=/.test(arg)) { rootHelp.push(arg); continue; }
    if (names.length === 0 && ['-h', '-help', '--help'].includes(arg)) rootHelp.push('--help');
    if (/^(?:-h|--?help)(?:=(?:1|t|true|T|True|TRUE))?$/.test(arg)) helpAfter ??= names.length;
    else if (/^(?:-h|--help)=(?:0|f|false|F|False|FALSE)$/.test(arg)) helpAfter = null;
    else if (!arg.startsWith('-')) names.push(arg);
  }
  const [command, subcommand] = names;
  if (rootHelp.length) return rootHelp;
  if (helpAfter === 0) return ['--help'];
  if (command === 'help') return subcommand ? ['help', subcommand] : ['help'];
  if (subcommandHelp.has(command) && subcommand === 'help') return ['help', command];
  if (helpAfter === null) return null;
  if (helpAfter === 2 && subcommandHelp.get(command)?.has(subcommand)) return [command, subcommand, '--help'];
  // Several plugin actions take --help as a target. Ask the native help command
  // for their syntax instead of calling the action.
  return ['help', command];
}

const sections = {
  'Available subcommands:': '可用子命令：',
  'Arguments:': '参数：',
  'Commands:': '命令：',
  'Examples:': '示例：',
  'Flags:': '选项：',
  'Notes:': '说明：',
};
const text = {
  'Path where structured sandbox proxy audit logs (JSONL) will be emitted; disabled if empty': '沙盒代理结构化审计日志（JSONL）的保存路径。留空时关闭审计日志',
  'Emit ALLOW decisions in structured sandbox proxy audit logs': '在沙盒代理的结构化审计日志中记录 ALLOW（允许）决定',
  'log to standard error as well as files': '将日志同时写入文件和标准错误',
  'Disable logging to local disk (not including binary logging)': '关闭本地磁盘日志，二进制日志除外',
  'when logging hits line file:N, emit a stack trace': '记录日志时若到达 file:N 指定的行，输出调用栈',
  'If non-empty, write log files in this directory': '指定日志文件的保存目录',
  'If non-empty, add symbolic links in this directory to the log files': '在指定目录中创建指向日志文件的符号链接',
  "Buffer log messages logged at this level or lower (-1 means don't buffer; 0 means buffer INFO only; ...). Has limited applicability on non-prod platforms.": '缓冲此级别及以下级别的日志。-1 表示关闭缓冲，0 表示仅缓冲 INFO，依此类推。此设置在非生产平台上仅部分适用',
  'log to standard error instead of files': '将日志输出到标准错误',
  [`This flag determines how memory will be locked:
"none" means no memory will be locked.
"startup" means the memory in use at startup will be locked.
"all" means current and all future memory will be locked.
"executable" means to lock executable pages at startup.
The empty default will take a hint regarding the mlock style from the
environment var GOOGLE_MLOCK_HINT set by the borglet for latency sensitive
jobs at production priority.`]: `设置内存锁定方式：
"none"：不锁定内存。
"startup"：锁定启动时已使用的内存。
"all"：锁定当前和后续分配的全部内存。
"executable"：启动时锁定可执行内存页。
默认留空，读取 borglet 为生产优先级的延迟敏感任务设置的环境变量 GOOGLE_MLOCK_HINT。`,
  'Use old Datapol annotation sets for proto data sanitization': '使用旧版 Datapol 注解集对 proto 数据脱敏',
  'Use sensitivity-based field sanitizers for proto data sanitization': '根据字段敏感级别对 proto 数据脱敏',
  'Export sanitization metrics on /streamz': '通过 /streamz 导出脱敏指标',
  'No log message on initialization': '初始化时不输出日志消息',
  'logs at or above this threshold go to stderr': '将此级别及以上级别的日志输出到标准错误',
  'syslog() on program start-up.  We collect these logs to identify used (vs obsolete) binaries': '程序启动时调用 syslog()。收集这些日志可识别仍在使用和已经弃用的二进制文件',
  'comma-separated list of flag names that it is OK to specify on the command line even if the program does not define a flag with that name.  IMPORTANT: flags in this list that have arguments MUST use the flag=value format': '以逗号分隔的选项名列表。即使程序未定义这些选项，也允许在命令行指定。列表中带参数的选项必须使用 flag=value 格式',
  'Save and display the full stack trace of the point of non-ok util statuses': '保存并显示 util 状态异常处的完整调用栈',
  'log level for V logs': 'V 日志的详细级别',
  'print version and build info and exit': '打印版本与构建信息后退出',
  'comma-separated list of pattern=N settings for file-filtered logging': '按文件筛选日志，使用逗号分隔的 pattern=N 设置',
  'Add a directory to the workspace (repeatable)': '将目录加入工作区（可重复指定）',
  'Agent for the current CLI session': '当前 CLI 会话使用的代理',
  'Continue the most recent conversation': '继续最近的对话',
  'Resume a previous conversation by ID': '按 ID 恢复已有对话',
  'Auto-approve all tool permission requests without prompting': '自动批准所有工具权限请求，跳过确认提示',
  'Disable slash command and skill expansion in print mode': '在打印模式下禁用斜杠命令和技能展开',
  'Reasoning effort for the current CLI session (low|medium|high|xhigh|max)': '当前 CLI 会话的推理强度（low|medium|high|xhigh|max）',
  'Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin and runs a turn for each; it requires --output-format stream-json': '打印模式的输入格式（text、stream-json）。stream-json 从标准输入逐行读取 NDJSON 消息，每条消息运行一轮，需使用 --output-format stream-json',
  'Optional JSON schema string or path to a schema file to enforce structured output (for stream-json, only applicable to the final result)': '用于约束结构化输出的可选 JSON Schema 字符串或文件路径（stream-json 只约束最终结果）',
  'Override CLI log file path': '指定 CLI 日志文件路径',
  'Set the agent execution mode for this session (accept-edits, auto, plan)': '设置本次会话的代理执行模式（accept-edits、auto、plan）',
  'Model for the current CLI session': '当前 CLI 会话使用的模型',
  'Create a new project for this session': '为本次会话创建一个新项目',
  'Output format for print mode (text, json, stream-json)': '打印模式的输出格式（text、json、stream-json）',
  'Run a single prompt non-interactively and print the response': '以非交互方式运行一条提示并打印回复',
  'Optional time limit for print mode; 0 waits until the turn completes': '打印模式的可选时间上限，0 表示等待本轮结束',
  'Project ID or project name for the current CLI session': '当前 CLI 会话的项目 ID 或名称',
  'Run an initial prompt interactively and continue the session': '在交互模式下运行初始提示，然后继续会话',
  "Run this session's conversations using remote agents; --project then names a remote project by ID or name, otherwise they open in this machine's default remote project": '使用远程代理运行本次会话。可用 --project 指定远程项目的 ID 或名称，省略时使用本机的默认远程项目',
  'Create a remote connection for the CLI session on start up': '启动 CLI 会话时创建远程连接',
  'Run in a sandbox with terminal restrictions enabled': '在启用终端限制的沙盒中运行',
  'Settings for this session only, never saved: a JSON object of settings.json keys, inline or as a file path': '仅本次会话生效的设置，以 settings.json 字段组成的 JSON 对象内联传入，或提供文件路径',
  'Start the Agent Client Protocol (ACP) stdio server': '启动使用标准输入输出的 Agent Client Protocol（ACP）服务器',
  'List available agents': '列出可用代理',
  'Show changelog and release notes': '显示更新日志和发行说明',
  'Show help for subcommands': '显示子命令帮助',
  'Configure environment paths and shell settings': '配置环境路径和 Shell 设置',
  'Manage MCP servers (add, remove, list, enable, disable)': '管理 MCP 服务器（add、remove、list、enable、disable）',
  "Serve this machine's microphone to a CLI on another host": '将本机麦克风提供给另一台主机上的 CLI',
  'List available models': '列出可用模型',
  'Manage plugins (install, uninstall, list, enable, disable)': '管理插件（install、uninstall、list、enable、disable）',
  'Manage the remote-control background daemon (start, status, stop)': '管理远程控制后台进程（start、status、stop）',
  'Update CLI': '更新 CLI',
  'Agent for the ACP session': 'ACP 会话使用的代理',
  'Path where application data is stored': '应用数据存放路径',
  'Subdirectory under app_data_dir for CLI settings and logs': 'app_data_dir 下存放 CLI 设置和日志的子目录',
  'Override ACP log file path': '指定 ACP 日志文件路径',
  'CCPA API URL': 'CCPA API 的 URL',
  'Auto-approve all tool permission requests': '自动批准所有工具权限请求',
  'If true, disable telemetry': '设为 true 时禁用遥测',
  'Path where Gemini files are stored': 'Gemini 文件存放路径',
  'Show help': '显示帮助',
  "Port for host IDE tools MCP server (requires 'nc' in $PATH)": '宿主 IDE 工具的 MCP 服务器端口（$PATH 中需要有 nc）',
  'Include default customizations': '包含默认的自定义配置',
  'Whether running in Google environment': '是否在 Google 环境中运行',
  'Deprecated: use is_google3_workspace': '已弃用，请使用 is_google3_workspace',
  'Log in with Google interactively, then exit (ACP terminal auth)': '交互式登录 Google 后退出（ACP 终端认证）',
  'Override user agent name for HTTP requests': '指定 HTTP 请求的 User-Agent 名称',
  'Serve each session from an isolated worker process': '为每个会话单独分配工作进程',
  'Use stdio JSON-RPC transport': '使用标准输入输出传输 JSON-RPC',
  'Use LOAS auth': '使用 LOAS 认证',
  'Serve a single session for an ACP front process (internal)': '为 ACP 前端进程提供单个会话（内部选项）',
  'Custom directory target to configure PATH for': '要为其配置 PATH 的自定义目录',
  'Bypasses shell profile alias purging': '跳过清理 Shell 配置中的命令别名',
  'Bypasses shell profile PATH appending': '跳过向 Shell 配置追加 PATH',
  'Add or update an MCP server configuration': '添加或更新 MCP 服务器配置',
  'Remove an MCP server configuration': '移除 MCP 服务器配置',
  'List all configured MCP servers': '列出已配置的 MCP 服务器',
  'Enable an MCP server': '启用 MCP 服务器',
  'Disable an MCP server': '停用 MCP 服务器',
  'Run "agy mcp <subcommand> --help" for flags, argument rules, and examples.': '运行 "agy mcp <subcommand> --help" 查看选项、参数规则和示例。',
  'Environment variable KEY=value (repeatable)': '环境变量 KEY=value（可重复指定）',
  'HTTP header Key: Value (repeatable)': 'HTTP 请求头 Key: Value（可重复指定）',
  "Server type: 'stdio' or 'http'": "服务器类型为 'stdio' 或 'http'",
  'Unique name for the server.': '服务器的唯一名称。',
  'Executable for a stdio server, or the URL for an http server.': 'stdio 服务器的可执行文件或 http 服务器的 URL。',
  'Arguments passed to the stdio command.': '传给 stdio 命令的参数。',
  'Flags must come before <name>; a flag placed after it is rejected.': '选项必须放在 <name> 前面，放在后面会报错。',
  'http/https URLs are detected automatically, so --type is usually unnecessary.': '自动识别 http/https URL，通常无需指定 --type。',
  "Use -- before the command to pass a command or args that begin with '-'.": "在命令前加 --，即可传入以 '-' 开头的命令或参数。",
  'Address to listen on; keep it on loopback': '监听地址，请使用回环地址',
  'List installed plugins': '列出已安装的插件',
  'Import plugins from gemini or claude': '从 gemini 或 claude 导入插件',
  'Install a plugin (supports plugin[@marketplace])': '安装插件（支持 plugin[@marketplace]）',
  'Uninstall a plugin': '卸载插件',
  'Enable a plugin': '启用插件',
  'Disable a plugin': '停用插件',
  "Check a plugin's manifest and files: a directory,": '检查插件的清单和文件，支持目录、',
  'a .zip, a URL, or the plugins of a marketplace.json': '.zip、URL 或 marketplace.json 中的插件',
  '(see validate --help)': '（见 validate --help）',
  'Generate link to a marketplace': '生成插件市场链接',
  'Show this help': '显示此帮助',
  'Checks a plugin the way the plugin loader reads it, and reports the files and': '按插件加载器的规则检查插件，报告',
  'fields that the loader skips or ignores.': '加载器跳过或忽略的文件和字段。',
  'One of (default: the current directory):': '以下任一项（默认：当前目录）：',
  '- a plugin directory, or its plugin.json': '- 插件目录或其中的 plugin.json',
  '- a .zip of a plugin, as a file or an https URL': '- 插件 .zip 文件或其 https URL',
  '- a github.com repository URL; for a plugin in a subfolder,': '- github.com 仓库的 URL，子目录中的插件请使用',
  '- a marketplace.json, as a file or an https URL, to check': '- marketplace.json 文件或其 https URL，用于检查',
  'every plugin the catalog lists': '目录中列出的每个插件',
  'A zip or a repository is fetched to a temporary folder and only': 'zip 或仓库会下载到临时目录，仅供读取，',
  'read: nothing in it is installed or run.': '其中的内容不会被安装或运行。',
  'Also fail on warnings': '出现警告时也返回失败',
  'Print the report as JSON': '以 JSON 输出报告',
  'Each finding is an error (the loader skips a file or the plugin, or an item': '每项结果分为错误、警告或备注。错误表示加载器跳过文件、跳过插件',
  'can never work), a warning (a field or file is ignored or falls back to a': '或某项无法工作。警告表示忽略某个字段或文件、使用了',
  "default, or the plugin marketplace in Antigravity can't build or list the": '默认值，或 Antigravity 插件市场无法构建或列出',
  'plugin) or a note (how the plugin loads). Exits non-zero if there are errors,': '插件。备注说明插件如何加载。有错误时退出码非零。',
  'or warnings with --strict.': '使用 --strict 时，有警告也会返回非零退出码。',
  'Register and start the remote-control daemon': '注册并启动远程控制后台进程',
  "Show the daemon's status": '显示后台进程状态',
  'Stop the daemon and unregister it': '停止后台进程并取消注册',
  'Run "agy remote-control <subcommand> --help" for flags.': '运行 "agy remote-control <subcommand> --help" 查看选项。',
  "Set this machine's instance name shown in Remote Control": '设置本机在远程控制界面显示的实例名称',
  'Register the daemon login-scoped (stops at logout) instead of starting at boot': '将后台进程注册到登录会话（退出登录时停止），无需开机启动',
};

function translateDescription(original, strings) {
  const [source, defaultValue] = /^(.+?) \(default(?: (.*))?\)$/.exec(original)?.slice(1) ?? [original];
  const alias = /^(Short alias|Alias) for (\S+)$/.exec(source);
  const translated = strings?.[`cli-help:${source}`] ?? (Object.hasOwn(text, source) ? text[source] : undefined) ??
    (alias && `${alias[2]} 的${alias[1] === 'Short alias' ? '简写' : '别名'}`);
  if (!translated) return original;
  if (source === original) return translated;
  return defaultValue === undefined ? `${translated}（默认）` : `${translated}（默认 ${defaultValue}）`;
}

/** The native usage screen passes heap-assembled descriptions (including the mode choices). */
export function nativeUsageDescriptions(dictionary) {
  const strings = dictionary?.strings ?? dictionary;
  const known = new Set([...Object.keys(text), 'Short alias for --continue', 'Short alias for --print',
    'Short alias for --prompt-interactive', 'Alias for --print', 'Alias for plugin']);
  return [...known].map(original => ({original, translated:translateDescription(original, strings),
    sourceLength:Buffer.byteLength(original)}));
}

/** Localize native help prose while keeping command syntax and examples literal. */
export function localizeCliNativeHelp(output, dictionary) {
  if (!/^(?:Usage: |Usage of |Error: |flag: no flags match help pattern )/.test(output)) return output;
  const strings = dictionary?.strings ?? dictionary;
  // Full help prints -flag=default: description, with unindented continuation lines.
  if (/^Usage of [^\r\n]+:\r?\n[ \t]+-[\w-]+=/.test(output)) {
    return output.replace(/^Usage of ([^\r\n]+):/, '$1 用法：')
      .replace(/^([ \t]+-[\w-]+=[^\r\n]*?: )([^\r\n]*(?:\r?\n[^\s][^\r\n]*)*)/gm, (_, flag, prose) => {
        const translated = translateDescription(prose.replaceAll('\r\n', '\n'), strings);
        return flag + (prose.includes('\r\n') ? translated.replaceAll('\n', '\r\n') : translated);
      });
  }
  let inExamples = false;
  return output.replace(/[^\r\n]+/g, line => {
    if (Object.hasOwn(sections, line)) {
      inExamples = line === 'Examples:';
      return sections[line];
    }
    if (inExamples) return line;
    if (line.startsWith('Usage: ')) return `用法：${line.slice(7)}`;
    const usage = /^Usage of (.+):$/.exec(line);
    if (usage) return `${usage[1]} 用法：`;
    if (line.startsWith('Error: unknown subcommand: ')) return `错误，未知子命令：${line.slice(27)}`;
    if (line.startsWith('Error: usage: ')) return `错误，用法：${line.slice(14)}`;
    const unmatched = /^flag: no flags match help pattern (.+)$/.exec(line);
    if (unmatched) return `找不到与 ${unmatched[1]} 匹配的选项。`;
    const [,indent,content] = /^([ \t]*)(.*)$/.exec(line);
    const column = /^(\S(?:.*?\S)?[ \t]{2,})(\S.*)$/.exec(content);
    if (indent && column) return `${indent}${column[1]}${translateDescription(column[2], strings)}`;
    return `${indent}${translateDescription(content, strings)}`;
  });
}
