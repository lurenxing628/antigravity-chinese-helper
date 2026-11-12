import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBackendMetadata } from '../runtime/backend-metadata.mjs';

// A small, real-format Mach-O / pclntab / rtype fixture. Code addresses, Go
// fields, descriptor locations and the moduledata tail can move independently.
function fixture({ codeShift = 0, fieldShift = 0, typeShift = 0, boundary = 0x40,
  reorderFields = false, duplicateFunction = false, duplicateType = false, wrongFieldType = false } = {}) {
  const bytes = Buffer.alloc(0x9000), imageBase = 0x100000000;
  const text = 0x400 + codeShift, pcln = 0x1000, pclnSize = 0x1000, module = 0x700;
  const types = 0x2200, typesSize = 0x5000, gofunc = imageBase + pcln + 0xc00, rodata = imageBase + 0x800;
  const u32 = (offset, value) => bytes.writeUInt32LE(value >>> 0, offset);
  const i32 = (offset, value) => bytes.writeInt32LE(value, offset);
  const u64 = (offset, value) => bytes.writeBigUInt64LE(BigInt(value), offset);
  u32(0, 0xfeedfacf); u32(4, 0x0100000c); u32(12, 2); u32(16, 1); u32(20, 72 + 4 * 80);
  const command = 32;
  u32(command, 0x19); u32(command + 4, 72 + 4 * 80);
  bytes.write('__TEXT', command + 8);
  u64(command + 24, imageBase); u64(command + 32, bytes.length);
  u64(command + 40, 0); u64(command + 48, bytes.length); u32(command + 64, 4);
  for (const [index, [name, offset, size]] of [
    ['__text', text, 0x200], ['__lrodata_gopcln', pcln, pclnSize],
    ['__go_type', types, typesSize], ['__go_module', module, 0x80],
  ].entries()) {
    const start = command + 72 + index * 80;
    bytes.write(name, start); bytes.write('__TEXT', start + 16);
    u64(start + 32, imageBase + offset); u64(start + 40, size); u32(start + 48, offset);
  }

  const names = [
    'google3/third_party/jetski/cortex/cortex.(*CascadeManager).getCascadeConfigForTrajectory',
    'google3/third_party/jetski/cortex/cortex.(*CascadeManager).getCascadeConfig',
    'google3/third_party/jetski/cortex/config/config.GetCascadeConversationalConfigWithExperiment',
    'google3/third_party/jetski/cortex/config/config.clampAndValidateConfig',
    'google3/third_party/jetski/cortex/utils/utils.ClampCheckpointConfigForModelInfo',
    'google3/third_party/jetski/cortex/config/config.GetModelInfoFromPlannerConfig',
    'google3/third_party/jetski/cortex/sdk/sdk.ResolveCustomAgentSpec',
  ];
  if (duplicateFunction) names.push(names[0]);
  const nameStart = pcln + 0x60, table = pcln + 0x500, tableSize = (names.length * 2 + 1) * 4;
  u32(pcln, 0xfffffff1); bytes[pcln + 6] = 4; bytes[pcln + 7] = 8;
  u64(pcln + 8, names.length); u64(pcln + 16, 0); u64(pcln + 24, 0);
  let nextName = nameStart;
  for (const [index, name] of names.entries()) {
    const info = table + tableSize + index * 60;
    u32(table + index * 8, 0x10 + index * 0x20); u32(table + index * 8 + 4, info - table);
    u32(info, 0x10 + index * 0x20); i32(info + 4, nextName - nameStart);
    nextName += bytes.write(name + '\0', nextName);
    u32(info + 28, 1); bytes[info + 43] = 3;
    u32(info + 48, 0xffffffff); u32(info + 52, 0x100); u32(info + 56, 0x140);
  }
  u32(table + names.length * 8, 0x10 + names.length * 0x20);
  const nameEnd = Math.ceil((nextName - pcln) / 8) * 8;
  [0x60, nameEnd, nameEnd, nameEnd, 0x500].forEach((value, index) => u64(pcln + 32 + index * 8, value));

  u64(module, imageBase + pcln);
  u64(module + boundary - 16, rodata); u64(module + boundary - 8, gofunc);
  u64(module + boundary, imageBase + pcln + pclnSize);
  const locals = gofunc - imageBase + 0x100, objects = gofunc - imageBase + 0x140;
  i32(locals, 2); i32(locals + 4, 8); bytes[locals + 8] = 0; bytes[locals + 9] = 1;
  u64(objects, 1); i32(objects + 8, -16); i32(objects + 12, 16); i32(objects + 16, 16);
  u32(objects + 20, 0x20); bytes[rodata - imageBase + 0x20] = 2;

  let allocated = types + 0x100 + typeShift;
  const allocate = size => { allocated = Math.ceil(allocated / 8) * 8; const result = allocated; allocated += size; return result; };
  const namesCache = new Map(), descriptors = new Map();
  function encodedName(name) {
    if (namesCache.has(name)) return namesCache.get(name);
    const raw = Buffer.from(name), length = [];
    let remaining = raw.length;
    do { const value = remaining % 128; remaining = Math.floor(remaining / 128); length.push(value | (remaining ? 128 : 0)); } while (remaining);
    const start = allocate(1 + length.length + raw.length);
    bytes[start] = 1; Buffer.from(length).copy(bytes, start + 1); raw.copy(bytes, start + 1 + length.length);
    namesCache.set(name, start);
    return start;
  }
  function descriptor(name, kind, size, extraStar = false) {
    const start = allocate(kind === 25 ? 80 : kind === 22 ? 56 : 48);
    u64(start, size); u64(start + 8, kind === 25 ? size : kind === 22 || kind === 24 ? 8 : 0);
    bytes[start + 20] = extraStar ? 2 : 0; bytes[start + 21] = size < 8 ? size : 8;
    bytes[start + 22] = bytes[start + 21]; bytes[start + 23] = kind;
    i32(start + 40, encodedName(extraStar ? `*${name}` : name) - types);
    return start;
  }
  const structures = {
    'cortex_go_proto.CascadeConfig': [['PlannerConfig', '*cortex_go_proto.CascadePlannerConfig', 16], ['CheckpointConfig', '*cortex_go_proto.CheckpointConfig', 32]],
    'cortex_go_proto.CheckpointConfig': [['MaxTokenLimit', wrongFieldType ? 'int32' : 'uint32', 24], ['Enabled', '*bool', 40]],
    'cortex_go_proto.CascadePlannerConfig': [['PlanModel', 'codeium_common_go_proto.Model', 16], ['CustomModelInfoOverride', '*codeium_common_go_proto.ModelInfo', 32], ['MaxOutputTokens', 'uint32', 48]],
    'cortex_go_proto.CortexTrajectoryMetadata': [['ParentConversationId', 'string', 16], ['SubagentSpec', '*cortex_go_proto.SubagentSpec', 48]],
    'codeium_common_go_proto.ModelInfo': [['ModelId', 'codeium_common_go_proto.Model', 16], ['MaxTokens', 'int32', 24], ['MaxOutputTokens', 'int32', 32]],
    'cortex_go_proto.SubagentSpec': [],
  };
  for (const name of Object.keys(structures)) descriptors.set(name, descriptor(name, 25, 0x100, true));
  function fieldType(name) {
    if (descriptors.has(name)) return descriptors.get(name);
    let start;
    if (name.startsWith('*')) {
      start = descriptor(name, 22, 8);
      u64(start + 48, imageBase + fieldType(name.slice(1)));
    } else {
      const [kind, size] = name === 'string' ? [24, 16] : name === 'uint32' ? [10, 4] : name === 'bool' ? [1, 1] : [5, 4];
      start = descriptor(name, kind, size);
    }
    descriptors.set(name, start);
    return start;
  }
  for (const [name, fields] of Object.entries(structures)) {
    const start = descriptors.get(name), table = allocate(fields.length * 24);
    u64(start + 56, imageBase + table); u64(start + 64, fields.length); u64(start + 72, fields.length);
    const layout = reorderFields ? fields.map((field, index) => [...fields[fields.length - index - 1].slice(0, 2), field[2]]) : fields;
    for (const [index, [name, type, offset]] of layout.entries()) {
      const field = table + index * 24;
      u64(field, imageBase + encodedName(name)); u64(field + 8, imageBase + fieldType(type));
      u64(field + 16, offset + fieldShift);
    }
    fieldType(`*${name}`);
  }
  if (duplicateType) {
    const name = 'cortex_go_proto.CheckpointConfig', original = descriptors.get(name);
    const duplicate = descriptor(name, 25, 0x100, true);
    bytes.copy(bytes, duplicate + 56, original + 56, original + 80);
    const pointer = descriptor(`*${name}`, 22, 8); u64(pointer + 48, imageBase + duplicate);
  }
  return { bytes, imageBase, text, pcln, table, module, locals, objects };
}

