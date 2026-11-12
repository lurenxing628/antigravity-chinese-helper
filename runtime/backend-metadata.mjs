import { readFile } from 'node:fs/promises';

const functionNames = {
  getCascadeConfigForTrajectory: 'google3/third_party/jetski/cortex/cortex.(*CascadeManager).getCascadeConfigForTrajectory',
  getCascadeConfig: 'google3/third_party/jetski/cortex/cortex.(*CascadeManager).getCascadeConfig',
  GetCascadeConversationalConfigWithExperiment: 'google3/third_party/jetski/cortex/config/config.GetCascadeConversationalConfigWithExperiment',
  clampAndValidateConfig: 'google3/third_party/jetski/cortex/config/config.clampAndValidateConfig',
  ClampCheckpointConfigForModelInfo: 'google3/third_party/jetski/cortex/utils/utils.ClampCheckpointConfigForModelInfo',
  GetModelInfoFromPlannerConfig: 'google3/third_party/jetski/cortex/config/config.GetModelInfoFromPlannerConfig',
  ResolveCustomAgentSpec: 'google3/third_party/jetski/cortex/sdk/sdk.ResolveCustomAgentSpec',
};

// These are schema contracts, not memory layouts. Offsets and complete structure
// sizes come from this executable's Go type metadata.
const typeFields = {
  CascadeConfig: {
    name: 'cortex_go_proto.CascadeConfig',
    fields: { PlannerConfig: ['*cortex_go_proto.CascadePlannerConfig', 8], CheckpointConfig: ['*cortex_go_proto.CheckpointConfig', 8] },
  },
  CheckpointConfig: {
    name: 'cortex_go_proto.CheckpointConfig',
    fields: { MaxTokenLimit: ['uint32', 4], Enabled: ['*bool', 8] },
  },
  CascadePlannerConfig: {
    name: 'cortex_go_proto.CascadePlannerConfig',
    fields: { PlanModel: ['codeium_common_go_proto.Model', 4], CustomModelInfoOverride: ['*codeium_common_go_proto.ModelInfo', 8], MaxOutputTokens: ['uint32', 4] },
  },
  CortexTrajectoryMetadata: {
    name: 'cortex_go_proto.CortexTrajectoryMetadata',
    fields: { ParentConversationId: ['string', 16], SubagentSpec: ['*cortex_go_proto.SubagentSpec', 8] },
  },
  ModelInfo: {
    name: 'codeium_common_go_proto.ModelInfo',
    fields: { ModelId: ['codeium_common_go_proto.Model', 4], MaxTokens: ['int32', 4] },
  },
};

const unsupported = message => new Error(`Unsupported backend metadata: ${message}`);

