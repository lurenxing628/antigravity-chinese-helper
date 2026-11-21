import { CliCompatibilityError } from './cli-compatibility.mjs';
import { addressInstructions } from './native-strings.mjs';
import { inspectNativeBinary } from './backend-metadata.mjs';
import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

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

// A translated control can have several render paths. Resolve each within its
// owning UI function and retain the other paths when one no longer matches.
function uniqueFunction(metadata, name) {
  if (metadata.ambiguousFunctions?.has(name)) return null;
  return metadata.functions.get(name) ?? null;
}

// Locate the prefix passed to the final concatenation within GetTip.
export const cliTipProfile = {
  name:'google3/third_party/jetski/cli/store/store.(*Manager).GetTip',
  resolve:relocateStatusLiteralGroup,
  literals:[[0,8,1,2,'└ Tip: ']],
  verifiedCalls:[[12,'runtime.concatstring2']],
};

function findTipBodySite(buffer, metadata) {
  let profile;
  try { profile = cliTipProfile.resolve(buffer, metadata, cliTipProfile); }
  catch (error) {
    if (error instanceof CliCompatibilityError) return null;
    throw error;
  }
  const tip = uniqueFunction(metadata, profile.name), prefixOffset = profile.literals[0][0];
  // Both tip selection paths load the body into X3/X4 just before the prefix.
  const bodyWords = [0xf86578c3, 0xf94004e4, 0xaa1f03e0];
  const offset = prefixOffset - 8;
  if (prefixOffset < 12 || !bodyWords.every((word, index) =>
    buffer.readUInt32LE(tip.fileOffset + prefixOffset - 12 + index * 4) === word)) return null;
  return {rva:tip.rva + offset, fileOffset:tip.fileOffset + offset, word:bodyWords[1],
    pointerRegister:3, lengthRegister:4, replayFirst:true};
}

