import { pageAddress, stringLengthImmediate } from './cli-localization.mjs';

const cli = 'google3/third_party/jetski/cli/';
const model = cli + 'model/model.';
const providerLabels = ['Gemini API key', 'Enterprise Gateway'];
const displayFields = [
  [cli + 'render/render.BannerWithInfo', providerLabels, 1, 2, 'tuple'],
  [model + 'HelpModel.renderTabBar', ['general', 'commands', 'shortcuts'], 5, 6, 'tuple'],
  [model + 'StatusLineModel.RenderBuiltIn', ['? for shortcuts'], 3, 4, 'tuple'],
  [cli + 'layout/layout.Column.renderKeyboardHints', ['Keyboard: '], 3, 4, 'tuple'],
  [model + 'SettingsModel.KeyboardHints', ['Clear Search/Exit'], 8, 9, 'field'],
  [cli + 'render/render.HintNavigate', ['Navigate'], 2, 3, 'return'],
];
const trustOptions = ['Yes, I trust this folder', 'No, exit'];
const masked = (word, mask, value) => ((word & mask) >>> 0) === (value >>> 0);

function addressAt(buffer, fn, index, imageBase, register) {
  if (index < 0 || index + 8 > fn.size) return null;
  const offset = fn.fileOffset + index;
  const page = buffer.readUInt32LE(offset), add = buffer.readUInt32LE(offset + 4);
  if (!masked(page, 0x9f00001f, 0x90000000 | register) ||
      !masked(add, 0xffc003ff, 0x91000000 | (register << 5) | register)) return null;
  return pageAddress(page, imageBase + fn.rva + index) + ((add >>> 10) & 4095);
}

function sectionOffset(section, address, length) {
  if (!section || !Number.isSafeInteger(address) || address < section.address ||
      length > section.address + section.size - address) return null;
  return section.fileOffset + address - section.address;
}

function callTarget(word, pc) {
  return word >>> 26 === 0x25 ? pc + (word << 6 >> 6) * 4 : null;
}

