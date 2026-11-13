import { readFile } from 'node:fs/promises';

const functionNames = {
  getCascadeConfigForTrajectory: 'google3/third_party/jetski/cortex/cortex.(*CascadeManager).getCascadeConfigForTrajectory',
  getCascadeConfig: 'google3/third_party/jetski/cortex/cortex.(*CascadeManager).getCascadeConfig',
  GetCascadeConversationalConfigWithExperiment: 'google3/third_party/jetski/cortex/config/config.GetCascadeConversationalConfigWithExperiment',
  clampAndValidateConfig: 'google3/third_party/jetski/cortex/config/config.clampAndValidateConfig',
  ClampCheckpointConfigForModelInfo: 'google3/third_party/jetski/cortex/utils/utils.ClampCheckpointConfigForModelInfo',
  GetModelInfoFromPlannerConfig: 'google3/third_party/jetski/cortex/config/config.GetModelInfoFromPlannerConfig',
  ResolveCustomAgentSpec: 'google3/third_party/jetski/cortex/sdk/sdk.ResolveCustomAgentSpec',
  runInvocationHooks: 'google3/third_party/oneharness/internal/core/core.runInvocationHooks',
  stepPreInvocation: 'google3/third_party/oneharness/internal/core/core.(*Machine).stepPreInvocation',
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
  Machine: { name:'core.Machine', fields:{ agent:['*core.Agent',8], input:['*core.RunInput',8] } },
  RunInput: { name:'core.RunInput', fields:{ Trajectory:['trajectory.Trajectory',16,20], ExecutionMetadata:['core.ExecutionMetadata',80,25], MaxContextTokens:['int',8,2] } },
  Agent: { name:'core.Agent', fields:{ Serializer:['core.Serializer',16,20] } },
  ExecutionMetadata: { name:'core.ExecutionMetadata', fields:{ PlannerConfig:['*cortex_go_proto.CascadePlannerConfig',8] } },
  AugmentedSerializer: { name:'integration.AugmentedSerializer', fields:{ Serializer:['core.Serializer',16,20] } },
  DefaultSerializer: { name:'serializers.DefaultSerializer', fields:{ fallbackConverter:['serializers.StepFallbackConverter',16,20] } },
  TrajectoryChatConverter: { name:'chatconverters.TrajectoryChatConverter', fields:{ checkpointConfig:['*cortex_go_proto.CheckpointConfig',8], plannerModelInfo:['*codeium_common_go_proto.ModelInfo',8] } },
  Step: { name:'gemini_coder_go_proto.Step', fields:{ Step:['gemini_coder_go_proto.isStep_Step',16,20] } },
  StepUserInput: { name:'gemini_coder_go_proto.Step_UserInput', fields:{ UserInput:['*cortex_go_proto.CortexStepUserInput',8] } },
  CortexStepUserInput: { name:'cortex_go_proto.CortexStepUserInput', fields:{ UserConfig:['*cortex_go_proto.CascadeConfig',8] } },
  ProtoTrajectory: { name:'trajectory.protoTrajectory', fields:{ metadata:['*cortex_go_proto.CortexTrajectoryMetadata',8] } },
  DbTrajectory: { name:'dbtrajectory.dbTrajectory', fields:{ pb:['*gemini_coder_go_proto.Trajectory',8] } },
  Trajectory: { name:'gemini_coder_go_proto.Trajectory', fields:{ Metadata:['*cortex_go_proto.CortexTrajectoryMetadata',8] } },
  IapiStrippingTrajectory: { name:'integration.iapiStrippingTrajectory', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
  ExecutionIDDecorator: { name:'decorators.executionIDDecorator', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
  StagingDecorator: { name:'decorators.StagingDecorator', fields:{ base:['trajectory.Trajectory',16,20] } },
  StepEnricherDecorator: { name:'decorators.stepEnricherDecorator', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
  TruncationDecorator: { name:'decorators.TruncationDecorator', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
  AccumulatorDecorator: { name:'decorators.AccumulatorDecorator', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
  AgentStateUpdaterDecorator: { name:'decorators.AgentStateUpdaterDecorator', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
  TelemetryDecorator: { name:'decorators.TelemetryDecorator', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
  TranscriptLogDecorator: { name:'decorators.TranscriptLogDecorator', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
  ReplacerDecorator: { name:'decorators.replacerDecorator', fields:{ Trajectory:['trajectory.Trajectory',16,20] } },
};

const unsupported = message => new Error(`Unsupported backend metadata: ${message}`);
const describeBudgetSlot = (rva, size) => ({ rva, size, codeRva:rva + 32, capacity:size - 32 });

function readMachO(input) {
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
  const segments = [], sections = new Map(), allSections = [], commands = [];
  let position = 32;
  for (let index = 0; index < commandCount; index++) {
    range(position, 8, commandEnd);
    const command = u32(position), size = u32(position + 4);
    if (size < 8 || size % 8) throw unsupported('invalid Mach-O load command size');
    range(position, size, commandEnd);
    commands.push({ command, size, position });
    if (command === 0x19) {
      if (size < 72) throw unsupported('truncated Mach-O segment');
      const address = u64(position + 24), memorySize = u64(position + 32);
      const fileOffset = u64(position + 40), fileSize = u64(position + 48), count = u32(position + 64);
      if (72 + count * 80 > size || fileSize > memorySize) throw unsupported('invalid Mach-O segment sections');
      range(fileOffset, fileSize);
      const segment = { name:fixedName(position + 8), address, memorySize, fileOffset, fileSize,
        maximumProtection:u32(position + 56), protection:u32(position + 60), sections:[] };
      segments.push(segment);
      for (let sectionIndex = 0; sectionIndex < count; sectionIndex++) {
        const start = position + 72 + sectionIndex * 80;
        const name = fixedName(start), sectionAddress = u64(start + 32), sectionSize = u64(start + 40);
        if (sectionAddress < address || sectionSize > address + memorySize - sectionAddress) throw unsupported('section is outside its segment');
        const offset = u32(start + 48), flags = u32(start + 64), zeroFill = [1, 12, 18].includes(flags & 255);
        if (!zeroFill && sectionSize) {
          range(offset, sectionSize);
          if (offset !== fileOffset + sectionAddress - address || sectionSize > fileSize - (offset - fileOffset)) {
            throw unsupported(`invalid ${name} file mapping`);
          }
        }
        const value = { name, address:sectionAddress, size:sectionSize, fileOffset:offset, zeroFill,
          relocationOffset:u32(start + 56), relocationCount:u32(start + 60) };
        segment.sections.push(value); allSections.push(value);
        if (['__text', '__lrodata_gopcln', '__go_type', '__go_module'].includes(name)) {
          if (sections.has(name)) throw unsupported(`ambiguous ${name} section`);
          sections.set(name, value);
        }
      }
    }
    position += size;
  }
  if (position !== commandEnd) throw unsupported('Mach-O load command length does not match');
  const imageBase = Math.min(...segments.filter(segment => segment.fileSize).map(segment => segment.address));
  const textSegments = segments.filter(segment => segment.name === '__TEXT');
  let budgetSlot = null;
  for (const { command, size, position } of commands) {
    if (command !== 0x31) continue;
    if (size < 40) throw unsupported('truncated Mach-O reservation note');
    if (fixedName(position + 8) !== 'AGHBudget') continue;
    if (budgetSlot || size !== 40 || textSegments.length !== 1) throw unsupported('invalid AGHBudget reservation note');
    const text = textSegments[0], offset = u64(position + 24), length = u64(position + 32);
    range(offset, length);
    const address = text.address + offset - text.fileOffset;
    if (text.fileOffset !== 0 || offset < commandEnd || offset + length > text.fileSize || length < 36 || address % 16 ||
        Math.floor(address / 16384) !== Math.floor((address + length - 1) / 16384) ||
        text.protection !== 5 || text.maximumProtection !== 5) throw unsupported('AGHBudget reservation is not in one RX text page');
    budgetSlot = describeBudgetSlot(address - imageBase, length);
  }
  return { bytes, range, u32, i32, u64, cstring, fixedName, segments, sections, allSections, commands,
    commandCount, commandEnd, imageBase, budgetSlot };
}

const overlap = (start, size, other, length) => start < other + length && other < start + size;
const nativePageSize = 16384;

// Admission belongs to the copied file's one Mach-O reader. The note names a
// structural, file-backed RX padding range; it does not own budget semantics.
function budgetReservation(mach) {
  const { bytes, range, u32, u64, fixedName, segments, allSections, commands, commandEnd, imageBase } = mach;
  const textSegments = segments.filter(segment => segment.name === '__TEXT');
  if (textSegments.length !== 1) throw unsupported('budget reservation needs one __TEXT segment');
  const text = textSegments[0];
  if (text.protection !== 5 || text.maximumProtection !== 5 || text.fileOffset !== 0 || !text.sections.length || !text.fileSize) {
    throw unsupported('budget reservation needs file-backed RX text with declared sections');
  }
  const end = text.address + text.fileSize;
  const occupiedEnd = Math.max(text.address + commandEnd - text.fileOffset,
    ...text.sections.map(section => section.address + section.size));
  const address = Math.ceil(Math.max(occupiedEnd, Math.floor((end - 1) / nativePageSize) * nativePageSize) / 16) * 16;
  const size = end - address, offset = text.fileOffset + address - text.address;
  if (size < 36) throw unsupported('RX text has insufficient single-page tail padding for a budget reservation');
  const slot = describeBudgetSlot(address - imageBase, size);
  if (mach.budgetSlot && (slot.rva !== mach.budgetSlot.rva || slot.size !== mach.budgetSlot.size)) {
    throw unsupported('AGHBudget note does not identify the structural RX tail reservation');
  }
  const fileRange = (start, length, label) => {
    range(start, length);
    if (length && overlap(start, length, offset, size)) throw unsupported(`${label} occupies the budget reservation`);
    if (length && !mach.budgetSlot && overlap(start, length, commandEnd, 40)) {
      throw unsupported(`${label} occupies the AGHBudget note header space`);
    }
  };
  for (const segment of segments) {
    if (segment !== text && (overlap(segment.address, segment.memorySize, address, size) ||
        overlap(segment.fileOffset, segment.fileSize, offset, size))) throw unsupported('another segment occupies the budget reservation');
  }
  for (const section of allSections) {
    if (overlap(section.address, section.size, address, size)) throw unsupported('a section occupies the budget reservation');
    fileRange(section.relocationOffset, section.relocationCount * 8, 'section relocations');
    if (section.relocationCount) throw unsupported('classic section relocations are unsupported for budget reservation');
  }
  const streams = [], functionStarts = [], dataInCode = [], symbols = [];
  const simpleCommands = new Map([[0xc,24], [0x18,24], [0x80000018,24], [0x8000001f,24], [0x80000023,24],
    [0x20,24], [0xe,12], [0xf,12], [0x1b,24], [0x8000001c,12], [0x24,16], [0x25,16], [0x2a,16],
    [0x2f,16], [0x30,16], [0x32,24]]);
  for (const { command, position, size:commandSize } of commands) {
    const sized = required => { if (commandSize < required) throw unsupported(`truncated budget Mach-O command 0x${command.toString(16)}`); };
    if (command === 0x19) continue;
    if (simpleCommands.has(command)) { sized(simpleCommands.get(command)); continue; }
    if (command === 0x31) {
      sized(40);
      if (fixedName(position + 8) !== 'AGHBudget') fileRange(u64(position + 24), u64(position + 32), 'Mach-O note');
    } else if (command === 0x2) {
      sized(24);
      const start = u32(position + 8), count = u32(position + 12);
      fileRange(start, count * 16, 'symbol table'); fileRange(u32(position + 16), u32(position + 20), 'symbol strings');
      symbols.push({ start, count });
    } else if (command === 0xb) {
      sized(80);
      for (const [field, width] of [[6,8], [8,56], [10,4], [12,4], [14,8], [16,8]]) {
        fileRange(u32(position + 8 + field * 4), u32(position + 12 + field * 4) * width, 'dynamic symbol metadata');
      }
      if (u32(position + 68) || u32(position + 76)) throw unsupported('classic dynamic relocations are unsupported for budget reservation');
    } else if (command === 0x22 || command === 0x80000022) {
      sized(48);
      for (const [index, kind] of ['rebase', 'bind', 'weak-bind', 'lazy-bind', 'exports'].entries()) {
        const start = u32(position + 8 + index * 8), length = u32(position + 12 + index * 8);
        fileRange(start, length, `dyld ${kind}`);
        if (length && kind !== 'exports') streams.push({ start, length, kind });
      }
    } else if ([0x1d, 0x26, 0x29, 0x2e, 0x80000033].includes(command)) {
      sized(16);
      const start = u32(position + 8), length = u32(position + 12);
      fileRange(start, length, 'link-edit data');
      if (command === 0x26 && length) functionStarts.push({ start, length });
      if (command === 0x29 && length) dataInCode.push({ start, length });
    } else if (command === 0x80000028) {
      sized(24); fileRange(u64(position + 8), 4, 'main entry point');
    } else {
      throw unsupported(`unsupported Mach-O command 0x${command.toString(16)} for budget reservation`);
    }
  }
  function streamReader(start, length) {
    let position = start;
    const end = start + length;
    return {
      get done() { return position === end; },
      byte() { return bytes[range(position++, 1, end)]; },
      integer() {
        let value = 0n;
        for (let shift = 0n; shift < 70n; shift += 7n) {
          const byte = this.byte(); value |= BigInt(byte & 127) << shift;
          if (!(byte & 128)) {
            if (value > 0xffffffffffffffffn) throw unsupported('dyld integer exceeds uint64');
            return value;
          }
        }
        throw unsupported('unterminated dyld integer');
      },
      name() { while (this.byte()) {} },
    };
  }
  for (const { start, length, kind } of streams) {
    const stream = streamReader(start, length);
    let segment = null, cursor = 0n, type = 1;
    const advance = value => { cursor = BigInt.asUintN(64, cursor + value); };
    const setSegment = index => {
      if (index >= segments.length) throw unsupported('dyld fixup selects an absent segment');
      segment = segments[index]; cursor = stream.integer();
    };
    const write = (count, skip = 0n) => {
      if (!segment || count > BigInt(Math.floor(segment.memorySize / 4))) throw unsupported('invalid dyld fixup count');
      const width = type === 1 ? 8 : 4;
      for (let index = 0n; index < count; index++) {
        if (cursor > BigInt(segment.memorySize - width)) throw unsupported('dyld fixup leaves its segment');
        const location = segment.address + Number(cursor);
        if (overlap(location, width, address, size)) throw unsupported('dyld fixup writes into the budget reservation');
        advance(8n + skip);
      }
    };
    while (!stream.done) {
      const byte = stream.byte(), opcode = byte & 240, immediate = byte & 15;
      if (opcode === 0) continue;
      if (kind === 'rebase') {
        if (opcode === 0x10) type = immediate;
        else if (opcode === 0x20) setSegment(immediate);
        else if (opcode === 0x30) advance(stream.integer());
        else if (opcode === 0x40) advance(BigInt(immediate * 8));
        else if (opcode === 0x50) write(BigInt(immediate));
        else if (opcode === 0x60) write(stream.integer());
        else if (opcode === 0x70) write(1n, stream.integer());
        else if (opcode === 0x80) { const count = stream.integer(); write(count, stream.integer()); }
        else throw unsupported('unsupported dyld rebase opcode for budget reservation');
      } else {
        if (opcode === 0x10 || opcode === 0x30) continue;
        if (opcode === 0x20 || opcode === 0x60) stream.integer();
        else if (opcode === 0x40) stream.name();
        else if (opcode === 0x50) type = immediate;
        else if (opcode === 0x70) setSegment(immediate);
        else if (opcode === 0x80) advance(stream.integer());
        else if (opcode === 0x90) write(1n);
        else if (opcode === 0xa0) write(1n, stream.integer());
        else if (opcode === 0xb0) write(1n, BigInt(immediate * 8));
        else if (opcode === 0xc0) { const count = stream.integer(); write(count, stream.integer()); }
        else throw unsupported('unsupported dyld bind opcode for budget reservation');
      }
      if (![1, 2, 3].includes(type)) throw unsupported('unsupported dyld fixup type for budget reservation');
    }
  }
  for (const { start, length } of functionStarts) {
    const stream = streamReader(start, length);
    let functionAddress = BigInt(imageBase);
    while (!stream.done) {
      const delta = stream.integer(); if (!delta) break;
      functionAddress += delta;
      if (functionAddress >= BigInt(address) && functionAddress < BigInt(address + size)) {
        throw unsupported('function entry occupies the budget reservation');
      }
    }
  }
  for (const { start, length } of dataInCode) {
    if (length % 8) throw unsupported('truncated data-in-code records');
    for (let position = start; position < start + length; position += 8) {
      fileRange(u32(position), bytes.readUInt16LE(position + 4), 'data-in-code region');
    }
  }
  for (const { start, count } of symbols) {
    for (let index = 0; index < count; index++) {
      if ((bytes[start + index * 16 + 4] & 14) !== 14) continue; // Only N_SECT values identify a section address.
      const value = u64(start + index * 16 + 8);
      if (value >= address && value < address + size) throw unsupported('symbol occupies the budget reservation');
    }
  }
  if (bytes.subarray(offset, offset + size).some(value => value !== 0)) throw unsupported('budget reservation padding is not zero-filled');
  return { slot, offset };
}

function declareBudgetReservation(mach, { slot, offset }) {
  if (mach.budgetSlot) return;
  const buffer = mach.bytes;
  const firstSection = Math.min(...mach.allSections.filter(section => !section.zeroFill && section.size).map(section => section.fileOffset));
  if (mach.commandEnd + 40 > firstSection || mach.commandEnd + 40 > offset ||
      buffer.subarray(mach.commandEnd, mach.commandEnd + 40).some(value => value !== 0)) {
    throw unsupported('Mach-O header has insufficient padding for the AGHBudget note');
  }
  buffer.writeUInt32LE(0x31, mach.commandEnd); buffer.writeUInt32LE(40, mach.commandEnd + 4);
  buffer.write('AGHBudget', mach.commandEnd + 8);
  buffer.writeBigUInt64LE(BigInt(offset), mach.commandEnd + 24);
  buffer.writeBigUInt64LE(BigInt(slot.size), mach.commandEnd + 32);
  buffer.writeUInt32LE(mach.commandCount + 1, 16); buffer.writeUInt32LE(mach.commandEnd - 32 + 40, 20);
}

/** Declare a code reservation when only Mach-O metadata is needed. */
export function reserveBackendBudget(buffer) {
  const mach = readMachO(buffer), reservation = budgetReservation(mach);
  declareBudgetReservation(mach, reservation);
  return reservation.slot;
}

/** Prepare one owned copy and derive its Go layout from the same Mach-O parse. */
export function prepareBackendMetadata(buffer) {
  const mach = readMachO(buffer), reservation = budgetReservation(mach);
  declareBudgetReservation(mach, reservation);
  return decodeGoMetadata(mach, reservation.slot);
}

/** Inspect raw or prepared executables without changing the file. */
export function parseBackendMetadata(input) {
  const mach = readMachO(input);
  return decodeGoMetadata(mach, mach.budgetSlot ? budgetReservation(mach).slot : null);
}

// Go 1.20+ pclntab, rtype and GC contracts share the caller's Mach-O facts.
function decodeGoMetadata(mach, budgetSlot) {
  const { bytes, range, u32, i32, u64, cstring, segments, sections, imageBase } = mach;
  const section = name => {
    const result = sections.get(name);
    if (!result || !result.size) throw unsupported(`missing ${name} section`);
    return result;
  };
  const text = section('__text'), pcln = section('__lrodata_gopcln'), goType = section('__go_type');
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
    const candidates = new Map(), pointers = new Map();
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
          pointers.set(u64(start + 48), address);
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
      const expectedKind = contract[2] ?? (contract[0].startsWith('*') ? 22 : contract[0] === 'string' ? 24 : contract[0] === 'uint32' ? 10 : 5);
      if (fieldType.name !== contract[0] || fieldType.size !== contract[1] || fieldType.kind !== expectedKind) {
        throw unsupported(`field contract changed for ${type.name}.${name}`);
      }
      selected[name] = { name, offset, type: fieldType.name, size: fieldType.size };
    }
    for (const name of Object.keys(expected.fields)) if (!selected[name]) throw unsupported(`missing field ${type.name}.${name}`);
    return { name: type.name, size: type.size, rva:address - imageBase, pointerRva:pointers.get(address) - imageBase, fields: selected };
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
  return { format: 1, arch: 'arm64', pointerSize: 8, imageBase, functions, types, budgetSlot,
    scratchGC: { locals: { n: mapCount, nbit: bitCount, masks }, stackObjects } };
}

/** Inspect a helper-owned executable before attaching; this never starts it. */
export async function readBackendMetadata(binaryPath) {
  return parseBackendMetadata(await readFile(binaryPath));
}
