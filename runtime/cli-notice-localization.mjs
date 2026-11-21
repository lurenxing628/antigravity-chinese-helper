import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';
import { inspectNativeBinary } from './backend-metadata.mjs';
import { applyCliContentDisplayStrings } from './cli-display.mjs';

const nuxRenderer = 'google3/third_party/jetski/cli/model/model.(*ConversationModel).nuxCard';
const styleSetter = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.(*Style).set';
const noticePrefix = 'cli-notice:';
const masked = (word, mask, value) => ((word & mask) >>> 0) === (value >>> 0);
const signed = (value, bits) => value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
const branchTarget = (word, pc) => masked(word, 0xfc000000, 0x94000000)
  ? pc + signed(word & 0x3ffffff, 26) * 4 : null;

const cli = 'google3/third_party/jetski/cli/';
const model = cli + 'model/model.';
const plugins = cli + 'plugins/plugins.';
const followUp = cli + 'commands/commands.installFollowUpNotice';
const signInAction = 'open /plugin, expand %s under Installed, and choose Sign in';

// Keep articles and punctuation scoped to plugin notices. These expressions
// assemble the message around the original account, plugin and server names.
const noticeSyntax = 'cli-plugin-notice:';
function noticeLiteral(name, text, pointer, length, displacement, namespace, call) {
  return {name, optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0, displacement, pointer, length, text, undefined, namespace]],
    ...(call ? {verifiedCalls:[call]} : {})};
}
const manager = cli + 'store/store.(*Manager).';
const unsandboxedPermissionsWarning = cli + 'store/store.BuildUnsandboxedPermissionsWarning';
const invalidPermissions = 'Invalid "unsandboxed" permission rules found; they are ignored and grant nothing:';
const repairPermissions = '\nFix: replace "unsandboxed" with "command" (e.g. command(git status)), or remove the rule. Edit the file directly or use /permissions.';
const unknownModel = 'model %s is not recognized as a known model or custom model in settings';
// Alert titles and bodies can share their literal bytes with logs and command IDs.
// Match each displayed argument together with its consumer in the owning function.
const alertProfiles = [
  ...[
    [manager+"selectAgentByName", ["%v. Using the default agent instead."]],
    [manager+"handleTransition", ["Failed to warm up agent: %v"]],
    [manager+"forkOrStartConversation", ["Failed to fork current conversation: %v. Starting fresh conversation."]],
    [manager+"startNewConversationInternal", ["Error: %v"]],
    [manager+"startConversationForSend", ["Failed to start a conversation: %v"]],
    [manager+"sendMessageOrSteer", ["Failed to send message: %v", "Failed to send message to battle arm: %v"]],
    [manager+"sendImmediateMidTurn", ["Failed to send message: %v"]],
    [manager+"applySavedModel", ["%s. Using %q.", "%q is no longer available"]],
    [manager+"warnFlagErrorOnce", ["%s. Ignoring the flag.", "%s. Using %q instead."]],
    [cli+"commands/commands.(*logoutCommand).Execute.func1", ["You are connected to an Enterprise LLM Gateway, so there is no session to log out of.\nTo switch back to signing in, unset %s (or remove gateway configuration from settings) and restart the CLI."]],
    [cli+"entrypoints/entrypoints.launchCLI", ["Project %s not found"]],
    [cli+"entrypoints/entrypoints.maybeLegacyDaemonCleanupWarning", ["Unregistered the deprecated remote-control installer service that was running in the background.\nRun `%s remote-control start` to re-enable background remote control using the supported daemon."]],
  ].map(([name, formats]) => ({name, formats, optional:true})),
  ...[
    [manager+"selectAgentByName", "Agent Not Found", 5, 2, 8, 56, manager+"addAlert"],
    [manager+"forkOrStartConversation", "Failed to fork current conversation (empty ID returned). Starting fresh conversation.", 3, 4, 8, 36, manager+"addAlert"],
    [manager+"forkOrStartConversation", "Failed to start new conversation.", 3, 4, 8, 20, manager+"addAlert"],
    [manager+"warnMissingAICodeScope", "Sign-in update needed", 1, 2, 8, 28, manager+"addAlertAtEnd"],
    [manager+"warnMissingAICodeScope", "Sign-in update needed", 7, 2, 8, 52, manager+"addAlert"],
    [manager+"warnMissingAICodeScope", "Your sign-in is missing permissions that are now required, so some requests may fail. Run /logout to sign in again.", 3, 4, 8, 16, manager+"addAlertAtEnd"],
    [manager+"warnMissingAICodeScope", "Your sign-in is missing permissions that are now required, so some requests may fail. Run /logout to sign in again.", 3, 4, 8, 36, manager+"addAlert"],
    [manager+"applySessionSettings", "Session Settings Error", 1, 2, -24, 8, manager+"addAlert"],
    [manager+"startConversationForSend", "Send Message Error", 1, 2, -24, 8, manager+"addAlert"],
    [manager+"sendMessageOrSteer", "Send Message Error", 1, 2, -24, 8, manager+"addAlert"],
    [manager+"sendImmediateMidTurn", "Send Message Error", 1, 2, -24, 8, manager+"addAlert"],
    [manager+"sendMessageOrSteer", "Message not sent: ", 1, 2, -16, 8, "runtime.concatstring2"],
    [manager+"sendMessageOrSteer", "Input Error", 1, 2, -24, 8, manager+"addAlert"],
    [cli+"store/store.NewManager", "Keybindings Error", 1, 2, -24, 8, manager+"addAlert"],
    [cli+"model/model.(*RootModel).update.func5", "Keybindings Error", 1, 2, -24, 8, manager+"addAlert"],
    [manager+"applySavedModel", ". Please use the /model command to select a valid model.", 3, 4, 8, 20, "runtime.concatstring2"],
    [manager+"initAuth.func1", "Eligibility Check", 1, 2, -24, 8, manager+"addAlert"],
    [manager+"startStreaming.func16", "Lost connection to agent updates", 7, 2, 8, 52, manager+"addAlert"],
    [manager+"startStreaming.func16", "Stopped receiving updates for this conversation after repeated errors. The agent may still be running.", 3, 4, 8, 36, manager+"addAlert"],
    [manager+"initStatusLine.func1", "Statusline Error", 1, 2, -24, 8, manager+"addAlert"],
    [cli+"commands/commands.(*logoutCommand).Execute.func1", "Gemini API Key Mode", 7, 2, 8, 52, manager+"addAlert"],
    [cli+"commands/commands.(*logoutCommand).Execute.func1", "You are using the Gemini API directly with GEMINI_API_KEY, so there is no session to log out of.\nTo switch back to signing in, remove \"modelProvider\" from settings.json and restart the CLI.", 3, 4, 8, 36, manager+"addAlert"],
    [cli+"commands/commands.(*logoutCommand).Execute.func1", "Enterprise Gateway Mode", 5, 2, 8, 56, manager+"addAlert"],
    [cli+"commands/commands.(*logoutCommand).Execute.func1", "ADC Logout Instructions", 7, 2, 8, 52, manager+"addAlert"],
    [cli+"commands/commands.(*logoutCommand).Execute.func1", "You are logged in using Application Default Credentials (ADC).\nTo log out, please run `unset AGY_ADC_AUTH` in your terminal and restart the CLI.", 3, 4, 8, 36, manager+"addAlert"],
    [cli+"model/model.GcpSetupModel.applyLicenseSelection.func1", "License Selection Failed", 1, 2, -24, 8, manager+"addAlert"],
    [cli+"entrypoints/entrypoints.launchCLI", "Project Not Found", 3, 4, 8, 92, manager+"addAlert"],
    [cli+"entrypoints/entrypoints.maybeLegacyDaemonCleanupWarning", "Deprecated Remote-Control Service Removed", 1, 2, -20, 8, manager+"addAlertAtEnd"],
    [cli+"entrypoints/entrypoints.maybeLegacyDaemonCleanupWarning", "Deprecated Remote-Control Service Removed", 7, 2, 8, 52, manager+"addAlert"],
    [manager+"SwitchToConversation", "The project associated with this conversation is no longer valid.\nUse /fork to continue in a new project.", 3, 4, 8, 16, manager+"addAlertAtEnd"],
    [cli+"entrypoints/entrypoints.launchCLI.func10", "Invalid Project", 1, 2, 8, 28, manager+"addAlertAtEnd"],
    [cli+"entrypoints/entrypoints.launchCLI.func10", "The project associated with this conversation is no longer valid.\nUse /fork to continue in a new project.", 3, 4, 8, 16, manager+"addAlertAtEnd"],
    [manager+"acquireConversationPresence", "Conversation already open", 1, 2, 8, 28, manager+"addAlertAtEnd"],
    [manager+"acquireConversationPresence", "When you opened this conversation it was already open in another CLI instance on this machine. Sending messages from both may cause conflicts. Use /fork to continue here separately.", 3, 4, 8, 16, manager+"addAlertAtEnd"],
  ].map(([name, text, pointer, length, displacement, offset, callee]) =>
    noticeLiteral(name, text, pointer, length, displacement, undefined, [offset, callee])),
  ...[
    [manager+'AddWarning', 7, 8, 8, 52, manager+'addAlert'],
    [manager+'SwitchToConversation', 1, 2, 8, 28, manager+'addAlertAtEnd'],
    [manager+'WarnUnsandboxedPermissions', 1, 2, 8, 24, manager+'addAlertAtEnd'],
    [manager+'applySavedModel', 4, 2, 8, 64, manager+'addAlert'],
    [manager+'applySavedModel', 5, 2, 8, 64, manager+'addAlert'],
  ].map(([name, pointer, length, displacement, offset, callee]) =>
    noticeLiteral(name, 'Warning', pointer, length, displacement, undefined, [offset, callee])),
  {name:manager+'warnFlagErrorOnce', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,-16,1,2,'Warning'],[0x74,0x64,1,2,'Warning']],
    verifiedCalls:[[8,manager+'warnOnce'],[0x7c,manager+'warnOnce']]},
  noticeLiteral(cli+'printmode/printmode.(*session).warnUnsandboxed', 'warning: %s\n', 2, 3, 8, undefined, [24,'fmt.Fprintf']),
  {name:cli+'backend/backend.ResolveModel', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,0,1,unknownModel],[0x38,0x40,3,4,unknownModel]], verifiedCalls:[[24,'fmt.errorf']]},
  ...[
    ['CLI settings (settings.json)', 6],
    ['Shared configuration (config.json)', 7],
    ['Project configuration (project.json)', 7],
  ].map(([text, register]) => noticeLiteral(manager+'unsandboxedRuleSourcesUnlocked', text, register, register, -8)),
  noticeLiteral(manager+'unsandboxedRuleSourcesUnlocked', 'Project configuration (%s)', 0, 1, 8, undefined, [24,'fmt.Sprintf']),
  // Both Builder writes reserve capacity using the source byte counts before
  // copying. Keep those counts and the direct-return header the same length.
  {name:unsandboxedPermissionsWarning, optional:true, size:944,
    literals:[[0xb4,0xbc,1,2,invalidPermissions],[0x100,0x108,0,1,invalidPermissions],
      [0x260,0x268,2,3,'    ... and %d more\n'],[0x2f4,0x2fc,1,2,repairPermissions]],
    sharedLengths:[0xbc,0x108,0x2fc],
    guards:[[0x7c,0x910144c1],[0x90,0xd2800a23],[0x2c4,0x910218c1],[0x2d4,0xd28010c3]],
    verifiedCalls:[[0x278,'fmt.Fprintf']]},
];

