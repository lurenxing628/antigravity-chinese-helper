import { CliCompatibilityError } from './cli-compatibility.mjs';
import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';
import { fileOffsetFor, pageAddress } from './native-strings.mjs';

const model = 'google3/third_party/jetski/cli/model/model.';
const backend = 'google3/third_party/jetski/cli/backend/backend.';
const style = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.';

// Model identifiers, including the effort map's low/medium/etc. keys, are not
// display strings. Patch only the independent description written to each value.
const descriptions = [
  [0x1028, 0x1008, 4, 1, 'Faster responses, lighter reasoning — great for simpler tasks'],
  [0x1070, 0x1050, 4, 4, 'Balanced speed and reasoning quality for most tasks'],
  [0x10b8, 0x1098, 4, 4, 'Deeper reasoning for complex problems — slower but stronger'],
  [0x1100, 0x10e0, 4, 4, 'Extra-deep reasoning for demanding problems — slower than high'],
  [0x1160, 0x1128, 1, 4, 'Maximum reasoning for the hardest problems — slowest but most thorough'],
];
export const modelLiteralProfiles = [
  ...descriptions.map(literal => ({
    name:model + 'init', literals:[literal], verifiedCalls:[[literal[1] - 4, 'runtime.mapassign_faststr']],
  })),
  // Both pointer selection and "/model NAME" format the user-visible confirmation.
  ...[model + 'SelectorModel.selectRow.func1',
    'google3/third_party/jetski/cli/commands/commands.(*modelCommand).Execute.func2'].map(name => ({
    name, literals:[[0,8,0,1,'Model set to %s',24]],
  })),
  {name:model + 'SelectorModel.selectRow.func1', optional:true,
    literals:[[0,8,0,1,' with a %s context window',24]], verifiedCalls:[[48,'runtime.concatstring2']]},
  // The optional context window and closing parenthesis are separate concat arguments.
  {name:model + 'SelectorModel.renderRow', literals:[[0x2f8,0x2dc,1,2,' (current']],
    verifiedCalls:[[0x300,'runtime.concatstring3']]},
  {name:model + 'EffortSelectorModel.renderGauge', literals:[[0xa50,0xa58,3,4,'  (current)']],
    verifiedCalls:[[0xa5c,'runtime.concatstring2']]},
  ...['SelectorModel.effortCellWidth', 'SelectorModel.renderContextChip'].map(method => ({
    name:model + method, literals:[[0,8,0,1,'  Effort  ']], verifiedCalls:[[12,style + 'Width']],
  })),
  // Translate both the measured caption and the rendered caption.
  {name:model + 'SelectorModel.renderEffortBar', literals:[
    [0xa28,0xa30,0,1,'  Effort  '], [0xa5c,0xa64,2,3,'Effort'],
  ], verifiedCalls:[[0xa34,style + 'Width'],[0xab4,style + 'Style.Render']]},
].map(profile => ({...profile, resolve:relocateStatusLiteralGroup}));

const variantCaptions = [['Orchestrator','model-mode:Orchestrator'], ['Planner','cli-ui:Planner']];

function orchestratorCaptions(buffer, metadata) {
  const name = model + 'variantOf', fn = metadata.functions.get(name);
  const changed = () => new CliCompatibilityError('CLI 编排器原生标题表已变化');
  if (!fn || fn.size < 0x58 || metadata.ambiguousFunctions?.has(name)) throw changed();
  const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
  const page = word(0x4c), add = word(0x50);
  // Go slice header loads X8 (table) and X9 (count). Each record contains
  // the group label and the variant header as two 16-byte string headers.
  if (((page & 0x9f00001f) >>> 0) !== 0x9000001b ||
      ((add & 0xffc003ff) >>> 0) !== 0x9100037b || word(0x54) !== 0xa9402768) throw changed();
  const address = pageAddress(page, metadata.imageBase + fn.rva + 0x4c) + ((add >>> 10) & 4095);
  const slice = fileOffsetFor(metadata, address, 16);
  const count = Number(buffer.readBigUInt64LE(slice + 8)), size = count * 32;
  if (!count || !Number.isSafeInteger(size)) throw changed();
  const table = fileOffsetFor(metadata, Number(buffer.readBigUInt64LE(slice)), size);
  const matches = [];
  for (let i = 0; i < count; i++) {
    const row = table + i * 32;
    const captions = variantCaptions.map(([original, key], index) => {
      const slot = row + index * 16, pointer = Number(buffer.readBigUInt64LE(slot));
      const sourceLength = Number(buffer.readBigUInt64LE(slot + 8));
      if (sourceLength !== original.length) return null;
      const offset = fileOffsetFor(metadata, pointer, sourceLength);
      if (buffer.toString('utf8', offset, offset + sourceLength) !== original) return null;
      return {original, key, sourceLength, sourceRva:pointer - metadata.imageBase};
    });
    if (captions.every(Boolean)) matches.push(captions);
  }
  if (matches.length !== 1) throw changed();
  return matches[0];
}