/** Adapt the strings which form native navigation controls before measuring or styling. */
export function collectCliNavigationLocalization(buffer, dictionary, metadata, claimedPatches = []) {
  const strings = dictionary.strings ?? dictionary;
  const {imageBase} = metadata;
  const rodata = metadata.segments.find(s => s.name === '__TEXT')?.sections.find(s => s.name === '__rodata');
  const data = metadata.segments.find(s => s.name === '__DATA')?.sections.find(s => s.name === '__data');
  const patches = [], missing = [], unsupported = [];
  const claimed = new Set(claimedPatches.map(p => p.pointerFileOffset ?? p.fileOffset));
  const find = name => metadata.ambiguousFunctions?.has(name) ? null : metadata.functions.get(name);
  function originalAt(address, length, expected) {
    if (!expected.includes(length)) return null;
    const offset = sectionOffset(rodata, address, length);
    return offset === null ? null : buffer.toString('utf8', offset, offset + length);
  }
  function add(patch) {
    if (claimed.has(patch.pointerFileOffset ?? patch.fileOffset)) return;
    const translated = strings['cli-ui:' + patch.original] ?? strings[patch.original];
    if (!translated) missing.push({functionName:patch.functionName, original:patch.original});
    else if (translated !== patch.original) patches.push({...patch, translated});
  }
  function literal(fn, index, pointer, lengthIndex, length, original, end) {
    const pointerFileOffset = fn.fileOffset + index, lengthFileOffset = fn.fileOffset + lengthIndex;
    const contextFileOffset = Math.min(pointerFileOffset, lengthFileOffset);
    return {kind:'literal', functionName:fn.name, original, sourceLength:Buffer.byteLength(original),
      pointerPc:imageBase + fn.rva + index, pointerRegister:pointer, lengthRegister:length,
      pointerFileOffset, lengthFileOffset, contextFileOffset,
      originalContext:Buffer.from(buffer.subarray(contextFileOffset, fn.fileOffset + end))};
  }
  for (const [name, labels, pointer, length, role] of displayFields) {
    const fn = find(name), found = new Set(), lengths = labels.map(s => Buffer.byteLength(s));
    for (let i = 0; fn && i + 24 <= fn.size; i += 4) {
      const word = n => buffer.readUInt32LE(fn.fileOffset + i + n);
      const address = addressAt(buffer, fn, i, imageBase, pointer);
      const original = originalAt(address, stringLengthImmediate(word(8), length), lengths);
      if (!labels.includes(original)) continue;
      // The tab list, status line and keyboard prefix build display-only Go string
      // tuples. The frame address may need one or two ADDs in different builds.
      let end = 16;
      if (role === 'tuple') {
        if (!masked(word(12), 0xff8003ff, 0x910003fb)) continue;
        let tuple = 16;
        if (masked(word(tuple), 0xff8003ff, 0x9100037b)) tuple += 4;
        if (word(tuple) !== ((0xa9000360 | (length << 10) | pointer) >>> 0)) continue;
        end = tuple + 4;
      } else if (role === 'field') {
        if (word(12) !== 0xa90524e8) continue; // KeyboardHints writes KeyHint.Action.
      } else {
        if (word(12) !== 0xf85f83fd || word(20) !== 0xd65f03c0) continue;
        end = 24;
      }
      found.add(original);
      add(literal(fn, i, pointer, i + 8, length, original, i + end));
    }
    for (const label of labels) if (!found.has(label)) unsupported.push(label);
  }
  // The Help page appends the provider's display name to its []string.
  // Match this display-only assignment, leaving the sign-in method ID intact.
  const help = find(model + 'HelpModel.renderGeneralTab'), barrier = find('runtime.gcWriteBarrier1');
  const providerLengths = providerLabels.map(p => p.length);
  const providersFound = new Set();
  for (let i = 40; help && barrier && i + 16 <= help.size; i += 4) {
    const word = n => buffer.readUInt32LE(help.fileOffset + i + n);
    if (word(-40) !== 0xd10004c7 || word(-36) !== 0x8b0710a7 || word(-28) !== 0xf90004e8 ||
        word(-16) !== 0x34000088 || word(-12) !== 0xf94000e8 || word(-4) !== 0xf9000328 ||
        word(8) !== 0xf90000e8 || callTarget(word(-8),help.rva + i - 8) !== barrier.rva) continue;
    const original = originalAt(addressAt(buffer, help, i, imageBase, 8), stringLengthImmediate(word(-32),8), providerLengths);
    if (!providerLabels.includes(original)) continue;
    providersFound.add(original);
    add(literal(help, i, 8, i - 32, 8, original, i + 12));
  }
  for (const provider of providerLabels) if (!providersFound.has(provider)) unsupported.push(provider);
  // The trust picker stores each action ID separately from its displayed label.
  // Bind to the actual slice consumed by View and validate both rows together.
  const trust = find(model + 'WorkspaceTrustModel.View');
  let trustFound = false;
  for (let i = 0; trust && i + 12 <= trust.size; i += 4) {
    if (buffer.readUInt32LE(trust.fileOffset + i + 8) !== 0xa9401363) continue;
    const slice = sectionOffset(data, addressAt(buffer, trust, i, imageBase, 27), 24);
    if (slice === null || buffer.readBigUInt64LE(slice + 8) !== 2n || buffer.readBigUInt64LE(slice + 16) !== 2n) continue;
    const rows = sectionOffset(data, Number(buffer.readBigUInt64LE(slice)), 48);
    if (rows === null) continue;
    const labels = [];
    for (const [index, original] of trustOptions.entries()) {
      const row = rows + index * 24, fileOffset = row + 8;
      if (buffer.readBigUInt64LE(row) !== BigInt(index) || buffer.readBigUInt64LE(row + 16) !== BigInt(original.length) ||
          originalAt(Number(buffer.readBigUInt64LE(fileOffset)), original.length, [original.length]) !== original) break;
      labels.push({kind:'slot',functionName:trust.name,original,fileOffset,contextFileOffset:row,
        originalContext:Buffer.from(buffer.subarray(row,row + 24))});
    }
    if (labels.length === trustOptions.length) {
      labels.forEach(add);
      trustFound = true;
      break;
    }
  }
  if (!trustFound) unsupported.push('项目目录信任选项');
  return {imageBase,patches,missing,unsupported};
}