test('metadata follows moved code, reordered fields and a moved moduledata boundary', () => {
  const first = fixture(), moved = fixture({ codeShift: 0x80, fieldShift: 8, typeShift: 0x100, boundary: 0x60, reorderFields: true });
  const original = parseBackendMetadata(first.bytes), result = parseBackendMetadata(moved.bytes);
  assert.equal(Object.keys(result.functions).length, 7);
  assert.equal(result.functions.getCascadeConfigForTrajectory.rva, moved.text + 0x10);
  assert.equal(result.functions.getCascadeConfigForTrajectory.fileOffset, moved.text + 0x10);
  assert.equal(result.functions.getCascadeConfigForTrajectory.size, 0x20);
  assert.equal(result.functions.getCascadeConfigForTrajectory.rva - original.functions.getCascadeConfigForTrajectory.rva, 0x80);
  assert.equal(result.types.CheckpointConfig.fields.MaxTokenLimit.offset, 48);
  assert.equal(original.types.CheckpointConfig.fields.MaxTokenLimit.offset, 24);
  assert.deepEqual(result.types.ModelInfo.fields.MaxTokens, { name: 'MaxTokens', offset: 32, type: 'int32', size: 4 });
  assert.deepEqual(result.scratchGC, {
    locals: { n: 2, nbit: 8, masks: [[0], [1]] },
    stackObjects: [{ offset: -16, size: 16, ptrBytes: 16, mask: [2] }],
  });
});

