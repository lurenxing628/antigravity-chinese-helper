import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const renderer = readFileSync(new URL('../runtime/renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('(function createChineseTitleController');
const end = renderer.indexOf('\n});', start);
assert.ok(start >= 0 && end > start, 'the actual Chinese title controller is present');
const controllerSource = renderer.slice(start, end + 3);
const settle = async () => { await nextTurn(); await nextTurn(); };
const model = 1417;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function message(cascadeId = 'new', text = '修复登录页面按钮失效的问题') {
  return { cascadeId, items: [{ chunk: { case: 'text', value: text } }] };
}

function broadcastChannels() {
  return class BroadcastChannel {
    static instances = new Set();
    constructor(name) {
      this.name = name;
      this.closed = false;
      this.listeners = new Set();
      this.messages = [];
      BroadcastChannel.instances.add(this);
    }
    addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); }
    removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); }
    postMessage(data) {
      this.messages.push(structuredClone(data));
      for (const peer of BroadcastChannel.instances) {
        if (peer === this || peer.name !== this.name) continue;
        queueMicrotask(() => {
          if (peer.closed) return;
          const event = { data: structuredClone(data) };
          peer.onmessage?.(event);
          for (const listener of peer.listeners) listener(event);
        });
      }
    }
    close() { this.closed = true; BroadcastChannel.instances.delete(this); }
  };
}

function memoryStorage() {
  const items = {}, listeners = new Set();
  return {
    async getItems() { return structuredClone(items); },
    async updateItems(changes) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete items[key]; else items[key] = value;
      }
      for (const listener of listeners) listener(structuredClone(changes));
    },
    onChanged(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
    snapshot: () => structuredClone(items),
  };
}

function lockManager() {
  const queues = new Map();
  return {
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (options?.ifAvailable && queues.has(name)) return Promise.resolve(callback(null));
      const previous = queues.get(name) ?? Promise.resolve();
      const running = previous.catch(() => {}).then(() => {
        if (options?.signal?.aborted) throw options.signal.reason;
        return callback({ name });
      });
      queues.set(name, running);
      running.finally(() => { if (queues.get(name) === running) queues.delete(name); }).catch(() => {});
      return running;
    },
  };
}

