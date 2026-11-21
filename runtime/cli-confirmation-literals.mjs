import { CliCompatibilityError } from './cli-compatibility.mjs';
import { fileOffsetFor, pageAddress } from './cli-localization.mjs';

const model = 'google3/third_party/jetski/cli/model/model.(*ToolConfirmationModel).';

// A choice has an action enum at +0 and a display string at +8. Inputs and
// permission rules are separate fields. In particular handleConfirm copies the
// label into its closure at +0x30/+0x38, but the sender never reads those two
// fields. It sends the enum and rule, and handles any typed amendment separately.
const readers = [
  ['canAmend', 384, [[0x48, 0xf8617801]]],
  ['escDisabledHint', 240, [[0x38, 0xf8637803], [0x60, 0xf8647804]]],
  ['autoModeSelected', 112, [[0x38, 0xf8617801]]],
  ['Update', 3776, [[0x1f0, 0xf100003f], [0x1f8, 0x9a810084]]],
  ['updateExpandedDiff', 1920, [[0x348, 0xeb02003f]]],
  ['handleConfirm', 1248, [[0x168, 0xa9409484], [0x174, 0xf8637803], [0x450, 0xa9028c01], [0x458, 0xa9039001]]],
  ['handleConfirm.func1', 432, [[0x1c, 0xa9451b45], [0x28, 0xa940a347], [0x2c, 0xa9418b41],
    [0x30, 0xa9442740], [0x38, 0xf940174a], [0x40, 0xf940334b], [0x128, 0xa90b83e2], [0x134, 0x9102a3e1]]],
];

function verifyReaders(buffer, metadata) {
  for (const [method, size, instructions] of readers) {
    const name = model + method, fn = metadata.functions.get(name);
    if (!fn || fn.size !== size || metadata.ambiguousFunctions?.has(name) ||
        instructions.some(([offset, word]) => buffer.readUInt32LE(fn.fileOffset + offset) !== word)) {
      throw new CliCompatibilityError('CLI 工具确认选项的读取方式已变化');
    }
  }
}

function confirmationProfile(buffer, metadata, profile, dictionary) {
  verifyReaders(buffer, metadata);
  if (profile.name === model + 'choices') {
    // The length for "No, deny creation" and "Yes, allow access" is shared
    // by the two conditional selects. Both translations must still fit it.
    const strings = dictionary.strings ?? dictionary;
    const lengths = ['No, deny creation', 'Yes, allow access'].map(text =>
      Buffer.byteLength(strings['cli-ui:' + text] || strings[text] || text));
    if (lengths[0] !== lengths[1]) throw new CliCompatibilityError('CLI 文件操作选项需要等长的拒绝创建和允许访问译文');
  }
  return profile;
}

const tell = 'No, and tell %s what to do differently';
export const cliConfirmationLiteralProfiles = [
  {name:model + 'choices', optional:true, size:5360, resolve:confirmationProfile,
    guards:[[0x110, 0xa9009003], [0x120, 0xa9019003], [0xc54, 0xa9008c02],
      [0x1168, 0x9a821021], [0x1180, 0x9a821021], [0x1190, 0x9a821022], [0x119c, 0x9a811041]],
    literals:[
      [0x104,0x10c,3,4,'Yes, accept this change'], [0x118,0x124,4,3,'No, reject this change'],
      [0x1ec,0x1e4,8,8,'Yes, and always allow non-workspace access'],
      [0x638,0x640,3,4,'Yes, elevate'], [0x64c,0x658,4,3,'No, deny'], [0x8f0,0x8fc,5,4,'No, deny'],
      [0xc48,0xc50,2,3,'Yes, run command'], [0xddc,0xdbc,7,7,'No, cancel'],
      [0x1158,0x1188,1,1,'No, deny creation'], [0x1160,0x118c,2,2,'No, deny access'],
      [0x1170,0x1198,1,2,'Yes, allow creation'], [0x1178,0x1188,2,1,'Yes, allow access'],
      [0x1224,0x1230,5,4,'Yes, and always allow non-workspace access'],
      ...[[0x2dc,tell], [0xf9c,tell], [0x13ec,tell],
        [0x6b0,'Yes, grant permission for %s in this conversation'],
        [0x764,'Yes, grant permission for %s (Persist to %s)'],
        [0x7b8,'No, and always deny for %s in this conversation'],
        [0x86c,'No, and always deny for %s (Persist to %s)'],
        [0xa50,"Yes, and always allow in this conversation for commands that start with '%s'"],
        [0xaa4,"No, and always deny for commands that start with '%s' in this conversation"],
        [0xb58,"Yes, and always allow for commands that start with '%s' (Persist to %s)"],
        [0xc0c,"No, and always deny for commands that start with '%s' (Persist to %s)"],
        [0x1038,'Yes, use Auto mode until you exit, and tell %s what to do next'],
        [0x10d4,'Yes, and tell %s what to do next'],
      ].map(([offset, text]) => [offset,offset+8,0,1,text,offset+28]),
      ...[[0x6f4,4], [0x7fc,4], [0xae8,3], [0xb9c,4]].map(([offset, reg]) =>
        [offset,offset-4,reg,reg-1,'remote settings']),
    ]},
  {name:model + 'withAutoModeChoice', optional:true, size:224, resolve:confirmationProfile,
    literals:[[0x8c,0x84,9,9,'Yes, and use Auto mode until you exit (auto-approve edits and safe commands)']]},
  {name:model + 'standardChoices', optional:true, size:976, resolve:confirmationProfile,
    literals:[[0x8c,0x88,2,0,'remote settings']]},
];

