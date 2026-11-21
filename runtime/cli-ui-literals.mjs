import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';
import { inspectNativeBinary } from './backend-metadata.mjs';
import { pageAddress, stringLengthImmediate } from './cli-localization.mjs';

const modelPrefix = 'google3/third_party/jetski/cli/model/model.';
const keyboardHintView = 'google3/third_party/jetski/cli/layout/layout.Column.renderKeyboardHints';
const styleRender = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render';
const masked = (word, mask, expected) => ((word & mask) >>> 0) === (expected >>> 0);
// Commands, locations and checkbox marks retain their literal spelling.
const displayedVerbatim = /^(?:https?:\/\/\S+|\[x\]|\/[a-z][\w-]*|~\/(?:[\w.+-]+\/)*[\w.+-]+)$/;

// Go emits a stack address in one or two ADDs, depending on the frame size.
function stackAddress(word, offset, register) {
  const displacement = instruction => ((instruction >>> 10) & 4095) * ((instruction & 0x400000) ? 4096 : 1);
  const first = word(offset);
  if (!masked(first, 0xff8003ff, 0x910003e0 | register)) return null;
  const second = word(offset + 4);
  if (masked(second, 0xff8003ff, 0x91000000 | (register << 5) | register)) {
    return {value:displacement(first) + displacement(second), next:offset + 8};
  }
  return {value:displacement(first), next:offset + 4};
}

// Follow one literal into a one-element []string on the stack. The intervening
// copy passes the Lip Gloss style by value, then Style.Render receives that
// same []string. The original pointer and length registers have both been
// reused for the style copy before the call; only the display argument changes.
function displayedLiteral(buffer, fn, offset, metadata, rodata, render) {
  const word = relative => relative + 4 <= fn.size ? buffer.readUInt32LE(fn.fileOffset + relative) : 0;
  const page = word(offset), pointer = page & 31;
  if (pointer > 7 || !masked(page, 0x9f000000, 0x90000000)) return null;
  const add = word(offset + 4);
  if (!masked(add, 0xffc003ff, 0x91000000 | (pointer << 5) | pointer)) return null;
  const lengthWord = word(offset + 8), length = lengthWord & 31;
  if (length > 7 || length === pointer) return null;
  const sourceLength = stringLengthImmediate(lengthWord, length);
  if (!sourceLength) return null;
  const tuple = stackAddress(word, offset + 12, 27);
  if (!tuple || word(tuple.next) !== (0xa9000360 | (length << 10) | pointer) >>> 0) return null;

  const destination = stackAddress(word, tuple.next + 4, pointer);
  if (!destination || destination.value !== 8 || tuple.value < destination.value + 648) return null;
  const style = stackAddress(word, destination.next, length);
  if (!style || (tuple.value < style.value + 648 && style.value < tuple.value + 16)) return null;
  const copy = [
    0xd2800158, 0xacc14410 | (length << 5), 0xac814410 | (pointer << 5),
    0xacc14410 | (length << 5), 0xac814410 | (pointer << 5),
    0xd1000718, 0xb5ffff78, 0xf9400019 | (length << 5), 0xf9000019 | (pointer << 5),
  ];
  if (!copy.every((expected, index) => word(style.next + index * 4) === (expected >>> 0))) return null;

  const argument = stackAddress(word, style.next + copy.length * 4, 0);
  if (!argument || argument.value !== tuple.value || stringLengthImmediate(word(argument.next), 1) !== 1 ||
      word(argument.next + 4) !== 0xaa0103e2) return null;
  const callOffset = argument.next + 8, call = word(callOffset);
  if (call >>> 26 !== 0x25 || fn.rva + callOffset + (call << 6 >> 6) * 4 !== render.rva) return null;

  const pointerPc = metadata.imageBase + fn.rva + offset;
  const address = pageAddress(page, pointerPc) + ((add >>> 10) & 4095);
  if (address < rodata.address || address + sourceLength > rodata.address + rodata.size) return null;
  const fileOffset = rodata.fileOffset + address - rodata.address, pointerFileOffset = fn.fileOffset + offset;
  return {kind:'literal', functionName:fn.name, pointerPc, pointerRegister:pointer, lengthRegister:length,
    original:buffer.toString('utf8', fileOffset, fileOffset + sourceLength), sourceLength,
    pointerFileOffset, lengthFileOffset:pointerFileOffset + 8, contextFileOffset:pointerFileOffset,
    originalContext:Buffer.from(buffer.subarray(pointerFileOffset, fn.fileOffset + callOffset + 4))};
}