/** Translate the built-in group and variant captions at their display consumers. */
export function collectCliModelVariantDisplayStrings(buffer, dictionary, metadata) {
  const sites = [], unsupported = [];
  for (const [method, callee, guards, callIndex, index, pointerRegister, lengthRegister, replayFirst] of [
    ['nameColumnWidth', style + 'Width', [0xaa0303e0, 0xaa0403e1, null, 0xf940d3e2], 2, 1, 0, 1, true],
    ['SelectorModel.renderRow', model + 'padRight',
      [0xaa0403e1, 0xaa0303e2, null, 0x912723fb, 0x91402f7b, 0xa9000760], 2, 1, 0, 1, false],
    ['SelectorModel.renderVariantChip', style + 'Style.Render',
      [0x911da3fb, 0x9140577b, 0xa9401363, 0x911da3fb, 0x9140137b, 0xa9001363, 0x910023e3, 0x91402fe4,
        0x911de084, 0xd2800158, 0xacc14490, 0xac814470, 0xacc14490, 0xac814470, 0xd1000718, 0xb5ffff78,
        0xf9400099, 0xf9000079, 0x914013e0, 0x911da000, 0xb24003e1, 0xaa0103e2], 22, 2, 3, 4, true],
  ]) {
    const name = model + method, fn = metadata.functions.get(name), consumer = metadata.functions.get(callee);
    const matches = [];
    if (fn && consumer && !metadata.ambiguousFunctions?.has(name) && !metadata.ambiguousFunctions?.has(callee)) {
      const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
      for (let start = 0; start + 4 * Math.max(callIndex + 1, guards.length) <= fn.size; start += 4) {
        if (!guards.every((expected, i) => expected === null || word(start + 4 * i) === expected)) continue;
        const call = start + 4 * callIndex, instruction = word(call);
        if (instruction >>> 26 !== 0x25 || fn.rva + call + (instruction << 6 >> 6) * 4 !== consumer.rva) continue;
        const offset = start + 4 * index, fileOffset = fn.fileOffset + offset, contextFileOffset = fn.fileOffset + start;
        matches.push({functionName:name, rva:fn.rva + offset, fileOffset, word:word(offset),
          pointerRegister, lengthRegister, replayFirst, contextFileOffset,
          originalContext:Buffer.from(buffer.subarray(contextFileOffset, fn.fileOffset + Math.max(call + 4, start + guards.length * 4)))});
      }
    }
    if (matches.length === 1) sites.push(matches[0]);
    else unsupported.push(method);
  }
  if (unsupported.length) return {imageBase:metadata.imageBase, entries:[], sites:[], unsupported};
  const strings = dictionary?.strings ?? dictionary, entries = [], missing = [];
  for (const {original, key, sourceLength, sourceRva} of orchestratorCaptions(buffer, metadata)) {
    const translated = strings[key];
    if (typeof translated === 'string' && translated) entries.push({original, translated, sourceLength, sourceRva});
    else missing.push({original, functionName:model + 'SelectorModel.View'});
  }
  // Built-in captions come from static Go data. A custom model with the same
  // name uses a separate address, even when its bytes are identical.
  return {imageBase:metadata.imageBase, entries, sites, missing, unsupported, requireAllSites:true};
}

// Only the joined capabilities are boxed for fmt.Sprintf(" (%s)"). Its result
// is subsequently joined to the model URI. Compare the separate Go string here
// so neither the model name nor runtime capability IDs enter the translation.
export function collectCliModelFeatureDisplayStrings(buffer, dictionary, metadata) {
  const name = backend + 'buildCustomModelDescription';
  const profile = relocateStatusLiteralGroup(buffer, metadata, {
    name, literals:[[0x34,0x3c,3,4,', '], [0x58,0x60,0,1,' (%s)']],
    verifiedCalls:[[0x40,'strings.Join'],[0x48,'runtime.convTstring'],[0x70,'fmt.Sprintf'],[0x88,'runtime.concatstring2']],
  });
  const fn = metadata.functions.get(name), offset = profile.verifiedCalls[0][0] + 4;
  const word = buffer.readUInt32LE(fn.fileOffset + offset);
  // Clear the boxed interface slot using SP and ZR only. The joined display
  // string in x0/x1 is still live; there are no other live caller-saved values.
  if (((word & 0xffc07fff) >>> 0) !== 0xa9007fff) {
    throw new CliCompatibilityError('CLI 模型能力说明显示入口已变化');
  }
  const strings = dictionary?.strings ?? dictionary;
  const entries = [], missing = [];
  for (const feature of ['images', 'toolCalls', 'thinking']) {
    const label = strings[`cli-model-feature:${feature}`];
    if (typeof label !== 'string' || !label) { missing.push({original:feature, functionName:name}); continue; }
    const combinations = entries.map(({original, translated}) => ({
      original:original + ', ' + feature, translated:translated + '、' + label,
    }));
    entries.push({original:feature, translated:label}, ...combinations);
  }
  const site = {functionName:name, rva:fn.rva + offset, fileOffset:fn.fileOffset + offset,
    word, pointerRegister:0, lengthRegister:1};
  return {imageBase:metadata.imageBase, entries:entries.map(entry => ({...entry, sourceLength:Buffer.byteLength(entry.original)})),
    matchContent:true, missing, sites:[site]};
}

