import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { scheduleOfficialCliUpdate } from '../runtime/cli-update.mjs';

test('concurrent Chinese sessions check once on the default official install and respect opt-outs', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'agy-official-update-'));
  t.after(() => rm(folder, { recursive:true, force:true }));
  const binDir = join(folder, '.local', 'bin');
  const officialCliPath = join(binDir, 'agy');
  const options = { officialCliPath, stateDir:join(folder, 'helper'), env:{ HOME:folder } };
  await mkdir(binDir, { recursive:true });
  await writeFile(officialCliPath, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$0.args"\n', { mode:0o700 });

  assert.equal(await scheduleOfficialCliUpdate({ ...options, officialCliPath:join(folder, 'builds', 'agy') }), false);
  for (const env of [{ ANTIGRAVITY_HELPER_CLI:officialCliPath }, { AGY_CLI_DISABLE_AUTO_UPDATE:'true' }]) {
    assert.equal(await scheduleOfficialCliUpdate({ ...options, env:{ ...options.env, ...env } }), false);
  }

  const scheduled = await Promise.all([scheduleOfficialCliUpdate(options), scheduleOfficialCliUpdate(options)]);
  assert.deepEqual(scheduled.sort(), [false, true]);
  let args;
  for (let attempt = 0; attempt < 200 && !args; attempt++) {
    args = await readFile(officialCliPath + '.args', 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!args) await delay(25);
  }
  assert.equal(args, 'update\n');
});
