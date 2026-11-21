import { flagUsageLiterals } from './cli-flag-usage.mjs';
import { cliProjectPanelLiteralProfiles } from './cli-project-panel-literals.mjs';
import { cliConfirmationLiteralProfiles, collectCliConfirmationCopy } from './cli-confirmation-literals.mjs';
import { cliArtifactPanelLiteralProfiles } from './cli-artifact-panel-literals.mjs';
import { cliPluginPanelLiteralProfiles } from './cli-plugin-panel-literals.mjs';
import { cliDiffHooksLiteralProfiles } from './cli-diff-hooks-literals.mjs';
import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';
import { fileOffsetFor, pageAddress } from './cli-localization.mjs';

const cli = 'google3/third_party/jetski/cli/';
const model = cli + 'model/model.';
const statusline = cli + 'commands/commands.(*statuslineCommand).';
const commandOutput = cli + 'store/store.(*Manager).AddCommandOutput';

// Each expression is located independently by its source text, registers and
// (when present) formatting/output call. Changing one tab leaves the others usable.
function literal(name, text, pointer, { namespace, format, consumer } = {}) {
  return {name, optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0, 8, pointer, pointer + 1, text, format, namespace]],
    verifiedCalls:consumer ? [[12, consumer]] : []};
}

const scopeLabel = model + 'PermissionsModel.scopeLabel';
const scopeDescription = model + 'PermissionsModel.scopeDescription';
const scopePicker = model + 'PermissionsModel.viewScopePicker';
const panel = 'cli-panel:';
const style = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.';
const audioBanner = model + 'AudioModel.Banner';
export const cliPanelLiteralProfiles = [
  ...flagUsageLiterals,
  // Only the TTY heading uses this string. The headless writer keeps agent
  // IDs and their structured representations in separate fields.
  {name:cli + 'entrypoints/entrypoints.runListAgents', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,3,4,'Available agents:',undefined,'cli-command:agents:']],
    verifiedCalls:[[0x74,cli + 'headless/headless.Write']]},
  ...cliDiffHooksLiteralProfiles,
  ...cliProjectPanelLiteralProfiles,
  ...cliPluginPanelLiteralProfiles,
  ...cliConfirmationLiteralProfiles,
  ...cliArtifactPanelLiteralProfiles,
  // The input panel copies its own diagnostics and operator hints into the
  // rendered prompt. Leave editor paths, slash commands and key bindings intact.
  ...[
    ['PromptModel.Update', 'Editor exited with error: %v', 28],
    ['PromptModel.Update', 'Fallback editor %q failed: %v. Set $EDITOR or configure in /settings.', 28],
    ['PromptModel.Update', 'Editor %q failed: %v', 28],
    ['PromptModel.Update', 'Failed to read editor file: %v', 28],
    ['PromptModel.Update', 'Paste failed: %v', 28],
    ['PromptModel.handleInputWithOptions', 'Enter a message to send to @%s', 28],
    ['PromptModel.handleOpenEditor', 'Failed to create temporary file: %v', 28],
    ['PromptModel.handleOpenEditor', 'Failed to write to temporary file: %v', 28],
    ['AtSuggestionModel.View.func2', 'Fetching matches for %q...', 24],
    ['AudioModel.handleConnected', 'Failed to start recording: %v', 24],
    ['AudioModel.handleConnected', 'Could not start transcription: %v', 24],
    ['GcpSetupModel.Update', 'License fetch failed: %v', 28],
  ].map(([method, text, format]) => literal(model + method, text, 0, {format})),
  ...[
    ['Migration failed: %v', 0x30],
    ['Migrated %d extensions!', 0x38],
  ].map(([text, status]) => ({name:model+'(*RootModel).update', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,0,1,text,24]], verifiedCalls:[[status,cli+'store/store.(*Manager).SetMigrationProgress']]})),
  ...[
    ['PromptModel.handleInputWithOptions', [[0,8,1,2,'Unknown command: /']], [[20,'runtime.concatstring2']]],
    ['PromptModel.queuedSendNowHint', [[0,8,5,6,' to send immediately)']], [[24,'runtime.concatstring3']]],
    ['PromptModel.Update', [[0,-60,0,3,'No image or video found in the clipboard']], [[-12,'runtime.wbMove']]],
    ['PromptModel.handlePasteMedia', [[0,8,1,2,"Can't read your clipboard over SSH: connect with ssh -X (and install xclip on this host) to paste images"]]],
    ['AudioModel.StartRecording', [[0,8,2,3,'No microphone found. Check System Settings > Sound > Input and make sure a capture device is connected and enabled.']]],
    ['AudioModel.noteSilence', [[0,8,16,17,'No audio is being picked up. Check that your terminal app has microphone access: a blocked microphone can record silence rather than failing.']]],
    ['GcpSetupModel.Update', [[0,-0x28,2,11,'No licenses found. Please enter project ID manually.']],
      [[0x84,model+'GcpSetupModel.transitionToManualProjectID']]],
    ...['Global skills','Shared skills'].map(text => ['SkillsModel.groupSkills', [[0,8,2,3,text]], [[44,'runtime.concatstring2']]]),
  ].map(([method, literals, verifiedCalls]) => ({name:model+method, optional:true, resolve:relocateStatusLiteralGroup,
    literals, verifiedCalls})),
  // The banner concatenates already-resolved keys with different copy while
  // recording and when a partial transcript can be inserted.
  ...[
    {literals:[[-0x30,-0x28,3,4,' or ',undefined,panel],[0,8,3,4,' to ',undefined,panel],
      [12,20,5,6,'insert',undefined,panel],[24,32,7,8,' · esc to discard',undefined,panel]],
      verifiedCalls:[[-0x14,'runtime.concatstring3'],[36,'runtime.concatstring4']]},
    {literals:[[0,8,3,4,' Recording ',undefined,panel]], verifiedCalls:[[60,'runtime.concatstring5']]},
    {literals:[[-0x24,-0x1c,3,4,' or ',undefined,panel],[0,8,3,4,' to ',undefined,panel],
      [12,20,5,6,'insert what you have',undefined,panel],[24,32,7,8,' · esc to discard',undefined,panel]],
      verifiedCalls:[[-8,'runtime.concatstring3'],[44,'runtime.concatstring4']]},
    {literals:[[0,8,3,4,'esc to cancel',undefined,panel]], verifiedCalls:[[88,style+'Style.Render']]},
    ...['  Finishing up... ','  Connecting... '].map(text => ({
      literals:[[0,-16,1,2,text,undefined,panel]], verifiedCalls:[[8,'runtime.concatstring2']]})),
  ].map(profile => ({name:audioBanner, optional:true, resolve:relocateStatusLiteralGroup, ...profile})),
  // Capture native format strings before Go inserts filenames, key bindings or counts.
  ...[
    ["executionStatusLabel", " (attempt %d/%d)", "%s, retrying in %ds"],
    ["ConversationPickerModel.renderOverflowRow", "⋯ %d more %s", "⋯ %d more in %s"],
    ["ConversationPickerModel.renderRowIndented", " [Delete? (%s/%s)]", " [Import this conversation? (%s/%s)]"],
    ["ConversationPickerModel.renderAbandonBattleConfirmation", "\n  You have an active battle session.\n  Switching to %q will abandon it.\n\n  Proceed? (%s/%s)"],
    ["FeedbackModel.View", "✔ Thanks for improving %s!"],
    ["formatLicenseLabel", "%s (Project: %s, Location: %s)"],
    ["ProjectsModel.switchPrompt", "[Switch? Starts a new conversation (%s/%s)]"],
    ["PromptModel.View", "  %s 📎 1 media attached (%s, %s, %s)  (%s)", "  %s 📎 %d media attached  (%s)", "  %s 📎 %d Media(s) attached"],
    ["(*InputModel).update", "Transcription failed: %v"],
    ["startProjectConversationCmd.func1", "Error starting a conversation in %s: %v", "Started a new conversation in %s."],
    ["PromptModel.Update.func3", "Closed %s"],
    ["ActiveItemsModel.View", "  ↑ %d more", "  ↓ %d more"],
    ["SettingsErrorModel.confirmBody", "Could not overwrite the file: %s"],
    ["SkillsModel.RenderHeader", "%d skills"],
    ["(*ToolConfirmationModel).escDisabledHint", "Esc disabled during file edits — press %d to accept or %d to reject."],
    ["(*ToolConfirmationModel).createFilePreview", "New file: %s"],
    ["(*ToolConfirmationModel).writeFileEditPreview", "Edit: %s"],
    ["(*ConversationModel).renderTranscriptBar", " · (%d–%d of %d lines)"],
    ["(*ConversationModel).handleEscCancelBattle.func1", "Use %s to cancel the battle session"],
    ["EffortSelectorModel.selectEffort.func2", "Effort set to %s"],
    ["GcpSetupModel.applyLicenseSelection.func1", "Could not select license for project %s: %v"],
  ].map(([method, ...formats]) => ({name:model + method, optional:true, formats})),
  // Exact labels assembled by panel views and their local status producers.
  ...[
    ["executionStatusLabel", ", retrying", 3],
    ["(*InputModel).update", "No speech detected", 2],
    ["SettingsErrorModel.confirmBody", "Cancel", 12],
    ["BugReportModel.View", "Bug report not available in external builds.\n", 0],
    ["ChangelogModel.View", "Loading changelog...", 0],
    ["buildDualGroupedList", "Groups", 3],
    ["ConversationPickerModel.View", "  Type to search conversations...  (type title:<query> to filter by title)", 0],
    ["ConversationPickerModel.renderOverflowRow", " — enter to show", 3],
    ["cloudProjectLabel", " (not created yet)", 3],
    ["PermissionsModel.updateScopePicker", "No active project. Cannot edit project permissions.", 1],
    ["ProjectsModel.Update", "Saved ", 1],
    ["ProjectsModel.Update", "Created ", 1],
    ["ProjectsModel.handleProjectsListKey", "Switching to ", 1],
    ["ProjectsModel.handleInputKey", "Paste a Google Docs, Sheets, Slides or Drive link.", 1],
    ["SettingsErrorModel.errorBody", "Exit and fix manually", 12],
    ["SettingsErrorModel.errorBody", "Continue with defaults this session", 12],
    ["SettingsErrorModel.errorBody", "Overwrite the file with defaults", 12],
    ["SettingsErrorModel.confirmBody", "Overwrite", 12],
    ["(*ToolConfirmationModel).ExpandedView", "scroll Full Command", 4],
    ["(*BugReportModel).View", "Bug report not available in external builds.\n", 0],
  ].map(([method, text, register]) => literal(model + method, text, register)),
  {name:model+'executionStatusLabel', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0xb0,0xac,0,1,'Model unavailable'],[0x120,0x110,1,2,'Model unavailable'],
      [0x138,0x134,0,1,'Model unavailable']], verifiedCalls:[[0x128,'runtime.concatstring2']]},
  // Settings recovery preserves the wrapped parser error, including its byte
  // or field details. Go can build the wrapper through either format path.
  ...[
    ['validateCliSettings', 'settings file is malformed: %w'],
    ['parseDiskSettings', 'settings file is malformed: %w'],
    ['validateCliSettings', 'invalid settings: %s'],
  ].map(([method, text]) => ({
    name:cli+'store/store.(*Manager).'+method, optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,0,1,text],[0x38,0x40,3,4,text]], verifiedCalls:[[24,'fmt.errorf']],
  })),
  literal(cli+'store/store.(*Manager).ResetSettingsToDefaults', 'backend cannot save a copy of the settings file', 3),
  // The conversation list formats a count with its own singular/plural label.
  {name:model+'ConversationPickerModel.renderOverflowRow', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,-12,4,3,'workspaces'],[8,-8,5,4,'workspace'],[32,52,5,5,'group'],[40,56,6,6,'groups']]},
  // The builder has already reserved this byte count before copying the text.
  ...[
    ['UsageModel.renderPlanSection', '  Upgrade to get 1,500 model requests per day with Gemini CLI and\n'],
    ['UsageModel.renderCreditsSection', "  Use your AI credits to fulfill model requests once you're out of quota.\n\n"],
  ].map(([method, original]) => ({
    ...literal(model + method, original, 1),
    resolve(buffer, metadata, profile, dictionary) {
      const strings = dictionary?.strings ?? dictionary;
      const translated = strings?.['cli-ui:' + original] ?? strings?.[original];
      if (typeof translated === 'string' && translated && Buffer.byteLength(translated) !== Buffer.byteLength(original)) {
        throw new CliCompatibilityError('CLI 套餐说明使用固定字节数复制');
      }
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      return {...located, sharedLengths:[located.literals[0][1]]};
    },
  })),
  // These scope helpers are used by the title, scope picker and tab bar.
  // The saved permission scope is an independent enum.
  ...['Project', 'Global', 'Shared', 'Unknown'].map(text => literal(scopeLabel, text, 0, {namespace:panel})),
  literal(scopeLabel, 'Global remote settings', 0),
  literal(scopeLabel, 'Shared with %s', 0, {format:24}),
  literal(scopeDescription, 'Rules that apply only to this project (highest priority)', 0),
  literal(scopeDescription, 'Global rules', 0),
  literal(scopeDescription, 'Rules that apply to all %s products', 0, {format:24}),
  literal(scopeDescription, 'Rules that apply to all products', 0),
  literal(scopePicker, 'Select a config scope to edit:', 3),
  literal(scopePicker, ' (disabled: no active project)', 3),
  literal(model + 'PermissionsModel.renderTabBar', 'Permissions — %s', 0, {format:28}),
  literal(model + 'PermissionsModel.renderTabBar', '  (%s/%s to switch)', 0, {format:28}),
  literal(model + 'PermissionsModel.viewRuleViewer', 'No %s rules.', 0, {format:28}),
  literal(model + 'PermissionsModel.RenderHeader', '%s Rule — %s — %s', 0, {format:28}),
  literal(model + 'PermissionsModel.viewAddRule', 'Enter a permission rule:', 3),
  literal(model + 'PermissionsModel.viewAddRule', 'Format: action(target)', 3),
  {name:model + 'PermissionsModel.RenderHeader', optional:true, verifiedCalls:[[0x20, 'runtime.convTstring']],
    literals:[[12, 0, 2, 2, 'Edit', undefined, panel], [20, 4, 3, 3, 'Add', undefined, panel]],
    resolve(buffer, metadata, profile) {
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      const start = located.literals[0][1];
      return {...located, guards:[[start + 8, 0x9a831041], [start + 28, 0x9a831040]]};
    }},

  // Only the stock agent's display description is stored here. The adjacent
  // name "default" remains the ID used when switching agents.
  literal(model + 'AgentsModel.Update', 'Default agent', 1),
  {name:model + 'AgentsModel.View', optional:true, resolve:relocateStatusLiteralGroup,
    verifiedCalls:[[0x24, 'runtime.concatstring3']],
    literals:[[0x1c, 0, 1, 2, 'Available Agents'], [0x38, 0x34, 5, 4, 'Available Agents']]},

  literal(model + 'pluginPanelHeader.render', '  (%s to cycle)', 0, {format:28}),
  {name:model + 'PluginsModel.View', optional:true, verifiedCalls:[[0x2bc, style + 'Style.Render']],
    literals:[[0, 0x26c, 3, 4, '[enabled] ', undefined, panel], [8, 0x26c, 4, 4, '[disabled]', undefined, panel]],
    resolve(buffer, metadata, profile) {
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      const start = located.literals[0][0], length = located.literals[0][1];
      // CSEL chooses the label pointer and both labels use the same byte length.
      return {...located, guards:[[start + 16, 0x9a841063]], sharedLengths:[length]};
    }},
  ...['setEnabled.func1', 'toggle.func1'].flatMap(method => {
    const name = statusline + method;
    return [literal(name, 'Statusline on. (%s)', 0, {format:24}),
      literal(name, 'Statusline on.', 3, {consumer:commandOutput}),
      literal(name, method === 'setEnabled.func1' ? 'Statusline off.' : 'Statusline off. Run /statusline to re-enable.',
        3, {consumer:commandOutput})];
  }),
];

