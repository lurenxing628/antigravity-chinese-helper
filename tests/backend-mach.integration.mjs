// Actual Mach transport checks on a private four-entry C target. No live App.
// node tests/backend-mach.integration.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { reserveBackendBudget } from '../runtime/backend-metadata.mjs';
const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Mach integration requires macOS arm64');
const dir = await realpath(await mkdtemp(join(tmpdir(), 'agh-mach-test-')));
const executable = join(dir, 'backend-mach'), instrumented = join(dir, 'backend-mach-stop'), targetPath = join(dir, 'target');
const queue = [], readers = [];
let target, lines;
const receive = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
  const reader = value => { clearTimeout(timer); resolve(value); };
  const timer = setTimeout(() => {
    readers.splice(readers.indexOf(reader), 1);
    reject(new Error('Target stopped responding after Mach publication'));
  }, 5000);
  readers.push(reader);
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let stoppedExecutors = [];
try {
  await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', join(root, 'runtime/backend-mach.c'), '-o', executable]);
  await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-pthread', '-Wl,-no_fixup_chains', join(root, 'tests/mach-target.c'), '-o', targetPath]);
  const targetBytes = await readFile(targetPath);
  const budgetSlot = reserveBackendBudget(targetBytes);
  await writeFile(targetPath, targetBytes);
  const wrapper = join(dir, 'instrumented.c');
  await writeFile(wrapper, `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <signal.h>\nstatic void checkpoint(const char *name) {\n  const char *wanted=getenv("AGH_MACH_STOP_AT");\n  if(wanted && !strcmp(wanted,name)) { fprintf(stderr,"checkpoint:%s\\n",name);fflush(stderr);raise(SIGSTOP); }\n}\n#define AGH_MACH_CHECKPOINT(label) checkpoint(label)\n#include ${JSON.stringify(join(root,'runtime/backend-mach.c'))}\n`);
  await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', wrapper, '-o', instrumented]);
  const entitlements = join(dir, 'entitlements.plist');
  await writeFile(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>');
  await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlements, targetPath]);
  target = spawn(targetPath, [String(budgetSlot.codeRva)], {stdio:['pipe','pipe','pipe']});
  let stderr = ''; target.stderr.on('data', chunk => stderr += chunk);
  lines = createInterface({input:target.stdout});
  lines.on('line', line => { const result = JSON.parse(line); const reader = readers.shift(); if(reader) reader(result); else queue.push(result); });
  const initial = await receive(), base = BigInt(initial.base), rvas = initial.sites.map(site => String(BigInt(site.address)-base));
  assert.equal(new Set(initial.sites.map(site=>String(BigInt(site.address) >> 14n))).size, 4, 'sites must occupy distinct text pages');
  const slotPage = (base + BigInt(budgetSlot.rva)) >> 14n;
  assert(initial.sites.every(site => (BigInt(site.address) >> 14n) !== slotPage), 'slot publication must precede every entry publication');
  const args = [String(target.pid), targetPath];
  const call = async (op, rest=[], path=executable) => JSON.parse((await exec(path,[op,...args,...rest],{timeout:10000})).stdout);
  const report = async () => { target.stdin.write('s\n'); return receive(); };
  const assertHealthy = async () => {
    const value = await report(); assert.equal(value.errors,0); assert.ok(value.calls > 0);
    for(let i=0;i<4;i++) { assert.equal(value.sites[i].protection,5); assert.deepEqual(value.sites[i].words.slice(1),initial.sites[i].words.slice(1)); }
    assert.equal(value.code.protection,5);
    return value;
  };
  const allocation = await call('prepare',rvas);
  assert.equal(allocation.initialized,false); assert.equal(allocation.targetTokens,null); assert.equal(allocation.active,false);
  assert.equal(BigInt(allocation.code), base + BigInt(budgetSlot.codeRva));
  // Simulate controller death after prepare: a new invocation adopts the saved
  // descriptor even though no entry branch can yet discover the installation.
  const recovered = await call('inspect',[...rvas,allocation.descriptor]);
  assert.equal(recovered.generation,allocation.generation);
  const code = Buffer.alloc(32), manifest = Buffer.alloc(200);
  manifest.write('AGHPLAN2'); manifest.writeBigUInt64LE(base,8); manifest.writeBigUInt64LE(BigInt(allocation.code),16); manifest.writeBigUInt64LE(BigInt(allocation.data),24);
  manifest.writeUInt32LE(allocation.generation,32); manifest.writeUInt32LE(code.length,36);
  initial.sites.forEach((site,index)=>{
    code.writeUInt32LE(0x52800540,index*8); code.writeUInt32LE(0xd65f03c0,index*8+4);
    const offset=40+40*index, address=BigInt(site.address), destination=BigInt(allocation.code)+BigInt(index*8);
    manifest.writeBigUInt64LE(address,offset); site.words.forEach((word,j)=>manifest.writeUInt32LE(word,offset+8+4*j));
    manifest.writeUInt32LE(Number(0x14000000n|(((destination-address)/4n)&0x03ffffffn)),offset+24);
  });
  const manifestPath=join(dir,'plan'), codePath=join(dir,'code'); await writeFile(manifestPath,manifest); await writeFile(codePath,code);
  const installArgs=[manifestPath,codePath,'512000'];
  async function killAt(op,rest,checkpoint) {
    const child=spawn(instrumented,[op,...args,...rest],{env:{...process.env,AGH_MACH_STOP_AT:checkpoint},stdio:['ignore','pipe','pipe']});
    stoppedExecutors.push(child); child.stdout.resume();
    let output=''; await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Executor did not reach '+checkpoint+': '+output)),10000);
      child.stderr.on('data',chunk=>{output+=chunk;if(output.includes('checkpoint:')){clearTimeout(timer);resolve();}});
      child.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error(`Executor exited ${code}/${signal}: ${output}`));});
    });
    const closed=once(child,'close'); child.kill('SIGKILL'); await closed;
    stoppedExecutors=stoppedExecutors.filter(value=>value!==child);
    await delay(15); return assertHealthy();
  }
  await killAt('install',installArgs,'suspended');
  let status=await call('inspect',[...rvas,allocation.descriptor]); assert.equal(status.siteMask,0); assert.equal(status.targetTokens,null); assert.equal(status.active,false);
  // The first RX page publishes the immutable slot and its locator. A dead
  // controller can be replaced without a receipt, before any entry is hooked.
  await killAt('install',installArgs,'remapped');
  status=await call('inspect',rvas); assert.equal(status.siteMask,0); assert.equal(status.targetTokens,null); assert.equal(status.active,false); assert.equal(status.generation,allocation.generation);
  assert.equal((await report()).code.hex,code.toString('hex'));
  status=await call('install',installArgs); assert.equal(status.siteMask,15); assert.equal(status.targetTokens,512000); assert.equal(status.active,true);
  // Restoring the child default keeps the parent consumption hook active.
  status=await call('configure',[allocation.descriptor,'0']); assert.equal(status.targetTokens,null); assert.equal(status.active,true);
  status=await call('configure',[allocation.descriptor,'512000']); assert.equal(status.active,true);
  // An already-complete installation still validates the immutable code.
  const changedCode=Buffer.from(code); changedCode.writeUInt32LE(0x52800560,0);
  const changedPath=join(dir,'changed-code'); await writeFile(changedPath,changedCode);
  await assert.rejects(call('install',[manifestPath,changedPath,'700000']),error => /restart the backend normally/.test(error.stderr));
  assert.equal((await call('inspect',rvas)).targetTokens,512000);
  assert.equal((await assertHealthy()).code.hex,code.toString('hex'),'failed replacement cannot alter in-flight code');
  await call('remove',[allocation.descriptor]);
  status=await call('inspect',rvas); assert.equal(status.siteMask,0); assert.equal(status.generation,allocation.generation);
  // With the retained slot already present, the first remap connects just one
  // entry; subsequent installation adopts that same partially active state.
  await killAt('install',installArgs,'remapped');
  status=await call('inspect',rvas); assert.equal(status.siteMask,1); assert.equal(status.targetTokens,null); assert.equal(status.active,false); assert.equal(status.generation,allocation.generation);
  status=await call('install',installArgs); assert.equal(status.siteMask,15); assert.equal(status.generation,allocation.generation);
  // Real concurrent execution across four different text pages while enabling
  // and disabling. Each CLI exits; no target control thread or monitor exists.
  for(let i=0;i<20;i++) {
    status=await call('configure',[allocation.descriptor,String(100000+i)]); assert.equal(status.targetTokens,100000+i);
    status=await call('remove',[allocation.descriptor]); assert.equal(status.initialized,false); assert.equal(status.targetTokens,null); assert.equal(status.active,false);
    status=await call('install',installArgs); assert.equal(status.generation,allocation.generation);
  }
  // A killed remover has already zeroed the allowance, but its remaining
  // branches still reference retained native memory and can be adopted.
  await killAt('remove',[allocation.descriptor],'remapped');
  status=await call('inspect',rvas); assert.equal(status.siteMask,14); assert.equal(status.targetTokens,null); assert.equal(status.active,false);
  status=await call('install',installArgs); assert.equal(status.siteMask,15);
  status=await call('remove',[allocation.descriptor]); assert.equal(status.siteMask,0);
  const final=await assertHealthy(); assert.deepEqual(final.values,[7,8,9,10]);
  assert.equal(final.code.hex,code.toString('hex'),'removal retains immutable code until target exit');
  assert.equal((await call('inspect',rvas)).generation,allocation.generation);
  target.stdin.end('q\n'); const [exitCode]=await once(target,'close'); assert.equal(exitCode,0,stderr);
  console.log(JSON.stringify({transport:'mach-note',sites:4,pages:5,workers:8,cycles:20,executorDeaths:['suspended','slot-published','partial-install','partial-remove'],sameGeneration:true,codeChangeRefused:true,originalText:'RX',workerErrors:final.errors,calls:final.calls}));
} finally {
  for (const child of stoppedExecutors) child.kill('SIGKILL');
  lines?.close();
  if(target?.exitCode===null) {target.kill('SIGKILL');await once(target,'close');}
  await rm(dir,{recursive:true,force:true});
}
