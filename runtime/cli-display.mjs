import { inspectNativeBinary } from './backend-metadata.mjs';

const renderName = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render';
const ansiPrefix = 'google3/third_party/golang/github_com/charmbracelet/x/ansi/v/v0/ansi.';
const wrapName = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Wrap';
// Copying a Lip Gloss style uses Q16/Q17 and X24/X25. Integer X9..X17 are
// unused from the hint's Action load through the following Style.Render call.
const hintStyleCopy = [0xd2800158, 0xacc14490, 0xac814470, 0xacc14490, 0xac814470,
  0xd1000718, 0xb5ffff78, 0xf9400099, 0xf9000079];
const signed = (value, bits) => value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
const branchTarget = (word, pc) => ((word & 0xfc000000) >>> 0) === 0x94000000
  ? pc + signed(word & 0x3ffffff, 26) * 4 : null;

/** Translate literal display strings after Join and before Lip Gloss measures them. */
export function collectCliDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const fn = metadata.functions.get(renderName), join = metadata.functions.get('strings.Join');
  if (!fn || !join || metadata.ambiguousFunctions?.has(renderName) || metadata.ambiguousFunctions?.has('strings.Join')) {
    throw new Error('CLI 通用显示入口未找到');
  }
  const calls = [];
  for (let offset = 0; offset < Math.min(fn.size, 512); offset += 4) {
    const pc = fn.rva + offset;
    if (branchTarget(buffer.readUInt32LE(fn.fileOffset + offset), pc) === join.rva) calls.push(offset);
  }
  // IDA in 1.5.9: X0/X1 is strings.Join's result. The next instruction opens
  // the style result slot, and all width/height processing occurs afterwards.
  if (calls.length !== 1) throw new Error('CLI 显示字符串合并入口已变化');
  const offset = calls[0] + 4, word = buffer.readUInt32LE(fn.fileOffset + offset);
  if (((word & 0xffc003ff) >>> 0) !== 0x910003fb ||
      buffer.readUInt32LE(fn.fileOffset + offset + 4) !== 0xa9007f7f ||
      ((buffer.readUInt32LE(fn.fileOffset + offset + 8) & 0xffc003ff) >>> 0) !== 0xf90003ff) {
    throw new Error('CLI 显示字符串返回布局已变化');
  }
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const sources = new Map();
  const dictionaryEntries = Object.entries(strings);
  const candidates = [...dictionaryEntries.filter(([key]) => !key.startsWith('cli-ui:')),
    ...dictionaryEntries.filter(([key]) => key.startsWith('cli-ui:'))];
  for (let [original, translated] of candidates) {
    const contextual = original.startsWith('cli-ui:');
    if (contextual) original = original.slice(7);
    else if (/^[a-z][\w.-]*:/.test(original)) continue;
    if (typeof translated !== 'string' || !translated || original === translated ||
        original.length < 2 || !/[A-Za-z]/.test(original)) continue;
    const previous = sources.get(original);
    if (previous && previous !== translated && !contextual) throw new Error(`CLI 显示译文冲突：${original}`);
    sources.set(original, translated);
  }
  const entries = collectCliLiteralEntries(buffer, metadata, sources);
  const site = {rva:fn.rva + offset, fileOffset:fn.fileOffset + offset, word, pointerRegister:0, lengthRegister:1};
  const sites = [site];
  // IDA: ANSI's scalar Method is X0, the source string is X1/X2, and width /
  // breakpoints occupy X3..X5. Lip Gloss Wrap takes the source in X0/X1.
  // Translate before these helpers allocate a wrapped/truncated string.
  for (const [name, pointerRegister, lengthRegister] of [
    ...['truncate', 'hardwrap', 'wordwrap', 'wrap'].map(suffix => [ansiPrefix + suffix, 1, 2]),
    [wrapName, 0, 1],
  ]) {
    const helper = metadata.functions.get(name);
    if (!helper || metadata.ambiguousFunctions?.has(name)) throw new Error('CLI 文案排版入口未找到');
    const first = buffer.readUInt32LE(helper.fileOffset), adjust = buffer.readUInt32LE(helper.fileOffset + 4);
    const compare = buffer.readUInt32LE(helper.fileOffset + 8), conditional = buffer.readUInt32LE(helper.fileOffset + 12);
    if (first !== 0xf9400b90 || ((adjust & 0xffc003ff) >>> 0) !== 0xd10003f1 ||
        compare !== 0xeb10023f || ((conditional & 0xff00001f) >>> 0) !== 0x54000009) {
      throw new Error('CLI 文案排版参数布局已变化');
    }
    sites.push({rva:helper.rva, fileOffset:helper.fileOffset, word:first, pointerRegister, lengthRegister});
  }
  // KeyHint.Action is display text. NewKeyHint also receives keybinding IDs,
  // so translate only when the two renderers load Action from the hint value.
  for (const [suffix, offset, pointerRegister, lengthRegister, expected] of [
    ['NavHints', 0x1f4, 3, 6, [0xa9411863, 0xf9029fe6, 0xf90537e3, 0x8b011003,
      0xf90533e3, 0x912aa3fb, 0xa9001764, 0x910023e3, 0x911523e4,
      ...hintStyleCopy, 0x912aa3e0, 0xb24003e1, 0xaa0103e2]],
    ['NavHintsWrap', 0x2b4, 5, 6, [0xa9411845, 0xf902d3e6, 0xf90437e5,
      0x912d63fb, 0xa9001363, 0x910023e3, 0x911723e4,
      ...hintStyleCopy, 0x912d63e0, 0xb24003e1, 0xaa0103e2]],
  ]) {
    const name = `google3/third_party/jetski/cli/render/render.${suffix}`, helper = metadata.functions.get(name);
    if (!helper || metadata.ambiguousFunctions?.has(name) || offset + (expected.length + 1) * 4 > helper.size ||
        expected.some((word, index) => buffer.readUInt32LE(helper.fileOffset + offset + index * 4) !== word) ||
        branchTarget(buffer.readUInt32LE(helper.fileOffset + offset + expected.length * 4),
          helper.rva + offset + expected.length * 4) !== fn.rva) {
      throw new Error('CLI 快捷键提示显示布局已变化');
    }
    sites.push({rva:helper.rva + offset, fileOffset:helper.fileOffset + offset, word:expected[0],
      pointerRegister, lengthRegister, replayFirst:true});
  }
  const truncate = metadata.functions.get('google3/third_party/jetski/cli/model/model.truncateToWidth');
  if (!truncate || buffer.readUInt32LE(truncate.fileOffset) !== 0xf9400b90 ||
      buffer.readUInt32LE(truncate.fileOffset + 4) !== 0xeb3063ff ||
      ((buffer.readUInt32LE(truncate.fileOffset + 8) & 0xff00001f) >>> 0) !== 0x54000009) {
    throw new Error('CLI 输入提示排版入口已变化');
  }
  sites.push({rva:truncate.rva, fileOffset:truncate.fileOffset, word:0xf9400b90, pointerRegister:0, lengthRegister:1});

  const shortcuts = metadata.functions.get('google3/third_party/jetski/cli/model/model.HelpModel.renderShortcutsTab');
  const stringRunes = metadata.functions.get('runtime.stringtoslicerune');
  const description = [0xf9024fe9, 0xf9021be1, 0xf90223e7, 0xf90217e4, 0x390cbfe0, 0x8b0714c3,
    0xa9401464, 0xf90237e5, 0xf9025be4, 0xa9410861, 0xf90233e2, 0xf9028fe1, 0x910cc3e0];
  if (!shortcuts || !stringRunes || description.some((word, index) =>
    buffer.readUInt32LE(shortcuts.fileOffset + 0x328 + index * 4) !== word) ||
    branchTarget(buffer.readUInt32LE(shortcuts.fileOffset + 0x35c), shortcuts.rva + 0x35c) !== stringRunes.rva) {
    throw new Error('CLI 快捷键说明显示入口已变化');
  }
  sites.push({rva:shortcuts.rva + 0x34c, fileOffset:shortcuts.fileOffset + 0x34c,
    word:0xa9410861, pointerRegister:1, lengthRegister:2, replayFirst:true});

  // GetTip selects both ordinary and conditional tips before this common
  // string load. Translate the chosen literal before adding the Tip prefix;
  // its feature flags and the source Tip structure remain unchanged.
  const tipName = 'google3/third_party/jetski/cli/store/store.(*Manager).GetTip';
  const tip = metadata.functions.get(tipName), concat = metadata.functions.get('runtime.concatstring2');
  if (!tip || !concat || metadata.ambiguousFunctions?.has(tipName) ||
      metadata.ambiguousFunctions?.has('runtime.concatstring2') || tip.size !== 1376 ||
      buffer.readUInt32LE(tip.fileOffset + 0x334) !== 0xf86578c3 ||
      buffer.readUInt32LE(tip.fileOffset + 0x338) !== 0xf94004e4 ||
      buffer.readUInt32LE(tip.fileOffset + 0x33c) !== 0xaa1f03e0 ||
      buffer.readUInt32LE(tip.fileOffset + 0x348) !== 0xd2800122 ||
      branchTarget(buffer.readUInt32LE(tip.fileOffset + 0x34c), tip.rva + 0x34c) !== concat.rva) {
    throw new Error('CLI 条件提示共同显示入口已变化');
  }
  sites.push({rva:tip.rva + 0x338, fileOffset:tip.fileOffset + 0x338,
    word:0xf94004e4, pointerRegister:3, lengthRegister:4, replayFirst:true});

  const boxString = metadata.functions.get('runtime.convTstring');
  // Timer/cron status is a separate system string. Prompt is already boxed
  // into the first fmt argument; translate only the second status argument.
  const scheduleName = 'google3/third_party/oneharness/internal/tools/tools.scheduleRenderInfo';
  const schedule = metadata.functions.get(scheduleName);
  if (!schedule || !boxString || metadata.ambiguousFunctions?.has(scheduleName) ||
      metadata.ambiguousFunctions?.has('runtime.convTstring') || schedule.size !== 1024 ||
      buffer.readUInt32LE(schedule.fileOffset + 0x34) !== 0xa914afea ||
      buffer.readUInt32LE(schedule.fileOffset + 0x180) !== 0xa95387e0 ||
      branchTarget(buffer.readUInt32LE(schedule.fileOffset + 0x184),schedule.rva + 0x184) !== boxString.rva ||
      buffer.readUInt32LE(schedule.fileOffset + 0x190) !== 0xa90c83e2 ||
      buffer.readUInt32LE(schedule.fileOffset + 0x194) !== 0xa95487e0 ||
      branchTarget(buffer.readUInt32LE(schedule.fileOffset + 0x198),schedule.rva + 0x198) !== boxString.rva) {
    throw new Error('CLI 定时任务状态显示参数已变化');
  }
  sites.push({rva:schedule.rva + 0x194, fileOffset:schedule.fileOffset + 0x194,
    word:0xa95487e0, pointerRegister:0, lengthRegister:1, replayFirst:true});
  return { imageBase:metadata.imageBase, entries, site, sites };
}

