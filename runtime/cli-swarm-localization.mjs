import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';
import { fileOffsetFor, pageAddress } from './cli-localization.mjs';

const cli = 'google3/third_party/jetski/cli/';
const swarm = cli + 'swarm/';
const board = swarm + 'tui/tui.';
const core = swarm + 'swarm.';
const live = swarm + 'live/live.';
const model = cli + 'model/model.';
const namespace = 'cli-swarm:';
const target = name => name.startsWith('tui.') ? board + '(*tuiModel).' + name.slice(4)
  : name.startsWith('core.') ? core + name.slice(5)
  : name.startsWith('live.') ? live + name.slice(5) : name;

// Display-only string operands in the native board and inline status. The
// numeric positions describe each expression, which relocates together.
const boardLiterals = [
  ["tui.stampLayout", "Jan 2 ", 0, 8, 1, 2, 44, "time.Time.Format"],
  ["core.Dir", "resolve swarm directory: %w", 0x38, 0x40, 0, 1, 0x50, "fmt.errorf"],
  ["core.LoadIn", "open swarm board: %w", 0xa8, 0xb0, 0, 1, 0xc0, "fmt.errorf"],
  ["core.LoadIn", "read swarm roster: %w", 0x1b8, 0x1c0, 0, 1, 0x1d0, "fmt.errorf"],
  ["core.LoadIn", "read swarm board: %w", 0x3a8, 0x3b0, 0, 1, 0x3c0, "fmt.errorf"],
  ["core.LoadIn", "read swarm board head: %w", 0x448, 0x450, 0, 1, 0x460, "fmt.errorf"],
  ["core.Format", "Swarm", 0x68, 0x60, 3, 3, 0x74, "runtime.convTstring"],
  ["core.Format", "%s · %d members · %d posts", 0xc8, 0xd0, 2, 3, 0xe0, "fmt.Fprintf"],
  ["core.Format", "Last %d of %d posts:\n", 0x5f0, 0x5f8, 2, 3, 0x608, "fmt.Fprintf"],
  ["core.Format", "Last %d posts in #%s:\n", 0x660, 0x668, 2, 3, 0x678, "fmt.Fprintf"],
  ["core.Format", "\nNo posts in #%s yet.", 0x78c, 0x794, 2, 3, 0x7a4, "fmt.Fprintf"],
  ["core.StatusRow", "Done", 0x5e0, 0x5dc, 6, 2],
  ["core.StatusRow", "Waiting for posts...", 0x604, 0x600, 6, 2],
  ["core.StatusRow", " · %d %s", 0x76c, 0x774, 0, 1, 0x784, "fmt.Sprintf", true],
  ["core.StatusRow", " Swarm()  ", 0x888, 0x890, 3, 4, 0x894, "runtime.concatstring2"],
  ["core.StatusRow", " Swarm  ", 0x8b8, 0x8c0, 3, 4, 0x8c4, "runtime.concatstring2"],
  ["core.StatusRow", "%s Swarm(%s)  ", 0x978, 0x980, 0, 1, 0x990, "fmt.Sprintf"],
  ["core.failureWarning", "⚠ %s failed", 0x3c, 0x44, 0, 1, 0x54, "fmt.Sprintf"],
  ["core.failureWarning", "⚠ %d members failed", 0x7c, 0x84, 0, 1, 0x94, "fmt.Sprintf"],
  ["core.noSuchChannel", "%w: #%s (this swarm has only #main)", 0x5c, 0x64, 0, 1, 0x74, "fmt.errorf"],
  ["core.noSuchChannel", "%w: #%s (channels: #main, #%s)", 0x130, 0x138, 0, 1, 0x148, "fmt.errorf"],
  ["live.(*swarmBoardLiveCommand).Description", "Show the swarm's members and recent message board posts", 0x0, 0x8, 0, 1],
  ["live.(*swarmBoardLiveCommand).Execute", "No swarm in this conversation. Start one with /swarm <task>.", 0x700, 0x708, 1, 2],
  ["live.(*swarmBoardLiveCommand).Execute", "Error reading the swarm board: %v", 0x12c, 0x134, 0, 1, 0x144, "fmt.Sprintf"],
  ["live.boardHint", "board", 0x70, 0x78, 2, 3, 0x7c, "core.KeyHint"],
  ["live.dismissHint", "dismiss", 0x70, 0x78, 2, 3, 0x7c, "core.KeyHint"],
  [board + "(*LiveBoardExec).Run", "swarm board: no program input", 0x184, 0x18c, 3, 4],
  ["tui.filterHint", "filter", 0xa0, 0xa8, 3, 4],
  ["tui.newPostsBadge", "↓ %d new", 0x158, 0x160, 0, 1, 0x170, "fmt.Sprintf"],
  ["tui.messageRows", "Message", 0x19c, 0x1a4, 1, 2, 0x1ac, "tui.sectionHeading"],
  ["tui.messageRows", "✓ done", 0x3a4, 0x3ac, 4, 5],
  ["tui.messageRows", " · zoomed", 0x530, 0x538, 4, 5],
  ["tui.messageRows", " · lines %d–%d of %d", 0x87c, 0x884, 0, 1, 0x894, "fmt.Sprintf"],
  [board + "pane.window", " · rows %d–%d of %d", 0x134, 0x13c, 0, 1, 0x14c, "fmt.Sprintf"],
  ["tui.planNote", " waiting on ", 0x310, 0x318, 3, 4],
  ["tui.planNote", "failed", 0x4b0, 0x4b8, 3, 4],
  ["tui.planNote", "working", 0x764, 0x76c, 3, 4],
  ["tui.planNote", "in review", 0x788, 0x790, 3, 4],
  ["tui.planNote", "done", 0x7cc, 0x7d4, 3, 4],
  ["tui.planNote", "not started", 0x854, 0x85c, 3, 4],
  ["tui.planNote", "moving", 0x8b0, 0x8b8, 3, 4],
  ["tui.planRows", "Overview", 0xc8, 0xd0, 3, 4],
  ["tui.planRows", " · %d of %d tasks done", 0x17c, 0x184, 0, 1, 0x198, "fmt.Sprintf"],
  ["tui.planRows", "%d blocked", 0x2ac, 0x2b4, 0, 1, 0x2c8, "fmt.Sprintf"],
  ["tui.planRows", "    … %d more", 0xbb8, 0xbc0, 0, 1, 0xbd4, "fmt.Sprintf"],
  ["tui.postHeader", "✓ done", 0x3d4, 0x3dc, 4, 5],
  ["tui.rosterHeader", "Roster", 0x130, 0x138, 1, 2, 0x140, "tui.sectionHeading"],
  ["tui.rosterHeader", " · %d members, %d waiting", 0x19c, 0x1a4, 0, 1, 0x1b8, "fmt.Sprintf"],
  ["tui.rosterHeader", "%d failed", 0x2bc, 0x2c4, 0, 1, 0x2d8, "fmt.Sprintf"],
  ["tui.rosterHeader", " · all on ", 0x950, 0x95c, 1, 2, 0x960, "runtime.concatstring2"],
  ["tui.memberRows", "  posted ", 0x5d0, 0x5d8, 1, 2, 0x5e4, "runtime.concatstring2"],
  ["tui.memberDetails", "role", 0x110, 0x118, 8, 11],
  ["tui.memberDetails", "model", 0x134, 0x13c, 8, 11],
  ["tui.memberDetails", "conversation", 0x150, 0x158, 8, 9],
  ["tui.memberDetails", "workspace", 0x174, 0x17c, 8, 9],
  ["tui.memberDetails", "added by", 0x198, 0x1a0, 8, 9],
  ["tui.memberDetails", "last post", 0x2b4, 0x278, 7, 5],
  ["tui.memberDetails", "failure", 0x39c, 0x370, 8, 8],
  ["tui.killedGroupRows", "killed", 0x54, 0x34, 1, 2, 0x5c, "tui.labeledKilledRows"],
  ["tui.rosterStatus", "Member %d/%d: %s (%s)", 0xe0, 0xe8, 0, 1, 0xf8, "fmt.Sprintf"],
  ["tui.rosterStatus", "Member %d/%d: %d killed", 0x16c, 0x174, 0, 1, 0x184, "fmt.Sprintf"],
  ["tui.rosterStatus", "details", 0x108, 0x104, 3, 2],
  ["tui.rosterStatus", "list", 0x18c, 0x188, 3, 2],
  ["tui.rosterStatus", "collapse", 0x220, 0x210, 3, 3],
  ["tui.rosterStatus", "open", 0x30c, 0x304, 5, 5],
  ["tui.cardLayout", "Retired", 0xe40, 0xe48, 1, 2],
  ["tui.cardNote", "posted ", 0x1a0, 0x190, 1, 2, 0x1a8, "runtime.concatstring2"],
  ["tui.age", "%dh ago", 0xd4, 0xdc, 0, 1, 0xec, "fmt.Sprintf"],
  ["tui.age", "%dd ago", 0x128, 0x130, 0, 1, 0x140, "fmt.Sprintf"],
  ["tui.age", "%dm ago", 0x17c, 0x184, 0, 1, 0x194, "fmt.Sprintf"],
  ["tui.age", "just now", 0x1a4, 0x1ac, 0, 1],
  ["tui.view", "  (No posts by or to %s yet · esc to show all)", 0x348, 0x350, 0, 1, 0x364, "fmt.Sprintf"],
  ["tui.view", "  (No posts on the message board yet)", 0x3e8, 0x3f0, 3, 4],
  ["tui.view", "No swarm active. Press 'q' to return.", 0x4ac, 0x4b4, 0, 1],
  ["tui.layout", "Swarm", 0xa4, 0x98, 4, 6],
  ["tui.layout", "⚠ %d %s waiting in the CLI · q to return", 0x6a4, 0x6ac, 0, 1, 0x6c0, "fmt.Sprintf", true],
  ["tui.layout", "Board read failed (showing last snapshot): %v", 0x7d0, 0x7d8, 0, 1, 0x7ec, "fmt.Sprintf"],
  ["tui.layout", "[follow: off]", 0x934, 0x93c, 3, 4],
  ["tui.layout", "[follow: on]", 0x99c, 0x9a4, 3, 4],
  ["tui.layout", "%d %s", 0xa7c, 0xa84, 0, 1, 0xa98, "fmt.Sprintf", true],
  ["tui.layout", "Swarm board", 0xc30, 0xc38, 3, 4],
  ["tui.postsHeader", "Posts", 0x60, 0x68, 1, 2, 0x70, "tui.sectionHeading"],
  ["tui.postsHeader", " · zoomed", 0x9c, 0xa4, 4, 5],
  ["tui.postsHeader", " in ", 0x160, 0x168, 3, 4],
  ["tui.postsHeader", " · latest %d of %d", 0x2dc, 0x2e4, 0, 1, 0x2f8, "fmt.Sprintf"],
  ["tui.postsHeader", " · %d total", 0x398, 0x3a0, 0, 1, 0x3b4, "fmt.Sprintf"],
  ["tui.postsHeader", " · latest %d", 0x454, 0x45c, 0, 1, 0x470, "fmt.Sprintf"],
  ["tui.postsHeader", "by or to ", 0x568, 0x570, 1, 2, 0x574, "runtime.concatstring2"],
  ["tui.postsHeader", " · %d of %d loaded", 0x628, 0x630, 0, 1, 0x644, "fmt.Sprintf"],
  ["tui.postsStatus", "follow", 0x4c, 0x54, 3, 5],
  ["tui.postsStatus", "No posts selected", 0x8c, 0x80, 0, 1],
  ["tui.postsStatus", "collapse", 0xc8, 0xe0, 3, 4],
  ["tui.postsStatus", "expand", 0xd0, 0xe4, 4, 5],
  ["tui.postsStatus", "show message", 0x164, 0x134, 6, 6],
  ["tui.postsStatus", "hide message", 0x1d8, 0x1a8, 6, 6],
  ["tui.postsStatus", "open", 0x338, 0x330, 5, 5],
  ["tui.selectedPostStatus", "Post %d/%d (seq #%d by %s", 0xe0, 0xe8, 0, 1, 0xf8, "fmt.Sprintf"],
  ["tui.selectedPostStatus", " at ", 0x144, 0x14c, 3, 4, 0x174, "runtime.concatstring5"],
  ["tui.messageStatus", "prev/next post", 0x88, 0x90, 1, 2, 0x9c, "tui.filterHint"],
  ["tui.messageStatus", "open", 0x154, 0x14c, 5, 5],
  ["tui.fillHints", "restore", 0xc0, 0xbc, 7, 6],
  ["tui.fillHints", "posts", 0xdc, 0xd8, 7, 6],
  ["tui.fillHints", "show all", 0xf4, 0xf0, 7, 6],
  ["tui.fillHints", "back", 0x104, 0x100, 7, 6],
  ["tui.fillHints", "switch pane", 0x1ec, 0x1e4, 9, 9],
  ["tui.fillHints", "restore", 0x268, 0x25c, 10, 9],
  ["tui.fillHints", "zoom", 0x270, 0x260, 11, 10],
  [model + "PluginsModel.renderExpandedDetailsInstalled", "Description:", 0x148, 0x150, 4, 5, 0x15c, model + "renderDetailFieldBudget"],
  [model + "PluginsModel.renderExpandedDetailsDiscover", "Description:", 0x84, 0x8c, 4, 5, 0xa4, model + "renderDetailFieldBudget"],
];