function fixture({ summaries = { new: {
  summary: 'Fix Login Button', stepCount: 0,
  createdTime: { seconds: 1793559164n, nanos: 423000000 },
} }, topLevel,
  startCascade, send, save, read, generate = () => ({ response: '修复登录界面' }), loadModel = () => model,
  BroadcastChannel = broadcastChannels(), storage = memoryStorage(), locks } = {}) {
  let current = summaries;
  let roots = topLevel ?? Object.fromEntries(Object.keys(summaries).map(id => [id, true]));
  const listeners = new Set();
  const calls = { started: [], sent: [], generated: [], saved: [], read: [], model: [] };
  const store = {
    getState: () => ({ trajectorySummaries: { summaries: current, indexes: { topLevel: roots } } }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const emit = () => { for (const listener of listeners) listener(); };
  const client = {
    async startCascade(request, options) {
      calls.started.push({ request, options, receiver: this });
      return startCascade ? startCascade(request, options) : { cascadeId: request.cascadeId };
    },
    async sendUserCascadeMessage(request, options) {
      calls.sent.push({ request, options, receiver: this });
      return send ? send(request, options) : 'sent';
    },
    async getModelResponse(request, options) {
      calls.generated.push({ request, options, receiver: this });
      return generate(request, options);
    },
    async getCascadeTrajectorySteps(request, options) {
      calls.read.push({ request, options, receiver: this });
      return read ? read(request, options) : {
        steps: [{ step: { case: 'userInput', value: { items: message(request.cascadeId).items } } }],
      };
    },
    async updateConversationAnnotations(request, options) {
      calls.saved.push({ request, options, receiver: this });
      const result = save ? await save(request, options) : 'saved';
      for (const id of request.cascadeIds) {
        current = { ...current, [id]: { ...current[id], annotations: {
          ...(request.mergeAnnotations ? current[id]?.annotations : {}), ...request.annotations,
        } } };
      }
      emit();
      return result;
    },
  };
  const original = Object.fromEntries(Object.keys(client).map(key => [key, client[key]]));
  const create = vm.runInNewContext(controllerSource, { AbortController, BroadcastChannel, queueMicrotask, setTimeout, clearTimeout });
  const controller = create(async (nativeClient) => {
    calls.model.push(nativeClient);
    return loadModel(nativeClient);
  }, { storage, locks });
  return {
    controller, client, calls, listeners, original, BroadcastChannel,
    bind: () => controller.bind(client, store),
    emit,
    setSummary(id, summary, isTopLevel = true) {
      current = { ...current, [id]: summary };
      roots = { ...roots };
      if (isTopLevel) roots[id] = true; else delete roots[id];
      emit();
    },
    summary: id => current[id],
  };
}

test('a confirmed new conversation generates one Chinese title through native APIs', async t => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.bind();
  assert.equal(f.listeners.size, 1, 'rebinding a native client must share its subscription');
  const startRequest = { cascadeId: 'new' }, startOptions = { source: 'start' };
  await f.client.startCascade(startRequest, startOptions);
  const request = message(), options = { source: 'send' };
  assert.equal(await f.client.sendUserCascadeMessage(request, options), 'sent');
  await settle();
  await f.client.sendUserCascadeMessage(message('new', '追加第二轮问题'));
  f.emit(); f.emit();
  await settle();

  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.model.length, 1);
  assert.equal(f.calls.model[0], f.client);
  const generated = f.calls.generated[0];
  assert.equal(generated.receiver, f.client);
  assert.equal(generated.request.model, model);
  assert.match(generated.request.prompt, /中文|简体/);
  assert.ok(generated.request.prompt.includes(request.items[0].chunk.value));
  assert.equal(generated.request.prompt.includes('追加第二轮问题'), false);
  assert.ok(generated.options.signal instanceof AbortSignal);
  assert.equal(f.calls.saved.length, 1);
  assert.deepEqual(structuredClone(f.calls.saved[0].request), {
    cascadeIds: ['new'], annotations: { title: '修复登录界面' }, mergeAnnotations: true,
  });
  assert.equal(f.calls.saved[0].receiver, f.client);
  assert.equal(f.summary('new').annotations.title, '修复登录界面');
  assert.deepEqual([...f.BroadcastChannel.instances].flatMap(channel => channel.messages), [],
    'the helper save must not broadcast a manual rename');
  assert.equal(f.calls.started[0].request, startRequest);
  assert.equal(f.calls.started[0].options, startOptions);
  assert.equal(f.calls.started[0].receiver, f.client);
  assert.equal(f.calls.sent[0].request, request);
  assert.equal(f.calls.sent[0].options, options);
  assert.equal(f.calls.sent[0].receiver, f.client);
});

test('history, manual titles and nested conversations never request a replacement title', async t => {
  const f = fixture({
    storage: memoryStorage(),
    summaries: {
      history: { summary: 'Existing Conversation', stepCount: 8,
        createdTime: { seconds: 1793472764n, nanos: 120000000 } },
      manual: { summary: 'Auto Title', annotations: { title: '我自己起的名字' } },
      child: { summary: 'Nested Task', trajectoryMetadata: { parentConversationId: 'history' } },
    },
    topLevel: { history: true, manual: true },
  });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.client.sendUserCascadeMessage(message('history'));
  for (const id of ['history', 'manual', 'child']) {
    await f.client.startCascade({ cascadeId: id });
    await f.client.sendUserCascadeMessage(message(id));
  }
  await settle();
  assert.equal(f.calls.generated.length, 0);
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.summary('manual').annotations.title, '我自己起的名字');
});

test('a first send completed before start confirmation is retained without duplicate generation', async t => {
  const started = deferred(), generated = deferred();
  const f = fixture({ startCascade: () => started.promise, generate: () => generated.promise });
  t.after(() => f.controller.dispose());
  await f.bind();
  const starting = f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  f.emit(); f.emit();
  await settle();
  assert.equal(f.calls.generated.length, 0, 'creation must succeed before using the model');
  started.resolve({ cascadeId: 'new' });
  await starting;
  await settle();
  await f.client.sendUserCascadeMessage(message('new', '第二次发送'));
  f.emit(); f.emit();
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.ok(f.calls.generated[0].request.prompt.includes('修复登录页面按钮失效的问题'));
  generated.resolve({ response: '修复登录界面' });
  await settle();
  assert.equal(f.calls.saved.length, 1);
});

