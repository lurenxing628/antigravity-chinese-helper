import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../runtime/renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('(function createContextRingController');
const end = renderer.indexOf('\n});', start);
assert.ok(start >= 0 && end > start, 'the actual controller is present');
const controllerSource = renderer.slice(start, end + 3);
const model = 1417;
const settle = async () => { await nextTurn(); await nextTurn(); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

function usage(input, output, cache) {
  return {model, inputTokens:BigInt(input), outputTokens:BigInt(output), cacheReadTokens:BigInt(cache)};
}

function record(index, overrides = {}) {
  return {stepIndices:[index], plannerConfig:{planModel:model}, metadata:{case:'chatModel', value:{
    model, usage:usage(10, (index + 1) * (2 * (index + 1) + 1), 30),
    timeToFirstToken:{seconds:BigInt(index + 1), nanos:500000000},
    streamingDuration:{seconds:BigInt(index + 1), nanos:500000000},
    ...overrides
  }}};
}

function state(id, generation, {stepUsage, costSummary} = {}) {
  return {conversationId:id, fullyIdle:false, costSummary, trajectorySlice:{
    totalGeneratorMetadataLength:generation,
    generatorMetadatasInSlice:generation ? [{stepIndices:[generation - 1], plannerConfig:{planModel:model}}] : [],
    totalStepsLength:generation, stepsSlice:{startIndex:Math.max(0, generation - 1)},
    stepsInSlice:stepUsage ? [{metadata:{modelUsage:stepUsage}}] : []
  }};
}

function fixture(initial, {metadata = () => ({generatorMetadata:[]}), catalog, config, stored = {}, save, load,
  childStates = {}, byParent = {}} = {}) {
  let current = initial;
  const listeners = new Set();
  const storageListeners = new Set();
  const storeListeners = new Set();
  const childListeners = new Map(), childProviders = new Map(), registryActive = new Map();
  const calls = {metadata:[], catalog:0, config:0, resolved:[], sent:[], saved:[], subscribed:[], unsubscribed:[]};
  const selected = {value:model, label:'Gemini Fixture'};
  let actions;
  const provider = {
    getState:() => current,
    onDidChange(listener) { listeners.add(listener); return {dispose:() => listeners.delete(listener)}; }
  };
  const store = {
    getState:() => ({trajectorySummaries:{indexes:{byParent}}}),
    subscribe(listener) { storeListeners.add(listener); return () => storeListeners.delete(listener); }
  };
  function childProvider(id) {
    if (!childProviders.has(id)) {
      const listeners = new Set();
      childListeners.set(id, listeners);
      childProviders.set(id, {
        getState:() => childStates[id],
        onDidChange(listener) { listeners.add(listener); return {dispose:() => listeners.delete(listener)}; }
      });
    }
    return childProviders.get(id);
  }
  const registry = {
    getAgentStates:() => new Map([...childProviders].map(([id, provider]) => [id, {provider}])),
    peek:id => childProviders.get(id),
    subscribe(id) {
      calls.subscribed.push(id);
      registryActive.set(id, (registryActive.get(id) ?? 0) + 1);
      return {agentStateProvider:childProvider(id), unsubscribe() {
        calls.unsubscribed.push(id);
        registryActive.set(id, registryActive.get(id) - 1);
      }};
    }
  };
  const client = {
    getAvailableModels() {
      calls.catalog++;
      return catalog ? catalog() : Promise.resolve({models:{
        fixture:{model, maxTokens:1048576, maxOutputTokens:65536, displayName:'Gemini Fixture'},
        claude:{model:1402, maxTokens:1000000, maxOutputTokens:128000, displayName:'Claude Fixture'}
      }});
    },
    getResolvedCascadeConfig(request) {
      calls.config++;
      calls.resolved.push(request);
      return config ? config(request) : Promise.resolve({cascadeConfig:{
        checkpointConfig:{enabled:true, maxTokenLimit:request?.overrideConfig?.checkpointConfig?.maxTokenLimit ?? 256000}, plannerConfig:{maxOutputTokens:65536}
      }});
    },
    getCascadeTrajectoryGeneratorMetadata(request) {
      calls.metadata.push({...request});
      return metadata(request);
    },
    async sendUserCascadeMessage(request, options) { calls.sent.push({method:'message', request, options, receiver:this}); return 'message-result'; },
    async sendAllQueuedMessages(request, options) { calls.sent.push({method:'queued', request, options, receiver:this}); return 'queued-result'; }
  };
  const view = {
    host:{}, updates:[], disposed:false,
    update(snapshot) {
      assert.equal(this.disposed, false, 'a late callback must not write to a disposed view');
      this.updates.push(structuredClone(snapshot));
    },
    dispose() { this.disposed = true; }
  };
  const anchor = {
    isConnected:true,
    matches:selector => selector === '[data-testid="model-selector-trigger"]',
    getAttribute:() => null,
    closest:selector => selector === '[data-cascade-id]' ? {getAttribute:() => current.conversationId} : null,
    after(host) { assert.equal(host, view.host); },
    __reactFiber$fixture:{memoizedProps:{value:{
      cascadeContext:{state:{agentStateProvider:provider}}, selectedModel:selected
    }}, return:{memoizedProps:{value:{store}}, return:{memoizedProps:{value:registry},
      return:{memoizedProps:{services:{core:{authService:{_lsClient:client}}}}, return:null}}}}
  };
  const storage = {...stored};
  const nativeStorage = {
    getItems:async () => load ? load() : ({...storage}),
    async updateItems(changes) {
      await save?.(changes);
      calls.saved.push({...changes});
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete storage[key]; else storage[key] = value;
      }
      for (const listener of storageListeners) listener(changes);
    },
    onChanged(listener) { storageListeners.add(listener); return () => storageListeners.delete(listener); }
  };
  // The native protobuf runtime stores scalar defaults on message prototypes.
  const checkpointSchema = {kind:'message', typeName:'exa.cortex_pb.CheckpointConfig', members:[
    {fieldKind:'scalar', localName:'maxTokenLimit', default:0},
    {fieldKind:'scalar', localName:'tokenThreshold', default:0},
    {fieldKind:'scalar', localName:'enabled', default:false}
  ]};
  const cascadeSchema = {kind:'message', typeName:'exa.cortex_pb.CascadeConfig', fields:[{localName:'checkpointConfig', message:checkpointSchema}]};
  const sendSchema = {kind:'message', typeName:'exa.language_server_pb.SendUserCascadeMessageRequest', fields:[{localName:'cascadeConfig', message:cascadeSchema}]};
  function createNativeMessage(schema) {
    const defaults = {};
    for (const field of schema.members) if (field.fieldKind === 'scalar') defaults[field.localName] = field.default;
    const message = Object.create(defaults);
    message.$typeName = schema.typeName;
    return message;
  }
  const document = {defaultView:{nativeStorage, sendSchema, createNativeMessage}};
  const create = vm.runInNewContext(controllerSource, {queueMicrotask});
  const controller = create(document, (_document, _anchor, callbacks) => { actions = callbacks; return view; });
  return {
    controller, calls, view, listeners, storeListeners, childListeners, registryActive, client, storage, nativeStorage,
    mount:() => controller.discover(anchor),
    setLimit:tokens => actions.setContextLimit(tokens),
    select(value, label = String(value)) { selected.value = value; selected.label = label; controller.discover(anchor); },
    emit(next = current) { current = next; for (const listener of listeners) listener(); },
    emitChild(id, next = childStates[id]) {
      childStates[id] = next;
      for (const listener of childListeners.get(id) ?? []) listener();
    },
    setParents(next) { byParent = next; for (const listener of storeListeners) listener(); },
    snapshot:() => view.updates.at(-1)
  };
}

