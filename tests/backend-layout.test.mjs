import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBackendLayout } from '../runtime/backend-layout.mjs';

const mov = (rd, rm) => (0xaa0003e0 | (rm << 16) | rd) >>> 0;
const add = (rd, rn, value, subtract = false) => ((subtract ? 0xd1000000 : 0x91000000) | (value << 10) | (rn << 5) | rd) >>> 0;
const ldr = (rt, rn, offset, width = 8) => ((width === 8 ? 0xf9400000 : 0xb9400000) | ((offset / width) << 10) | (rn << 5) | rt) >>> 0;
const str = (rt, rn, offset) => (0xf9000000 | ((offset / 8) << 10) | (rn << 5) | rt) >>> 0;
const ldp = (rt, rt2, rn, offset) => (0xa9400000 | ((offset / 8) << 15) | (rt2 << 10) | (rn << 5) | rt) >>> 0;
const branch = (pc, target, link = false) => ((link ? 0x94000000 : 0x14000000) | (((target - pc) / 4) & 0x03ffffff)) >>> 0;
const cbz = (pc, target, register, nonzero = false) => ((nonzero ? 0xb5000000 : 0xb4000000) | ((((target - pc) / 4) & 0x7ffff) << 5) | register) >>> 0;
const restore = 0xa97ffbfd, ret = 0xd65f03c0;

