import { inspectNativeBinary } from './backend-metadata.mjs';
import { applyCliContentDisplayStrings } from './cli-display.mjs';

const nuxRenderer = 'google3/third_party/jetski/cli/model/model.(*ConversationModel).nuxCard';
const styleSetter = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.(*Style).set';
const noticePrefix = 'cli-notice:';
const masked = (word, mask, value) => ((word & mask) >>> 0) === (value >>> 0);
const signed = (value, bits) => value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
const branchTarget = (word, pc) => masked(word, 0xfc000000, 0x94000000)
  ? pc + signed(word & 0x3ffffff, 26) * 4 : null;

function uniqueFunction(metadata, name) {
  const fn = metadata.functions.get(name);
  if (!fn || metadata.ambiguousFunctions?.has(name)) throw new Error('CLI 系统公告显示入口未找到');
  return fn;
}

function checkWords(buffer, fn, offset, expected) {
  return offset >= 0 && offset + expected.length * 4 <= fn.size &&
    expected.every((word, index) => buffer.readUInt32LE(fn.fileOffset + offset + index * 4) === word);
}

/** NUX title/body are system UI fields; their source object and ID stay intact. */
export function collectCliNoticeDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const fn = uniqueFunction(metadata, nuxRenderer), setStyle = uniqueFunction(metadata, styleSetter);
  const growSlice = uniqueFunction(metadata, 'runtime.growslice');
  // IDA: follow ConversationModel -> Store.nux, select the current NUX, then
  // load its Title string at 0x48. The original model pointer remains in X5.
  const source = [0x914063fb, 0xf952a765, 0xf94000a5, 0xf94000a5, 0x910820bb,
    0xa9401b65, 0xb5000066, 0xaa1f03e5, 0x14000002, 0xf94000a5, 0xb4000065, 0xa9449ca6];
  const title = [0xa9449ca6, 0x14000003, 0xaa1f03e7, 0xaa1f03e6, 0x914023fb, 0xf9295765,
    0xb50000a7, 0xaa1f03e0, 0xaa1f03e4, 0xaa1f03e1, 0x14000047, 0x914023fb,
    0xf9280f66, 0x914023fb, 0xf927fb67, 0x914037e0, 0x910ac000, 0xd2800144,
    0xa8817c1f, 0xa8817c1f, 0xa8817c1f, 0xa8817c1f, 0xd1000484, 0xb5ffff64,
    0xf900001f, 0x914037e0, 0x910ac000, 0xb24003e1];
  const body = [0xb40000a5, 0xf9402ca6, 0xb4000066, 0xa9401cc6, 0x14000003,
    0xaa1f03e7, 0xaa1f03e6, 0xb4000407, 0x91000421, 0xeb01001f, 0x54000262,
    0x914023fb, 0xf9280b66, 0x914023fb, 0xf927f767, 0xaa0003e2, 0xb24003e3, 0xaa0403e0];
  const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
  const addressLoad = (offset, register) => masked(word(offset), 0x9f00001f, 0x90000000 | register) &&
    masked(word(offset + 4), 0xffc003ff, 0x91000000 | (register << 5) | register);
  // X9..X17 have no live reads in either verified window before its Go call.
  // Keep Q16/Q17 style-copy registers separate from these integer registers.
  if (!checkWords(buffer, fn, 0x44, source) || !checkWords(buffer, fn, 0x70, title) ||
      !addressLoad(0xe0, 2) || !addressLoad(0xe8, 3) ||
      branchTarget(word(0xf0), fn.rva + 0xf0) !== setStyle.rva ||
      !checkWords(buffer, fn, 0x1b4, body) || !addressLoad(0x1fc, 4) ||
      branchTarget(word(0x204), fn.rva + 0x204) !== growSlice.rva) {
    throw new Error('CLI 系统公告标题或正文显示布局已变化');
  }
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI notice translations must be an object');
  const entries = Object.entries(strings).filter(([key, value]) => key.startsWith(noticePrefix) &&
    key.length > noticePrefix.length && typeof value === 'string' && value.length > 0)
    .map(([key, translated]) => ({ original:key.slice(noticePrefix.length), translated,
      sourceLength:Buffer.byteLength(key.slice(noticePrefix.length), 'utf8') }));
  const sites = [
    {offset:0x70, contextOffset:0x44, contextSize:0xb0, word:0xa9449ca6},
    {offset:0x1c0, contextOffset:0x1b4, contextSize:0x54, word:0xa9401cc6},
  ].map(site => ({ rva:fn.rva + site.offset, fileOffset:fn.fileOffset + site.offset,
    word:site.word, pointerRegister:6, lengthRegister:7, replayFirst:true,
    contextFileOffset:fn.fileOffset + site.contextOffset,
    originalContext:Buffer.from(buffer.subarray(fn.fileOffset + site.contextOffset,
      fn.fileOffset + site.contextOffset + site.contextSize)) }));
  return { imageBase:metadata.imageBase, entries, sites, matchContent:true };
}

/** Match known system announcement text, including its server-owned heap string. */
export function applyCliNoticeDisplayStrings(buffer, plan, options) {
  return applyCliContentDisplayStrings(buffer, plan, options);
}
