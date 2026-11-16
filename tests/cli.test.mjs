import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArguments, parseContextK, readCliContext, cliHelp, launchCliSession, main } from '../runtime/cli.mjs';
import { collectCliMainContextPatch } from '../runtime/cli-context.mjs';

test('context arguments use decimal K and M, with an explicit default', () => {
  assert.equal(parseContextK('500'), 500000);
  assert.equal(parseContextK('500K'), 500000);
  assert.equal(parseContextK('1M'), 1000000);
  assert.equal(parseContextK('default'), null);
  for (const value of ['0', '-1', '500tokens', '2147484', undefined]) assert.throws(() => parseContextK(value));
});

test('helper options never consume option-looking prompt contents', () => {
  const parsed = parseCliArguments(['--main-context', '500', '-p', '--subagent-context', '--output-format', 'json'], {contextOverridesEnabled:true});
  assert.deepEqual(parsed.overrides, { mainTokens:500000 });
  assert.deepEqual(parsed.args, ['-p', '--subagent-context', '--output-format', 'json']);
  assert.equal(parsed.command, null);
  assert.equal(parseCliArguments(['--', '-p', '--version']).version, false);
  assert.equal(parseCliArguments(['--', '--version']).version, true);
  const forwarded = parseCliArguments(['--', '--main-context', '500', '-p', '--help'], {contextOverridesEnabled:true});
  assert.deepEqual(forwarded.args, ['--main-context', '500', '-p', '--help']);
  assert.deepEqual(forwarded.overrides, {});
  assert.equal(forwarded.help, false);
});

test('native install and service commands retain their executable path', () => {
  assert.equal(parseCliArguments(['--model', 'update', 'install']).command, 'install');
  assert.equal(parseCliArguments(['--', '--settings', '{}', 'remote-control', 'status']).command, 'remote-control');
  assert.equal(parseCliArguments(['-p', 'update']).command, null);
});


test('disabled context entries are rejected while prompt values remain untouched', async () => {
  for (const argv of [['context'], ['--main-context','500'], ['--subagent-context=128'],
    ['--','--main-context','500'], ['--','context']]) {
    assert.throws(() => parseCliArguments(argv), /上下文调节功能已停用/);
  }
  await assert.rejects(main(['context'], {stateDir:'/not-read'}), /上下文调节功能已停用/);
  assert.deepEqual(parseCliArguments(['-p','--main-context']).args, ['-p','--main-context']);
  assert.deepEqual(parseCliArguments(['--','-p','--subagent-context']).args, ['-p','--subagent-context']);
  assert.deepEqual(await readCliContext('/not-read'), {mainTokens:null,subagentTokens:null});
  assert.doesNotMatch(cliHelp(), /agy-zh context|--main-context|--subagent-context/);
  assert.match(cliHelp(), /原生默认/);
  assert.equal(collectCliMainContextPatch(null, null, 500000), null);
});

test('disabled context launches the native process without a budget layout or bridge', async () => {
  let ready = false;
  const code = await launchCliSession({ binaryPath:process.execPath,
    args:['--eval','process.exit(7)'], stdio:'ignore', subagentTokens:500000,
    layout:{}, machExecutablePath:'/not-used', launchExecutablePath:'/not-used',
    onReady({ runtime, pid }) { ready = true; assert.equal(runtime, null); assert(Number.isSafeInteger(pid)); },
  });
  assert.equal(code, 7);
  assert(ready);
});
