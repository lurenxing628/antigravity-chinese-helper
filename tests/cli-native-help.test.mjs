import assert from 'node:assert/strict';
import test from 'node:test';
import { localizeCliNativeHelp, nativeCliHelpArgs } from '../runtime/cli-native-help.mjs';

test('native help routes root, aliases and nested commands through display-only arguments', () => {
  const valueFlags = new Set(['-p', '--model', '--print', '--prompt', '--prompt-interactive']);
  const examples = [
    [['-h'], ['--help']],
    [['-help'], ['--help']],
    [['-helpfull'], ['-helpfull']],
    [['--helpshort'], ['--helpshort']],
    [['--helpxml'], ['--helpxml']],
    [['-p','--helpfull'], null],
    [['plugin','install','--helpshort'], null],
    [['--help=model'], ['--help=model']],
    [['-help=false'], ['-help=false']],
    [['--help','models'], ['--help']],
    [['--model','foo','models','-h'], ['help','models']],
    [['future-command','--help'], ['help','future-command']],
    [['--model','--help','future-command','-h'], ['help','future-command']],
    [['help','agents'], ['help','agents']],
    [['remote-control'], ['remote-control']],
    [['mcp'], ['mcp']],
    [['plugin'], ['plugin']],
    [['plugins'], ['plugins']],
    [['mcp','add'], ['mcp','add']],
    [['plugins','uninstall'], ['plugins','uninstall']],
    [['mcp','list'], null],
    [['plugin','validate'], null],
    [['plugin','install','some-plugin'], null],
    [['mcp','help'], ['help','mcp']],
    [['mcp','add','--help'], ['mcp','add','--help']],
    [['mcp','add','-help'], ['mcp','add','--help']],
    [['mcp','--help','add'], ['help','mcp']],
    [['plugins','validate','-h'], ['plugins','validate','--help']],
    [['plugin','uninstall','--help'], ['help','plugin']],
    [['install','--help'], ['help','install']],
    [['update','--help'], ['help','update']],
    [['-p','--help'], null],
    [['--print','help'], null],
    [['--prompt','--help'], null],
    [['--prompt-interactive','--help'], null],
    [['-p','text','--','--help'], null],
    [['mcp','add','--env','--help'], null],
    [['models','--help=false'], null],
    [['--','--help'], null],
    [['--','help','models'], null],
    [['--print=--help'], null],
  ];
  for (const [args, expected] of examples) assert.deepEqual(nativeCliHelpArgs(args, valueFlags), expected);
});

test('full help translates whole multiline descriptions while preserving defaults and line endings', () => {
  const output = 'Usage of /tmp/agy:\r\n  -remote-control=false: Create a remote connection for the CLI session on start up\r\n' +
    '  -new="": First line\r\nSecond line\r\n  -v=0: log level for V logs\r\n';
  assert.equal(localizeCliNativeHelp(output, {'cli-help:First line\nSecond line':'第一行\n第二行'}),
    '/tmp/agy 用法：\r\n  -remote-control=false: 启动 CLI 会话时创建远程连接\r\n' +
    '  -new="": 第一行\r\n第二行\r\n  -v=0: V 日志的详细级别\r\n');
  const xml = '<AllFlags><usage>Usage of agy:</usage><meaning>Show help</meaning></AllFlags>';
  assert.equal(localizeCliNativeHelp(xml), xml);
});

test('help translates headings and prose while retaining usage, option values, examples and line endings', () => {
  const lines = [
    'Usage: agy mcp add [flags] <name> <commandOrUrl> [args...]',
    '',
    'Add or update an MCP server configuration',
    'Flags:',
    '  -H        Short alias for --header (default [])',
    '  --type    Server type: \'stdio\' or \'http\' (default stdio)',
    '  --extra   Criteria for this example',
    '  --other   New upstream option',
    'Examples:',
    '  agy mcp add --header "Authorization: Bearer TOKEN" api https://example.com/mcp',
    '',
  ];
  const result = localizeCliNativeHelp(lines.join('\r\n'), {strings:{'cli-help:Criteria for this example':'此示例的条件'}});
  assert.deepEqual(result.split('\r\n'), [
    '用法：agy mcp add [flags] <name> <commandOrUrl> [args...]',
    '',
    '添加或更新 MCP 服务器配置',
    '选项：',
    '  -H        --header 的简写（默认 []）',
    '  --type    服务器类型为 \'stdio\' 或 \'http\'（默认 stdio）',
    '  --extra   此示例的条件',
    lines[7],
    '示例：',
    lines[9],
    '',
  ]);
});

test('machine-readable and ordinary output bypass help translation', () => {
  const json = '{"message":"Usage: agy models [flags]"}\n';
  assert.equal(localizeCliNativeHelp(json), json);
  assert.equal(localizeCliNativeHelp('Show help\n'), 'Show help\n');
  assert.equal(localizeCliNativeHelp('Error: unknown subcommand: xyz\n'), '错误，未知子命令：xyz\n');
  assert.equal(localizeCliNativeHelp('Error: usage: mcp enable <name>\n'), '错误，用法：mcp enable <name>\n');
  assert.equal(localizeCliNativeHelp('flag: no flags match help pattern "abc"\n'), '找不到与 "abc" 匹配的选项。\n');
});