// These are the built-in options in agy 1.5.9, rather than arbitrary setting
// strings. Saved JSON values may have different addresses from their literals.
const settingDisplayValues = [
  'terminal', 'light', 'solarized light', 'colorblind-friendly light', 'dark',
  'solarized dark', 'colorblind-friendly dark', 'tokyo night',
  'full screen (altscreen)', 'native terminal (inline)',
  'fast', 'medium', 'slow', 'off', 'on', 'default', 'vim',
  'always proceeds', 'agent decides', 'asks for review',
  'request-review', 'proceed-in-sandbox', 'always-proceed', 'strict',
  'grouped', 'none', 'low', 'high', 'auto', 'accept-edits', 'plan',
  'Queue', 'Send Immediately', 'dictation',
  'auto ($EDITOR)', 'other...',
];
const dynamicSettingHints = [
  'full screen (altscreen) is ideal for long conversations but requires holding Shift/Option for native text selection. Native Terminal experience (inline) preserves native terminal behavior but may truncate long conversations and flicker when toggling views.',
  "'default': standard behavior. 'accept-edits': auto-approve file edits, prompt for commands. 'auto': auto-approve edits and safe commands, prompt on irreversible actions. 'plan': research and plan without making changes",
  'Agent always asks for confirmation before executing terminal commands (except those in the Allow list).',
  'Terminal command automatically proceeds if the command runs inside the sandbox. Otherwise, it requests review.',
  'Agent never asks for confirmation before executing terminal commands (except those in the Deny list). This provides the Agent with the maximum ability to operate over long periods without intervention, but also has the highest risk of an Agent executing an unsafe terminal command.',
  'Agent prompts for all non-read tools.',
];

