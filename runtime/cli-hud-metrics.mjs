import { basename, dirname, join, resolve } from 'node:path';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';

const CACHE_VERSION = 5;

// agy 1.5.9's persisted Cortex protobufs. Only counters, timing and confirmed
// FileEdit results are decoded; prompts, tool arguments and results stay bytes.
function fields(bytes) {
  const result = new Map();
  if (!(bytes instanceof Uint8Array)) return result;
  let at = 0;
  const integer = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n && at < bytes.length; shift += 7n) {
      const byte = bytes[at++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        // Unselected signed protobuf fields (for example checkpoint_index=-1)
        // use ten-byte varints. Preserve them without treating them as counters.
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error('Incomplete CLI metric protobuf');
  };
  while (at < bytes.length) {
    const tag = integer();
    if (typeof tag !== 'number') throw new Error('Invalid CLI metric tag');
    const number = Math.floor(tag / 8), wire = tag & 7;
    if (!number) throw new Error('Invalid CLI metric field');
    let value;
    if (wire === 0) value = integer();
    else {
      const length = wire === 2 ? integer() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (typeof length !== 'number' || length < 0 || at + length > bytes.length) throw new Error('Invalid CLI metric wire value');
      value = bytes.subarray(at, at + length); at += length;
    }
    const values = result.get(number) ?? [];
    values.push(value); result.set(number, values);
  }
  return result;
}
const first = (message, number) => message.get(number)?.[0];
const child = (message, number) => fields(first(message, number));
const counter = (message, number) => {
  const value = first(message, number) ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid CLI metric counter');
  return value;
};
const time = bytes => {
  if (!bytes) return null;
  const value = fields(bytes);
  return counter(value, 1) * 1000 + counter(value, 2) / 1e6;
};
const text = bytes => bytes ? Buffer.from(bytes).toString('utf8') : null;
const empty = () => ({context:{used:null, window:null, compactAt:null}, input:null, output:null,
  cacheRead:null, cacheHitRate:null, tps:null, ttftMs:null, samples:0,
  edits:{files:null, added:null, removed:null}, activeMs:null, isActive:null, subagentMetrics:null});

