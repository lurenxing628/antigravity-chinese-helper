// Actual CLI main/subagent budgets, using only a loopback Gemini mock.
// node tests/cli-budget.integration.mjs [path/to/agy]
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureCliTools, launchCliSession, prepareCliCopy } from '../runtime/cli.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('CLI budget integration requires macOS arm64');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'agh-cli-budget-')));
const officialCliPath = resolve(process.argv[2] ?? join(homedir(), '.local', 'bin', 'agy'));
const model = 'agh-local', capacity = 1000000, defaultBudget = capacity - 65536;
const sandbox = '(version 1) (allow default) (deny network*) ' +
  '(allow network-outbound (remote ip "localhost:*")) (allow network-inbound (local ip "localhost:*"))';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const cases = [];
let activeCase = null, activeChild = null, activePid = null, mockError = null;

function stopActiveChild() {
  if (!activeChild || activeChild.exitCode !== null || activeChild.signalCode !== null) return;
  // Killing the gate alone would leave its CLI child behind.
  try { process.kill(activePid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  activeChild.kill('SIGTERM');
}

function finish(response, parts) {
  response.writeHead(200, { 'Content-Type':'text/event-stream' });
  response.end(`data: ${JSON.stringify({
    candidates:[{ content:{ role:'model', parts }, finishReason:'STOP', index:0 }],
    usageMetadata:{ promptTokenCount:20, candidatesTokenCount:5, totalTokenCount:25 }, modelVersion:model,
  })}\n\n`);
}

const mock = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (request.url.includes('streamGenerateContent')) {
      assert(activeCase, 'A model request must belong to an isolated CLI case');
      activeCase.requests++;
      if (activeCase.spawnChild && !activeCase.childRequested) {
        const tool = (body.tools ?? []).flatMap(value => value.functionDeclarations ?? []).find(value => value.name === 'invoke_subagent');
        assert(tool, 'The real CLI must expose invoke_subagent');
        activeCase.childRequested = true;
        finish(response, [{ functionCall:{ name:tool.name, id:'agh-local-child-launch', args:{
          TypeName:'self', Role:'Budget Probe', Prompt:'Reply AGH_CHILD_LOCAL_OK only.', Model:'inherit', Workspace:'inherit',
        } } }]);
      } else {
        finish(response, [{ text:'AGH_LOCAL_OK' }]);
      }
    } else if (request.url.includes('countTokens')) {
      response.writeHead(200, { 'Content-Type':'application/json' });
      response.end('{"totalTokens":20}');
    } else {
      response.writeHead(200, { 'Content-Type':'application/json' });
      response.end(JSON.stringify({ name:`models/${model}`, displayName:'AGH Local', inputTokenLimit:capacity,
        outputTokenLimit:8192, supportedGenerationMethods:['generateContent', 'streamGenerateContent', 'countTokens'] }));
    }
  } catch (error) {
    mockError = error;
    response.destroy(error);
  }
});

// The native gen_metadata BLOB is protobuf. Read only the fields whose schema
// tags are confirmed in agy's Go type metadata; no generated API client is used.
function fields(bytes) {
  let offset = 0;
  const result = new Map();
  const varint = () => {
    let value = 0n, shift = 0n;
    for (let index = 0; index < 10 && offset < bytes.length; index++) {
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
      shift += 7n;
    }
    throw new Error('Invalid protobuf varint in isolated CLI metadata');
  };
  while (offset < bytes.length) {
    const key = Number(varint()), number = key >>> 3, wire = key & 7;
    assert(number > 0, 'A protobuf field must have a positive number');
    let value;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const length = Number(varint());
      assert(Number.isSafeInteger(length) && length <= bytes.length - offset, 'Protobuf field exceeds its BLOB');
      value = bytes.subarray(offset, offset + length); offset += length;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
    assert(offset <= bytes.length, 'Protobuf scalar exceeds its BLOB');
    if (value !== undefined) result.set(number, [...(result.get(number) ?? []), value]);
  }
  return result;
}

function valuesAt(bytes, path) {
  const values = fields(bytes).get(path[0]) ?? [];
  return path.length === 1 ? values : values.flatMap(value => typeof value === 'bigint' ? [] : valuesAt(value, path.slice(1)));
}

function readBudgets(path) {
  const db = new DatabaseSync(path, { readOnly:true });
  try {
    // ChatStartMetadata.context_window_metadata is field 10; its
    // ContextWindowMetadata.max_context_tokens is field 4.
    const budgets = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all()
      .flatMap(row => valuesAt(Buffer.from(row.data), [1, 9, 10, 4])).map(Number);
    const metadata = db.prepare('SELECT data FROM trajectory_metadata_blob WHERE id = ?').get('main');
    const parent = metadata && valuesAt(Buffer.from(metadata.data), [5])[0];
    return { budgets, parentId:parent && Buffer.from(parent).toString('utf8') };
  } finally { db.close(); }
}

function parseEvents(stdout) {
  return stdout.split(/\r?\n/).flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; }
    catch { return []; }
  });
}

