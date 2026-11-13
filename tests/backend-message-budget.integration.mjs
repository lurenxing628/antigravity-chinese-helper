// Actual message-consumption budgets on one private backend and a local model.
// node tests/backend-message-budget.integration.mjs [path/to/language_server]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createBackendRuntime, prepareBackendCopy } from '../runtime/backend-runtime.mjs';
import { fixture, settle, state } from './helpers/metrics-fixture.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Mach integration requires macOS arm64');
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'agh-message-budget-')));
const officialBackendPath = resolve(process.argv[2] ?? '/Applications/Antigravity.app/Contents/Resources/bin/language_server');
const machExecutablePath = join(directory, 'backend-mach');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [], cases = [];
let child, runtime, ui, port, startupError, mockError, backendLog = '', latest;

// Only the local fixture sees model requests. Never log their prompts or tools.
const mock = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const data = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
    if (request.url.includes('streamGenerateContent')) {
      requests.push({ index:requests.length, response, data });
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  } catch (error) {
    mockError = error;
    response.statusCode = 500;
    response.end();
  }
});

async function rpc(method, body = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`, {
    method:'POST', headers:{'Content-Type':'application/json', 'X-Codeium-Csrf-Token':'isolated-message-budget'},
    // Native protobuf metadata is not a wire field. Budget values are untouched.
    body:JSON.stringify(body, (key, value) => key === '$typeName' ? undefined : value), signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  return response.json();
}

const message = (cascadeId, deliveryStrategy, text) => ({
  cascadeId, items:[{text}], cascadeConfig:{plannerConfig:{planModel:326}, executorConfig:{useCoreDirect:true}}, deliveryStrategy,
});
const send = (...args) => ui.client.sendUserCascadeMessage(message(...args));
const hasMarker = (request, marker) => JSON.stringify(request.data.request.contents).includes(marker);

async function waitRequest(index) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (mockError) throw mockError;
    if (requests[index]) return requests[index];
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private backend exited before its model request');
    await delay(50);
  }
  throw new Error(`Local model request ${index} did not arrive`);
}

function finish(request, parts = [{text:'AGH local mock reply.'}]) {
  request.response.setHeader('Content-Type', 'text/event-stream');
  request.response.end(`data: ${JSON.stringify({
    response:{candidates:[{content:{role:'model', parts}, finishReason:'STOP', index:0}],
      usageMetadata:{promptTokenCount:20, candidatesTokenCount:5, totalTokenCount:25}},
    traceId:`agh-message-budget-${request.index}`,
  })}\n\n`);
}

function continueThroughTaskList(request, tag) {
  const tool = (request.data.request.tools ?? []).flatMap(tool => tool.functionDeclarations ?? [])
    .find(tool => tool.name === 'manage_task');
  assert(tool, 'Official manage_task tool is required to reach the next planner invocation');
  finish(request, [{functionCall:{name:tool.name, args:{Action:'list'}, id:`agh-local-list-${tag}`}}]);
}

// Keep diagnostics to execution identity, budget, and our own marker booleans.
function compact(trajectory) {
  const steps = trajectory.trajectory.steps;
  return {
    status:trajectory.status,
    users:steps.filter(step => step.type === 'CORTEX_STEP_TYPE_USER_INPUT').map(step => ({
      executionId:step.metadata.executionId, limit:step.userInput.userConfig?.checkpointConfig?.maxTokenLimit ?? null,
    })),
    generators:(trajectory.trajectory.generatorMetadata ?? []).map(generator => ({
      executionId:generator.executionId, stepIndices:generator.stepIndices,
      limit:generator.chatModel?.chatStartMetadata?.contextWindowMetadata?.maxContextTokens,
      model:generator.chatModel?.model,
    })),
    completedTool:steps.some(step => step.type === 'CORTEX_STEP_TYPE_GENERIC' && step.status === 'CORTEX_STEP_STATUS_DONE'),
  };
}

async function snapshot(cascadeId, stage) {
  const trajectory = await rpc('GetCascadeTrajectory', {cascadeId});
  latest = {stage, cascadeId, ...compact(trajectory)};
  return latest;
}

async function waitIdle(cascadeId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await snapshot(cascadeId, 'waiting-for-idle');
    if (state.status === 'CASCADE_RUN_STATUS_IDLE') return state;
    await delay(50);
  }
  throw new Error('Private cascade did not become idle');
}

try {
  await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    join(root, 'runtime/backend-mach.c'), '-o', machExecutablePath], {timeout:30000});
  await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', machExecutablePath], {timeout:30000});
  const prepared = await prepareBackendCopy({officialBackendPath, stateDir:directory});
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${mock.address().port}`;
  child = spawn(prepared.binaryPath, [
    '--standalone', '--headless', '--disable_telemetry', `--gemini_dir=${join(directory, 'data')}`,
    '--config_dir=isolated-config', '--http_server_port=0', '--csrf_token=isolated-message-budget',
    '--override_model_name=gemini-2.5-pro-windsurf', `--cloud_code_endpoint=${endpoint}`,
    `--api_server_url=${endpoint}`, `--analytics_server_url=${endpoint}`, `--inference_api_server_url=${endpoint}`,
  ], {
    env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin', HOME:directory, TMPDIR:directory, LANG:'en_US.UTF-8',
      JETSKI_OAUTH_TOKEN:'agh-isolated-local-token'}, stdio:['ignore', 'pipe', 'pipe'],
  });
  child.once('error', error => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    backendLog = (backendLog + chunk.toString()).slice(-32768);
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    port = Number(backendLog.match(/listening on \w+ port at (\d+) for HTTP\b/i)?.[1]);
    if (port) break;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private backend exited during startup');
    await delay(100);
  }
  assert(port, 'Private backend did not announce its HTTP port');
  await rpc('GetStatus');
  runtime = createBackendRuntime({machExecutablePath, expectedBinaryPath:prepared.binaryPath,
    layout:prepared.layout, targetTokens:null});
  assert.equal((await runtime.attach(child.pid)).attached, true);

  // Establish this model's actual default before the production controller is
  // bound. Its catalog experiment then supplies that observed baseline to the
  // controller's existing resolved-config path, without inventing a default.
  const {cascadeId:baselineId} = await rpc('StartCascade', {source:1});
  const baselineIndex = requests.length;
  await rpc('SendUserCascadeMessage', message(baselineId, 1, 'Official default control: reply briefly.'));
  finish(await waitRequest(baselineIndex));
  const baseline = (await waitIdle(baselineId)).generators.at(-1);
  assert(Number.isSafeInteger(baseline?.limit) && baseline.limit > 0, 'The native default must be observed in a real generator record');
  assert.notEqual(baseline.limit, 512000, 'The reset control needs an observed default distinct from the custom budget');
  const wireBudgets = [];
  const client = {
    async getAvailableModels() {
      return {models:{isolated:{model:326, displayName:'Isolated BYOM', modelExperiments:{experiments:{
        CASCADE_USE_EXPERIMENT_CHECKPOINTER:{value:{case:'stringValue', value:JSON.stringify({enabled:true, max_token_limit:baseline.limit})}},
      }}}}};
    },
    getCascadeTrajectoryGeneratorMetadata:request => rpc('GetCascadeTrajectoryGeneratorMetadata', request),
    sendUserCascadeMessage(request) {
      wireBudgets.push({cascadeId:request.cascadeId, strategy:request.deliveryStrategy,
        limit:request.cascadeConfig.checkpointConfig?.maxTokenLimit ?? null});
      return rpc('SendUserCascadeMessage', request);
    },
    sendAllQueuedMessages:request => rpc('SendAllQueuedMessages', request),
  };
  const nativeState = async () => ({nativeReady:runtime.getStatus().attached});
  ui = fixture(state(baselineId, 0), {client, windowGlobals:{
    __antigravitySubagentContext:{getStatus:nativeState, mainSettingsChanged:nativeState},
  }});
  ui.mount(); await settle();
  ui.select(326, 'Isolated BYOM'); await settle();
  assert.equal(ui.snapshot().contextSetting.defaultLimit, baseline.limit);

  for (const [strategy, name] of [[1, 'NEXT_INVOCATION'], [2, 'WHEN_IDLE']]) {
    const {cascadeId} = await rpc('StartCascade', {source:1});
    ui.emit(state(cascadeId, 0));
    let index = requests.length;
    const marker = `AGH_FOLLOWUP_${name}`;
    assert.equal(await ui.setLimit(256000), true);
    await send(cascadeId, 1, 'List only this isolated conversation background tasks and then reply briefly.');
    const first = await waitRequest(index++);
    const initial = await snapshot(cascadeId, `${name}:initial-running`);
    assert.equal(initial.status, 'CASCADE_RUN_STATUS_RUNNING');
    assert.deepEqual(initial.users.map(user => user.limit), [256000]);

    assert.equal(await ui.setLimit(512000), true);
    await send(cascadeId, strategy, `${marker}: after listing tasks, reply with one short sentence.`);
    await snapshot(cascadeId, `${name}:followup-submitted`);
    continueThroughTaskList(first, name);

    const second = await waitRequest(index++);
    const secondHasFollowup = hasMarker(second, marker);
    assert.equal(secondHasFollowup, strategy === 1, 'Message delivery order must retain native strategy semantics');
    await snapshot(cascadeId, `${name}:second-planner-running`);
    finish(second);
    if (strategy === 2) {
      const queued = await waitRequest(index++);
      assert.equal(hasMarker(queued, marker), true, 'The queued turn must consume its followup');
      await snapshot(cascadeId, `${name}:queued-turn-running`);
      finish(queued);
    }
    const consumed = await waitIdle(cascadeId);
    const {users, generators} = consumed;
    assert.deepEqual(users.map(user => user.limit), [256000, 512000]);
    assert.equal(consumed.completedTool, true, 'The next planner invocation must follow a completed real backend tool');
    assert.equal(generators[0].limit, 256000, 'Previously dispatched work retains its recorded budget');
    if (strategy === 1) {
      assert.equal(users[1].executionId, users[0].executionId);
      assert.equal(generators[1].executionId, users[1].executionId);
      assert.equal(generators[1].limit, 512000, 'NEXT_INVOCATION must use the newly consumed message budget');
    } else {
      assert.notEqual(users[1].executionId, users[0].executionId);
      assert.equal(generators[1].executionId, users[0].executionId);
      assert.equal(generators[1].limit, 256000, 'WHEN_IDLE must retain the current turn budget before consuming its queued message');
      assert.equal(generators[2].executionId, users[1].executionId);
      assert.equal(generators[2].limit, 512000, 'WHEN_IDLE must apply the budget when its queued turn actually starts');
    }

    // The idle control also holds a fresh 512K execution open for a real reset.
    // The application request still has no checkpoint override: only the shared
    // production controller can materialize either custom or default budgets.
    await send(cascadeId, 1, 'Idle control: list this isolated conversation background tasks and then reply briefly.');
    const idle = await waitRequest(index++);
    await snapshot(cascadeId, `${name}:idle-custom-running`);
    assert.equal(await ui.setLimit(null), true);
    assert.equal(ui.snapshot().contextSetting.customLimit, null);
    const resetMarker = `AGH_RESET_${name}`;
    await send(cascadeId, strategy, `${resetMarker}: reply briefly using the restored model default.`);
    continueThroughTaskList(idle, `reset-${name}`);
    const afterReset = await waitRequest(index++);
    const resetHasFollowup = hasMarker(afterReset, resetMarker);
    assert.equal(resetHasFollowup, strategy === 1, 'Restoring a budget must not change message delivery semantics');
    await snapshot(cascadeId, `${name}:reset-next-planner-running`);
    finish(afterReset);
    if (strategy === 2) {
      const resetQueued = await waitRequest(index++);
      assert.equal(hasMarker(resetQueued, resetMarker), true);
      await snapshot(cascadeId, `${name}:reset-queued-turn-running`);
      finish(resetQueued);
    }
    const final = await waitIdle(cascadeId);
    assert.deepEqual(final.users.map(user => user.limit), [256000, 512000, 512000, baseline.limit]);
    const idleUser = final.users[2], resetUser = final.users[3];
    assert.notEqual(idleUser.executionId, users.at(-1).executionId);
    const resetGenerators = final.generators.slice(generators.length);
    assert.equal(resetGenerators[0].executionId, idleUser.executionId);
    assert.equal(resetGenerators[0].limit, 512000, 'Idle sends must continue to apply the saved message budget');
    if (strategy === 1) {
      assert.equal(resetUser.executionId, idleUser.executionId);
      assert.deepEqual(resetGenerators.map(generator => generator.limit), [512000, baseline.limit]);
    } else {
      assert.notEqual(resetUser.executionId, idleUser.executionId);
      assert.equal(resetGenerators[1].executionId, idleUser.executionId);
      assert.deepEqual(resetGenerators.map(generator => generator.limit), [512000, 512000, baseline.limit]);
    }
    assert.equal(resetGenerators.at(-1).executionId, resetUser.executionId);
    assert.equal(resetGenerators.at(-1).limit, baseline.limit, 'Reset must change the running or queued consumer back to its observed native default');
    assert(final.generators.every(generator => generator.model === baseline.model), 'Baseline and custom/reset records must belong to the same resolved model');
    assert.equal(final.generators[0].limit, 256000, 'Later settings must not rewrite earlier model metadata');
    cases.push({strategy:name, cascadeId, secondHasFollowup, resetHasFollowup, users:final.users, generators:final.generators});
  }
  console.log(JSON.stringify({buildCL:prepared.buildCL, onlyLocalModelResponses:true, baseline, wireBudgets, cases}));
} catch (error) {
  if (latest) console.error(JSON.stringify({lastBudgetState:latest}));
  const errors = backendLog.split(/\r?\n/).filter(line => /(?:ERROR|FATAL|panic:|level=error)/i.test(line));
  if (errors.length) console.error(errors.slice(-4).join('\n').slice(-4000));
  throw error;
} finally {
  for (const request of requests) request.response.destroy();
  try {
    ui?.controller.dispose();
    await runtime?.dispose().catch(() => {});
    if (child?.pid) {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        const closed = once(child, 'close');
        child.kill(signal);
        await Promise.race([closed, delay(2000)]);
      }
      assert(child.exitCode !== null || child.signalCode !== null, 'Private backend must exit during cleanup');
    }
  } finally {
    mock.closeAllConnections();
    try {
      if (mock.listening) await new Promise((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
    } finally {
      await rm(directory, {recursive:true, force:true});
    }
  }
}