test('a native manual rename aborts pending generation and keeps the manual title', async t => {
  const generated = deferred();
  const f = fixture({ generate: () => generated.promise });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 1);
  const request = { cascadeIds: ['new'], annotations: { title: '手动保留的标题' }, mergeAnnotations: true };
  const options = { source: 'manual' };
  assert.equal(await f.client.updateConversationAnnotations(request, options), 'saved');
  assert.equal(f.calls.generated[0].options.signal.aborted, true);
  generated.resolve({ response: '迟到的中文标题' });
  await settle();
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.calls.saved[0].request, request);
  assert.equal(f.calls.saved[0].options, options);
  assert.equal(f.summary('new').annotations.title, '手动保留的标题');
});

test('a real manual rename in another window aborts generation before its summary stream arrives', async t => {
  const generated = deferred();
  const BroadcastChannel = broadcastChannels();
  const f = fixture({ generate: () => generated.promise, BroadcastChannel });
  const other = fixture({ BroadcastChannel });
  t.after(() => { generated.resolve({ response: '迟到的中文标题' }); f.controller.dispose(); other.controller.dispose(); });
  await f.bind();
  await other.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  const request = { cascadeIds: ['new'], annotations: { title: '另一个窗口设置的标题' }, mergeAnnotations: true };
  assert.equal(await other.client.updateConversationAnnotations(request), 'saved');
  await settle();
  assert.equal(f.calls.generated[0].options.signal.aborted, true);
  generated.resolve({ response: '迟到的中文标题' });
  await settle();
  assert.equal(f.calls.saved.length, 0);
  assert.equal(other.calls.saved.length, 1);
  assert.equal(other.calls.saved[0].request, request);
  assert.equal(other.summary('new').annotations.title, '另一个窗口设置的标题');
  assert.equal(f.summary('new').annotations?.title, undefined, 'the other window stream has not arrived yet');
  const channels = [...BroadcastChannel.instances];
  assert.ok(channels.every(channel => channel.name === 'antigravityChineseHelper.manualTitles'));
  assert.deepEqual(channels.flatMap(channel => channel.messages), [{ type: 'manual-rename', cascadeIds: ['new'] }]);
});

test('a native automatic summary and explicit title received before the first send succeeds still become Chinese', async t => {
  const sent = deferred();
  const f = fixture({ send: () => sent.promise });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  const sending = f.client.sendUserCascadeMessage(message());
  f.setSummary('new', { ...f.summary('new'), summary: 'Fix Login Button', stepCount: 1,
    annotations: { title: 'Fix Login Button' } });
  sent.resolve('sent');
  assert.equal(await sending, 'sent');
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.generated[0].request.model, model);
  assert.ok(f.calls.generated[0].request.prompt.includes(message().items[0].chunk.value));
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.calls.saved[0].request.annotations.title, '修复登录界面');
  assert.equal(f.summary('new').annotations.title, '修复登录界面');
});

test('a native automatic summary and explicit title received during generation do not cancel the Chinese title', async t => {
  const generated = deferred();
  const f = fixture({ generate: () => generated.promise });
  t.after(() => { generated.resolve({ response: '修复登录界面' }); f.controller.dispose(); });
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.generated[0].request.model, model);
  f.setSummary('new', { ...f.summary('new'), summary: 'Fix Login Button', stepCount: 1,
    annotations: { title: 'Fix Login Button' } });
  assert.equal(f.calls.generated[0].options.signal.aborted, false);
  generated.resolve({ response: '修复登录界面' });
  await settle();
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.calls.saved[0].request.annotations.title, '修复登录界面');
  assert.equal(f.summary('new').annotations.title, '修复登录界面');
});

test('a manual rename before the first send keeps its title and prevents any model request', async t => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  const request = { cascadeIds: ['new'], annotations: { title: '发送前手动命名' }, mergeAnnotations: true };
  await f.client.updateConversationAnnotations(request);
  assert.equal(await f.client.sendUserCascadeMessage(message()), 'sent');
  await settle();
  assert.equal(f.calls.generated.length, 0);
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.calls.saved[0].request, request);
  assert.equal(f.summary('new').annotations.title, '发送前手动命名');
});

test('an old title present at the start call remains protected if the store changes before confirmation', async t => {
  const started = deferred();
  const f = fixture({
    summaries: { new: { summary: 'Existing Conversation', annotations: { title: '开始前已有标题' } } },
    startCascade: () => started.promise,
  });
  t.after(() => f.controller.dispose());
  await f.bind();
  const starting = f.client.startCascade({ cascadeId: 'new' });
  f.setSummary('new', { summary: 'Existing Conversation' });
  started.resolve({ cascadeId: 'new' });
  await starting;
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 0);
  assert.equal(f.calls.saved.length, 0);
});

