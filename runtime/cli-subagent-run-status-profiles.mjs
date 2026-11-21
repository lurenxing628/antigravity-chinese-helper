import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';

const render = 'google3/third_party/jetski/cli/render/render.';
const steps = 'google3/third_party/jetski/cli/steps/steps.';
const conversation = 'google3/third_party/jetski/cli/model/model.(*ConversationModel).';
const manager = 'google3/third_party/jetski/cli/store/store.(*Manager).';
const tools = 'google3/third_party/oneharness/internal/tools/tools.';
const agentCard = tools + 'manageSubagentsRenderInfo';
const taskCard = tools + 'manageTaskRenderInfo';
const renderInfo = render + 'GetSubagentRenderInfo';
const alert = conversation + 'renderMultiLineSubagentAlert';
const width = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Width';

export const subagentRunStatusProfiles = [
  // These are display descriptions of the selected tool. The action classifier
  // and the user-provided tool and target names have their own values.
  {name:render + 'formatOtherActions', literals:[
    [0x34,0x24,6,5,'Using'], [0x3c,0x28,7,6,'Used'],
  ]},
  {name:render + 'formatOtherActions', formats:['%s %d tools']},
  {name:steps + 'DeriveActivityLabel', literals:[
    [0x30,0x38,0,1,'Generating'], [0x90,0x98,0,1,'Working'],
  ]},
  {name:render + 'FormatSubagentModel', literals:[[0x88,0x90,0,1,'Blocked · ']], verifiedCalls:[[0x94,width]]},
  {name:render + 'SubagentRenderInfo.RenderRow', literals:[[0x210,0x218,0,1,'Blocked · ']], verifiedCalls:[[0x21c,width]]},
  {name:renderInfo, formats:['Agent(%s)']},
  {name:renderInfo, literals:[[0x374,0x370,6,7,'Tool'], [0x3c4,0x3c0,6,7,'Tool']]},
  {name:renderInfo, literals:[[0x3f8,0x3f4,5,3,'1 step'], [0x424,0x42c,0,1,'%d steps',0x43c]]},
  {name:renderInfo, literals:[
    [0x480,0x478,9,8,'Processing...'], [0x4bc,0x4b8,9,8,'Done'],
    [0x4f8,0x500,1,2,'Error: '], [0x554,0x550,9,8,'Killed'],
    [0x610,0x618,4,5,'Blocked'],
  ], verifiedCalls:[[0x504,'runtime.concatstring2']]},
  {name:renderInfo, formats:[' · worked %s']},
  {name:render + 'formatSubagentName', literals:[[0xac,0xb4,0,1,'Subagent']]},
  {name:render + 'invokeSubagentName', literals:[[0x60,0x68,0,1,'Subagent'], [0x78,0x80,0,1,'Subagent']]},
  {name:render + 'genericInvokeSubagentInfo', literals:[
    [0x130,0x138,1,2,'Agent('], [0x300,0x308,1,2,'Agent('],
  ], verifiedCalls:[[0x150,'runtime.concatstring3'], [0x320,'runtime.concatstring3']]},
  {name:tools + 'defineSubagentRenderInfo', formats:['%s subagent']},
  {name:tools + 'invokeSubagentsRenderInfo', literals:[[0xac,0xbc,7,7,'Subagent']]},
  // These strings supply only the card's title, count and Markdown body.
  // The tools return their own messages and structured results separately.
  {name:tools + 'agentBlocksRenderInfo', optional:true, literals:[
    [0x334,0x330,0,1,'subagents'], [0x34c,0x348,0,1,'subagent'],
    [0x370,0x378,0,1,'%d subagents',0x388],
  ]},
  ...[
    ['(*ManageSubagentsTool).list', 'Finding', 0x2c,0x34,0x44],
    ['(*ManageSubagentsTool).listPeers', 'Found', 0x88,0x90,0xa0],
    ['(*ManageSubagentsTool).buildListResult', 'Found', 0x624,0x62c,0x63c],
    ['(*ManageSubagentsTool).kill', 'Killing', 0x3d4,0x3e8,0x3ec],
    ['(*ManageSubagentsTool).kill', 'Killed', 0x4d4,0x4dc,0x4ec],
    ['(*ManageSubagentsTool).kill', 'Killed', 0xac8,0xad0,0xadc],
    ['(*ManageTaskTool).kill', 'Killing task', 0x54,0x5c,0x70],
    ['(*ManageTaskTool).kill', 'Killed task', 0x25c,0x264,0x274],
    ['(*ManageTaskTool).status', 'Checking task', 0x40,0x48,0x5c],
    ['(*ManageTaskTool).status', 'Checked task', 0x26c,0x274,0x278],
    ['(*ManageTaskTool).sendInput', 'Sending input to task', 0x8c,0x94,0x98],
    ['(*ManageTaskTool).sendInput', 'Sent input to task', 0x220,0x228,0x238],
  ].map(([name,text,pointer,length,call]) => ({
    name:tools + name, optional:true, literals:[[pointer,length,0,1,text]],
    verifiedCalls:[[call,name.startsWith('(*ManageSubagentsTool)') ? agentCard : taskCard]],
  })),
  {name:tools + '(*ManageTaskTool).list', optional:true, literals:[
    [0x38,0x40,0,1,'Listing'], [0x44,0x4c,2,3,'tasks'],
  ], verifiedCalls:[[0x58,taskCard]]},
  {name:tools + '(*ManageTaskTool).list', optional:true, literals:[
    [0x208,0x210,0,1,'Listed'], [0x214,0x21c,2,3,'0 tasks'],
  ], verifiedCalls:[[0x228,taskCard]]},
  {name:tools + '(*ManageTaskTool).list', optional:true, formats:['%d tasks']},
  {name:tools + '(*ManageTaskTool).list', optional:true, literals:[
    [0x854,0x848,2,1,'1 task'], [0x8a4,0x848,0,1,'Listed'],
  ], verifiedCalls:[[0x8ac,taskCard]], resolve(buffer, metadata, profile, dictionary) {
    // Go uses the same byte count for both strings, including an untranslated one.
    const strings = dictionary?.strings ?? dictionary;
    function displayLength(original) {
      const value = strings?.['cli-ui:' + original] ?? strings?.[original];
      return Buffer.byteLength(typeof value === 'string' && value ? value : original);
    }
    if (displayLength('1 task') !== displayLength('Listed')) throw new CliCompatibilityError('CLI 任务列表的 Listed 和 1 task 共用显示长度');
    return relocateStatusLiteralGroup(buffer, metadata, profile);
  }},
  {name:tools + 'formatStatusMarkdown', optional:true, literals:[
    [0x68,0x70,2,3,'**Status**: %s'], [0xb0,0xb8,2,3,' • **Last progress**: %v ago'],
    [0x134,0x13c,2,3,'\n\n*No log output recorded yet.*'],
  ], verifiedCalls:[[0x80,'fmt.Fprintf'],[0xc8,'fmt.Fprintf'],[0x14c,'fmt.Fprintf']]},
  // These statuses and callouts are drawn after classification. The workflow
  // state map still uses the original strings as lookup keys.
  {name:render + 'workflowAgentRow', literals:[
    [0xdc,0xd8,3,2,'Canceled'], [0x1b0,0x1ac,3,2,'Idle'],
    [0x21c,0x218,3,2,'Running'], [0x294,0x29c,3,4,'Needs approval'],
  ]},
  {name:alert, literals:[[0x1a8,0x1a4,3,4,'Tool'], [0x238,0x240,3,4,' needs approval for '],
    [0x2ec,0x2e8,4,3,'approve'], [0x8a4,0x8ac,3,4,' manage'],
  ], verifiedCalls:[[0x254,'runtime.concatstring3'], [0x8b8,'runtime.concatstring2']]},
  {name:alert, literals:[[0xeec,0xef4,3,4,' has a question'], [0xf18,0xf10,5,4,'answer']],
    verifiedCalls:[[0xf00,'runtime.concatstring2']]},
  {name:manager + 'HandleSubagentUserInput', formats:['Sent message to %s: %s', 'Failed to send message to %s: %v']},
  {name:manager + 'TriggerSubagentApprovalFast.func1', formats:['Tool confirmation failed: %v']},
].map(profile => profile.literals ? {resolve:relocateStatusLiteralGroup, ...profile} : profile);
