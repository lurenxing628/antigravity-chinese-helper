import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';

const cli = 'google3/third_party/jetski/cli/';
const model = cli + 'model/model.';
const detail = model + 'SubagentDetailModel.';
const agents = model + 'AgentsModel.';
const selections = model + '(*AgentsModel).refreshSelections';
const concat = 'runtime.concatstring2';

function literals(name, entries, verifiedCalls = []) {
  return { name, optional:true, resolve:relocateStatusLiteralGroup,
    literals:entries, verifiedCalls };
}

function literal(name, text, pointer, length = pointer + 1, lengthOffset = 8, consumer) {
  return literals(name, [[0, lengthOffset, pointer, length, text]], consumer ? [consumer] : []);
}

function formats(name, values) {
  return { name, optional:true, formats:values };
}

// Each expression is anchored to its display owner. Agent names, keybinding IDs,
// tool arguments and generated text never pass through these replacements.
export const cliSubagentLiteralProfiles = [
  literal(agents + 'View', '(active: ', 1, 2, 8, [24, 'runtime.concatstring3']),
  formats(selections, ['%d running, %d done', '%d done']),
  literal(selections, 'Subagents', 5, 5, -8),
  literal(agents + 'Update.func3', 'Already using default agent.', 2, 3, 8,
    [20, cli + 'store/store.(*Manager).addCommandOutputWith']),
  formats(agents + 'Update.func4', ['Prepared switch to default agent (will %s on exit).']),
  literals(agents + 'Update.func4', [
    [0, -4, 0, 1, 'Prepared switch to default agent (will apply on exit).'],
    [16, 12, 0, 1, 'Prepared switch to default agent (will apply on exit).'],
  ]),
  literal(agents + 'Update.func5', 'Already selected agent: ', 1, 2, 8, [12, concat]),
  literals(agents + 'Update.func6', [
    [0, 8, 1, 2, 'Prepared selection: '],
    [12, 20, 5, 6, ' (will apply on exit).'],
  ], [[24, 'runtime.concatstring3']]),
  formats(agents + 'Update.func6', ['Prepared selection: %s (will %s on exit).']),
  ...['Update.func4', 'Update.func6'].flatMap(method => ['fork the current conversation', 'create a new conversation']
    .map(text => literal(agents + method, text, 3))),

  literal(detail + 'buildHeaderLines', 'main › ', 1, 2, 8, [12, concat]),
  literal(detail + 'buildHeaderLines', 'ID: ', 1, 2, 8, [12, concat]),
  formats(detail + 'buildHeaderLines', ['worked %s', '%d steps']),
  formats(detail + 'View', ['  (%d–%d of %d lines)']),
  formats(detail + 'buildContentLines', ['Trajectory — %s (%d steps)']),
  ...[
    ['Prompt', 4], ['(no prompt available)', 3], ['  (no subagent data)', 3], ['Tools', 3, 5],
    ['No tools used yet', 4], ['⚠ Approval Required', 4], ['Tool', 13, 14, -4],
    ['Yes, approve', 5, 7], ['No, deny', 5, 7], ['Answer', 5, 7], ['Skip', 5, 7],
    ['No steps yet', 3], ['⚠ Error', 4],
  ].map(args => literal(detail + 'buildContentLines', ...args)),
  ...[
    ['navigate', 4], ['select', 2, 4, -60], ['confirm', 2, 4, -48], ['cancel', 6, 6, -44],
  ].map(args => literal(detail + 'renderHints', ...args)),
  formats(detail + 'handleApproval.func1', ['Tool confirmation failed: %v']),
  formats(model + 'StatusLineModel.renderRight', ['%d subagent(s)']),
];

// The header uses the status enum to choose a color and a duration first. Only
// translate the final status argument to concatstring3, in X5/X6.
export function collectCliSubagentStatusDisplayStrings(buffer, dictionary, metadata) {
  const name = detail + 'buildHeaderLines';
  const consumer = 'runtime.concatstring3';
  const fn = metadata.functions.get(name), target = metadata.functions.get(consumer);
  const plan = {imageBase:metadata.imageBase, matchContent:true, entries:[], sites:[], missing:[]};
  if (!fn && !metadata.ambiguousFunctions?.has(name)) return plan;
  if (!fn || !target || metadata.ambiguousFunctions?.has(name) || metadata.ambiguousFunctions?.has(consumer)) {
    throw new CliCompatibilityError('CLI 子代理详情状态入口已变化');
  }
  const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
  const isStackLoad = (offset, register) => ((word(offset) & 0xffc003ff) >>> 0) === ((0xf94003e0 | register) >>> 0);
  for (let offset = 4; offset + 16 <= fn.size; offset += 4) {
    const call = word(offset + 12);
    if (call >>> 26 !== 0x25 || fn.rva + offset + 12 + (call << 6 >> 4) !== target.rva ||
        !isStackLoad(offset - 4, 5) || !isStackLoad(offset, 6) || word(offset + 4) !== 0xaa0003e1 ||
        word(offset + 8) !== 0xaa1f03e0) continue;
    const fileOffset = fn.fileOffset + offset;
    plan.sites.push({functionName:name, rva:fn.rva + offset, fileOffset, word:word(offset),
      pointerRegister:5, lengthRegister:6, replayFirst:true, contextFileOffset:fileOffset - 4,
      originalContext:Buffer.from(buffer.subarray(fileOffset - 4, fileOffset + 16))});
  }
  if (plan.sites.length !== 1) throw new CliCompatibilityError('CLI 子代理详情状态入口已变化');
  const strings = dictionary.strings ?? dictionary;
  for (const original of ['running', 'done', 'idle', 'error', 'killed']) {
    const translated = strings['cli-subagent-status:' + original] ?? strings['cli-ui:' + original];
    if (!translated) plan.missing.push({functionName:name, original});
    else if (translated !== original) plan.entries.push({original, translated, sourceLength:Buffer.byteLength(original)});
  }
  return plan;
}
