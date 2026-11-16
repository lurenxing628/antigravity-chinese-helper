import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectCliHudMetrics } from '../runtime/cli-hud-metrics.mjs';

const integer = n => {
  let rest = BigInt(n); const bytes = [];
  do { const byte = Number(rest & 127n); rest >>= 7n; bytes.push(byte | (rest ? 128 : 0)); } while (rest);
  return Buffer.from(bytes);
};
const scalar = (n, value) => Buffer.concat([integer(n * 8), integer(value)]);
const bytes = (n, value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([integer(n * 8 + 2), integer(body.length), body]);
};
const message = (...parts) => Buffer.concat(parts);
const duration = seconds => scalar(1, seconds);
const timestamp = seconds => scalar(1, seconds);
const usage = (input, output, cache = 0) => message(scalar(2, input), scalar(3, output), scalar(5, cache));
async function fixture(run) {
  const folder = await mkdtemp(join(tmpdir(), 'agy-hud-metrics-'));
  const path = join(folder, 'conversation.db'), database = new DatabaseSync(path);
  database.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
  try { await run({database, path, cacheDir:join(folder, 'cache')}); }
  finally { database.close(); await rm(folder, {recursive:true, force:true}); }
}

test('matches Desktop retry selection, cumulative cache input and last-ten arithmetic TPS', async () => {
  await fixture(async ({database, path}) => {
    const insert = database.prepare('INSERT INTO gen_metadata VALUES (?, ?)');
    for (let i = 1; i <= 12; i++) {
      const chat = message(bytes(4, i === 12 ? usage(999, 999, 999) : usage(100, i * 10, 20)),
        ...(i === 12 ? [bytes(17, bytes(2, usage(80, 120, 40))), bytes(17, bytes(3, 'retry without usage'))] : []),
        bytes(11, duration(1)), bytes(12, duration(1)),
        bytes(9, message(bytes(10, message(scalar(1, 2400), scalar(4, 256000))), scalar(2, 18446744073709551615n))));
      insert.run(i, bytes(1, chat));
    }
    const value = await collectCliHudMetrics({databasePath:path});
    assert.equal(value.input, 1440);
    assert.equal(value.output, 780);
    assert.equal(value.cacheRead, 260);
    assert.equal(value.cacheHitRate, 260 / 1440);
    assert.equal(value.tps, 37.5);
    assert.equal(value.ttftMs, 1000);
    assert.equal(value.samples, 10);
    assert.deepEqual(value.context, {used:2400, window:null, compactAt:256000});
  });
});

test('counts confirmed FileEdit results and unions active intervals; cached running time advances', async () => {
  await fixture(async ({database, path, cacheDir}) => {
    const step = database.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
    step.run(1, 15, 3, message(bytes(1, timestamp(100)), bytes(7, timestamp(104)), bytes(9, usage(10, 1))), null);
    const tool = name => bytes(4, bytes(2, name));
    const edit = (path, added, removed) => bytes(140, bytes(2, bytes(6, message(
      bytes(1, 'type.googleapis.com/exa.cortex.core.tools.FileEdit'),
      bytes(2, message(bytes(2, path), bytes(4, message(scalar(1, added), scalar(2, removed)))))))));
    step.run(2, 132, 3, message(tool('edit_file'), bytes(32, timestamp(103)), bytes(8, timestamp(106))), edit('/a', 5, 2));
    step.run(3, 132, 3, message(tool('write_file'), bytes(32, timestamp(105)), bytes(8, timestamp(107))), edit('/a', 1, 0));
    step.run(4, 132, 7, tool('edit_file'), edit('/b', 99, 99)); // failed edit
    step.run(5, 132, 2, message(tool('run_command'), bytes(32, timestamp(110))), null);
    step.run(6, 132, 3, message(tool('schedule'), bytes(32, timestamp(200)), bytes(8, timestamp(900000))), null);
    const value = await collectCliHudMetrics({databasePath:path, now:112000, cacheDir, runId:'first', isActive:true});
    assert.deepEqual(value.edits, {files:1, added:6, removed:2});
    assert.equal(value.activeMs, 7000); // Restored completed [100,107], no stale-running estimate.
    assert.equal(value.isActive, true);
    const cached = await collectCliHudMetrics({databasePath:path, now:115000, cacheDir, runId:'first', isActive:true});
    assert.equal(cached.activeMs, 10000);
    const persisted = JSON.parse(await readFile(join(cacheDir, 'conversation.db.metrics.json'), 'utf8'));
    assert.equal(persisted.activity.at, 115000);
    const restarted = await collectCliHudMetrics({databasePath:path, now:1000000, cacheDir, runId:'second'});
    assert.equal(restarted.activeMs, 10000); // The exit/idle gap never becomes active time.
    // Changing the database invalidates the scalar cache.
    database.prepare('UPDATE steps SET status = 3, metadata = ? WHERE idx = 5').run(message(tool('run_command'), bytes(32, timestamp(110)), bytes(8, timestamp(113))));
    const refreshed = await collectCliHudMetrics({databasePath:path, now:1000001, cacheDir, runId:'second'});
    assert.equal(refreshed.activeMs, 12000); // [100,107], [110,113] union observed [112,115]
    assert.equal(refreshed.isActive, false);
    database.exec('DROP TABLE gen_metadata'); // Simulate an unavailable metric query.
    const retained = await collectCliHudMetrics({databasePath:path, now:1000002, cacheDir, runId:'second'});
    assert.deepEqual(retained.edits, refreshed.edits);
    assert.equal(retained.activeMs, refreshed.activeMs);
    database.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
    step.run(7, 132, 2, message(tool('schedule'), bytes(32, timestamp(120))), null);
    const waiting = await collectCliHudMetrics({databasePath:path, now:1000003, cacheDir, runId:'second', isActive:true});
    assert.equal(waiting.isActive, false);
    const stillWaiting = await collectCliHudMetrics({databasePath:path, now:1005003, cacheDir, runId:'second', isActive:true});
    assert.equal(stillWaiting.activeMs, waiting.activeMs);
  });
});

