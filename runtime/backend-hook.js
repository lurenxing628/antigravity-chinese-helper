/* Antigravity 2.31.0 / language_server CL 1017595969 / arm64.
 * Go executes only short ARM64 branches: no JS, C callbacks, stack pushes,
 * new Go objects, or retained Go pointers. JavaScript manages installation.
 */
'use strict';

const buildCL = 1017595969;
const caveRva = 0x742e240;
const caveSize = 0x1dc0;
const headerSize = 64;
const magic = 0x43484741; // AGHC
const format = 2;
const sites = [
  {rva:0x2237280, original:0xf9410fe2}, // ldr x2, [sp, #0x218]
  {rva:0x1626630, original:0x97fa9e0c}, // bl ClampCheckpointConfigForModelInfo
  {rva:0x2237904, original:0xaa1f03e3}, // mov x3, xzr
];
let state = null;
let patches = [];
let initialized = false;

function validateLimit(tokens) {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 0xffffffff)) {
    throw new Error('Invalid subagent context limit');
  }
}

function branchWord(from, to) {
  const distance = to.sub(from).toInt32();
  if (distance % 4 || distance < -0x8000000 || distance >= 0x8000000) throw new Error('Native branch is out of range');
  return (0x14000000 | ((distance / 4) & 0x3ffffff)) >>> 0;
}

function patchWord(address, word) {
  Memory.patchCode(address, 4, writable => writable.writeU32(word));
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
  // Single-instruction branches are restored atomically. Keep their tiny stubs
  // and native data mapped until process exit, so an in-flight stub stays valid.
  for (const patch of patches) {
    if (patch.address.readU32() === patch.branch) patchWord(patch.address, patch.original);
  }
  initialized = false;
  return status();
}

