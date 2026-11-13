/* One host-side generator for the validated Go arm64 configuration boundary.
 * The target executes only these native instructions: no JS runtime, callbacks,
 * stack pushes, new Go objects or retained Go pointers.
 */
'use strict';

function address(value) {
  const result = BigInt(value);
  if (result < 0n || result > 0xffffffffffffffffn || result % 4n) throw new RangeError('Invalid aligned native address');
  return result;
}

function displacement(from, to, bits) {
  const delta = to - from;
  const words = delta / 4n, half = 1n << BigInt(bits - 1);
  if (delta % 4n || words < -half || words >= half) throw new RangeError('Native branch is outside its near code range');
  return Number(BigInt.asUintN(bits, words));
}
const branchWord = (from, to) => (0x14000000 | displacement(from, to, 26)) >>> 0;
const register = name => {
  if (name === 'sp' || name === 'xzr' || name === 'wzr') return 31;
  const match = /^[xw]([0-9]|[12][0-9]|30)$/.exec(name);
  if (!match) throw new Error(`Invalid ARM64 register ${name}`);
  return Number(match[1]);
};
const wide = name => name[0] === 'x' || name === 'sp';

// Only the instructions used below are encoded here. MOVZ/MOVK address loads
// need no literal pool, and direct B continuations preserve all live registers.
class Arm64Writer {
  constructor(pc) { this.base = pc; this.words = []; this.labels = new Map(); this.fixups = []; }
  get offset() { return this.words.length * 4; }
  get pc() { return this.base + BigInt(this.offset); }
  putInstruction(word) { this.words.push(word >>> 0); }
  putMovRegReg(rd, rm) { this.putInstruction((wide(rd) ? 0xaa0003e0 : 0x2a0003e0) | (register(rm) << 16) | register(rd)); }
  putLdrRegAddress(rd, value) {
    value = address(value);
    for (let shift = 0; shift < 64; shift += 16) {
      const part = Number((value >> BigInt(shift)) & 0xffffn);
      this.putInstruction((shift ? 0xf2800000 : 0xd2800000) | ((shift / 16) << 21) | (part << 5) | register(rd));
    }
  }
  putLdrRegU32(rd, value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Invalid native uint32 immediate');
    this.putInstruction(0x52800000 | ((value & 0xffff) << 5) | register(rd));
    if (value >>> 16) this.putInstruction(0x72a00000 | ((value >>> 16) << 5) | register(rd));
  }
  memory(rd, rn, offset, load) {
    const width = wide(rd) ? 8 : 4;
    if (!Number.isInteger(offset) || offset < 0 || offset % width || offset / width >= 4096) throw new RangeError('Native load/store offset is outside its encoding');
    this.putInstruction((width === 8 ? 0xf9000000 : 0xb9000000) | (load ? 0x00400000 : 0) |
      ((offset / width) << 10) | (register(rn) << 5) | register(rd));
  }
  putLdrRegRegOffset(rd, rn, offset) { this.memory(rd, rn, offset, true); }
  putLdrRegReg(rd, rn) { this.memory(rd, rn, 0, true); }
  putStrRegRegOffset(rd, rn, offset) { this.memory(rd, rn, offset, false); }
  putCmpRegReg(rn, rm) { this.putInstruction((wide(rn) ? 0xeb00001f : 0x6b00001f) | (register(rm) << 16) | (register(rn) << 5)); }
  immediate(rd, rn, value, subtract) {
    if (!Number.isInteger(value) || value < 0 || value >= 4096) throw new RangeError('Native arithmetic immediate is outside its encoding');
    this.putInstruction((wide(rd) ? 0x91000000 : 0x11000000) | (subtract ? 0x40000000 : 0) | (value << 10) | (register(rn) << 5) | register(rd));
  }
  putAddRegRegImm(rd, rn, value) { this.immediate(rd, rn, value, false); }
  arithmetic(rd, rn, rm, subtract) { this.putInstruction((wide(rd) ? 0x8b000000 : 0x0b000000) | (subtract ? 0x40000000 : 0) |
    (register(rm) << 16) | (register(rn) << 5) | register(rd)); }
  putAddRegRegReg(rd, rn, rm) { this.arithmetic(rd, rn, rm, false); }
  putSubRegRegReg(rd, rn, rm) { this.arithmetic(rd, rn, rm, true); }
  putLslRegImm(rd, rn, shift) {
    const bits = wide(rd) ? 64 : 32;
    if (!Number.isInteger(shift) || shift < 0 || shift >= bits) throw new RangeError('Invalid native shift');
    this.putInstruction((wide(rd) ? 0xd3400000 : 0x53000000) | (((bits - shift) % bits) << 16) |
      ((bits - shift - 1) << 10) | (register(rn) << 5) | register(rd));
  }
  putBranch(target) { this.putInstruction(branchWord(this.pc, target)); }
  labelBranch(label, word, bits) { this.fixups.push({ offset:this.offset, label, word, bits }); this.putInstruction(word); }
  putBLabel(label) { this.labelBranch(label, 0x14000000, 26); }
  putBCondLabel(condition, label) {
    const cond = { eq:0, ne:1, hs:2, ls:9, le:13 }[condition];
    if (cond === undefined) throw new Error(`Unsupported native condition ${condition}`);
    this.labelBranch(label, 0x54000000 | cond, 19);
  }
  putCbzRegLabel(rn, label) { this.labelBranch(label, (wide(rn) ? 0xb4000000 : 0x34000000) | register(rn), 19); }
  putCbnzRegLabel(rn, label) { this.labelBranch(label, (wide(rn) ? 0xb5000000 : 0x35000000) | register(rn), 19); }
  putLabel(label) {
    if (this.labels.has(label)) throw new Error(`Duplicate native label ${label}`);
    this.labels.set(label, this.offset);
  }
  finish() {
    for (const fix of this.fixups) {
      const target = this.labels.get(fix.label);
      if (target === undefined) throw new Error(`Missing native label ${fix.label}`);
      const delta = displacement(BigInt(fix.offset), BigInt(target), fix.bits);
      this.words[fix.offset / 4] = (fix.word | (fix.bits === 26 ? delta : delta << 5)) >>> 0;
    }
    const result = Buffer.alloc(this.offset);
    this.words.forEach((word, index) => result.writeUInt32LE(word, index * 4));
    return result;
  }
}

