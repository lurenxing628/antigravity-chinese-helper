import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

const model = 'google3/third_party/jetski/cli/model/model.';
const detail = model + 'renderDetailFieldBudget';
const signInText = model + 'signInText';
const render = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render';

function group(method, literals, verifiedCalls = []) {
  return {name:model + method, optional:true, resolve:relocateStatusLiteralGroup, literals, verifiedCalls};
}
function displayed(method, text, pointer, consumer, callOffset) {
  return group(method, [[0, 8, pointer, pointer + 1, text]], consumer ? [[callOffset, consumer]] : []);
}

// The format belongs to the native panel. Dynamic arguments remain server names,
// plugin IDs, configuration values or errors provided by the original CLI.
export const cliPluginPanelLiteralProfiles = [
  ...[
    ['CloudPluginsModel.renderDisconnectPrompt', 'Disconnect %s? [y/N]: ', 'Disconnect %s from %s? [y/N]: '],
    ['McpAuthModel.View',
      'Authenticate MCP Server: %s\n\n',
      'Authentication failed: %v',
      'Press %s to return to the MCP panel.'],
    ['(*MCPModel).refreshSelections', 'Failed to resolve config directory: %v', 'Configured (%s)'],
    ['MCPModel.renderActions', 'Are you sure you want to sign out? [%s/%s]'],
    ['pluginAuthStatusLines', '✓ signed in to %s', 'not signed in to %s (optional)'],
    ['PluginsModel.handlePluginAuthStarted', "Couldn't sign in to %s: %v"],
    ['PluginsModel.handlePluginAuthSignedIn', "Couldn't sign in to %s: %v"],
    ['PluginsModel.handleSetupStep', 'Failed to save configuration: %v'],
    ['(*pluginSetupForm).showStartFailure', '%s failed to start: %s'],
    ['(*pluginSetupForm).render',
      'Configure %s',
      'The %s MCP server requires configuration parameters before it can be started.',
      '%s is enabled: its MCP servers restart with the new values after you save.',
      'Enter %s'],
    ['PluginsModel.updateSignIn', 'Sign in to %s later: expand it under Installed and choose Sign in'],
    ['PluginsModel.handleSignIn', "Couldn't connect: %v"],
    ['(*pluginSignIn).stepLabel', 'MCP server %d of %d', 'Sign-in %d of %d'],
    ['PluginsModel.renderSignInStatus', '✓ signed in to %s'],
    ['PluginsModel.handleSignedOut', 'Signed out of %s'],
    ['(*PluginsModel).updateLocalDirStatus', '✓ plugin.json found: %s (installed — press Enter to update)'],
    ['pluginPanelHeader.render', '(Error: %v)'],
    ['PluginsModel.KeyboardHints', 'Show %d More'],
    ['PluginsModel.Update',
      '%q updated from local directory',
      ' It is disabled pending permission review: its sidecars request permissions. Review the plugin, then run /plugin enable %s.',
      'Signing out of %s...'],
    ['PluginsModel.View', 'Sign out of %s? [y/N]: ', '⋯ %d more — enter to show'],
    ['PluginsModel.renderUninstallConfirm', 'Uninstall plugin %q? [y/N]: '],
    ['renderMcpSetupStatus', '⚠ needs %s'],
    ['MCPModel.Init.func2', 'Failed to load plugin MCP specs: %v'],
    ['MCPModel.Init.func1', 'Failed to reload MCP config: %v'],
    ['MCPModel.doSignOut.func1', 'Failed to sign out from %s: %v', 'Signed out from server: %s'],
    ['MCPModel.doRestart.func1', 'Failed to restart %s: %v', 'Restarted server: %s'],
    ['MCPModel.doToggle.func1',
      'Failed to resolve config directory: %v',
      'Failed to update config: %v',
      '%s %s (config updated), but reload failed: %v'],
  ].map(([method, ...formats]) => ({name:model + method, optional:true, formats})),
  group('(*MCPModel).refreshSelections', [
    [0, 8, 0, 1, 'Plugins (%s)', 24],
    [300, 308, 0, 1, 'Plugins (%s)', 324],
  ]),
  group('(*MCPModel).refreshSelections', [[0, -4, 7, 6, 'Configured', undefined, 'cli-mcp-ui:']]),
  group('pluginAuthStatusLines', [
    [0, 8, 0, 1, '⚠ needs sign-in to %s', 24],
    [252, 260, 0, 1, '⚠ needs sign-in to %s', 276],
  ]),
  group('PluginsModel.handlePluginAuthPolled', [
    [0, 8, 0, 1, "Couldn't sign in to %s: %v", 28],
    [492, 500, 0, 1, "Couldn't sign in to %s: %v", 520],
  ]),
  group('MCPModel.doToggle.func1', [
    [0, 8, 0, 1, '%s server: %s', 24],
    [192, 200, 0, 1, '%s server: %s', 216],
  ]),

  ...['No plugins connected yet. Press Tab to connect one from Discover.', 'No cloud plugins available.',
    'No cloud plugins match your search.', "Couldn't load cloud plugins. Reopen /plugin to try again.",
    'Loading cloud plugins...'].map(text => displayed('CloudPluginsModel.emptyMessage', text, 0)),
  ...[' (default)', ' (needs reconnect)'].map(text =>
    displayed('cloudPluginAccountsText', text, 3, 'runtime.concatstring2', 12)),

  displayed('McpAuthModel.View', 'Open the following URL in your local browser to authenticate:\n\n', 3, 'runtime.concatstring2', 12),
  displayed('McpAuthModel.View', 'Your browser should open automatically. If not:\n\n', 3, 'runtime.concatstring2', 12),
  displayed('McpAuthModel.View', 'Paste the authorization code below:\n\n', 3, 'runtime.concatstring3', 32),
  displayed('McpAuthModel.View', 'Please check the code and try again.\n\n', 3, 'runtime.concatstring2', 20),
  displayed('McpAuthModel.View', ' Completing authentication...', 5, 'runtime.concatstring3', 24),
  displayed('NewMcpAuthModel', 'authorization code...', 0),
  displayed('MCPModel.renderItem', 'Tools: ', 1, 'runtime.concatstring2', 28),
  group('MCPModel.renderItem', [
    [0x42c, 0x428, 3, 2, '(error)'],
    [0xc68, 0xc64, 2, 1, '(error)'],
  ]),
  // Status captions are composed before the MCP panel renders each row.
  // The server's actual error and the available tool names are separate values.
  group('statusDetail', [
    [0x34, 0x30, 2, 1, 'initializing...', undefined, 'cli-mcp-ui:'],
    [0x80, 0x78, 3, 4, 'unknown error'],
    [0x9c, 0xa4, 0, 1, 'error: %s', 0xb4, 'cli-mcp-ui:'],
    [0xd0, 0xcc, 0, 1, '[Authed]', undefined, 'cli-mcp-ui:'],
    [0xe0, 0xe8, 3, 4, ' [Authed]', undefined, 'cli-mcp-ui:'],
    [0x110, 0x10c, 0, 1, '[Auth Needed]', undefined, 'cli-mcp-ui:'],
    [0x120, 0x128, 3, 4, ' [Auth Needed]', undefined, 'cli-mcp-ui:'],
    [0x150, 0x158, 0, 1, 'disabled', undefined, 'cli-mcp-ui:'],
  ], [[0x8c, 'runtime.convTstring'], [0xf8, 'runtime.concatstring2'], [0x138, 'runtime.concatstring2']]),
  group('formatTools', [
    [0x40, 0x48, 0, 1, 'no tools', undefined, 'cli-mcp-ui:'],
    [0x160, 0x168, 0, 1, ', +%d more', 0x178, 'cli-mcp-ui:'],
  ], [[0x190, 'runtime.concatstring2']]),
  group('MCPModel.renderActions', [
    [0, -4, 15, 12, 'Restart'], [40, 28, 13, 10, 'Enable'], [48, 32, 14, 11, 'Disable'],
    [76, 72, 15, 12, 'Authenticate'], [100, 96, 15, 12, 'Sign Out'],
  ]),

  group('MCPModel.doToggle.func1', [[0, -16, 1, 1, 'Disabled'], [8, -12, 2, 2, 'Enabled']]),
  group('PluginsModel.renderSignInStatus', [
    [0, -4, 4, 3, '⚠ needs sign-in'], [0x40, 0x48, 3, 4, ' to '], [0x58, 0x3c, 1, 2, '⚠ needs sign-in'],
  ], [[0x60, 'runtime.concatstring3']]),
  group('PluginsModel.renderSignInStatus', [[0, -8, 2, 2, 'Sign-in:']], [[12, 'runtime.convTstring']]),

  displayed('pluginAuthKeyDetails', 'Get an API key here:', 0, signInText, 20),
  ...['(*cloudPluginSignIn).render', '(*pluginSignIn).render'].map(method => group(method, [
    [0, -12, 3, 3, 'Open this URL in your local browser to sign in:'],
    [8, -8, 4, 4, "Your browser should open automatically. If it doesn't, open this URL:"],
  ])),
  group('(*pluginSignIn).render', [
    [0, 8, 0, 1, 'Then paste the authorization code from the page:'],
    [0x68, 0x70, 1, 2, 'authorization code...'],
    [0x3cc, 0x3d4, 0, 1, 'Then paste the authorization code from the page:'],
    [0x434, 0x43c, 1, 2, 'authorization code...'],
  ], [[20, signInText], [0x3e0, signInText]]),
  group('(*pluginSignIn).render', [
    [0, -8, 5, 3, 'username:password'], [8, -4, 6, 4, 'Enter your username and password:'],
    [28, 20, 5, 3, 'API key...'], [36, 24, 6, 4, 'Paste your API key:'],
  ]),
  ...['Starting sign-in...', 'Connecting...'].map(text => displayed('(*pluginSignIn).render', text, 0, signInText, 20)),
  displayed('PluginsModel.handleSignIn', 'The sign-in link changed. Open the new one above, then paste its code.', 3),
  displayed('findSignInPluginCmd.func1', 'no sign-in page is available', 0, 'errors.New', 12),

  displayed('renderCloudPluginDetails', 'Description:', 4, detail, 32),
  displayed('renderCloudPluginDetails', 'Version:', 4, detail, 16),
  ...[
    ['Installed', 'Skills:', 44], ['Installed', 'Agents:', 44],
    ['Installed', 'Marketplace:', 20], ['Installed', 'Version:', 20], ['Installed', 'Notice:', 44],
    ['Discover', 'Components:', 44], ['Discover', 'Components:', 32],
    ['Discover', 'Marketplace:', 20], ['Discover', 'Version:', 20], ['Discover', 'Notice:', 44],
  ].map(([tab, text, offset]) => displayed('PluginsModel.renderExpandedDetails' + tab, text, 4, detail, offset)),
  displayed('PluginsModel.renderExpandedDetailsInstalled', 'MCP:', 4, detail, 44),
  // The English captions and the indentation each occupy six bytes. Go reuses
  // the indent length (X2) for the caption (X5); only the latter changes.
  ...['Rules:', 'Hooks:'].map(text => ({
    ...group('PluginsModel.renderExpandedDetailsInstalled', [[0, -8, 4, 2, text]], [[44, detail]]),
    resolve(buffer, metadata, profile) {
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      const [pointer, indentLength] = located.literals[0];
      return {...located, literals:[[pointer, pointer + 8, 4, 5, text]], lengthAliases:[[pointer + 8, 2, indentLength]]};
    },
  })),
  displayed('PluginsModel.renderExpandedDetailsDiscover', 'loading...', 6, detail, 20),
  // Both focus states select one caption from these three actions.
  ...[2, 1].map(pointer => group('PluginsModel.renderExpandedDetailsInstalled', [
    [0, -4, pointer, pointer - 1, 'Sign in...'], [24, 20, pointer, pointer - 1, 'Sign out...'],
    [40, 36, pointer, pointer - 1, 'Configure MCP servers...'],
  ], [[124, render]])),

  // Go emits an inline fallback for static errors as well as fmt.Errorf.
  // The two copies belong to the same error message in either path.
  ...[
    ['(*cloudPluginSignIn).timeoutError', 'timed out waiting for you to sign in to %s', 24, 56],
    ['CloudPluginsModel.act', '%s has no sign-in page', 28, 60],
    ['PluginsModel.handleSignedOut', 'couldn\'t sign out of %s: %w', 28, 60],
    ['PluginsModel.Update', '%q is not installed by the CLI; it is registered at %s', 28, 60],
    ['PluginsModel.Update', '%q is a built-in plugin and cannot be uninstalled', 28, 60],
    ['PluginsModel.Update', 'directory %q does not contain a valid plugin', 28, 60],
    ['(*PluginsModel).submitSetupForm.func1', 'failed to enable plugin %q: %w', 24, 56],
  ].map(([method, text, call, fallback]) => group(method, [
    [0, 8, 0, 1, text], [fallback, fallback + 8, 3, 4, text],
  ], [[call, 'fmt.errorf']])),
];