// A compact fixture retains the real blocks' register and stack relationships.
// Function RVAs, frame size and protobuf offsets can move independently.
function fixture({ relocate = false, reorderFields = false, frameSize = 0x100 } = {}) {
  const buffer = Buffer.alloc(0x700);
  for (let offset = 0; offset < buffer.length; offset += 4) buffer.writeUInt32LE(0xd503201f, offset);
  const definitions = [
    ['getCascadeConfigForTrajectory', 0, 0x200], ['getCascadeConfig', 0x200, 0x80],
    ['GetCascadeConversationalConfigWithExperiment', 0x280, 0x80], ['clampAndValidateConfig', 0x300, 0x100],
    ['ClampCheckpointConfigForModelInfo', 0x400, 0x20], ['GetModelInfoFromPlannerConfig', 0x420, 0x20], ['ResolveCustomAgentSpec', 0x440, 0x20],
    ['runInvocationHooks', 0x460, 0x180], ['stepPreInvocation', 0x5e0, 0x80],
  ];
  const locations = relocate ? [0x210000, 0x101000, 0x305000, 0x121000, 0x401000, 0x203000, 0x117000, 0x501000, 0x601000] :
    [0x1000, 0x4000, 0x7000, 0xa000, 0xc000, 0xd000, 0xe000, 0xf000, 0x11000];
  const functions = Object.fromEntries(definitions.map(([name, fileOffset, size], index) => [name, { name, fileOffset, size, rva:locations[index] }]));
  const field = (offset, size, type = 'fixture') => ({ offset, size, type });
  const types = {
    CascadeConfig:{ size:128, fields:{ PlannerConfig:field(reorderFields ? 24 : 8, 8), CheckpointConfig:field(reorderFields ? 32 : 16, 8) } },
    CheckpointConfig:{ size:256, fields:{ MaxTokenLimit:field(reorderFields ? 28 : 12, 4), Enabled:field(reorderFields ? 176 : 168, 8) } },
    CascadePlannerConfig:{ size:256, fields:{ PlanModel:field(reorderFields ? 72 : 64, 4), CustomModelInfoOverride:field(reorderFields ? 104 : 96, 8), MaxOutputTokens:field(reorderFields ? 112 : 104, 4) } },
    CortexTrajectoryMetadata:{ size:256, fields:{ ParentConversationId:field(reorderFields ? 64 : 56, 16), SubagentSpec:field(reorderFields ? 120 : 112, 8) } },
    ModelInfo:{ size:256, fields:{ ModelId:field(reorderFields ? 16 : 8, 4), MaxTokens:field(reorderFields ? 28 : 20, 4) } },
  };
  const consumptionFields = {
    Machine:{ agent:[0,8], input:[8,8] },
    RunInput:{ Trajectory:[16,16], ExecutionMetadata:[144,80], MaxContextTokens:[224,8] },
    Agent:{ Serializer:[168,16] }, ExecutionMetadata:{ PlannerConfig:[16,8] },
    AugmentedSerializer:{ Serializer:[0,16] }, DefaultSerializer:{ fallbackConverter:[176,16] },
    TrajectoryChatConverter:{ checkpointConfig:[16,8], plannerModelInfo:[32,8] },
    Step:{ Step:[88,16] }, StepUserInput:{ UserInput:[0,8] }, CortexStepUserInput:{ UserConfig:[136,8] },
    ProtoTrajectory:{ metadata:[64,8] }, DbTrajectory:{ pb:[48,8] }, Trajectory:{ Metadata:[152,8] },
    ExecutionIDDecorator:{ Trajectory:[0,16] }, StagingDecorator:{ base:[16,16] },
    StepEnricherDecorator:{ Trajectory:[0,16] }, TruncationDecorator:{ Trajectory:[0,16] },
    AccumulatorDecorator:{ Trajectory:[0,16] }, AgentStateUpdaterDecorator:{ Trajectory:[0,16] },
    TelemetryDecorator:{ Trajectory:[0,16] }, TranscriptLogDecorator:{ Trajectory:[0,16] }, ReplacerDecorator:{ Trajectory:[0,16] },
    IapiStrippingTrajectory:{ Trajectory:[0,16] },
  };
  for (const [name, selected] of Object.entries(consumptionFields)) {
    types[name] = { size:256, fields:Object.fromEntries(Object.entries(selected).map(([fieldName,[offset,size]]) =>
      [fieldName,field(offset + (reorderFields ? 8 : 0),size)])) };
  }
  for (const [index,type] of Object.values(types).entries()) {
    type.rva = (relocate ? 0x700000 : 0x20000) + index * 0x100;
    type.pointerRva = type.rva + 0x80;
  }
  const low = frameSize - 0x48, high = low + 24, array = low - 16, scratch = low + 16, varp = frameSize - 8;
  const metadata = { format:1, arch:'arm64', pointerSize:8, imageBase:relocate ? 0x200000000 : 0x100000000, functions, types,
    scratchGC:{ locals:{ n:2, nbit:20, masks:[Array(3).fill(0), Array(3).fill(0)] }, stackObjects:[
      { offset:low - varp, size:24, ptrBytes:16, mask:[2] }, { offset:high - varp, size:24, ptrBytes:24, mask:[4] },
    ] } };
  function put(name, offset, ...instructions) {
    for (const instruction of instructions) { buffer.writeUInt32LE(instruction >>> 0, functions[name].fileOffset + offset); offset += 4; }
  }
  const pc = (name, offset) => functions[name].rva + offset;
  function smallFrame(name, size) {
    put(name, 0, (0xf8000c00 | (((-size) & 511) << 12) | (31 << 5) | 30) >>> 0,
      (0xf8000000 | ((-8 & 511) << 12) | (31 << 5) | 29) >>> 0, add(29, 31, 8, true));
  }
  const outer = 'getCascadeConfigForTrajectory', manager = 'getCascadeConfig', conv = 'GetCascadeConversationalConfigWithExperiment', clamp = 'clampAndValidateConfig';
  put(outer, 0x10, add(20, 31, frameSize, true), (0xa9000000 | (127 << 15) | (30 << 10) | (20 << 5) | 29) >>> 0,
    add(31, 20, 0), add(29, 31, 8, true), str(4, 31, frameSize + 40));
  put(outer, 0x40, add(4, 31, high), str(4, 31, array), add(4, 31, low), str(4, 31, array + 8),
    mov(0, 1), add(1, 31, array), 0xb27f03e2, mov(3, 2), branch(pc(outer, 0x60), functions.ResolveCustomAgentSpec.rva, true));
  put(outer, 0xb0, mov(8, 2), ldr(0, 31, frameSize + 8), ldr(1, 31, frameSize + 16), ldr(2, 31, frameSize + 24),
    branch(pc(outer, 0xc0), functions[manager].rva, true), cbz(pc(outer, 0xc4), pc(outer, 0x160), 1, true), str(0, 31, 0x80),
    branch(pc(outer, 0xcc), pc(outer, 0x114)));
  put(outer, 0x114, ldr(0, 31, 0x80), ldr(1, 31, 0x70), ldr(2, 31, 0x78), mov(3, 31), mov(4, 31), restore, add(31, 31, frameSize), ret);
  put(outer, 0x160, mov(0, 31), restore, add(31, 31, frameSize), ret);
  for (const name of [manager, conv]) smallFrame(name, 0x40);
  put(manager, 0x30, branch(pc(manager, 0x30), functions[conv].rva, true));
  put(conv, 0x30, branch(pc(conv, 0x30), functions[clamp].rva, true));
  smallFrame(clamp, 0x60);
  put(clamp, 0x0c, ldr(3, 2, types.CascadeConfig.fields.CheckpointConfig.offset), str(2, 31, 0x78), str(3, 31, 0x40),
    cbz(pc(clamp, 0x18), pc(clamp, 0x24), 2), ldr(4, 2, types.CascadeConfig.fields.PlannerConfig.offset),
    branch(pc(clamp, 0x20), pc(clamp, 0x28)), mov(4, 31), (0xa9000000 | (13 << 15) | (1 << 10) | (31 << 5)) >>> 0, mov(2, 4));
  put(clamp, 0x30, branch(pc(clamp, 0x30), functions.GetModelInfoFromPlannerConfig.rva, true), ldr(1, 31, 0x78),
    cbz(pc(clamp, 0x38), pc(clamp, 0x44), 1), ldr(3, 1, types.CascadeConfig.fields.PlannerConfig.offset),
    branch(pc(clamp, 0x40), pc(clamp, 0x48)), mov(3, 31), cbz(pc(clamp, 0x48), pc(clamp, 0x54), 3),
    ldr(2, 3, types.CascadePlannerConfig.fields.MaxOutputTokens.offset, 4), branch(pc(clamp, 0x50), pc(clamp, 0x58)), mov(2, 31), mov(1, 0), ldr(0, 31, 0x40),
    branch(pc(clamp, 0x60), functions.ClampCheckpointConfigForModelInfo.rva, true));
  const hooks = 'runInvocationHooks', step = 'stepPreInvocation';
  put(hooks, 0x10, add(20, 31, 0x160, true), (0xa9000000 | (127 << 15) | (30 << 10) | (20 << 5) | 29) >>> 0,
    add(31, 20, 0), add(29, 31, 8, true));
  put(hooks, 0x20, str(6,31,0x198), str(7,31,0x1a0), str(0,31,0x168), str(1,31,0x170));
  put(hooks, 0x80, ldr(5,31,0x198), ldr(5,5,0x30), ldr(0,31,0x1a0), ldp(1,2,31,0x168), mov(3,4), 0xd63f00a0);
  smallFrame(step,0xb0);
  put(step,0x0c,str(0,31,0xb8));
  put(step,0x30,branch(pc(step,0x30),functions[hooks].rva,true));
  return { buffer, metadata, put, pc, scratch, outer, clamp };
}

