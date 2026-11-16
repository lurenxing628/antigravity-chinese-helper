import { inspectNativeBinary } from './backend-metadata.mjs';

export { stringLengthImmediate, pageAddress, fileOffsetFor, addressInstructions };

const RET = 0xd65f03c0;
const decoder = new TextDecoder('utf-8', { fatal:true });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const normalize = value => value.trim().replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const commandDescription = /\/cli\/commands\/commands\.(?:\(\*?[^)]+\)|[^.]+)\.Description$/;
const settingsInitializer = 'google3/third_party/jetski/cli/model/model.settingFields.func1';
const liveSettingsInitializer = 'google3/third_party/jetski/cli/model/model.liveSettingFields';
const settingsRenderer = 'google3/third_party/jetski/cli/model/model.SettingsModel.renderFieldLines';

function createTranslator(dictionary) {
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const normalized = new Map(Object.entries(strings).filter(([,value]) => typeof value === 'string')
    .map(([key, value]) => [normalize(key), value]));
  return original => {
    for (const key of [`cli-ui:${original}`, original]) {
      const value = own(strings, key) ? strings[key] : normalized.get(normalize(key));
      if (typeof value === 'string' && value) return value;
    }
    return null;
  };
}

function stringLengthImmediate(word, register = 1) {
  if (((word & 0xffe0001f) >>> 0) === (0xd2800000 | register) >>> 0) return (word >>> 5) & 0xffff;
  // Go also spells MOV X1,#length as ORR X1,XZR,#logical-immediate.
  if (((word & 0xff8003ff) >>> 0) !== (0xb20003e0 | register) >>> 0) return null;
  const n = (word >>> 22) & 1, immr = (word >>> 16) & 63, imms = (word >>> 10) & 63;
  const length = 31 - Math.clz32((n << 6) | ((~imms) & 63));
  if (length < 1) return null;
  const levels = (1 << length) - 1, set = imms & levels, rotate = immr & levels;
  if (set === levels) return null;
  const width = 1 << length, mask = (1n << BigInt(width)) - 1n;
  const ones = (1n << BigInt(set + 1)) - 1n;
  const element = ((ones >> BigInt(rotate)) | (ones << BigInt(width - rotate))) & mask;
  let value = 0n;
  for (let bit = 0; bit < 64; bit += width) value |= element << BigInt(bit);
  return value <= 0xffffn ? Number(value) : null;
}

function fileOffsetFor(metadata, address, size) {
  const segment = metadata.segments.find(value => address >= value.address &&
    address + size <= value.address + value.fileSize);
  if (!segment) throw new Error('CLI UI string has no file mapping');
  return segment.fileOffset + address - segment.address;
}

function pageAddress(word, pc) {
  let delta = ((word >>> 5) & 0x7ffff) * 4 + ((word >>> 29) & 3);
  if (delta >= 0x100000) delta -= 0x200000;
  return Math.floor(pc / 4096) * 4096 + delta * 4096;
}

// IDA verified this Go leaf shape in agy 1.5.9: return a static string in X0/X1.
// A field getter, an alias list, and a command's Name method do not match it.
function staticStringLeaf(buffer, metadata, fn) {
  if (fn.size !== 16) return null;
  const offset = fn.fileOffset;
  const adrp = buffer.readUInt32LE(offset), add = buffer.readUInt32LE(offset + 4);
  const sourceLength = stringLengthImmediate(buffer.readUInt32LE(offset + 8));
  const ret = buffer.readUInt32LE(offset + 12);
  if (((adrp & 0x9f00001f) >>> 0) !== 0x90000000 ||
      ((add & 0xffc003ff) >>> 0) !== 0x91000000 ||
      sourceLength === null || ret !== RET) return null;
  const pc = metadata.imageBase + fn.rva;
  const sourceAddress = pageAddress(adrp, pc) + ((add >>> 10) & 0xfff);
  const sourceOffset = fileOffsetFor(metadata, sourceAddress, sourceLength);
  const original = decoder.decode(buffer.subarray(sourceOffset, sourceOffset + sourceLength));
  return { sourceAddress, sourceLength, sourceOffset, original };
}

