import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';
import { pageAddress, stringLengthImmediate } from './cli-localization.mjs';

const render = 'google3/third_party/jetski/cli/render/render.';
const tools = 'google3/third_party/oneharness/internal/tools/tools.';
const schedule = tools + '(*ScheduleTool).';
const timerInfo = tools + 'timerRenderInfo', cronInfo = tools + 'cronRenderInfo';

const hint = (text, register, callee, minimum = 1) => ({
  text, register, minimum, calls:[[12, render + callee]],
});
const format = (text, consumer) => ({
  text, register:0, calls:consumer ? [[24, 'fmt.Sprintf'], [40, consumer]] : [[24, 'fmt.Sprintf']],
});
const timerLabel = text => ({text, register:1, calls:[[12, timerInfo]]});
const expand = hint('ctrl+o to expand', 1, 'appendHintToLastLine');
const collapseLast = hint('ctrl+o to collapse', 1, 'appendHintToLastLine');

export const toolStatusProfiles = [
  {name:render + 'CollapsedSummaryToolGroup', references:[expand]},
  {name:render + 'renderCommandOutput', references:[expand, collapseLast]},
  {name:render + 'CollapsedToolGroup', references:[{...expand, minimum:2}]},
  {name:render + 'CollapsedLowVerbosityGroup', references:[
    // The first value is the fallback string of a branch. The second is
    // materialized as a Go string for the rendered prompt line.
    {text:'Thinking', register:1, lengthDelta:-4, guards:[[-8,0x14000004]]},
    {text:'Thinking...', register:2, guards:[[12,0x910003fb,0xffc003ff],[16,0x9140037b,0xffc003ff],
      [20,0xa9000f62,0xffc07fff]]},
    expand,
  ]},
  {name:render + 'expandedToolGroup', references:[
    hint('ctrl+o to collapse', 5, 'addHint', 2), collapseLast,
  ]},
  {name:schedule + 'startTimer', references:[timerLabel('Cancelled (task already finished)'),
    timerLabel('Cancelled (pre-existing undelivered messages)'), timerLabel('Pending'), format('%s timer')]},
  {name:schedule + 'continueTimer', references:[
    format('Cancelled (early-termination condition met by a message from %s)', timerInfo),
    // X2 also supplies the byte length of a different field. Existing status
    // validation requires its translation to retain the same UTF-8 byte length.
    {text:'Cancelled', register:1, lengthDelta:-12, sharedLength:true, calls:[[8,timerInfo]],
      guards:[[-8,0xa9018800,0xffffffe0],[-4,0xf94003e0,0xffc003ff]]},
  ]},
  {name:schedule + 'continueCron', references:[
    format('Completed (%d iterations)', cronInfo), format('Active (Triggered %d times)', cronInfo),
    format('Cancelled after %d iterations', cronInfo),
  ]},
].map(profile => ({...profile, resolve:resolveToolStatusProfile}));

const model = 'google3/third_party/jetski/cli/model/model.';
const styleRender = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render';
const statusLine = model + 'StatusLineModel.';
const prompt = model + 'PromptModel.View';
const conversation = model + '(*ConversationModel).';
const transcriptBar = conversation + 'renderTranscriptBar';
const manager = 'google3/third_party/jetski/cli/store/store.(*Manager).';
const scroll = model + 'scrollIndicatorText';
const copyStatus = model + 'copyStatusMessage';
const turnSummary = model + 'formatTurnSummary';
const untrackedEntry = model + 'untrackedEntry';

function renderLiteral(name, text, register, consumer, delta, length = 8, lengthRegister = register + 1) {
  return {name, optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,length,register,lengthRegister,text]],
    verifiedCalls:consumer ? [[delta,consumer]] : []};
}

// Both PromptModel branches display the same four Vim labels. The compiler
// chooses a different register pair in different CLI releases.
function vimIndicators(buffer, metadata, profile) {
  const fn = metadata.functions.get(profile.name);
  const registers = new Set();
  for (let offset = 4; fn && offset + 8 <= fn.size; offset += 4) {
    const page = buffer.readUInt32LE(fn.fileOffset + offset), register = page & 31;
    if ((page & 0x9f000000) >>> 0 === 0x90000000 && register > 0 &&
        stringLengthImmediate(buffer.readUInt32LE(fn.fileOffset + offset - 4),register - 1) === 6) {
      registers.add(register);
    }
  }
  const literals = [];
  for (const pr of registers) {
    const group = [[0,'INSERT'],[0x18,'VISUAL'],[0x30,'VISUAL LINE'],[0x40,'NORMAL']];
    try {
      const match = relocateStatusLiteralGroup(buffer, metadata, {...profile,
        literals:group.map(([at,text]) => [at,at-4,pr,pr-1,text])});
      literals.push(...match.literals);
    } catch (error) {
      if (!(error instanceof CliCompatibilityError)) throw error;
    }
  }
  if (literals.length !== 8) throw new CliCompatibilityError('CLI 输入框的 Vim 模式标签已变化');
  return {...profile,literals};
}