/** Translate literal display strings after Join and before Lip Gloss measures them. */
export function collectCliDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const fn = uniqueFunction(metadata, renderName), join = uniqueFunction(metadata, 'strings.Join');
  const sites = [], unsupported = [];
  function record(role, site) {
    if (site) sites.push({...site, role});
    else unsupported.push(role);
  }
  let renderSite;
  if (fn && join) {
    const matches = [];
    for (let offset = 4; offset + 12 <= fn.size; offset += 4) {
      if (branchTarget(buffer.readUInt32LE(fn.fileOffset + offset - 4), fn.rva + offset - 4) !== join.rva) continue;
      const word = buffer.readUInt32LE(fn.fileOffset + offset);
      if (((word & 0xffc003ff) >>> 0) === 0x910003fb &&
          buffer.readUInt32LE(fn.fileOffset + offset + 4) === 0xa9007f7f &&
          ((buffer.readUInt32LE(fn.fileOffset + offset + 8) & 0xffc003ff) >>> 0) === 0xf90003ff) {
        const fileOffset = fn.fileOffset + offset;
        matches.push({rva:fn.rva + offset, fileOffset, word, pointerRegister:0, lengthRegister:1,
          wideEntry:Buffer.from(buffer.subarray(fileOffset, fileOffset + 12))});
      }
    }
    if (matches.length === 1) renderSite = matches[0];
  }
  record('通用样式显示', renderSite);
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
  // IDA: ANSI's scalar Method is X0, the source string is X1/X2, and width /
  // breakpoints occupy X3..X5. Lip Gloss Wrap takes the source in X0/X1.
  // Translate before these helpers allocate a wrapped/truncated string.
  for (const [name, pointerRegister, lengthRegister] of [
    ...['truncate', 'hardwrap', 'wordwrap', 'wrap'].map(suffix => [ansiPrefix + suffix, 1, 2]),
    [wrapName, 0, 1],
  ]) {
    const helper = uniqueFunction(metadata, name);
    // The UI helper takes its string argument before the Go stack growth check.
    const word = helper && buffer.readUInt32LE(helper.fileOffset);
    const valid = helper && helper.size >= 16 && word === 0xf9400b90 &&
      ((buffer.readUInt32LE(helper.fileOffset + 4) & 0xffc003ff) >>> 0) === 0xd10003f1 &&
      buffer.readUInt32LE(helper.fileOffset + 8) === 0xeb10023f &&
      ((buffer.readUInt32LE(helper.fileOffset + 12) & 0xff00001f) >>> 0) === 0x54000009;
    record('文本排版 ' + name.slice(name.lastIndexOf('.') + 1), valid && {
      rva:helper.rva, fileOffset:helper.fileOffset, word, pointerRegister, lengthRegister,
      wideEntry:Buffer.from(buffer.subarray(helper.fileOffset, helper.fileOffset + 12)),
    });
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
    const name = `google3/third_party/jetski/cli/render/render.${suffix}`, helper = uniqueFunction(metadata, name);
    const valid = fn && helper && offset + (expected.length + 1) * 4 <= helper.size &&
      expected.every((word, index) => buffer.readUInt32LE(helper.fileOffset + offset + index * 4) === word) &&
      branchTarget(buffer.readUInt32LE(helper.fileOffset + offset + expected.length * 4),
        helper.rva + offset + expected.length * 4) === fn.rva;
    record('导航提示 ' + suffix, valid && {rva:helper.rva + offset, fileOffset:helper.fileOffset + offset,
      word:expected[0], pointerRegister, lengthRegister, replayFirst:true});
  }
  const truncate = uniqueFunction(metadata, 'google3/third_party/jetski/cli/model/model.truncateToWidth');
  const truncateMatches = truncate && truncate.size >= 12 && buffer.readUInt32LE(truncate.fileOffset) === 0xf9400b90 &&
    buffer.readUInt32LE(truncate.fileOffset + 4) === 0xeb3063ff &&
    ((buffer.readUInt32LE(truncate.fileOffset + 8) & 0xff00001f) >>> 0) === 0x54000009;
  record('输入提示排版', truncateMatches && {rva:truncate.rva, fileOffset:truncate.fileOffset,
    word:0xf9400b90, pointerRegister:0, lengthRegister:1});

  const shortcuts = uniqueFunction(metadata, 'google3/third_party/jetski/cli/model/model.HelpModel.renderShortcutsTab');
  const stringRunes = uniqueFunction(metadata, 'runtime.stringtoslicerune');
  const shortcutDescriptions = [];
  if (shortcuts && stringRunes) {
    const word = offset => buffer.readUInt32LE(shortcuts.fileOffset + offset);
    const stackOp = offset => (word(offset) & 0xffc003ff) >>> 0;
    for (let call = 0x20; call + 4 <= shortcuts.size; call += 4) {
      if (branchTarget(word(call), shortcuts.rva + call) !== stringRunes.rva) continue;
      // Each row is two strings. X4/X5 hold the shortcut itself; X1/X2
      // hold the description used by the rune conversion. Stack slots vary.
      if (word(call - 0x20) !== 0x8b0714c3 || word(call - 0x1c) !== 0xa9401464 ||
          stackOp(call - 0x18) !== 0xf90003e5 || stackOp(call - 0x14) !== 0xf90003e4 ||
          word(call - 0x10) !== 0xa9410861 || stackOp(call - 0x0c) !== 0xf90003e2 ||
          stackOp(call - 0x08) !== 0xf90003e1 || stackOp(call - 0x04) !== 0x910003e0) continue;
      const offset = call - 0x10;
      shortcutDescriptions.push({rva:shortcuts.rva + offset, fileOffset:shortcuts.fileOffset + offset,
        word:word(offset), pointerRegister:1, lengthRegister:2, replayFirst:true});
    }
  }
  record('快捷键说明', shortcutDescriptions.length === 1 && shortcutDescriptions[0]);

  record('条件提示', findTipBodySite(buffer, metadata));

  const boxString = uniqueFunction(metadata, 'runtime.convTstring');
  // Timer/cron status is a separate system string. Prompt is already boxed
  // into the first fmt argument; translate only the second status argument.
  const scheduleName = 'google3/third_party/oneharness/internal/tools/tools.scheduleRenderInfo';
  const schedule = uniqueFunction(metadata, scheduleName);
  const scheduleMatches = schedule && boxString && schedule.size >= 0x19c &&
    buffer.readUInt32LE(schedule.fileOffset + 0x34) === 0xa914afea &&
    buffer.readUInt32LE(schedule.fileOffset + 0x180) === 0xa95387e0 &&
    branchTarget(buffer.readUInt32LE(schedule.fileOffset + 0x184),schedule.rva + 0x184) === boxString.rva &&
    buffer.readUInt32LE(schedule.fileOffset + 0x190) === 0xa90c83e2 &&
    buffer.readUInt32LE(schedule.fileOffset + 0x194) === 0xa95487e0 &&
    branchTarget(buffer.readUInt32LE(schedule.fileOffset + 0x198),schedule.rva + 0x198) === boxString.rva;
  record('定时任务状态', scheduleMatches && {rva:schedule.rva + 0x194, fileOffset:schedule.fileOffset + 0x194,
    word:0xa95487e0, pointerRegister:0, lengthRegister:1, replayFirst:true});
  if (!sites.length) throw new CliCompatibilityError('CLI 通用显示入口未找到');
  return {imageBase:metadata.imageBase, entries:collectCliLiteralEntries(buffer, metadata, sources),
    site:sites[0], sites, unsupported};
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
  'Queue until after the current turn.',
  'Send into the current turn; the agent reads it after its current step.',
];

