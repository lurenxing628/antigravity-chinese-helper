import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';

const moduleUrl = new URL('../runtime/backend-runtime.mjs', import.meta.url);
const names = ['reset', 'observe', 'final', 'consume'];
const layout = {budgetSlot:{capacity:8192}, sites:Object.fromEntries(names.map((name, index) => [name,
  {rva:4096 + index * 4096, originalWords:[0xaa0203e8, 0xf94007e0, 0xf9400be1, 0xf9400fe2]}]))};
const generatedCode = Buffer.from([0xc0, 0x03, 0x5f, 0xd6]);
const prepared = {base:'0x100000000', code:'0x100080000', data:'0x100084000',
  descriptor:'0x100084040', generation:262177, pageSize:16384};

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return {promise, resolve};
}

// Execute the production runtime with only subprocesses and files replaced.
// The fake executor models target state; budget generation is tested separately.
function fixture({existing = false, targetTokens = 400000, retainedCode = generatedCode} = {}) {
  const changes = [], calls = [], files = new Map(), targets = new Map();
  const behavior = {gates:new Map(), errors:new Map(), exited:new Set(), receiptError:null, configureAfterWriteError:null};
  let generated = 0, temporary = 0;
  const newTarget = initialized => {
    const state = Buffer.alloc(64); state.writeUInt32LE(initialized ? 1 : 0, 52);
    return {...prepared, initialized, state, code:null, codeWrites:0};
  };
  if (existing) {
    const target = newTarget(true);
    target.code = retainedCode;
    target.state.writeUInt32LE(880000, 0);
    targets.set(101, target);
  }
  function wire(target) {
    return {...prepared, initialized:target.initialized, stateHex:target.state.toString('hex')};
  }
  const execFile = () => { throw new Error('Unexpected callback execution'); };
  execFile[promisify.custom] = async (path, args) => {
    assert.equal(path, '/fixture/backend-mach');
    const [operation, rawPid] = args, pid = Number(rawPid);
    calls.push({operation, pid, args});
    const gate = behavior.gates.get(operation);
    if (gate) {
      behavior.gates.delete(operation);
      gate.entered.resolve();
      await gate.promise;
    }
    if (behavior.exited.has(pid)) throw Object.assign(new Error('target gone'), {stderr:'TARGET_EXITED: fixture target gone'});
    const failure = behavior.errors.get(operation);
    if (failure) { behavior.errors.delete(operation); throw failure; }
    let target = targets.get(pid), result;
    if (operation === 'inspect') {
      result = target ? wire(target) : {base:prepared.base, pageSize:prepared.pageSize, initialized:false};
    } else if (operation === 'prepare') {
      target = newTarget(false);
      targets.set(pid, target);
      result = wire(target);
    } else if (operation === 'install') {
      assert.ok(files.has(args[3]), '安装时完整 manifest 已在暂停窗口外写好');
      assert.ok(files.has(args[4]), '安装时完整代码已在暂停窗口外写好');
      const manifest = files.get(args[3]);
      assert.equal(manifest.length, 200);
      assert.equal(manifest.toString('ascii', 0, 8), 'AGHPLAN2');
      assert.equal(manifest.readBigUInt64LE(160), BigInt(prepared.base) + BigInt(layout.sites.consume.rva));
      const code = files.get(args[4]);
      if (target.code && !target.code.equals(code)) throw new Error('Generated code differs from retained installation');
      if (!target.code) { target.code = code; target.codeWrites++; }
      target.initialized = true;
      target.state.writeUInt32LE(Number(args[5]), 0);
      target.state.writeUInt32LE(1, 52);
      result = wire(target);
    } else if (operation === 'configure') {
      target.state.writeUInt32LE(Number(args[4]), 0);
      const error = behavior.configureAfterWriteError;
      behavior.configureAfterWriteError = null;
      if (error) throw error;
      result = wire(target);
    } else if (operation === 'remove') {
      target.initialized = false;
      target.state.writeUInt32LE(0, 52);
      target.state.writeUInt32LE(0, 0);
      result = wire(target);
    } else assert.fail(`Unexpected executor command: ${operation}`);
    return {stdout:JSON.stringify(result)};
  };
  const source = readFileSync(moduleUrl, 'utf8').replace(/^import .*;\n/gm, '')
    .replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));
  const context = vm.createContext({execFile, promisify, dirname, join, fileURLToPath, URL, Buffer,
    tmpdir:() => '/fixture/tmp',
    hook:{emitStubs(options) {
      generated++;
      assert.equal(options.capacity, layout.budgetSlot.capacity, '代码容量使用元数据解析器给出的唯一槽位布局');
      return {code:generatedCode, sites:names.map(name => ({name,
        address:BigInt(prepared.base) + BigInt(layout.sites[name].rva), branchWord:0x14000000}))};
    }},
    mkdtemp:async prefix => `${prefix}${++temporary}`,
    writeFile:async (path, value) => { files.set(path, value); },
    rm:async path => { for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key); },
  });
  vm.runInContext(`${source}\nglobalThis.createRuntime = createBackendRuntime;`, context);
  const runtime = context.createRuntime({machExecutablePath:'/fixture/backend-mach',
    expectedBinaryPath:'/fixture/language_server', layout, targetTokens,
    onChange:status => changes.push(status),
    async onInstallation(value) {
      calls.push({operation:'receipt', ...value});
      if (behavior.receiptError) throw behavior.receiptError;
    }});
  function hold(operation) {
    const gate = {...deferred(), entered:deferred()};
    behavior.gates.set(operation, gate);
    return gate;
  }
  return {runtime, changes, calls, files, behavior, targets, hold, generated:() => generated,
    count:operation => calls.filter(call => call.operation === operation).length};
}