// These functions build text for the transcript, detail view or status line.
// Bind each format to its Sprintf call and each short caption to its display
// consumer. Shell output, file contents and command identifiers stay intact.
export const transcriptStatusProfiles = [
  // The full screen scroll indicator chooses singular/plural before boxing
  // each noun. The icon and count still feed the native width calculation.
  {name:scroll, optional:true, resolve:relocateStatusLiteralGroup,
    guards:[[0xb0,0x9a830040],[0x15c,0x9a830040]],
    verifiedCalls:[[0xb4,'runtime.convTstring'],[0x160,'runtime.convTstring']],
    literals:[
      [0xa0,0x94,2,1,'line',undefined,'cli-scroll:'],
      [0xa8,0x98,3,2,'lines',undefined,'cli-scroll:'],
      [0xc4,0xcc,0,1,'%s %d %s',0xdc,'cli-scroll:'],
      [0x14c,0x140,2,2,'turn',undefined,'cli-scroll:'],
      [0x154,0x144,3,3,'turns',undefined,'cli-scroll:'],
      [0x170,0x178,0,1,'%s · %d %s',0x188,'cli-scroll:'],
    ]},
  {name:copyStatus, optional:true, resolve:relocateStatusLiteralGroup,
    guards:[[0xb0,0x9a8700c6]],
    verifiedCalls:[[0xf8,'runtime.convTstring'],[0x154,'runtime.convTstring']],
    literals:[
      [0xa0,0x90,6,5,'character',undefined,'cli-copy:'],
      [0xa8,0x94,7,6,'characters',undefined,'cli-copy:'],
      [0x108,0x110,0,1,'Copied %d lines (%d %s)',0x120,'cli-copy:'],
      [0x164,0x16c,0,1,'Copied %d %s',0x17c,'cli-copy:'],
    ]},
  {name:model + 'agentInitTask', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[
      [0x90,0x98,0,1,'Initializing agent: %s...',0xa8],
      [0xb4,0xb0,0,1,'Initializing agent...'],
      [0xc4,0xc0,0,1,'Initializing agent...'],
    ]},
  {name:turnSummary, optional:true, resolve:relocateStatusLiteralGroup,
    guards:[[0x1c4,0x9a830040]],
    verifiedCalls:[[0x1c8,'runtime.convTstring']],
    literals:[
      [0x1b4,0x1a8,2,1,'file',undefined,'cli-turn-summary:'],
      [0x1bc,0x1ac,3,2,'files',undefined,'cli-turn-summary:'],
      [0x214,0x21c,0,1,'%d %s changed %s %s',0x22c,'cli-turn-summary:'],
    ]},
  {name:turnSummary, optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0x2c0,0x2a0,6,6,'1 artifact generated'],[0x300,0x308,0,1,'%d artifacts generated',0x318]]},
  renderLiteral(untrackedEntry,'binary file',3),
  {name:untrackedEntry, formats:['%.1f MB, over the %d MB limit'], optional:true},
  // The result line is written to the transcript before the independent approval decision is committed.
  renderLiteral(manager + 'userInputLoop','User declined the tool call',2,manager + 'addCommandOutputWith',24),
  renderLiteral(manager + 'userInputLoop','Setting up your account...',1,manager + 'addAlert',32),
  renderLiteral(manager + 'userInputLoop','Your account is still under provisioning.\nThis usually takes about 30 seconds. Please try again later.',3,manager + 'addAlert',20),
  renderLiteral(manager + 'userInputLoop','Eligibility Check',1,manager + 'addAlert',8,-24),
  ...[
    [render + 'renderMarkdownUncached', '> **Diagram exceeds terminal width (%d > %d cols)**'],
    [prompt,'↑ %d more lines','↓ %d more lines'],
    [render + 'renderCarouselSlides', '**Slide %d of %d**'],
    [render + 'RenderRecitations', 'Source %d'],
    [render + 'BannerWithInfo', 'GCP Project: %s'],
    [render + 'lowVerbosityTokensLine', '%s in | %s out | %s thinking'],
    [render + 'renderCommandOutput', '<output +%d lines>'],
    [render + 'RenderBackgroundCommandOutput', 'completed (exit %d)'],
    [render + 'toolDetail', 'Read %d lines'],
    [render + 'fileStepDetail', 'Read %d lines'],
    [render + 'formatCommandOutputDetail', '<output +%d lines>\n       %s'],
    [render + 'editDiffDetail', '%*s    … and %d more lines'],
    [render + 'replacePluginCards.func1.1.1', '⚠ The %s plugin needs you to sign in. Open /plugin to sign in.'],
    [statusLine + 'renderRight', 'AI: %d (/credits to add more)', 'AI Credits: %d'],
    [statusLine + 'renderHint', 'activated code search mode · tab/enter to see all results · %s to cancel',
      ' activated bash mode · %s to cancel', '  Press %s to edit queued messages',
      'press %s again to send command to background'],
  ].map(([name,...formats]) => ({name,formats,optional:true})),
  {name:render + 'stepContent', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,0,1,'  (%s, %s tokens)',28]]},
  ...[
    ['AltScreenHint', '⚠ alt screen unavailable — run ssh -t', 0],
    ['AltScreenHint', 'unknown', 3, 'runtime.convTstring',12,-8],
    ['AutoApproveHint', 'to auto-approve file edits',3,render + 'NewKeyHint',12],
    ['renderMarkdownUncached', '> Displayed as code block. Widen terminal to view inline.',1],
    ['RenderRecitations','  Sources:',3,styleRender,80],
    ['ExpandedSummaryToolGroup','ctrl+o to collapse',1,render + 'appendHintToLastLine',12],
    ['stepContent','Error ID: ',1,'runtime.concatstring2',12],
    ['stepContent','Agent(',1,'runtime.concatstring3',8,-28],
    ['stepContent','(skipped)',3],
    ['renderAskQuestionEntries','(skipped)',3,styleRender,76],
    ['renderCommandOutput',' (run in background)',3,styleRender,88],
    ['toolDetail','Error: ',1,'runtime.concatstring2',12],
    ['toolDetail','Reason: ',1,'runtime.concatstring2',12],
    ['editStatsDetail',' lines',7,'runtime.concatstring4',20],
    ['RenderWorkflowDone','(ctrl+o to expand)',3,styleRender,88],
    ['RenderWorkflowDone','(ctrl+o to collapse)',3,styleRender,88],
    ['RenderWorkflowDone','ctrl+o to collapse',1,render + 'appendHintToLastLine',12],
    ['RenderTaskItem','running',6,undefined,undefined,-4,5],
    ['RenderTaskItem','cancelled',6,undefined,undefined,-4,5],
    ['RenderTaskItem','failed',1,'runtime.concatstring2',20],
    ['RenderTaskItem','completed',1,'runtime.concatstring2',20],
  ].map(([owner,...args]) => renderLiteral(render + owner,...args)),
  {name:render + 'RenderTaskItem', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,0,1,' (exit %d)',28],[0xb8,0xc0,0,1,' (exit %d)',0xd4]]},
  ...['-- INSERT --','-- VISUAL --','-- V-LINE --'].map(text =>
    renderLiteral(statusLine + 'RenderBuiltIn',text,3,styleRender,88)),
  renderLiteral(model + 'TaskDetailModel.buildTaskDetailLines','Task Details',2),
  renderLiteral(model + 'TaskDetailModel.buildTaskDetailLines','Output',3),
  renderLiteral(statusLine + 'renderRight','AI: Out of credits',0,undefined,undefined,-4),
  renderLiteral(model + '(*InputModel).View','Bug report not available in external builds.\n',2),
  renderLiteral(prompt,'Initializing agent...',5,'runtime.concatstring3',16),
  ...['Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
    'Plan mode: research & plan only (shift+tab to cycle)',
    'Best-of-N mode: fork into parallel arms and pick a winner (shift+tab to cycle)',
    'Accept-edits mode: file edits auto-approved (shift+tab to cycle)'].map(text =>
    renderLiteral(prompt,text,1,undefined,undefined,-4,0)),
  {name:prompt, optional:true, resolve:vimIndicators, literals:[]},
  renderLiteral(conversation + 'highlightItemCollapseHints','ctrl+o to collapse',2,model + 'hintCols',12),
  renderLiteral(conversation + 'transcriptSearchHints','confirm',4),
  renderLiteral(conversation + 'transcriptSearchHints','cancel',4,render + 'NavHints',36),
  renderLiteral(transcriptBar,'  Search:',3), renderLiteral(transcriptBar,'transcript',3),
  renderLiteral(transcriptBar,'prev/next prompt',7), renderLiteral(transcriptBar,'search',7),
  renderLiteral(transcriptBar,'prompts',6,undefined,undefined,-8,6),
  renderLiteral(transcriptBar,'clear search',5,undefined,undefined,24,6),
  renderLiteral(transcriptBar,'close',6,undefined,undefined,20,7),
  renderLiteral(transcriptBar,' again to search in the conversation',5,'runtime.concatstring3',24),
  renderLiteral(transcriptBar,'  press ',1,'runtime.concatstring3',8,-28),

];