const boardUsage = 'usage: /swarm board [--channel <name>]';
const rosterPosition = ' · %d of %d';
const groupedLiterals = [
  // A clipped roster shows either one row or a span of visible rows.
  {name:target('tui.rosterPosition'), optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,0,1,rosterPosition,24,namespace],
      [0xf8,0x100,0,1,' · %d–%d of %d',0x110,namespace],
      [0x1d4,0x1dc,0,1,rosterPosition,0x1ec,namespace]]},
  {name:target('tui.rosterHeader'), optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,4,5,' · zoomed',undefined,namespace],[0x11c,0x124,4,5,' · zoomed',undefined,namespace]]},
  {name:target('live.boardChannel'), optional:true,
    resolve(buffer, metadata, profile) {
      const found = relocateStatusLiteralGroup(buffer, metadata, profile);
      return {...found, guards:[[found.literals[1][1] + 4, 0xa9001003]]};
    },
    literals:[[0,8,0,1,boardUsage,undefined,namespace],[0x38,0x40,3,4,boardUsage,undefined,namespace]],
    verifiedCalls:[[0x18,'fmt.errorf']]},
];

export const cliSwarmLiteralProfiles = [...groupedLiterals,...boardLiterals.map(([name, original, ptr, len, pr, lr, offset, consumer, plural]) => {
  const owner = name === 'tui.planNote' ? board + 'boardStyles.planNote' : target(name);
  return {name:owner, optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,len-ptr,pr,lr,original,undefined,namespace]],
    ...(consumer ? {verifiedCalls:[[offset-ptr,target(consumer)]]} : {}),
    ...(plural ? {pluralSuffixes:[original]} : {})};
})];

