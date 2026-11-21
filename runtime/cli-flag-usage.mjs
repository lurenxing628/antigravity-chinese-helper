import { CliCompatibilityError } from './cli-compatibility.mjs';
import { nativeUsageDescriptions } from './cli-native-help.mjs';
import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

const flags = 'google3/base/go/flag.(*FlagSet).';
const entrypoints = 'google3/third_party/jetski/cli/entrypoints/entrypoints.';
const validateLaunchFlags = entrypoints + 'validateLaunchFlags';

// Each option prepends its own display-only label to the provider's reason.
// Use that label to distinguish the two otherwise identical native branches.
const remoteLaunchMessages = ['--remote-agent', '--remote-control'].map(flag => ({
  name:validateLaunchFlags, optional:true, resolve:relocateStatusLiteralGroup,
  literals:[
    [0,-4,0,1,'not available with a Gemini API key',undefined,'cli-help:'],
    [16,24,1,2,'not available with a Gemini API key; ',undefined,'cli-help:'],
    [64,48,1,2,`${flag} is `,undefined,'cli-help:'],
  ],
  verifiedCalls:[[28,'runtime.concatstring2'],[72,'runtime.concatstring2']],
}));

export const flagUsageLiterals = [
  ...remoteLaunchMessages,
  ...[
    [flags + 'Parse', 1, 'flags provided but not defined:%s'],
    ...['bad flag syntax: %s', 'invalid boolean value %q for  -%s: %v', 'invalid boolean flag %s: %v',
      'invalid value %q for flag -%s: %v', 'flag needs an argument: -%s'].map(text => [flags + 'parseOne', 1, text]),
    ['main.main.func2', 2, 'Usage of %s:\n'],
    ['main.main.func2', 0, ' (default %s)'],
    [entrypoints + 'launchCLI', 2, 'error: %v\n'],
    [validateLaunchFlags, 3, '--print and --prompt-interactive are mutually exclusive'],
    [validateLaunchFlags, 3, '--remote-agent does not support --print yet'],
    [validateLaunchFlags, 3, '--remote-agent does not support --conversation-path'],
  ].map(([name, register, text]) => ({name, optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,register,register + 1,text,undefined,'cli-help:']]})),
];

// Both native usage loops convert the description to an interface{} immediately
// before formatting the row. The flag registry (including XML help), parsing,
// option operands and both TTY descriptors remain entirely native.
export function collectCliFlagDescriptions(binary, dictionary, metadata) {
  const convert = metadata.functions.get('runtime.convTstring');
  const entries = nativeUsageDescriptions(dictionary), sites = [], unsupported = [];
  for (const [name, mask, load] of [
    ['main.main.func2', 0xffffffff, 0xa9410420],       // LDP X0,X1,[X1,#16] (flag.Usage)
    ['main.PrintSubcommands', 0xffc07fff, 0xa94007e0], // LDP X0,X1,[SP,#offset] (subcommand description)
  ]) {
    const fn = metadata.functions.get(name), matches = [];
    if (fn && convert && !metadata.ambiguousFunctions?.has(name) && !metadata.ambiguousFunctions?.has(convert.name)) {
      for (let offset = 0; offset + 8 <= fn.size; offset += 4) {
        const fileOffset = fn.fileOffset + offset, word = binary.readUInt32LE(fileOffset), call = binary.readUInt32LE(fileOffset + 4);
        if ((word & mask) >>> 0 !== load || call >>> 26 !== 0x25 ||
            fn.rva + offset + 4 + (call << 6 >> 6) * 4 !== convert.rva) continue;
        matches.push({functionName:name, rva:fn.rva + offset, fileOffset, word, pointerRegister:0, lengthRegister:1,
          replayFirst:true, contextFileOffset:fileOffset, originalContext:Buffer.from(binary.subarray(fileOffset, fileOffset + 8))});
      }
    }
    if (matches.length === 1) sites.push(matches[0]);
    else unsupported.push(name);
  }
  if (!sites.length) throw new CliCompatibilityError('CLI 原生用法的说明文字入口已变化');
  return {imageBase:metadata.imageBase, entries, sites, unsupported, matchContent:true};
}