test('required function and type names must identify one exact target', () => {
  assert.throws(() => parseBackendMetadata(fixture({ duplicateFunction: true }).bytes), /ambiguous function/);
  assert.throws(() => parseBackendMetadata(fixture({ duplicateType: true }).bytes), /ambiguous type/);
  const missing = fixture();
  const name = Buffer.from('getCascadeConfigForTrajectory');
  missing.bytes[missing.bytes.indexOf(name)] = 'X'.charCodeAt(0);
  assert.throws(() => parseBackendMetadata(missing.bytes), /missing function/);
});

test('the discovered field must still satisfy the configuration schema contract', () => {
  assert.throws(() => parseBackendMetadata(fixture({ wrongFieldType: true }).bytes), /field contract changed.*MaxTokenLimit/);
});

test('truncated or malformed executable metadata is rejected before returning hook data', () => {
  const { bytes } = fixture();
  assert.throws(() => parseBackendMetadata(bytes.subarray(0, 31)), /metadata range/);
  const badTable = fixture(); badTable.bytes.writeBigUInt64LE(0x100000000n, badTable.pcln + 8);
  assert.throws(() => parseBackendMetadata(badTable.bytes), /metadata range/);
  const badTypeRange = fixture();
  badTypeRange.bytes.writeBigUInt64LE(0xffffffffn, 32 + 72 + 2 * 80 + 40);
  assert.throws(() => parseBackendMetadata(badTypeRange.bytes), /section is outside/);
});

test('GC data needs a unique module boundary and bounded locals and object masks', () => {
  const duplicate = fixture();
  duplicate.bytes.writeBigUInt64LE(BigInt(duplicate.imageBase + duplicate.pcln + 0x1000), duplicate.module + 0x20);
  assert.throws(() => parseBackendMetadata(duplicate.bytes), /unique epclntab/);
  const locals = fixture(); locals.bytes.writeInt32LE(0x7fffffff, locals.locals);
  assert.throws(() => parseBackendMetadata(locals.bytes), /function data is outside/);
  const object = fixture(); object.bytes.writeInt32LE(24, object.objects + 16);
  assert.throws(() => parseBackendMetadata(object.bytes), /invalid.*stack object/);
});