const stringConversion = 'runtime.stringtoslicerune';
const call = name => ({callee:target(name)});
const stack = (word, mask = 0xffc003ff) => ({mask, value:word & mask});

// Hook only the operands consumed by the native display call. Formatting,
// selection and the original string stored in the session remain native.
function findDisplaySites(buffer, metadata, specifications) {
  const sites = [], unsupported = [];
  for (const {name, words, site, pointer = 0, length = pointer + 1, replayFirst = true, count = 1} of specifications) {
    const fn = metadata.functions.get(name);
    if (!fn) continue;
    const matches = [];
    const size = words.length * 4;
    for (let offset = 0; !metadata.ambiguousFunctions?.has(name) && offset + size <= fn.size; offset += 4) {
      const at = fn.fileOffset + offset;
      const rva = fn.rva + offset;
      if (!words.every((expected, index) => {
        const word = buffer.readUInt32LE(at + index * 4);
        if (typeof expected === 'number') return word === expected;
        if ('mask' in expected) return (word & expected.mask) === expected.value;
        const callee = metadata.functions.get(expected.callee);
        return callee && !metadata.ambiguousFunctions?.has(expected.callee) && word >>> 26 === 0x25 &&
          rva + index * 4 + (word << 6 >> 6) * 4 === callee.rva;
      })) continue;
      const delta = site * 4;
      matches.push({functionName:name, rva:rva+delta, fileOffset:at+delta,
        word:buffer.readUInt32LE(at+delta), pointerRegister:pointer, lengthRegister:length,
        replayFirst, contextFileOffset:at, originalContext:Buffer.from(buffer.subarray(at,at+size))});
    }
    if (matches.length === count) sites.push(...matches);
    else unsupported.push(name);
  }
  return {sites, unsupported};
}

