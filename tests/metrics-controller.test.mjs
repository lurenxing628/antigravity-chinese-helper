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
  let viewId = initial?.conversationId;
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
  const createView = () => ({
    host:{}, updates:[], disposed:false,
    update(snapshot) {
      assert.equal(this.disposed, false, 'a late callback must not write to a disposed view');
      this.updates.push(structuredClone(snapshot));
    },
    dispose() { this.disposed = true; }
  });
  let view = createView();
  let anchor = {
    isConnected:true,
    matches:selector => selector === '[data-testid="model-selector-trigger"]',
    getAttribute:() => null,
    closest:selector => selector === '[data-cascade-id]' ? {getAttribute:() => viewId} : null,
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
  const controller = create(document, (_document, _anchor, callbacks) => {
    actions = callbacks;
    if (view.disposed) view = createView();
    return view;
  });
  return {
    controller, calls, get view() { return view; }, listeners, storeListeners, childListeners, registryActive, client, storage, nativeStorage,
    mount:() => controller.discover(anchor),
    remount() { anchor.isConnected = false; controller.cleanup(); anchor = {...anchor,isConnected:true}; controller.discover(anchor); },
    rebindProvider() {
      anchor.__reactFiber$fixture.memoizedProps.value.cascadeContext.state.agentStateProvider = {...provider};
      controller.discover(anchor);
    },
    useClient(value) {
      anchor.__reactFiber$fixture.return.return.return.memoizedProps.services.core.authService._lsClient = value;
      controller.discover(anchor);
    },
    setLimit:tokens => actions.setContextLimit(tokens),
    select(value, label = String(value)) { selected.value = value; selected.label = label; controller.discover(anchor); },
    emit(next = current, id = next.conversationId ?? viewId) { current = next; viewId = id; for (const listener of listeners) listener(); },
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

  // Two calls arrive between provider events. Refresh the previous tail at 11,
  // cover both new calls, and coalesce repeated notifications.
  f.emit(state('A', 14)); await settle();
  f.emit(); f.emit(); await settle();
  assert.deepEqual(f.calls.metadata.map(call => call.generatorMetadataOffset), [0, 4, 8, 11, 12]);
  gap.resolve({generatorMetadata:records.slice(12)}); await settle();
  f.emit(); await settle();
  assert.equal(f.calls.metadata.length, 5);
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

test('a new generator refreshes the previous unfinished tail before adding its own output', async t => {
  const history = [record(0, {usage:usage(10, 1, 30), streamingDuration:{seconds:0n, nanos:0}})];
  const f = fixture(state('A', 1), {
    metadata:request => ({generatorMetadata:history.slice(request.generatorMetadataOffset)})
  });
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.equal(f.snapshot().metrics.outputTokens, 1);
  assert.equal(f.snapshot().metrics.samples, 0);
  history[0] = record(0, {usage:usage(10, 1000, 30), streamingDuration:{seconds:3n, nanos:0}});
  history.push(record(1, {usage:usage(10, 20, 30)}));
  f.emit(state('A', 2)); await settle();
  assert.deepEqual(f.calls.metadata.map(call => call.generatorMetadataOffset), [0, 0]);
  assert.equal(f.snapshot().metrics.outputTokens, 1020);
  assert.equal(f.snapshot().metrics.inputTokens, 80);
  assert.equal(f.snapshot().metrics.samples, 2);
  assert.equal(f.snapshot().metrics.tps, (1000 * 1000 / 4500 + 4) / 2);
  f.emit(); await settle();
  assert.equal(f.calls.metadata.length, 2);
});

test('an expanded child step list applies usage immediately and stale metadata cannot replace it', async t => {
  const history = [record(0, {usage:usage(10, 1, 30)})];
  const f = fixture(state('A', 0), {
    childStates:{child:state('child', 1)}, byParent:{A:{child:true}},
    metadata:request => ({generatorMetadata:history.slice(request.generatorMetadataOffset)})
  });
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  const expanded = state('child', 1, {stepUsage:usage(20, 500, 60)});
  expanded.trajectorySlice.generatorMetadatasInSlice[0].stepIndices = [0, 1];
  expanded.trajectorySlice.stepsSlice.startIndex = 1;
  expanded.trajectorySlice.totalStepsLength = 2;
  f.emitChild('child', expanded); await settle();
  assert.equal(f.snapshot().subagentMetrics.outputTokens, 500, 'the first event must use the newly associated step');
  assert.equal(f.snapshot().subagentMetrics.tps, 500 * 1000 / 3000);
  assert.equal(f.calls.metadata.length, 1, 'step usage is already available without another request');
  history.push({...record(1, {usage:usage(10, 20, 30)}), stepIndices:[2]});
  const next = state('child', 2);
  next.trajectorySlice.generatorMetadatasInSlice[0].stepIndices = [2];
  next.trajectorySlice.stepsSlice.startIndex = 2;
  next.trajectorySlice.totalStepsLength = 3;
  f.emitChild('child', next); await settle();
  assert.deepEqual(f.calls.metadata.map(call => call.generatorMetadataOffset), [0, 0]);
  assert.equal(f.snapshot().subagentMetrics.outputTokens, 520, 'the old metadata snapshot must not undo the step counters');
  assert.equal(f.snapshot().subagentMetrics.inputTokens, 120);
  assert.equal(f.snapshot().subagentMetrics.tps, (500 * 1000 / 3000 + 4) / 2);
});

test('completion during an in-flight start read queues final usage and timing while the agent remains active', async t => {
  const starting = deferred();
  let requests = 0;
  const f = fixture(state('A', 1), {metadata:() => ++requests === 1 ? starting.promise : {
    generatorMetadata:[record(0, {usage:usage(20, 1000, 60),
      timeToFirstToken:{seconds:1n, nanos:0}, streamingDuration:{seconds:4n, nanos:0}})]
  }});
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  const completed = state('A', 1, {stepUsage:usage(20, 1000, 60)});
  completed.trajectorySlice.stepsInSlice[0].metadata.finishedGeneratingAt = {seconds:1n, nanos:0};
  f.emit(completed); await settle();
  assert.equal(f.calls.metadata.length, 1);
  starting.resolve({generatorMetadata:[record(0, {usage:usage(10, 1, 30), streamingDuration:{seconds:0n, nanos:0}})]});
  await settle();
  assert.deepEqual(f.calls.metadata.map(call => call.generatorMetadataOffset), [0, 0]);
  assert.equal(f.snapshot().metrics.outputTokens, 1000);
  assert.equal(f.snapshot().metrics.tps, 200);
  assert.equal(f.snapshot().metrics.samples, 1);
  f.emit({...completed, fullyIdle:true}); await settle();
  assert.equal(f.calls.metadata.length, 2, 'the later idle event must not fetch the same completed call again');
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
  const zero = fixture(state('zero',1,{costSummary:{total:{cumulativeTotal:{input:{tokens:0n}}}}}),
    {metadata:() => ({generatorMetadata:[record(0)]})});
  t.after(() => zero.controller.dispose());
  zero.mount(); await settle();
  assert.equal(zero.snapshot().metrics.conversationTokens,0,'an explicit zero cost partition remains authoritative');
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

test('child provider events and new descendants refresh the aggregate without rereading the full history', async t => {
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
  assert.deepEqual(f.calls.metadata.filter(call => call.cascadeId === 'child').map(call => call.generatorMetadataOffset), [0, 0, 1]);
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

test('returning to a cached conversation restores complete metrics and refreshes its unfinished tail', async t => {
  const history = [record(0),record(1),record(2)];
  const refresh = deferred();
  let revisiting = false;
  const f = fixture(state('A',3), {metadata:request => request.cascadeId === 'B'
    ? {generatorMetadata:[record(0)]} : revisiting ? refresh.promise
      : {generatorMetadata:history.slice(request.generatorMetadataOffset)}});
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  f.emit(state('A',3,{stepUsage:usage(20,300,40)})); await settle();
  const before = f.snapshot().metrics;
  assert.equal(before.outputTokens,313);
  f.emit(state('B',1)); await settle();
  history[2] = record(2,{usage:usage(20,1000,40)});
  history.push(record(3,{usage:usage(10,20,30)}));
  revisiting = true;
  f.emit(state('A',4,{costSummary:{total:{cumulativeTotal:{}}}})); await settle();
  assert.deepEqual(f.calls.metadata.map(call => [call.cascadeId,call.generatorMetadataOffset]),[['A',0],['B',0],['A',2]]);
  assert.deepEqual(f.snapshot().metrics,before,'an incomplete refresh cannot replace the complete snapshot with native default zeroes');
  refresh.resolve({generatorMetadata:history.slice(2)}); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,1033,'a cached fromStep flag cannot hide the final usage of the previous tail');
  assert.equal(f.snapshot().metrics.samples,4);
});

test('numeric history survives view replacement and provider rebinding while backend clients stay isolated', async t => {
  const history = [record(0),record(1),record(2)], tails = [deferred(),deferred()];
  const pending = [...tails];
  const f = fixture(state('A',3), {metadata:request => request.generatorMetadataOffset === 0
    ? {generatorMetadata:history} : pending.shift()?.promise ?? {generatorMetadata:history.slice(2)}});
  const other = fixture(state('A',3), {metadata:() => ({generatorMetadata:history.map((value,index) => record(index,{usage:usage(100,900,200)}))})});
  t.after(() => { f.controller.dispose(); other.controller.dispose(); });
  f.mount(); await settle();
  const metrics = f.snapshot().metrics, oldView = f.view;
  f.remount(); await settle();
  assert.equal(oldView.disposed,true);
  assert.notEqual(f.view,oldView);
  assert.equal(f.listeners.size,1,'only the replacement view owns a subscription');
  assert.deepEqual(f.snapshot().metrics,metrics);
  tails[0].resolve({generatorMetadata:history.slice(2)}); await settle();
  f.rebindProvider(); await settle();
  assert.deepEqual(f.snapshot().metrics,metrics);
  assert.equal(f.listeners.size,1);
  tails[1].resolve({generatorMetadata:history.slice(2)}); await settle();
  f.useClient(other.client); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,2700);
  assert.deepEqual(other.calls.metadata.map(call => call.generatorMetadataOffset),[0]);
  f.useClient(f.client);
  assert.deepEqual(f.snapshot().metrics,metrics,'restoring the first backend does not borrow the second backend statistics');
  await settle();
  assert.deepEqual(f.calls.metadata.map(call => call.generatorMetadataOffset),[0,2,2,2]);
});

test('unknown provider snapshots retain the DOM target cache while loaded rollback and trajectory replacement invalidate it', async t => {
  const unknown = fixture({conversationId:'unknown'});
  t.after(() => unknown.controller.dispose());
  unknown.mount(); await settle();
  assert.equal(unknown.snapshot().metrics.inputTokens,null);
  assert.equal(unknown.snapshot().metrics.outputTokens,null);
  unknown.emit(state('unknown',0)); await settle();
  assert.equal(unknown.snapshot().metrics.inputTokens,0,'a loaded empty trajectory is a real zero');

  const rolledBack = deferred(), replaced = deferred();
  let phase = 'initial';
  const withTrajectory=(id,generation,trajectoryId)=>{
    const value=state(id,generation); value.trajectorySlice.trajectoryId=trajectoryId; return value;
  };
  const f = fixture(withTrajectory('A',2,'trajectory-A'), {metadata:request => request.cascadeId === 'B'
    ? {generatorMetadata:[record(0)]} : phase === 'initial' ? {generatorMetadata:[record(0),record(1)]}
      : phase === 'rollback' ? rolledBack.promise : replaced.promise});
  t.after(() => f.controller.dispose());
  f.mount(); await settle(); const a = f.snapshot().metrics;
  f.emit(withTrajectory('B',1,'trajectory-B')); await settle(); const b = f.snapshot().metrics;
  f.emit({conversationId:'A'}); await settle();
  assert.deepEqual(f.snapshot().metrics,a);
  f.emit({},'B'); await settle();
  assert.deepEqual(f.snapshot().metrics,b,'a temporarily missing provider ID uses the target DOM conversation');
  f.emit(withTrajectory('A',2,'trajectory-A'),'B'); await settle();
  assert.deepEqual(f.snapshot().metrics,b,'the old provider cannot contribute statistics to the new DOM target');
  phase='rollback'; f.emit(withTrajectory('A',1,'trajectory-A')); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,null);
  rolledBack.resolve({generatorMetadata:[record(0,{usage:usage(1,2,3)})]}); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,2);
  phase='replacement'; f.emit(withTrajectory('A',1,'trajectory-A-new')); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,null);
  replaced.resolve({generatorMetadata:[record(0,{usage:usage(5,6,7)})]}); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,6);
  assert.deepEqual(f.calls.metadata.filter(call => call.cascadeId === 'A').map(call => call.generatorMetadataOffset),[0,0,0]);
});