/** Collect existing Go UI literals without depending on the reach of a shared style hook. */
export function collectCliUiLiterals(buffer, dictionary, metadata = inspectNativeBinary(buffer), claimedPatches = []) {
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const render = metadata.functions.get(styleRender);
  const rodata = metadata.segments.find(segment => segment.name === '__TEXT')?.sections.find(section => section.name === '__rodata');
  const patches = [], missing = [];
  if (render && !metadata.ambiguousFunctions?.has(styleRender) && rodata) {
    const claimed = new Set(claimedPatches.map(patch => patch.pointerFileOffset));
    for (const fn of metadata.functions.values()) {
      if ((!fn.name.startsWith(modelPrefix) && fn.name !== keyboardHintView) ||
          metadata.ambiguousFunctions?.has(fn.name)) continue;
      for (let offset = 0; offset + 16 <= fn.size; offset += 4) {
        if (claimed.has(fn.fileOffset + offset)) continue;
        const patch = displayedLiteral(buffer, fn, offset, metadata, rodata, render);
        if (!patch || !/[a-zA-Z]/.test(patch.original) || displayedVerbatim.test(patch.original.trim())) continue;
        const translated = strings[`cli-ui:${patch.original}`] ?? strings[patch.original];
        if (typeof translated === 'string' && translated) {
          if (translated !== patch.original) patches.push({...patch, translated});
        } else {
          missing.push({original:patch.original, functionName:fn.name});
        }
      }
    }
  }
  const unsupported = [];
  collectInlineDisplayCopies(buffer, strings, metadata, rodata, patches, missing, unsupported);
  return {imageBase:metadata.imageBase, patches, missing, unsupported};
}

// The native helper capitalizes the first byte of the English reason and adds
// punctuation. Translate its completed string on return, after both operations.
export function collectCliUnavailableMessageStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const name = 'google3/third_party/jetski/cli/commands/commands.unsupportedMessage';
  const plan = {imageBase:metadata.imageBase, entries:[], sites:[], matchContent:true};
  const fn = metadata.functions.get(name);
  if (!fn && !metadata.ambiguousFunctions?.has(name)) return plan; // Introduced in agy 1.5.11.
  const upper = metadata.functions.get('strings.ToUpper'), concat = metadata.functions.get('runtime.concatstring3');
  if (!fn || !upper || !concat || [name,upper.name,concat.name].some(key => metadata.ambiguousFunctions?.has(key))) {
    throw new CliCompatibilityError('CLI 命令不可用提示入口已变化');
  }
  const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
  let sawUpper = false;
  for (let offset = 0; offset + 16 <= fn.size; offset += 4) {
    const call = word(offset);
    if (call >>> 26 !== 0x25) continue;
    const target = fn.rva + offset + (call << 6 >> 6) * 4;
    if (target === upper.rva) sawUpper = true;
    if (!sawUpper || target !== concat.rva || word(offset + 4) !== 0xf85f83fd ||
        !masked(word(offset + 8),0xffe00fff,0xf84007fe) || word(offset + 12) !== 0xd65f03c0) continue;
    const fileOffset = fn.fileOffset + offset;
    plan.sites.push({functionName:name, rva:fn.rva + offset + 4, fileOffset:fileOffset + 4,
      word:word(offset + 4), pointerRegister:0, lengthRegister:1, contextFileOffset:fileOffset,
      originalContext:Buffer.from(buffer.subarray(fileOffset,fileOffset + 16))});
  }
  if (plan.sites.length !== 1) throw new CliCompatibilityError('CLI 命令不可用提示返回位置已变化');
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const prefix = 'cli-unavailable:';
  for (const [key,translated] of Object.entries(strings)) {
    if (!key.startsWith(prefix) || typeof translated !== 'string' || !translated) continue;
    const original = key.slice(prefix.length);
    if (original && original !== translated) plan.entries.push({original,translated,sourceLength:Buffer.byteLength(original)});
  }
  return plan;
}

const feedbackView = modelPrefix + 'FeedbackModel.View';
export const feedbackLiteralProfiles = [
  '\n\nYour feedback helps improve %s. The following sanitized data will be sent:\n\n',
  'Trajectory ID: %s\n', '%s Submit Feedback', '%s Back',
].map(text => ({name:feedbackView, optional:true, resolve:relocateStatusLiteralGroup,
  literals:[[0,8,0,1,text,28]]}));