function collectDisplayStrings(buffer, dictionary, metadata, specifications, strings) {
  const {sites,unsupported} = findDisplaySites(buffer,metadata,specifications);
  const values = dictionary.strings ?? dictionary;
  const entries = [], missing = [];
  for (const [original,key] of strings) {
    const translated = values[key];
    if (typeof translated === 'string' && translated) entries.push({original,translated,sourceLength:Buffer.byteLength(original)});
    else if (sites.length) missing.push({original,functionName:specifications[0].name});
  }
  return {imageBase:metadata.imageBase, sites, entries, missing, unsupported, matchContent:true};
}

const formState = [
  {name:board+'boardStyles.state', site:2, pointer:3, count:4,
    words:[0xaa0003e3, 0xaa0103e4, 0xaa1f03e0, stack(0x90000001,0x9f00001f),
      stack(0x91000021), call('runtime.concatstring2')]},
  {name:target('tui.rosterStatus'), site:0,
    words:[0xa94d87e0, call('runtime.convTstring'), stack(0x90000001,0x9f00001f),
      stack(0x91000021), stack(0xa90003e1,0xffc07fff)]},
  {name:target('tui.memberDetails'), site:7, replayFirst:false,
    words:[0xaa1f03e0,0xaa0c03e1,0xaa0d03e2,stack(0x90000003,0x9f00001f),stack(0x91000063),
      0xb27f03e4,call('runtime.concatstring3'),0xaa0103e2,stack(0xf94003e3),0xaa1f03e4,0xaa1f03e5,
      0xaa0003e1,0xb24003e0,call('google3/third_party/golang/github_com/charmbracelet/x/ansi/v/v0/ansi.wrap')]},
  {name:target('core.stateText'), site:0, words:[0xa94987e0,0xf85f83fd,0xf84507fe,0xd65f03c0]},
  {name:target('core.stateText'), site:5, pointer:1,
    words:[0xa9498be3,0xb27f03e4,0xaa0003e5,0xaa0103e6,0xaa1f03e0,0xaa0303e1,
      stack(0x90000003,0x9f00001f),stack(0x91000063),call('runtime.concatstring3')]},
  {name:target('core.PlanStatusOf'), site:5, replayFirst:false,
    words:[0x9a8700a0,0xaa0103e4,stack(0x910003fa),0xd28000a1,0xaa0203e5,
      0xaa0303e2,0xaa0503e3,0xd63f00c0]},
];