/** Translate recognized options and system hints, keeping IDs and custom text. */
export function collectCliSettingsDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const name = 'google3/third_party/jetski/cli/model/model.SettingsModel.renderFieldLines';
  const fn = metadata.functions.get(name);
  const hintName = 'google3/third_party/jetski/cli/model/model.SettingsModel.wrapHint';
  const hint = metadata.functions.get(hintName);
  // IDA: 0x7e4 compares current value with option.Value. Only its equal branch
  // reaches 0x810, which chooses option.Label or option.Value for this row.
  // Unmatched/custom values skip to 0x834 and never enter this display hook.
  const words = [0x912b83fb,0x9140537b,0xa9400b61,0x912b43fb,0x9140537b,
    0xa9401b65,0xf100005f,0x9a861044,0x9a851023];
  if (!fn || fn.size !== 5056 || metadata.ambiguousFunctions?.has(name) ||
      words.some((word,index) => buffer.readUInt32LE(fn.fileOffset + 0x810 + index * 4) !== word)) {
    throw new Error('CLI 设置枚举显示入口已变化');
  }
  // This helper receives the selected field's system hint in X0/X1 before
  // saving it or calling any formatting helper. No user input flows here.
  const hintWords = [0xf9400b90,0xd12783f1,0xeb10023f,0x54000e09];
  if (!hint || hint.size !== 496 || metadata.ambiguousFunctions?.has(hintName) ||
      hintWords.some((word,index) => buffer.readUInt32LE(hint.fileOffset + index * 4) !== word)) {
    throw new Error('CLI 设置动态提示显示入口已变化');
  }
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const entries = [], missing = [];
  for (const original of [...settingDisplayValues,...dynamicSettingHints]) {
    const translated = strings[`cli-ui:${original}`] ?? strings[original];
    if (typeof translated !== 'string' || !translated) { missing.push({functionName:name,original}); continue; }
    if (translated !== original) entries.push({original,translated,sourceLength:Buffer.byteLength(original)});
  }
  const site = {rva:fn.rva + 0x830,fileOffset:fn.fileOffset + 0x830,word:words.at(-1),
    pointerRegister:3,lengthRegister:4,replayFirst:true,
    contextFileOffset:fn.fileOffset + 0x810,
    originalContext:Buffer.from(buffer.subarray(fn.fileOffset + 0x810,fn.fileOffset + 0x834))};
  const hintSite = {rva:hint.rva,fileOffset:hint.fileOffset,word:hintWords[0],
    pointerRegister:0,lengthRegister:1,
    contextFileOffset:hint.fileOffset,
    originalContext:Buffer.from(buffer.subarray(hint.fileOffset,hint.fileOffset + hintWords.length * 4))};
  return {imageBase:metadata.imageBase,entries,sites:[site,hintSite],missing,matchContent:true};
}

