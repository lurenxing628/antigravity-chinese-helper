import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../runtime/renderer.js', import.meta.url), 'utf8');
const factoryStart = renderer.indexOf('(function installStatusFormatters');
const factoryEnd = renderer.indexOf('\n});', factoryStart);
assert.ok(factoryStart >= 0 && factoryEnd > factoryStart, 'status formatter factory is present');
const factorySource = renderer.slice(factoryStart, factoryEnd + 3);
const uninstallSource = renderer.match(/\n    uninstall\(\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(uninstallSource, 'renderer uninstall method is present');

function fixture() {
  const window = {};
  window.window = window;
  const context = vm.createContext(window);
  const install = vm.runInContext(factorySource, context);
  const registered = [];
  return {
    window,
    evaluate: source => vm.runInContext(source, context),
    install: () => install({
      strings: {},
      register: (key, original, wrapper, kind, owner) => registered.push({key, original, wrapper, kind, owner})
    }),
    uninstall: () => vm.runInContext(`(function(nativeMenuHooks) {
      let stopped = false;
      const clearPending = () => {}, restore = () => {};
      const contextRings = {dispose() {}};
      const originalLang = null;
      const document = {documentElement: {removeAttribute() {}, setAttribute() {}}};
      const api = {${uninstallSource}};
      return api.uninstall;
    })`, context)(registered)
  };
}

const runningSource = '(function runningFormatter(active) { const marker={toolSummary:active}; return active?"Running command":"Exploring"; })';

test('closure loss falls back once, including cached wrapper references and native errors', () => {
  const f = fixture();
  const native = f.evaluate(`(() => {
    const calls = [];
    const hidden = function(input, suffix) {
      calls.push({receiver: this, input, suffix});
      if (input.error) throw input.error;
      return this.prefix + input.path + suffix;
    };
    return {
      calls,
      formatter: function pathFormatter(input, suffix) {
        const directoryPathUri = input.path, read_file = true;
        return \`Searching \${hidden.call(this, input, suffix)}\`;
      }
    };
  })()`);
  f.window.path = native.formatter;
  f.window.running = f.evaluate(runningSource);
  const adapters = f.install();
  const saved = f.window.path;
  const receiver = {prefix: 'owner:'};
  const input = {path: '/file'};
  assert.equal(adapters.count, 2);
  assert.equal(saved.call(receiver, input, ':tail'), 'Searching owner:/file:tail');
  assert.equal(f.window.path, native.formatter);
  assert.equal(native.calls[0].receiver, receiver);
  assert.equal(native.calls[0].input, input);
  assert.equal(native.calls[0].suffix, ':tail');

  let retried = 0;
  f.window.hidden = () => { retried++; return 'wrong binding'; };
  assert.equal(saved.call(receiver, input, ':again'), 'Searching owner:/file:again');
  assert.equal(retried, 0, 'saved wrapper must never try localization again');
  const nativeError = new Error('native formatter failure');
  assert.throws(() => saved.call(receiver, {error: nativeError}, ':error'), error => error === nativeError);
  assert.equal(native.calls.length, 3, 'each fallback calls the original exactly once');
  assert.equal(f.window.running(true), '正在运行命令');
  assert.equal(adapters.count, 1, 'the failed adapter is no longer reported as installed');
});

test('an un-compilable formatter stays native while later adapters still install', () => {
  const f = fixture();
  const original = f.evaluate('({path(input) { const directoryPathUri=input,read_file=true;return `Searching ${directoryPathUri}`; }}).path');
  f.window.path = original;
  f.window.running = f.evaluate(runningSource);
  const adapters = f.install();
  assert.equal(f.window.path, original);
  assert.equal(f.window.path('query'), 'Searching query');
  assert.deepEqual(Array.from(adapters.hooks, hook => hook.kind), ['status-running']);
  assert.equal(f.window.running(true), '正在运行命令');
  assert.equal(adapters.count, 1);
  f.uninstall()();
  assert.equal(f.window.path, original);
  assert.equal(f.window.running(false), 'Exploring');
});

test('fallback and an old uninstall preserve subsequent owners', () => {
  const f = fixture();
  f.window.path = f.evaluate('(() => { const hidden=value=>value;return function pathFormatter(input) { const directoryPathUri=input,read_file=true;return `Searching ${hidden(directoryPathUri)}`; }; })()');
  f.install();
  const saved = f.window.path;
  const uninstall = f.uninstall();
  const later = () => 'later owner';
  f.window.path = later;
  assert.equal(saved('query'), 'Searching query');
  assert.equal(f.window.path, later, 'a failed saved wrapper does not replace the current owner');
  uninstall();
  assert.equal(f.window.path, later, 'old uninstall does not overwrite a later replacement');
});