/** Generate all four native stubs; the Mach executor only publishes the result. */
function emitStubs({ base, code, data, layout, capacity = 4096 }) {
  base = address(base); code = address(code); data = address(data);
  if (layout?.format !== 1 || layout.profile !== 'go-arm64-regabi-fp-v1') throw new Error('Unsupported backend instruction contract');
  for (const site of Object.values(layout.sites)) {
    if (site.continueRva !== site.rva + 4) throw new Error('Native sites must preserve the instructions after their first word');
  }
  const f = layout.fields;
  const scratch = layout.scratchOffset;
  const starts = [];
  let bytes;
  {
    const w = new Arm64Writer(code);
    const start = () => { starts.push(w.pc); };
    const jump = rva => { w.putBranch(base + BigInt(rva)); };
    // One budget rule for children at resolution and parents at consumption:
    // min(requested, official capacity minus the final output reservation).
    const capLimit = prefix => {
      w.putCmpRegReg('w7', 'w6'); w.putBCondLabel('hs', `${prefix}-capacity-ready`);
      w.putSubRegRegReg('w6', 'w6', 'w7');
      w.putLabel(`${prefix}-capacity-ready`);
      w.putCmpRegReg('w11', 'w6'); w.putBCondLabel('ls', `${prefix}-limit-ready`);
      w.putMovRegReg('w11', 'w6');
      w.putLabel(`${prefix}-limit-ready`);
    };
    const checkpointEnabled = (pointer, done) => {
      w.putLdrRegRegOffset('x7', pointer, f.CheckpointConfig.Enabled); w.putCbzRegLabel('x7', done);
      w.putInstruction(0x394000e7); // ldrb w7, [x7]
      w.putCbzRegLabel('w7', done);
    };
    const typeEquals = (type, label, kind = 'pointerRva') => {
      w.putLdrRegAddress('x10', base + BigInt(layout.typeRefs[type][kind]));
      w.putCmpRegReg('x9', 'x10'); w.putBCondLabel('eq', label);
    };
    const requireType = (itab, type, kind = 'pointerRva') => {
      w.putCbzRegLabel(itab, 'consume-done');
      w.putLdrRegRegOffset('x9', itab, 8);
      w.putLdrRegAddress('x10', base + BigInt(layout.typeRefs[type][kind]));
      w.putCmpRegReg('x9', 'x10'); w.putBCondLabel('ne', 'consume-done');
    };

    start();
    w.putInstruction(layout.sites.reset.originalWords[0]);
    // This closed-over object is dead after ResolveCustomAgentSpec. These three
    // words are non-pointers in every Go stack map and unused until return.
    for (const offset of [scratch, scratch + 8, scratch + 16]) w.putStrRegRegOffset('xzr', 'sp', offset);
    jump(layout.sites.reset.continueRva);

    start();
    // Observe the ModelInfo just returned by the official resolver in x0.
    // Preserve x0, x2, SP, FP and LR; the original Go clamp call stays in place.
    // Verify the exact caller chain before touching the outer frame's scalars.
    w.putMovRegReg('x3', 'x29');
    for (const returnRva of layout.callerReturnRvas) {
      w.putLdrRegRegOffset('x4', 'x3', 8);
      w.putLdrRegAddress('x5', base + BigInt(returnRva));
      w.putCmpRegReg('x4', 'x5'); w.putBCondLabel('ne', 'clamp-done');
      w.putLdrRegReg('x3', 'x3');
    }
    w.putAddRegRegImm('x3', 'x3', 8); // outer SP = outer FP + 8
    w.putCbzRegLabel('x0', 'clamp-done');
    w.putLdrRegRegOffset('w4', 'x0', f.ModelInfo.MaxTokens); // actual resolved ModelInfo.maxTokens
    w.putCmpRegReg('w4', 'wzr'); w.putBCondLabel('le', 'clamp-done');
    w.putLdrRegRegOffset('x5', 'sp', layout.clampCfgSpill); // clampAndValidateConfig's config
    w.putCbzRegLabel('x5', 'clamp-done');
    w.putLdrRegRegOffset('x5', 'x5', f.CascadeConfig.PlannerConfig); // planner
    w.putCbzRegLabel('x5', 'clamp-done');
    w.putStrRegRegOffset('w4', 'x3', scratch);
    w.putLdrRegRegOffset('w6', 'x5', f.CascadePlannerConfig.PlanModel);
    w.putStrRegRegOffset('w6', 'x3', scratch + 4);
    for (const offset of [scratch + 8, scratch + 12, scratch + 16]) w.putStrRegRegOffset('wzr', 'x3', offset);
    w.putLdrRegRegOffset('x5', 'x5', f.CascadePlannerConfig.CustomModelInfoOverride);
    w.putCbzRegLabel('x5', 'clamp-valid');
    w.putLdrRegU32('w6', 1); w.putStrRegRegOffset('w6', 'x3', scratch + 8);
    w.putLdrRegRegOffset('w6', 'x5', f.ModelInfo.ModelId); w.putStrRegRegOffset('w6', 'x3', scratch + 12);
    w.putLdrRegRegOffset('w6', 'x5', f.ModelInfo.MaxTokens); w.putStrRegRegOffset('w6', 'x3', scratch + 16);
    w.putLabel('clamp-valid');
    w.putLdrRegAddress('x7', data); w.putLdrRegRegOffset('w6', 'x7', 48);
    w.putStrRegRegOffset('w6', 'x3', scratch + 20);
    w.putLabel('clamp-done');
    // Only the first load moved. All original conditional branches and their
    // destinations stay at their original addresses.
    w.putInstruction(layout.sites.observe.originalWords[0]);
    jump(layout.sites.observe.continueRva);

    start();
    w.putLdrRegAddress('x16', data);
    w.putLdrRegRegOffset('w17', 'x16', 52); w.putCbzRegLabel('w17', 'done');
    w.putLdrRegRegOffset('x3', 'sp', layout.metadataSpill); // trajectory metadata
    w.putCbzRegLabel('x3', 'parent');
    w.putLdrRegRegOffset('x4', 'x3', f.CortexTrajectoryMetadata.SubagentSpec); w.putCbnzRegLabel('x4', 'child');
    w.putLdrRegRegOffset('x4', 'x3', f.CortexTrajectoryMetadata.ParentConversationId + 8); w.putCbnzRegLabel('x4', 'child');
    w.putLabel('parent');
    w.putLdrRegRegOffset('x3', 'x0', f.CascadeConfig.CheckpointConfig);
    w.putCbzRegLabel('x3', 'done');
    w.putLdrRegRegOffset('w4', 'x3', f.CheckpointConfig.MaxTokenLimit);
    w.putStrRegRegOffset('w4', 'x16', 4); w.putBLabel('done');

    w.putLabel('child');
    w.putMovRegReg('w13', 'wzr'); // before
    w.putMovRegReg('w15', 'wzr'); // after
    w.putMovRegReg('w6', 'wzr'); // capacity
    w.putLdrRegU32('w10', 3); // missing checkpoint
    w.putLdrRegRegOffset('x12', 'x0', f.CascadeConfig.CheckpointConfig);
    w.putCbzRegLabel('x12', 'record');
    w.putLdrRegRegOffset('w13', 'x12', f.CheckpointConfig.MaxTokenLimit); w.putMovRegReg('w15', 'w13');
    w.putLdrRegU32('w10', 2); // restoring default
    w.putLdrRegReg('w11', 'x16'); w.putCbzRegLabel('w11', 'record');
    w.putLdrRegU32('w10', 4); // disabled checkpoint
    checkpointEnabled('x12', 'record');
    w.putLdrRegU32('w10', 5); // capacity observation absent in this resolution
    w.putLdrRegRegOffset('w7', 'sp', scratch + 20); w.putLdrRegRegOffset('w8', 'x16', 48);
    w.putCmpRegReg('w7', 'w8'); w.putBCondLabel('ne', 'record');
    w.putLdrRegRegOffset('w6', 'sp', scratch);
    w.putLdrRegU32('w10', 6); // a later global/dynamic overlay changed the model
    w.putLdrRegRegOffset('x5', 'x0', f.CascadeConfig.PlannerConfig); w.putCbzRegLabel('x5', 'record');
    w.putLdrRegRegOffset('w7', 'x5', f.CascadePlannerConfig.PlanModel); w.putLdrRegRegOffset('w8', 'sp', scratch + 4);
    w.putStrRegRegOffset('w7', 'x16', 24); w.putStrRegRegOffset('w8', 'x16', 28);
    w.putCmpRegReg('w7', 'w8'); w.putBCondLabel('ne', 'record');
    w.putLdrRegRegOffset('x7', 'x5', f.CascadePlannerConfig.CustomModelInfoOverride); w.putLdrRegRegOffset('w8', 'sp', scratch + 8);
    w.putStrRegRegOffset('w8', 'x16', 32); w.putStrRegRegOffset('wzr', 'x16', 36);
    w.putCbzRegLabel('x7', 'no-custom');
    w.putLdrRegU32('w9', 1); w.putStrRegRegOffset('w9', 'x16', 36);
    w.putCbzRegLabel('w8', 'record');
    w.putLdrRegRegOffset('w8', 'x7', f.ModelInfo.ModelId); w.putLdrRegRegOffset('w9', 'sp', scratch + 12);
    w.putCmpRegReg('w8', 'w9'); w.putBCondLabel('ne', 'record');
    w.putLdrRegRegOffset('w8', 'x7', f.ModelInfo.MaxTokens); w.putLdrRegRegOffset('w9', 'sp', scratch + 16);
    w.putCmpRegReg('w8', 'w9'); w.putBCondLabel('ne', 'record');
    w.putBLabel('same-model');
    w.putLabel('no-custom'); w.putCbnzRegLabel('w8', 'record');
    w.putLabel('same-model');
    // Retain the official capacity rule, using the FINAL output reservation.
    w.putLdrRegRegOffset('w7', 'x5', f.CascadePlannerConfig.MaxOutputTokens);
    capLimit('child');
    w.putStrRegRegOffset('w11', 'x12', f.CheckpointConfig.MaxTokenLimit); w.putMovRegReg('w15', 'w11');
    w.putLdrRegU32('w10', 1);
    w.putLabel('record');
    // One aligned 64-bit store keeps before/after together for diagnostics.
    w.putLslRegImm('x14', 'x13', 32); w.putAddRegRegReg('x14', 'x14', 'x15');
    w.putStrRegRegOffset('x14', 'x16', 8);
    w.putStrRegRegOffset('w6', 'x16', 16); w.putStrRegRegOffset('w10', 'x16', 20);
    w.putLabel('done');
    w.putInstruction(layout.sites.final.originalWords[0]);
    jump(layout.sites.final.continueRva);

    start();
    // runInvocationHooks appends each delivered user step before it invokes
    // context summary. X0..X4 are live append arguments; only X5..X17 are scratch.
    w.putLdrRegAddress('x16', data);
    w.putLdrRegRegOffset('w17', 'x16', 52); w.putCbzRegLabel('w17', 'consume-done');
    w.putLdrRegRegOffset('x7', 'x29', 8);
    w.putLdrRegAddress('x8', base + BigInt(layout.consume.parentReturnRva));
    w.putCmpRegReg('x7', 'x8'); w.putBCondLabel('ne', 'consume-done');
    w.putLdrRegRegOffset('x7', 'x4', f.Step.Step);
    requireType('x7', 'StepUserInput');
    w.putLdrRegRegOffset('x7', 'x4', f.Step.Step + 8); w.putCbzRegLabel('x7', 'consume-done');
    for (const offset of [f.StepUserInput.UserInput, f.CortexStepUserInput.UserConfig, f.CascadeConfig.CheckpointConfig]) {
      w.putLdrRegRegOffset('x7', 'x7', offset); w.putCbzRegLabel('x7', 'consume-done');
    }
    w.putLdrRegRegOffset('w11', 'x7', f.CheckpointConfig.MaxTokenLimit);
    w.putCbzRegLabel('w11', 'consume-done'); // absent/default is owned by upstream
    w.putLdrRegReg('x5', 'x29'); w.putAddRegRegImm('x5', 'x5', 8);
    w.putLdrRegRegOffset('x5', 'x5', layout.consume.machineSpill); w.putCbzRegLabel('x5', 'consume-done');
    w.putLdrRegRegOffset('x15', 'x5', f.Machine.input); w.putCbzRegLabel('x15', 'consume-done');

    // The Go interface determines each valid wrapper. No metadata method is
    // called and no Go pointer survives this native invocation.
    w.putLdrRegRegOffset('x7', 'x15', f.RunInput.Trajectory);
    w.putLdrRegRegOffset('x8', 'x15', f.RunInput.Trajectory + 8);
    const wrappers = ['IapiStrippingTrajectory', 'ExecutionIDDecorator', 'StagingDecorator', 'StepEnricherDecorator', 'TruncationDecorator',
      'AccumulatorDecorator', 'AgentStateUpdaterDecorator', 'TelemetryDecorator', 'TranscriptLogDecorator', 'ReplacerDecorator'];
    w.putLabel('trajectory-type');
    w.putCbzRegLabel('x7', 'consume-done'); w.putCbzRegLabel('x8', 'consume-done');
    w.putLdrRegRegOffset('x9', 'x7', 8);
    typeEquals('ProtoTrajectory', 'proto-trajectory'); typeEquals('DbTrajectory', 'db-trajectory');
    for (const type of wrappers) { typeEquals(type, `unwrap-${type}`); typeEquals(type, `unwrap-${type}`, 'rva'); }
    w.putBLabel('consume-done');
    for (const type of wrappers) {
      w.putLabel(`unwrap-${type}`);
      const offset = f[type][type === 'StagingDecorator' ? 'base' : 'Trajectory'];
      w.putLdrRegRegOffset('x7', 'x8', offset);
      w.putLdrRegRegOffset('x8', 'x8', offset + 8); w.putBLabel('trajectory-type');
    }
    w.putLabel('db-trajectory');
    w.putLdrRegRegOffset('x8', 'x8', f.DbTrajectory.pb); w.putCbzRegLabel('x8', 'consume-done');
    w.putLdrRegRegOffset('x7', 'x8', f.Trajectory.Metadata); w.putBLabel('consume-metadata');
    w.putLabel('proto-trajectory');
    w.putLdrRegRegOffset('x7', 'x8', f.ProtoTrajectory.metadata);
    w.putLabel('consume-metadata'); w.putCbzRegLabel('x7', 'consume-parent');
    w.putLdrRegRegOffset('x8', 'x7', f.CortexTrajectoryMetadata.SubagentSpec); w.putCbnzRegLabel('x8', 'consume-done');
    w.putLdrRegRegOffset('x8', 'x7', f.CortexTrajectoryMetadata.ParentConversationId + 8); w.putCbnzRegLabel('x8', 'consume-done');
    w.putLabel('consume-parent');
    w.putLdrRegRegOffset('x5', 'x5', f.Machine.agent); w.putCbzRegLabel('x5', 'consume-done');
    w.putLdrRegRegOffset('x7', 'x5', f.Agent.Serializer);
    w.putLdrRegRegOffset('x8', 'x5', f.Agent.Serializer + 8);
    requireType('x7', 'AugmentedSerializer'); w.putCbzRegLabel('x8', 'consume-done');
    w.putLdrRegRegOffset('x7', 'x8', f.AugmentedSerializer.Serializer);
    w.putLdrRegRegOffset('x8', 'x8', f.AugmentedSerializer.Serializer + 8); w.putCbzRegLabel('x7', 'consume-done');
    w.putLdrRegRegOffset('x9', 'x7', 8);
    typeEquals('DefaultSerializer', 'default-serializer', 'rva');
    typeEquals('DefaultSerializer', 'default-serializer'); w.putBLabel('consume-done');
    w.putLabel('default-serializer'); w.putCbzRegLabel('x8', 'consume-done');
    w.putLdrRegRegOffset('x7', 'x8', f.DefaultSerializer.fallbackConverter);
    w.putLdrRegRegOffset('x8', 'x8', f.DefaultSerializer.fallbackConverter + 8);
    requireType('x7', 'TrajectoryChatConverter'); w.putCbzRegLabel('x8', 'consume-done');
    w.putLdrRegRegOffset('x12', 'x8', f.TrajectoryChatConverter.checkpointConfig); w.putCbzRegLabel('x12', 'consume-done');
    checkpointEnabled('x12', 'consume-done');
    w.putLdrRegRegOffset('x9', 'x8', f.TrajectoryChatConverter.plannerModelInfo); w.putCbzRegLabel('x9', 'consume-done');
    w.putLdrRegRegOffset('w6', 'x9', f.ModelInfo.MaxTokens);
    w.putCmpRegReg('w6', 'wzr'); w.putBCondLabel('le', 'consume-done');
    w.putLdrRegRegOffset('x7', 'x15', f.RunInput.ExecutionMetadata + f.ExecutionMetadata.PlannerConfig);
    w.putCbzRegLabel('x7', 'consume-done');
    w.putLdrRegRegOffset('w7', 'x7', f.CascadePlannerConfig.MaxOutputTokens);
    capLimit('parent');
    w.putStrRegRegOffset('x11', 'x15', f.RunInput.MaxContextTokens);
    w.putStrRegRegOffset('w11', 'x12', f.CheckpointConfig.MaxTokenLimit);
    w.putStrRegRegOffset('w11', 'x16', 4);
    w.putLabel('consume-done');
    w.putInstruction(layout.sites.consume.originalWords[0]);
    jump(layout.sites.consume.continueRva);
    if (w.offset > capacity) throw new Error('Native stubs exceed their allocated code mapping');
    bytes = w.finish();
  }
  const names = ['reset', 'observe', 'final', 'consume'];
  return { code:bytes, entries:Object.fromEntries(names.map((name, index) => [name, starts[index]])),
    sites:names.map((name, index) => ({ name, address:base + BigInt(layout.sites[name].rva),
      originalWord:layout.sites[name].originalWords[0],
      branchWord:branchWord(base + BigInt(layout.sites[name].rva), starts[index]) })), dataSize:64 };
}


module.exports = { emitStubs };