/** Reuse literal matching for distinct display roles without sharing their vocabulary. */
export function collectCliLiteralEntries(buffer, metadata, sources) {
  const rodata = metadata.segments.filter(segment => segment.name === '__TEXT')
    .flatMap(segment => segment.sections.filter(section => section.name === '__rodata'));
  if (rodata.length !== 1) throw new Error('CLI 固定显示文案区未找到');
  const section = rodata[0], literal = buffer.subarray(section.fileOffset, section.fileOffset + section.size);
  const unique = new Map();
  for (const [original, translated] of sources) {
    const source = Buffer.from(original), sourceLength = source.length;
    if (!sourceLength) continue;
    for (let start = 0; ;) {
      const found = literal.indexOf(source, start);
      if (found < 0) break;
      const sourceRva = section.address - metadata.imageBase + found;
      if (sourceRva > 0xffffffff || sourceLength > 0xffffffff) throw new Error('CLI 固定显示文案地址超出范围');
      const key = `${sourceLength}:${sourceRva}`, previous = unique.get(key);
      if (previous && previous.translated !== translated) throw new Error(`CLI 显示译文冲突：${original}`);
      unique.set(key, { original, translated, sourceRva, sourceLength });
      start = found + 1;
    }
  }
  return [...unique.values()].sort((left, right) => left.sourceLength - right.sourceLength || left.sourceRva - right.sourceRva);
}