export function collectCliPluginDescriptionStrings(buffer, dictionary, metadata) {
  const name = model + 'truncateDesc', fn = metadata.functions.get(name);
  const flatten = metadata.functions.get(cli + 'render/render.FlattenToLine');
  const width = metadata.functions.get(style + 'Width');
  const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
  const calls = (offset, target) => word(offset) >>> 26 === 0x25 &&
    fn.rva + offset + (word(offset) << 6 >> 6) * 4 === target.rva;
  if (!fn || !flatten || !width || [name,flatten.name,width.name].some(key => metadata.ambiguousFunctions?.has(key)) ||
      fn.size < 56 || word(0) !== 0xf9400b90 || word(4) !== 0xd10083f1 || word(8) !== 0xeb10023f ||
      word(0x1c) !== 0xf90057e0 || word(0x20) !== 0xf100005f || !calls(0x2c, flatten) || !calls(0x34, width)) {
    throw new CliCompatibilityError('CLI 插件说明宽度计算入口已变化');
  }
  const original = 'Unlock the power of agent swarms.';
  const translated = (dictionary.strings ?? dictionary)['cli-ui:' + original];
  return {imageBase:metadata.imageBase, matchContent:true,
    entries:translated ? [{original, translated, sourceLength:Buffer.byteLength(original)}] : [],
    missing:translated ? [] : [{original, functionName:name}],
    sites:[{functionName:name, rva:fn.rva, fileOffset:fn.fileOffset, word:word(0), pointerRegister:0, lengthRegister:1,
      contextFileOffset:fn.fileOffset, originalContext:Buffer.from(buffer.subarray(fn.fileOffset, fn.fileOffset + 56))}]};
}

