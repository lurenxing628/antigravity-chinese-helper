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

function fixture({ summaries = { new: { summary: 'Fix Login Button' } }, topLevel,
  startCascade, send, generate = () => ({ response: '修复登录界面' }), loadModel = () => model,
  BroadcastChannel = broadcastChannels() } = {}) {
  let current = summaries;
  let roots = topLevel ?? Object.fromEntries(Object.keys(summaries).map(id => [id, true]));
  const listeners = new Set();
  const calls = { started: [], sent: [], generated: [], saved: [], model: [] };
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
    async updateConversationAnnotations(request, options) {
      calls.saved.push({ request, options, receiver: this });
      for (const id of request.cascadeIds) {
        current = { ...current, [id]: { ...current[id], annotations: {
          ...(request.mergeAnnotations ? current[id]?.annotations : {}), ...request.annotations,
        } } };
      }
      emit();
      return 'saved';
    },
  };
  const original = Object.fromEntries(Object.keys(client).map(key => [key, client[key]]));
  const create = vm.runInNewContext(controllerSource, { AbortController, BroadcastChannel, queueMicrotask, setTimeout, clearTimeout });
  const controller = create(async (nativeClient) => {
    calls.model.push(nativeClient);
    return loadModel(nativeClient);
  });
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
    summaries: {
      history: { summary: 'Existing Conversation' },
      manual: { summary: 'Auto Title', annotations: { title: '我自己起的名字' } },
      child: { summary: 'Nested Task', trajectoryMetadata: { parentConversationId: 'history' } },
    },
    topLevel: { history: true, manual: true },
  });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.client.sendUserCascadeMessage(message('history'));
  for (const id of ['manual', 'child']) {
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

test('a native automatic title received before the first send succeeds still becomes Chinese', async t => {
  const sent = deferred();
  const f = fixture({ send: () => sent.promise });
  t.after(() => f.controller.dispose());
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  const sending = f.client.sendUserCascadeMessage(message());
  f.setSummary('new', { summary: 'Fix Login Button', annotations: { title: 'Fix Login Button' } });
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

test('a native automatic title received while the model is running does not cancel the Chinese title', async t => {
  const generated = deferred();
  const f = fixture({ generate: () => generated.promise });
  t.after(() => { generated.resolve({ response: '修复登录界面' }); f.controller.dispose(); });
  await f.bind();
  await f.client.startCascade({ cascadeId: 'new' });
  await f.client.sendUserCascadeMessage(message());
  await settle();
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.generated[0].request.model, model);
  f.setSummary('new', { summary: 'Fix Login Button', annotations: { title: 'Fix Login Button' } });
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