// Only the equality branch selects a built-in option. It loads adjacent Go
// string fields (Value, Label) from the same option and uses Label when set.
function findSettingOptionSite(buffer, renderer, equal) {
  if (!renderer || !equal) return null;
  const word = offset => buffer.readUInt32LE(renderer.fileOffset + offset);
  const sites = [];
  for (let offset = 0; offset + 8 <= renderer.size; offset += 4) {
    if (branchTarget(word(offset), renderer.rva + offset) !== equal.rva) continue;
    const branch = word(offset + 4);
    if (((branch & 0xfff8001f) >>> 0) !== 0x37000000) continue; // tbnz w0,#0,matched
    const matched = offset + 4 + signed((branch >>> 5) & 0x3fff, 14) * 4;
    if (matched < 0 || matched + 36 > renderer.size) continue;

    const fieldOffset = at => {
      const low = word(at), high = word(at + 4);
      if (((low & 0xffc003ff) >>> 0) !== 0x910003fb ||
          ((high & 0xffc003ff) >>> 0) !== 0x9140037b) return null;
      return ((low >>> 10) & 0xfff) + ((high >>> 10) & 0xfff) * 4096;
    };
    const label = fieldOffset(matched), value = fieldOffset(matched + 12);
    if (value === null || label !== value + 16 || word(matched + 8) !== 0xa9400b61 ||
        word(matched + 20) !== 0xa9401b65 || word(matched + 24) !== 0xf100005f ||
        word(matched + 28) !== 0x9a861044 || word(matched + 32) !== 0x9a851023) continue;
    const fileOffset = renderer.fileOffset + matched;
    sites.push({rva:renderer.rva + matched + 32, fileOffset:fileOffset + 32, word:word(matched + 32),
      pointerRegister:3, lengthRegister:4, replayFirst:true, contextFileOffset:fileOffset,
      originalContext:Buffer.from(buffer.subarray(fileOffset, fileOffset + 36))});
  }
  return sites.length === 1 ? sites[0] : null;
}

const settingOptionPolicy = 'google3/third_party/jetski/cli/store/store.(*Store).IsOptionDisallowed';