test('derives relocated functions, reordered fields and a moved Go frame without a build CL', () => {
  const original = fixture(), moved = fixture({ relocate:true, reorderFields:true, frameSize:0x140 });
  const first = deriveBackendLayout(original.buffer, original.metadata), plan = deriveBackendLayout(moved.buffer, moved.metadata);
  assert.equal(first.sites.reset.rva, original.pc(original.outer, 0xb0));
  assert.equal(plan.sites.reset.rva, moved.pc(moved.outer, 0xb0));
  assert.equal(plan.sites.observe.rva, moved.pc(moved.clamp, 0x34));
  assert.equal(plan.sites.observe.continueRva, moved.pc(moved.clamp, 0x38));
  assert.equal(plan.sites.final.continueRva, moved.pc(moved.outer, 0x124));
  assert.deepEqual(plan.callerReturnRvas, [moved.pc('GetCascadeConversationalConfigWithExperiment', 0x34), moved.pc('getCascadeConfig', 0x34), moved.pc(moved.outer, 0xc4)]);
  assert.equal(plan.metadataSpill, 0x168);
  assert.equal(plan.clampCfgSpill, 0x78);
  assert.equal(plan.scratchOffset, moved.scratch);
  assert.equal(plan.scratchSize, 24);
  assert.equal(plan.fields.CascadeConfig.PlannerConfig, 24);
  assert.equal(plan.fields.ModelInfo.MaxTokens, 28);
  assert.equal(plan.sites.consume.rva,moved.pc('runInvocationHooks',0x80));
  assert.equal(plan.sites.consume.continueRva,moved.pc('runInvocationHooks',0x84));
  assert.deepEqual(plan.consume,{parentReturnRva:moved.pc('stepPreInvocation',0x34),machineSpill:0xb8});
  assert.equal(plan.fields.RunInput.MaxContextTokens,232);
  assert.deepEqual(plan.typeRefs.StepUserInput,{rva:moved.metadata.types.StepUserInput.rva,pointerRva:moved.metadata.types.StepUserInput.pointerRva});
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, 'The installation plan contains only JSON data');
});