async function runCase({ name, mainTokens, subagentTokens, expected, spawnChild = false }, tools) {
  const folder = join(directory, name), home = join(folder, 'home'), work = join(folder, 'work'), temporary = join(folder, 'tmp');
  await Promise.all([home, work, temporary].map(path => mkdir(path, { recursive:true })));
  const prepared = await prepareCliCopy({ officialCliPath, stateDir:join(directory, 'helper'), mainTokens, contextOverridesEnabled:true });
  // Sandbox the complete C gate and CLI child, while the Mach publisher remains
  // outside it. The gate's status/control FDs survive exec unchanged.
  const launchExecutablePath = join(folder, 'launch-isolated');
  await writeFile(launchExecutablePath, `#!/bin/sh\ncd ${shellQuote(work)} || exit 1\n` +
    `exec /usr/bin/sandbox-exec -p ${shellQuote(sandbox)} ${shellQuote(tools.launchExecutablePath)} "$@"\n`);
  await chmod(launchExecutablePath, 0o755);
  const settings = { modelProvider:'gemini', customModelsConfig:{ customModels:{
    [model]:{ modelName:`gemini-api://${model}`, label:'AGH Local', maxTokens:capacity },
  } } };
  const endpoint = `http://127.0.0.1:${mock.address().port}`;
  const env = { PATH:'/usr/bin:/bin:/usr/sbin:/sbin', HOME:home, TMPDIR:temporary, LANG:'en_US.UTF-8',
    GEMINI_API_KEY:'agh-local-fake-key', GOOGLE_GEMINI_BASE_URL:endpoint, XDG_CONFIG_HOME:join(home, 'config'),
    XDG_DATA_HOME:join(home, 'data'), XDG_CACHE_HOME:join(home, 'cache'), TERM:'xterm-256color', NO_COLOR:'1' };
  let stdout = '', stderr = '', closed, timer;
  activeCase = { name, spawnChild, childRequested:false, requests:0 };
  try {
    const code = await launchCliSession({ binaryPath:prepared.binaryPath,
      args:['--model', model, '--print', 'Reply AGH_LOCAL_OK only.', '--print-timeout', '20s',
        '--output-format', 'stream-json', '--log-file', join(folder, 'agy.log'), '--settings', JSON.stringify(settings)],
      contextOverridesEnabled:true, layout:prepared.layout, subagentTokens, machExecutablePath:tools.machExecutablePath, launchExecutablePath, env,
      stdio:['ignore', 'pipe', 'pipe'],
      onReady({ pid, child, runtime }) {
        activeChild = child; activePid = pid;
        closed = once(child, 'close');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        if (subagentTokens !== null) assert.equal(runtime.getStatus().attached, true);
        timer = setTimeout(stopActiveChild, 30000);
      },
    });
    await closed;
    if (mockError) throw mockError;
    assert.equal(code, 0, `${name}: CLI failed: ${stderr.slice(-2000)}`);
    const events = parseEvents(stdout), result = events.findLast(event => event.event === 'result')?.result;
    assert.equal(result?.status, 'SUCCESS', `${name}: CLI did not finish successfully`);
    const conversationId = result.conversation_id;
    assert(conversationId, `${name}: CLI did not report a conversation ID`);
    const conversations = join(home, '.gemini', 'antigravity-cli', 'conversations');
    const parent = readBudgets(join(conversations, `${conversationId}.db`));
    assert(parent.budgets.length > 0, `${name}: no actual parent model budget was recorded`);
    assert(parent.budgets.every(tokens => tokens === expected), `${name}: parent budgets ${parent.budgets} must be ${expected}`);
    const updates = events.flatMap(event => event.event === 'step_update' ? [event.step_update] : []);
    const childIds = [...new Set(updates.flatMap(update => update.step_type === 'subagent' && update.state === 'DONE'
      ? (update.subagent_info?.subagents ?? []).map(child => child.conversation_id).filter(Boolean) : []))];
    const children = childIds.map(id => ({ id, ...readBudgets(join(conversations, `${id}.db`)) }));
    if (spawnChild) {
      assert(activeCase.childRequested && children.length > 0, 'A real subagent tool must finish in the CLI');
      for (const child of children) {
        assert.equal(child.parentId, conversationId, 'The budget record must belong to this parent\'s real child');
        assert(child.budgets.length > 0, 'The child must actually call the local model');
        assert(child.budgets.every(tokens => tokens === subagentTokens), `Child budgets ${child.budgets} must be ${subagentTokens}`);
      }
    }
    cases.push({ name, mainTokens, subagentTokens, requests:activeCase.requests, parentBudgets:parent.budgets,
      childBudgets:children.map(child => child.budgets) });
  } catch (error) {
    const log = await readFile(join(folder, 'agy.log'), 'utf8').catch(() => '');
    const errors = log.split(/\r?\n/).filter(line => /(?:ERROR|FATAL|panic:|level=error)/i.test(line));
    console.error(JSON.stringify({ case:name, requests:activeCase.requests,
      stderr:stderr.slice(-2000), nativeErrors:errors.slice(-3) }));
    throw error;
  } finally {
    clearTimeout(timer);
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      stopActiveChild();
      await closed;
    }
    activeChild = activeCase = activePid = null;
  }
}

try {
  const tools = await ensureCliTools(join(directory, 'helper'));
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  await runCase({ name:'main-and-child', mainTokens:500000, subagentTokens:128000, expected:500000, spawnChild:true }, tools);
  await runCase({ name:'main-only', mainTokens:500000, subagentTokens:null, expected:500000 }, tools);
  await runCase({ name:'child-only', mainTokens:null, subagentTokens:128000, expected:defaultBudget, spawnChild:true }, tools);
  await runCase({ name:'model-capacity', mainTokens:2000000, subagentTokens:null, expected:defaultBudget }, tools);
  await runCase({ name:'restore-default', mainTokens:null, subagentTokens:null, expected:defaultBudget }, tools);
  console.log(JSON.stringify({ cli:basename(officialCliPath), onlyLocalModelResponses:true, cases }));
} finally {
  mock.closeAllConnections();
  if (mock.listening) await new Promise(resolve => mock.close(resolve));
  // The CLI's detached updater may briefly write its final failure status.
  await rm(directory, { recursive:true, force:true, maxRetries:3, retryDelay:100 });
}