/** Parse the arm64 Mach-O / Go 1.20+ pclntab and rtype formats used by this backend. */
export function parseBackendMetadata(input) {
  if (!Buffer.isBuffer(input)) throw new TypeError('Backend metadata input must be a Buffer');
  const bytes = input;
  function range(offset, size, end = bytes.length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > end - size) {
      throw unsupported('metadata range is outside the executable');
    }
    return offset;
  }
  const u32 = offset => bytes.readUInt32LE(range(offset, 4));
  const i32 = offset => bytes.readInt32LE(range(offset, 4));
  const u64 = offset => {
    const value = bytes.readBigUInt64LE(range(offset, 8));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported('address exceeds the supported integer range');
    return Number(value);
  };
  const cstring = (offset, end) => {
    range(offset, 1, end);
    const zero = bytes.indexOf(0, offset);
    if (zero < 0 || zero >= end) throw unsupported('unterminated metadata name');
    return bytes.toString('utf8', offset, zero);
  };
  const fixedName = offset => {
    const end = offset + 16, zero = bytes.indexOf(0, offset);
    range(offset, 16);
    return bytes.toString('utf8', offset, zero >= offset && zero < end ? zero : end);
  };

  range(0, 32);
  if (u32(0) !== 0xfeedfacf || u32(4) !== 0x0100000c) throw unsupported('expected a little-endian arm64 Mach-O');
  const commandEnd = 32 + u32(20), commandCount = u32(16);
  range(32, commandEnd - 32);
  if (commandCount > (commandEnd - 32) / 8) throw unsupported('invalid Mach-O load commands');
  const segments = [], sections = new Map();
  let position = 32;
  for (let index = 0; index < commandCount; index++) {
    range(position, 8, commandEnd);
    const command = u32(position), size = u32(position + 4);
    if (size < 8 || size % 8) throw unsupported('invalid Mach-O load command size');
    range(position, size, commandEnd);
    if (command === 0x19) {
      if (size < 72) throw unsupported('truncated Mach-O segment');
      const address = u64(position + 24), memorySize = u64(position + 32);
      const fileOffset = u64(position + 40), fileSize = u64(position + 48), count = u32(position + 64);
      if (72 + count * 80 > size || fileSize > memorySize) throw unsupported('invalid Mach-O segment sections');
      range(fileOffset, fileSize);
      const segment = { address, memorySize, fileOffset, fileSize };
      segments.push(segment);
      for (let sectionIndex = 0; sectionIndex < count; sectionIndex++) {
        const start = position + 72 + sectionIndex * 80;
        const name = fixedName(start), sectionAddress = u64(start + 32), sectionSize = u64(start + 40);
        if (sectionAddress < address || sectionSize > address + memorySize - sectionAddress) throw unsupported('section is outside its segment');
        if (['__text', '__lrodata_gopcln', '__go_type', '__go_module'].includes(name)) {
          if (sections.has(name)) throw unsupported(`ambiguous ${name} section`);
          const offset = u32(start + 48);
          range(offset, sectionSize);
          if (offset !== fileOffset + sectionAddress - address || sectionSize > fileSize - (offset - fileOffset)) {
            throw unsupported(`invalid ${name} file mapping`);
          }
          sections.set(name, { address: sectionAddress, size: sectionSize, fileOffset: offset });
        }
      }
    }
    position += size;
  }
  if (position !== commandEnd) throw unsupported('Mach-O load command length does not match');
  const section = name => {
    const result = sections.get(name);
    if (!result || !result.size) throw unsupported(`missing ${name} section`);
    return result;
  };
  const text = section('__text'), pcln = section('__lrodata_gopcln'), goType = section('__go_type');
  const imageBase = Math.min(...segments.filter(segment => segment.fileSize).map(segment => segment.address));
  const fileOffset = (address, size) => {
    const matches = segments.filter(segment => address >= segment.address && address + size <= segment.address + segment.fileSize);
    if (matches.length !== 1) throw unsupported('metadata address has no unique file mapping');
    return range(matches[0].fileOffset + address - matches[0].address, size);
  };

  const h = pcln.fileOffset, pclnEnd = h + pcln.size;
  range(h, 72, pclnEnd);
  if (u32(h) !== 0xfffffff1 || bytes[h + 4] !== 0 || bytes[h + 5] !== 0 || bytes[h + 6] !== 4 || bytes[h + 7] !== 8) {
    throw unsupported('unknown Go pclntab format');
  }
  const count = u64(h + 8), declaredText = u64(h + 24);
  if (declaredText && declaredText !== text.address) throw unsupported('Go text base does not match Mach-O text');
  const offsets = [32, 40, 48, 56, 64].map(offset => u64(h + offset));
  let previous = 72;
  for (const offset of offsets) {
    if (offset < previous || offset > pcln.size) throw unsupported('invalid Go pclntab subtable offsets');
    previous = offset;
  }
  const names = h + offsets[0], namesEnd = h + offsets[1], table = h + offsets[4];
  const tableSize = (count * 2 + 1) * 4;
  if (!count) throw unsupported('empty Go function table');
  range(table, tableSize, pclnEnd);
  const wanted = new Map(Object.entries(functionNames).map(([key, name]) => [name, key]));
  const functions = {};
  for (let index = 0; index < count; index++) {
    const entry = u32(table + index * 8), next = u32(table + (index + 1) * 8);
    const infoOffset = u32(table + index * 8 + 4);
    if (next < entry || next > text.size || infoOffset < tableSize) throw unsupported('invalid Go function range');
    const info = table + infoOffset;
    range(info, 8, pclnEnd);
    if (u32(info) !== entry) throw unsupported('Go function descriptor does not match its table entry');
    const namePosition = names + i32(info + 4);
    if (namePosition < names) throw unsupported('invalid Go function name offset');
    const name = cstring(namePosition, namesEnd), key = wanted.get(name);
    if (!key) continue;
    if (functions[key]) throw unsupported(`ambiguous function ${name}`);
    if (next === entry) throw unsupported(`empty function ${name}`);
    functions[key] = { name, rva: text.address + entry - imageBase, size: next - entry,
      fileOffset: fileOffset(text.address + entry, next - entry),
      funcDataRva: pcln.address + info - h - imageBase, funcDataFileOffset: info };
  }
  for (const [key, name] of Object.entries(functionNames)) if (!functions[key]) throw unsupported(`missing function ${name}`);

  const typesStart = goType.fileOffset, typesEnd = typesStart + goType.size;
  const typeOffset = (address, size) => {
    if (address < goType.address || address + size > goType.address + goType.size) throw unsupported('type descriptor is outside Go type metadata');
    return range(typesStart + address - goType.address, size, typesEnd);
  };
  function readName(address) {
    const start = typeOffset(address, 2);
    let length = 0, scale = 1;
    for (let index = 0; index < 5; index++) {
      const byte = bytes[range(start + index + 1, 1, typesEnd)];
      length += (byte & 127) * scale;
      if (!(byte & 128)) {
        const body = start + index + 2;
        range(body, length, typesEnd);
        return bytes.toString('utf8', body, body + length);
      }
      scale *= 128;
    }
    throw unsupported('invalid Go encoded name length');
  }
  const typeCache = new Map();
  function readType(address) {
    if (typeCache.has(address)) return typeCache.get(address);
    const start = typeOffset(address, 48), size = u64(start), pointers = u64(start + 8);
    const alignment = bytes[start + 21], kind = bytes[start + 23] & 31;
    if (!size || pointers > size || ![1, 2, 4, 8].includes(alignment) || size % alignment) throw unsupported('invalid Go type descriptor');
    let name = readName(goType.address + i32(start + 40));
    if (bytes[start + 20] & 2) {
      if (!name.startsWith('*')) throw unsupported('invalid extra-star Go type name');
      name = name.slice(1);
    }
    if (!name) throw unsupported('empty Go type name');
    const result = { name, size, kind, alignment };
    typeCache.set(address, result);
    return result;
  }
  function encodedLength(value) {
    const result = [];
    do { const rest = value % 128; value = Math.floor(value / 128); result.push(rest | (value ? 128 : 0)); } while (value);
    return Buffer.from(result);
  }
  function findType(expected) {
    const raw = Buffer.from(`*${expected.name}`), suffix = Buffer.concat([encodedLength(raw.length), raw]);
    const candidates = new Map(), pointers = new Set();
    let namePosition = typesStart;
    while ((namePosition = bytes.indexOf(suffix, namePosition)) >= 0 && namePosition < typesEnd) {
      const nameStart = namePosition++ - 1;
      if (nameStart < typesStart || bytes[nameStart] > 15 || nameStart + suffix.length + 1 > typesEnd) continue;
      const reference = Buffer.alloc(4); reference.writeInt32LE(nameStart - typesStart);
      let found = typesStart;
      while ((found = bytes.indexOf(reference, found)) >= 0 && found < typesEnd) {
        const start = found++ - 40;
        if (start < typesStart || start % 8 || start + 48 > typesEnd) continue;
        const address = goType.address + start - typesStart;
        let type;
        // A four-byte name offset can occur in unrelated data. Only complete
        // descriptors with the expected name and a pointer/struct pair qualify.
        try { type = readType(address); } catch { continue; }
        if (type.kind === 22 && type.name === `*${expected.name}` && type.size === 8 && start + 56 <= typesEnd) {
          pointers.add(u64(start + 48));
        } else if (type.kind === 25 && type.name === expected.name && start + 80 <= typesEnd) {
          candidates.set(address, type);
        }
      }
    }
    const matches = [...candidates].filter(([address]) => pointers.has(address));
    if (matches.length !== 1) throw unsupported(`${matches.length ? 'ambiguous' : 'missing'} type ${expected.name}`);
    const [address, type] = matches[0], start = typeOffset(address, 80);
    const fieldsAddress = u64(start + 56), length = u64(start + 64), capacity = u64(start + 72);
    if (length !== capacity || !length || length > goType.size / 24) throw unsupported(`invalid fields for ${type.name}`);
    const fieldsStart = typeOffset(fieldsAddress, length * 24), selected = {};
    for (let index = 0; index < length; index++) {
      const field = fieldsStart + index * 24, name = readName(u64(field));
      const contract = expected.fields[name];
      if (!contract) continue;
      const fieldType = readType(u64(field + 8)), offset = u64(field + 16);
      if (selected[name] || offset % fieldType.alignment || offset + fieldType.size > type.size) throw unsupported(`invalid field ${type.name}.${name}`);
      const expectedKind = contract[0].startsWith('*') ? 22 : contract[0] === 'string' ? 24 : contract[0] === 'uint32' ? 10 : 5;
      if (fieldType.name !== contract[0] || fieldType.size !== contract[1] || fieldType.kind !== expectedKind) {
        throw unsupported(`field contract changed for ${type.name}.${name}`);
      }
      selected[name] = { name, offset, type: fieldType.name, size: fieldType.size };
    }
    for (const name of Object.keys(expected.fields)) if (!selected[name]) throw unsupported(`missing field ${type.name}.${name}`);
    return { name: type.name, size: type.size, fields: selected };
  }
  const types = Object.fromEntries(Object.entries(typeFields).map(([key, expected]) => [key, findType(expected)]));

  // moduledata has changed in Google's Go fork. Locate its trailing rodata /
  // gofunc / epclntab triple by the exact section boundary, not a moduledata
  // field offset or an address from one build.
  const module = section('__go_module');
  if (u64(module.fileOffset) !== pcln.address) throw unsupported('moduledata does not identify its pclntab');
  const ends = [];
  for (let offset = 16; offset + 8 <= module.size; offset += 8) {
    if (u64(module.fileOffset + offset) === pcln.address + pcln.size) ends.push(offset);
  }
  if (ends.length !== 1) throw unsupported('moduledata has no unique epclntab boundary');
  const boundary = module.fileOffset + ends[0];
  const rodata = u64(boundary - 16), gofunc = u64(boundary - 8);
  if (gofunc < pcln.address || gofunc >= pcln.address + pcln.size) throw unsupported('gofunc is outside pclntab');
  fileOffset(rodata, 1);
  const dataOffset = (address, size) => {
    if (address < pcln.address || address + size > pcln.address + pcln.size) throw unsupported('function data is outside pclntab');
    return fileOffset(address, size);
  };
  const outerInfo = functions.getCascadeConfigForTrajectory.funcDataFileOffset;
  range(outerInfo, 44, pclnEnd);
  const pcDataCount = u32(outerInfo + 28), funcDataCount = bytes[outerInfo + 43];
  const funcDataStart = outerInfo + 44 + pcDataCount * 4;
  range(funcDataStart, funcDataCount * 4, pclnEnd);
  if (funcDataCount < 2 || u32(funcDataStart + 4) === 0xffffffff) throw unsupported('missing outer-function locals map');
  const localsAddress = gofunc + u32(funcDataStart + 4), localsStart = dataOffset(localsAddress, 8);
  const mapCount = i32(localsStart), bitCount = i32(localsStart + 4), stride = Math.ceil(bitCount / 8);
  if (mapCount <= 0 || bitCount <= 0) throw unsupported('invalid outer-function locals map');
  const mapStart = dataOffset(localsAddress + 8, mapCount * stride);
  const masks = Array.from({ length: mapCount }, (_, index) => [...bytes.subarray(mapStart + index * stride, mapStart + (index + 1) * stride)]);
  const stackObjects = [];
  if (funcDataCount > 2 && u32(funcDataStart + 8) !== 0xffffffff) {
    const objectAddress = gofunc + u32(funcDataStart + 8), objectStart = dataOffset(objectAddress, 8);
    const objectCount = u64(objectStart), records = dataOffset(objectAddress + 8, objectCount * 16);
    for (let index = 0; index < objectCount; index++) {
      const record = records + index * 16, offset = i32(record), size = i32(record + 4), ptrBytes = i32(record + 8);
      if (offset % 8 || size <= 0 || ptrBytes < 0 || ptrBytes % 8 || ptrBytes > size) throw unsupported('invalid outer-function stack object');
      const maskSize = Math.ceil(ptrBytes / 64);
      const maskStart = maskSize ? fileOffset(rodata + u32(record + 12), maskSize) : 0;
      stackObjects.push({ offset, size, ptrBytes, mask: [...bytes.subarray(maskStart, maskStart + maskSize)] });
    }
  }
  return { format: 1, arch: 'arm64', pointerSize: 8, imageBase, functions, types,
    scratchGC: { locals: { n: mapCount, nbit: bitCount, masks }, stackObjects } };
}

/** Inspect a helper-owned executable before attaching; this never starts it. */
export async function readBackendMetadata(binaryPath) {
  return parseBackendMetadata(await readFile(binaryPath));
}