export const cliNoticeLiteralProfiles = [
  ...alertProfiles,
  ...[
    [model+'cloudPluginDisconnectedMsg.notice', ['Disconnected %s', 'Disconnected %s from %s']],
    [model+'connectedNotice', ['Connected %s as %s', 'Connected %s']],
    [model+'(*pluginSetupForm).busyNotice', ['Saving and restarting the MCP servers of %s...', 'Enabling %s and starting its MCP servers...']],
    [model+'(*pluginSetupForm).savedNotice', ['%s saved; MCP servers restarted', '%s saved; press space to enable it']],
    [followUp, [' It is disabled pending permission review: its sidecars request permissions. Review the plugin, then run /plugin enable %s.']],
    [plugins+'SignInNotice', [signInAction]],
    [plugins+'(*Manager).McpSignInNoticeFor', [signInAction, 'If %s, %s.']],
    [plugins+'signInSubject', ['%s %s plugin needs you to sign in to %s']],
    [plugins+'mcpSignInSubject', ['%s %s MCP server needs you to sign in', '%s %s MCP servers need you to sign in']],
  ].map(([name,formats]) => ({name,formats,optional:true})),
  noticeLiteral(nuxRenderer, 'Learn more: ', 1, 2, 8, undefined, [16, 'runtime.concatstring2']),
  noticeLiteral(followUp, ' It is disabled until its MCP servers are configured: open /plugin and turn it on to fill them in.', 0, 1, 8),
  noticeLiteral(model+'(*pluginSetupForm).busyNotice', 'Saving...', 0, 1, 8),
  noticeLiteral(plugins+'SignInNotice', 'The', 0, 1, 8, noticeSyntax, [12, plugins+'signInSubject']),
  noticeLiteral(model+'(*pluginSignIn).render', 'The', 0, 1, 8, noticeSyntax, [28, plugins+'signInSubject']),
  noticeLiteral(plugins+'(*Manager).McpSignInNoticeFor', 'the', 0, 1, 8, noticeSyntax, [24, plugins+'mcpSignInSubject']),
  noticeLiteral(plugins+'SignInNotice', '%s: %s.', 0, 1, 8, noticeSyntax, [24, 'fmt.Sprintf']),
  noticeLiteral(plugins+'signInSubject', 'its MCP server', 8, 8, -32),
  noticeLiteral(plugins+'signInSubject', 'its MCP servers', 8, 8, -32),
  noticeLiteral(plugins+'joinNames', ' and ', 3, 4, 8, noticeSyntax, [20, 'runtime.concatstring3']),
];

