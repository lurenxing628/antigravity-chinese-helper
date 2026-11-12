// This is one Go arm64 register-ABI compiler profile. It recognizes only the
// three native blocks we replace; a different register/stack contract is refused.
const profile = 'go-arm64-regabi-fp-v1';
const unsupported = message => new Error(`Unsupported backend ABI: ${message}`);
const check = (condition, message) => { if (!condition) throw unsupported(message); };
const masked = (word, mask, value) => ((word & mask) >>> 0) === value;
const signed = (value, bits) => value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
const overlaps = (start, size, other, length) => start < other + length && other < start + size;

function immediate(word) {
  if (!masked(word, 0x7f000000, 0x11000000) && !masked(word, 0x7f000000, 0x51000000)) return null;
  return { rd:word & 31, rn:(word >>> 5) & 31, value:((word >>> 10) & 4095) * (word & 0x00400000 ? 4096 : 1),
    subtract:Boolean(word & 0x40000000), wide:Boolean(word & 0x80000000) };
}
const move = (word, rd, rm) => word === ((0xaa0003e0 | (rm << 16) | rd) >>> 0);
const moveZero = (word, rd) => move(word, rd, 31);

// Only scalar/vector immediate-addressed loads/stores are needed for stack
// liveness. Register-indexed SP addressing is rejected rather than guessed.
function memory(word) {
  const rn = (word >>> 5) & 31, rt = word & 31, vector = Boolean(word & 0x04000000);
  if (masked(word, 0x3a000000, 0x28000000)) {
    const opc = word >>> 30;
    const width = vector ? 4 * 2 ** opc : opc === 2 ? 8 : 4;
    const mode = (word >>> 23) & 3;
    return { rn, rt, vector, rt2:(word >>> 10) & 31, offset:signed((word >>> 15) & 127, 7) * width,
      size:width * 2, width, load:Boolean(word & 0x00400000), writeback:mode === 1 || mode === 3, post:mode === 1 };
  }
  const width = vector && word & 0x00800000 ? 16 : 2 ** (word >>> 30);
  // SIMD 的位 23 选择 Q 宽度；标量的位 23 选择符号扩展加载。
  const load = Boolean(word & (vector ? 0x00400000 : 0x00c00000));
  if (masked(word, 0x3b000000, 0x39000000)) {
    return { rn, rt, vector, offset:((word >>> 10) & 4095) * width, size:width, width,
      load, writeback:false };
  }
  if (masked(word, 0x3b200000, 0x38000000)) {
    const mode = (word >>> 10) & 3;
    return { rn, rt, vector, offset:signed((word >>> 12) & 511, 9), size:width, width,
      load, writeback:mode === 1 || mode === 3, post:mode === 1 };
  }
  if (masked(word, 0x3b200c00, 0x38200800)) return { rn, rt, vector, indexed:true, load };
  return null;
}

function load(word, rt, rn, offset, width = 8) {
  const value = memory(word);
  return value?.load && !value.vector && !value.writeback && value.rt === rt && value.rn === rn && value.offset === offset && value.size === width;
}
function store(word, rt, rn, offset, width = 8) {
  const value = memory(word);
  return value && !value.vector && !value.load && !value.writeback && value.rt === rt && value.rn === rn && value.offset === offset && value.size === width;
}
function jump(word, pc) {
  if (masked(word, 0xfc000000, 0x94000000)) return { call:true, target:pc + signed(word & 0x03ffffff, 26) * 4 };
  if (masked(word, 0xfc000000, 0x14000000)) return { target:pc + signed(word & 0x03ffffff, 26) * 4 };
  if (masked(word, 0xff000010, 0x54000000)) return { conditional:true, target:pc + signed((word >>> 5) & 0x7ffff, 19) * 4 };
  if (masked(word, 0x7e000000, 0x34000000)) return { conditional:true, target:pc + signed((word >>> 5) & 0x7ffff, 19) * 4 };
  if (masked(word, 0x7e000000, 0x36000000)) return { conditional:true, target:pc + signed((word >>> 5) & 0x3fff, 14) * 4 };
  return null;
}
function cbz(word, pc, register, target, nonzero = false) {
  return masked(word, 0xff00001f, (nonzero ? 0xb5000000 : 0xb4000000) + register) && jump(word, pc)?.target === target;
}
const pairFrameRestore = word => word === 0xa97ffbfd; // ldp x29,x30,[sp,#-8]
const ret = word => word === 0xd65f03c0;