test('rejects a pointer in any locals bitmap, including a later GC safe point', () => {
  const value = fixture(), { locals } = value.metadata.scratchGC;
  const bit = (value.scratch - (0x100 - 8 - locals.nbit * 8)) / 8;
  locals.masks[1][Math.floor(bit / 8)] |= 1 << (bit % 8);
  assert.throws(() => deriveBackendLayout(value.buffer, value.metadata), /scratch contains a locals-map pointer/);
});

test('rejects a stack-object pointer even when every locals bitmap says scalar', () => {
  const value = fixture();
  value.metadata.scratchGC.stackObjects.push({ offset:value.scratch - (0x100 - 8), size:8, ptrBytes:8, mask:[1] });
  assert.throws(() => deriveBackendLayout(value.buffer, value.metadata), /scratch contains a stack-object pointer/);
});

test('rejects native use of consumed scratch after initialization', () => {
  const value = fixture();
  // Keep the validated result loads intact and put this read on their incoming path.
  value.put(value.outer, 0xcc, ldr(9, 31, value.scratch), branch(value.pc(value.outer, 0xd0), value.pc(value.outer, 0x114)));
  assert.throws(() => deriveBackendLayout(value.buffer, value.metadata), /scratch is used by post-reset native code/);
});

test('rejects a store moved into scratch through a copied SP-derived register', () => {
  const value = fixture({ frameSize:0x200 });
  value.put(value.outer, 0xcc, add(9, 31, 0x188), mov(11, 9), str(10, 11, 0x10), branch(value.pc(value.outer, 0xd8), value.pc(value.outer, 0x114)));
  deriveBackendLayout(value.buffer, value.metadata);
  value.put(value.outer, 0xd4, str(10, 11, value.scratch - 0x188));
  assert.throws(() => deriveBackendLayout(value.buffer, value.metadata), /scratch is used by post-reset native code/);
});

test('不同访存形式的 SIMD 目标寄存器不影响 GPR 栈别名', () => {
  for (const [instruction, encoded, clearsAlias] of [
    ['ldr q6,[sp,#0x100]', 0x3dc043e6, false],
    ['str q6,[sp,#0x100]', 0x3d8043e6, false],
    ['ldur q6,[sp,#0xf0]', 0x3ccf03e6, false],
    ['stur q6,[sp,#0xf0]', 0x3c8f03e6, false],
    ['ldp q5,q6,[sp,#0x100]', 0xad481be5, false],
    ['ldp d5,d6,[sp,#0x100]', 0x6d501be5, false],
    ['ldr q6,[x0,x1]', 0x3ce16806, false],
    ['ldr x6,[x0,x1]', 0xf8616806, true],
    ['ldr x6,[sp,#0x100]', 0xf94083e6, true],
    ['ldrsw x6,[sp,#0x100]', 0xb98103e6, true],
    ['ldp x5,x6,[sp,#0x100]', 0xa9501be5, true],
    ['str x6,[sp,#0x100]', 0xf90083e6, false],
  ]) {
    const value = fixture({ frameSize:0x200 });
    value.put(value.outer, 0xcc, add(6, 31, 0x100), encoded, str(31, 6, value.scratch - 0x100),
      branch(value.pc(value.outer, 0xd8), value.pc(value.outer, 0x114)));
    const derive = () => deriveBackendLayout(value.buffer, value.metadata);
    if (clearsAlias) assert.doesNotThrow(derive, instruction);
    else assert.throws(derive, /scratch is used by post-reset native code/, instruction);
  }
});

