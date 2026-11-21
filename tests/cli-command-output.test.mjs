import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cliOutputCommand, commandLineTranslator } from '../runtime/cli-command-output.mjs';

const dictionary = JSON.parse(readFileSync(new URL('../runtime/translations.json', import.meta.url)));
test('administrative output keeps JSON, prompts, endpoints and commands intact', () => {
  for (const args of [['plugins','validate','--json'], ['plugin','list','--json'], ['plugin','validate','-json'], ['plugins','list','-json']]) {
    assert.deepEqual(cliOutputCommand(args), {command:'plugin', action:args[1], machineOutput:true});
  }
  for (const args of [['acp'], ['-p','mcp'],
    ['remote-control','serve'], ['--print','plugin list']]) assert.equal(cliOutputCommand(args), null);
  assert.deepEqual(cliOutputCommand(['--model', 'dummy', 'mcp', 'list'], new Set(['--model'])), {command:'mcp', action:'list'});
  assert.deepEqual(cliOutputCommand(['agent']), {command:'agents', action:undefined});
  assert.deepEqual(cliOutputCommand(['remote-control','typo']), {command:'remote-control', action:'typo'});
  const mcp = commandLineTranslator('mcp', 'list', dictionary);
  const header = 'NAME        TYPE   STATUS    COMMAND/URL';
  assert.match(mcp(header, false), /名称.*类型.*状态.*命令\/URL/);
  assert.equal(mcp('my enabled  stdio  disabled  echo enabled disabled', false), 'my enabled  stdio  已停用    echo enabled disabled');
  const plugin = commandLineTranslator('plugin','list',dictionary);
  assert.equal(plugin('- My (enabled) (disabled, 1.0)', false), '- My (enabled)（已停用, 1.0）');
  assert.equal(plugin('    Source:     enabled', false), '    来源：enabled');
  const pluginImport = commandLineTranslator('plugin','import',dictionary);
  assert.equal(pluginImport('          ✔ mcpServers  : 1 installed (echo)', false), '          ✔ MCP 服务器：已安装 1 (echo)');
});
test('plugin validation renders the diagnostic and retains the exact path and invalid value', () => {
  const validate = commandLineTranslator('plugin', 'validate', dictionary);
  assert.equal(validate('  ✗ plugin.json: a b is not a directory', false), '  ✗ plugin.json: a b 不是目录');
  assert.equal(validate('Error: validation failed: 1 error, 0 warnings', true), '错误：校验失败：1 个错误，0 条警告');
});