/** Derive only the native contracts used by backend-hook.js; never invokes Go. */
export function deriveBackendLayout(buffer, metadata) {
  check(Buffer.isBuffer(buffer), 'expected an executable Buffer');
  check(metadata?.arch === 'arm64' && metadata.pointerSize === 8, 'expected arm64 / 8-byte pointers');
  const names = ['getCascadeConfigForTrajectory', 'getCascadeConfig', 'GetCascadeConversationalConfigWithExperiment',
    'clampAndValidateConfig', 'ClampCheckpointConfigForModelInfo', 'GetModelInfoFromPlannerConfig', 'ResolveCustomAgentSpec'];
  const functions = {};
  for (const name of names) {
    const value = metadata.functions?.[name];
    check(value && [value.rva, value.size, value.fileOffset].every(Number.isSafeInteger) && value.rva >= 0 &&
      value.size > 0 && value.size % 4 === 0 && value.fileOffset >= 0 && value.fileOffset <= buffer.length - value.size,
    `missing or invalid function ${name}`);
    functions[name] = value;
  }
  const word = (fn, rva) => {
    check(rva % 4 === 0 && rva >= fn.rva && rva <= fn.rva + fn.size - 4, 'instruction is outside its function');
    return buffer.readUInt32LE(fn.fileOffset + rva - fn.rva);
  };
  const words = (fn, rva, count) => Array.from({ length:count }, (_, index) => word(fn, rva + 4 * index));
  const entries = fn => Array.from({ length:fn.size / 4 }, (_, index) => {
    const pc = fn.rva + 4 * index;
    return { pc, word:word(fn, pc) };
  });
  const unique = (values, label) => {
    check(values.length === 1, `${label} must have exactly one match`);
    return values[0];
  };
  const call = (caller, callee) => unique(entries(caller).filter(item => {
    const branch = jump(item.word, item.pc);
    return branch?.call && branch.target === callee.rva;
  }), `call to ${callee.name ?? callee.rva}`).pc;

  const fields = {};
  const required = {
    CascadeConfig:{ PlannerConfig:8, CheckpointConfig:8 },
    CheckpointConfig:{ MaxTokenLimit:4, Enabled:8 },
    CascadePlannerConfig:{ PlanModel:4, CustomModelInfoOverride:8, MaxOutputTokens:4 },
    CortexTrajectoryMetadata:{ ParentConversationId:16, SubagentSpec:8 },
    ModelInfo:{ ModelId:4, MaxTokens:4 },
  };
  for (const [typeName, wanted] of Object.entries(required)) {
    const type = metadata.types?.[typeName];
    check(type && Number.isSafeInteger(type.size), `missing type ${typeName}`);
    fields[typeName] = {};
    for (const [fieldName, size] of Object.entries(wanted)) {
      const field = type.fields?.[fieldName];
      check(field && Number.isSafeInteger(field.offset) && field.offset >= 0 && field.size === size &&
        field.offset % Math.min(size, 8) === 0 && field.offset + size <= type.size, `invalid field ${typeName}.${fieldName}`);
      fields[typeName][fieldName] = field.offset;
    }
  }
  const outer = functions.getCascadeConfigForTrajectory, manager = functions.getCascadeConfig;
  const conversational = functions.GetCascadeConversationalConfigWithExperiment, clamp = functions.clampAndValidateConfig;
  const outerCall = call(outer, manager), managerCall = call(manager, conversational), conversationalCall = call(conversational, clamp);
  const clampCall = call(clamp, functions.ClampCheckpointConfigForModelInfo), getterCall = call(clamp, functions.GetModelInfoFromPlannerConfig);

  // Go arm64 keeps the previous FP at [FP] and its real return PC at [FP+8].
  // Recognize both canonical small and large frame prologues used here.
  function frame(fn) {
    const candidates = [];
    for (let pc = fn.rva + 8; pc < Math.min(fn.rva + 40, fn.rva + fn.size); pc += 4) {
      if (word(fn, pc) !== 0xd10023fd) continue; // sub x29,sp,#8
      const previous = memory(word(fn, pc - 4)), allocation = memory(word(fn, pc - 8));
      if (previous && !previous.vector && !previous.load && previous.size === 8 && previous.rt === 29 && previous.rn === 31 && previous.offset === -8 && !previous.writeback &&
        allocation && !allocation.vector && !allocation.load && allocation.size === 8 && allocation.rt === 30 && allocation.rn === 31 && allocation.writeback && !allocation.post && allocation.offset < 0) {
        candidates.push({ size:-allocation.offset, end:pc });
        continue;
      }
      if (pc < fn.rva + 12) continue;
      const adjust = immediate(word(fn, pc - 12)), pair = memory(word(fn, pc - 8)), setSP = immediate(word(fn, pc - 4));
      if (adjust?.wide && adjust.subtract && adjust.rd === 20 && adjust.rn === 31 && pair && !pair.vector && !pair.load && pair.width === 8 && pair.rt === 29 && pair.rt2 === 30 &&
        pair.rn === 20 && pair.offset === -8 && !pair.writeback && setSP?.wide && !setSP.subtract && setSP.rd === 31 && setSP.rn === 20 && setSP.value === 0) {
        candidates.push({ size:adjust.value, end:pc });
      }
    }
    const result = unique(candidates, `Go frame for ${fn.name ?? fn.rva}`);
    check(result.size >= 32 && result.size % 16 === 0, 'invalid Go frame size');
    return result;
  }
  const outerFrame = frame(outer);
  for (const fn of [manager, conversational, clamp]) frame(fn);
  const frameSize = outerFrame.size;
  const firstCall = entries(outer).find(item => jump(item.word, item.pc)?.call || masked(item.word, 0xfffffc1f, 0xd63f0000))?.pc;
  check(firstCall !== undefined, 'trajectory function has no call');
  const metadataSpill = unique(entries(outer).filter(item => item.pc > outerFrame.end && item.pc < firstCall &&
    store(item.word, 4, 31, frameSize + 40)), 'metadata argument spill').word;
  const metadataSpillOffset = memory(metadataSpill).offset;

  const resetRva = outerCall - 16, resetWords = words(outer, resetRva, 4);
  check(move(resetWords[0], 8, 2) && load(resetWords[1], 0, 31, frameSize + 8) &&
    load(resetWords[2], 1, 31, frameSize + 16) && load(resetWords[3], 2, 31, frameSize + 24), 'configuration-call register preparation changed');

  const observeRva = getterCall + 4;
  check(clampCall === observeRva + 44, 'model getter / official clamp sequence changed');
  const observeWords = words(clamp, observeRva, 12), clampCfgSpill = memory(observeWords[0])?.offset;
  check(Number.isSafeInteger(clampCfgSpill) && load(observeWords[0], 1, 31, clampCfgSpill) &&
    cbz(observeWords[1], observeRva + 4, 1, observeRva + 16) &&
    load(observeWords[2], 3, 1, fields.CascadeConfig.PlannerConfig) && masked(observeWords[3], 0xfc000000, 0x14000000) && jump(observeWords[3], observeRva + 12)?.target === observeRva + 20 &&
    moveZero(observeWords[4], 3) && cbz(observeWords[5], observeRva + 20, 3, observeRva + 32) &&
    load(observeWords[6], 2, 3, fields.CascadePlannerConfig.MaxOutputTokens, 4) && masked(observeWords[7], 0xfc000000, 0x14000000) && jump(observeWords[7], observeRva + 28)?.target === observeRva + 36 &&
    moveZero(observeWords[8], 2) && move(observeWords[9], 1, 0), 'model-info / planner selection block changed');
  const cfgStore = unique(entries(clamp).filter(item => item.pc < getterCall && store(item.word, 2, 31, clampCfgSpill)), 'clamp configuration spill').pc;
  const checkpointSpill = memory(observeWords[10])?.offset;
  check(Number.isSafeInteger(checkpointSpill) && load(observeWords[10], 0, 31, checkpointSpill) &&
    entries(clamp).some(item => item.pc < getterCall && load(item.word, 3, 2, fields.CascadeConfig.CheckpointConfig)), 'official clamp checkpoint argument changed');
  check(getterCall === cfgStore + 32, 'model getter argument preparation changed');
  const prepare = words(clamp, cfgStore, 8), providerSpill = memory(prepare[6]);
  check(store(prepare[1], 3, 31, checkpointSpill) && cbz(prepare[2], cfgStore + 8, 2, cfgStore + 20) &&
    load(prepare[3], 4, 2, fields.CascadeConfig.PlannerConfig) && masked(prepare[4], 0xfc000000, 0x14000000) &&
    jump(prepare[4], cfgStore + 16)?.target === cfgStore + 24 && moveZero(prepare[5], 4) &&
    providerSpill && !providerSpill.vector && !providerSpill.load && providerSpill.rn === 31 && providerSpill.rt === 0 && providerSpill.rt2 === 1 &&
    providerSpill.width === 8 && !providerSpill.writeback && move(prepare[7], 2, 4), 'model getter argument preparation changed');

  const finalRva = unique(entries(outer).filter(item => {
    if (item.pc > outer.rva + outer.size - 20) return false;
    const sequence = words(outer, item.pc, 5), restore = immediate(sequence[3]);
    return moveZero(sequence[0], 3) && moveZero(sequence[1], 4) && pairFrameRestore(sequence[2]) &&
      restore?.wide && !restore.subtract && restore.rd === 31 && restore.rn === 31 && restore.value === frameSize && ret(sequence[4]);
  }), 'successful trajectory epilogue').pc;
  const finalLoads = words(outer, finalRva - 12, 3), finalConfigSpill = memory(finalLoads[0])?.offset;
  check(Number.isSafeInteger(finalConfigSpill) && load(finalLoads[0], 0, 31, finalConfigSpill) &&
    load(finalLoads[1], 1, 31, memory(finalLoads[1])?.offset) && load(finalLoads[2], 2, 31, memory(finalLoads[2])?.offset) &&
    store(word(outer, outerCall + 8), 0, 31, finalConfigSpill) &&
    masked(word(outer, outerCall + 4), 0xff00001f, 0xb5000001), 'successful return does not carry the resolved configuration');

  // The consumed option closures provide exactly three adjacent non-pointer
  // words. The next word is a Go pointer and is deliberately outside scratch.
  const gc = metadata.scratchGC, locals = gc?.locals;
  check(locals && Number.isInteger(locals.n) && locals.n > 0 && Number.isInteger(locals.nbit) && locals.nbit > 0 &&
    Array.isArray(locals.masks) && locals.masks.length === locals.n && Array.isArray(gc.stackObjects), 'missing scratch GC metadata');
  const varp = frameSize - 8;
  const objects = gc.stackObjects.map(object => {
    check(Number.isInteger(object.offset) && Number.isInteger(object.size) && object.size > 0 && Number.isInteger(object.ptrBytes) &&
      object.ptrBytes >= 0 && object.ptrBytes <= object.size && Array.isArray(object.mask), 'invalid stack-object metadata');
    return { ...object, sp:object.offset < 0 ? varp + object.offset : frameSize + 8 + object.offset };
  });
  const closureCall = call(outer, functions.ResolveCustomAgentSpec);
  const before = words(outer, closureCall - 32, 8);
  const highAddress = immediate(before[0]), lowAddress = immediate(before[2]), argumentAddress = immediate(before[5]);
  const address = value => value?.wide && !value.subtract && value.rn === 31;
  check(address(highAddress) && highAddress.rd === 4 && address(lowAddress) && lowAddress.rd === 4 &&
    address(argumentAddress) && argumentAddress.rd === 1 && store(before[1], 4, 31, argumentAddress.value) &&
    store(before[3], 4, 31, argumentAddress.value + 8) && move(before[4], 0, 1) &&
    [0xd2800042, 0xb27f03e2].includes(before[6]) && move(before[7], 3, 2), 'consumed stack-closure arguments changed');
  const low = unique(objects.filter(object => object.sp === lowAddress.value && object.size === 24 && object.ptrBytes === 16 && object.mask[0] === 2), 'low option closure');
  const high = unique(objects.filter(object => object.sp === highAddress.value && object.size === 24 && object.ptrBytes === 24 && object.mask[0] === 4), 'high option closure');
  check(low.sp + low.size === high.sp && closureCall < resetRva, 'option-closure lifetime changed');
  const scratchOffset = low.sp + 16, scratchSize = 24;
  check(scratchOffset % 8 === 0 && scratchOffset >= 0 && scratchOffset + scratchSize <= varp, 'invalid scratch range');
  const bit = (mask, index) => (mask[Math.floor(index / 8)] >>> (index % 8)) & 1;
  const mapBase = varp - locals.nbit * 8, mapBytes = Math.ceil(locals.nbit / 8);
  for (const mask of locals.masks) {
    check(Array.isArray(mask) && mask.length === mapBytes, 'invalid locals pointer bitmap');
    for (let offset = scratchOffset; offset < scratchOffset + scratchSize; offset += 8) {
      const index = (offset - mapBase) / 8;
      check(index >= 0 && index < locals.nbit && !bit(mask, index), 'scratch contains a locals-map pointer');
    }
  }
  for (const object of objects) {
    check(object.mask.length === Math.ceil(object.ptrBytes / 64), 'invalid stack-object pointer bitmap');
    for (let index = 0; index * 8 < object.ptrBytes; index++) {
      check(!bit(object.mask, index) || !overlaps(object.sp + index * 8, 8, scratchOffset, scratchSize), 'scratch contains a stack-object pointer');
    }
  }

  // Track only stack-derived addresses through this function's immediate ADD /
  // MOV and load/store blocks. Other arithmetic loses the known offset; using
  // such an address is refused. Go calls clobber all ordinary argument registers.
  // There is no callee analysis or recovery of arbitrary values/signatures.
  const states = new Map(), pending = [{ pc:resetRva + 16, aliases:new Map([[29, new Set([-8])]]) }];
  const cloneAliases = aliases => new Map([...aliases].map(([register, offsets]) => [register, new Set(offsets)]));
  const origin = (aliases, register) => register === 31 ? new Set([0]) : aliases.get(register);
  const assign = (aliases, register, offsets) => {
    if (register === 31) return;
    const values = offsets == null ? null : new Set(offsets);
    if (values?.size) aliases.set(register, values); else aliases.delete(register);
  };
  while (pending.length) {
    const { pc, aliases:incoming } = pending.pop();
    check(pc >= resetRva + 16 && pc < outer.rva + outer.size && pc % 4 === 0, 'post-reset control flow leaves its verified lifetime');
    const previous = states.get(pc);
    if (previous) {
      let changed = false;
      for (const [register, offsets] of incoming) {
        const combined = previous.get(register) ?? new Set();
        for (const offset of offsets) if (!combined.has(offset)) { combined.add(offset); changed = true; }
        check(combined.size <= 16, 'stack-alias offsets do not converge in this compiler profile');
        previous.set(register, combined);
      }
      if (!changed) continue;
    } else states.set(pc, cloneAliases(incoming));
    const aliases = cloneAliases(states.get(pc));
    const instruction = word(outer, pc), access = memory(instruction), add = immediate(instruction);
    if (access) {
      const bases = origin(aliases, access.rn);
      if (bases) {
        check(!access.indexed && !bases.has('unknown'), 'post-reset stack alias has an indeterminate address');
        for (const base of bases) check(!overlaps(base + (access.post ? 0 : access.offset), access.size, scratchOffset, scratchSize), 'scratch is used by post-reset native code');
        check(access.rn !== 31 || !access.writeback, 'post-reset stack writeback changed');
      }
      if (access.load && !access.vector) { assign(aliases, access.rt); if (access.rt2 !== undefined) assign(aliases, access.rt2); }
      if (access.writeback && bases) assign(aliases, access.rn, [...bases].map(base => typeof base === 'number' ? base + access.offset : 'unknown'));
    }
    if (add) {
      const bases = origin(aliases, add.rn);
      if (add.rn === 31 && add.rd === 31) {
        check(!add.subtract && add.value === frameSize && ret(word(outer, pc + 4)) && pairFrameRestore(word(outer, pc - 4)), 'post-reset stack restoration changed');
      } else if (bases) {
        check(add.wide, 'post-reset stack alias is truncated');
        const offsets = [...bases].map(base => typeof base === 'number' ? base + (add.subtract ? -add.value : add.value) : 'unknown');
        for (const offset of offsets) check(offset === 'unknown' || !overlaps(offset, 1, low.sp, low.size + high.size) &&
          !overlaps(offset, 1, argumentAddress.value, 16), 'consumed closure is addressed after reset');
        assign(aliases, add.rd, offsets);
      } else assign(aliases, add.rd);
    } else if (masked(instruction, 0xffe0ffe0, 0xaa0003e0)) {
      const source = (instruction >>> 16) & 31;
      assign(aliases, instruction & 31, source === 31 ? undefined : aliases.get(source));
    } else if (!access && (masked(instruction, 0x1f000000, 0x10000000) || masked(instruction, 0x1f800000, 0x12800000))) {
      assign(aliases, instruction & 31); // ADR/ADRP or MOVN/MOVZ/MOVK.
    } else if (!access && (masked(instruction, 0x1c000000, 0x10000000) || masked(instruction, 0x0e000000, 0x0a000000))) {
      const rn = aliases.get((instruction >>> 5) & 31), rm = aliases.get((instruction >>> 16) & 31);
      assign(aliases, instruction & 31, rn || rm ? ['unknown'] : undefined);
    }
    const branch = jump(instruction, pc), indirectCall = masked(instruction, 0xfffffc1f, 0xd63f0000);
    if (branch?.call || indirectCall) {
      for (let register = 0; register < 28; register++) aliases.delete(register);
      aliases.delete(30);
    }
    if (ret(instruction)) continue;
    check(!masked(instruction, 0xfffffc1f, 0xd61f0000), 'post-reset indirect branch changed');
    if (branch && !branch.call) {
      pending.push({ pc:branch.target, aliases:cloneAliases(aliases) });
      if (branch.conditional) pending.push({ pc:pc + 4, aliases });
    } else pending.push({ pc:pc + 4, aliases });
  }
  check(states.has(finalRva), 'successful return is unreachable after reset');

  const site = (fn, rva, continueRva) => {
    // A replaced middle instruction must never remain an original branch target.
    for (const item of entries(fn)) {
      const branch = jump(item.word, item.pc);
      check(!branch || branch.target <= rva || branch.target >= rva + 16, 'a native branch enters the replaced block');
    }
    return { rva, originalWords:words(fn, rva, 4), continueRva };
  };
  return { format:1, profile, functions:Object.fromEntries(Object.entries(functions).map(([name, fn]) => [name, fn.rva])), fields,
    sites:{ reset:site(outer, resetRva, outerCall), observe:{ ...site(clamp, observeRva, observeRva + 20), modelInfoRegister:0 },
      final:site(outer, finalRva, finalRva + 16) },
    callerReturnRvas:[conversationalCall + 4, managerCall + 4, outerCall + 4], frameSize,
    metadataSpill:metadataSpillOffset, clampCfgSpill, scratchOffset, scratchSize };
}