function jump(from, to, bits = 26) {
  const delta = (to - from) / 4;
  if (!Number.isSafeInteger(delta) || delta < -(2 ** (bits - 1)) || delta >= 2 ** (bits - 1)) {
    throw new Error('CLI 显示跳转地址超出范围');
  }
  return delta & (2 ** bits - 1);
}

/** A table lookup changes only the display value and keeps the caller's string. */
export function applyCliDisplayStrings(buffer, plan, { codeAddress, codeFileOffset, capacity, tableAddress, allocateString }) {
  const sites = plan.sites ?? [plan.site];
  for (const site of sites) if (buffer.readUInt32LE(site.fileOffset) !== site.word) throw new Error('CLI 显示入口已变化');
  const table = Buffer.alloc(plan.entries.length * 16);
  for (const [index, entry] of plan.entries.entries()) {
    const utf8 = Buffer.from(entry.translated), address = allocateString(utf8), targetRva = address - plan.imageBase;
    if (!Number.isSafeInteger(targetRva) || targetRva < 0 || targetRva > 0xffffffff || utf8.length > 0xffffffff) {
      throw new Error('CLI 中文显示文案地址超出范围');
    }
    table.writeUInt32LE(entry.sourceRva, index * 16);
    table.writeUInt32LE(entry.sourceLength, index * 16 + 4);
    table.writeUInt32LE(targetRva, index * 16 + 8);
    table.writeUInt32LE(utf8.length, index * 16 + 12);
  }
  const thunks = [];
  let codeSize = 0;
  for (const site of sites) {
    const words = displayLookup(plan, site, codeAddress + codeSize, tableAddress);
    thunks.push({site, offset:codeSize, words});
    codeSize += words.length * 4;
  }
  if (codeSize > capacity || codeFileOffset < 0 || codeFileOffset + codeSize > buffer.length) throw new Error('CLI 显示代码空间不足');
  const redirects = thunks.map(({site, offset}) => ({site,
    word:0x14000000 | jump(plan.imageBase + site.rva, codeAddress + offset)}));
  for (const thunk of thunks) thunk.words.forEach((word, index) => buffer.writeUInt32LE(word, codeFileOffset + thunk.offset + index * 4));
  for (const {site, word} of redirects) buffer.writeUInt32LE(word >>> 0, site.fileOffset);
  return { table, codeSize, translated:plan.entries.length };
}

/** Known UI text can be matched independently of its literal/heap address. */
export function applyCliContentDisplayStrings(buffer, plan, options) {
  for (const site of plan.sites) {
    if (site.originalContext && !buffer.subarray(site.contextFileOffset,
      site.contextFileOffset + site.originalContext.length).equals(site.originalContext)) {
      throw new Error('CLI 内容显示入口已变化');
    }
  }
  const entries = plan.entries.map(entry => {
    const sourceRva = options.allocateString(Buffer.from(entry.original, 'utf8')) - plan.imageBase;
    if (!Number.isSafeInteger(sourceRva) || sourceRva < 0 || sourceRva > 0xffffffff) {
      throw new Error('CLI 显示原文地址超出范围');
    }
    return {...entry,sourceRva};
  });
  return applyCliDisplayStrings(buffer,{...plan,entries,matchContent:true},options);
}

