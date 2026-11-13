import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setImmediate as nextTurn} from 'node:timers/promises';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../../runtime/renderer.js', import.meta.url), 'utf8');
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

function fixture(initial, {metadata = () => ({generatorMetadata:[]}), catalog, config, stored = {}, save, load, windowGlobals = {}, client: suppliedClient,
  childStates = {}, byParent = {}, summaries = {}} = {}) {
  let current = initial;
  let viewId = initial?.conversationId;
  const listeners = new Set();
  const storageListeners = new Set();
  const storeListeners = new Set();
  const childListeners = new Map(), childProviders = new Map(), registryActive = new Map();
  const calls = {metadata:[], catalog:0, catalogRequests:[], config:0, resolved:[], sent:[], saved:[], subscribed:[], unsubscribed:[]};
  const selected = {value:model, label:'Gemini Fixture'};
  let actions;
  const provider = {
    getState:() => current,
    onDidChange(listener) { listeners.add(listener); return {dispose:() => listeners.delete(listener)}; }
  };
  const store = {
    getState:() => ({trajectorySummaries:{summaries,indexes:{byParent}}}),
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
  const client = suppliedClient ?? {
    getAvailableModels(request) {
      calls.catalog++;
      calls.catalogRequests.push({...request});
      return catalog ? catalog(request) : Promise.resolve({models:{
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
  const document = {defaultView:{...windowGlobals, nativeStorage, sendSchema, createNativeMessage}};
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
    setSummary(id, summary) { summaries = {...summaries,[id]:summary}; for (const listener of storeListeners) listener(); },
    snapshot:() => view.updates.at(-1)
  };
}

export {fixture, model, settle, deferred, usage, record, state};