function findSettingOptionListSites(buffer, renderer, policy, concat, render) {
  if (!renderer || !policy || !concat || !render) return [];
  const word = offset => buffer.readUInt32LE(renderer.fileOffset + offset);
  const calls = (at, fn) => branchTarget(word(at), renderer.rva + at) === fn.rva;
  const stackLoad = (at, register) => ((word(at) & 0xffc003ff) >>> 0) === ((0xf9400360 | register) >>> 0);
  const matches = [];
  for (let at = 0x4c; at + 0x2a0 <= renderer.size; at += 4) {
    // IsOptionDisallowed consumes the option Value. The separate Label loaded
    // into X3/X6 becomes X1/X2 in both styled rows, before appending the suffix.
    if (!calls(at, policy) || word(at - 0x4c) !== 0xa9400b61 ||
        word(at - 0x40) !== 0xa9401b63 || word(at + 0x04) !== 0x370000c0 ||
        word(at + 0x54) !== 0x54000de1) continue;
    const focused = at + 0xfc, regular = at + 0x238;
    if (!calls(focused, concat) || !calls(focused + 0x50, render) ||
        word(focused - 0x24) !== 0xaa1f03e0 ||
        ![1, 2, 3, 4].every((reg, i) => stackLoad(focused - 0x1c + i * 8, reg)) ||
        !calls(regular, concat) || !calls(regular + 0x64, render) ||
        word(regular - 0x1c) !== 0xaa0103e2 || word(regular - 8) !== 0xaa0003e1 ||
        word(regular - 4) !== 0xaa1f03e0) continue;
    matches.push([focused, regular]);
  }
  if (matches.length !== 1) return [];
  // concatstring2 uses only X0–X4 and overwrites its scratch registers; the
  // row reloads all other live values before formatting and writing the cell.
  return matches[0].map(call => {
    const offset = call - 4, fileOffset = renderer.fileOffset + offset;
    return {functionName:renderer.name, rva:renderer.rva + offset, fileOffset, word:word(offset),
      pointerRegister:1, lengthRegister:2, contextFileOffset:fileOffset,
      originalContext:Buffer.from(buffer.subarray(fileOffset, fileOffset + 8))};
  });
}

/** Translate recognized options and system hints, keeping IDs and custom text. */
export function collectCliSettingsDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const name = 'google3/third_party/jetski/cli/model/model.SettingsModel.renderFieldLines';
  const hintName = 'google3/third_party/jetski/cli/model/model.SettingsModel.wrapHint';
  const renderer = uniqueFunction(metadata, name), policy = uniqueFunction(metadata, settingOptionPolicy);
  const optionSite = findSettingOptionSite(buffer, renderer, uniqueFunction(metadata, 'runtime.memequal'));
  const listSites = findSettingOptionListSites(buffer, renderer, policy,
    uniqueFunction(metadata, 'runtime.concatstring2'), uniqueFunction(metadata, renderName));

  // The hint helper receives the selected field's system text in X0/X1.
  const hint = uniqueFunction(metadata, hintName);
  const hintWords = [0xf9400b90,0xd12783f1,0xeb10023f,0x54000e09];
  const hintMatches = hint && hint.size >= hintWords.length * 4 &&
    hintWords.every((word,index) => buffer.readUInt32LE(hint.fileOffset + index * 4) === word);
  const hintSite = hintMatches && {rva:hint.rva,fileOffset:hint.fileOffset,word:hintWords[0],
    pointerRegister:0,lengthRegister:1,contextFileOffset:hint.fileOffset,
    originalContext:Buffer.from(buffer.subarray(hint.fileOffset,hint.fileOffset + hintWords.length * 4))};
  const sites = [optionSite, ...listSites, hintSite].filter(Boolean);
  if (!sites.length) throw new CliCompatibilityError('CLI 设置枚举和动态提示显示入口已变化');

  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const entries = [], missing = [], unsupported = [];
  if (!optionSite && listSites.length) unsupported.push('设置选项');
  if (policy && !listSites.length) unsupported.push('设置选项列表');
  for (const [site, role, functionName, phrases] of [
    [optionSite || listSites.length, '设置选项', name, settingDisplayValues], [hintSite, '设置提示', hintName, dynamicSettingHints],
  ]) {
    if (!site) { unsupported.push(role); continue; }
    for (const original of phrases) {
      const translated = strings[`cli-ui:${original}`] ?? strings[original];
      if (typeof translated !== 'string' || !translated) { missing.push({functionName,original}); continue; }
      if (translated !== original) entries.push({original,translated,sourceLength:Buffer.byteLength(original)});
    }
  }
  return {imageBase:metadata.imageBase,entries,sites,missing,unsupported,matchContent:true};
}

