/* Antigravity language_server / validated Go arm64 configuration boundary.
 * Go executes only short ARM64 branches: no JS, C callbacks, stack pushes,
 * new Go objects, or retained Go pointers. JavaScript manages installation.
 */
'use strict';

let state = null;
let memory = null;
let layout = null;
let initialized = false;

function validateLimit(tokens) {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 0xffffffff)) {
    throw new Error('Invalid subagent context limit');
  }
}

function status() {
  if (!state) return {initialized:false, targetTokens:null, lastBudget:null};
  const target = state.readU32();
  const pair = state.add(8).readU64();
  const result = state.add(20).readU32();
  const reasons = ['unobserved', 'applied', 'default', 'missing-checkpoint', 'disabled-checkpoint', 'missing-capacity', 'changed-model'];
  return {initialized, targetTokens:target || null, parentLimit:state.add(4).readU32() || null,
    lastBudget:result ? {before:Number(pair.shr(32)), applied:Number(pair.and(uint64('0xffffffff'))),
      capacity:state.add(16).readU32() || null, result:reasons[result] ?? 'unknown',
      modelBefore:state.add(28).readU32(), modelAfter:state.add(24).readU32(),
      customBefore:state.add(32).readU32(), customAfter:state.add(36).readU32()} : null};
}

function configure(tokens) {
  validateLimit(tokens);
  if (!initialized) throw new Error('Backend agent is not initialized');
  state.writeU32(tokens ?? 0);
  return status();
}

function dispose() {
  if (state) state.writeU32(0);
  // Stubs own their continuations and mappings. Reverting a redirect never
  // frees code that a Go goroutine may already be executing.
  memory?.revert();
  initialized = false;
  return status();
}

function emitStubs(base, code, data, capacity) {
  const f = layout.fields;
  const scratch = layout.scratchOffset;
  const starts = [];
  {
    const w = new Arm64Writer(code, {pc:code});
    const start = () => { starts.push(w.pc); };
    const finish = () => w.flush();
    const jump = rva => {
      w.putLdrRegAddress('x17', base.add(rva));
      w.putBrReg('x17');
    };

    start();
    for (const word of layout.sites.reset.originalWords) w.putInstruction(word);
    // This closed-over object is dead after ResolveCustomAgentSpec. These three
    // words are non-pointers in every Go stack map and unused until return.
    for (const offset of [scratch, scratch + 8, scratch + 16]) w.putStrRegRegOffset('xzr', 'sp', offset);
    jump(layout.sites.reset.continueRva);
    finish();

    start();
    // Observe the ModelInfo just returned by the official resolver in x0.
    // Preserve x0, x2, SP, FP and LR; the original Go clamp call stays in place.
    // Verify the exact caller chain before touching the outer frame's scalars.
    w.putMovRegReg('x3', 'x29');
    for (const returnRva of layout.callerReturnRvas) {
      w.putLdrRegRegOffset('x4', 'x3', 8);
      w.putLdrRegAddress('x5', base.add(returnRva));
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
    // Recreate the displaced cfg/planner selection. Its conditional branches
    // were PC-relative; the continuation is our own, not a Gum trampoline.
    w.putLdrRegRegOffset('x1', 'sp', layout.clampCfgSpill);
    w.putMovRegReg('x3', 'xzr');
    w.putCbzRegLabel('x1', 'observe-replayed');
    w.putLdrRegRegOffset('x3', 'x1', f.CascadeConfig.PlannerConfig);
    w.putLabel('observe-replayed');
    jump(layout.sites.observe.continueRva);
    finish();

    start();
    w.putLdrRegAddress('x16', data);
    w.putLdrRegRegOffset('x3', 'sp', layout.metadataSpill); // trajectory metadata
    w.putCbzRegLabel('x3', 'parent');
    w.putLdrRegRegOffset('x4', 'x3', f.CortexTrajectoryMetadata.SubagentSpec); w.putCbnzRegLabel('x4', 'child');
    w.putLdrRegRegOffset('x4', 'x3', f.CortexTrajectoryMetadata.ParentConversationId + Process.pointerSize); w.putCbnzRegLabel('x4', 'child');
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
    w.putLdrRegRegOffset('x3', 'x12', f.CheckpointConfig.Enabled); w.putCbzRegLabel('x3', 'record');
    w.putInstruction(0x39400063); // ldrb w3, [x3]
    w.putCbzRegLabel('w3', 'record');
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
    w.putCmpRegReg('w7', 'w6'); w.putBCondLabel('hs', 'capacity-ready');
    w.putSubRegRegReg('w6', 'w6', 'w7');
    w.putLabel('capacity-ready');
    w.putCmpRegReg('w11', 'w6'); w.putBCondLabel('ls', 'limit-ready');
    w.putMovRegReg('w11', 'w6');
    w.putLabel('limit-ready');
    w.putStrRegRegOffset('w11', 'x12', f.CheckpointConfig.MaxTokenLimit); w.putMovRegReg('w15', 'w11');
    w.putLdrRegU32('w10', 1);
    w.putLabel('record');
    // One aligned 64-bit store keeps before/after together for diagnostics.
    w.putLslRegImm('x14', 'x13', 32); w.putAddRegRegReg('x14', 'x14', 'x15');
    w.putStrRegRegOffset('x14', 'x16', 8);
    w.putStrRegRegOffset('w6', 'x16', 16); w.putStrRegRegOffset('w10', 'x16', 20);
    w.putLabel('done');
    for (const word of layout.sites.final.originalWords) w.putInstruction(word);
    w.putRet(); // The copied epilogue restored the real Go return address.
    finish();
    if (w.offset > capacity) throw new Error('Native stubs exceed their allocated code mapping');
    w.dispose();
  }
  return starts;
}

function initialize(expectedBinaryPath, tokens, plan) {
  validateLimit(tokens);
  if (initialized) throw new Error('Backend agent is already initialized');
  const module = Process.mainModule, base = module.base;
  if (Process.arch !== 'arm64' || module.path !== expectedBinaryPath) throw new Error('Unexpected backend executable');
  if (plan?.format !== 1 || plan.profile !== 'go-arm64-regabi-fp-v1') throw new Error('Unsupported backend instruction contract');
  // The host derives this contract from the copied executable's symbols, types,
  // stack maps and instructions. Check the actual loaded code before touching it.
  for (const site of Object.values(plan.sites)) {
    site.originalWords.forEach((word, index) => {
      if (base.add(site.rva + index * 4).readU32() !== word) throw new Error('Loaded backend code does not match its metadata');
    });
  }
  layout = plan;
  const codeSize = 4096;
  memory = BackendCodeMemory.create({ codeSize, dataSize:64 });
  state = memory.data;
  // Retained mappings cannot share a page. Its page number is an exact unique
  // generation in this supported address range, including across script reloads.
  const pageNumber = uint64(state.toString()).shr(Math.log2(Process.pageSize));
  if (pageNumber.compare(uint64(0xffffffff)) > 0 || pageNumber.equals(uint64(0))) {
    throw new Error('Native mapping is outside the supported generation range');
  }
  state.add(48).writeU32(Number(pageNumber));
  try {
    const starts = emitStubs(base, memory.code, state, codeSize);
    memory.sealCode();
    for (const [index, name] of ['reset', 'observe', 'final'].entries()) {
      memory.replaceFast(base.add(layout.sites[name].rva), starts[index]);
    }
    initialized = true;
    return configure(tokens);
  } catch (error) { dispose(); throw error; }
}

rpc.exports = {initialize, configure, status, dispose};