test('paged history counts generators once and averages the last ten completed replies', async t => {
  const records = Array.from({length:14}, (_, index) => record(index));
  records[0].metadata.value = {...records[0].metadata.value,
    usage:usage(10000, 10000, 10000), retryInfos:[{usage:usage(10, 3, 30)}]};
  records[1].metadata.value = {...records[1].metadata.value,
    usage:usage(10000, 10000, 10000), retryInfos:[{usage:usage(9999, 9999, 9999)}, {usage:usage(10, 10, 30)}]};
  const gap = deferred();
  const f = fixture(state('A', 12), {metadata:request => request.generatorMetadataOffset === 12
    ? gap.promise : {generatorMetadata:records.slice(request.generatorMetadataOffset, Math.min(12, request.generatorMetadataOffset + 4))}});
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.deepEqual(f.calls.metadata.map(call => call.generatorMetadataOffset), [0, 4, 8]);
  assert.ok(f.calls.metadata.every(call => call.includeMessages === false));
  assert.deepEqual(f.snapshot().metrics, {ttftMs:8000, tps:7.5, samples:10, inputTokens:480, outputTokens:1378, conversationTokens:1858, cacheHitRate:0.75});
  assert.equal(f.snapshot().subagentMetrics, null);

  // Step usage replaces the same generator's counters; it is not another call.
  f.emit(state('A', 12, {stepUsage:usage(20, 300, 40)})); await settle();
  assert.equal(f.snapshot().metrics.conversationTokens, 1878);
  assert.equal(f.snapshot().metrics.cacheHitRate, 370 / 500, 'output tokens do not enter the cache denominator');
  assert.equal(f.calls.metadata.length, 3);

  // Two calls arrive between provider events. Fetch the uncovered index 12,
  // rather than only the newest index 13, and coalesce repeated notifications.
  f.emit(state('A', 14)); await settle();
  f.emit(); f.emit(); await settle();
  assert.deepEqual(f.calls.metadata.map(call => call.generatorMetadataOffset), [0, 4, 8, 12]);
  gap.resolve({generatorMetadata:records.slice(12)}); await settle();
  f.emit(); await settle();
  assert.equal(f.calls.metadata.length, 4);
  assert.deepEqual(f.snapshot().metrics, {
    ttftMs:10000, tps:9.5, samples:10, inputTokens:580, outputTokens:2135, conversationTokens:2715, cacheHitRate:430 / 580
  });

  const pending = fixture(state('pending', 1), {metadata:() => ({generatorMetadata:[record(0, {
    streamingDuration:{seconds:0n, nanos:0}
  })]})});
  t.after(() => pending.controller.dispose());
  pending.mount(); await settle();
  assert.equal(pending.snapshot().metrics.samples, 0, 'An unfinished reply is not an averaging sample');
  assert.equal(pending.snapshot().metrics.ttftMs, null);
  assert.equal(pending.snapshot().metrics.tps, null);
});