// These settingField templates are copied before get/set and option values are
// filled. Labels also act as IDs in filteredFields, so only hint slots change.
function staticSettingsSlots(buffer, metadata, fn, fields = [['hint',16]]) {
  const tables = [];
  for (let offset = fn.fileOffset; offset + 40 <= fn.fileOffset + fn.size; offset += 4) {
    const word = index => buffer.readUInt32LE(offset + index * 4);
    if (((word(0) & 0x9f00001f) >>> 0) !== 0x90000001 ||
        ((word(1) & 0xffc003ff) >>> 0) !== 0x91000021 || word(2) !== 0xaa0003e2 ||
        word(4) !== 0xacc14430 || word(5) !== 0xac814410 ||
        word(6) !== 0xacc14430 || word(7) !== 0xac814410 ||
        word(8) !== 0xd1000718 || word(9) !== 0xb5ffff78) continue;
    const iterations = stringLengthImmediate(word(3), 24);
    const tail = offset + 48 <= fn.fileOffset + fn.size &&
      word(10) === 0xad404430 && word(11) === 0xad004410 ? 32 : 0;
    const size = (iterations ?? 0) * 64 + tail;
    if (!size || size % 160) continue;
    if (fn.name === liveSettingsInitializer) {
      const nextObject = uniqueFunction(metadata, 'runtime.newobject');
      if (offset !== fn.fileOffset + 0x224 || iterations !== 12 || tail !== 32 ||
          offset + 68 > fn.fileOffset + fn.size || word(12) !== 0xf94067e1 || word(13) !== 0xf9004441 ||
          ((word(14) & 0x9f00001f) >>> 0) !== 0x90000000 ||
          ((word(15) & 0xffc003ff) >>> 0) !== 0x91000000 ||
          branchTarget(word(16), metadata.imageBase + fn.rva + 0x264) !== metadata.imageBase + nextObject.rva) {
        throw new Error('Unsupported CLI settings display: live field copy changed');
      }
    }
    const address = pageAddress(word(0), metadata.imageBase + offset - fn.fileOffset + fn.rva) + ((word(1) >>> 10) & 0xfff);
    tables.push({offset:fileOffsetFor(metadata, address, size), size, fieldPrefix:''});
  }
  if (tables.length !== 1) return [];

  // appendExternalSettingFields is inlined here. Its AI Credits field is a
  // separate 160-byte template copied with five Q16/Q17 pairs, not the loop.
  if (fn.name === settingsInitializer && fn.size >= 0x1450) {
    const offset = fn.fileOffset + 0x141c, word = index => buffer.readUInt32LE(offset + index * 4);
    const pairs = [0xad404450,0xad004430,0xad414450,0xad014430,0xad424450,
      0xad024430,0xad434450,0xad034430,0xad444450,0xad044430];
    if (word(0) !== 0x910463e1 || ((word(1) & 0x9f00001f) >>> 0) !== 0x90000002 ||
        ((word(2) & 0xffc003ff) >>> 0) !== 0x91000042 ||
        pairs.some((expected, index) => word(index + 3) !== expected)) {
      throw new Error('Unsupported CLI settings display: external field copy changed');
    }
    const address = pageAddress(word(1), metadata.imageBase + fn.rva + 0x1420) + ((word(2) >>> 10) & 0xfff);
    tables.push({offset:fileOffsetFor(metadata, address, 160), size:160, fieldPrefix:'external.'});
  }
  const slots = [];
  for (const table of tables) {
    for (let index = 0; index < table.size / 160; index++) {
      for (const [field, delta] of fields) {
        const fileOffset = table.offset + index * 160 + delta;
        const sourceAddress = Number(buffer.readBigUInt64LE(fileOffset));
        const sourceLength = Number(buffer.readBigUInt64LE(fileOffset + 8));
        if (!sourceLength) continue;
        const sourceOffset = fileOffsetFor(metadata, sourceAddress, sourceLength);
        const original = decoder.decode(buffer.subarray(sourceOffset, sourceOffset + sourceLength));
        slots.push({fileOffset, sourceAddress, sourceLength, sourceOffset, original,
          field:`${table.fieldPrefix}${index}.${field}`});
      }
    }
  }
  return slots;
}