export function collectCliSwarmStateDisplayStrings(buffer, dictionary, metadata) {
  const plan = collectDisplayStrings(buffer,dictionary,metadata,formState,
    ['working','waiting','failed','killed','Tasks','Other'].map(text => [text,namespace+text]));
  const values = dictionary.strings ?? dictionary, roleLabel = values[namespace+'role'] || 'role';
  // Include the translated field prefix in each match. A working directory,
  // member name or other user value with the same spelling is not a role row.
  for (const role of ['coordinator','worker','narrator','monitor']) {
    const original = `${roleLabel}: ${role}`;
    const value = values['swarm-ui:'+role];
    if (value) plan.entries.push({original,translated:`${roleLabel}: ${value}`,sourceLength:Buffer.byteLength(original)});
  }
  return plan;
}

const skillDescription = "(Preview & Quota Heavy) Run a swarm: several agents working in parallel on one task, each in its own conversation, collaborating through a shared message board. Use when the work splits into pieces that can be done at the same time, or when a second pair of eyes should check the first pair's work.";
const pluginDescription = 'Unlock the power of agent swarms.';

const commandDescriptions = [
  {name:model+'SuggestionModel.View', site:2,
    words:[0xd63f0020,stack(0x914003fb),stack(0xf9400362),call(model+'truncateToWidth')]},
  {name:model+'HelpModel.renderCommandsTab', site:1, replayFirst:false,
    words:[0xd63f0020,stack(0xf90003e0),stack(0xf90003e1),0xaa0103e2,0xaa0003e1,stack(0x910003e0),call(stringConversion)]},
  {name:model+'SkillsModel.renderSkillLine', site:1, replayFirst:false,
    // Store the translated return before checking the width. The short-text
    // branch reloads this same slot instead of using the converted runes.
    words:[call(model+'getSkillDescription'),stack(0xf90003e0),stack(0xf90003e1),
      stack(0xf94003e0),stack(0xf94003e1),call('google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Width')]},
  {name:model+'SkillsModel.buildDetailLines', site:6, pointer:3,
    words:[0xa9429003,0x14000003,0xaa1f03e4,0xaa1f03e3,stack(0xb4000004,0xff00001f),
      stack(0x910003fb),stack(0x9140037b),0xa9001363,0x910023e3]},
  {name:model+'renderDetailFieldBudget', site:5,
    words:[0xcb010042,0xf1003c5f,0xb2400fe3,0x9a82b062,stack(0xf94003e0),stack(0xf94003e1),
      call(cli+'render/render.WrapAll')]},
];