/** Reuse literal matching for distinct display roles without sharing their vocabulary. */
export function collectCliLiteralEntries(buffer, metadata, sources) {
  const rodata = metadata.segments.filter(segment => segment.name === '__TEXT')
    .flatMap(segment => segment.sections.filter(section => section.name === '__rodata'));
  if (rodata.length !== 1) throw new CliCompatibilityError('CLI 固定显示文案区未找到');
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
  return [...unique.values()];
}

function jump(from, to, bits = 26) {
  const delta = (to - from) / 4;
  if (!Number.isSafeInteger(delta) || delta < -(2 ** (bits - 1)) || delta >= 2 ** (bits - 1)) {
    throw new Error('CLI 显示跳转地址超出范围');
  }
  return delta & (2 ** bits - 1);
}

// The style initializer and the five wrap/truncate prologues above each
// identify three position-independent instructions. Only those verified
// entries can use a page-relative branch when __TEXT exceeds B's range.
function displayBranch(from, to, wide) {
  return wide ? [...addressInstructions(9, to, from), 0xd61f0120] : [0x14000000 | jump(from, to)];
}

/** A table lookup changes only the display value and keeps the caller's string. */
export function applyCliDisplayStrings(buffer, plan, { codeAddress, codeFileOffset, capacity, tableAddress, allocateString }) {
  const sites = plan.sites ?? [plan.site];
  for (const site of sites) {
    if (buffer.readUInt32LE(site.fileOffset) !== site.word || (site.wide &&
        !buffer.subarray(site.fileOffset, site.fileOffset + 12).equals(site.wideEntry))) throw new Error('CLI 显示入口已变化');
    if (site.originalContext && !buffer.subarray(site.contextFileOffset,
      site.contextFileOffset + site.originalContext.length).equals(site.originalContext)) {
      throw new Error('CLI 内容显示入口已变化');
    }
  }
  const thunks = [];
  let codeSize = 0;
  for (const site of sites) {
    const words = displayLookup(plan, site, codeAddress + codeSize, tableAddress);
    thunks.push({site, offset:codeSize, words});
    codeSize += words.length * 4;
  }
  if (codeSize > capacity) throw new CliCompatibilityError(`CLI 显示代码空间不足（需 ${codeSize} 字节，剩余 ${capacity} 字节）`);
  if (!Number.isSafeInteger(codeFileOffset) || codeFileOffset < 0 || codeFileOffset + codeSize > buffer.length) {
    throw new Error('CLI 显示代码区超出文件');
  }
  const entries = plan.matchContent ? plan.entries : plan.entries.toSorted((left, right) =>
    left.sourceLength - right.sourceLength || left.sourceRva - right.sourceRva);
  const table = Buffer.alloc(entries.length * 16);
  for (const [index, entry] of entries.entries()) {
    const utf8 = Buffer.from(entry.translated), address = allocateString(utf8), targetRva = address - plan.imageBase;
    // Signed subtraction orders the packed (length, RVA) keys provided each
    // key is a non-negative int64. Go UI strings are much smaller than 2 GiB.
    if (entry.sourceLength >= 0x80000000 || !Number.isSafeInteger(targetRva) ||
        targetRva < 0 || targetRva > 0xffffffff || utf8.length > 0xffffffff) {
      throw new Error('CLI 显示字符串超出查表范围');
    }
    table.writeUInt32LE(entry.sourceRva, index * 16);
    table.writeUInt32LE(entry.sourceLength, index * 16 + 4);
    table.writeUInt32LE(targetRva, index * 16 + 8);
    table.writeUInt32LE(utf8.length, index * 16 + 12);
  }
  const redirects = thunks.map(({site, offset}) => ({site,
    words:displayBranch(plan.imageBase + site.rva, codeAddress + offset, site.wide)}));
  for (const thunk of thunks) thunk.words.forEach((word, index) => buffer.writeUInt32LE(word, codeFileOffset + thunk.offset + index * 4));
  for (const {site, words} of redirects) words.forEach((word, index) => buffer.writeUInt32LE(word >>> 0, site.fileOffset + index * 4));
  return { table, codeSize, translated:plan.entries.length };
}