test('native cumulative cost takes priority and output subdivisions are not counted twice', async t => {
  const f = fixture(state('A', 1, {costSummary:{total:{cumulativeTotal:{
    input:{tokens:100n}, cacheRead:{tokens:50n}, output:{tokens:200n},
    thinking:{tokens:80n}, response:{tokens:120n}
  }}}}), {metadata:() => ({generatorMetadata:[record(0)]})});
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.equal(f.snapshot().metrics.conversationTokens, 350);
  assert.equal(f.snapshot().metrics.inputTokens, 150);
  assert.equal(f.snapshot().metrics.outputTokens, 200);
  assert.equal(f.snapshot().metrics.cacheHitRate, 50 / 150);
});

test('recursive descendants are paged once and stay separate from their parent metrics', async t => {
  const histories = {
    A:[record(0)],
    child:Array.from({length:12}, (_, index) => record(index)),
    grandchild:[record(0, {usage:usage(20, 100, 80),
      timeToFirstToken:{seconds:0n, nanos:500000000}, streamingDuration:{seconds:1n, nanos:500000000}})]
  };
  const f = fixture(state('A', 1, {costSummary:{total:{cumulativeTotal:{
    input:{tokens:9000n}, cacheRead:{tokens:9000n}, output:{tokens:9000n}
  }}}}), {
    childStates:{child:state('child', 12), grandchild:state('grandchild', 1)},
    byParent:{A:{child:true, grandchild:true}, child:{grandchild:true}},
    metadata:request => ({generatorMetadata:histories[request.cascadeId].slice(request.generatorMetadataOffset, request.generatorMetadataOffset + 4)})
  });
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.deepEqual(f.snapshot().metrics, {
    ttftMs:1500, tps:1, samples:1, inputTokens:40, outputTokens:3, conversationTokens:43, cacheHitRate:0.75
  }, 'without a native subagent breakdown, the parent must use its own history');
  assert.deepEqual(f.snapshot().subagentMetrics, {
    count:2, ttftMs:80500 / 11, tps:125 / 11, samples:11,
    inputTokens:580, outputTokens:1478, conversationTokens:2058, cacheHitRate:440 / 580
  });
  assert.deepEqual(f.calls.subscribed.sort(), ['child', 'grandchild']);
  assert.deepEqual(f.calls.metadata.filter(call => call.cascadeId === 'child').map(call => call.generatorMetadataOffset), [0, 4, 8]);
  assert.equal(f.calls.metadata.filter(call => call.cascadeId === 'grandchild').length, 1);
  assert.ok(f.calls.metadata.every(call => call.includeMessages === false));
});