function settingFieldSources(buffer, metadata, fields) {
  const initializers = [uniqueFunction(metadata, settingsInitializer)];
  const live = metadata.functions instanceof Map ? metadata.functions.get(liveSettingsInitializer)
    : metadata.functions.find(fn => fn.name === liveSettingsInitializer);
  if (live) initializers.push(uniqueFunction(metadata, liveSettingsInitializer));
  return initializers.flatMap(fn => {
    const slots = staticSettingsSlots(buffer, metadata, fn, fields);
    if (!slots.length && fields.some(([field]) => field === 'label')) {
      throw new Error('Unsupported CLI label display: settings table copy changed');
    }
    return slots.map(source => ({fn, source}));
  });
}

/** Collect only verified fixed UI references; this never changes the executable. */
export function collectCliLocalizationPatches(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const translate = createTranslator(dictionary);
  const functions = metadata.functions instanceof Map ? metadata.functions.values() : metadata.functions;
  const patches = [], missing = [];
  const add = (fn, source, kind) => {
    const translated = translate(source.original);
    if (!translated) {
      missing.push({functionName:fn.name, original:source.original, ...(source.field ? {field:source.field} : {})});
    } else if (translated !== source.original) {
      const fileOffset = source.fileOffset ?? fn.fileOffset;
      patches.push({kind, functionName:fn.name, rva:fn.rva, ...source, fileOffset, translated,
        originalInstructions:Buffer.from(buffer.subarray(fileOffset, fileOffset + 16))});
    }
  };
  for (const fn of functions) {
    const isDescription = commandDescription.test(fn.name);
    if (!isDescription) continue;
    if (metadata.ambiguousFunctions?.has(fn.name)) throw new Error(`Ambiguous CLI UI function: ${fn.name}`);
    const source = staticStringLeaf(buffer, metadata, fn);
    if (source?.original) add(fn, source, 'go-string-leaf');
  }
  for (const {fn, source} of settingFieldSources(buffer, metadata, [['hint',16]])) add(fn, source, 'go-string-slot');
  return {imageBase:metadata.imageBase, patches, missing};
}

/** Rewrite a caller-owned in-memory copy using its allocated UTF-8 string pool. */
export function applyCliLocalizationPatches(buffer, plan, allocateString) {
  const writes = [];
  for (const patch of plan.patches) {
    const current = buffer.subarray(patch.fileOffset, patch.fileOffset + 16);
    if (!current.equals(patch.originalInstructions)) throw new Error(`CLI UI function changed: ${patch.functionName}`);
    const utf8 = Buffer.from(patch.translated, 'utf8');
    if (utf8.length > 0xffff) throw new Error(`CLI UI translation is too long: ${patch.functionName}`);
    const address = allocateString(utf8);
    if (!Number.isSafeInteger(address) || address < 0) throw new Error('CLI UI string allocation returned an invalid address');
    let bytes;
    if (patch.kind === 'go-string-slot') {
      bytes = Buffer.alloc(16);
      bytes.writeBigUInt64LE(BigInt(address), 0);
      bytes.writeBigUInt64LE(BigInt(utf8.length), 8);
    } else if (patch.kind === 'go-string-leaf') {
      const pc = plan.imageBase + patch.rva;
      const pageDelta = Math.floor(address / 4096) - Math.floor(pc / 4096);
      if (pageDelta < -0x100000 || pageDelta > 0xfffff) throw new Error('CLI UI string pool is outside ADRP range');
      const immediate = pageDelta & 0x1fffff;
      bytes = Buffer.alloc(12);
      bytes.writeUInt32LE((0x90000000 | ((immediate & 3) << 29) | ((immediate >>> 2) << 5)) >>> 0, 0);
      bytes.writeUInt32LE((0x91000000 | ((address % 4096) << 10)) >>> 0, 4);
      bytes.writeUInt32LE((0xd2800001 | (utf8.length << 5)) >>> 0, 8);
    } else throw new Error(`Unknown CLI UI patch kind: ${patch.kind}`);
    writes.push({offset:patch.fileOffset, bytes});
  }
  for (const write of writes) write.bytes.copy(buffer, write.offset);
  return {translated:plan.patches.length, missing:plan.missing.length};
}