function emitStubs(base, cave, data) {
  const starts = [];
  Memory.patchCode(cave, caveSize, writable => {
    const w = new Arm64Writer(writable.add(headerSize), {pc:cave.add(headerSize)});
    const start = () => { starts.push(w.pc); };
    const finish = () => w.flush();

    start();
    w.putInstruction(sites[0].original);
    // This closed-over object is dead after ResolveCustomAgentSpec. These three
    // words are non-pointers in every Go stack map and unused until return.
    for (const offset of [0x1c8, 0x1d0, 0x1d8]) w.putStrRegRegOffset('xzr', 'sp', offset);
    w.putBImm(base.add(sites[0].rva + 4));
    finish();

    start();
    // Preserve x0/x1/x2 (the original clamp's arguments), SP, FP and its real LR.
    // Verify the exact caller chain before touching the outer frame's scalars.
    w.putMovRegReg('x3', 'x29');
    for (const returnRva of [0x1626498, 0x223918c, 0x2237288]) {
      w.putLdrRegRegOffset('x4', 'x3', 8);
      w.putLdrRegAddress('x5', base.add(returnRva));
      w.putCmpRegReg('x4', 'x5'); w.putBCondLabel('ne', 'clamp-done');
      w.putLdrRegReg('x3', 'x3');
    }
    w.putAddRegRegImm('x3', 'x3', 8); // outer SP = outer FP + 8
    w.putCbzRegLabel('x1', 'clamp-done');
    w.putLdrRegRegOffset('w4', 'x1', 0x14); // actual resolved ModelInfo.maxTokens
    w.putCmpRegReg('w4', 'wzr'); w.putBCondLabel('le', 'clamp-done');
    w.putLdrRegRegOffset('x5', 'sp', 0x78); // clampAndValidateConfig's config
    w.putCbzRegLabel('x5', 'clamp-done');
    w.putLdrRegRegOffset('x5', 'x5', 8); // planner
    w.putCbzRegLabel('x5', 'clamp-done');
    w.putStrRegRegOffset('w4', 'x3', 0x1c8);
    w.putLdrRegRegOffset('w6', 'x5', 0x40);
    w.putStrRegRegOffset('w6', 'x3', 0x1cc);
    for (const offset of [0x1d0, 0x1d4, 0x1d8]) w.putStrRegRegOffset('wzr', 'x3', offset);
    w.putLdrRegRegOffset('x5', 'x5', 0x60);
    w.putCbzRegLabel('x5', 'clamp-valid');
    w.putLdrRegU32('w6', 1); w.putStrRegRegOffset('w6', 'x3', 0x1d0);
    w.putLdrRegRegOffset('w6', 'x5', 8); w.putStrRegRegOffset('w6', 'x3', 0x1d4);
    w.putLdrRegRegOffset('w6', 'x5', 0x14); w.putStrRegRegOffset('w6', 'x3', 0x1d8);
    w.putLabel('clamp-valid');
    w.putLdrRegAddress('x7', data); w.putLdrRegRegOffset('w6', 'x7', 48);
    w.putStrRegRegOffset('w6', 'x3', 0x1dc);
    w.putLabel('clamp-done');
    w.putLdrRegAddress('x30', base.add(sites[1].rva + 4));
    w.putBImm(base.add(0x14cde60)); // reproduce the original BL's target and LR
    finish();

    start();
    w.putLdrRegAddress('x16', data);
    w.putLdrRegRegOffset('x3', 'sp', 0x228); // trajectory metadata
    w.putCbzRegLabel('x3', 'parent');
    w.putLdrRegRegOffset('x4', 'x3', 0x70); w.putCbnzRegLabel('x4', 'child');
    w.putLdrRegRegOffset('x4', 'x3', 0x40); w.putCbnzRegLabel('x4', 'child');
    w.putLabel('parent');
    w.putLdrRegRegOffset('x3', 'x0', 0x10);
    w.putCbzRegLabel('x3', 'done');
    w.putLdrRegRegOffset('w4', 'x3', 0xc);
    w.putStrRegRegOffset('w4', 'x16', 4); w.putBLabel('done');

    w.putLabel('child');
    w.putMovRegReg('w13', 'wzr'); // before
    w.putMovRegReg('w15', 'wzr'); // after
    w.putMovRegReg('w6', 'wzr'); // capacity
    w.putLdrRegU32('w10', 3); // missing checkpoint
    w.putLdrRegRegOffset('x12', 'x0', 0x10);
    w.putCbzRegLabel('x12', 'record');
    w.putLdrRegRegOffset('w13', 'x12', 0xc); w.putMovRegReg('w15', 'w13');
    w.putLdrRegU32('w10', 2); // restoring default
    w.putLdrRegReg('w11', 'x16'); w.putCbzRegLabel('w11', 'record');
    w.putLdrRegU32('w10', 4); // disabled checkpoint
    w.putLdrRegRegOffset('x3', 'x12', 0xa8); w.putCbzRegLabel('x3', 'record');
    w.putInstruction(0x39400063); // ldrb w3, [x3]
    w.putCbzRegLabel('w3', 'record');
    w.putLdrRegU32('w10', 5); // capacity observation absent in this resolution
    w.putLdrRegRegOffset('w7', 'sp', 0x1dc); w.putLdrRegRegOffset('w8', 'x16', 48);
    w.putCmpRegReg('w7', 'w8'); w.putBCondLabel('ne', 'record');
    w.putLdrRegRegOffset('w6', 'sp', 0x1c8);
    w.putLdrRegU32('w10', 6); // a later global/dynamic overlay changed the model
    w.putLdrRegRegOffset('x5', 'x0', 8); w.putCbzRegLabel('x5', 'record');
    w.putLdrRegRegOffset('w7', 'x5', 0x40); w.putLdrRegRegOffset('w8', 'sp', 0x1cc);
    w.putStrRegRegOffset('w7', 'x16', 24); w.putStrRegRegOffset('w8', 'x16', 28);
    w.putCmpRegReg('w7', 'w8'); w.putBCondLabel('ne', 'record');
    w.putLdrRegRegOffset('x7', 'x5', 0x60); w.putLdrRegRegOffset('w8', 'sp', 0x1d0);
    w.putStrRegRegOffset('w8', 'x16', 32); w.putStrRegRegOffset('wzr', 'x16', 36);
    w.putCbzRegLabel('x7', 'no-custom');
    w.putLdrRegU32('w9', 1); w.putStrRegRegOffset('w9', 'x16', 36);
    w.putCbzRegLabel('w8', 'record');
    w.putLdrRegRegOffset('w8', 'x7', 8); w.putLdrRegRegOffset('w9', 'sp', 0x1d4);
    w.putCmpRegReg('w8', 'w9'); w.putBCondLabel('ne', 'record');
    w.putLdrRegRegOffset('w8', 'x7', 0x14); w.putLdrRegRegOffset('w9', 'sp', 0x1d8);
    w.putCmpRegReg('w8', 'w9'); w.putBCondLabel('ne', 'record');
    w.putBLabel('same-model');
    w.putLabel('no-custom'); w.putCbnzRegLabel('w8', 'record');
    w.putLabel('same-model');
    // Retain the official capacity rule, using the FINAL output reservation.
    w.putLdrRegRegOffset('w7', 'x5', 0x68);
    w.putCmpRegReg('w7', 'w6'); w.putBCondLabel('hs', 'capacity-ready');
    w.putSubRegRegReg('w6', 'w6', 'w7');
    w.putLabel('capacity-ready');
    w.putCmpRegReg('w11', 'w6'); w.putBCondLabel('ls', 'limit-ready');
    w.putMovRegReg('w11', 'w6');
    w.putLabel('limit-ready');
    w.putStrRegRegOffset('w11', 'x12', 0xc); w.putMovRegReg('w15', 'w11');
    w.putLdrRegU32('w10', 1);
    w.putLabel('record');
    // One aligned 64-bit store keeps before/after together for diagnostics.
    w.putLslRegImm('x14', 'x13', 32); w.putAddRegRegReg('x14', 'x14', 'x15');
    w.putStrRegRegOffset('x14', 'x16', 8);
    w.putStrRegRegOffset('w6', 'x16', 16); w.putStrRegRegOffset('w10', 'x16', 20);
    w.putLabel('done');
    w.putInstruction(sites[2].original);
    w.putBImm(base.add(sites[2].rva + 4));
    finish();
    if (w.offset + headerSize > caveSize) throw new Error('Native stubs exceed reserved padding');
    writable.writeU32(magic); writable.add(4).writeU32(format); writable.add(8).writeU32(buildCL);
    writable.add(16).writePointer(data);
    starts.forEach((address, index) => writable.add(24 + index * 8).writePointer(address));
    w.dispose();
  });
  return starts;
}