test('dispose aborts pending work, restores native methods and suppresses late writes', async () => {
  const generated = deferred();
  const f = fixture({ generate: () => generated.promise });
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 1);
  const retainedListener = [...f.listeners][0];
  f.controller.dispose();
  assert.equal(f.calls.generated[0].options.signal.aborted, true);
  assert.equal(f.listeners.size, 0);
  for (const name of ['startCascade', 'sendUserCascadeMessage', 'updateConversationAnnotations']) {
    assert.equal(f.client[name], f.original[name], `${name} must be restored on exit`);
  }
  retainedListener?.();
  generated.resolve({ response: '退出后迟到的标题' });
  await settle();
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.BroadcastChannel.instances.size, 0, 'exit must close the manual rename channel');
  f.controller.dispose();
});

test('an unavailable title model leaves normal conversation sending intact', async t => {
  const f = fixture({ loadModel: () => { throw new Error('native title model unavailable'); } });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  assert.equal(await f.client.sendUserCascadeMessage(message()), 'sent');
  await settle();
  assert.equal(await f.client.sendUserCascadeMessage(message('new', '继续正常对话')), 'sent');
  await settle();
  assert.equal(f.calls.sent.length, 2);
  assert.equal(f.calls.generated.length, 0);
  assert.equal(f.calls.saved.length, 0);
});

test('an English model response preserves the native title without repeatedly calling the model', async t => {
  const f = fixture({ generate: () => ({ response: 'Fix Login Button' }) });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  await f.client.sendUserCascadeMessage(message('new', '继续第二轮'));
  f.emit();
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.summary('new').summary, 'Fix Login Button');
  assert.equal(f.summary('new').annotations?.title, undefined);
  assert.equal(f.controller.status().failed, 1);
});

test('a later native summary cannot replace the saved Chinese explicit title', async t => {
  const f = fixture({ storage: memoryStorage() });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  f.setSummary('new', { ...f.summary('new'), summary: 'A Later Native English Summary' });
  await settle();
  const summary = f.summary('new');
  assert.equal(summary.annotations.title || summary.summary, '修复登录界面');
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.saved.length, 1, 'summary updates require no compensating rename loop');
});