function uniqueFunction(metadata, name) {
  const fn = metadata.functions.get(name);
  if (!fn || metadata.ambiguousFunctions?.has(name)) throw new CliCompatibilityError('CLI 系统公告显示入口未找到');
  return fn;
}

// Frame size changes move spill slots and stack objects. Match their addressing
// instructions and registers while accepting the compiler-chosen displacement.
const frame = opcode => word => masked(word, 0xffc003ff, opcode);
const frameBase = frame(0x914003fb); // add x27, sp, #imm, lsl #12
const styleObject = [frame(0x914003e0), frame(0x91000000)];
const globalAddress = register => [
  word => masked(word, 0x9f00001f, 0x90000000 | register),
  word => masked(word, 0xffc003ff, 0x91000000 | (register << 5) | register),
];
const call = target => (word, rva) => branchTarget(word, rva) === target.rva;

function findDisplaySite(buffer, fn, pattern, fieldLoad) {
  let site;
  const contextSize = pattern.length * 4;
  for (let offset = 0; offset + contextSize <= fn.size; offset += 4) {
    const contextFileOffset = fn.fileOffset + offset;
    const matches = pattern.every((expected, i) => {
      const word = buffer.readUInt32LE(contextFileOffset + i * 4);
      return typeof expected === 'number' ? word === expected : expected(word, fn.rva + offset + i * 4);
    });
    if (!matches) continue;
    if (site) throw new CliCompatibilityError('CLI 系统公告显示入口不唯一');
    const relativeOffset = offset + pattern.indexOf(fieldLoad) * 4;
    site = { rva:fn.rva + relativeOffset, fileOffset:fn.fileOffset + relativeOffset,
      word:fieldLoad, pointerRegister:6, lengthRegister:7, replayFirst:true, contextFileOffset,
      originalContext:Buffer.from(buffer.subarray(contextFileOffset, contextFileOffset + contextSize)) };
  }
  if (!site) throw new CliCompatibilityError('CLI 系统公告标题或正文显示布局已变化');
  return site;
}