test('child provider events and new descendants refresh the aggregate without rereading completed history', async t => {
  const histories = {A:[record(0)], child:[record(0), record(1)], grandchild:[record(0, {usage:usage(5, 6, 5)})]};
  const f = fixture(state('A', 1), {
    childStates:{child:state('child', 1), grandchild:state('grandchild', 1)},
    byParent:{A:{child:true}},
    metadata:request => ({generatorMetadata:histories[request.cascadeId].slice(request.generatorMetadataOffset, request.generatorMetadataOffset + 1)})
  });
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.equal(f.snapshot().subagentMetrics.inputTokens, 40);
  f.emitChild('child', state('child', 1, {stepUsage:usage(20, 20, 60)})); await settle();
  assert.equal(f.snapshot().subagentMetrics.inputTokens, 80);
  assert.equal(f.snapshot().subagentMetrics.outputTokens, 20);
  f.emitChild('child'); f.emitChild('child'); await settle();
  assert.equal(f.calls.metadata.filter(call => call.cascadeId === 'child').length, 1);
  f.emitChild('child', state('child', 2)); await settle();
  assert.deepEqual(f.calls.metadata.filter(call => call.cascadeId === 'child').map(call => call.generatorMetadataOffset), [0, 1]);
  assert.equal(f.snapshot().subagentMetrics.outputTokens, 30);
  f.setParents({A:{child:true}, child:{grandchild:true}}); await settle();
  assert.equal(f.snapshot().subagentMetrics.count, 2);
  assert.equal(f.snapshot().subagentMetrics.inputTokens, 130);
  assert.equal(f.snapshot().subagentMetrics.outputTokens, 36);
  assert.equal(f.snapshot().subagentMetrics.cacheHitRate, 95 / 130);
  assert.equal(f.snapshot().metrics.outputTokens, 3);
});

test('native subagent totals are separated once and do not double count descendant costs', async t => {
  const f = fixture(state('A', 1, {costSummary:{total:{
    cumulativeTotal:{input:{tokens:100n}, cacheRead:{tokens:50n}, output:{tokens:200n}},
    subagent:{input:{tokens:30n}, cacheRead:{tokens:20n}, output:{tokens:80n}}
  }}}), {
    childStates:{child:state('child', 1, {costSummary:{total:{cumulativeTotal:{
      input:{tokens:9000n}, cacheRead:{tokens:9000n}, output:{tokens:9000n}
    }}}}), grandchild:state('grandchild', 1)},
    byParent:{A:{child:true}, child:{grandchild:true}},
    metadata:() => ({generatorMetadata:[record(0)]})
  });
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.deepEqual(f.snapshot().metrics, {
    ttftMs:1500, tps:1, samples:1, inputTokens:100, outputTokens:120, conversationTokens:220, cacheHitRate:0.3
  });
  assert.deepEqual(f.snapshot().subagentMetrics, {
    count:2, ttftMs:1500, tps:1, samples:2, inputTokens:50, outputTokens:80, conversationTokens:130, cacheHitRate:0.4
  });
});