test('a durable manual marker cancels generation before the manual title reaches the summary store', async t => {
  const generated = deferred(), storage = memoryStorage();
  const f = fixture({ storage, generate: () => generated.promise });
  t.after(() => { generated.resolve({ response: '迟到的中文标题' }); f.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 1);
  await storage.updateItems({ 'antigravityChineseHelper.title.manual.new': JSON.stringify({ v: 1 }) });
  assert.equal(f.calls.generated[0].options.signal.aborted, true);
  generated.resolve({ response: '迟到的中文标题' });
  await settle();
  assert.equal(f.summary('new').annotations?.title, undefined, 'the manual rename summary stream has not arrived yet');
  assert.equal(f.calls.saved.length, 0, 'the durable manual marker protects the pending rename');
});

test('restart recovers an interrupted generation from the native first input without storing its text', async t => {
  const storage = memoryStorage(), generated = deferred();
  const source = '恢复首条用户输入中的设备排产要求';
  const f = fixture({ storage, generate: () => generated.promise });
  let resumed;
  t.after(() => { generated.resolve({ response: '旧实例的迟到结果' }); f.controller.dispose(); resumed?.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message('new', source));
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.ok(Object.keys(storage.snapshot()).length, 'the confirmed task survives a new controller');
  assert.equal(JSON.stringify(storage.snapshot()).includes(source), false, 'the durable record does not duplicate user input');
  f.controller.dispose();
  resumed = fixture({ storage, summaries: { new: f.summary('new') }, read: () => ({
    steps: [{ step: { case: 'userInput', value: { items: message('new', source).items } } }],
  }) });
  await resumed.bind();
  await resumed.controller.ready;
  await settle();
  assert.equal(resumed.calls.read.length, 1);
  assert.deepEqual(structuredClone(resumed.calls.read[0].request), {
    cascadeId: 'new', stepOffset: 0, trajectoryVerbosity: 2,
  });
  assert.equal(resumed.calls.read[0].receiver, resumed.client);
  assert.equal(resumed.calls.generated.length, 1);
  assert.ok(resumed.calls.generated[0].request.prompt.includes(source));
  assert.equal(resumed.summary('new').annotations.title, '修复登录界面');
  generated.resolve({ response: '旧实例的迟到结果' });
  await settle();
  assert.equal(f.calls.saved.length, 0, 'the disposed generation cannot write after recovery');
});

test('restart saves a durable Chinese result after a save failure without another model call', async t => {
  const storage = memoryStorage();
  const f = fixture({ storage, save: () => { throw new Error('save interrupted'); } });
  let resumed;
  t.after(() => { f.controller.dispose(); resumed?.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.summary('new').annotations?.title, undefined);
  assert.ok(JSON.stringify(storage.snapshot()).includes('修复登录界面'), 'the result is durable before native save succeeds');
  f.controller.dispose();
  resumed = fixture({ storage, summaries: { new: f.summary('new') } });
  await resumed.bind();
  await resumed.controller.ready;
  await settle();
  assert.equal(resumed.calls.read.length, 0);
  assert.equal(resumed.calls.model.length, 0);
  assert.equal(resumed.calls.generated.length, 0);
  assert.equal(resumed.calls.saved.length, 1);
  assert.equal(resumed.summary('new').annotations.title, '修复登录界面');
});

test('a manual rename waits for an already dispatched automatic save and writes last', async t => {
  const saving = deferred(), events = [];
  const f = fixture({ storage: memoryStorage(), save: async request => {
    const title = request.annotations.title;
    events.push(`begin:${title}`);
    if (title === '修复登录界面') await saving.promise;
    events.push(`end:${title}`);
    return 'saved';
  } });
  t.after(() => { saving.resolve(); f.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.saved.length, 1);
  const request = { cascadeIds: ['new'], annotations: { title: 'Manual English Name' }, mergeAnnotations: true };
  const renaming = f.client.updateConversationAnnotations(request);
  await settle();
  assert.equal(f.calls.saved.length, 1, 'the native manual RPC starts after the in-flight automatic RPC');
  saving.resolve();
  assert.equal(await renaming, 'saved');
  await settle();
  assert.deepEqual(events, ['begin:修复登录界面', 'end:修复登录界面', 'begin:Manual English Name', 'end:Manual English Name']);
  assert.equal(f.summary('new').annotations.title, 'Manual English Name');
});

test('the shared browser lock orders a manual rename in another window after an automatic save', async t => {
  const storage = memoryStorage(), locks = lockManager(), saving = deferred(), events = [];
  const BroadcastChannel = broadcastChannels();
  const f = fixture({ storage, locks, BroadcastChannel, save: async request => {
    events.push(`auto:${request.annotations.title}`);
    await saving.promise;
    return 'saved';
  } });
  const other = fixture({ storage, locks, BroadcastChannel, save: request => {
    events.push(`manual:${request.annotations.title}`);
    return 'saved';
  } });
  t.after(() => { saving.resolve(); f.controller.dispose(); other.controller.dispose(); });
  await f.bind();
  await other.bind();
  await Promise.all([f.controller.ready, other.controller.ready]);
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.saved.length, 1);
  const renaming = other.client.updateConversationAnnotations({
    cascadeIds: ['new'], annotations: { title: '另一窗口的手动名称' }, mergeAnnotations: true,
  });
  await settle();
  assert.equal(other.calls.saved.length, 0);
  saving.resolve();
  await renaming;
  await settle();
  assert.deepEqual(events, ['auto:修复登录界面', 'manual:另一窗口的手动名称']);
  assert.equal(other.summary('new').annotations.title, '另一窗口的手动名称');
  assert.equal(other.calls.generated.length, 0, 'both windows share one automatic generation task');
});

test('durable manual protection survives restart even before the manual title reaches the summary store', async t => {
  const storage = memoryStorage(), generated = deferred();
  const f = fixture({ storage, generate: () => generated.promise });
  let resumed;
  t.after(() => { generated.resolve({ response: '迟到的自动标题' }); f.controller.dispose(); resumed?.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  await f.client.updateConversationAnnotations({
    cascadeIds: ['new'], annotations: { title: 'My Own English Name' }, mergeAnnotations: true,
  });
  f.controller.dispose();
  resumed = fixture({ storage, summaries: { new: { summary: 'An Older Summary' } } });
  await resumed.bind();
  await resumed.controller.ready;
  await resumed.client.startCascade({ cascadeId: 'new' });
  await resumed.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(resumed.calls.model.length, 0);
  assert.equal(resumed.calls.read.length, 0);
  assert.equal(resumed.calls.saved.length, 0);
  resumed.setSummary('new', f.summary('new'));
  generated.resolve({ response: '迟到的自动标题' });
  await settle();
  assert.equal(resumed.summary('new').annotations.title, 'My Own English Name');
  assert.equal(f.calls.saved.length, 1, 'only the requested manual rename was written');
});

test('restart preserves an explicit title changed while the helper was not running', async t => {
  const storage = memoryStorage(), generated = deferred();
  const f = fixture({ storage, generate: () => generated.promise });
  let resumed;
  t.after(() => { generated.resolve({ response: '旧的中文结果' }); f.controller.dispose(); resumed?.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.ok(Object.keys(storage.snapshot()).length, 'the interrupted task was saved before the external rename');
  f.controller.dispose();
  resumed = fixture({ storage, summaries: {
    new: { summary: 'Native Summary', annotations: { title: 'An Intentional External Rename' } },
  } });
  await resumed.bind();
  await resumed.controller.ready;
  await settle();
  assert.equal(resumed.calls.read.length, 0);
  assert.equal(resumed.calls.generated.length, 0);
  assert.equal(resumed.calls.saved.length, 0);
  assert.equal(resumed.summary('new').annotations.title, 'An Intentional External Rename');
});

test('a recovered task accepts a native automatic title that arrives while reading its first input', async t => {
  const storage = memoryStorage(), generated = deferred(), firstInput = deferred();
  const source = '恢复后继续修复设备排产页面';
  const input = { steps: [{ step: { case: 'userInput', value: { items: message('new', source).items } } }] };
  const f = fixture({ storage, summaries: {}, generate: () => generated.promise });
  let resumed;
  t.after(() => {
    generated.resolve({ response: '旧实例的迟到结果' }); firstInput.resolve(input);
    f.controller.dispose(); resumed?.controller.dispose();
  });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  f.setSummary('new', { summary: 'Waiting For Native Title', stepCount: 1,
    createdTime: { seconds: 1793559164n, nanos: 423000000 } });
  await f.client.sendUserCascadeMessage(message('new', source));
  await settle();
  assert.equal(f.calls.generated.length, 1);
  f.controller.dispose();

  resumed = fixture({ storage, summaries: { new: f.summary('new') }, read: () => firstInput.promise });
  await resumed.bind();
  await resumed.controller.ready;
  await settle();
  assert.equal(resumed.calls.read.length, 1, 'the unchanged baseline admits the recovered task');
  assert.equal(resumed.calls.generated.length, 0, 'the native first input is still pending');
  resumed.setSummary('new', { ...resumed.summary('new'), summary: 'A Native English Title',
    annotations: { title: 'A Native English Title' } });
  firstInput.resolve(input);
  await settle();
  assert.equal(resumed.calls.generated.length, 1);
  assert.equal(resumed.calls.generated[0].request.model, model);
  assert.ok(resumed.calls.generated[0].request.prompt.includes(source));
  assert.equal(resumed.calls.saved.length, 1);
  assert.equal(resumed.summary('new').annotations.title, '修复登录界面');
  assert.equal(Object.keys(storage.snapshot()).some(key => key.startsWith('antigravityChineseHelper.title.manual.')), false,
    'an automatic title after recovery begins must not become a durable manual marker');
});

test('a recovered task waits for a delayed summary instead of treating it as deletion', async t => {
  const storage = memoryStorage(), generated = deferred();
  const f = fixture({ storage, generate: () => generated.promise });
  let resumed;
  t.after(() => { generated.resolve({ response: '旧实例的结果' }); f.controller.dispose(); resumed?.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  f.controller.dispose();
  resumed = fixture({ storage, summaries: {}, read: () => ({
    steps: [{ step: { case: 'userInput', value: { query: '恢复旧格式的首条用户请求' } } }],
  }) });
  await resumed.bind();
  await resumed.controller.ready;
  await settle();
  assert.equal(resumed.calls.read.length, 0);
  assert.equal(resumed.calls.generated.length, 0);
  resumed.setSummary('new', { summary: 'A Delayed Native Summary' });
  await settle();
  assert.equal(resumed.calls.read.length, 1);
  assert.equal(resumed.calls.generated.length, 1);
  assert.ok(resumed.calls.generated[0].request.prompt.includes('恢复旧格式的首条用户请求'));
  assert.equal(resumed.calls.saved.length, 1);
  assert.equal(resumed.summary('new').annotations.title, '修复登录界面');
});

test('unavailable durable storage disables automatic titles while native sending and manual rename keep working', async () => {
  const unavailable = {
    async getItems() { throw new Error('native storage is unavailable'); },
    async updateItems() { throw new Error('native storage is unavailable'); },
  };
  for (const storage of [null, unavailable]) {
    const f = fixture({ storage });
    try {
      await f.bind();
      await f.controller.ready;
      await f.client.startCascade({ cascadeId: 'new' });
      assert.equal(await f.client.sendUserCascadeMessage(message()), 'sent');
      await settle();
      assert.equal(f.calls.generated.length, 0, 'automatic work requires a readable durable manual-protection record');
      assert.equal(f.calls.saved.length, 0);
      const request = { cascadeIds: ['new'], annotations: { title: '手动命名仍然可用' }, mergeAnnotations: true };
      assert.equal(await f.client.updateConversationAnnotations(request), 'saved');
      await settle();
      assert.equal(f.calls.saved[0].request, request);
      assert.equal(f.summary('new').annotations.title, '手动命名仍然可用');
      assert.ok(f.controller.status().storageError);
    } finally { f.controller.dispose(); }
  }
});

test('a server-assigned conversation id stays eligible when its new summary arrives before start confirmation', async t => {
  const started = deferred();
  const f = fixture({ startCascade: () => started.promise });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.controller.ready;
  const starting = f.client.startCascade({});
  f.setSummary('assigned', {
    summary: 'A Newly Created Native Summary', stepCount: 1,
    createdTime: { seconds: 1793559164n, nanos: 0 },
  });
  await f.client.sendUserCascadeMessage(message('assigned'));
  started.resolve({ cascadeId: 'assigned' });
  await starting;
  await settle();
  assert.equal(f.calls.generated.length, 1, 'the confirmed start distinguishes this new id from old history');
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.calls.saved[0].request.cascadeIds[0], 'assigned');
  assert.equal(f.summary('assigned').annotations.title, '修复登录界面');
});

test('a rejected restart call does not discard an already confirmed title task', async t => {
  const generated = deferred();
  let starts = 0;
  const f = fixture({
    startCascade: request => ++starts === 1 ? { cascadeId: request.cascadeId } : Promise.reject(new Error('restart rejected')),
    generate: () => generated.promise,
  });
  t.after(() => { generated.resolve({ response: '修复登录界面' }); f.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 1);
  await assert.rejects(f.client.startCascade({ cascadeId: 'new' }), /restart rejected/);
  await settle();
  assert.equal(f.calls.generated[0].options.signal.aborted, false, 'a failed later start does not cancel the earlier valid task');
  generated.resolve({ response: '修复登录界面' });
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.summary('new').annotations.title, '修复登录界面');
});

test('recovery waits for a first input that appears after the initial empty step page', async t => {
  const storage = memoryStorage();
  const f = fixture({ storage });
  let resumed, hasInput = false;
  t.after(() => { f.controller.dispose(); resumed?.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  await f.client.startCascade({ cascadeId: 'new' });
  await settle();
  assert.ok(Object.keys(storage.snapshot()).length);
  f.controller.dispose();
  const beforeInput = { summary: 'Waiting For Input', stepCount: 0, trajectoryId: 'new-trajectory' };
  resumed = fixture({ storage, summaries: { new: beforeInput }, read: () => ({
    steps: hasInput ? [{ step: { case: 'userInput', value: { items: message('new', '首条输入稍后到达').items } } }] : [],
  }) });
  await resumed.bind();
  await resumed.controller.ready;
  await settle();
  assert.equal(resumed.calls.read.length, 1);
  assert.equal(resumed.calls.generated.length, 0);
  resumed.emit(); resumed.emit();
  await settle();
  assert.equal(resumed.calls.read.length, 1, 'unchanged summaries do not repeatedly fetch an empty first page');
  hasInput = true;
  resumed.setSummary('new', { ...beforeInput, summary: 'First Input Arrived', stepCount: 1 });
  await settle();
  assert.equal(resumed.calls.read.length, 2);
  assert.equal(resumed.calls.generated.length, 1);
  assert.ok(resumed.calls.generated[0].request.prompt.includes('首条输入稍后到达'));
  assert.equal(resumed.calls.saved.length, 1);
});

test('one failed concurrent start does not discard the same-id start that later succeeds', async t => {
  const first = deferred(), second = deferred();
  let starts = 0;
  const f = fixture({ startCascade: () => ++starts === 1 ? first.promise : second.promise });
  t.after(() => { first.reject(new Error('first start rejected')); second.resolve({ cascadeId: 'new' }); f.controller.dispose(); });
  await f.bind();
  await f.controller.ready;
  const rejected = assert.rejects(f.client.startCascade({ cascadeId: 'new' }), /first start rejected/);
  const succeeding = f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message('new', '并发创建成功后正常命名'));
  first.reject(new Error('first start rejected'));
  await rejected;
  await settle();
  assert.equal(f.calls.generated.length, 0, 'a surviving start still needs its own success confirmation');
  second.resolve({ cascadeId: 'new' });
  await succeeding;
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.summary('new').annotations.title, '修复登录界面');
});

test('a disposed start callback and cached wrapper cannot alter the next controller durable tasks', async t => {
  const storage = memoryStorage(), oldStart = deferred(), recoveredGeneration = deferred();
  const f = fixture({ storage, startCascade: request => request.cascadeId === 'new'
    ? oldStart.promise : { cascadeId: request.cascadeId } });
  let resumed;
  t.after(() => {
    oldStart.reject(new Error('old start rejected late'));
    recoveredGeneration.resolve({ response: '恢复后的中文标题' });
    f.controller.dispose(); resumed?.controller.dispose();
  });
  await f.bind();
  await f.controller.ready;
  const cachedStart = f.client.startCascade;
  const rejected = assert.rejects(cachedStart.call(f.client, { cascadeId: 'new' }), /old start rejected late/);
  await f.client.sendUserCascadeMessage(message());
  await settle();
  f.controller.dispose();
  resumed = fixture({ storage, summaries: { new: {
    summary: 'A Recovered New Conversation', stepCount: 1, trajectoryId: 'recovered-trajectory',
  } }, generate: () => recoveredGeneration.promise });
  await resumed.bind();
  await resumed.controller.ready;
  await settle();
  assert.equal(resumed.calls.generated.length, 1);
  const beforeLateCallback = storage.snapshot();
  oldStart.reject(new Error('old start rejected late'));
  await rejected;
  await settle();
  assert.deepEqual(storage.snapshot(), beforeLateCallback, 'the old failed start cannot delete the recovered controller record');
  const result = await cachedStart.call(f.client, { cascadeId: 'orphan' });
  await settle();
  assert.equal(result.cascadeId, 'orphan', 'a cached wrapper still delegates to the original native API');
  assert.deepEqual(storage.snapshot(), beforeLateCallback, 'a stopped cached wrapper cannot create a durable orphan task');
  recoveredGeneration.resolve({ response: '恢复后的中文标题' });
  await settle();
  assert.equal(resumed.calls.saved.length, 1);
  assert.equal(resumed.summary('new').annotations.title, '恢复后的中文标题');
});

test('a completed shared task does not mistake another window stale summary for a manual rename', async t => {
  const storage = memoryStorage(), locks = lockManager(), BroadcastChannel = broadcastChannels();
  const f = fixture({ storage, locks, BroadcastChannel });
  const other = fixture({ storage, locks, BroadcastChannel });
  t.after(() => { f.controller.dispose(); other.controller.dispose(); });
  await f.bind();
  await other.bind();
  await Promise.all([f.controller.ready, other.controller.ready]);
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.summary('new').annotations.title, '修复登录界面');
  assert.equal(other.summary('new').annotations?.title, undefined, 'the peer summary has not received the saved title yet');
  other.emit(); other.emit();
  await settle();
  assert.equal(f.calls.generated.length + other.calls.generated.length, 1);
  assert.equal(f.calls.saved.length + other.calls.saved.length, 1);
  assert.equal(f.controller.status().manualTitles, 0);
  assert.equal(other.controller.status().manualTitles, 0);
  assert.equal(Object.keys(storage.snapshot()).some(key => key.startsWith('antigravityChineseHelper.title.manual.')), false,
    'an applied terminal record must not create a durable manual tombstone from stale peer state');
});
