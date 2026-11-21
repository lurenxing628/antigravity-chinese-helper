import { CliCompatibilityError } from './cli-compatibility.mjs';
import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

// The two independent branches of toolStepInfo and the task detail panel can
// move by different amounts. Keep each dependent call and selection in its
// source block. The status collector commits the complete function together.
export function resolveTaskStatusProfile(buffer, metadata, profile) {
  const isTool = profile.name.endsWith('.toolStepInfo');
  const isDetail = profile.name.endsWith('.TaskDetailModel.buildTaskDetailLines');
  if (!isTool && !isDetail) return relocateStatusLiteralGroup(buffer, metadata, profile);

  const split = isTool ? 1 : 2;
  function resolve(literals, verifiedCalls) {
    return relocateStatusLiteralGroup(buffer, metadata, {name:profile.name, literals, verifiedCalls});
  }
  const first = resolve(profile.literals.slice(0, split), profile.verifiedCalls?.slice(0, 1));
  const rest = resolve(profile.literals.slice(split), profile.verifiedCalls?.slice(1));
  const delta = rest.literals[0][0] - profile.literals[split][0];
  return {
    ...profile,
    size:first.size,
    literals:[...first.literals, ...rest.literals],
    verifiedCalls:[...(first.verifiedCalls ?? []), ...(rest.verifiedCalls ?? [])],
    guards:profile.guards?.map(([offset, word]) => [offset + delta, word]),
  };
}

// TasksModel.View loads a status record into its frame and uses the status
// string's byte length for both Go string operations and two display widths.
// Resolve the stack slots from their real producers and verify their shared
// consumers before allowing the display-only width adjustment.
export function inspectTaskStatusWidths(buffer, metadata, fn, delta) {
  function mismatch() {
    throw new CliCompatibilityError('CLI 任务状态列宽来源或读取位置已变化');
  }
  function word(offset) {
    const at = offset + delta;
    if (at < 0 || at + 4 > fn.size) mismatch();
    return buffer.readUInt32LE(fn.fileOffset + at);
  }
  function frameSlot(offset, opcode, scale) {
    const base = word(offset - 4), field = word(offset);
    if (((base & 0xffc003ff) >>> 0) !== 0x914003fb || ((field & 0xffc003ff) >>> 0) !== opcode) mismatch();
    return ((base >>> 10) & 0xfff) * 4096 + ((field >>> 10) & 0xfff) * scale;
  }

  const taskFrameOffset = frameSlot(0x684, 0x39400364, 1) - 0x18;
  // The cancellation and exit selections use the same BackgroundTaskInfo.
  if (taskFrameOffset < 0 || taskFrameOffset >= 0x1000000 ||
      frameSlot(0x6a0, 0x39400365, 1) !== taskFrameOffset + 0x41 ||
      frameSlot(0x6ac, 0xb9800365, 4) !== taskFrameOffset + 0x44 || word(0x6b0) !== 0x710018bf ||
      frameSlot(0x6cc, 0x39400365, 1) !== taskFrameOffset + 0x30 ||
      frameSlot(0x6d8, 0x39400365, 1) !== taskFrameOffset + 0x40) mismatch();

  const statusLength = frameSlot(0x86c, 0xf9000364, 8);
  for (const offset of [0x96c, 0xae0, 0xb50, 0xbb4, 0xc18]) {
    if (frameSlot(offset, 0xf9400364, 8) !== statusLength) mismatch();
  }
  if (frameSlot(0x9cc, 0xf9400363, 8) !== statusLength ||
      word(0x990) !== 0xcb0400a4 || word(0x9d0) !== 0x8b000063) mismatch();
  const sites = [[0x96c, 4], [0x9cc, 3]].map(([offset, register]) => ({
    rva:fn.rva + offset + delta, fileOffset:fn.fileOffset + offset + delta, register, word:word(offset),
  }));
  return {imageBase:metadata.imageBase, taskFrameOffset, sites};
}