// The formatter receives a number and an already pluralized English noun.
// Consume the unused noun in the localized format, keeping the native count.
function resolveDisplayCounts(buffer, metadata, profile) {
  // Several sites take the same "%d %s" format. Validate the source noun
  // attached to each site before assigning a Chinese unit to that count.
  const located = relocateStatusLiteralGroup(buffer,metadata,{...profile,literals:[
    ...profile.literals,...profile.sourceNouns.map(([pointer,text]) => [pointer,pointer + 8,3,4,text]),
  ]});
  return {...located,literals:located.literals.slice(0,profile.literals.length)};
}

const count = (pointer, call, namespace) =>
  [pointer,pointer + 8,0,1,'%d %s',call,'cli-' + namespace + '-count:'];
transcriptStatusProfiles.push(
  {name:render + 'toolDetail', optional:true, resolve:resolveDisplayCounts, pluralSuffixes:['%d %s'],
    sourceNouns:[[0x1a0,'match'],[0x70c,'result'],[0x958,'file'],[0xa08,'directory'],[0xb0c,'result']],
    literals:[
      count(0x1f8,0x214,'match'), [0x228,0x218,1,2,'Found '],
      count(0x764,0x780,'result'), [0x794,0x784,1,2,'Found '],
      count(0x9b4,0x9d0,'file'), count(0xa64,0xa80,'directory'),
      count(0xb68,0xb84,'result'), [0xb98,0xb88,1,2,'Found '],
    ]},
  {name:render + 'editStatsDetail', optional:true, resolve:resolveDisplayCounts, pluralSuffixes:['%d %s'],
    sourceNouns:[[0x5c,'line'],[0x108,'line'],[0x1b4,'line']],
    literals:[
      count(0xa8,0xc0,'line'), [0xd4,0xc4,1,2,'Wrote '],
      count(0x154,0x16c,'line'), [0x180,0x170,1,2,'Added '],
      count(0x204,0x21c,'line'), [0x230,0x220,1,2,'Removed '],
    ]},
  {name:render + 'RenderWorkflowTree', optional:true, resolve:resolveDisplayCounts, pluralSuffixes:['%d %s'],
    sourceNouns:[[0x5a8,'more agent'],[0xc64,'more agent'],[0xfb4,'more agent']],
    literals:[count(0x604,0x620,'more-agents'),count(0xcc0,0xcdc,'more-agents'),count(0x1010,0x102c,'more-agents')]},
);