// The conversation picker copies two Go strings to its stack. The plugin header
// reads a two-element slice of tab captions and a constant with its panel title.
// Match the native reader and every expected caption together before using a table.
const panelTables = [
  {owner:'main.', name:'PrintSubcommands', register:4, load:0xa90f93e3,
    labels:['\nAvailable subcommands:'], namespace:'cli-help:'},
  // All four migration previews box this one Go string for fmt.Sprintf.
  { owner:cli + 'onboarding/onboarding.', name:'formatExtensionsLabel', register:3, load:0xa90d8fe2,
    labels:['Import extensions from Gemini CLI'], namespace:'cli-ui:' },
  { name:'ConversationPickerModel.renderTabBar', register:27, load:0xad400760, labels:['CLI', 'Other'] },
  // Update uses the options count and the selected index; renderStepMenu
  // receives these two captions as a separate argument.
  { name:'GcpSetupModel.renderFullView', register:27, load:0xa9400f62, slice:true,
    labels:['Continue with Google Cloud', 'Use advanced SSO config'] },
  // The tab renderer also reads an independent slice of permission values
  // ("allow", "deny", "ask"). Only this array of captions matches.
  { name:'PermissionsModel.renderTabBar', register:27, load:0xa9400f62, slice:true, labels:['allowlist', 'denylist', 'asklist'] },
  { name:'PluginsModel.RenderHeader', register:27, load:0xa9401363, slice:true, labels:['Installed', 'Discover'] },
  { name:'PluginsModel.RenderHeader', register:3, load:0xad404470, labels:['Plugins'] },
  // Shared key hints have separate Go string headers for the key and caption.
  { name:'(*DiffModel).detailHints', register:27, load:0xa9402367, labels:['prev/next turn'] },
  { name:'(*DiffModel).viewTurnFileList', register:27, load:0xa9402f6a, labels:['switch view'] },
  { name:'ProjectsModel.listBody', register:27, load:0xa9402768, slice:true, labels:['Switch to project', 'Edit'] },
  // Hook rows store the event ID first, followed by the UI description
  // and a matcher flag. Toggle/save/delete use the event ID.
  { name:'HooksModel.viewTypeList', register:27, load:0xa9401f66, slice:true, stride:40, labelOffset:16,
    labels:['Before tool execution', 'After tool execution', 'Before each LLM invocation',
      'After each LLM invocation', 'When agent tries to exit'] },
];