function initialize(expectedBinaryPath, tokens) {
  validateLimit(tokens);
  if (initialized) throw new Error('Backend agent is already initialized');
  const module = Process.mainModule, base = module.base;
  if (Process.arch !== 'arm64' || module.path !== expectedBinaryPath) throw new Error('Unexpected backend executable');
  const cave = base.add(caveRva);
  const existing = cave.readU32() === magic && cave.add(4).readU32() === format && cave.add(8).readU32() === buildCL;
  // Adjacent instructions pin the stack layout and real call/return locations.
  for (const [rva, word] of [[0x2237284,0x94000797], [0x1626634,0xa94687e0], [0x2237908,0xaa1f03e4],
    [0x223790c,0xa97ffbfd], [0x2237910,0x910803ff], [0x2237914,0xd65f03c0]]) {
    if (base.add(rva).readU32() !== word) throw new Error('Unsupported backend build');
  }
  let starts;
  if (existing) {
    state = cave.add(16).readPointer();
    starts = sites.map((_, index) => cave.add(24 + index * 8).readPointer());
  } else {
    if (sites.some(site => base.add(site.rva).readU32() !== site.original)
      || new Uint8Array(cave.readByteArray(caveSize)).some(byte => byte !== 0)) throw new Error('Unsupported backend build or occupied padding');
    // mmap has process lifetime. A script unload must not free data that an
    // already-entered native stub may still reference; it is reused on reload.
    const mmap = new NativeFunction(Module.getGlobalExportByName('mmap'), 'pointer', ['pointer','ulong','int','int','int','int64']);
    state = mmap(ptr(0), Process.pageSize, 3, 0x1002, -1, 0);
    if (state.equals(ptr(-1))) throw new Error('Could not allocate native budget state');
    starts = emitStubs(base, cave, state);
  }
  patches = sites.map((site, index) => ({...site, address:base.add(site.rva), branch:branchWord(base.add(site.rva), starts[index])}));
  if (patches.some(patch => ![patch.original, patch.branch].includes(patch.address.readU32()))) throw new Error('Backend hook is owned by another patch');
  state.writeU32(0);
  // Ignore any configuration already in flight when a helper reconnects.
  state.add(48).writeU32((state.add(48).readU32() + 1) >>> 0 || 1);
  try {
    for (const patch of patches) patchWord(patch.address, patch.branch);
    initialized = true;
    return configure(tokens);
  } catch (error) { dispose(); throw error; }
}

rpc.exports = {initialize, configure, status, dispose};
