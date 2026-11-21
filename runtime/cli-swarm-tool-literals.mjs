import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

const swarm = 'google3/third_party/jetski/cortex/core/native_swarm/nativeswarm.';
const ns = 'cli-swarm-tool:';
const renderInfo = swarm + 'swarmRenderInfo';

// These strings populate the tool display summary. Command input, member IDs,
// channel values, result payloads and messages use separate producers.
function display(name, text, {pointer = 0, length = 8, lengthRegister = pointer + 1, format, call, guard} = {}) {
  return {
    name:swarm + name, optional:true,
    literals:[[0, length, pointer, lengthRegister, text, format, ns]],
    verifiedCalls:call ? [call] : [],
    resolve(buffer, metadata, profile) {
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      if (!guard) return located;
      const offset = located.literals[0][0];
      return {...located, guards:[[offset + guard[0], guard[1]]]};
    },
  };
}

const format = (name, text) => display(name, text, {format:24});
const action = (name, text, call) => display(name, text, {call:[call, renderInfo]});
const title = (name, text) => display(name, text, {pointer:1, guard:[12, 0xa9018801]});

const waitTargets = {
  name:swarm + 'swarmWaitRenderInfo', optional:true, resolve:relocateStatusLiteralGroup,
  verifiedCalls:[[0x40, 'runtime.convTstring']],
  literals:[
    [0,-4,1,0,'board messages',undefined,ns], [0x10,0xc,1,0,'@mentions',undefined,ns],
    [0x20,0x1c,1,0,'@mentions',undefined,ns],
  ],
};
const readBoardLabel = {
  name:swarm + 'readBoardRenderInfo', optional:true, resolve:relocateStatusLiteralGroup,
  verifiedCalls:[[0x2c, 'runtime.convTstring']],
  literals:[[0,-4,3,2,'board',undefined,ns], [0x10,0xc,3,2,'board',undefined,ns]],
};

const manage = method => '(*manageSwarmTool).' + method;
function summary(name, verb, label) {
  return {
    name:swarm + name, optional:true, resolve:relocateStatusLiteralGroup,
    verifiedCalls:[[0x24, renderInfo]],
    literals:[[0,8,0,1,verb,undefined,ns], [12,20,2,3,label,undefined,ns]],
  };
}

const channelActions = {
  // The selected caption is loaded into X0/X1 just before swarmRenderInfo.
  // The adjacent past-tense JSON results are never included in this profile.
  name:swarm + manage('channelAction'), optional:true, resolve:relocateStatusLiteralGroup,
  verifiedCalls:[[0x188, renderInfo]],
  literals:[
    [0,-4,1,0,'Created',undefined,ns], [0x48,0x44,1,0,'Archived',undefined,ns],
    [0x88,0x84,1,0,'Subscribed to',undefined,ns], [0x98,0x94,1,0,'Unsubscribed from',undefined,ns],
  ],
};
const switchedModels = {
  name:swarm + manage('setModel'), optional:true, resolve:relocateStatusLiteralGroup,
  verifiedCalls:[[0x20, renderInfo], [0x268, renderInfo]],
  literals:[[0,8,0,1,'Switched',undefined,ns], [0x248,0x250,0,1,'Switched',undefined,ns]],
};

export const cliSwarmToolLiteralProfiles = [
  format('remoteKillRenderInfo', '%d worker(s)'),
  action('remoteKillRenderInfo', 'Killed', 12),
  ...['addRenderInfo', 'killRenderInfo'].flatMap(name => [
    format(name, 'worker @%s'), format(name, '%d workers (@%s–@%s)'),
  ]),
  display('addRenderInfo', 'Spawned', {length:0x14, call:[0x18, renderInfo]}),
  action('addRenderInfo', 'Spawned', 16),
  action('killRenderInfo', 'Killed', 0x24),
  format('parkGuardRenderInfo', 'wait — new board message (#%d)'),
  format('parkGuardRenderInfo', 'wait — new board messages (#%d–#%d)'),
  format('parkGuardRenderInfo', 'Board message #%d arrived before waiting completed; reading the board before waiting again.'),
  format('parkGuardRenderInfo', 'Board messages #%d–#%d arrived before waiting completed; reading the board before waiting again.'),
  title('parkGuardRenderInfo', 'Resumed'),
  display('postMessageRenderInfo', 'board', {pointer:2, length:-4, lengthRegister:1, call:[0x60, 'runtime.convTstring']}),
  format('postMessageRenderInfo', '#%d to %s'),
  title('postMessageRenderInfo', 'Posted'),
  readBoardLabel,
  format('readBoardRenderInfo', '%s (0 messages)'),
  format('readBoardRenderInfo', '%d messages from %s (#%d–#%d)'),
  format('readBoardRenderInfo', '1 message from %s (#%d)'),
  title('readBoardRenderInfo', 'Read'),
  waitTargets,
  format('swarmWaitRenderInfo', 'for %s after #%d'),
  title('swarmWaitRenderInfo', 'Waiting'),
  channelActions,
  action(manage('channelAction'), 'Checked', 12),
  summary(manage('listChannels'), 'Listed', 'channels'),
  format(manage('joinedResult'), 'swarm %s as @%s'),
  action(manage('joinedResult'), 'Joined', 12),
  summary(manage('status'), 'Checked', 'swarm status'),
  // This is the markdown block passed to swarmRenderInfo. The tool returns
  // a separate JSON status to the model on the same branch.
  display(manage('status'), 'No swarm yet.', {pointer:3, call:[0x7c, renderInfo]}),
  display(manage('status'), 'swarm status', {length:-4, call:[0x164, renderInfo]}),
  format(manage('status'), 'swarm status (%s)'),
  action(manage('status'), 'Checked', 0x20),
  ...[', last seen %s', ' in `%s`', '\n%d agent(s), %d waiting', ', %d stopped (a post naming one revives it)'].map(text =>
    display('statusMarkdown', text, {pointer:2, call:[24, 'fmt.Fprintf']})),
  display('channelsLine', ' (archived)', {pointer:3, call:[20, 'runtime.concatstring2']}),
  display('channelsLine', '\nchannels: #main, ', {pointer:1, length:-28, call:[8, 'runtime.concatstring3']}),
  summary(manage('models'), 'Listed', 'swarm models'),
  summary(manage('models'), 'Listed', 'suggested swarm models'),
  format(manage('setModel'), '@%s to %s'),
  format(manage('setModel'), 'worker @%s to %s'),
  switchedModels,
  format(manage('title'), 'swarm %q'),
  action(manage('title'), 'Titled', 12),
];