/** Find the function's UI arguments together with their original consumers. */
function resolveToolStatusProfile(buffer, metadata, profile) {
  const fn = metadata.functions.get(profile.name);
  if (!fn || metadata.ambiguousFunctions?.has(fn.name)) throw new CliCompatibilityError(`CLI 工具显示入口已变化：${profile.name}`);
  const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
  const literals = [], verifiedCalls = [], sharedLengths = [];
  for (const {text, register, guards = [], calls = [], minimum = 1, lengthDelta = 8, sharedLength} of profile.references) {
    const expected = Buffer.from(text), targets = calls.map(([delta,name]) => {
      const callee = metadata.functions.get(name);
      if (!callee || metadata.ambiguousFunctions?.has(name)) throw new CliCompatibilityError(`CLI 工具显示调用已变化：${name}`);
      return {delta, name, address:metadata.imageBase + callee.rva};
    });
    const first = -Math.min(0, lengthDelta, ...guards.map(([delta]) => delta));
    const last = fn.size - Math.max(8, lengthDelta + 4, ...guards.map(([delta]) => delta + 4), ...calls.map(([delta]) => delta + 4));
    let count = 0;
    for (let pointer = first; pointer <= last; pointer += 4) {
      const adrp = word(pointer), add = word(pointer + 4), length = pointer + lengthDelta;
      if (((adrp & 0x9f00001f) >>> 0) !== ((0x90000000 | register) >>> 0) ||
          ((add & 0xffc003ff) >>> 0) !== ((0x91000000 | (register << 5) | register) >>> 0) ||
          stringLengthImmediate(word(length), register + 1) !== expected.length) continue;
      const pc = metadata.imageBase + fn.rva + pointer;
      if (targets.some(({delta,address}) => {
        const call = word(pointer + delta);
        return ((call & 0xfc000000) >>> 0) !== 0x94000000 || pc + delta + ((call << 6) >> 4) !== address;
      }) || guards.some(([delta,value,mask = 0xffffffff]) => ((word(pointer + delta) & mask) >>> 0) !== value)) continue;
      const address = pageAddress(adrp, pc) + ((add >>> 10) & 0xfff);
      const segment = metadata.segments.find(s => address >= s.address && address + expected.length <= s.address + s.fileSize);
      if (!segment) continue;
      const start = segment.fileOffset + address - segment.address;
      if (!buffer.subarray(start,start + expected.length).equals(expected)) continue;
      const formatSite = targets.find(call => call.name === 'fmt.Sprintf');
      literals.push([pointer,length,register,register + 1,text,formatSite && pointer + formatSite.delta]);
      for (const {delta,name} of targets) verifiedCalls.push([pointer + delta,name]);
      if (sharedLength) sharedLengths.push(length);
      count++;
    }
    if (count < minimum || (!calls.length && count !== 1)) {
      throw new CliCompatibilityError(`CLI 工具显示文案引用已变化：${fn.name} · ${text}`);
    }
  }
  return {name:fn.name,literals,verifiedCalls,sharedLengths};
}

