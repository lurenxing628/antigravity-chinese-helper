// Actual suspended-spawn gate and signal lifecycle; no account or model calls.
// node tests/cli-launch.integration.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') throw new Error('CLI launch integration requires macOS');
const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'agh-cli-launch-')));
const executable = join(directory, 'cli-launch'), target = join(directory, 'target');
const pending = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const gone = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
};
try {
  const source = join(directory, 'target.c');
  await writeFile(source, `#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 4) return 99;
    int closed3 = fcntl(3, F_GETFD) == -1, closed4 = fcntl(4, F_GETFD) == -1;
    FILE *file = fopen(argv[1], "w");
    if (!file) return 98;
    fprintf(file, "%s\\n%s\\n%d %d\\n", argv[3], getenv("AGH_CLI_LAUNCH_TEST"),
        closed3, closed4);
    fclose(file);
    puts("target-ready"); fflush(stdout);
    if (!strcmp(argv[2], "exit")) return 7;
    for (;;) pause();
}
`);
  await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', join(root, 'runtime/cli-launch.c'), '-o', executable]);
  await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', target]);

  let next = 0;
  async function launch(mode = 'wait') {
    const marker = join(directory, `marker-${++next}`);
    const child = spawn(executable, [target, marker, mode, 'argument with spaces'], {
      env:{ ...process.env, AGH_CLI_LAUNCH_TEST:'inherited-environment' }, stdio:['ignore','pipe','pipe','pipe','pipe'],
    });
    pending.add(child);
    const closed = once(child, 'close').then(value => { pending.delete(child); return value; });
    let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => error += chunk);
    const lines = createInterface({ input:child.stdio[3] });
    const [line] = await Promise.race([once(lines, 'line'), closed.then(value => { throw new Error(`Launcher closed before PID: ${value}: ${error}`); })]);
    lines.close();
    const pid = JSON.parse(line).pid;
    assert(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(existsSync(marker), false, 'target cannot run before the controller releases it');
    return { child, pid, marker, closed, output:() => output, error:() => error };
  }
  async function release(session) {
    const ready = once(session.child.stdout, 'data');
    session.child.stdio[4].end('R');
    await ready;
    assert.match(session.output(), /target-ready/);
  }

  const normal = await launch('exit');
  await delay(50);
  assert.equal(existsSync(normal.marker), false);
  await release(normal);
  assert.deepEqual(await normal.closed, [7, null]);
  assert.equal(await readFile(normal.marker, 'utf8'), 'argument with spaces\ninherited-environment\n1 1\n');
  assert.equal(normal.error(), '');

  const cancelled = await launch();
  cancelled.child.stdio[4].end();
  assert.deepEqual(await cancelled.closed, [125, null]);
  assert.equal(existsSync(cancelled.marker), false);
  assert.equal(gone(cancelled.pid), true, 'closing the gate must reap the stopped target');

  const earlyTermination = await launch();
  earlyTermination.child.kill('SIGTERM');
  assert.deepEqual(await earlyTermination.closed, [143, null]);
  assert.equal(existsSync(earlyTermination.marker), false);
  assert.equal(gone(earlyTermination.pid), true);

  const termination = await launch();
  await release(termination);
  termination.child.kill('SIGTERM');
  assert.deepEqual(await termination.closed, [143, null]);
  assert.equal(gone(termination.pid), true, 'termination must reach the active CLI');

  const interrupt = await launch();
  await release(interrupt);
  interrupt.child.kill('SIGINT');
  await delay(20);
  assert.equal(gone(interrupt.pid), false, 'launcher cannot forward a second terminal Ctrl+C');
  process.kill(interrupt.pid, 'SIGINT');
  assert.deepEqual(await interrupt.closed, [130, null]);
  assert.equal(gone(interrupt.pid), true, 'CLI cannot inherit the launcher Ctrl+C handler');
  console.log('CLI launch gate: first-instruction suspension, inherited arguments/environment/stdio, gate cancellation, SIGTERM and SIGINT passed');
} finally {
  for (const child of pending) child.kill('SIGTERM');
  await Promise.allSettled([...pending].map(child => once(child, 'close')));
  await rm(directory, { recursive:true, force:true });
}