/** NUX title/body are system UI fields; their source object and ID stay intact. */
export function collectCliNoticeDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const fn = uniqueFunction(metadata, nuxRenderer), setStyle = uniqueFunction(metadata, styleSetter);
  const growSlice = uniqueFunction(metadata, 'runtime.growslice');
  const titleLoad = 0xa9449ca6, bodyLoad = 0xa9401cc6;
  // Follow ConversationModel -> Store.nux -> current NUX -> Title in x6/x7,
  // through its nil/default branches to the first style call. x9..x17 are free.
  const title = findDisplaySite(buffer, fn, [
    frameBase, frame(0xf9400365), 0xf94000a5, 0xf94000a5, 0x910820bb,
    0xa9401b65, 0xb5000066, 0xaa1f03e5, 0x14000002, 0xf94000a5, 0xb4000065,
    titleLoad, 0x14000003, 0xaa1f03e7, 0xaa1f03e6, frameBase, frame(0xf9000365),
    0xb50000a7, 0xaa1f03e0, 0xaa1f03e4, 0xaa1f03e1, 0x14000047, frameBase,
    frame(0xf9000366), frameBase, frame(0xf9000367), ...styleObject, 0xd2800144,
    0xa8817c1f, 0xa8817c1f, 0xa8817c1f, 0xa8817c1f, 0xd1000484, 0xb5ffff64,
    0xf900001f, ...styleObject, 0xb24003e1, ...globalAddress(2), ...globalAddress(3), call(setStyle),
  ], titleLoad);
  // Reload the very same NUX saved by the title path, read Body's optional
  // string into x6/x7, then append it to the rendered card's slice.
  const savedBase = buffer.readUInt32LE(title.fileOffset + 16);
  const savedStore = buffer.readUInt32LE(title.fileOffset + 20);
  const body = findDisplaySite(buffer, fn, [
    savedBase, (savedStore | 0x00400000) >>> 0, 0xb27f03e0, 0xb24003e1,
    0xb40000a5, 0xf9402ca6, 0xb4000066, bodyLoad, 0x14000003,
    0xaa1f03e7, 0xaa1f03e6, 0xb4000407, 0x91000421, 0xeb01001f, 0x54000262,
    frameBase, frame(0xf9000366), frameBase, frame(0xf9000367),
    0xaa0003e2, 0xb24003e3, 0xaa0403e0, ...globalAddress(4), call(growSlice),
  ], bodyLoad);
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI notice translations must be an object');
  const entries = Object.entries(strings).filter(([key, value]) => key.startsWith(noticePrefix) &&
    key.length > noticePrefix.length && typeof value === 'string' && value.length > 0)
    .map(([key, translated]) => ({ original:key.slice(noticePrefix.length), translated,
      sourceLength:Buffer.byteLength(key.slice(noticePrefix.length), 'utf8') }));
  return { imageBase:metadata.imageBase, entries, sites:[title, body], matchContent:true };
}

/** Match known system announcement text, including its server-owned heap string. */
export function applyCliNoticeDisplayStrings(buffer, plan, options) {
  return applyCliContentDisplayStrings(buffer, plan, options);
}