test('同步getStatus不调用执行器，安装定位先落盘并解码真实预算状态', async () => {
  const f = fixture();
  assert.equal(f.runtime.getStatus().attached, false);
  assert.equal(f.calls.length, 0);
  await f.runtime.attach(101);
  assert.equal(f.runtime.getStatus().attached, true);
  const receiptIndex = f.calls.findIndex(call => call.operation === 'receipt');
  assert.ok(receiptIndex < f.calls.findIndex(call => call.operation === 'install'));
  assert.equal(f.calls[receiptIndex].descriptor, prepared.descriptor);
  assert.equal(f.files.size, 0, '安装命令完成后删除临时代码文件');
  const target = f.targets.get(101);
  for (const [offset, value] of [[4,300000], [8,400000], [12,256000], [16,900000],
    [20,1], [24,326], [28,326], [32,0], [36,0]]) target.state.writeUInt32LE(value, offset);
  const {native} = await f.runtime.status();
  assert.equal(native.targetTokens, 400000);
  assert.equal(native.active, true);
  assert.equal(native.parentLimit, 300000);
  assert.equal(native.lastBudget.before, 256000);
  assert.equal(native.lastBudget.applied, 400000);
  assert.equal(native.lastBudget.capacity, 900000);
  assert.equal(native.lastBudget.result, 'applied');
  assert.equal(native.lastBudget.modelBefore, 326);
  const count = f.calls.length;
  f.runtime.getStatus(); f.runtime.getStatus();
  assert.equal(f.calls.length, count);
  await f.runtime.dispose();
  assert.equal(f.targets.get(101).state.readUInt32LE(0), 0);
  assert.equal(f.targets.get(101).state.readUInt32LE(52), 0);
});

test('健康检查失败立即inactive并保留诊断，getStatus不重试', async () => {
  const f = fixture();
  await f.runtime.attach(101);
  f.behavior.errors.set('inspect', new Error('fixture health failed'));
  const status = await f.runtime.status();
  assert.equal(status.attached, false);
  assert.equal(status.lastError, 'fixture health failed');
  assert.equal(f.changes.at(-1).attached, false);
  const count = f.calls.length;
  assert.equal(f.runtime.getStatus().lastError, 'fixture health failed');
  assert.equal(f.calls.length, count);
  await f.runtime.dispose();
  assert.equal(f.count('remove'), 1);
});

test('四处跳转已接通但尚未发布active时不能显示已启用', async () => {
  const f = fixture();
  await f.runtime.attach(101);
  // An installer can die after the last entry remap, before publishing active.
  f.targets.get(101).state.writeUInt32LE(0, 52);
  const status = await f.runtime.status();
  assert.equal(status.native.initialized, true);
  assert.equal(status.native.active, false);
  assert.equal(status.attached, false);
  await f.runtime.dispose();
});

test('目标退出成为inactive，无清理错误；新后台可以重新接入', async () => {
  const f = fixture();
  await f.runtime.attach(101);
  f.behavior.exited.add(101);
  const status = await f.runtime.status();
  assert.equal(status.attached, false);
  assert.equal(status.detachedReason, 'process-terminated');
  assert.equal(status.lastError, null);
  assert.equal(f.changes.at(-1).attached, false);
  await f.runtime.attach(202);
  assert.equal(f.runtime.getStatus().attached, true);
  assert.equal(f.runtime.getStatus().pid, 202);
  f.behavior.exited.add(202);
  await f.runtime.dispose();
  assert.equal(f.runtime.getStatus().lastError, null);
});