test('switching conversations releases descendants and ignores late results after switching or disposal', async t => {
  const old = deferred(), current = deferred(), late = deferred();
  const f = fixture(state('A', 1), {
    childStates:{oldChild:state('oldChild', 1), newChild:state('newChild', 1)},
    byParent:{A:{oldChild:true}, B:{newChild:true}},
    metadata:request => request.cascadeId === 'oldChild' ? old.promise : request.cascadeId === 'newChild'
      ? request.generatorMetadataOffset === 0 ? current.promise : late.promise
      : {generatorMetadata:[record(0)]}
  });
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.equal(f.childListeners.get('oldChild').size, 1);
  f.emit(state('B', 1)); await settle();
  assert.equal(f.childListeners.get('oldChild').size, 0);
  assert.equal(f.registryActive.get('oldChild'), 0);
  assert.equal(f.registryActive.get('newChild'), 1);
  assert.equal(f.storeListeners.size, 1);
  old.resolve({generatorMetadata:[record(0, {usage:usage(99999, 99999, 99999)})]}); await settle();
  assert.equal(f.snapshot().subagentMetrics.count, 1);
  assert.equal(f.snapshot().subagentMetrics.inputTokens, null);
  current.resolve({generatorMetadata:[record(0, {usage:usage(1, 2, 3)})]}); await settle();
  assert.equal(f.snapshot().subagentMetrics.inputTokens, 4);
  assert.equal(f.snapshot().subagentMetrics.outputTokens, 2);
  assert.equal(f.snapshot().metrics.outputTokens, 3);
  f.emitChild('newChild', state('newChild', 2)); await settle();
  const retainedChildListener = [...f.childListeners.get('newChild')][0];
  f.controller.dispose();
  const writes = f.view.updates.length;
  assert.equal(f.listeners.size, 0);
  assert.equal(f.storeListeners.size, 0);
  assert.equal(f.childListeners.get('newChild').size, 0);
  assert.equal(f.registryActive.get('newChild'), 0);
  retainedChildListener();
  late.resolve({generatorMetadata:[record(1)]}); await settle();
  assert.equal(f.view.updates.length, writes);
});

test('a reused provider isolates old successes and failures from the next conversation', async t => {
  for (const outcome of ['resolve', 'reject']) {
    const old = deferred(), current = deferred();
    const f = fixture(state('A', 2), {metadata:request => request.cascadeId === 'A' ? old.promise : current.promise});
    t.after(() => f.controller.dispose());
    f.mount(); await settle();
    f.emit(state('B', 1)); await settle();
    assert.equal(f.snapshot().metrics.conversationTokens, null);
    if (outcome === 'resolve') old.resolve({generatorMetadata:[record(0, {usage:usage(99999, 99999, 99999)})]});
    else old.reject(new Error('old conversation request failed'));
    await settle();
    assert.deepEqual(f.calls.metadata.map(call => [call.cascadeId, call.generatorMetadataOffset]), [['A', 0], ['B', 0]]);
    assert.equal(f.snapshot().metrics.conversationTokens, null);
    assert.equal(f.snapshot().snapshotLabel, '等待本次调用数据', `old ${outcome} must not change the new conversation's status`);
    current.resolve({generatorMetadata:[record(0, {
      usage:usage(1, 2, 3), timeToFirstToken:{seconds:0n, nanos:250000000}, streamingDuration:{seconds:1n, nanos:0}
    })]});
    await settle();
    assert.deepEqual(f.snapshot().metrics, {ttftMs:250, tps:1.6, samples:1, inputTokens:4, outputTokens:2, conversationTokens:6, cacheHitRate:0.75});
    f.controller.dispose();
  }
});

test('dispose unsubscribes and suppresses queued and late async view writes', async () => {
  const metadata = deferred(), catalog = deferred(), config = deferred();
  const f = fixture(state('A', 1), {metadata:() => metadata.promise, catalog:() => catalog.promise, config:() => config.promise});
  f.mount(); await settle();
  const retainedListener = [...f.listeners][0];
  f.emit();
  f.controller.dispose();
  const writes = f.view.updates.length;
  assert.equal(f.listeners.size, 0);
  assert.equal(f.view.disposed, true);
  retainedListener();
  metadata.resolve({generatorMetadata:[record(0)]});
  catalog.resolve({models:{}}); config.resolve({cascadeConfig:{}});
  await settle();
  assert.equal(f.view.updates.length, writes);
  assert.equal(f.calls.metadata.length, 1);
  assert.equal(f.controller.size, 0);
});