export function collectCliPanelTables(buffer, metadata, collectGroup, add) {
  collectCliConfirmationCopy(buffer, metadata, collectGroup, add);
  for (const {name, register, load, slice, labels, stride = 16, labelOffset = 0, owner = model, namespace = panel} of panelTables) {
    const fullName = owner + name;
    collectGroup(fullName, () => {
      const fn = metadata.functions.get(fullName);
      if (!fn || metadata.ambiguousFunctions?.has(fullName)) throw new CliCompatibilityError('CLI 面板显示入口已变化');
      let matched;
      for (let offset = 0; offset + 12 <= fn.size; offset += 4) {
        const at = fn.fileOffset + offset, first = buffer.readUInt32LE(at), second = buffer.readUInt32LE(at + 4);
        if (buffer.readUInt32LE(at + 8) !== load || ((first & 0x9f00001f) >>> 0) !== ((0x90000000 | register) >>> 0) ||
            ((second & 0xffc003ff) >>> 0) !== ((0x91000000 | register << 5 | register) >>> 0)) continue;
        let address = pageAddress(first, metadata.imageBase + fn.rva + offset) + ((second >>> 10) & 4095);
        const entries = [];
        try {
          if (slice) {
            const header = fileOffsetFor(metadata, address, 24);
            if (buffer.readBigUInt64LE(header + 8) !== BigInt(labels.length) ||
                buffer.readBigUInt64LE(header + 16) !== BigInt(labels.length)) continue;
            address = Number(buffer.readBigUInt64LE(header));
          }
          const table = fileOffsetFor(metadata, address, labels.length * stride);
          for (const [index, original] of labels.entries()) {
            const fileOffset = table + index * stride + labelOffset, sourceLength = Buffer.byteLength(original);
            if (buffer.readBigUInt64LE(fileOffset + 8) !== BigInt(sourceLength)) break;
            const sourceAddress = Number(buffer.readBigUInt64LE(fileOffset)), source = fileOffsetFor(metadata, sourceAddress, sourceLength);
            if (buffer.toString('utf8', source, source + sourceLength) !== original) break;
            entries.push({kind:'slot', functionName:fullName, original, fileOffset, sourceLength, sourceAddress,
              contextFileOffset:fileOffset, originalContext:Buffer.from(buffer.subarray(fileOffset, fileOffset + 16))});
          }
        } catch (error) {
          if (error instanceof CliCompatibilityError) continue;
          throw error;
        }
        if (entries.length !== labels.length) continue;
        if (matched) throw new CliCompatibilityError('CLI 面板标题表位置不唯一');
        matched = entries;
      }
      if (!matched) throw new CliCompatibilityError('CLI 面板标题表已变化');
      for (const entry of matched) if (entry.original !== 'CLI') add(entry, namespace);
    });
  }
}