const accessOptions = ['Yes, allow access', 'No, deny access', "Yes, and always allow access to '%s' in this conversation",
  "Yes, and always allow access to '%s' (Persist to %s)", "No, and always deny access to '%s' in this conversation",
  "No, and always deny access to '%s' (Persist to %s)"];
const confirmationTexts = [
  [0x104, ['Allow access to this file?', ...accessOptions]],
  [0x23c, ['Allow access to this URL?', ...accessOptions]],
  [0x334, ['Allow calling this tool?', 'Yes, allow tool call', 'No, deny tool call',
    "Yes, and always allow tool '%s' in this conversation", "Yes, and always allow tool '%s' (Persist to %s)",
    "No, and always deny tool '%s' in this conversation", "No, and always deny tool '%s' (Persist to %s)"]],
  [0x434, ['Grant requested permission?', 'Yes, grant permission', 'No, deny permission',
    "Yes, and always grant permission for '%s' in this conversation", "Yes, and always grant permission for '%s' (Persist to %s)",
    "No, and always deny permission for '%s' in this conversation", "No, and always deny permission for '%s' (Persist to %s)"]],
  [0x4d8, ['Do you want to proceed?', 'Yes, proceed', 'No, cancel',
    "Yes, and always allow '%s' in this conversation", "Yes, and always allow '%s' (Persist to %s)",
    "No, and always deny '%s' in this conversation", "No, and always deny '%s' (Persist to %s)"]],
];

// copyFor returns seven strings in X0..X13. Lengths come from seven static
// headers, and pointers are materialized separately just before RET. Replace
// those return values only; the original tables and rule targets stay intact.
export function collectCliConfirmationCopy(buffer, metadata, collectGroup, add) {
  const name = model + 'copyFor', fn = metadata.functions.get(name);
  if (!fn) return;
  collectGroup(name, () => {
    verifyReaders(buffer, metadata);
    const mismatch = () => { throw new CliCompatibilityError('CLI 工具确认提示的布局已变化'); };
    if (metadata.ambiguousFunctions?.has(name) || fn.size !== 1328) mismatch();
    const word = at => buffer.readUInt32LE(fn.fileOffset + at);
    for (const [start, captions] of confirmationTexts) {
      if (word(start + 64) !== 0xd65f03c0) mismatch();
      for (const [index, original] of captions.entries()) {
        const at = start + index * 8, lengthAt = at - 0x60, pr = index * 2, lr = pr + 1;
        const page = word(at), plus = word(at + 4), lengthPage = word(lengthAt), load = word(lengthAt + 4);
        if (((page & 0x9f00001f) >>> 0) !== ((0x90000000 | pr) >>> 0) ||
            ((plus & 0xffc003ff) >>> 0) !== ((0x91000000 | pr << 5 | pr) >>> 0) ||
            ((lengthPage & 0x9f00001f) >>> 0) !== 0x9000001b || ((load & 0xffc003ff) >>> 0) !== ((0xf9400360 | lr) >>> 0)) mismatch();
        const pc = metadata.imageBase + fn.rva + at, address = pageAddress(page, pc) + ((plus >>> 10) & 4095);
        const header = pageAddress(lengthPage, pc - 0x60) + ((load >>> 10) & 4095) * 8 - 8;
        const slot = fileOffsetFor(metadata, header, 16), bytes = Buffer.from(original);
        if (buffer.readBigUInt64LE(slot) !== BigInt(address) || buffer.readBigUInt64LE(slot + 8) !== BigInt(bytes.length)) mismatch();
        const src = fileOffsetFor(metadata, address, bytes.length);
        if (!bytes.equals(buffer.subarray(src, src + bytes.length))) mismatch();
        const contextFileOffset = fn.fileOffset + lengthAt;
        add({kind:'literal',functionName:name,original,sourceLength:bytes.length,sourceAddress:address,pointerPc:pc,
          pointerFileOffset:fn.fileOffset+at,lengthFileOffset:contextFileOffset+4,pointerRegister:pr,lengthRegister:lr,
          contextFileOffset,originalContext:Buffer.from(buffer.subarray(contextFileOffset,fn.fileOffset+at+8))});
      }
    }
  });
}