/** Translate effort names only while measuring or drawing selector cells. */
export function collectCliModelEffortDisplayStrings(buffer, dictionary, metadata) {
  const render = metadata.functions.get(model + 'SelectorModel.renderEffortBar');
  const pad = metadata.functions.get(model + 'padCenter');
  const measureName = model + 'SelectorModel.effortCellWidth';
  const measured = relocateStatusLiteralGroup(buffer, metadata, {
    name:measureName, literals:[[0,8,0,1,'  Effort  ']],
    verifiedCalls:[[12,style + 'Width'],[44,model + 'gaugeCellWidth']],
  });
  if (!render || !pad || metadata.ambiguousFunctions?.has(render.name) || metadata.ambiguousFunctions?.has(pad.name)) {
    throw new CliCompatibilityError('CLI 模型思考档位显示函数未找到');
  }
  const sites = [];
  function site(fn, offset, pointerRegister, lengthRegister, start, end, replayFirst = false) {
    const fileOffset = fn.fileOffset + offset, contextFileOffset = fn.fileOffset + start;
    sites.push({functionName:fn.name, rva:fn.rva + offset, fileOffset,
      word:buffer.readUInt32LE(fileOffset), pointerRegister, lengthRegister, replayFirst,
      contextFileOffset, originalContext:Buffer.from(buffer.subarray(contextFileOffset, fn.fileOffset + end))});
  }

  // Both the selected and unselected rows center the same label (x0/x1).
  // x2 reloads the width; the spill supplying that width must agree at each call.
  let widthSource;
  for (let at = 8; at < render.size; at += 4) {
    const instruction = buffer.readUInt32LE(render.fileOffset + at);
    if (instruction >>> 26 !== 0x25 || render.rva + at + (instruction << 6 >> 6) * 4 !== pad.rva) continue;
    const frame = buffer.readUInt32LE(render.fileOffset + at - 8), load = buffer.readUInt32LE(render.fileOffset + at - 4);
    if (((frame & 0xffc003ff) >>> 0) !== 0x914003fb || ((load & 0xffc003ff) >>> 0) !== 0xf9400362 ||
        (widthSource && (widthSource.frame !== frame || widthSource.load !== load))) {
      throw new CliCompatibilityError('CLI 模型思考档位的宽度参数已变化');
    }
    widthSource = {frame, load};
    site(render, at - 4, 0, 1, at - 8, at + 4);
  }
  if (sites.length !== 2) throw new CliCompatibilityError('CLI 模型思考档位的选中行显示已变化');

  // This loop copies each model option's display string into a temporary
  // []string for gaugeCellWidth; it never writes back to the model options.
  const measure = metadata.functions.get(measureName), caption = measured.literals[0][0];
  const loop = [0xf9000106, 0x91008063, 0x910004a5, 0xeb0400bf, 0x540001aa,
    0xa9401c66, 0xeb0200bf, 0x540003c2, 0x8b051008, 0xf9000507];
  const start = caption - 0x58, barrier = metadata.functions.get('runtime.gcWriteBarrier2');
  const at = start + 0x38;
  const word = offset => buffer.readUInt32LE(measure.fileOffset + offset);
  const call = at >= 0 ? word(at) : 0;
  if (start < 0 || !loop.every((expected, i) => word(start + 4 * i) === expected) ||
      ((word(at - 16) & 0x9f00001f) >>> 0) !== 0x9000001b ||
      ((word(at - 12) & 0xffc003ff) >>> 0) !== 0xb9400367 ||
      word(at - 8) !== 0x34fffe87 || word(at - 4) !== 0xf9400107 ||
      !barrier || metadata.ambiguousFunctions?.has(barrier.name) || call >>> 26 !== 0x25 ||
      measure.rva + at + (call << 6 >> 6) * 4 !== barrier.rva ||
      word(at + 4) !== 0xa9001f26 || word(at + 8) !== 0x17fffff0) {
    throw new CliCompatibilityError('CLI 模型思考档位的测量列表已变化');
  }
  site(measure, start + 20, 6, 7, start, caption, true);

  const strings = dictionary?.strings ?? dictionary, entries = [], missing = [];
  for (const original of ['low','medium','high','xhigh','max']) {
    const translated = strings['cli-model-effort:' + original];
    if (typeof translated === 'string' && translated) entries.push({original, translated, sourceLength:Buffer.byteLength(original)});
    else missing.push({original, functionName:render.name});
  }
  return {imageBase:metadata.imageBase, entries, missing, sites, matchContent:true, requireAllSites:true};
}
