/** A verified native localization site is unavailable in this build. */
export class NativeLocalizationError extends Error {}

export function stringLengthImmediate(word, register = 1) {
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

export function fileOffsetFor(metadata, address, size) {
  const segment = metadata.segments.find(value => address >= value.address &&
    address + size <= value.address + value.fileSize);
  if (!segment) throw new NativeLocalizationError('Native string has no file mapping');
  return segment.fileOffset + address - segment.address;
}

export function pageAddress(word, pc) {
  let delta = ((word >>> 5) & 0x7ffff) * 4 + ((word >>> 29) & 3);
  if (delta >= 0x100000) delta -= 0x200000;
  return Math.floor(pc / 4096) * 4096 + delta * 4096;
}

export function addressInstructions(register, address, pc) {
  const pages = Math.floor(address / 4096) - Math.floor(pc / 4096);
  if (!Number.isSafeInteger(address) || address < 0 || pages < -0x100000 || pages > 0xfffff) {
    throw new Error('Native string is outside ADRP range');
  }
  const immediate = pages & 0x1fffff;
  return [(0x90000000 | ((immediate & 3) << 29) | ((immediate >>> 2) << 5) | register) >>> 0,
    (0x91000000 | ((address % 4096) << 10) | (register << 5) | register) >>> 0];
}