test('在暂存区边界检查 SIMD 立即数及成对访存宽度', () => {
  for (const [instruction, encoded, nextOffset] of [
    ['ldr q6,[x9,#0xb0]', 0x3dc02d26, 1 << 10],
    ['str q6,[x9,#0xb0]', 0x3d802d26, 1 << 10],
    ['ldur q6,[x9,#0xb0]', 0x3ccb0126, 1 << 12],
    ['stur q6,[x9,#0xb0]', 0x3c8b0126, 1 << 12],
    ['ldp q5,q6,[x9,#0xa0]', 0xad451925, 1 << 15],
    ['stp d5,d6,[x9,#0xb0]', 0x6d0b1925, 1 << 15],
  ]) {
    const value = fixture({ frameSize:0x200 });
    // 每次访存恰好止于暂存区起点；将编码偏移递增一档后便与暂存区重叠。
    value.put(value.outer, 0xcc, add(9, 31, 0x108), encoded,
      branch(value.pc(value.outer, 0xd4), value.pc(value.outer, 0x114)));
    assert.doesNotThrow(() => deriveBackendLayout(value.buffer, value.metadata), instruction);
    value.put(value.outer, 0xd0, encoded + nextOffset);
    assert.throws(() => deriveBackendLayout(value.buffer, value.metadata), /scratch is used by post-reset native code/, instruction);
  }
});

test('在 GPR 地址命名空间中跟踪 SIMD 前后索引写回', () => {
  for (const [instruction, encoded] of [
    ['ldr q6,[x9],#0x20', 0x3cc20526],
    ['str q6,[x9,#0x20]!', 0x3c820d26],
    ['ldp q5,q6,[x9],#0x20', 0xacc11925],
    ['stp q5,q6,[x9,#0x20]!', 0xad811925],
  ]) {
    const value = fixture({ frameSize:0x200 });
    value.put(value.outer, 0xcc, add(9, 31, 0x100), encoded, str(31, 9, value.scratch - 0x120),
      branch(value.pc(value.outer, 0xd8), value.pc(value.outer, 0x114)));
    assert.throws(() => deriveBackendLayout(value.buffer, value.metadata), /scratch is used by post-reset native code/, instruction);
  }
});

test('拒绝 SIMD 寄存器冒充标量加载、溢出存储及栈帧契约', () => {
  for (const [name, offset, vectorBits, error] of [
    ['getCascadeConfigForTrajectory', 0xb4, 0x04000000, /configuration-call register preparation changed/],
    ['getCascadeConfigForTrajectory', 0x20, 0x04000000, /metadata argument spill/],
    ['getCascadeConfig', 0, 0x04000000, /Go frame for/],
    ['getCascadeConfig', 4, 0x04000000, /Go frame for/],
    ['getCascadeConfigForTrajectory', 0x14, 0xc4000000, /Go frame for/],
    ['clampAndValidateConfig', 0x28, 0xc4000000, /model getter argument preparation changed/],
  ]) {
    const value = fixture();
    const original = value.buffer.readUInt32LE(value.metadata.functions[name].fileOffset + offset);
    // 将 X 换为 D 保留访存宽度、偏移和寄存器编号，但不保留其 ABI。
    value.put(name, offset, original ^ vectorBits);
    assert.throws(() => deriveBackendLayout(value.buffer, value.metadata), error, `${name}+0x${offset.toString(16)}`);
  }
});

test('rejects a changed success return ABI and preserves native branches after a redirected word', () => {
  const wrongReturn = fixture();
  wrongReturn.put(wrongReturn.outer, 0x124, mov(4, 1));
  assert.throws(() => deriveBackendLayout(wrongReturn.buffer, wrongReturn.metadata), /successful trajectory epilogue/);
  const interiorBranch = fixture();
  // This targets the original CBZ immediately after the one redirected load.
  interiorBranch.put(interiorBranch.clamp, 0x68,
    branch(interiorBranch.pc(interiorBranch.clamp, 0x68), interiorBranch.pc(interiorBranch.clamp, 0x38)));
  const plan = deriveBackendLayout(interiorBranch.buffer, interiorBranch.metadata);
  assert.equal(plan.sites.observe.continueRva, interiorBranch.pc(interiorBranch.clamp, 0x38));
});

test('rejects changed consumed-step arguments, trajectory method, or machine frame before native publication', () => {
  for (const [name,offset,instruction,error] of [
    ['runInvocationHooks',0x90,mov(3,0),/delivered-step append boundary/],
    ['runInvocationHooks',0x84,ldr(5,5,0x38),/delivered-step append boundary/],
    ['stepPreInvocation',0x0c,str(0,31,0xc0),/pre-invocation machine spill changed/],
  ]) {
    const value=fixture();
    value.put(name,offset,instruction);
    assert.throws(()=>deriveBackendLayout(value.buffer,value.metadata),error);
  }
});
