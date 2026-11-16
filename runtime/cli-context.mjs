import { CONTEXT_OVERRIDES_ENABLED } from './context-policy.mjs';

const contextMethod = 'google3/third_party/jetski/cli/backend/backend.(*ServerBackend).ContextWindow';

/** Feed the native main-session config builder at its existing budget source. */
export function collectCliMainContextPatch(buffer, metadata, tokens,
  { contextOverridesEnabled = CONTEXT_OVERRIDES_ENABLED } = {}) {
  if (!contextOverridesEnabled || tokens === null) return null;
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 2147483647) throw new RangeError('主代理上下文必须是正整数 token');
  const fn = metadata.functions.get(contextMethod);
  if (!fn || metadata.ambiguousFunctions?.has(contextMethod)) throw new Error('CLI 主代理预算入口未找到');
  const words = Array.from({ length:fn.size / 4 }, (_, index) => buffer.readUInt32LE(fn.fileOffset + index * 4));
  // IDA: this method locks, reads settings.contextWindow as a Go string, then
  // unlocks. Return before its frame/lock is entered, using the same X0/X1 ABI.
  const reads = words.filter(word => word === 0xa9450400); // ldp x0,x1,[x0,#0x50]
  if (words[0] !== 0xf9400b90 || words[1] !== 0xeb3063ff ||
      ((words[2] & 0xff00001f) >>> 0) !== 0x54000009 || reads.length !== 1 ||
      !words.includes(0xd65f03c0)) throw new Error('CLI 主代理预算入口布局已变化');
  return { functionName:contextMethod, fileOffset:fn.fileOffset, rva:fn.rva, imageBase:metadata.imageBase,
    value:String(tokens), originalInstructions:Buffer.from(buffer.subarray(fn.fileOffset, fn.fileOffset + 16)) };
}

export function applyCliMainContextPatch(buffer, patch, address) {
  if (!patch) return;
  if (!buffer.subarray(patch.fileOffset, patch.fileOffset + 16).equals(patch.originalInstructions)) {
    throw new Error('CLI 主代理预算入口已变化');
  }
  const pc = patch.imageBase + patch.rva;
  const delta = Math.floor(address / 4096) - Math.floor(pc / 4096);
  if (!Number.isSafeInteger(address) || delta < -0x100000 || delta > 0xfffff) throw new Error('CLI 主代理预算文本地址无效');
  const immediate = delta & 0x1fffff;
  const words = [0x90000000 | ((immediate & 3) << 29) | ((immediate >>> 2) << 5),
    0x91000000 | ((address % 4096) << 10), 0xd2800001 | (patch.value.length << 5), 0xd65f03c0];
  words.forEach((word, index) => buffer.writeUInt32LE(word >>> 0, patch.fileOffset + index * 4));
}