for (const [operation, existing, expectedRemovals] of [
  ['inspect', false, 0], ['inspect', true, 1], ['prepare', false, 1], ['install', false, 1],
]) {
  test(`${existing ? '已有安装' : '新安装'} ${operation}期间dispose立即inactive，晚到结果不能复活`, async () => {
    const f = fixture({existing}), gate = f.hold(operation);
    const attaching = f.runtime.attach(101);
    const rejected = assert.rejects(attaching, /后端运行时已退出/);
    await gate.entered.promise;
    const disposing = f.runtime.dispose();
    assert.equal(f.runtime.getStatus().disposed, true);
    assert.equal(f.runtime.getStatus().attached, false);
    const exitIndex = f.changes.length;
    gate.resolve();
    await Promise.all([rejected, disposing]);
    assert.ok(f.changes.slice(exitIndex).every(status => !status.attached));
    assert.equal(f.count('remove'), expectedRemovals);
    if (f.targets.has(101)) assert.equal(f.targets.get(101).state.readUInt32LE(0), 0);
  });
}

test('安装定位落盘失败直接撤销，不发布用户额度', async () => {
  const f = fixture();
  f.behavior.receiptError = new Error('fixture receipt disk full');
  await assert.rejects(f.runtime.attach(101), /receipt disk full/);
  assert.equal(f.count('install'), 0);
  assert.equal(f.count('remove'), 1);
  assert.equal(f.runtime.getStatus().attached, false);
  assert.equal(f.targets.get(101).state.readUInt32LE(0), 0);
  await f.runtime.dispose();
});

test('重连沿同一安装入口验证代码，接管原generation并重新应用持久设置', async () => {
  const f = fixture({existing:true, targetTokens:512000});
  const connected = await f.runtime.attach(101, {descriptor:prepared.descriptor});
  assert.equal(connected.attached, true);
  assert.equal(connected.native.generation, prepared.generation);
  assert.equal(connected.native.targetTokens, 512000);
  assert.equal(f.generated(), 1);
  assert.equal(f.count('prepare'), 0);
  assert.equal(f.count('install'), 1);
  assert.equal(f.count('configure'), 0, '重连不能绕过代码一致性验证直接发布额度');
  assert.equal(f.targets.get(101).codeWrites, 0, '沿用目标保留的相同代码，不覆盖正在执行的stub');
  assert.equal(f.calls.find(call => call.operation === 'inspect').args.at(-1), prepared.descriptor);
  const defaults = await f.runtime.setLimit(null);
  assert.equal(defaults.native.active, true);
  assert.equal(defaults.attached, true);
  assert.equal(f.targets.get(101).state.readUInt32LE(0), 0);
  await f.runtime.dispose();
});

test('已有安装代码不兼容时停止接管，保留不可变代码并撤销预算跳转', async () => {
  const retainedCode = Buffer.from([0x1f, 0x20, 0x03, 0xd5]);
  const f = fixture({existing:true, retainedCode});
  await assert.rejects(f.runtime.attach(101, {descriptor:prepared.descriptor}), /Generated code differs/);
  assert.equal(f.generated(), 1);
  assert.equal(f.count('install'), 1);
  assert.equal(f.count('configure'), 0);
  assert.equal(f.count('remove'), 1);
  assert.ok(f.targets.get(101).code.equals(retainedCode));
  assert.equal(f.targets.get(101).codeWrites, 0);
  assert.equal(f.targets.get(101).state.readUInt32LE(0), 0);
  assert.equal(f.runtime.getStatus().attached, false);
  await f.runtime.dispose();
});

test('撤销后从目标NOTE发现原安装，复用代码槽和generation', async () => {
  const f = fixture();
  const initial = await f.runtime.attach(101);
  await f.runtime.detach();
  assert.equal(f.runtime.getStatus().attached, false);
  assert.equal(f.targets.get(101).state.readUInt32LE(0), 0);
  const reattached = await f.runtime.attach(101);
  assert.equal(reattached.attached, true);
  assert.equal(reattached.native.generation, initial.native.generation);
  assert.equal(reattached.native.descriptor, initial.native.descriptor);
  assert.equal(reattached.native.targetTokens, 400000);
  assert.equal(f.count('prepare'), 1);
  assert.equal(f.count('install'), 2);
  assert.equal(f.targets.get(101).codeWrites, 1);
  await f.runtime.dispose();
});

test('额度发布后执行器失败仍可回滚原值', async () => {
  const f = fixture();
  await f.runtime.attach(101);
  f.behavior.configureAfterWriteError = new Error('fixture executor died after publish');
  await assert.rejects(f.runtime.setLimit(700000), /died after publish/);
  assert.equal(f.runtime.getStatus().attached, false);
  assert.equal(f.targets.get(101).state.readUInt32LE(0), 700000);
  await f.runtime.setLimit(400000);
  assert.equal(f.targets.get(101).state.readUInt32LE(0), 400000);
  assert.equal(f.runtime.getStatus().attached, true);
  assert.equal(f.count('configure'), 2);
  await f.runtime.dispose();
});