export function collectCliSwarmDescriptionStrings(buffer, dictionary, metadata) {
  const values = dictionary.strings ?? dictionary;
  const rolePrefixes = ['narrator','monitor','pane'].map(role => `builtin-skill:swarm_${role}:description:`);
  const roleDescriptions = Object.keys(values).flatMap(key => {
    const prefix = rolePrefixes.find(candidate => key.startsWith(candidate));
    return prefix ? [[key.slice(prefix.length),key]] : [];
  });
  return collectDisplayStrings(buffer,dictionary,metadata,commandDescriptions,[
    [skillDescription,'swarm-ui:skill-description:'+skillDescription],
    [pluginDescription,'cli-ui:'+pluginDescription],
    ...roleDescriptions,
  ]);
}

export function collectCliSwarmPluginFieldSlots(buffer, metadata, collectGroup, add) {
  const name = model+'PluginsModel.renderExpandedDetailsInstalled';
  if (!metadata.functions.has(name)) return;
  collectGroup(name, () => {
    // These boxed strings are the Source/Path labels passed to fmt.Sprintf.
    // The separately boxed field value continues to be the original string.
    const {sites,unsupported} = findDisplaySites(buffer,metadata,[{name,site:0,count:2,
      words:[stack(0x90000003,0x9f00001f),stack(0x91000063),stack(0x910003fb),
        stack(0x9140037b),0xa9000f62,call('runtime.convTstring'),
        stack(0x90000002,0x9f00001f),stack(0x91000042),stack(0x910003fb),
        stack(0x9140037b),0xa9000362,stack(0x90000000,0x9f00001f),
        stack(0x91000000),0xb27d03e1,stack(0x914003e2),stack(0x91000042),
        0xb27e03e3,0xaa0303e4,call('fmt.Sprintf')]}]);
    if (unsupported.length) throw new CliCompatibilityError('CLI 插件属性显示布局已变化');
    const found = new Set();
    for (const {rva,fileOffset:p,word} of sites) {
      const address = pageAddress(word,metadata.imageBase+rva)+((buffer.readUInt32LE(p+4)>>>10)&4095);
      const fileOffset = fileOffsetFor(metadata,address,16);
      const sourceLength = Number(buffer.readBigUInt64LE(fileOffset+8));
      const sourceAddress = Number(buffer.readBigUInt64LE(fileOffset));
      if (sourceLength !== 7 && sourceLength !== 5) throw new CliCompatibilityError('CLI 插件属性标签已变化');
      const source = fileOffsetFor(metadata,sourceAddress,sourceLength);
      const original = buffer.toString('utf8',source,source+sourceLength);
      if (!['Source:','Path:'].includes(original)||found.has(original)) throw new CliCompatibilityError('CLI 插件属性标签已变化');
      found.add(original);
      add({kind:'slot',functionName:name,fileOffset,sourceAddress,sourceLength,original,
        contextFileOffset:fileOffset,originalContext:Buffer.from(buffer.subarray(fileOffset,fileOffset+16))},namespace);
    }
  });
}
