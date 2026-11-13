import test from 'node:test';
import assert from 'node:assert/strict';
import generator from '../runtime/backend-hook.js';

const { emitStubs } = generator;
const base = 0x100000000n, code = 0x108000000n, data = 0x108004000n;
const layout = {
  format:1, profile:'go-arm64-regabi-fp-v1', scratchOffset:0x280, metadataSpill:0x328, clampCfgSpill:0x78,
  callerReturnRvas:[0x42004, 0x32004, 0x12004],
  consume:{ parentReturnRva:0x50124, machineSpill:0xb8 },
  fields:{
    ModelInfo:{ MaxTokens:20, ModelId:8 }, CascadeConfig:{ PlannerConfig:8, CheckpointConfig:16 },
    CascadePlannerConfig:{ PlanModel:64, CustomModelInfoOverride:96, MaxOutputTokens:104 },
    CortexTrajectoryMetadata:{ SubagentSpec:112, ParentConversationId:56 },
    CheckpointConfig:{ MaxTokenLimit:12, Enabled:168 },
    Machine:{ agent:0, input:8 }, RunInput:{ Trajectory:16, ExecutionMetadata:144, MaxContextTokens:224 },
    Agent:{ Serializer:168 }, ExecutionMetadata:{ PlannerConfig:16 }, AugmentedSerializer:{ Serializer:0 },
    DefaultSerializer:{ fallbackConverter:176 }, TrajectoryChatConverter:{ checkpointConfig:16, plannerModelInfo:32 },
    Step:{ Step:88 }, StepUserInput:{ UserInput:0 }, CortexStepUserInput:{ UserConfig:136 },
    ProtoTrajectory:{ metadata:64 }, DbTrajectory:{ pb:48 }, Trajectory:{ Metadata:152 },
    ExecutionIDDecorator:{ Trajectory:0 }, StagingDecorator:{ base:16 }, StepEnricherDecorator:{ Trajectory:0 },
    TruncationDecorator:{ Trajectory:0 }, AccumulatorDecorator:{ Trajectory:0 }, AgentStateUpdaterDecorator:{ Trajectory:0 },
    TelemetryDecorator:{ Trajectory:0 }, TranscriptLogDecorator:{ Trajectory:0 }, ReplacerDecorator:{ Trajectory:0 },
    IapiStrippingTrajectory:{ Trajectory:0 },
  },
  sites:{
    reset:{ rva:0x12000, continueRva:0x12004, originalWords:[0xaa0203e8, 0xf94187e0, 0xf9418be1, 0xf9418fe2] },
    observe:{ rva:0x22000, continueRva:0x22004, originalWords:[0xf9403fe1, 0xb4000061, 0xf9400423, 0x14000002] },
    final:{ rva:0x13000, continueRva:0x13004, originalWords:[0xaa1f03e3, 0xaa1f03e4, 0xa97ffbfd, 0x910c03ff] },
    consume:{ rva:0x50000, continueRva:0x50004, originalWords:[0xf940cfe5, 0xf94018a5, 0xf940d3e0, 0xa9560be1] },
  },
};
layout.typeRefs=Object.fromEntries(Object.keys(layout.fields).map((name,index)=>
  [name,{rva:0x700000 + index * 0x100,pointerRva:0x700080 + index * 0x100}]));
function destination(word, pc) {
  assert.equal(word >>> 26, 5, 'Continuation must use a register-preserving B instruction');
  let immediate = word & 0x03ffffff;
  if (immediate >= 0x02000000) immediate -= 0x04000000;
  return pc + BigInt(immediate * 4);
}

test('each entry redirects one word and returns to the still-in-place following instruction', () => {
  const emitted = emitStubs({base, code, data, layout});
  const names = ['reset', 'observe', 'final', 'consume'];
  assert(emitted.code.length <= 4096);
  for (let index = 0; index < names.length; index++) {
    const name = names[index], entry = emitted.entries[name], site = emitted.sites[index];
    assert.equal(site.originalWord, layout.sites[name].originalWords[0]);
    assert.equal(destination(site.branchWord, site.address), entry);
    const end = index + 1 < names.length ? Number(emitted.entries[names[index + 1]] - code) : emitted.code.length;
    const branchPc = code + BigInt(end - 4);
    assert.equal(destination(emitted.code.readUInt32LE(end - 4), branchPc), base + BigInt(layout.sites[name].rva + 4));
    if (name === 'reset') assert.equal(emitted.code.readUInt32LE(Number(entry - code)), site.originalWord);
    else assert.equal(emitted.code.readUInt32LE(end - 8), site.originalWord);
    if (name === 'final' || name === 'consume') {
      const offset=Number(entry-code);
      assert.equal(emitted.code.readUInt32LE(offset+16),0xb9403611,'entry must load active from [data,#52]');
      const gate=emitted.code.readUInt32LE(offset+20);
      assert.equal((gate & 0xff00001f) >>> 0,0x34000011,'inactive entry must CBZ w17');
      let immediate=(gate >>> 5) & 0x7ffff;
      if(immediate >= 0x40000) immediate-=0x80000;
      assert.equal(entry+20n+BigInt(immediate*4),code+BigInt(end-8),'inactive entry must reach the preserved original instruction');
    }
  }
  // Reset clears all three scalar scratch words before returning to the original
  // register loads. No copied stack epilogue or indirect continuation is needed.
  assert.equal(emitted.entries.observe - emitted.entries.reset, 20n);
});

test('refuses unreachable code, insufficient capacity, and old multiword continuation contracts', () => {
  assert.throws(() => emitStubs({base, code:base + 0x8012000n, data, layout}), /near code range/);
  assert.throws(() => emitStubs({base, code:base - 0x8000000n, data, layout}), /near code range/);
  assert.throws(() => emitStubs({base, code, data, layout, capacity:64}), /exceed/);
  const old = structuredClone(layout);
  old.sites.observe.continueRva += 16;
  assert.throws(() => emitStubs({base, code, data, layout:old}), /preserve the instructions/);
});