// Some fixed-length Builder.WriteString calls are lowered to two overlapping
// vector copies. Both chunks must come from the same translated resource.
function collectInlineDisplayCopies(buffer, strings, metadata, rodata, patches, missing, unsupported) {
  if (!rodata) return;
  for (const [name,original,tail,firstLoad,secondLoad,stores] of [
    [feedbackView,'\n\nWhat went wrong? Select a category to assist your report:\n\n',29,0xad400760,0xad400f62,[0xad0004a0,0x910074bb,0xad000f62]],
    [feedbackView,'\n\nMind telling us more?\n\n',9,0x3dc00360,0x3dc00361,[0x3d8000a0,0x3c8090a1]],
    [modelPrefix+'UsageModel.renderPlanSection', "  Gemini Code Assist's agent mode with Google AI Pro.\n",22,0xad400760,0xad400f62,[0xad0004c0,0x910058db,0xad000f62]],
  ]) {
    const fn = metadata.functions.get(name);
    if (!fn || metadata.ambiguousFunctions?.has(name)) continue;
    const word = at => buffer.readUInt32LE(fn.fileOffset + at);
    function literalAddress(at) {
      if (!masked(word(at),0x9f00001f,0x9000001b) || !masked(word(at+4),0xffc003ff,0x9100037b)) return null;
      return pageAddress(word(at),metadata.imageBase + fn.rva + at) + ((word(at+4) >>> 10) & 4095);
    }
    const bytes = Buffer.from(original), end = 24 + stores.length * 4;
    const hits = [];
    for (let at = 0; at + end <= fn.size; at += 4) {
      if (word(at+8) !== firstLoad || word(at+20) !== secondLoad ||
          !stores.every((value,index) => word(at+24+index*4) === value)) continue;
      const first = literalAddress(at);
      if (first === null || literalAddress(at+12) !== first + tail ||
          first < rodata.address || first + bytes.length > rodata.address + rodata.size) continue;
      const raw = rodata.fileOffset + first - rodata.address;
      if (buffer.subarray(raw,raw + bytes.length).equals(bytes)) hits.push(at);
    }
    if (hits.length !== 1) { unsupported.push(original.trim()); continue; }
    const text = strings['cli-ui:' + original];
    if (!text) { missing.push({original,functionName:fn.name}); continue; }
    if (text === original) continue;
    if (typeof text !== 'string' || Buffer.byteLength(text) !== bytes.length) {
      unsupported.push(original.trim()); continue;
    }
    const at = hits[0], fileOffset = fn.fileOffset + at;
    patches.push({kind:'inline-string-copy', original, translated:text, sourceLength:bytes.length,
      functionName:fn.name, contextFileOffset:fileOffset, originalContext:Buffer.from(buffer.subarray(fileOffset,fileOffset + end)),
      sources:[[0,0],[12,tail]].map(([offset,resourceOffset])=>({pointerFileOffset:fileOffset+offset,
        pointerPc:metadata.imageBase+fn.rva+at+offset,pointerRegister:27,resourceOffset}))});
  }
}

// Category labels also identify the report being submitted. Translate only the
// category copied for a numbered row and the selected category in its preview.
export function collectCliFeedbackDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const fn = metadata.functions.get(feedbackView);
  const located = profile => relocateStatusLiteralGroup(buffer,metadata,{name:feedbackView,...profile}).literals[0][0];
  const numbered = located({literals:[[0,8,0,1,'%d. ',28]]});
  const review = located({literals:[[0,8,3,4,'Feedback: ']],verifiedCalls:[[0x58,styleRender],[0xe8,styleRender]]});
  const sites = [];
  function add(at,word,pointerRegister,lengthRegister,start,end) {
    const contextFileOffset = fn.fileOffset + start;
    sites.push({functionName:fn.name,rva:fn.rva+at,fileOffset:fn.fileOffset+at,word,pointerRegister,lengthRegister,
      replayFirst:true,contextFileOffset,originalContext:Buffer.from(buffer.subarray(contextFileOffset,fn.fileOffset + end))});
  }
  const word = at => buffer.readUInt32LE(fn.fileOffset+at);
  const row = numbered - 0x44, choice = review + 0x98;
  if (row < 0 || word(row) !== 0xa94008a1 ||
      !masked(word(row+4),0xffc003ff,0x914003fb) || !masked(word(row+8),0xffc003ff,0xf9000362) ||
      !masked(word(row+12),0xffc003ff,0x914003fb) || !masked(word(row+16),0xffc003ff,0xf9000361) ||
      word(row+28) !== 0xa9007f7f || word(row+32) !== 0x91000400 ||
      word(choice-4) !== 0x8b051063 || word(choice) !== 0xa9401063 ||
      word(choice+12) !== 0xa9001363) {
    throw new CliCompatibilityError('CLI 反馈分类列表与预览显示入口已变化');
  }
  add(row,word(row),1,2,row,numbered+32);
  add(choice,word(choice),3,4,review+0x58,review+0xec);
  const prefix = 'cli-feedback:', strings = dictionary?.strings ?? dictionary;
  const entries = Object.entries(strings).filter(([key,value]) => key.startsWith(prefix) && typeof value === 'string' && value)
    .map(([key,translated]) => ({original:key.slice(prefix.length),translated,sourceLength:Buffer.byteLength(key.slice(prefix.length))}));
  return {imageBase:metadata.imageBase,entries,sites,matchContent:true};
}
