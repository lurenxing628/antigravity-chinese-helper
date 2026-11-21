import { readFileSync } from 'node:fs';
import { CliCompatibilityError } from './cli-compatibility.mjs';
import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

let notes;
function releaseNotes() {
  return notes ??= JSON.parse(readFileSync(new URL('./cli-release-notes.zh-CN.json', import.meta.url), 'utf8'));
}

export function localizeCliReleaseNoteLine(line) {
  const bullet = /^(· )(.+?)(\r?)$/u.exec(line);
  if (!bullet) return line;
  const translated = releaseNotes()[bullet[2]];
  return typeof translated === 'string' ? bullet[1] + translated + bullet[3] : line;
}

// The standalone command prints bullets, while /changelog renders the source
// Markdown. Read the Go string's actual length from its embedded-data header.
function embeddedChangelog(binary, metadata) {
  const section = (segment, name) => metadata.segments.find(s => s.name === segment)?.sections.find(s => s.name === name);
  const text = section('__TEXT', '__rodata'), data = section('__DATA', '__data');
  if (!text || !data) return null;
  const rodata = binary.subarray(text.fileOffset, text.fileOffset + text.size);
  const title = '# Antigravity CLI Changelog\n';
  const offset = rodata.indexOf(title);
  if (offset < 0 || rodata.indexOf(title, offset + title.length) >= 0) return null;
  const pointer = Buffer.alloc(8);
  pointer.writeBigUInt64LE(BigInt(text.address + offset));
  const globals = binary.subarray(data.fileOffset, data.fileOffset + data.size);
  const header = globals.indexOf(pointer);
  if (header < 0 || header % 8 !== 0 || header + 16 > globals.length) return null;
  const length = Number(globals.readBigUInt64LE(header + 8));
  if (length <= title.length || length > rodata.length - offset) return null;
  return rodata.toString('utf8', offset, offset + length);
}

const model = 'google3/third_party/jetski/cli/model/model.ChangelogModel.Init.func1';
const render = 'google3/third_party/jetski/cli/render/render.Markdown';
const cached = 'google3/third_party/jetski/cli/changelog/changelog.readCachedChangelog';
export const releaseNoteProfiles = [
  ...['Warning: Markdown rendering failed: ', 'Error loading changelog: '].map(text => ({
    name:model, allVariants:true, literals:[[0,-16,1,2,text]], verifiedCalls:[[8,'runtime.concatstring2']],
  })),
  ...[
    ['failed to get cache path and no fallback available: %w', 0x40, 0x78, 0x58],
    ['failed to read cache and no fallback available: %w. See online changelog at: %s', 0x108, 0x13c, 0x11c],
  ].map(([text, first, second, call]) => ({
    name:cached, literals:[[first, first + 8, 0, 1, text],[second, second + 8, 3, 4, text]], verifiedCalls:[[call,'fmt.errorf']],
  })),
].map(profile => ({...profile, optional:true, resolve:relocateStatusLiteralGroup}));

// The model calls Markdown with the changelog in X0/X1. The three zero
// arguments just before that call neither use nor need any lookup scratch
// registers. This site excludes arbitrary Markdown from user conversations.
export function collectCliReleaseNotes(binary, dictionary, metadata) {
  const variants = metadata.functionVariants?.get(model) ?? [metadata.functions.get(model)].filter(Boolean);
  const markdown = metadata.functions.get(render);
  const original = embeddedChangelog(binary, metadata);
  if (!variants.length || !markdown || !original || metadata.ambiguousFunctions?.has(render)) {
    throw new CliCompatibilityError('CLI 更新说明或其 Markdown 显示入口未找到');
  }
  const sites = [];
  for (const fn of variants) {
    const before = sites.length;
    for (let i = 12; i + 4 <= fn.size; i += 4) {
      const pos = fn.fileOffset + i, call = binary.readUInt32LE(pos);
      if (call >>> 26 !== 0x25 || fn.rva + i + (call << 6 >> 6) * 4 !== markdown.rva) continue;
      if (binary.readUInt32LE(pos - 12) !== 0xaa1f03e6 || binary.readUInt32LE(pos - 8) !== 0xaa1f03e7 ||
          binary.readUInt32LE(pos - 4) !== 0xaa1f03e8) continue;
      sites.push({functionName:model, rva:fn.rva + i - 4, fileOffset:pos - 4, word:0xaa1f03e8,
        pointerRegister:0, lengthRegister:1, contextFileOffset:pos - 12,
        originalContext:Buffer.from(binary.subarray(pos - 12, pos + 4))});
    }
    if (sites.length !== before + 1) throw new CliCompatibilityError('CLI 更新说明 Markdown 显示入口已变化');
  }

  const strings = releaseNotes(), missing = new Set();
  const translated = original.split('\n').map(line => {
    if (line === '# Antigravity CLI Changelog') return '# Antigravity CLI 更新说明';
    if (line === 'The terminal-first surface to interact with Antigravity agents. Stay in your flow without context switching.') {
      return '在终端与 Antigravity 代理协作，无需切换工作环境。';
    }
    if (!line.startsWith('- ')) return line;
    const source = line.slice(2), value = strings[source];
    if (typeof value === 'string') return '- ' + value;
    missing.add(source);
    return line;
  }).join('\n');
  return {imageBase:metadata.imageBase, entries:[{original, translated, sourceLength:Buffer.byteLength(original)}],
    sites, matchContent:true, missing:[...missing].map(original => ({original, functionName:model}))};
}
