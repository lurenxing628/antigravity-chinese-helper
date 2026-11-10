import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { launchBackendApp, connectBackendApp } from '../runtime/backend-launch.mjs';
import { CdpClient } from '../runtime/cdp.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Fixture condition timed out');
}
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t, rounds = 1, manualRestart = false, manualReadiness = false) {
  const directory = await mkdtemp(join(tmpdir(), 'helper-backend-launch-'));
  const officialBackendPath = join(directory, 'official-backend');
  const helperBackendPath = join(directory, 'helper-backend');
  const main = join(directory, 'main.cjs');
  const log = join(directory, 'events.jsonl');
  const backend = name => `#!${process.execPath}
process.stdout.write(JSON.stringify({name:${JSON.stringify(name)},args:process.argv.slice(2),pid:process.pid})+'\\n');
if(process.argv.includes('--standalone')){
 const fs=require('node:fs'), round=Number(process.argv.find(v=>v.startsWith('round=')).split('=')[1]);
 const stream=round%2?process.stdout:process.stderr;
 stream.write('x'.repeat(20000)+' listening on tc');
 const ready=()=>{
  stream.write('p port at 34567 for HTTPS\\n');
  if(${manualRestart}){
   const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(directory)}+'/exit-'+round))clearInterval(timer)},20);
  }else setTimeout(()=>{},100);
 };
 if(${manualReadiness}){
  const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(directory)}+'/ready-'+round)){clearInterval(timer);ready();}},20);
 }else setImmediate(ready);
}else setTimeout(()=>{},100);
`;
  await writeFile(officialBackendPath, backend('official'), { mode: 0o755 });
  await writeFile(helperBackendPath, backend('helper'), { mode: 0o755 });
  await writeFile(main, `const cp=require('node:child_process');
const fs=require('node:fs');
const record=value=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');
let round=0;
function next(){
 const args=['--standalone','round='+ ++round];
 const child=cp.spawn(${JSON.stringify(officialBackendPath)},args,{stdio:['ignore','pipe','pipe']});
 record({event:'returned',round,pid:child.pid,realChild:child instanceof cp.ChildProcess,args});
 for(const stream of [child.stdout,child.stderr]){
  let buffer='';
  stream.on('data',chunk=>{
   const lines=(buffer+chunk.toString()).split(/[\\r\\n]/);buffer=lines.pop();
   for(const line of lines){
    if(line.startsWith('{'))record({event:'backend',round,...JSON.parse(line)});
    if(/listening on \\w+ port at (\\d+) for HTTP(S)?\\b/i.test(line))record({event:'ready-consumed',round});
   }
  });
 }
 child.once('exit',()=>{record({event:'exit',round});if(round<${rounds})next();});
}
const ordinary=cp.spawn(${JSON.stringify(officialBackendPath)},['--stamp'],{stdio:['ignore','pipe','pipe']});
ordinary.stdout.on('data',chunk=>record({event:'ordinary',...JSON.parse(chunk)}));
ordinary.once('exit',()=>setTimeout(next,100));
setInterval(()=>{},1000);
`);
  const sessions = [];
  t.after(async () => {
    for (let round = 1; round <= rounds; round++) {
      await writeFile(join(directory, `exit-${round}`), '');
      await writeFile(join(directory, `ready-${round}`), '');
    }
    for (const session of sessions) {
      await session.restore().catch(() => {});
      if (session.process && session.process.exitCode === null && session.process.signalCode === null) {
        const exited = once(session.process, 'exit');
        session.process.kill(); // Only the Node fixture created by this test.
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    async start(onBackendSpawn, onError) {
      try {
        const session = await launchBackendApp({ enabled: true, appExecutable: process.execPath,
          officialBackendPath, helperBackendPath, appArgs: [main], backendArgs: ['--helper-budget=500000'],
          onBackendSpawn, onError });
        sessions.push(session);
        return session;
      } catch (error) {
        if (error.session) sessions.push(error.session);
        throw error;
      }
    },
    async reconnect(receipt, onBackendSpawn) {
      try {
        const session = await connectBackendApp({ enabled: true, ...receipt,
          officialBackendPath, helperBackendPath, backendArgs: ['--helper-budget=500000'], onBackendSpawn });
        sessions.push(session);
        return session;
      } catch (error) {
        if (error.session) sessions.push(error.session);
        throw error;
      }
    },
    requestExit: round => writeFile(join(directory, `exit-${round}`), ''),
    releaseReady: round => writeFile(join(directory, `ready-${round}`), ''),
    async events() {
      try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  };
}

test('spawn returns immediately and fragmented ready lines gate stdout and stderr before app consumption', async t => {
  const f = await fixture(t, 2, false, true);
  const first = gate(), second = gate(), attached = [];
  const session = await f.start(async (pid, { sequence, stage }) => {
    attached.push({ pid, sequence, stage });
    await (sequence === 1 ? first : second).promise;
  });
  if (process.platform === 'darwin') {
    const group = Number(execFileSync('/bin/ps', ['-p', String(session.appPid), '-o', 'pgid='], {encoding:'utf8'}).trim());
    assert.equal(group, session.appPid, 'Application must survive termination of the helper runner process group');
  }
  await until(async () => (await f.events()).some(event => event.event === 'returned'));
  assert.equal(attached.length, 0, 'A successful spawn is not a native-ready signal');
  await f.releaseReady(1);
  await until(() => attached.length === 1);
  assert.equal((await f.events()).some(event => event.event === 'ready-consumed'), false);
  assert.equal((await f.events())[0].name, 'official');
  assert.equal(session.getStatus().phase, 'attaching');
  first.release();
  assert.equal(await session.ready, attached[0].pid);
  await until(async () => (await f.events()).filter(event => event.event === 'returned').length === 2);
  assert.equal(attached.length, 1);
  await f.releaseReady(2);
  await until(() => attached.length === 2);
  assert.equal((await f.events()).filter(event => event.event === 'ready-consumed').length, 1);
  second.release();
  await until(async () => (await f.events()).filter(event => event.event === 'exit').length === 2);
  const events = await f.events();
  assert.deepEqual(attached.map(entry => entry.sequence), [1, 2]);
  assert.deepEqual(attached.map(entry => entry.stage), ['ready', 'ready']);
  for (const event of events.filter(entry => entry.event === 'returned')) {
    assert.equal(event.realChild, true);
    assert.equal(event.pid, attached[event.round - 1].pid);
    assert.deepEqual(event.args, ['--standalone', `round=${event.round}`]);
  }
  for (const event of events.filter(entry => entry.event === 'backend')) {
    assert.equal(event.name, 'helper');
    assert.deepEqual(event.args, ['--standalone', `round=${event.round}`, '--helper-budget=500000']);
  }
});

test('attachment failure leaves an owned pause that restore can release', async t => {
  const f = await fixture(t, 2);
  const failures = [];
  const session = await f.start(async () => { throw new Error('Fixture attach failure'); }, error => failures.push(error));
  await assert.rejects(session.ready, /Fixture attach failure/);
  assert.equal(session.getStatus().phase, 'failed');
  assert.equal(failures.length, 1);
  assert.equal((await f.events()).some(event => event.event === 'ready-consumed'), false);
  await session.restore();
  await until(async () => (await f.events()).filter(event => event.event === 'exit').length === 2);
  const backends = (await f.events()).filter(event => event.event === 'backend');
  assert.deepEqual(backends.map(event => event.name), ['helper', 'official']);
  assert.equal(session.getStatus().phase, 'restored');
});

test('restore during attachment cancels the callback and ignores its late completion', async t => {
  const f = await fixture(t, 2);
  const pending = gate();
  let signal, calls = 0;
  const session = await f.start(async (_pid, context) => { calls++; signal = context.signal; await pending.promise; });
  await until(() => calls === 1);
  await session.restore();
  assert.equal(signal.aborted, true);
  await assert.rejects(session.ready, /restored/);
  pending.release();
  await until(async () => (await f.events()).filter(event => event.event === 'exit').length === 2);
  assert.equal(calls, 1);
  assert.equal(session.getStatus().phase, 'restored');
  assert.deepEqual((await f.events()).filter(event => event.event === 'backend').map(event => event.name), ['helper', 'official']);
});

test('restore reconnects after inspector loss and actually removes the live wrapper', async t => {
  const f = await fixture(t);
  const originalConnect = CdpClient.connect;
  let inspector, url, session;
  CdpClient.connect = async (...args) => {
    url = args[0];
    inspector = await originalConnect(...args);
    return inspector;
  };
  try { session = await f.start(async () => {}); }
  finally { CdpClient.connect = originalConnect; }
  await session.ready;
  await until(async () => (await f.events()).some(event => event.event === 'exit'));
  inspector.close();
  await until(() => session.getStatus().phase === 'failed');
  await session.restore();
  assert.equal(session.getStatus().phase, 'restored');
  const check = await originalConnect(url);
  try {
    const result = await check.call('Runtime.evaluate', {
      expression: `({removed:globalThis.__antigravityChineseBackendAdapter===undefined,
        wrapped:process.getBuiltinModule('child_process').spawn.name==='helperBackendSpawn'})`,
      returnByValue: true,
    });
    assert.deepEqual(result.result.value, { removed: true, wrapped: false });
  } finally { check.close(); }
});

test('a saved connection reattaches its current backend and gates its next restart', async t => {
  const f = await fixture(t, 2, true);
  const originalConnect = CdpClient.connect;
  let inspector, launched, firstMetadata;
  CdpClient.connect = async (...args) => { inspector = await originalConnect(...args); return inspector; };
  try { launched = await f.start(async (_pid, metadata) => { firstMetadata = metadata; }); }
  finally { CdpClient.connect = originalConnect; }
  await launched.ready;
  const receipt = launched.getConnectionInfo();
  assert.equal(firstMetadata.appPid, receipt.appPid);
  assert.equal(firstMetadata.inspectorUrl, receipt.inspectorUrl);
  assert.equal(launched.appPid, launched.process.pid);
  assert.equal(launched.inspectorUrl, receipt.inspectorUrl);
  assert.equal(Object.hasOwn(launched.getStatus(), 'inspectorUrl'), false);
  inspector.close();
  await until(() => launched.getStatus().phase === 'failed');

  const currentGate = gate(), restartedGate = gate(), attached = [];
  let returned = false;
  const reconnecting = f.reconnect(receipt, async (pid, metadata) => {
    attached.push({ pid, ...metadata });
    await (attached.length === 1 ? currentGate : restartedGate).promise;
  }).then(session => { returned = true; return session; });
  await until(() => attached.length === 1);
  assert.equal(attached[0].pid, receipt.backendPid);
  assert.equal(returned, false);
  currentGate.release();
  const connected = await reconnecting;
  assert.equal(connected.process, null);
  assert.deepEqual(connected.getConnectionInfo(), receipt);
  assert.equal(await connected.ready, receipt.backendPid);

  await f.requestExit(1);
  await until(() => attached.length === 2);
  assert.equal(attached[1].sequence, attached[0].sequence + 1);
  assert.equal(attached[1].appPid, receipt.appPid);
  assert.equal(attached[1].inspectorUrl, receipt.inspectorUrl);
  await launched.restore(); // A stale controller must leave its successor alone.
  assert.equal(connected.getStatus().phase, 'attaching');
  assert.equal((await f.events()).filter(event => event.event === 'ready-consumed').length, 1);
  restartedGate.release();
  await f.requestExit(2);
  await until(async () => (await f.events()).filter(event => event.event === 'exit').length === 2);
  assert.equal(connected.getConnectionInfo().backendPid, attached[1].pid);
  await connected.restore();
  const check = await originalConnect(receipt.inspectorUrl);
  try {
    const result = await check.call('Runtime.evaluate', {
      expression: `process.getBuiltinModule('child_process').spawn.name`, returnByValue: true,
    });
    assert.notEqual(result.result.value, 'helperBackendSpawn');
  } finally { check.close(); }
});

test('failed reattachment returns a recoverable session without terminating the existing app', async t => {
  const f = await fixture(t, 1, true);
  const launched = await f.start(async () => {});
  await launched.ready;
  const receipt = launched.getConnectionInfo();
  await launched.restore();
  let failedSession;
  await assert.rejects(f.reconnect(receipt, async () => { throw new Error('Fixture reattach failure'); }), error => {
    assert.match(error.message, /Fixture reattach failure/);
    failedSession = error.session;
    return true;
  });
  assert.deepEqual(failedSession.getConnectionInfo(), receipt);
  assert.equal(failedSession.getStatus().phase, 'failed');
  await failedSession.restore();
  assert.equal(launched.process.exitCode, null);
  assert.equal(launched.process.signalCode, null);
  await f.requestExit(1);
  await until(async () => (await f.events()).some(event => event.event === 'exit'));
});

test('a mismatched saved PID is rejected without debugger control or restore commands', async t => {
  const f = await fixture(t, 1, true);
  const launched = await f.start(async () => {});
  await launched.ready;
  const receipt = launched.getConnectionInfo();
  await launched.restore();
  const originalConnect = CdpClient.connect, calls = [];
  CdpClient.connect = async (...args) => {
    const client = await originalConnect(...args), call = client.call.bind(client);
    client.call = (method, ...params) => { calls.push(method); return call(method, ...params); };
    return client;
  };
  try {
    let failedSession;
    await assert.rejects(f.reconnect({ ...receipt, appPid: receipt.appPid + 1 }, async () => assert.fail('Must not attach')), error => {
      assert.match(error.message, /expected application PID/);
      failedSession = error.session;
      return true;
    });
    await assert.rejects(failedSession.restore(), /unverified main process/);
    assert.deepEqual(calls, ['Runtime.enable', 'Runtime.evaluate']);
  } finally { CdpClient.connect = originalConnect; }
  assert.equal(launched.process.exitCode, null);
  await f.requestExit(1);
  await until(async () => (await f.events()).some(event => event.event === 'exit'));
});

test('the app keeps writing console output after its launcher controller exits', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'helper-console-lifetime-'));
  const official = join(directory, 'official-backend'), helper = join(directory, 'helper-backend');
  const main = join(directory, 'app.cjs'), launcher = join(directory, 'controller.mjs');
  const appPidFile = join(directory, 'app.pid'), trigger = join(directory, 'write-now');
  const success = join(directory, 'writes-completed.json'), failure = join(directory, 'uncaught.json');
  let controller;
  t.after(async () => {
    if (controller && controller.exitCode === null && controller.signalCode === null) {
      const exited = once(controller, 'exit');
      controller.kill();
      await exited;
    }
    let pid;
    try { pid = Number(await readFile(appPidFile, 'utf8')); } catch {}
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await until(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
      });
    }
    await rm(directory, { recursive: true, force: true });
  });
  const backend = `#!${process.execPath}\nprocess.stderr.write('listening on tcp port at 34567 for HTTPS\\n');\nsetTimeout(()=>{},100);\n`;
  await writeFile(official, backend, { mode: 0o755 });
  await writeFile(helper, backend, { mode: 0o755 });
  await writeFile(main, `const fs=require('node:fs'),cp=require('node:child_process');
const {Console}=require('node:console');
fs.writeFileSync(${JSON.stringify(appPidFile)},String(process.pid));
process.on('uncaughtExceptionMonitor',error=>fs.writeFileSync(${JSON.stringify(failure)},JSON.stringify({code:error.code,message:error.message})));
const backend=cp.spawn(${JSON.stringify(official)},['--standalone'],{stdio:['ignore','pipe','pipe']});
backend.stdout.resume();backend.stderr.resume();
let written=false;
setInterval(()=>{
 if(written||!fs.existsSync(${JSON.stringify(trigger)}))return;
 written=true;
 // Do not suppress write errors: the former helper-owned pipes fail here.
 const output=new Console({stdout:process.stdout,stderr:process.stderr,ignoreErrors:false});
 output.info('fixture console.info after controller exit');
 output.error('fixture console.error after controller exit');
 process.stdout.write('fixture stdout after controller exit\\n',error=>{
  if(error)throw error;
  process.stderr.write('fixture stderr after controller exit\\n',error=>{
   if(error)throw error;
   setImmediate(()=>fs.writeFileSync(${JSON.stringify(success)},JSON.stringify({pid:process.pid,parent:process.ppid,writes:4})));
  });
 });
},20);
`);
  const moduleURL = new URL('../runtime/backend-launch.mjs', import.meta.url).href;
  await writeFile(launcher, `import {writeFile} from 'node:fs/promises';
import {launchBackendApp} from ${JSON.stringify(moduleURL)};
let session;
try{
 session=await launchBackendApp({enabled:true,appExecutable:process.execPath,
  appArgs:[${JSON.stringify(main)}],officialBackendPath:${JSON.stringify(official)},
  helperBackendPath:${JSON.stringify(helper)},onBackendSpawn:async()=>{},timeoutMs:5000});
 let timer;
 try{await Promise.race([session.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture attachment timeout')),5000)})]);}
 finally{clearTimeout(timer);}
 await session.restore();
}catch(error){
 session??=error.session;
 if(session){await writeFile(${JSON.stringify(appPidFile)},String(session.appPid));await session.restore().catch(()=>{});}
 process.stderr.write(error.stack+'\\n');process.exitCode=1;
}
`);
  controller = spawn(process.execPath, [launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
  controller.stdout.resume();
  let diagnostics = '';
  controller.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16384); });
  const [code, signal] = await once(controller, 'exit', { signal: AbortSignal.timeout(10000) });
  assert.equal(code, 0, diagnostics);
  assert.equal(signal, null);
  // The original reader process has exited before any of these writes begin.
  await writeFile(trigger, '');
  let completed;
  await until(async () => {
    let uncaught;
    try { uncaught = JSON.parse(await readFile(failure, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(uncaught, undefined, `App raised an uncaught write error: ${JSON.stringify(uncaught)}`);
    try { completed = JSON.parse(await readFile(success, 'utf8')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  assert.equal(completed.writes, 4);
  assert.notEqual(completed.parent, controller.pid);
  assert.doesNotThrow(() => process.kill(completed.pid, 0), 'App must still be alive after writing');
});