test('child hydration publishes complete aggregates and restores child cursors on return', async t => {
  const histories = {one:[record(0),record(1),record(2)],two:[record(0),record(1),record(2)]};
  const first = {one:deferred(),two:deferred()}, refresh = {one:deferred(),two:deferred()};
  let revisiting = false;
  const f = fixture(state('A',0), {childStates:{one:state('one',3),two:state('two',3)},byParent:{A:{one:true,two:true}},
    metadata:request => (revisiting ? refresh : first)[request.cascadeId].promise});
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  first.one.resolve({generatorMetadata:histories.one}); await settle();
  assert.equal(f.snapshot().subagentMetrics.ttftMs,null);
  assert.equal(f.snapshot().subagentMetrics.tps,null);
  assert.equal(f.snapshot().subagentMetrics.samples,0);
  first.two.resolve({generatorMetadata:histories.two}); await settle();
  const complete = f.snapshot().subagentMetrics;
  assert.equal(complete.outputTokens,68);
  f.emit(state('B',0)); await settle();
  assert.equal(f.registryActive.get('one'),0);
  assert.equal(f.registryActive.get('two'),0);
  for (const id of ['one','two']) {
    histories[id].push(record(3)); f.emitChild(id,state(id,4));
  }
  revisiting = true;
  f.emit(state('A',0,{costSummary:{total:{subagent:{}}}})); await settle();
  assert.deepEqual(f.snapshot().subagentMetrics,complete);
  assert.deepEqual(f.calls.metadata.map(call => [call.cascadeId,call.generatorMetadataOffset]),[['one',0],['two',0],['one',2],['two',2]]);
  refresh.one.resolve({generatorMetadata:histories.one.slice(2)}); await settle();
  assert.deepEqual(f.snapshot().subagentMetrics,complete,'one completed child cannot publish a partial aggregate average');
  refresh.two.resolve({generatorMetadata:histories.two.slice(2)}); await settle();
  assert.equal(f.snapshot().subagentMetrics.outputTokens,140);
  assert.equal(f.snapshot().subagentMetrics.samples,8);
  assert.equal(f.snapshot().subagentMetrics.tps,2.5);
});

