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

function fixture(initial, {metadata, catalog, config} = {}) {
  let current = initial;
  const listeners = new Set();
  const calls = {metadata:[], catalog:0, config:0};
  const provider = {
    getState:() => current,
    onDidChange(listener) { listeners.add(listener); return {dispose:() => listeners.delete(listener)}; }
  };
  const client = {
    getAvailableModels() {
      calls.catalog++;
      return catalog ? catalog() : Promise.resolve({models:{fixture:{model, maxTokens:1048576, maxOutputTokens:65536, displayName:'Gemini Fixture'}}});
    },
    getResolvedCascadeConfig() {
      calls.config++;
      return config ? config() : Promise.resolve({cascadeConfig:{
        checkpointConfig:{enabled:true, maxTokenLimit:256000}, plannerConfig:{maxOutputTokens:65536}
      }});
    },
    getCascadeTrajectoryGeneratorMetadata(request) {
      calls.metadata.push({...request});
      return metadata(request);
    }
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
      cascadeContext:{state:{agentStateProvider:provider}}, selectedModel:{value:model, label:'Gemini Fixture'}
    }}, return:{memoizedProps:{services:{core:{authService:{_lsClient:client}}}}, return:null}}
  };
  const document = {defaultView:{}};
  const create = vm.runInNewContext(controllerSource, {queueMicrotask});
  const controller = create(document, () => view);
  return {
    controller, calls, view, listeners,
    mount:() => controller.discover(anchor),
    emit(next = current) { current = next; for (const listener of listeners) listener(); },
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
  assert.deepEqual(f.snapshot().metrics, {ttftMs:8000, tps:15, samples:10, conversationTokens:1858, cacheHitRate:0.75});

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
    ttftMs:10000, tps:19, samples:10, conversationTokens:2715, cacheHitRate:430 / 580
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
  assert.equal(f.snapshot().metrics.cacheHitRate, 50 / 150);
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
    assert.deepEqual(f.snapshot().metrics, {ttftMs:250, tps:2, samples:1, conversationTokens:6, cacheHitRate:0.75});
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