test('context limit changes both send paths while preserving requests and actual history', async t => {
  let actualBudget = 256000;
  const f = fixture(state('A', 1), {metadata:request => ({generatorMetadata:[record(request.generatorMetadataOffset, {
    chatStartMetadata:{contextWindowMetadata:{maxContextTokens:actualBudget}}
  })]})});
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  await f.setLimit(500000); await settle();
  assert.equal(f.snapshot().contextSetting.customLimit, 500000);
  assert.equal(f.snapshot().contextSetting.effectiveLimit, 500000);
  assert.equal(f.snapshot().maxContext, 256000, 'saving a future budget must not rewrite the last model call');
  const request = {cascadeId:'A', cascadeConfig:{
    plannerConfig:{planModel:model, maxOutputTokens:65536},
    checkpointConfig:{enabled:true, tokenThreshold:50000},
    unrelated:'keep'
  }, items:[{text:'unchanged'}]};
  const requestPrototype = {nativeRequestDefault:0}, cascadePrototype = {nativeCascadeDefault:0}, checkpointPrototype = {nativeCheckpointDefault:0};
  Object.setPrototypeOf(request, requestPrototype);
  Object.setPrototypeOf(request.cascadeConfig, cascadePrototype);
  Object.setPrototypeOf(request.cascadeConfig.checkpointConfig, checkpointPrototype);
  const before = structuredClone(request), options = {signal:'sentinel'};
  assert.equal(await f.client.sendUserCascadeMessage(request, options), 'message-result');
  assert.equal(await f.client.sendAllQueuedMessages(request, options), 'queued-result');
  assert.deepEqual(structuredClone(request), before);
  for (const call of f.calls.sent) {
    assert.equal(call.receiver, f.client);
    assert.equal(call.options, options);
    assert.equal(call.request.items, request.items);
    assert.equal(call.request.cascadeConfig.plannerConfig, request.cascadeConfig.plannerConfig);
    assert.equal(call.request.cascadeConfig.checkpointConfig.maxTokenLimit, 500000);
    assert.equal(call.request.cascadeConfig.checkpointConfig.tokenThreshold, 50000);
    assert.equal(call.request.cascadeConfig.unrelated, 'keep');
    assert.equal(Object.getPrototypeOf(call.request), requestPrototype);
    assert.equal(Object.getPrototypeOf(call.request.cascadeConfig), cascadePrototype);
    assert.equal(Object.getPrototypeOf(call.request.cascadeConfig.checkpointConfig), checkpointPrototype);
  }
  assert.ok(f.calls.saved.length > 0);
  actualBudget = 500000;
  f.emit(state('A', 2)); await settle();
  assert.equal(f.snapshot().maxContext, 500000);
  assert.equal(f.snapshot().compactionReference, 500000, 'a real expanded call must not show the old default checkpoint budget');
});

test('context preferences survive reload, stay model-specific, and restore cleanly', async t => {
  const f = fixture(state('A', 0));
  const original = f.client.sendUserCascadeMessage, originalQueued = f.client.sendAllQueuedMessages;
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  const request = {cascadeId:'A', cascadeConfig:{plannerConfig:{planModel:model}}};
  await f.client.sendUserCascadeMessage(request);
  assert.equal(f.calls.sent.at(-1).request, request, 'no override means the original request passes through');
  await f.setLimit(500000); await settle();
  const other = {cascadeId:'other', cascadeConfig:{plannerConfig:{planModel:1402}}};
  await f.client.sendUserCascadeMessage(other);
  assert.equal(f.calls.sent.at(-1).request, other, 'a Gemini preference must not lower a different model');

  const loaded = fixture(state('B', 0), {stored:f.storage});
  t.after(() => loaded.controller.dispose());
  loaded.mount(); await settle();
  assert.equal(loaded.snapshot().contextSetting.customLimit, 500000);
  await loaded.client.sendUserCascadeMessage({...request, cascadeId:'B'});
  assert.equal(loaded.calls.sent.at(-1).request.cascadeConfig.checkpointConfig.maxTokenLimit, 500000);
  assert.equal(loaded.calls.sent.at(-1).request.cascadeConfig.checkpointConfig.$typeName, 'exa.cortex_pb.CheckpointConfig');
  assert.equal(loaded.calls.sent.at(-1).request.cascadeConfig.checkpointConfig.tokenThreshold, 0, 'new checkpoint messages retain native scalar defaults');

  await f.setLimit(null); await settle();
  assert.equal(f.snapshot().contextSetting.customLimit, null);
  assert.equal(f.snapshot().contextSetting.effectiveLimit, 256000);
  await f.client.sendUserCascadeMessage(request);
  assert.equal(f.calls.sent.at(-1).request, request);
  assert.equal(Object.keys(f.storage).length, 0);
  f.controller.dispose();
  assert.equal(f.client.sendUserCascadeMessage, original);
  assert.equal(f.client.sendAllQueuedMessages, originalQueued);
});