function mergeIntervals(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of intervals) {
    if (end <= start) continue;
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function readMetrics(database) {
  const snapshot = empty(), intervals = [], files = new Set(), samples = [];
  let steps = 0, editsKnown = true, added = 0, removed = 0, pendingSchedule = false, pendingWork = false;
  const editIndices = [];
  for (const row of database.prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx').iterate()) {
    steps++;
    const meta = fields(row.metadata), created = time(first(meta, 1));
    const started = time(first(meta, 32)), completed = time(first(meta, 8));
    const generated = time(first(meta, 7));
    const toolName = text(first(child(meta, 4), 2));
    if (row.status === 2) {
      if (toolName === 'schedule') pendingSchedule = true;
      else pendingWork = true;
    }
    if (row.step_type === 132 && row.status === 3) {
      if (toolName === 'edit_file' || toolName === 'write_file') editIndices.push(row.idx);
    }
    // A model's creation-to-generation interval includes TTFT. Tools use their
    // execution timestamps, keeping permission and human input waits out.
    if (meta.has(9) && created !== null && generated !== null && generated >= created) intervals.push([created, generated]);
    if (meta.has(4) && toolName !== 'schedule' && started !== null && completed !== null && completed >= started) {
      intervals.push([started, completed]);
    }
  }

  let input = 0, output = 0, cacheRead = 0, generators = 0;
  for (const row of database.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').iterate()) {
    const generator = fields(row.data);
    if (!generator.has(1)) continue; // CortexStepGeneratorMetadata.chat_model
    const chat = child(generator, 1);
    let usageBytes = first(chat, 4);
    // Match Desktop modelMetrics: one selected usage for each generator.
    for (const retry of [...(chat.get(17) ?? [])].reverse()) {
      const retryUsage = first(fields(retry), 2);
      if (retryUsage) { usageBytes = retryUsage; break; }
    }
    if (!usageBytes) continue;
    const usage = fields(usageBytes), inTokens = counter(usage, 2), outTokens = counter(usage, 3), cached = counter(usage, 5);
    generators++; input += inTokens + cached; output += outTokens; cacheRead += cached;
    const ttftMs = time(first(chat, 11)), streamingMs = time(first(chat, 12));
    if (streamingMs > 0 && ttftMs !== null && outTokens > 0) {
      samples.push({tps:outTokens * 1000 / (ttftMs + streamingMs), ttftMs});
    }
    const start = child(chat, 9), context = child(start, 10);
    snapshot.context.used = context.has(1) ? counter(context, 1) : inTokens + cached + outTokens;
    snapshot.context.compactAt = first(context, 4) ?? null;
  }
  if (generators) {
    Object.assign(snapshot, {input, output, cacheRead, cacheHitRate:input > 0 ? cacheRead / input : null});
    const replies = samples.slice(-10);
    snapshot.samples = replies.length;
    if (replies.length) {
      snapshot.tps = replies.reduce((sum, value) => sum + value.tps, 0) / replies.length;
      snapshot.ttftMs = replies.reduce((sum, value) => sum + value.ttftMs, 0) / replies.length;
    }
  }

  // The stored step_payload is a full Step. Generic(140).result(2).payload(6)
  // is an Any; only a successful tools.FileEdit provides authoritative stats.
  const readEdit = database.prepare('SELECT step_payload FROM steps WHERE idx = ?');
  for (const index of editIndices) {
    const row = readEdit.get(index);
    const generic = child(fields(row.step_payload), 140), result = child(generic, 2), payload = child(result, 6);
    if (text(first(payload, 1)) !== 'type.googleapis.com/exa.cortex.core.tools.FileEdit') continue;
    const edit = child(payload, 2), path = text(first(edit, 2));
    if (!path || !edit.has(4)) { editsKnown = false; continue; }
    const stats = child(edit, 4);
    files.add(path); added += counter(stats, 1); removed += counter(stats, 2);
  }
  if (steps) {
    snapshot.activeMs = 0;
    if (editsKnown) snapshot.edits = {files:files.size, added, removed};
  }
  return {snapshot, intervals:mergeIntervals(intervals), editFiles:steps && editsKnown ? [...files] : null,
    waiting:pendingSchedule && !pendingWork};
}

async function fileState(path) {
  try { const value = await stat(path); return {size:value.size, modified:value.mtimeMs}; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function databaseIdentity(path, cacheDir) {
  const stamp = {path, main:await fileState(path), wal:await fileState(path + '-wal')};
  const cachePath = cacheDir && join(cacheDir, basename(path) + '.identity.json');
  let previousIdentity = null;
  if (cachePath) {
    try {
      const saved = JSON.parse(await readFile(cachePath, 'utf8'));
      if (saved.stamp.path === path) previousIdentity = saved.identity;
      if (JSON.stringify(saved.stamp) === JSON.stringify(stamp)) return saved.identity;
    } catch { /* Relationship metadata has not been cached. */ }
  }
  let database, identity = null;
  try {
    const {DatabaseSync} = await import('node:sqlite');
    database = new DatabaseSync(path, {readOnly:true});
    const row = database.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
    const trajectory = database.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 1').get();
    const meta = fields(row?.data);
    if (trajectory?.cascade_id) identity = {id:trajectory.cascade_id, path,
      parent:text(first(meta, 5)), subagent:meta.has(8), fork:counter(meta, 16) !== 0};
  } catch { /* A new or unavailable DB has no confirmed relationship yet. */ }
  finally { database?.close(); }
  if (cachePath && identity) {
    try {
      await mkdir(cacheDir, {recursive:true, mode:0o700});
      await writeFile(cachePath, JSON.stringify({stamp, identity}), {mode:0o600});
    } catch { /* Discovery can continue without the optional identity cache. */ }
  }
  return identity ?? previousIdentity;
}

async function collectSubagents(path, cacheDir, now, previous) {
  try {
    const folder = dirname(path), identities = [];
    for (const name of await readdir(folder)) {
      if (name.endsWith('.db')) {
        const identity = await databaseIdentity(join(folder, name), cacheDir);
        if (identity) identities.push(identity);
      }
    }
    const root = identities.find(value => value.path === path);
    if (!root) return previous ?? null;
    const known = new Set([root.id]), children = [];
    // Parent references also describe forks and inherited context. Require the
    // actual parent ID plus SubagentSpec so those histories are never repeated.
    for (let index = 0, parents = [root.id]; index < parents.length; index++) {
      for (const identity of identities) {
        if (identity.parent !== parents[index] || !identity.subagent || identity.fork || known.has(identity.id)) continue;
        known.add(identity.id); parents.push(identity.id); children.push(identity);
      }
    }
    if (!children.length) return {metrics:null, intervals:[], editFiles:[], added:0, removed:0};
    const totals = {count:children.length, input:0, output:0, cacheRead:0, samples:0, tps:0, ttftMs:0};
    const intervals = [], editFiles = new Set();
    let metricsKnown = true, activityKnown = true, editsKnown = true, added = 0, removed = 0;
    for (const identity of children) {
      const value = await collectCliHudMetrics({databasePath:identity.path, cacheDir, now, includeSubagents:false, _includeFacts:true});
      if (value.input === null || value.output === null || value.cacheRead === null) metricsKnown = false;
      else {
        totals.input += value.input; totals.output += value.output; totals.cacheRead += value.cacheRead;
        totals.samples += value.samples;
        totals.tps += (value.tps ?? 0) * value.samples;
        totals.ttftMs += (value.ttftMs ?? 0) * value.samples;
      }
      if (value.activeMs === null || !value._facts?.intervals) activityKnown = false;
      else intervals.push(...value._facts.intervals);
      if (!value._facts?.editFiles || value.edits.added === null || value.edits.removed === null) editsKnown = false;
      else {
        for (const path of value._facts.editFiles) editFiles.add(path);
        added += value.edits.added; removed += value.edits.removed;
      }
    }
    const metrics = metricsKnown ? {...totals, cacheHitRate:totals.input > 0 ? totals.cacheRead / totals.input : null,
      tps:totals.samples ? totals.tps / totals.samples : null,
      ttftMs:totals.samples ? totals.ttftMs / totals.samples : null} : previous?.metrics ?? {
        ...totals, input:null, output:null, cacheRead:null, cacheHitRate:null, tps:null, ttftMs:null};
    return {metrics, intervals:activityKnown ? mergeIntervals(intervals) : previous?.intervals ?? null,
      editFiles:editsKnown ? [...editFiles] : previous?.editFiles ?? null,
      added:editsKnown ? added : previous?.added ?? null,
      removed:editsKnown ? removed : previous?.removed ?? null};
  } catch { return previous ?? null; }
}

/** Read aggregate metrics without changing the conversation database. */
export async function collectCliHudMetrics({databasePath, now = Date.now(), cacheDir, isActive = false, runId,
  includeSubagents = true, _includeFacts = false} = {}) {
  if (!databasePath) return empty();
  const path = resolve(databasePath);
  const cachePath = cacheDir && join(cacheDir, basename(path) + '.metrics.json');
  let cache;
  if (cachePath) {
    try { const value = JSON.parse(await readFile(cachePath, 'utf8')); if (value.version === CACHE_VERSION && value.stamp.path === path) cache = value; }
    catch { /* No reusable cache yet. */ }
  }
  let stamp = null;
  try {
    const [main, wal] = await Promise.all([fileState(path), fileState(path + '-wal')]);
    if (main) stamp = {path, main, wal};
  } catch { /* A transient read failure keeps the last complete snapshot. */ }
  let snapshot = cache?.snapshot, intervals = cache?.intervals, editFiles = cache?.editFiles,
    waiting = cache?.waiting ?? false;
  if (stamp && (!cache || JSON.stringify(cache.stamp) !== JSON.stringify(stamp))) {
    let database;
    try {
      const {DatabaseSync} = await import('node:sqlite');
      database = new DatabaseSync(path, {readOnly:true});
      database.exec('BEGIN');
      ({snapshot, intervals, waiting, editFiles} = readMetrics(database));
    } catch { stamp = cache?.stamp ?? null; }
    finally { database?.close(); }
  }
  if (!snapshot) return empty();
  let observed = cache?.observed ?? [];
  const previous = cache?.activity, elapsed = now - (previous?.at ?? now);
  // Status commands run about every 300 ms. Observe only short, continuous
  // intervals in this CLI run; a stale running DB row never counts downtime.
  if (runId && previous?.runId === runId && previous.isActive && elapsed > 0 && elapsed <= 10000) {
    observed = mergeIntervals([...observed, [previous.at, now]]);
  }
  snapshot.isActive = isActive && !waiting;
  const directIntervals = mergeIntervals([...(intervals ?? []), ...observed]);
  if (snapshot.activeMs !== null) snapshot.activeMs = directIntervals.reduce((sum, [start, end]) => sum + end - start, 0);
  const aggregate = includeSubagents ? await collectSubagents(path, cacheDir, now, cache?.aggregate) : cache?.aggregate;
  if (cachePath) {
    const temporary = cachePath + '.' + process.pid + '.tmp';
    try {
      await mkdir(cacheDir, {recursive:true, mode:0o700});
      await writeFile(temporary, JSON.stringify({version:CACHE_VERSION, stamp:stamp ?? cache.stamp,
        snapshot, intervals, editFiles, aggregate, waiting, observed,
        activity:{runId, isActive:snapshot.isActive, at:now}}), {mode:0o600});
      await rename(temporary, cachePath);
    } catch { /* Metrics remain usable when the optional cache cannot be saved. */ }
  }
  // Persist direct facts separately. Combining an already aggregated snapshot
  // with the same descendants on the next refresh would count their work twice.
  const result = {...snapshot, edits:{...snapshot.edits}, subagentMetrics:includeSubagents ? aggregate?.metrics ?? null : null};
  if (includeSubagents && aggregate?.intervals && result.activeMs !== null) {
    result.activeMs = mergeIntervals([...directIntervals, ...aggregate.intervals]).reduce((sum, [start, end]) => sum + end - start, 0);
  }
  if (includeSubagents && aggregate?.editFiles && editFiles && result.edits.added !== null && result.edits.removed !== null) {
    result.edits = {files:new Set([...editFiles, ...aggregate.editFiles]).size,
      added:result.edits.added + aggregate.added, removed:result.edits.removed + aggregate.removed};
  }
  if (_includeFacts) result._facts = {intervals:directIntervals, editFiles};
  return result;
}
