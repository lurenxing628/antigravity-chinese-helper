import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const runnerUrl = new URL('../runtime/runner.mjs', import.meta.url);
const runnerSource = readFileSync(runnerUrl, 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/^import .*;\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(runnerUrl.href))
  .split('\nmain().catch(')[0];

function page() {
  const context = vm.createContext({
    location: { protocol: 'https:', hostname: '127.0.0.1' },
    electronNative: { getZoomLevel() {} }, nativeStorage: { getItems() {} },
    installs: 0, uninstalls: 0,
  });
  vm.runInContext('globalThis.top = globalThis', context);
  return context;
}

async function fixture() {
  const files = {
    source: `(dictionary) => {
      installs++;
      return { version: 'fixture-1', dictionary, history: new Map([[1, 'cached']]),
        refresh(next) { this.dictionary = next; },
        uninstall() { uninstalls++; }
      };
    }`,
    dictionary: '{"strings":{"Hello":"你好"}}', sourceMtime: 1, dictionaryMtime: 1,
  };
  const current = page(), scripts = new Map();
  let scriptId = 0;
  const client = {
    connected: true,
    async call(method, params) {
      if (method === 'Runtime.evaluate') return { result: { value: vm.runInContext(params.expression, current) } };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        const identifier = String(++scriptId);
        scripts.set(identifier, params.source);
        return { identifier };
      }
      if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
        assert.equal(scripts.delete(params.identifier), true);
        return {};
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  };
  const context = vm.createContext({
    dirname, join, fileURLToPath, homedir: () => '/mock-home',
    process: { env: {}, pid: 123 },
    readFile: async path => path.endsWith('renderer.js') ? files.source : files.dictionary,
    stat: async path => ({ mtimeMs: path.endsWith('renderer.js') ? files.sourceMtime : files.dictionaryMtime }),
    writeFile: async () => {},
  });
  const runner = vm.runInContext(runnerSource + `\n({
    reload, sessions, install,
    async initialize() { bundle = await loadBundle(); }
  })`, context);
  await runner.initialize();
  const session = { client, scriptId: null, operation: Promise.resolve(), closing: false };
  runner.sessions.set('window', session);
  await runner.install(session);
  return { files, current, scripts, session, reload: runner.reload };
}

test('dictionary reload preserves the live helper and updates the next-document script', async () => {
  const f = await fixture();
  const helper = f.current.__antigravityChineseHelper;
  const history = helper.history;
  f.files.dictionary = '{"strings":{"Hello":"您好"}}';
  f.files.dictionaryMtime++;
  await f.reload();

  assert.strictEqual(f.current.__antigravityChineseHelper, helper);
  assert.strictEqual(helper.history, history);
  assert.equal(history.get(1), 'cached');
  assert.equal(helper.dictionary.strings.Hello, '您好');
  assert.equal(f.current.installs, 1);
  assert.equal(f.current.uninstalls, 0);
  assert.equal(f.scripts.size, 1);

  const navigated = page();
  vm.runInContext([...f.scripts.values()][0], navigated);
  assert.equal(navigated.__antigravityChineseHelper.dictionary.strings.Hello, '您好');
});

test('renderer source changes replace the helper and manual dictionary reload stays lightweight', async () => {
  const f = await fixture();
  const previous = f.current.__antigravityChineseHelper;
  f.files.source = f.files.source.replace('fixture-1', 'fixture-2');
  f.files.sourceMtime++;
  await f.reload();
  const replacement = f.current.__antigravityChineseHelper;
  assert.notStrictEqual(replacement, previous);
  assert.equal(replacement.version, 'fixture-2');
  assert.equal(f.current.installs, 2);
  assert.equal(f.current.uninstalls, 1);
  await f.reload();
  assert.strictEqual(f.current.__antigravityChineseHelper, replacement);
  assert.equal(f.current.uninstalls, 1);
  assert.equal(f.scripts.size, 1);
});

test('an invalid dictionary leaves both the current helper and navigation script intact', async () => {
  const f = await fixture();
  const previous = f.current.__antigravityChineseHelper;
  const script = [...f.scripts.entries()][0];
  f.files.dictionary = '{"strings":';
  f.files.dictionaryMtime++;
  await assert.rejects(f.reload(), { name: 'SyntaxError' });
  assert.strictEqual(f.current.__antigravityChineseHelper, previous);
  assert.deepEqual([...f.scripts.entries()], [script]);
  assert.equal(f.current.uninstalls, 0);
});