function uniqueFunction(metadata, name) {
  if (metadata.ambiguousFunctions?.has(name)) throw new Error(`Ambiguous CLI UI function: ${name}`);
  const fn = metadata.functions instanceof Map ? metadata.functions.get(name) : metadata.functions.find(fn => fn.name === name);
  if (!fn) throw new Error(`Unsupported CLI label display: missing ${name}`);
  return fn;
}

function branchTarget(word, pc) {
  if (((word & 0xfc000000) >>> 0) !== 0x94000000) return null;
  let immediate = word & 0x3ffffff;
  if (immediate >= 0x2000000) immediate -= 0x4000000;
  return pc + immediate * 4;
}

/** Read labels as identities and identify their three verified display loads. */
export function collectCliDisplayLabels(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const translate = createTranslator(dictionary);
  const renderer = uniqueFunction(metadata, settingsRenderer);
  const concat = uniqueFunction(metadata, 'runtime.concatstring2');
  const boxString = uniqueFunction(metadata, 'runtime.convTstring');
  const slots = settingFieldSources(buffer, metadata, [['label',0]]).map(({source}) => source);
  const labels = [], missing = [], seen = new Set();
  for (const source of slots) {
    const translated = translate(source.original), key = `${source.sourceAddress}:${source.sourceLength}`;
    if (!translated) missing.push({original:source.original, field:source.field});
    else if (translated !== source.original && !seen.has(key)) {
      seen.add(key);
      labels.push({...source, translated});
    }
  }
  const sites = [];
  // Relative positions belong to the agy 1.5.9 profile. Each also verifies the
  // stack source, register pair, prefix and original Go callee before patching.
  for (const profile of [
    {offset:0x17c, pointerRegister:3, lengthRegister:4, load:0xa9401363},
    {offset:0x5e8, pointerRegister:3, lengthRegister:4, load:0xa9401363},
    {offset:0x880, pointerRegister:0, lengthRegister:1, load:0xa9400760},
  ]) {
    const offset = renderer.fileOffset + profile.offset, rva = renderer.rva + profile.offset;
    const contextLength = profile.pointerRegister === 3 ? 32 : 16;
    if (profile.offset < 8 || profile.offset + contextLength - 8 > renderer.size) {
      throw new Error('Unsupported CLI label display: renderer range changed');
    }
    const word = delta => buffer.readUInt32LE(offset + delta);
    let valid = word(-8) === 0x9119c3fb && word(-4) === 0x9140737b && word(0) === profile.load;
    if (profile.pointerRegister === 3) {
      const prefixAddress = pageAddress(word(8), metadata.imageBase + rva + 8) + ((word(12) >>> 10) & 0xfff);
      valid &&= word(4) === 0xaa1f03e0 && ((word(8) & 0x9f00001f) >>> 0) === 0x90000001 &&
        ((word(12) & 0xffc003ff) >>> 0) === 0x91000021 && stringLengthImmediate(word(16), 2) === 2 &&
        branchTarget(word(20), metadata.imageBase + rva + 20) === metadata.imageBase + concat.rva;
      if (valid) {
        const prefixOffset = fileOffsetFor(metadata, prefixAddress, 2);
        valid = buffer.toString('utf8', prefixOffset, prefixOffset + 2) === '  ';
      }
    } else valid &&= branchTarget(word(4), metadata.imageBase + rva + 4) === metadata.imageBase + boxString.rva;
    if (!valid) throw new Error(`Unsupported CLI label display: load at renderer+0x${profile.offset.toString(16)} changed`);
    sites.push({...profile, functionName:renderer.name, fileOffset:offset, rva, resumeRva:rva + 4,
      contextFileOffset:offset - 8, originalContext:Buffer.from(buffer.subarray(offset - 8, offset - 8 + contextLength))});
  }
  return {imageBase:metadata.imageBase, labels, sites, missing};
}