test('keeps main usage separate and combines each nested child last-ten sample window', async () => {
  await fixture(async ({database, path, cacheDir}) => {
    const identityTables = db => db.exec('CREATE TABLE trajectory_meta(cascade_id TEXT); CREATE TABLE trajectory_metadata_blob(id TEXT, data BLOB);');
    identityTables(database);
    database.prepare('INSERT INTO trajectory_meta VALUES (?)').run('main');
    database.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.alloc(0));
    database.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, bytes(1, bytes(4, usage(1000, 100))));
    const addWork = (db, [start, end], [path, added, removed]) => {
      const step = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
      step.run(1, 15, 3, message(bytes(1, timestamp(start)), bytes(7, timestamp(end)), bytes(9, usage(10, 1))), null);
      const payload = bytes(140, bytes(2, bytes(6, message(
        bytes(1, 'type.googleapis.com/exa.cortex.core.tools.FileEdit'),
        bytes(2, message(bytes(2, path), bytes(4, message(scalar(1, added), scalar(2, removed)))))))));
      step.run(2, 132, 3, bytes(4, bytes(2, 'edit_file')), payload);
    };
    addWork(database, [100, 110], ['/same', 2, 1]);
    const makeChild = (name, parent, outputs, fork = false, interval = [105, 115], edit = ['/same', 5, 2], withWork = true) => {
      const child = new DatabaseSync(join(join(path, '..'), name + '.db'));
      try {
        child.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
        identityTables(child);
        child.prepare('INSERT INTO trajectory_meta VALUES (?)').run(name);
        child.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', message(bytes(5, parent), bytes(8, Buffer.alloc(0)), scalar(16, Number(fork))));
        for (const [index, output] of outputs.entries()) child.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(index,
          bytes(1, message(bytes(4, usage(100, output, 10)), bytes(11, duration(1)), bytes(12, duration(1)))));
        if (withWork) addWork(child, interval, edit);
      } finally { child.close(); }
    };
    makeChild('child', 'main', [20]);
    makeChild('nested', 'child', [40, 40], false, [120, 125], ['/other', 3, 1]);
    makeChild('fork', 'main', [999], true, [1000, 2000], ['/fork', 999, 999]);
    const value = await collectCliHudMetrics({databasePath:path, cacheDir});
    assert.equal(value.input, 1000);
    assert.equal(value.output, 100);
    assert.equal(value.subagentMetrics.count, 2);
    assert.equal(value.subagentMetrics.input, 330);
    assert.equal(value.subagentMetrics.output, 100);
    assert.equal(value.subagentMetrics.cacheHitRate, 30 / 330);
    assert.equal(value.subagentMetrics.tps, 50 / 3);
    assert.equal(value.subagentMetrics.samples, 3);
    assert.equal(value.activeMs, 20000); // [100,115] union [120,125], fork excluded.
    assert.deepEqual(value.edits, {files:2, added:10, removed:4});
    const cached = await collectCliHudMetrics({databasePath:path, cacheDir});
    assert.equal(cached.activeMs, value.activeMs);
    assert.deepEqual(cached.edits, value.edits);
    const direct = JSON.parse(await readFile(join(cacheDir, 'conversation.db.metrics.json'), 'utf8'));
    assert.equal(direct.snapshot.activeMs, 10000);
    assert.deepEqual(direct.snapshot.edits, {files:1, added:2, removed:1});
    makeChild('pending', 'main', [], false, undefined, undefined, false);
    const incomplete = await collectCliHudMetrics({databasePath:path, cacheDir});
    assert.equal(incomplete.activeMs, value.activeMs);
    assert.deepEqual(incomplete.edits, value.edits);
  });
});

test('missing data remains unknown; counters do not become fabricated zeroes', async () => {
  await fixture(async ({path}) => {
    const value = await collectCliHudMetrics({databasePath:path});
    assert.equal(value.input, null);
    assert.equal(value.cacheHitRate, null);
    assert.equal(value.tps, null);
    assert.equal(value.activeMs, null);
    assert.deepEqual(value.edits, {files:null, added:null, removed:null});
    const missing = await collectCliHudMetrics({databasePath:path + '.missing'});
    assert.equal(missing.input, null);
    assert.equal(missing.activeMs, null);
  });
});
