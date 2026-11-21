import { CliCompatibilityError } from './cli-compatibility.mjs';
import { fileOffsetFor, pageAddress, stringLengthImmediate } from './cli-localization.mjs';

const model = 'google3/third_party/jetski/cli/model/model.';
const authView = model + 'AuthModel.renderFullView';
const authMenu = model + 'AuthModel.renderSelectionMenu';
const authOptions = model + 'AuthModel.getOptions';
const panelFunctions = new Set([
  model + 'SettingsModel.renderFieldLines', model + 'ContextModel.header', model + 'ContextModel.footer',
  model + 'ContextModel.scrollableBody', authView, model + 'UsageModel.header', model + 'UsageModel.scrollableContent',
  'google3/third_party/jetski/cli/render/render.stepContent',
]);

// Offsets describe the relationship between the two halves of a Go string;
// the matcher locates them in the current function. The selected auth method
// is an independent enum. Only option labels, hints and placeholders appear here.
export const authInstructionProfiles = [
  ...[
    [authView, 3, 'Got an error:'],
    [authView, 9, 'Press any key to go back.'],
    [authView, 4, 'Open the URL below in your browser:'],
    [authView, 3, 'After authenticating, copy the code displayed in the browser and paste it below:\n\n'],
    [authView, 3, "If you aren't automatically redirected, paste the authorization code below:\n\n"],
    [authView, 0, 'unknown error', -4],
    [authView, 1, 'Your browser should open automatically. If not:\n\n', -28],
    [authMenu, 4, 'Select login method:\n', -4, 3],
    [authMenu, 2, 'No authentication methods available.'],
    [authMenu, 3, 'ADC authentication failed. Please verify your Application Default Credentials:\n\n'],
    [authMenu, 3, '  1. Run: gcloud auth application-default login\n'],
    [authMenu, 3, '  2. Or check GOOGLE_APPLICATION_CREDENTIALS env var.\n'],
    [authMenu, 3, '  3. Or unset AGY_ADC_AUTH env var to use other sign in methods.\n\n'],
    [authMenu, 3, 'Press ctrl+c or ctrl+d twice to exit.'],
    [authMenu, 3, 'Back'],
    [authOptions, 0, 'Continue with Google Cloud', -4],
    [authOptions, 0, 'Continue with Advanced SSO', -4],
    [authOptions, 1, 'Continue with ', -16],
    [authOptions, 4, 'Other sign-in options', 12, 3],
    [authOptions, 3, 'Google OAuth'],
    [authOptions, 4, 'Use a Google Cloud project', -36],
    [model + 'AuthModel.View', 2, 'Navigate', -12, 2],
  ].map(([name, pointer, text, lengthOffset = 8, length = pointer + 1]) => ({
    name, resolve:relocateStatusLiteralGroup, literals:[[0, lengthOffset, pointer, length, text]],
  })),
  {name:model + 'AuthModel.updateStart', resolve:relocateStatusLiteralGroup, literals:[
    [0x248,0x218,1,1,'authorization code...'], [0x558,0x538,1,1,'authorization code...'],
    [0x7bc,0x78c,1,1,'authorization code...'],
  ]},
];

// Relocate a whole display expression within its named Go function. Every
// pointer, length, guard and named consumer must move together, including repeated
// labels such as "(current)" that cannot identify a producer on their own.
export function relocateStatusLiteralGroup(buffer, metadata, profile) {
  function findFunction(name) {
    const fn = metadata.functions instanceof Map ? metadata.functions.get(name) : metadata.functions.find(f => f.name === name);
    if (!fn || metadata.ambiguousFunctions?.has(name)) throw new CliCompatibilityError(`CLI 显示函数无法唯一识别：${name}`);
    return fn;
  }
  const fn = profile.variant ?? findFunction(profile.name);
  const calls = [...(profile.verifiedCalls ?? [])];
  const guards = profile.guards ?? [];
  const literals = profile.literals.map(([pointer, length, pointerRegister, lengthRegister, text, formatCall]) => {
    if (formatCall !== undefined) calls.push([formatCall, 'fmt.Sprintf']);
    return {pointer, length, pointerRegister, lengthRegister, bytes:Buffer.from(text)};
  });
  const targets = calls.map(([offset, name]) => ({offset, rva:findFunction(name).rva}));
  const first = Math.min(...literals.flatMap(l => [l.pointer, l.length]), ...targets.map(t => t.offset),
    ...guards.map(([offset]) => offset));
  const end = Math.max(...literals.flatMap(l => [l.pointer + 8, l.length + 4]), ...targets.map(t => t.offset + 4),
    ...guards.map(([offset]) => offset + 4));
  const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
  function matchesLiteral(delta, {pointer, length, pointerRegister, lengthRegister, bytes}) {
    const at = pointer + delta, adrp = word(at), add = word(at + 4);
    if (((adrp & 0x9f00001f) >>> 0) !== ((0x90000000 | pointerRegister) >>> 0) ||
        ((add & 0xffc003ff) >>> 0) !== ((0x91000000 | (pointerRegister << 5) | pointerRegister) >>> 0) ||
        stringLengthImmediate(word(length + delta), lengthRegister) !== bytes.length) return false;
    const address = pageAddress(adrp, metadata.imageBase + fn.rva + at) + ((add >>> 10) & 0xfff);
    try {
      const source = fileOffsetFor(metadata, address, bytes.length);
      return bytes.equals(buffer.subarray(source, source + bytes.length));
    } catch (error) {
      if (error instanceof CliCompatibilityError) return false;
      throw error;
    }
  }
  function matchesCall(delta, {offset, rva}) {
    const at = offset + delta, instruction = word(at);
    return ((instruction & 0xfc000000) >>> 0) === 0x94000000 && fn.rva + at + ((instruction << 6) >> 4) === rva;
  }
  let shift;
  for (let delta = -first; delta <= fn.size - end; delta += 4) {
    if (!literals.every(l => matchesLiteral(delta, l)) || !targets.every(t => matchesCall(delta, t)) ||
        !guards.every(([offset, instruction]) => word(offset + delta) === instruction)) continue;
    if (shift !== undefined) throw new CliCompatibilityError(`CLI 显示文案位置不唯一：${profile.name}`);
    shift = delta;
  }
  if (shift === undefined) throw new CliCompatibilityError(`CLI 显示文案布局已变化：${profile.name}`);
  return {...profile, size:fn.size,
    literals:profile.literals.map(([pointer,length,pr,lr,text,formatCall,namespace]) =>
      [pointer + shift, length + shift, pr, lr, text, formatCall === undefined ? undefined : formatCall + shift, namespace]),
    guards:profile.guards?.map(([offset,instruction]) => [offset + shift,instruction]),
    verifiedCalls:profile.verifiedCalls?.map(([offset,name]) => [offset + shift, name]),
  };
}

export function resolvePanelStatusProfile(buffer, metadata, profile) {
  return panelFunctions.has(profile.name) ? relocateStatusLiteralGroup(buffer, metadata, profile) : profile;
}