/** Known UI text can be matched independently of its literal/heap address. */
export function applyCliContentDisplayStrings(buffer, plan, options) {
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
  const address = (register, target) => addressInstructions(register, target, codeAddress + words.length * 4).forEach(put);
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
    if (site.returnOnMatch) put(0xd65f03c0); // Selected pure display function before its prologue.
    else branch('done', 0x14000000, 26);
    label('next');
    put(0x9100416b); // add x11,x11,#16
    put(0xd100058c); // sub x12,x12,#1
    branch('row', 0x14000000, 26);
  } else {
  put(0xcb09000a | (pointer << 5)); // sub x10,source,x9 (literal RVA)
  put(0xd360fd51); // lsr x17,x10,#32
  branch('done', 0xb5000011); // cbnz x17,done
  put(0xd35ffc11 | (length << 5)); // lsr x17,length,#31
  branch('done', 0xb5000011); // cbnz x17,done
  put(0xaa00814a | (length << 16)); // orr x10,x10,length,lsl#32 (length:RVA)
  address(11, tableAddress);
  constant(12, 0); constant(13, plan.entries.length);
  label('search');
  // The search interval never inverts. Compare with EOR/SUB and CBZ/TBNZ
  // so settings loads and other inline display sites preserve NZCV.
  put(0xca0d0191); // eor x17,x12,x13
  branch('done', 0xb4000011); // cbz x17,done
  put(0x8b0d018e); // add x14,x12,x13
  put(0xd341fdce); // lsr x14,x14,#1
  put(0x8b0e1170); // add x16,x11,x14,lsl#4
  put(0xf9400211); // ldr x17,[x16]
  put(0xcb110151); // sub x17,x10,x17
  branch('lower', 0xb7f80011, 14); // tbnz x17,#63,lower
  branch('higher', 0xb5000011); // cbnz x17,higher
  put(0x29410200 | (length << 10) | pointer); // ldp pointer,length,[x16,#8]
  put(0x8b000120 | (pointer << 16) | pointer); // add source,x9,source
  branch('done', 0x14000000, 26);
  label('lower'); put(0xaa0e03ed); // mov x13,x14
  branch('search', 0x14000000, 26);
  label('higher'); put(0x910005cc); // add x12,x14,#1
  branch('search', 0x14000000, 26);
  }
  label('done');
  if (site.wide) {
    // Replay the entire stack initialization, including CMP's flags on the
    // Go stack-growth path. ADRP/ADD/BR preserve those flags and X16/X17.
    for (let i = 0; i < 12; i += 4) put(site.wideEntry.readUInt32LE(i));
  } else if (!site.replayFirst) put(site.word);
  displayBranch(codeAddress + words.length * 4, plan.imageBase + site.rva + (site.wide ? 12 : 4), site.wide).forEach(put);
  for (const fix of fixups) {
    const target = labels.get(fix.name), displacement = jump(fix.offset, target, fix.bits);
    words[fix.offset / 4] = (fix.word | (fix.bits === 26 ? displacement : displacement << 5)) >>> 0;
  }
  return words;
}