const footerLabels = [
  'Navigate', 'Select', 'Select / Toggle', 'Change', 'Toggle', 'Switch View', 'Switch view', 'Effort', 'Go Back',
  'Close', 'Clear Search/Exit', 'Confirm', 'Complete', 'Back', 'Exit', 'Cancel', 'Search', 'Scroll', 'Page',
  'Page up', 'Page down', 'Top', 'Bottom', 'Refresh', 'View output', 'Next', 'Previous', 'Save',
  'Kill Task', 'Remove Task From List',
  'Kill Active Subagent', 'Switch Tab', 'Go back / Clear search', 'Cycle Tabs', 'Expand Details',
  'Toggle Enable', 'Enter Local Path', 'Actions', 'Add rule', 'Edit rule', 'Delete rule', 'Select & Continue',
  'Open Browser Again', 'Confirm Disconnect', 'Disconnect', 'Reconnect', 'Connect', 'Exit Search',
  'Move Between Fields', 'Next Field', 'Enable', 'Save & Continue', 'Try Again', 'Skip',
  'Sign In', 'Sign Out', 'Configure MCP Servers', 'Uninstall', 'Install', 'Install Plugin', 'Complete Path',
  'Confirm Sign Out', 'Confirm Uninstall', 'Collapse Shelf', 'Expand Shelf', 'Prev/Next Shelf',
  'New Project', 'Clear Search', 'Clear Filter', 'Create', 'Switch', 'Add', 'Remove',
  'Expand', 'Collapse', 'Add Link', 'Add File', 'Add Folder', 'Deselect', 'Cancel Project', 'Discard', 'Keep Editing',
];

// IDA: Column.renderKeyboardHints iterates the key and action pairs in its
// measurements and in both layouts. Each sequence stores the action separately
// before formatting; the subsequent Go call takes only X0..X2. The lookup
// operates after loading Action and before measuring it. Key stays untouched.
const columnStyleCopy = [
  0xd2800158,0xacc14490,0xac814470,0xacc14490,0xac814470,0xd1000718,0xb5ffff78,0xf9400099,0xf9000079,
];
const styleRender = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render';
const columnActionReads = [
  {role:'底栏宽度',pointer:2,length:3,callee:'runtime.convTstring',
    words:[0xf9029fe3,0xa9400460,0xa9410c62,0xf9022be3,0xf902a3e2,0x911363fb,0xa9007f7f]},
  {role:'底栏换行',pointer:3,length:7,callee:styleRender,
    words:[0xf9029fe3,0xa9401865,0xa9411c63,0xf9022be7,0xf902a3e3,0x91000483,0xf90227e3,0x911423fb,
      0xa9001b65,0x910023e3,0x914007e4,0x913c6084,...columnStyleCopy,0x911423e0,0xb24003e1,0xaa0103e2]},
  {role:'底栏单行',pointer:3,length:6,callee:styleRender,
    words:[0xf9029fe3,0xa9401464,0xa9411863,0xf9022fe6,0xf902a3e3,0x911463fb,0xa9001764,0x910023e3,
      0x914007e4,0x913c6084,...columnStyleCopy,0x911463e0,0xb24003e1,0xaa0103e2]},
];

function matchesFooterWord(actual, expected) {
  // Go frame sizes and spill offsets can change without changing the KeyHint
  // layout or the call. Preserve the instruction, stack base and registers.
  if (masked(expected, 0xffc003e0, 0xf90003e0) || masked(expected, 0xff8003e0, 0x910003e0)) {
    return masked(actual, 0xffc003ff, expected & 0xffc003ff);
  }
  return actual === expected;
}

export function collectCliFooterActionDisplayStrings(buffer, dictionary, metadata) {
  const name = cli + 'layout/layout.Column.renderKeyboardHints', fn = metadata.functions.get(name);
  const sites = [], unsupported = [], entries = [];
  for (const {role,pointer,length,callee,words} of columnActionReads) {
    const target = metadata.functions.get(callee), matches = [];
    if (fn && target && !metadata.ambiguousFunctions?.has(name) && !metadata.ambiguousFunctions?.has(callee)) {
      for (let i = 0; i + words.length * 4 + 4 <= fn.size; i += 4) {
        const start = fn.fileOffset + i, call = start + words.length * 4;
        if (buffer.readUInt32LE(start + 8) !== words[2] || !words.every((word,index) =>
          matchesFooterWord(buffer.readUInt32LE(start + index * 4), word))) continue;
        if (callTarget(buffer.readUInt32LE(call),fn.rva + i + words.length * 4) !== target.rva) continue;
        matches.push({functionName:name,rva:fn.rva+i+8,fileOffset:start+8,word:words[2],
          pointerRegister:pointer,lengthRegister:length,replayFirst:true,contextFileOffset:start,
          originalContext:Buffer.from(buffer.subarray(start,call+4))});
      }
    }
    if (matches.length === 1) sites.push(matches[0]);
    else unsupported.push(role);
  }
  const strings = dictionary.strings ?? dictionary;
  for (const original of footerLabels) {
    const translated = strings['cli-ui:' + original] ?? strings[original];
    if (translated && translated !== original) entries.push({original,translated,sourceLength:Buffer.byteLength(original)});
  }
  return {imageBase:metadata.imageBase,matchContent:true,entries,sites,unsupported};
}