function displayLookup(plan, site, codeAddress, tableAddress) {
  const words = [], labels = new Map(), fixups = [];
  const put = word => words.push(word >>> 0);
  const label = name => labels.set(name, words.length * 4);
  const branch = (name, word, bits = 19) => { fixups.push({offset:words.length * 4, name, word, bits}); put(word); };
  const address = (register, target) => {
    const pc = codeAddress + words.length * 4;
    const delta = Math.floor(target / 4096) - Math.floor(pc / 4096);
    if (!Number.isSafeInteger(delta) || delta < -0x100000 || delta > 0xfffff) throw new Error('CLI 显示查表地址超出范围');
    const immediate = delta & 0x1fffff;
    put(0x90000000 | ((immediate & 3) << 29) | ((immediate >>> 2) << 5) | register);
    put(0x91000000 | ((target % 4096) << 10) | (register << 5) | register);
  };
  const constant = (register, value) => {
    put(0xd2800000 | ((value & 0xffff) << 5) | register);
    if (value > 0xffff) put(0xf2a00000 | (((value >>> 16) & 0xffff) << 5) | register);
  };
  const pointer = site.pointerRegister ?? 0, length = site.lengthRegister ?? 1;
  // Formatting entry points use at most X0..X5 for arguments. The hint
  // renderers have already spilled their loop state before loading Action.
  // X9..X17 are scratch; only the selected display pointer/length changes.
  if (site.replayFirst) put(site.word);
  address(9, plan.imageBase);
  if (plan.matchContent) {
    // Dedicated UI collectors opt into byte matching; the shared display
    // hooks keep the literal-address contract for arbitrary rendered text.
    address(11, tableAddress); constant(12, plan.entries.length);
    label('row');
    branch('done', 0xb400000c); // cbz x12,done
    put(0x2940396d); // ldp w13,w14,[x11] (English RVA, length)
    put(0xca0001ce | (length << 16)); // eor x14,x14,length
    branch('next', 0xb500000e); // cbnz x14,next
    put(0x8b0d012d); // add x13,x9,x13
    put(0xaa0003ee | (pointer << 16)); // mov x14,source
    put(0xaa0003ef | (length << 16)); // mov x15,length
    branch('matched', 0xb400000f); // cbz x15,matched
    label('bytes');
    put(0x384015b0); // ldrb w16,[x13],#1
    put(0x384015d1); // ldrb w17,[x14],#1
    put(0x4a110210); // eor w16,w16,w17
    branch('next', 0x35000010); // cbnz w16,next
    put(0xd10005ef); // sub x15,x15,#1
    branch('bytes', 0xb500000f); // cbnz x15,bytes
    label('matched');
    put(0x29410160 | (length << 10) | pointer); // ldp pointer,length,[x11,#8]
    put(0x8b000120 | (pointer << 16) | pointer);
    branch('done', 0x14000000, 26);
    label('next');
    put(0x9100416b); // add x11,x11,#16
    put(0xd100058c); // sub x12,x12,#1
    branch('row', 0x14000000, 26);
  } else {
  put(0xcb09000a | (pointer << 5)); // sub x10,source,x9 (literal RVA)
  put(0xd360fd51); // lsr x17,x10,#32
  branch('done', 0xb5000011); // cbnz x17,done
  put(0xaa00814a | (length << 16)); // orr x10,x10,length,lsl#32 (length:RVA)
  address(11, tableAddress);
  constant(12, 0); constant(13, plan.entries.length);
  label('search');
  put(0xeb0d019f); // cmp x12,x13
  branch('done', 0x54000002); // b.hs done
  put(0x8b0d018e); // add x14,x12,x13
  put(0xd341fdce); // lsr x14,x14,#1
  put(0x8b0e1170); // add x16,x11,x14,lsl#4
  put(0xf9400211); // ldr x17,[x16]
  put(0xeb11015f); // cmp x10,x17
  branch('lower', 0x54000003); // b.lo lower
  branch('higher', 0x54000008); // b.hi higher
  put(0x29410200 | (length << 10) | pointer); // ldp pointer,length,[x16,#8]
  put(0x8b000120 | (pointer << 16) | pointer); // add source,x9,source
  branch('done', 0x14000000, 26);
  label('lower'); put(0xaa0e03ed); // mov x13,x14
  branch('search', 0x14000000, 26);
  label('higher'); put(0x910005cc); // add x12,x14,#1
  branch('search', 0x14000000, 26);
  }
  label('done'); if (!site.replayFirst) put(site.word);
  put(0x14000000 | jump(codeAddress + words.length * 4, plan.imageBase + site.rva + 4));
  for (const fix of fixups) {
    const target = labels.get(fix.name), displacement = jump(fix.offset, target, fix.bits);
    words[fix.offset / 4] = (fix.word | (fix.bits === 26 ? displacement : displacement << 5)) >>> 0;
  }
  return words;
}
