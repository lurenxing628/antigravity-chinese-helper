import { inspectNativeBinary } from './backend-metadata.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';

import { stringLengthImmediate, pageAddress, fileOffsetFor, addressInstructions } from './native-strings.mjs';

export { stringLengthImmediate, pageAddress, fileOffsetFor, addressInstructions };

const RET = 0xd65f03c0;
const decoder = new TextDecoder('utf-8', { fatal:true });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const normalize = value => value.trim().replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const commandDescription = /\/cli\/(?:commands\/commands|live\/live)\.(?:\(\*?[^)]+\)|[^.]+)\.Description$/;
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
        throw new CliCompatibilityError('Unsupported CLI settings display: live field copy changed');
      }
    }
    const address = pageAddress(word(0), metadata.imageBase + offset - fn.fileOffset + fn.rva) + ((word(1) >>> 10) & 0xfff);
    tables.push({offset:fileOffsetFor(metadata, address, size), size, fieldPrefix:''});
  }
  if (tables.length !== 1) throw new CliCompatibilityError('Unsupported CLI label display: settings table copy changed');

  // appendExternalSettingFields is inlined here. Its AI Credits field is a
  // separate 160-byte template copied with five Q16/Q17 pairs, not the loop.
  if (fn.name === settingsInitializer && fn.size >= 0x1450) {
    const offset = fn.fileOffset + 0x141c, word = index => buffer.readUInt32LE(offset + index * 4);
    const pairs = [0xad404450,0xad004430,0xad414450,0xad014430,0xad424450,
      0xad024430,0xad434450,0xad034430,0xad444450,0xad044430];
    if (word(0) !== 0x910463e1 || ((word(1) & 0x9f00001f) >>> 0) !== 0x90000002 ||
        ((word(2) & 0xffc003ff) >>> 0) !== 0x91000042 ||
        pairs.some((expected, index) => word(index + 3) !== expected)) {
      throw new CliCompatibilityError('Unsupported CLI settings display: external field copy changed');
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

function collectSupported(name, unsupported, inspect) {
  try { return inspect(); }
  catch (error) {
    if (!unsupported || !(error instanceof CliCompatibilityError)) throw error;
    unsupported.push(name);
    return null;
  }
}

function settingFieldSources(buffer, metadata, fields, unsupported) {
  const initializers = [settingsInitializer];
  if (findFunction(metadata, liveSettingsInitializer)) initializers.push(liveSettingsInitializer);
  return initializers.flatMap(name => collectSupported(name, unsupported, () => {
    const fn = uniqueFunction(metadata, name), slots = staticSettingsSlots(buffer, metadata, fn, fields);
    if (!slots.length && fields.some(([field]) => field === 'label')) {
      throw new CliCompatibilityError('Unsupported CLI label display: settings table copy changed');
    }
    return slots.map(source => ({fn, source}));
  }) ?? []);
}

/** Collect only verified fixed UI references; this never changes the executable. */
export function collectCliLocalizationPatches(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const translate = createTranslator(dictionary);
  const functions = metadata.functions instanceof Map ? metadata.functions.values() : metadata.functions;
  const patches = [], missing = [], unsupported = [];
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
    if (!commandDescription.test(fn.name)) continue;
    const source = collectSupported(fn.name, unsupported, () =>
      staticStringLeaf(buffer, metadata, uniqueFunction(metadata, fn.name)));
    if (source?.original) add(fn, source, 'go-string-leaf');
  }
  for (const {fn, source} of settingFieldSources(buffer, metadata, [['hint',16]], unsupported)) add(fn, source, 'go-string-slot');
  return {imageBase:metadata.imageBase, patches, missing, unsupported};
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

function findFunction(metadata, name) {
  return metadata.functions instanceof Map ? metadata.functions.get(name) : metadata.functions.find(fn => fn.name === name);
}

function uniqueFunction(metadata, name) {
  if (metadata.ambiguousFunctions?.has(name)) throw new CliCompatibilityError(`Ambiguous CLI UI function: ${name}`);
  const fn = findFunction(metadata, name);
  if (!fn) throw new CliCompatibilityError(`Unsupported CLI label display: missing ${name}`);
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
  const entries = [], missing = [], seen = new Set();
  for (const source of slots) {
    const translated = translate(source.original), key = `${source.sourceAddress}:${source.sourceLength}`;
    if (!translated) missing.push({original:source.original, field:source.field});
    else if (translated !== source.original && !seen.has(key)) {
      seen.add(key);
      const {original, sourceLength, sourceAddress} = source;
      entries.push({original, sourceLength, sourceRva:sourceAddress - metadata.imageBase, translated});
    }
  }
  // The same stack string is rendered twice with a two-space prefix and once
  // as a boxed string. Go can move the instruction blocks and the stack slot.
  const indented = [], boxed = [];
  for (let offset = 8; offset + 8 <= renderer.size; offset += 4) {
    const fileOffset = renderer.fileOffset + offset, rva = renderer.rva + offset;
    const word = delta => buffer.readUInt32LE(fileOffset + delta);
    const stackBase = word(-8), stackPage = word(-4), load = word(0);
    // ADD X27,SP,#imm; ADD X27,X27,#imm,LSL #12; LDP ..., [X27].
    if (((stackBase & 0xffc003ff) >>> 0) !== 0x910003fb ||
        ((stackPage & 0xffc003ff) >>> 0) !== 0x9140037b) continue;
    const stackOffset = ((stackBase >>> 10) & 0xfff) + ((stackPage >>> 10) & 0xfff) * 4096;
    const contextFileOffset = fileOffset - 8;
    const info = {word:load, replayFirst:true, functionName:renderer.name, fileOffset, rva, contextFileOffset};
    if (load === 0xa9401363 && offset + 24 <= renderer.size && word(4) === 0xaa1f03e0 &&
        ((word(8) & 0x9f00001f) >>> 0) === 0x90000001 &&
        ((word(12) & 0xffc003ff) >>> 0) === 0x91000021 && stringLengthImmediate(word(16), 2) === 2 &&
        branchTarget(word(20), rva + 20) === concat.rva) {
      const prefixAddress = pageAddress(word(8), metadata.imageBase + rva + 8) + ((word(12) >>> 10) & 0xfff);
      const prefixOffset = fileOffsetFor(metadata, prefixAddress, 2);
      if (buffer.toString('utf8', prefixOffset, prefixOffset + 2) !== '  ') continue;
      indented.push({stackOffset, site:{...info, pointerRegister:3, lengthRegister:4,
        originalContext:Buffer.from(buffer.subarray(contextFileOffset, fileOffset + 24))}});
    } else if (load === 0xa9400760 && branchTarget(word(4), rva + 4) === boxString.rva) {
      boxed.push({stackOffset, site:{...info, pointerRegister:0, lengthRegister:1,
        originalContext:Buffer.from(buffer.subarray(contextFileOffset, fileOffset + 8))}});
    }
  }
  const [first, second] = indented;
  const sameStack = boxed.filter(candidate => candidate.stackOffset === first?.stackOffset);
  if (indented.length !== 2 || first.stackOffset !== second.stackOffset || sameStack.length !== 1) {
    throw new CliCompatibilityError('Unsupported CLI label display: load at renderer changed');
  }
  const sites = [first.site, second.site, sameStack[0].site];
  return {imageBase:metadata.imageBase, entries, sites, missing};
}