test('the first send waits for persisted context preferences to finish loading', async t => {
  const seed = fixture(state('seed', 0));
  seed.mount(); await settle();
  await seed.setLimit(500000); await settle();
  const saved = {...seed.storage};
  seed.controller.dispose();
  const loaded = deferred();
  const f = fixture(state('A', 0), {load:() => loaded.promise});
  t.after(() => f.controller.dispose());
  f.mount();
  const sent = f.client.sendUserCascadeMessage({cascadeId:'A', cascadeConfig:{plannerConfig:{planModel:model}}});
  await settle();
  assert.equal(f.calls.sent.length, 0);
  loaded.resolve(saved);
  await sent; await settle();
  assert.equal(f.calls.sent[0].request.cascadeConfig.checkpointConfig.maxTokenLimit, 500000);
});

test('context limit reports the backend clamp instead of inventing model capacity', async t => {
  const f = fixture(state('A', 0), {
    catalog:() => ({models:{small:{model, maxTokens:131072, maxOutputTokens:32768, displayName:'Small Fixture'}}}),
    config:request => ({cascadeConfig:{
      checkpointConfig:{enabled:true, maxTokenLimit:Math.min(request?.overrideConfig?.checkpointConfig?.maxTokenLimit ?? 80000, 98304)},
      plannerConfig:{maxOutputTokens:32768}
    }})
  });
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  await f.setLimit(500000); await settle();
  assert.equal(f.snapshot().contextSetting.effectiveLimit, 98304);
  assert.equal(f.snapshot().modelCapacity, 131072);
  assert.equal(f.snapshot().contextSetting.maxLimit, 98304);
});

test('failed context configuration or persistence leaves the previous sending budget intact', async t => {
  for (const failure of ['resolve', 'save']) {
    let fail = false;
    const f = fixture(state('A', 0), {
      config:request => {
        if (fail && failure === 'resolve' && request?.overrideConfig?.checkpointConfig) throw new Error('config unavailable');
        return {cascadeConfig:{checkpointConfig:{enabled:true, maxTokenLimit:request?.overrideConfig?.checkpointConfig?.maxTokenLimit ?? 256000}, plannerConfig:{maxOutputTokens:65536}}};
      },
      save:() => { if (fail && failure === 'save') throw new Error('disk unavailable'); }
    });
    t.after(() => f.controller.dispose());
    f.mount(); await settle();
    await f.setLimit(400000); await settle();
    fail = true;
    await f.setLimit(500000).catch(() => {}); await settle();
    assert.equal(f.snapshot().contextSetting.customLimit, 400000);
    assert.ok(f.snapshot().contextSetting.error, 'the editing card must explain a failed apply');
    await f.client.sendUserCascadeMessage({cascadeId:'A', cascadeConfig:{plannerConfig:{planModel:model}}});
    assert.equal(f.calls.sent.at(-1).request.cascadeConfig.checkpointConfig.maxTokenLimit, 400000);
  }
});

test('a late context query cannot apply a previous model preference to the newly selected model', async t => {
  const pending = deferred();
  const f = fixture(state('A', 0), {config:request => {
    if (request?.overrideConfig?.checkpointConfig?.maxTokenLimit === 500000) return pending.promise;
    return {cascadeConfig:{checkpointConfig:{enabled:true, maxTokenLimit:256000}, plannerConfig:{maxOutputTokens:65536}}};
  }});
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  const applying = f.setLimit(500000);
  await settle();
  f.select(1402, 'Claude Fixture'); await settle();
  pending.resolve({cascadeConfig:{checkpointConfig:{enabled:true, maxTokenLimit:500000}, plannerConfig:{maxOutputTokens:65536}}});
  await applying; await settle();
  assert.equal(f.snapshot().contextSetting.modelKey, '1402');
  assert.equal(f.snapshot().contextSetting.customLimit, null);
  const request = {cascadeId:'A', cascadeConfig:{plannerConfig:{planModel:1402}}};
  await f.client.sendUserCascadeMessage(request);
  assert.equal(f.calls.sent.at(-1).request, request);
});