// The tool card's fallback title also feeds the collapsed action summary.
// cleanGenericToolName uppercases the first byte of each word; return the
// two already-formatted titles before that path splits their UTF-8 bytes.
export function collectCliPlanModeToolLabels(buffer, dictionary, metadata) {
  const namespace = 'google3/third_party/jetski/cortex/core/planexecute/planexecute.';
  const tools = [
    ['enter_plan_mode',namespace + '(*enterTool).Name'],
    ['exit_plan_mode',namespace + '(*exitTool).Name'],
  ].filter(([,name]) => metadata.functions.has(name));
  if (!tools.length) return {imageBase:metadata.imageBase, entries:[], sites:[]};

  const name = render + 'toolStepInfo', calleeName = render + 'cleanGenericToolName';
  const fn = metadata.functions.get(name), callee = metadata.functions.get(calleeName);
  let ownerCalls = 0;
  if (fn && callee && !metadata.ambiguousFunctions?.has(name) && !metadata.ambiguousFunctions?.has(calleeName)) {
    for (let offset = 0; offset + 12 <= fn.size; offset += 4) {
      const fileOffset = fn.fileOffset + offset, rva = fn.rva + offset;
      const word = buffer.readUInt32LE(fileOffset), call = buffer.readUInt32LE(fileOffset + 4);
      const after = buffer.readUInt32LE(fileOffset + 8);
      if (word !== 0xa9418420 || call >>> 26 !== 0x25 ||
          rva + 4 + ((call << 6) >> 4) !== callee.rva || after >>> 26 !== 5) continue;
      ownerCalls++;
    }
  }
  // LDR X16,[X28,#16]; CMP SP,X16; B.LS stack growth. The Go frame
  // has not been created, and X30 still holds the tool card's return address.
  const originalContext = callee && Buffer.from(buffer.subarray(callee.fileOffset,callee.fileOffset + 12));
  if (ownerCalls !== 1 || originalContext.readUInt32LE(0) !== 0xf9400b90 ||
      originalContext.readUInt32LE(4) !== 0xeb3063ff ||
      ((originalContext.readUInt32LE(8) & 0xff00001f) >>> 0) !== 0x54000009) {
    throw new CliCompatibilityError('CLI 规划模式工具标签显示入口已变化');
  }
  const sites = [{functionName:calleeName, rva:callee.rva, fileOffset:callee.fileOffset,
    word:0xf9400b90, pointerRegister:0, lengthRegister:1, returnOnMatch:true,
    contextFileOffset:callee.fileOffset, originalContext}];

  const strings = dictionary.strings ?? dictionary, entries = [], missing = [];
  for (const [original] of tools) {
    const translated = strings['cli-plan-tool:' + original];
    if (typeof translated !== 'string' || !translated) missing.push({original, functionName:name});
    else entries.push({original, translated, sourceLength:Buffer.byteLength(original)});
  }
  return {imageBase:metadata.imageBase, entries, sites, missing, matchContent:true};
}