function branchInstruction(from, to, register) {
  const delta = to - from, bits = register === undefined ? 26 : 19;
  if (delta % 4 || delta < -(2 ** (bits + 1)) || delta >= 2 ** (bits + 1)) {
    throw new Error('CLI display thunk branch is outside ARM64 range');
  }
  const immediate = (delta / 4) & (2 ** bits - 1);
  return register === undefined ? (0x14000000 | immediate) >>> 0 : (0xb5000000 | (immediate << 5) | register) >>> 0;
}

function addressInstructions(register, address, pc) {
  const pages = Math.floor(address / 4096) - Math.floor(pc / 4096);
  if (!Number.isSafeInteger(address) || address < 0 || pages < -0x100000 || pages > 0xfffff) {
    throw new Error('CLI display string is outside ADRP range');
  }
  const immediate = pages & 0x1fffff;
  return [(0x90000000 | ((immediate & 3) << 29) | ((immediate >>> 2) << 5) | register) >>> 0,
    (0x91000000 | ((address % 4096) << 10) | (register << 5) | register) >>> 0];
}

/** Translate only loaded display registers; source labels and Go calls stay intact. */
export function applyCliDisplayLabels(buffer, plan, {codeAddress, codeFileOffset, capacity, allocateString}) {
  if (!plan.labels.length) return {translated:0, sites:0, codeBytes:0};
  const codeBytes = plan.sites.length * (8 + plan.labels.length * 44);
  if (!Number.isSafeInteger(codeAddress) || !Number.isSafeInteger(codeFileOffset) || codeAddress % 4 || codeFileOffset % 4 ||
      codeFileOffset < 0 || codeBytes > capacity || codeFileOffset + codeBytes > buffer.length) {
    throw new Error('CLI display thunk reservation is too small or misaligned');
  }
  if (buffer.subarray(codeFileOffset, codeFileOffset + codeBytes).some(byte => byte !== 0)) {
    throw new Error('CLI display thunk reservation is not empty');
  }
  for (const site of plan.sites) {
    if (!buffer.subarray(site.contextFileOffset, site.contextFileOffset + site.originalContext.length).equals(site.originalContext)) {
      throw new Error('CLI label display code changed after inspection');
    }
  }
  const labels = plan.labels.map(label => {
    const utf8 = Buffer.from(label.translated, 'utf8');
    if (label.sourceLength > 0xffff || utf8.length > 0xffff) throw new Error('CLI display label exceeds MOV immediate range');
    return {...label, address:allocateString(utf8), length:utf8.length};
  });
  const code = Buffer.alloc(codeBytes), branches = [];
  let position = 0;
  const emit = word => { code.writeUInt32LE(word >>> 0, position); position += 4; };
  for (const site of plan.sites) {
    const thunkAddress = codeAddress + position;
    branches.push({offset:site.fileOffset, word:branchInstruction(plan.imageBase + site.rva, thunkAddress)});
    emit(site.load);
    for (const label of labels) {
      const next = codeAddress + position + 44;
      for (const word of addressInstructions(16, label.sourceAddress, codeAddress + position)) emit(word);
      emit(0xca000010 | (16 << 16) | (site.pointerRegister << 5)); // EOR X16,ptr,X16: preserves NZCV.
      emit(branchInstruction(codeAddress + position, next, 16));
      emit(0xd2800010 | (label.sourceLength << 5));
      emit(0xca000010 | (16 << 16) | (site.lengthRegister << 5));
      emit(branchInstruction(codeAddress + position, next, 16));
      for (const word of addressInstructions(site.pointerRegister, label.address, codeAddress + position)) emit(word);
      emit(0xd2800000 | (label.length << 5) | site.lengthRegister);
      emit(branchInstruction(codeAddress + position, plan.imageBase + site.resumeRva));
    }
    emit(branchInstruction(codeAddress + position, plan.imageBase + site.resumeRva));
  }
  code.copy(buffer, codeFileOffset);
  for (const patch of branches) buffer.writeUInt32LE(patch.word, patch.offset);
  return {translated:labels.length, sites:plan.sites.length, codeBytes};
}