test('a late response from the previous attachment cannot overwrite a returned conversation cache', async t => {
  const old = deferred(), current = deferred(), tail = deferred();
  let reads = 0;
  const f = fixture(state('A',2), {metadata:request => request.cascadeId === 'B'
    ? {generatorMetadata:[record(0)]} : [old,current,tail][reads++].promise});
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  f.emit(state('B',1)); await settle();
  f.emit(state('A',2)); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,null);
  const records = [record(0,{usage:usage(1,2,3)}),record(1,{usage:usage(4,5,6)})];
  current.resolve({generatorMetadata:records}); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,7);
  old.resolve({generatorMetadata:[record(0,{usage:usage(99999,99999,99999)})]}); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,7);
  f.emit(state('B',1)); await settle();
  f.emit(state('A',2)); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,7,'the passive cache also retains the current attachment result');
  assert.deepEqual(f.calls.metadata.filter(call => call.cascadeId === 'A').map(call => call.generatorMetadataOffset),[0,0,1]);
  tail.resolve({generatorMetadata:records.slice(1)}); await settle();
  assert.equal(f.snapshot().metrics.outputTokens,7);
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

test('new servers read catalog checkpoint budgets and retain both send overrides without the removed resolver', async t => {
  const f = fixture(state('A', 1), {
    stored:{'antigravityChineseHelper.contextLimit.1417':'500000'},
    metadata:() => ({generatorMetadata:[record(0, {chatStartMetadata:{contextWindowMetadata:{maxContextTokens:400000}}})]}),
    catalog:() => ({models:{fixture:{model, maxTokens:1048576, maxOutputTokens:65536, displayName:'Gemini Fixture',
      modelExperiments:{experiments:{CASCADE_USE_EXPERIMENT_CHECKPOINTER:{value:{case:'stringValue', value:JSON.stringify({
        enabled:true, max_token_limit:'256000', use_model_reported_token_count:false, session_summary_prompt_override:'not retained'
      })}}}}
    }}})
  });
  delete f.client.getResolvedCascadeConfig;
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.equal(f.snapshot().contextSetting.error, null);
  assert.equal(f.snapshot().contextSetting.defaultLimit, 256000);
  assert.equal(f.snapshot().contextSetting.customLimit, 500000);
  assert.equal(f.snapshot().contextSetting.effectiveLimit, 500000);
  assert.equal(f.snapshot().contextSetting.maxLimit, 1032192, 'native defaults reserve 16384 output tokens rather than the catalog output ceiling');
  assert.equal(f.snapshot().outputReserve, 16384);
  assert.equal(f.snapshot().compactionBasisLabel, '后端估算');
  assert.equal(f.snapshot().compactionReference, 400000, 'the actual call budget takes priority over the catalog default and future preference');
  assert.equal(await f.setLimit(600000), true);
  assert.equal(f.snapshot().maxContext, 400000);
  assert.equal(f.snapshot().compactionReference, 400000, 'editing a future budget must not rewrite the actual call');
  const request = {cascadeId:'A', cascadeConfig:{plannerConfig:{planModel:model}}};
  await f.client.sendUserCascadeMessage(request);
  await f.client.sendAllQueuedMessages(request);
  assert.ok(f.calls.sent.every(call => call.request.cascadeConfig.checkpointConfig.maxTokenLimit === 600000));
  assert.equal(f.calls.config, 0);
  assert.equal(await f.setLimit(2000000), true);
  assert.equal(f.snapshot().contextSetting.effectiveLimit, 1032192);
  assert.equal(await f.setLimit(null), true);
  assert.equal(f.snapshot().contextSetting.effectiveLimit, 256000);
  await f.client.sendUserCascadeMessage(request);
  assert.equal(f.calls.sent.at(-1).request, request);
});

test('an unknown backend default does not prevent removing a saved context override', async t => {
  const f = fixture(state('A', 0), {stored:{'antigravityChineseHelper.contextLimit.1417':'500000'}});
  delete f.client.getResolvedCascadeConfig;
  t.after(() => f.controller.dispose());
  f.mount(); await settle();
  assert.equal(f.snapshot().contextSetting.defaultLimit, null);
  assert.equal(f.snapshot().contextSetting.error, null);
  assert.equal(f.snapshot().contextSetting.customLimit, 500000);
  assert.equal(f.snapshot().compactionBasisLabel, null, 'an absent checkpoint experiment does not establish a token-count source');
  assert.equal(await f.setLimit(null), true);
  assert.equal(f.snapshot().contextSetting.customLimit, null);
  assert.equal(Object.keys(f.storage).length, 0);
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
