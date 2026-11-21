import { cliNoticeLiteralProfiles } from './cli-notice-localization.mjs';
import { releaseNoteProfiles } from './cli-release-notes.mjs';
import { authInstructionProfiles, relocateStatusLiteralGroup, resolvePanelStatusProfile } from './cli-panel-status-profiles.mjs';
import { inspectTaskStatusWidths, resolveTaskStatusProfile } from './cli-task-status-profiles.mjs';
import { toolStatusProfiles, transcriptStatusProfiles } from './cli-tool-status-profiles.mjs';
import { modelLiteralProfiles } from './cli-model-literals.mjs';
import { cliPanelLiteralProfiles, collectCliPanelTables } from './cli-panel-literals.mjs';
import { cloudLoginLiteralProfiles } from './cli-cloud-login-literals.mjs';
import { cliOnboardingLiteralProfiles } from './cli-onboarding-literals.mjs';
import { feedbackLiteralProfiles } from './cli-ui-literals.mjs';
import { cliSubagentLiteralProfiles } from './cli-subagent-literals.mjs';
import { subagentRunStatusProfiles } from './cli-subagent-run-status-profiles.mjs';
import { cliSwarmLiteralProfiles, collectCliSwarmPluginFieldSlots } from './cli-swarm-localization.mjs';
import { cliSwarmToolLiteralProfiles } from './cli-swarm-tool-literals.mjs';
import { CliCompatibilityError } from './cli-compatibility.mjs';
import { cliSiteReachesCodeSpace } from './cli-code-space.mjs';
import { inspectNativeBinary } from './backend-metadata.mjs';
import { stringLengthImmediate, pageAddress, fileOffsetFor, addressInstructions } from './cli-localization.mjs';
import { cliTipProfile, collectCliLiteralEntries } from './cli-display.mjs';

const render = 'google3/third_party/jetski/cli/render/render.';
const stateLabel = 'google3/third_party/jetski/cli/model/model.AgentState.Label';
const taskListView = 'google3/third_party/jetski/cli/model/model.TasksModel.View';
const compactionMarker = render + 'renderCompactionMarker';
const decoder = new TextDecoder('utf-8', { fatal:true });

// Named display producers. Simple formats follow fmt.Sprintf at any offset.
// Coupled references retain their register, literal and consumer checks.
// buildFoldLine's reads/searches/commands are classification IDs, not labels.
const literalProfiles = [
  ...releaseNoteProfiles,
  ...cliNoticeLiteralProfiles,
  {name:render + 'compactionStatsParts', size:1328,
    guards:[[0x130,0x9a820021],[0x144,0x9a830040]],
    verifiedCalls:[[0x314,'runtime.concatstring2'],[0x438,'runtime.concatstring2']],
    literals:[
      [0x134,0x128,2,1,'step'], [0x13c,0x12c,3,2,'steps'],
      [0x158,0x160,0,1,'%d %s summarized',0x170],
      [0x25c,0x264,0,1,'context %s → ~%s (%s summary)',0x274],
      [0x300,0x308,3,4,'-token summary'], [0x430,0x420,1,2,'took '],
    ],
  },
  {name:compactionMarker, size:512,
    verifiedCalls:[[0x9c,'runtime.concatstring3'],[0x120,'runtime.concatstring3']],
    literals:[
      [0x20,0x28,7,8,'Conversation compacted'], [0x34,0x3c,7,8,'Compacted'],
    ],
  },
  {name:render + 'formatFileTargets', size:1168, literals:[
    [0x1c8,0x1d0,0,1,'2 files'], [0x244,0x24c,0,1,'2 files'],
    [0x26c,0x274,0,1,'1 file'], [0x438,0x440,0,1,'%d files',0x450],
  ]},
  {name:render + 'summarizeThinkingSteps', resolve:relocateStatusLiteralGroup, literals:[
    [0x2b8,0x2c0,0,1,'Thought for %.1fs',0x2d0], [0x2e8,0x2f0,0,1,'Thought'],
    [0x320,0x328,0,1,'Thought for %s',0x338], [0x350,0x358,0,1,'Thinking...'],
  ]},
  {name:render + 'stepContent', size:12768, literals:[
    [0x1060,0x1068,0,1,'Thought for %s, %s tokens',0x107c],
    [0x10b0,0x10b8,0,1,'Thought for %s',0x10cc], [0x10dc,0x10d8,2,1,'Thought Process'],
  ]},
  {name:render + 'buildFoldLine', size:2144, guards:[[0x72c,0x9a820021],[0x740,0x9a830040]], literals:[
    [0x5a4,0x5ac,0,1,'%d %s',0x5bc],
    [0x6bc,0x6c4,0,1,': %d failed',0x6d4],
    [0x730,0x724,2,1,'action',undefined,'cli-noun:'], [0x738,0x728,3,2,'actions',undefined,'cli-noun:'],
    [0x758,0x760,0,1,'%d more %s',0x770],
  ]},
  {name:render + 'formatExploreRun', size:3184, guards:[[0x570,0x9a841063],[0x588,0x9a841063]], literals:[
    [0x578,0x568,3,3,'Exploring'], [0x580,0x56c,4,4,'Explored'],
    [0x6d0,0x6b0,7,7,'1 search'], [0x7a0,0x7a8,0,1,'%d searches',0x7b8],
    [0x928,0x908,10,10,'1 resource'], [0x9f4,0x9fc,0,1,'%d resources',0xa0c],
  ]},
  {name:render + 'formatCommandRun', size:5856, guards:[
    [0x29c,0x9a8b114a],[0x2b4,0x9a8d116b],[0x420,0x9a831042],
    [0x438,0x9a841063],[0x464,0x9a8f11ce],[0x478,0x9a9011ef],
  ], literals:[
    [0x2a4,0x294,11,10,'Running'], [0x2ac,0x298,13,11,'Ran'],
    [0x2c8,0x2c4,0,1,'1 command'], [0x2f4,0x2fc,0,1,'%d commands',0x30c],
    [0x428,0x418,3,2,'Running'], [0x430,0x41c,4,3,'Ran'],
    [0x468,0x45c,15,14,'Running'], [0x470,0x460,16,15,'Ran'],
    [0xf00,0xf08,0,1,'%d failed',0xf18], [0xfcc,0xfd4,0,1,'%s %d commands',0xfe4],
  ]},
  {name:render + 'formatEditRun', size:2384,
    guards:[[0x384,0x9a831041],[0x398,0x9a831040],[0x68c,0x9a851084],[0x6a0,0x9a8610a5],[0x6bc,0x9a8810e7],[0x6d4,0x9a891108]],
    literals:[
      [0x388,0x37c,2,2,"Generating"],
      [0x390,0x380,3,3,"Generated"],
      [0x3a8,0x3a4,3,2,"1 image"],
      [0x3dc,0x3e4,0,1,"%d images",0x3f4],
      [0x690,0x684,5,4,"Editing"],
      [0x698,0x688,6,5,"Edited"],
      [0x6c4,0x6b4,8,7,"generating"],
      [0x6cc,0x6b8,9,8,"generated"],
      [0x6e8,0x6e4,9,6,"1 image"],
      [0x71c,0x724,0,1,"%d images",0x734],
    ],
  },
  {name:render + 'formatScheduleRun', size:1392,
    guards:[[0x54,0x9a8710c6],[0x6c,0x9a8810e7]],
    literals:[
      [0x5c,0x4c,7,6,"Scheduling"],
      [0x64,0x50,8,7,"Scheduled"],
      [0x1dc,0x1e4,5,6,"1 timer"],
      [0x228,0x230,0,1,"%d timers",0x240],
      [0x300,0x2e0,7,7,"1 cron"],
      [0x33c,0x344,0,1,"%d crons",0x354],
    ],
  },
  {name:render + 'formatSubagentRun', size:1488,
    guards:[[0x168,0x9a821021],[0x180,0x9a831042],[0x2f4,0x9a821021],[0x30c,0x9a831042]],
    countNouns:[
      [0x1b8,2,"subagent",0x1c4,0x1dc],
      [0x20c,2,"subagent",0x218,0x230],
      [0x344,2,"subagent",0x350,0x368],
      [0x398,2,"subagent",0x3a4,0x3bc],
      [0x460,2,"message",0x46c,0x484],
      [0x4b0,2,"message",0x4bc,0x4d4],
    ],
    literals:[
      [0x170,0x160,2,1,"Messaging"],
      [0x178,0x164,3,2,"Messaged"],
      [0x1c4,0x1cc,0,1,"%d %s",0x1dc,"cli-subagent-count:"],
      [0x218,0x220,0,1,"%d %ss",0x230,"cli-subagent-count:"],
      [0x2fc,0x2ec,2,1,"Spawning"],
      [0x304,0x2f0,3,2,"Spawned"],
      [0x350,0x358,0,1,"%d %s",0x368,"cli-subagent-count:"],
      [0x3a4,0x3ac,0,1,"%d %ss",0x3bc,"cli-subagent-count:"],
      [0x46c,0x474,0,1,"%d %s",0x484,"cli-message-count:"],
      [0x4bc,0x4c4,0,1,"%d %ss",0x4d4,"cli-message-count:"],
    ],
  },
  {name:render + 'formatQuestionRun', size:848,
    guards:[[0x54,0x9a8710c6],[0x6c,0x9a8810e0]],
    literals:[
      [0x5c,0x4c,7,6,"Asking"],
      [0x64,0x50,8,7,"Asked"],
      [0x178,0x174,2,1,"1 question"],
      [0x19c,0x1a4,0,1,"%d questions",0x1b4],
    ],
  },
  {name:render + 'formatPermissionRun', size:832,
    guards:[[0x54,0x9a8710c6],[0x6c,0x9a8810e0]],
    literals:[
      [0x5c,0x4c,7,6,"Requesting"],
      [0x64,0x50,8,7,"Requested"],
      [0x174,0x170,2,1,"1 permission"],
      [0x198,0x1a0,0,1,"%d permissions",0x1b0],
    ],
  },
  {name:render + 'formatMCPRun', size:1024,
    guards:[[0x54,0x9a8710c6],[0x6c,0x9a8810e0]],
    literals:[
      [0x5c,0x4c,7,6,"Calling"],
      [0x64,0x50,8,7,"Called"],
      [0x180,0x188,0,1,"%s 1 MCP tool",0x198],
      [0x2b4,0x2bc,0,1,"%s %d MCP tools",0x2cc],
    ],
  },
  {name:render + 'formatBrowserRun', size:848,
    guards:[[0x54,0x9a8710c6],[0x6c,0x9a8810e0]],
    literals:[
      [0x5c,0x4c,7,6,"Browsing"],
      [0x64,0x50,8,7,"Browsed"],
      [0x178,0x174,2,1,"1 page"],
      [0x19c,0x1a4,0,1,"%d pages",0x1b4],
    ],
  },
  {name:render + 'formatWorkflowRun', size:1168,
    guards:[[0x94,0x9a841063],[0xa8,0x9a851080]],
    literals:[
      [0x98,0x8c,4,3,"Running"],
      [0xa0,0x90,5,4,"Ran"],
      [0x250,0x24c,1,0,"Running"],
      [0x380,0x388,0,1,"%s %d workflows",0x398],
    ],
  },
  {name:"google3/third_party/jetski/cli/steps/steps.WorkflowHeadline", size:752,
    verifiedCalls:[[0x200,"runtime.concatstring2"]],
    literals:[
      [0x1f4,0x1fc,3,4," workflow"],
      [0x228,0x230,0,1,"Workflow"],
    ],
  },
  {name:render + 'formatTaskSubActions', size:2352,
    guards:[[0x3dc,0x9a8710c6],[0x3fc,0x9a8810e6],[0x418,0x9a841063],[0x42c,0x9a881080],[0x578,0x9a841063],[0x58c,0x9a881080],[0x6a0,0x9a841063],[0x6b4,0x9a881080]],
    caseGroups:[
      [0x430,0x36000286,0x480,"killing","killed"],
      [0x590,0x36000286,0x5e0,"sending input to","sent input to"],
      [0x6b8,0x36000286,0x708,"checking","checked"],
    ],
    literals:[
      [0x3cc,0x3e0,6,2,"Listing tasks"],
      [0x3d4,0x3e0,7,2,"listing tasks"],
      [0x3ec,0x400,7,2,"Listed tasks"],
      [0x3f4,0x400,8,2,"listed tasks"],
      [0x41c,0x410,4,3,"killing"],
      [0x424,0x414,8,4,"killed"],
      [0x4a8,0x4b0,0,1,"%s 1 task",0x4c0],
      [0x504,0x50c,0,1,"%s %d tasks",0x51c],
      [0x57c,0x570,4,3,"sending input to"],
      [0x584,0x574,8,4,"sent input to"],
      [0x608,0x610,0,1,"%s 1 task",0x620],
      [0x664,0x66c,0,1,"%s %d tasks",0x67c],
      [0x6a4,0x698,4,3,"checking"],
      [0x6ac,0x69c,8,4,"checked"],
      [0x730,0x738,0,1,"%s 1 task",0x748],
      [0x78c,0x794,0,1,"%s %d tasks",0x7a4],
    ],
  },
  {name:render + 'scheduleSummary', size:352,
    verifiedCalls:[[0x70,"runtime.concatstring2"]],
    literals:[
      [0x64,0x6c,3,4,"s"],
    ],
  },
  {name:render + 'genericSearchSummary', size:336,
    verifiedCalls:[[0x8c,"runtime.concatstring2"]],
    literals:[
      [0x84,0x74,1,2,"in "],
    ],
  },
  {name:render + 'searchSummary', size:608,
    verifiedCalls:[[0xa8,"runtime.concatstring2"]],
    literals:[
      [0xa0,0x90,1,2,"in "],
    ],
  },
  {name:render + 'toolStepInfo', resolve:resolveTaskStatusProfile, size:4912,
    verifiedCalls:[[0x1a4,"runtime.concatstring3"],[0xc30,"runtime.concatstring2"]],
    literals:[
      [0x184,0x18c,1,2,"Agent("],
      [0xc24,0xc2c,1,2,"Requested Permission: "],
    ],
  },
  {name:"google3/third_party/jetski/cli/model/model.taskStatus", resolve:resolveTaskStatusProfile,size:1088,
    verifiedCalls:[[0x8c,"google3/third_party/jetski/cli/render/render.StatusMarker"],[0x1ac,"runtime.concatstring2"],[0x26c,"runtime.concatstring2"]],
    literals:[
      [0xb0,0xac,3,2,"running"],
      [0xdc,0xd8,3,2,"cancelled"],
      [0x170,0x178,0,1," (exit %d)",0x18c],
      [0x19c,0x1a8,1,2,"failed"],
      [0x230,0x238,0,1," (exit %d)",0x24c],
      [0x25c,0x268,1,2,"completed"],
    ],
  },
  {name:taskListView, resolve:resolveTaskStatusProfile,size:4544,
    verifiedCalls:[[0x76c,"fmt.Sprintf"],[0x78c,"runtime.concatstring2"],[0x82c,"fmt.Sprintf"],[0x84c,"runtime.concatstring2"],[0xe88,"fmt.Sprintf"]],
    literals:[
      [0x690,0x68c,5,4,"running"],
      [0x6bc,0x6b8,5,4,"cancelled"],
      [0x750,0x758,0,1," (exit %d)",0x76c],
      [0x77c,0x784,1,2,"failed"],
      [0x810,0x818,0,1," (exit %d)",0x82c],
      [0x83c,0x844,1,2,"completed"],
    ],
  },
  {name:"google3/third_party/jetski/cli/model/model.TaskDetailModel.buildTaskDetailLines", resolve:resolveTaskStatusProfile,size:4752,
    guards:[[0x6a8,0x9a841064],[0x6bc,0x9a851063]],
    literals:[
      [0x2a8,0x2b0,3,4,"Command: "],
      [0x42c,0x434,3,4,"Status:  "],
      [0x638,0x640,3,4,"Type:    "],
      [0x6ac,0x6a0,3,3,"Agent"],
      [0x6b4,0x6a4,5,4,"User"],
      [0x7f0,0x7f8,3,4,"Started: "],
      [0xe0c,0xe14,3,4,"(no output)"],
    ],
  },
  {name:"google3/third_party/oneharness/internal/tools/tools.cronToHumanReadable",size:880,
    literals:[
      [0xe8,0xf0,0,1,"every minute"],
      [0x180,0x188,0,1,"every %s minutes",0x198],
      [0x1ec,0x1f4,0,1,"every hour"],
      [0x220,0x228,0,1,"every hour at minute %s",0x238],
      [0x2ac,0x2b4,0,1,"every %s hours",0x2c4],
      [0x31c,0x324,0,1,"daily at %02d:%02d",0x334],
    ],
  },
  {name:"google3/third_party/jetski/cortex/handlers/handlers.cronToHumanReadable",size:1536,
    literals:[
      [0xa4,0xac,0,1,"every minute"],
      [0x148,0x150,0,1,"every %s minutes",0x160],
      [0x2e0,0x2e8,0,1,"every hour"],
      [0x310,0x318,0,1,"every hour at minute %s",0x328],
      [0x3ec,0x3f4,0,1,"every %s hours",0x404],
      [0x540,0x548,0,1,"daily at %02d:%02d",0x558],
    ],
  },
  {name:"google3/third_party/oneharness/internal/tools/tools.(*ScheduleTool).startCron",size:1040,
    verifiedCalls:[[0x48,"google3/third_party/oneharness/internal/tools/tools.cronRenderInfo"]],
    literals:[
      [0x3c,0x44,1,2,"Active"],
      [0x194,0x19c,0,1,"cron (%s)",0x1ac],
    ],
  },
  {name:"google3/third_party/oneharness/internal/tools/tools.scheduleRenderInfo", formats:["> %s\n\n**Status**: %s"]},
  {name:"google3/third_party/oneharness/internal/tools/tools.timerRenderInfo",size:144,
    lengthAliases:[[0x60,5,0x44]],
    verifiedCalls:[[0x64,"google3/third_party/oneharness/internal/tools/tools.scheduleRenderInfo"]],
    literals:[
      [0x58,0x60,0,1,"Timed"],
    ],
  },
  {name:"google3/third_party/oneharness/internal/tools/tools.cronRenderInfo",size:144,
    lengthAliases:[[0x5c,7,0x4c]],
    verifiedCalls:[[0x60,"google3/third_party/oneharness/internal/tools/tools.scheduleRenderInfo"]],
    literals:[
      [0x54,0x5c,0,1,"Scheduled"],
    ],
  },
  {name:stateLabel, formats:["Creating workspaces... (%ds)"]},
  {name:render + 'fmtDuration', formats:["%dm %ds", "%ds"]},
  {name:'google3/third_party/jetski/cli/model/model.compactingLabel', size:416,
    verifiedCalls:[[0x104,render + 'fmtDuration']],
    literals:[
      [0x4c,0x54,0,1,'%s… (esc to cancel)',0x64],
      [0x14c,0x154,0,1,'%s… (%s · esc to cancel)',0x164],
    ],
  },
  {name:'google3/third_party/jetski/cli/model/model.(*PromptModel).interruptedLine', size:320,
    verifiedCalls:[[0x30,'google3/third_party/jetski/cli/model/model.isCompactCancelled']],
    literals:[
      [0xe0,0xe8,0,1,'  ⎿  Interrupted · What should %s do instead?',0xf8],
      [0x108,0x110,0,1,'  ⎿  Compaction cancelled. Conversation was not compacted.'],
    ],
  },
  cliTipProfile,
  {name:render + 'EscHint', formats:["%s to cancel"]},
  {name:render + 'RenderRecitations', size:2208, guards:[[0x4a4,0x9a831041],[0x4b8,0x9a831040]], literals:[
    [0x4a8,0x49c,2,2,'ctrl+o to collapse'], [0x4b0,0x4a0,3,3,'ctrl+o to expand'],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.HelpModel.renderGeneralTab', size:3968, literals:[
    [0xe4,0xec,3,4,' understands your codebase, makes edits with your permission,\nand executes commands — right from your terminal.'],
    [0x1cc,0x1d4,0,1,'Version %s',0x1e4], [0x8f4,0x8fc,0,1,'Workspace:      %s',0x90c],
    [0xa3c,0xa44,0,1,'Project Config: %s',0xa54], [0xbcc,0xbd4,0,1,'Log File:       %s',0xbe4],
    [0xcb0,0xcb8,0,1,'Conversation:   %s',0xcc8], [0xdec,0xdf4,0,1,'Trajectory:     %s',0xe04],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.HelpModel.renderTabBar', formats:["  (%s/%s or %s to cycle)"]},
  {name:'google3/third_party/jetski/cli/model/model.WorkspaceTrustModel.View', formats:[
    "Do you trust the contents of this project?\n\n",
    "%s requires permission to read, edit, and execute files here.\n\n",
  ]},
  {name:'google3/third_party/jetski/cli/model/model.HelpModel.Update.func1', size:176, literals:[
    [0x68,0x70,2,3,'Exited /help command'],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.StatusLineModel.renderHint', formats:["press %s again to exit"]},
  {name:'google3/third_party/jetski/cli/messages/messages.ResumeHint', formats:["\nResume with -c (or command below):\nagy --conversation=%s\n"]},
  {name:"google3/third_party/jetski/cli/model/model.SettingsModel.renderTabBar", formats:["  (%s to cycle)"]},
  {name:"google3/third_party/jetski/cli/model/model.SettingsModel.renderFieldLines", size:5056,
    verifiedCalls:[[0x964,"runtime.concatstring2"],[0xcf8,"runtime.concatstring2"],[0xdcc,"runtime.concatstring2"]],
    literals:[
      [0x4a4,0x4ac,0,1,"    Type value, %s to save, %s to cancel",0x4c0],
      [0x950,0x958,3,4," (disabled)"],
      [0xdc0,0xdc8,3,4," (disabled by admin)"],
      [0xcc4,0xcc0,2,1,' (current)'],
      [0xcf0,0xce0,1,2,' (current)'],
      [0xd08,0xd04,2,1,' (current)'],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.SettingsModel.RenderHeader", size:2992,
    verifiedCalls:[[0x4dc,"runtime.concatstring3"],[0x618,"runtime.concatstring3"],
      [0x98c,"google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.JoinHorizontal"]],
    literals:[
      [0x954,0x95c,3,4,"  Search: "],
      [0x4d4,0x4b4,1,2,'  Search: '],
      [0x610,0x5f0,1,2,'  Search: '],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.SelectorModel.renderSearchBar", size:784,
    verifiedCalls:[[0x2d4,"google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.JoinHorizontal"]],
    literals:[
      [0x29c,0x2a4,3,4,"  Search: "],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.SelectorModel.View", formats:["No models match %q"]},
  {name:"google3/third_party/jetski/cli/model/model.ConversationPickerModel.renderTabBar", formats:["  (%s to cycle)"]},
  {name:"google3/third_party/jetski/cli/model/model.ConversationPickerModel.RenderHeader", formats:["(Error: %v)"]},
  {name:"google3/third_party/jetski/cli/model/model.AgentsModel.renderSubagentTipFooter", formats:["Tip: Press %s on a subagent to view details."]},
  {name:"google3/third_party/jetski/cli/render/render.AltScreenHint", formats:["⚠ terminal %q does not support alt screen"]},
  {name:"google3/third_party/jetski/cli/model/model.settingFields.func1.10", size:192,
    verifiedCalls:[[0x90,"runtime.concatstring3"]],
    literals:[
      [0x78,0x80,1,2," (overridden by "],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.settingFields.func1.36", size:112,
    literals:[
      [0x54,0x5c,0,1," (overridden by --sandbox)"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.settingFields.func1.42", size:16,
    guards:[[0xc,0xd65f03c0]],
    literals:[
      [0x0,0x8,0,1," (overridden by --disable_telemetry)"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.settingFields.func1.37", size:752,
    verifiedCalls:[[0x2cc,"runtime.concatstring2"]],
    literals:[
      [0x168,0x170,0,1,"Disabled for Business accounts. %s does not collect any of your prompts, content, or model responses, but will still collect general usage patterns.",0x180],
      [0x228,0x230,0,1,"When toggled on, %s collects usage data to help Google enhance performance and features",0x240],
      [0x2b8,0x2c0,3,4,". Note that this setting only controls CLI-level telemetry. It does not affect data logging, content retention, or privacy settings for your Gemini API key, which are governed by your GCP/API project settings."],
  ]},
  {name:"google3/third_party/jetski/cli/layout/layout.Column.Apply", formats:["  [%d-%d of %d items]"]},
  {name:"google3/third_party/jetski/cli/model/model.SuggestionModel.View", formats:["   ↑ %d more", "   ↓ %d more"]},
  {name:"google3/third_party/jetski/cli/model/model.ArgSuggestionModel.View", formats:["   ↑ %d more", "   ↓ %d more"]},
  {name:"google3/third_party/jetski/cli/model/model.AtSuggestionModel.View", formats:["   ↑ %d more", "   ↓ %d more"]},
  {name:"google3/third_party/jetski/cli/model/model.LiveCodeSearchModel.View", formats:["+%d more"]},
  {name:"google3/third_party/jetski/cli/model/model.(*DiffModel).viewFileList", formats:["  [%d-%d of %d files]"]},
  {name:"google3/third_party/jetski/cli/model/model.(*DiffModel).viewTurnFileList", formats:["  [%d-%d of %d rows]"]},
  {name:"google3/third_party/jetski/cli/model/model.(*DiffModel).commitTreeRange", formats:["[%d-%d of %d commits]"]},
  {name:'google3/third_party/jetski/cli/model/model.liveSettingFields', formats:["How fast the agent speaks (%gx to %gx). Applies at once."]},
  {name:"google3/third_party/jetski/cli/model/model.ContextModel.header", size:320,
    verifiedCalls:[[0x100,"google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render"]],
    literals:[
      [0xa8,0xb0,2,3,"└ Context Usage"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ContextModel.footer", size:320,
    verifiedCalls:[[0x100,"google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render"]],
    literals:[
      [0xa8,0xb0,2,3,"Related: /artifact · /skill · /rewind"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ContextModel.scrollableBody", size:5280,
    verifiedCalls:[[0xdec,"google3/third_party/jetski/cli/model/model.ContextModel.renderFileSection"],[0xf6c,"google3/third_party/jetski/cli/model/model.ContextModel.renderFileSection"],[0x10ec,"google3/third_party/jetski/cli/model/model.ContextModel.renderFileSection"],[0x1270,"google3/third_party/jetski/cli/model/model.ContextModel.renderFileSection"]],
    literals:[
      [0xdd4,0xddc,6,7,"Knowledge files"],
      [0xf54,0xf5c,6,7,"Artifact files"],
      [0x10d4,0x10dc,6,7,"Skill files"],
      [0x1258,0x1260,6,7,"System files"],
      [0x1264,0x126c,8,9,"auto-loaded"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ContextModel.renderGrid", size:2832,
    verifiedCalls:[[0xa30,"google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render"]],
    literals:[
      [0x9d8,0x9e0,3,5,"No steps yet"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ContextModel.renderStats", size:4720,
    guards:[[0xc40,0x9a8710a3],[0xc54,0x9a8710a2]],
    literals:[
      [0x13c,0x144,0,1,"%s · %s/%s tokens\n (%.1f%%)\n",0x158],
      [0x280,0x288,0,1,"%s · %s/Unknown tokens\n",0x29c],
      [0x374,0x37c,3,4,"Token usage by category"],
      [0x4ac,0x4b4,3,4,"Estimated usage (awaiting generation)"],
      [0x5e4,0x5ec,3,4,"Estimated after compaction · updates next turn"],
      [0x8e4,0x8ec,2,3,"User messages"],
      [0x94c,0x954,2,3,"Agent responses"],
      [0x9ac,0x9b4,2,3,"Tool calls"],
      [0xa10,0xa18,2,3,"System prompt"],
      [0xa6c,0xa74,2,3,"System tools"],
      [0xac8,0xad0,2,3,"System overhead"],
      [0xb24,0xb2c,2,3,"Rules"],
      [0xb80,0xb88,2,3,"Skills"],
      [0xbdc,0xbe4,2,3,"Subagents"],
      [0xcb4,0xcbc,2,3,"Workflows"],
      [0xd10,0xd18,2,3,"Plugins"],
      [0xd6c,0xd74,2,3,"MCP tools"],
      [0xdc8,0xdd0,2,3,"System messages"],
      [0xf0c,0xf14,0,1,"%s Free space: %s (%.1f%%)\n",0xf28],
      [0x10b4,0x10bc,0,1,"%s Checkpoint buffer: %s tokens (not counted in usage)\n",0x10d0],
      [0xc44,0xc38,5,5,"Legacy workflows"],
      [0xc4c,0xc3c,7,7,"Workflows"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ContextModel.renderCheckpoints", formats:[
    "Checkpoints (%d)",
    "steps %d–%d",
    "└ Checkpoint %d (active, in context): ",
    "  %d historical checkpoint(s) (summarized, not in context)",
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ContextModel.renderFileSection", formats:[" └ %s: %s tokens"]},
  {name:"google3/third_party/jetski/cli/model/model.ContextModel.renderStats.func1", formats:["%s %s: %s tokens (%.1f%%)\n"]},
  {name:"google3/third_party/jetski/cli/model/model.AgentsModel.Update.func1", size:560,
    literals:[
      [0x64,0x6c,2,3,"Exited /agents command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ArtifactViewModel.Update.func4", size:160,
    literals:[
      [0x60,0x68,2,3,"Exited /artifact command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ArtifactViewModel.Update.func3", size:160,
    literals:[
      [0x60,0x68,2,3,"Exited /artifact command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.ArtifactViewModel.Update.func2", size:160,
    literals:[
      [0x60,0x68,2,3,"Exited /artifact command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.CreditsModel.Update.func1", size:160,
    literals:[
      [0x60,0x68,2,3,"Exited /credits command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.(*DiffModel).diffDismissCmd.func1", size:160,
    literals:[
      [0x34,0x3c,3,4,"Exited /diff command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.(*DiffModel).diffDismissWithoutSendCmd.func1", size:96,
    literals:[
      [0x28,0x30,3,4,"Exited /diff command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.EffortSelectorModel.Update.func1", size:160,
    literals:[
      [0x60,0x68,2,3,"Exited /effort command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.HooksModel.updateTypeList.func1", size:112,
    literals:[
      [0x2c,0x34,3,4,"Exited /hooks command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.SelectorModel.Update.func1", size:160,
    literals:[
      [0x60,0x68,2,3,"Exited /model command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.SkillsModel.updateList.func1", size:160,
    literals:[
      [0x60,0x68,2,3,"Exited /skills command"],
  ]},
  {name:"google3/third_party/jetski/cli/model/model.TasksModel.updateList.func1", size:160,
    literals:[
      [0x60,0x68,2,3,"Exited /tasks command"],
  ]},
  // X2 also supplies the fallback command-name length before CSEL. Keep its
  // seven-byte prefix while translating the display-only suffix separately.
  {name:'google3/third_party/jetski/cli/model/model.SettingsModel.exitCmd.func1', size:224,
    sharedLengths:[0x30], verifiedCalls:[[0x64,'runtime.concatstring3']], literals:[
    [0x50,0x30,1,2,'Exited '], [0x58,0x60,5,6,' command'],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.AuthModel.renderFullView', size:2832,
    verifiedCalls:[[0xbc,'runtime.concatstring3']], literals:[
      [0xb4,0x98,1,2,'Welcome to the '],
      [0xa4,0xac,5,6,'. You are currently not signed in.\n\n'],
      [0xd8,0xd4,0,1,'Welcome back! You are currently not signed in.\n\n'],
      [0x200,0x208,5,6,' Signing in...'],
      [0x378,0x380,3,4,' Signing in...'],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.UsageModel.header', size:1072,
    verifiedCalls:[[0x2bc,'runtime.concatstring3']], literals:[
      [0x9c,0xa4,2,3,'└ Models & Quota'],
      [0x2b4,0x294,1,2,'  Account: '],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.UsageModel.scrollableContent', size:2560, literals:[
    [0x49c,0x4a4,3,4,'Loading quota summary...'],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.UsageModel.renderPlanSection', size:1856, literals:[
    [0xc8,0xd0,4,5,'PLAN'],
    [0x24c,0x254,0,1,'  Your Plan: %s\n',0x264],
    [0x5a4,0x588,1,2,'  Upgrade at: '],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.UsageModel.renderQuotaGroup', formats:["Disabled: %s"]},
  {name:'google3/third_party/jetski/cli/model/model.UsageModel.renderCreditsSection', formats:["  AI Credit Overages: %s\n", "  Available AI Credits: %s\n"]},
  {name:'google3/third_party/jetski/cli/model/model.quotaStatus', size:272,
    verifiedCalls:[[0xbc,'runtime.concatstring2']], literals:[
      [0x68,0x70,0,1,'Quota exhausted'],
      [0xb4,0xa4,1,2,'Refreshes in '],
      [0xcc,0xd4,0,1,'Quota available'],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.AgentsModel.RenderHeader', size:1888,
    verifiedCalls:[[0x3b4,'runtime.concatstring2'],[0x534,'runtime.concatstring2']], literals:[
      [0x118,0x120,2,3,'fork the current conversation'],
      [0x134,0x13c,2,3,'create a new conversation'],
      [0x16c,0x174,0,1,'[ Switch will %s on exit ]',0x184],
      [0x1f0,0x1f8,3,4,'  [ Loading agents... ]'],
      [0x248,0x250,3,4,'  [ Selecting agent... ]'],
      [0x2a4,0x2ac,3,4,'Create New Agents'],
      [0x3ac,0x39c,1,2,'Workspace: '],
      [0x528,0x530,1,2,'Global: '],
  ]},
  {name:'google3/third_party/jetski/cli/model/model.StatusLineModel.renderRight', formats:["%d task(s) · /tasks"]},
  {name:render + 'editDiffDetail', optional:true,
    formats:['Added %d line%s', 'Removed %d line%s', 'Wrote %d lines'],
    pluralSuffixes:['Added %d line%s', 'Removed %d line%s']},
  {name:render + 'editDiffDetail', optional:true, resolve:relocateStatusLiteralGroup,
    verifiedCalls:[[0x1c,'runtime.concatstring4']], literals:[[0,8,7,8,' lines',undefined,'cli-diff:']]},
  {name:render + 'editDiffDetail', optional:true, resolve:relocateStatusLiteralGroup,
    literals:[[0,8,0,1,'Wrote 1 line']]},
  {name:'google3/third_party/jetski/cli/model/model.SelectorModel.renderVariantChip', optional:true, formats:['%d of %d']},
  ...toolStatusProfiles,
  ...transcriptStatusProfiles,
  ...authInstructionProfiles,
  ...modelLiteralProfiles,
  ...cliPanelLiteralProfiles,
  ...cliSubagentLiteralProfiles,
  ...subagentRunStatusProfiles,
  ...cliSwarmLiteralProfiles,
  ...cliSwarmToolLiteralProfiles,
  ...cloudLoginLiteralProfiles.map(profile => ({...profile, resolve:relocateStatusLiteralGroup})),
  ...cliOnboardingLiteralProfiles,
  ...feedbackLiteralProfiles,
];

function uniqueFunction(metadata, name, size) {
  const fn = metadata.functions instanceof Map ? metadata.functions.get(name) : metadata.functions.find(fn => fn.name === name);
  if (!fn || metadata.ambiguousFunctions?.has(name) || (size && fn.size !== size)) {
    throw new CliCompatibilityError(`CLI 状态显示入口已变化：${name}`);
  }
  return fn;
}

function literalAddress(buffer, metadata, fn, offset, register) {
  if (offset < 0 || offset + 8 > fn.size) throw new CliCompatibilityError('CLI 状态文案地址超出函数');
  const position = fn.fileOffset + offset, adrp = buffer.readUInt32LE(position), add = buffer.readUInt32LE(position + 4);
  if (((adrp & 0x9f00001f) >>> 0) !== (0x90000000 | register) >>> 0 ||
      ((add & 0xffc003ff) >>> 0) !== (0x91000000 | (register << 5) | register) >>> 0) {
    throw new CliCompatibilityError(`CLI 状态文案指针布局已变化：${fn.name}+0x${offset.toString(16)}`);
  }
  return pageAddress(adrp, metadata.imageBase + fn.rva + offset) + ((add >>> 10) & 0xfff);
}

function readString(buffer, metadata, address, length) {
  const offset = fileOffsetFor(metadata, address, length);
  try { return decoder.decode(buffer.subarray(offset, offset + length)); }
  catch (error) {
    if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error;
    throw new CliCompatibilityError('CLI 显示文案已不是 UTF-8');
  }
}

function callTarget(word, pc) {
  if (((word & 0xfc000000) >>> 0) !== 0x94000000) return null;
  let immediate = word & 0x3ffffff;
  if (immediate >= 0x2000000) immediate -= 0x4000000;
  return pc + immediate * 4;
}

// Go passes the format as (X0,X1) and its argument slice as (X2,X3,X4).
// Resolve both inputs at fmt.Sprintf itself so stack-frame and function size
// changes do not invalidate a display string. Require one site per expected text.
function locateFormats(buffer, metadata, fn, sprintf, formats) {
  const word = offset => buffer.readUInt32LE(fn.fileOffset + offset);
  const matches = new Map(), lengths = new Set(formats.map(value => Buffer.byteLength(value)));
  for (let call = 24; call + 4 <= fn.size; call += 4) {
    if (callTarget(word(call), metadata.imageBase + fn.rva + call) !== metadata.imageBase + sprintf.rva) continue;
    let args = call - 12;
    if (word(call - 4) === 0xaa0303e4 && stringLengthImmediate(word(call - 8), 3) !== null) {
      // ADD X2,SP,#offset, optionally followed by ADD X2,X2,#offset.
      if (((word(args) & 0xff8003ff) >>> 0) === 0x91000042) args -= 4;
      if (args < 12 || ((word(args) & 0xff8003ff) >>> 0) !== 0x910003e2) continue;
    } else if (word(args) !== 0xaa1f03e2 || word(call - 8) !== 0xaa1f03e3 || word(call - 4) !== 0xaa1f03e4) {
      continue;
    }
    const size = stringLengthImmediate(word(args - 4), 1), pointer = args - 12;
    if (!lengths.has(size) || ((word(pointer) & 0x9f00001f) >>> 0) !== 0x90000000 ||
        ((word(pointer + 4) & 0xffc003ff) >>> 0) !== 0x91000000) continue;
    const address = literalAddress(buffer, metadata, fn, pointer, 0);
    const original = readString(buffer, metadata, address, size);
    if (!formats.includes(original)) continue;
    if (matches.has(original)) throw new CliCompatibilityError(`CLI 状态格式文案存在多个匹配位置：${fn.name}`);
    matches.set(original, [pointer, args - 4, 0, 1, original, call]);
  }
  if (matches.size !== formats.length) throw new CliCompatibilityError(`CLI 状态格式文案已变化：${fn.name}`);
  return formats.map(original => matches.get(original));
}

function collectQuotaDescriptionPrefix(buffer, metadata, translate) {
  const fn = uniqueFunction(metadata,'google3/third_party/jetski/cli/model/model.UsageModel.renderQuotaGroup',4160);
  const concat3 = uniqueFunction(metadata,'runtime.concatstring3');
  const concat5 = uniqueFunction(metadata,'runtime.concatstring5',160);
  const words = [0xb27f03e2,0xaa0003e3,0xaa0103e4,0,0,0xaa0203e6,0x910dc3e0];
  if (words.some((word,index) => word && buffer.readUInt32LE(fn.fileOffset + 0x260 + index * 4) !== word) ||
      readString(buffer,metadata,literalAddress(buffer,metadata,fn,0x26c,5),2) !== '\n\n' ||
      readString(buffer,metadata,literalAddress(buffer,metadata,fn,0x27c,1),2) !== '  ' ||
      callTarget(buffer.readUInt32LE(fn.fileOffset + 0x284),metadata.imageBase + fn.rva + 0x284) !== metadata.imageBase + concat3.rva) {
    throw new CliCompatibilityError('CLI 模型列表说明拼接入口已变化');
  }
  const original = 'Models within this group: ', translated = translate(original);
  if (!translated || translated === original) return null;
  return {kind:'quota-description-prefix',functionName:fn.name,original,translated,
    rva:fn.rva + 0x27c,fileOffset:fn.fileOffset + 0x27c,
    indentAddress:literalAddress(buffer,metadata,fn,0x27c,1),
    callRva:fn.rva + 0x284,callFileOffset:fn.fileOffset + 0x284,
    targetAddress:metadata.imageBase + concat5.rva,
    contextFileOffset:fn.fileOffset + 0x25c,
    originalContext:Buffer.from(buffer.subarray(fn.fileOffset + 0x25c,fn.fileOffset + 0x288))};
}

// Reuse the native Go concat call and its allocation/GC frame. The display
// string becomes indent + original ANSI prefix + Chinese label + model list +
// newline. Unknown descriptions use the same five arguments with two empty
// middle strings; their bytes and formatting stay exactly the same.
function quotaDescriptionPrefixCode(patch, address, translatedAddress, imageBase) {
  const words = [], labels = new Map(), fixups = [];
  const emit = word => words.push(word >>> 0);
  const label = name => labels.set(name,words.length * 4);
  const branch = (name,word,bits=19) => {fixups.push({name,word,bits,index:words.length});emit(word);};
  const mov = (to,from) => emit(0xaa0003e0 | (from << 16) | to);
  const cmpImm = (register,value) => emit(0xf100001f | (value << 10) | (register << 5));
  addressInstructions(1,patch.indentAddress,address).forEach(emit);
  mov(9,5);mov(10,6); // Preserve the newline as concatstring5's fifth string.
  mov(5,31);mov(6,31);mov(7,31);mov(8,31);
  mov(11,3);mov(12,4);
  label('leading');
  branch('done',0xb400000c); // cbz x12,done
  emit(0x3940016f); // ldrb w15,[x11]
  cmpImm(15,27);branch('prefix',0x54000001); // b.ne prefix
  cmpImm(12,2);branch('done',0x54000003); // b.lo done
  emit(0x3940056f);cmpImm(15,91);branch('done',0x54000001); // CSI introducer
  emit(0x9100096b);emit(0xd100098c); // skip ESC[
  label('csi');
  branch('done',0xb400000c);
  emit(0x3840156f);emit(0xd100058c); // ldrb w15,[x11],#1; remaining--
  cmpImm(15,0x40);branch('csi',0x54000003);
  cmpImm(15,0x7e);branch('csi',0x54000008);
  cmpImm(15,0x6d);branch('done',0x54000001); // Only SGR styling is skipped.
  branch('leading',0x14000000,26);
  label('prefix');
  const length = Buffer.byteLength(patch.original);
  cmpImm(12,length);branch('done',0x54000003);
  const sourceAddressIndex = words.length;emit(0);emit(0);
  emit(0xd280000e | (length << 5));mov(15,11);
  label('bytes');
  emit(0x384015f0);emit(0x384015b1); // source/expected byte, with post increment
  emit(0x6b11021f);branch('done',0x54000001); // cmp w16,w17; b.ne done
  emit(0xd10005ce);branch('bytes',0xb500000e);
  emit(0xcb030164); // sub x4,x11,x3: retain the original ANSI prefix.
  addressInstructions(5,translatedAddress,address + words.length * 4).forEach(emit);
  emit(0xd2800006 | (Buffer.byteLength(patch.translated) << 5));
  mov(7,15);emit(0xd1000188 | (length << 10)); // suffix = source after English prefix
  label('done');
  emit(relativeBranch(0x14000000,address + words.length * 4,imageBase + patch.callRva));
  const sourceAddress = address + words.length * 4;
  addressInstructions(13,sourceAddress,address + sourceAddressIndex * 4)
    .forEach((word,index) => {words[sourceAddressIndex + index] = word;});
  for (const fixup of fixups) {
    const delta = (labels.get(fixup.name) - fixup.index * 4) / 4;
    const mask = fixup.bits === 26 ? 0x3ffffff : 0x7ffff;
    words[fixup.index] = (fixup.word | ((delta & mask) << (fixup.bits === 26 ? 0 : 5))) >>> 0;
  }
  const data = Buffer.from(patch.original), output = Buffer.alloc(Math.ceil((words.length * 4 + data.length) / 4) * 4);
  words.forEach((word,index) => output.writeUInt32LE(word,index * 4));
  data.copy(output,words.length * 4);
  return output;
}

function fixedUiColumns(value) {
  let columns = 0;
  const graphemes = new Intl.Segmenter('zh', {granularity:'grapheme'}).segment(value);
  for (const {segment} of graphemes) {
    if (/^[\p{Mark}\p{Cf}]+$/u.test(segment)) continue;
    columns += /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u.test(segment) ? 2 : 1;
  }
  return columns;
}

function collectTaskStatusWidths(buffer, metadata, translate, delta) {
  const deltas = Object.fromEntries(['running','cancelled','failed','completed',' (exit %d)'].map(original => {
    const rendered = translate(original) ?? original;
    return [original,Buffer.byteLength(rendered) - fixedUiColumns(rendered)];
  }));
  if (!Object.values(deltas).some(Boolean)) return null;
  if (!Object.values(deltas).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xfff)) {
    throw new Error('CLI 任务状态列宽修正超出立即数范围');
  }
  const fn = uniqueFunction(metadata,taskListView);
  return {...inspectTaskStatusWidths(buffer,metadata,fn,delta), deltas};
}

function collectCompactionMarkerWidths(buffer, metadata, translate) {
  const deltas = ['Conversation compacted','Compacted'].map(original => {
    const rendered = translate(original) ?? original;
    return Buffer.byteLength(rendered) - fixedUiColumns(rendered);
  });
  if (!deltas.some(Boolean)) return null;
  if (!deltas.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xfff)) {
    throw new Error('CLI 压缩横幅列宽修正超出立即数范围');
  }
  const fn = uniqueFunction(metadata,compactionMarker,512);
  // The current title header stays at SP+0x320 across both strings.Repeat
  // calls. Its two possible addresses identify the long and short labels.
  for (const [offset,word] of [[0x2c,0x910ca3fb],[0x30,0xa9002367],
    [0x40,0x910ce3fb],[0x44,0xa9002367],[0x48,0x910ca3e7],
    [0x60,0xf94193e8],[0x64,0x91004107],[0x70,0xf100081f],
    [0x7c,0xf90193e7],[0x80,0xa94010e3],
    [0xac,0xf9017fe1],[0xd8,0xf9417fe3],[0x10c,0xf9417fe4]]) {
    if (buffer.readUInt32LE(fn.fileOffset + offset) !== word) throw new CliCompatibilityError('CLI 压缩横幅标题来源已变化');
  }
  const sites = [[0xa4,1,5,0xeb02003f],[0xb4,1,16,0xcb010043],[0xe0,3,5,0x8b440463]].map(([offset,register,operandShift,word]) => {
    if (buffer.readUInt32LE(fn.fileOffset + offset) !== word) throw new CliCompatibilityError('CLI 压缩横幅列宽消费者已变化');
    return {rva:fn.rva + offset,fileOffset:fn.fileOffset + offset,register,operandShift,word};
  });
  return {imageBase:metadata.imageBase,deltas,sites};
}

function relativeBranch(word, from, to, bits = 26) {
  const delta = (to - from) / 4;
  if (!Number.isSafeInteger(delta) || delta < -(2 ** (bits - 1)) || delta >= 2 ** (bits - 1)) {
    throw new Error('CLI 任务状态列宽跳转超出范围');
  }
  return (word | ((delta & (2 ** bits - 1)) << (bits === 26 ? 0 : 5))) >>> 0;
}

function taskStatusWidthCode(plan, site, address) {
  const words = [], labels = new Map(), fixups = [];
  const emit = word => words.push(word >>> 0);
  const branch = (label, word, bits = 26) => { fixups.push({label,word,bits,offset:words.length * 4}); emit(word); };
  const label = name => labels.set(name,words.length * 4);
  const ldrb = offset => emit(0x39400000 | (offset << 10) | (16 << 5) | 17);
  const subtract = delta => emit(0xd1000000 | (delta << 10) | (site.register << 5) | site.register);
  emit(site.word);
  emit(0x91400000 | (Math.floor(plan.taskFrameOffset / 4096) << 10) | (31 << 5) | 16);
  emit(0x91000000 | ((plan.taskFrameOffset % 4096) << 10) | (16 << 5) | 16);
  ldrb(0x18); branch('running',0x37000011,14); // tbnz w17,#0
  ldrb(0x41); branch('notCancelled',0x36000011,14);
  emit(0xb9400000 | ((0x44 / 4) << 10) | (16 << 5) | 17);
  emit(0x51000000 | (6 << 10) | (17 << 5) | 17); // sub w17,w17,#6; no NZCV change
  branch('cancelled',0x34000011,19);
  label('notCancelled'); ldrb(0x30); branch('failed',0x37000011,14);
  subtract(plan.deltas.completed); branch('suffix',0x14000000);
  label('failed'); subtract(plan.deltas.failed);
  label('suffix'); ldrb(0x40); branch('done',0x37000011,14);
  subtract(plan.deltas[' (exit %d)']); branch('done',0x14000000);
  label('running'); subtract(plan.deltas.running); branch('done',0x14000000);
  label('cancelled'); subtract(plan.deltas.cancelled);
  label('done'); emit(relativeBranch(0x14000000,address + words.length * 4,plan.imageBase + site.rva + 4));
  for (const fix of fixups) words[fix.offset / 4] = relativeBranch(fix.word,address + fix.offset,address + labels.get(fix.label),fix.bits);
  const code = Buffer.alloc(words.length * 4); words.forEach((word,index) => code.writeUInt32LE(word,index * 4));
  return code;
}

function compactionMarkerWidthCode(plan, site, address) {
  const words = [], emit = word => words.push(word >>> 0);
  const subtract = delta => emit(0xd1000000 | (delta << 10) | (site.register << 5) | 16);
  if (plan.deltas[0] === plan.deltas[1]) subtract(plan.deltas[0]);
  else {
    emit(0xf9400000 | ((0x320 / 8) << 10) | (31 << 5) | 16); // ldr x16,[sp,#0x320]
    emit(0x91000000 | (0x328 << 10) | (31 << 5) | 17); // add x17,sp,#0x328
    emit(0xcb000000 | (17 << 16) | (16 << 5) | 16); // sub x16,x16,x17; no NZCV change
    emit(0xb5000000 | (3 << 5) | 16); // cbnz x16,short
    subtract(plan.deltas[0]);
    emit(0x14000002); // b selected
    subtract(plan.deltas[1]);
  }
  // Only the first site intentionally sets flags (the original CMP). The
  // other two preserve NZCV, X1 and the true byte length at SP+0x2f8.
  emit((site.word & ~(31 << site.operandShift)) | (16 << site.operandShift));
  emit(relativeBranch(0x14000000,address + words.length * 4,plan.imageBase + site.rva + 4));
  const code = Buffer.alloc(words.length * 4); words.forEach((word,index) => code.writeUInt32LE(word,index * 4));
  return code;
}

/** Collect display literals and UI-only tables; source strings stay untouched. */
export function collectCliStatusLocalizationPatches(buffer, dictionary, metadata = inspectNativeBinary(buffer), { codeSpace } = {}) {
  if (Array.isArray(metadata.functions)) metadata = {...metadata, functions:new Map(metadata.functions.map(fn => [fn.name,fn]))};
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const patches = [], missing = [], casePatches = [], formats = value => value.match(/%[-+# 0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[a-zA-Z%]/g) ?? [];
  const translate = (original, namespace = 'cli-ui:') => {
    const value = strings[namespace + original] ?? (namespace === 'cli-ui:' ? strings[original] : undefined);
    return typeof value === 'string' && value ? value : undefined;
  };
  const add = (patch, namespace = 'cli-ui:', displayLabel = patch.original) => {
    const translated = translate(displayLabel, namespace);
    if (typeof translated !== 'string' || !translated) { missing.push({functionName:patch.functionName, original:patch.original}); return; }
    if (translated === patch.original) return;
    if (patch.sharedLength && Buffer.byteLength(translated) !== patch.sourceLength) {
      throw new Error(`CLI 共享长度文案需保持 ${patch.sourceLength} 字节：${patch.original}`);
    }
    const originalFormats = formats(patch.original);
    const translatedFormats = formats(translated).map(format =>
      patch.wrapsError && format === '%.0w' ? '%w' : format);
    // Some counters pass an English noun or plural suffix as the second argument.
    // The localized template consumes that argument at zero precision.
    const validFormats = (patch.countNoun || patch.pluralSuffix)
      ? JSON.stringify(originalFormats) === '["%d","%s"]' && JSON.stringify(translatedFormats) === '["%d","%.0s"]'
      : JSON.stringify(originalFormats) === JSON.stringify(translatedFormats);
    if (!validFormats) {
      throw new Error(`CLI 状态译文改变了格式参数：${patch.original}`);
    }
    patches.push({...patch, translated});
  };
  const unsupported = [];
  // A display function's strings, case handling and width calculation are one unit.
  // Discard every planned write from that unit if any required source has changed.
  function collectGroup(name, inspect) {
    const counts = [patches.length, missing.length, casePatches.length];
    try { return inspect(); }
    catch (error) {
      if (!(error instanceof CliCompatibilityError)) throw error;
      [patches.length, missing.length, casePatches.length] = counts;
      unsupported.push(name);
      return null;
    }
  }
  function checkReachable(sites) {
    if (codeSpace && sites?.some(site => !cliSiteReachesCodeSpace(metadata.imageBase, site, codeSpace))) {
      throw new CliCompatibilityError('CLI 状态显示入口超出当前代码区');
    }
  }
  function collectProfile(profile) {
    const fn = profile.variant ?? uniqueFunction(metadata, profile.name, profile.size);
    const needsSprintf = profile.formats || profile.literals.some(literal => literal[5] !== undefined);
    const sprintf = needsSprintf ? uniqueFunction(metadata, 'fmt.Sprintf') : null;
    const literals = profile.formats ? locateFormats(buffer, metadata, fn, sprintf, profile.formats) : profile.literals;
    for (const [offset, word] of profile.guards ?? []) if (buffer.readUInt32LE(fn.fileOffset + offset) !== word) {
      throw new CliCompatibilityError(`CLI 状态条件选择已变化：${fn.name}`);
    }
    for (const [offset, name] of profile.verifiedCalls ?? []) {
      const callee = uniqueFunction(metadata, name);
      if (offset < 0 || offset + 4 > fn.size ||
          callTarget(buffer.readUInt32LE(fn.fileOffset + offset), metadata.imageBase + fn.rva + offset) !== metadata.imageBase + callee.rva) {
        throw new CliCompatibilityError(`CLI 状态文案调用已变化：${fn.name}+0x${offset.toString(16)}`);
      }
    }
    const countNouns = new Map();
    for (const [referenceOffset, register, original, formatOffset, formatCall] of profile.countNouns ?? []) {
      const headerAddress = literalAddress(buffer,metadata,fn,referenceOffset,register);
      const headerOffset = fileOffsetFor(metadata,headerAddress,16);
      const address = Number(buffer.readBigUInt64LE(headerOffset)), length = Number(buffer.readBigUInt64LE(headerOffset + 8));
      // STP X1,X2,[SP,#offset] installs the boxed string as the second fmt arg.
      if (length !== Buffer.byteLength(original) || readString(buffer,metadata,address,length) !== original ||
          ((buffer.readUInt32LE(fn.fileOffset + referenceOffset + 8) & 0xffc07fff) >>> 0) !== 0xa9000be1 ||
          !literals.some(value => value[0] === formatOffset && value[5] === formatCall) ||
          callTarget(buffer.readUInt32LE(fn.fileOffset + formatCall),metadata.imageBase + fn.rva + formatCall) !== metadata.imageBase + sprintf.rva) {
        throw new CliCompatibilityError(`CLI 工具计数名词参数已变化：${fn.name}`);
      }
      countNouns.set(formatOffset,original);
    }
    for (const [offset, originalWord, resumeOffset, ...originals] of profile.caseGroups ?? []) {
      if (buffer.readUInt32LE(fn.fileOffset + offset) !== originalWord || resumeOffset < 0 || resumeOffset >= fn.size) {
        throw new CliCompatibilityError(`CLI 工具动作大小写分支已变化：${fn.name}`);
      }
      const firstCharacters = originals.map(original => String.fromCodePoint((translate(original) || original).codePointAt(0)));
      if (!firstCharacters.some(first => Buffer.byteLength(first) > 1)) continue; // Keep the original English case path.
      if (!firstCharacters.every(first => Buffer.byteLength(first) > 1 && first.toUpperCase() === first)) {
        throw new Error(`CLI 工具动作需统一使用无大小写的首个字符：${originals.join(' / ')}`);
      }
      // The native English path uppercases s[:1]. A translated Han character
      // already has its final case and must not be split at its first UTF-8 byte.
      casePatches.push({functionName:fn.name,fileOffset:fn.fileOffset + offset,originalWord,
        word:(0x14000000 | ((resumeOffset - offset) / 4)) >>> 0});
    }
    const wrapsError = profile.verifiedCalls?.some(([, name]) => name === 'fmt.errorf');
    for (const [pointerOffset,lengthOffset,pointerRegister,lengthRegister,original,formatCall,namespace] of literals) {
      const sourceLength = Buffer.byteLength(original), sourceAddress = literalAddress(buffer, metadata, fn, pointerOffset, pointerRegister);
      const lengthAlias = profile.lengthAliases?.find(value => value[0] === lengthOffset);
      const lengthWord = buffer.readUInt32LE(fn.fileOffset + lengthOffset);
      const aliasMatches = lengthAlias && lengthAlias[2] >= 0 && lengthAlias[2] + 4 <= fn.size &&
        lengthWord === (0xaa0003e0 | (lengthAlias[1] << 16) | lengthRegister) >>> 0 &&
        stringLengthImmediate(buffer.readUInt32LE(fn.fileOffset + lengthAlias[2]),lengthAlias[1]) === sourceLength;
      if (lengthOffset < 0 || lengthOffset + 4 > fn.size ||
          (stringLengthImmediate(lengthWord, lengthRegister) !== sourceLength && !aliasMatches) ||
          readString(buffer, metadata, sourceAddress, sourceLength) !== original ||
          (formatCall !== undefined && callTarget(buffer.readUInt32LE(fn.fileOffset + formatCall), metadata.imageBase + fn.rva + formatCall) !== metadata.imageBase + sprintf.rva)) {
        throw new CliCompatibilityError(`CLI 状态文案布局已变化：${fn.name}+0x${pointerOffset.toString(16)}`);
      }
      const start = Math.min(pointerOffset,lengthOffset,lengthAlias?.[2] ?? pointerOffset);
      const end = Math.max(pointerOffset + 8, lengthOffset + 4, (formatCall ?? -4) + 4);
      const contextFileOffset = fn.fileOffset + start;
      add({kind:'literal', functionName:fn.name, original, sourceAddress, sourceLength,
        countNoun:countNouns.get(pointerOffset), pluralSuffix:profile.pluralSuffixes?.includes(original),
        sharedLength:profile.sharedLengths?.includes(lengthOffset) ?? false, wrapsError,
        pointerFileOffset:fn.fileOffset + pointerOffset, pointerPc:metadata.imageBase + fn.rva + pointerOffset,
        lengthFileOffset:fn.fileOffset + lengthOffset, pointerRegister, lengthRegister, contextFileOffset,
        originalContext:Buffer.from(buffer.subarray(contextFileOffset, fn.fileOffset + end))}, namespace);
    }
  }
  let statusWidths = null, compactionWidths = null;
  const declarations = literalProfiles.flatMap(profile => profile.allVariants && metadata.functionVariants?.has(profile.name)
    ? metadata.functionVariants.get(profile.name).map(variant => ({...profile, variant})) : [profile]);
  for (const declaration of declarations) {
    if (declaration.optional && !metadata.functions.has(declaration.name)) continue;
    collectGroup(declaration.name, () => {
      const resolve = declaration.resolve ?? resolvePanelStatusProfile;
      const profile = resolve(buffer, metadata, declaration, dictionary);
      collectProfile(profile);
      if (profile.name === taskListView) {
        const plan = collectTaskStatusWidths(buffer,metadata,translate,profile.literals[0][0] - 0x690);
        checkReachable(plan?.sites);
        statusWidths = plan;
      }
      if (profile.name === compactionMarker) {
        const plan = collectCompactionMarkerWidths(buffer,metadata,translate);
        checkReachable(plan?.sites);
        compactionWidths = plan;
      }
    });
  }
  collectCliPanelTables(buffer, metadata, collectGroup, add);
  collectCliSwarmPluginFieldSlots(buffer, metadata, collectGroup, add);
  const collectTable = (fn, address, stride, count, expected, displayLabel) => {
    const base = fileOffsetFor(metadata, address, stride * count);
    for (let index = 0; index < count; index++) {
      const fileOffset = base + index * stride, sourceAddress = Number(buffer.readBigUInt64LE(fileOffset));
      const sourceLength = Number(buffer.readBigUInt64LE(fileOffset + 8));
      if (!Number.isSafeInteger(sourceLength) || sourceLength < 0) throw new CliCompatibilityError('CLI 显示文案表长度已变化');
      const original = sourceLength ? readString(buffer, metadata, sourceAddress, sourceLength) : '';
      if (expected && expected[index] !== original) throw new CliCompatibilityError(`CLI 显示文案表已变化：${fn.name}`);
      if (original) add({kind:'slot', functionName:fn.name, original, sourceAddress, sourceLength, fileOffset,
        contextFileOffset:fileOffset, originalContext:Buffer.from(buffer.subarray(fileOffset,fileOffset + 16))}, undefined, displayLabel);
    }
  };
  collectGroup(stateLabel, () => {
    const labels = uniqueFunction(metadata, stateLabel, 288);
    collectTable(labels, literalAddress(buffer,metadata,labels,0x30,3),16,8,
      ['Initializing agent','','Thinking','Running','Waiting','','Compacting conversation','Loading conversation']);
    const cycleHeader = literalAddress(buffer,metadata,labels,0x6c,27), cycleOffset = fileOffsetFor(metadata,cycleHeader,24);
    if (buffer.readBigUInt64LE(cycleOffset + 8) !== 3n || buffer.readBigUInt64LE(cycleOffset + 16) !== 3n) throw new CliCompatibilityError('CLI 生成状态轮换表已变化');
    // All three labels belong to the response generation state, including incremental output.
    collectTable(labels,Number(buffer.readBigUInt64LE(cycleOffset)),16,3,['Generating','Working','Loading'],'Generating');
  });
  collectGroup('工具活动标签', () => {
    // The map initializer reads a separate 35-element label array and tool-ID
    // array. Only value slots are localized; lookup identities stay untouched.
    const activity = uniqueFunction(metadata, 'google3/third_party/jetski/cli/steps/steps.map.init.0', 256);
    for (const [offset, word] of [[0x20,0xd2800461],[0x48,0xf1008c3f],[0x5c,0x8b011084],
      [0x60,0xa9401484],[0x74,0x8b011084],[0x78,0xa9400c82]]) {
      if (buffer.readUInt32LE(activity.fileOffset + offset) !== word) throw new CliCompatibilityError('CLI 活动标签表读取布局已变化');
    }
    const activityLabels = literalAddress(buffer,metadata,activity,0x54,4);
    const activityKeys = literalAddress(buffer,metadata,activity,0x6c,4);
    const assign = uniqueFunction(metadata, 'runtime.mapassign_faststr');
    if (activityKeys + 35 * 16 !== activityLabels ||
        callTarget(buffer.readUInt32LE(activity.fileOffset + 0x88), metadata.imageBase + activity.rva + 0x88) !== metadata.imageBase + assign.rva) {
      throw new CliCompatibilityError('CLI 活动标签表初始化入口已变化');
    }
    collectTable(activity,activityLabels,16,35,[
      'Reading file','Reading file','Searching','Code searching','Searching internal docs','Searching skills',
      'Finding files','Listing directory','Running command','Checking command','Sending input','Reading page',
      'Searching web','Editing files','Editing files','Editing files','Editing files','Editing files',
      'Editing notebook','Calling MCP tool','Reading resource','Reading resource','Generating image','Delegating',
      'Defining subagent','Managing subagents','Sending message','Checking inbox','Managing tasks','Scheduling',
      'Using browser','Using browser','Using browser','Waiting','Waiting',
    ]);
  });
  collectGroup('语音选项标签', () => {
    // A playback option has a separate display Label and submission Value.
    // Localize the label in the copied option template, keeping Value="other".
    const live = uniqueFunction(metadata, 'google3/third_party/jetski/cli/model/model.liveSettingFields', 1504);
    for (const [offset, word] of [[0x524,0xaa0003e2],[0x528,0xb27e03f8],
      [0x52c,0xacc14430],[0x530,0xac814410],[0x534,0xacc14430],[0x538,0xac814410],
      [0x53c,0xd1000718],[0x540,0xb5ffff78],[0x544,0xad404430],[0x548,0xad004410]]) {
      if (buffer.readUInt32LE(live.fileOffset + offset) !== word) throw new CliCompatibilityError('CLI 语音选项显示表复制已变化');
    }
    const playbackOptions = literalAddress(buffer,metadata,live,0x51c,1);
    const customValue = fileOffsetFor(metadata,playbackOptions + 5 * 48,16);
    if (buffer.readBigUInt64LE(customValue + 8) !== 5n ||
        readString(buffer,metadata,Number(buffer.readBigUInt64LE(customValue)),5) !== 'other') {
      throw new CliCompatibilityError('CLI 自定义语速选项身份已变化');
    }
    collectTable(live,playbackOptions + 5 * 48 + 16,16,1,['other...']);
  });
  collectGroup('额度模型列表前缀', () => {
    const prefix = collectQuotaDescriptionPrefix(buffer,metadata,translate);
    if (prefix) {
      checkReachable([prefix]);
      patches.push(prefix);
    }
  });
  return {imageBase:metadata.imageBase, patches, missing, casePatches, statusWidths, compactionWidths, unsupported};
}

/** Quota titles and descriptions arrive as server-owned strings, not literals. */
export function collectCliUsageDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  if (Array.isArray(metadata.functions)) metadata = {...metadata, functions:new Map(metadata.functions.map(fn => [fn.name,fn]))};
  const prefix = 'google3/third_party/jetski/cli/model/model.';
  const upper = metadata.functions.get('strings.ToUpper');
  const stackAddress = word => (word & 0xffc003ff) >>> 0; // Ignore only the 12-bit stack offset.
  const profiles = [
    // A Go string loaded as one pair and consumed directly by strings.ToUpper.
    {name:'额度分组标题', method:'renderQuotaGroup', span:16, offset:8, pointer:0, length:1,
      matches:(word,pc) => upper && !metadata.ambiguousFunctions?.has(upper.name) &&
        stackAddress(word(0)) === 0x910003fb && stackAddress(word(4)) === 0x9140037b &&
        word(8) === 0xa9400760 && callTarget(word(12),pc + 12) === metadata.imageBase + upper.rva},
    // The period is copied between two specific string slots for Style.Render.
    {name:'额度周期标签', method:'renderQuotaGroup', span:24, offset:8, pointer:4, length:5,
      matches:word => [0x913ffffb,0x9106677b,0xa9401764,0x913ffffb,0x9108e77b,0xa9001764]
        .every((expected,index) => word(index * 4) === expected)},
    // Load the pointer/length from adjacent cells of the same frame, then
    // copy them into the description to be wrapped. Both frame offsets may move.
    {name:'额度说明', method:'renderQuotaDescription', span:24, offset:12, pointer:1, length:2,
      matches:word => stackAddress(word(0)) === 0x914003fb && word(0) === word(8) &&
        stackAddress(word(4)) === 0xf9400361 && stackAddress(word(12)) === 0xf9400362 &&
        ((word(4) >>> 10) & 0xfff) + 1 === ((word(12) >>> 10) & 0xfff) &&
        stackAddress(word(16)) === 0x910003fb && word(20) === 0xa9000b61},
  ];
  const sites = [], unsupported = [];
  for (const profile of profiles) {
    const name = prefix + 'UsageModel.' + profile.method, fn = metadata.functions.get(name);
    const matches = [];
    if (fn && !metadata.ambiguousFunctions?.has(name)) {
      for (let start = 0; start + profile.span <= fn.size; start += 4) {
        const word = delta => buffer.readUInt32LE(fn.fileOffset + start + delta);
        if (profile.matches(word,metadata.imageBase + fn.rva + start)) matches.push(start);
      }
    }
    if (matches.length !== 1) {
      unsupported.push(profile.name);
      continue;
    }
    const start = matches[0], offset = start + profile.offset;
    sites.push({rva:fn.rva + offset, fileOffset:fn.fileOffset + offset, word:buffer.readUInt32LE(fn.fileOffset + offset),
      pointerRegister:profile.pointer, lengthRegister:profile.length, replayFirst:true,
      contextFileOffset:fn.fileOffset + start,
      originalContext:Buffer.from(buffer.subarray(fn.fileOffset + start,fn.fileOffset + start + profile.span))});
  }
  if (!sites.length) throw new CliCompatibilityError('CLI 额度显示数据入口已变化');
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const namespace = 'cli-usage:';
  const entries = Object.entries(strings).filter(([key,value]) => key.startsWith(namespace) &&
    key.length > namespace.length && typeof value === 'string' && value.length > 0)
    .map(([key,translated]) => ({original:key.slice(namespace.length),translated,
      sourceLength:Buffer.byteLength(key.slice(namespace.length))}));
  return {imageBase:metadata.imageBase,entries,sites,matchContent:true,unsupported};
}

/** A count noun is a display copy of the category key; the key stays English. */
export function collectCliSummaryNounDisplayStrings(buffer, dictionary, metadata = inspectNativeBinary(buffer)) {
  const strings = dictionary?.strings ?? dictionary;
  if (!strings || typeof strings !== 'object') throw new TypeError('CLI translations must be an object');
  const fn = uniqueFunction(metadata, render + 'buildFoldLine', 2144), conv = uniqueFunction(metadata, 'runtime.convTstring');
  if (buffer.readUInt32LE(fn.fileOffset + 0x588) !== 0xf94097e0 ||
      buffer.readUInt32LE(fn.fileOffset + 0x58c) !== 0xf94043e1 ||
      callTarget(buffer.readUInt32LE(fn.fileOffset + 0x590), metadata.imageBase + fn.rva + 0x590) !== metadata.imageBase + conv.rva) {
    throw new CliCompatibilityError('CLI 聚合计数名词显示入口已变化');
  }
  const sources = new Map(Object.entries(strings).filter(([key,value]) => key.startsWith('cli-noun:') && typeof value === 'string' && value)
    .map(([key,value]) => [key.slice(9),value]));
  const site = {rva:fn.rva + 0x58c, fileOffset:fn.fileOffset + 0x58c, word:0xf94043e1,
    pointerRegister:0, lengthRegister:1, replayFirst:true};
  return {imageBase:metadata.imageBase, entries:collectCliLiteralEntries(buffer,metadata,sources), sites:[site]};
}

/** Rewrite only verified reference producers, keeping original Go formatting. */
export function applyCliStatusLocalizationPatches(buffer, plan, allocateString, options) {
  for (const patch of plan.patches) if (!buffer.subarray(patch.contextFileOffset, patch.contextFileOffset + patch.originalContext.length).equals(patch.originalContext)) {
    throw new Error(`CLI 状态文案在检查后已变化：${patch.functionName}`);
  }
  for (const patch of plan.casePatches ?? []) if (buffer.readUInt32LE(patch.fileOffset) !== patch.originalWord) {
    throw new Error(`CLI 工具动作大小写分支在检查后已变化：${patch.functionName}`);
  }
  const widthThunks = [], prefixThunks = [];
  let codeBytes = 0;
  const prefixes = plan.patches.filter(patch => patch.kind === 'quota-description-prefix');
  if (plan.statusWidths || plan.compactionWidths || prefixes.length) {
    if (!options || !Number.isSafeInteger(options.codeAddress) || !Number.isSafeInteger(options.codeFileOffset) ||
        !Number.isSafeInteger(options.capacity) || options.codeAddress % 4 || options.codeFileOffset % 4) {
      throw new Error('CLI 显示列宽需要对齐的代码区');
    }
    for (const [widthPlan,buildCode] of [[plan.statusWidths,taskStatusWidthCode],[plan.compactionWidths,compactionMarkerWidthCode]]) {
      for (const site of widthPlan?.sites ?? []) {
        if (buffer.readUInt32LE(site.fileOffset) !== site.word) throw new Error('CLI 显示列宽消费者在检查后已变化');
        const address = options.codeAddress + codeBytes;
        const code = buildCode(widthPlan,site,address);
        widthThunks.push({site,address,code,offset:options.codeFileOffset + codeBytes});
        codeBytes += code.length;
      }
    }
    for (const patch of prefixes) {
      const address = options.codeAddress + codeBytes;
      const code = quotaDescriptionPrefixCode(patch,address,allocateString(Buffer.from(patch.translated)),plan.imageBase);
      prefixThunks.push({patch,address,code,offset:options.codeFileOffset + codeBytes});
      codeBytes += code.length;
    }
    if (codeBytes > options.capacity) throw new CliCompatibilityError('CLI 显示列宽代码区不足');
    if (options.codeFileOffset < 0 || options.codeFileOffset + codeBytes > buffer.length ||
        buffer.subarray(options.codeFileOffset,options.codeFileOffset + codeBytes).some(byte => byte !== 0)) {
      throw new Error('CLI 显示列宽代码区不足或不是空白');
    }
  }
  const writes = new Map();
  const stage = (offset, bytes) => {
    const previous = writes.get(offset);
    if (previous && !previous.equals(bytes)) throw new Error('CLI 共享显示引用的译文字节长度不一致');
    writes.set(offset,bytes);
  };
  for (const patch of plan.patches) {
    if (patch.kind === 'quota-description-prefix') continue;
    const bytes = Buffer.from(patch.translated), address = allocateString(bytes);
    if (!Number.isSafeInteger(address) || address < 0 || bytes.length > 0xffff) throw new Error('CLI 状态译文分配超出范围');
    if (patch.kind === 'slot') {
      const slot = Buffer.alloc(16); slot.writeBigUInt64LE(BigInt(address)); slot.writeBigUInt64LE(BigInt(bytes.length),8);
      stage(patch.fileOffset,slot);
    } else if (patch.kind === 'inline-string-copy') {
      for (const source of patch.sources) {
        const pointer = Buffer.alloc(8);
        addressInstructions(source.pointerRegister, address + source.resourceOffset, source.pointerPc)
          .forEach((word,index) => pointer.writeUInt32LE(word,index * 4));
        stage(source.pointerFileOffset,pointer);
      }
    } else {
      const pointer = Buffer.alloc(8), words = addressInstructions(patch.pointerRegister,address,patch.pointerPc);
      words.forEach((word,index) => pointer.writeUInt32LE(word,index * 4));
      const length = Buffer.alloc(4); length.writeUInt32LE((0xd2800000 | (bytes.length << 5) | patch.lengthRegister) >>> 0);
      stage(patch.pointerFileOffset,pointer); stage(patch.lengthFileOffset,length);
    }
  }
  for (const patch of plan.casePatches ?? []) {
    const bytes = Buffer.alloc(4); bytes.writeUInt32LE(patch.word); stage(patch.fileOffset,bytes);
  }
  for (const thunk of widthThunks) {
    stage(thunk.offset,thunk.code);
    const branch = Buffer.alloc(4); branch.writeUInt32LE(relativeBranch(0x14000000,plan.imageBase + thunk.site.rva,thunk.address));
    stage(thunk.site.fileOffset,branch);
  }
  for (const thunk of prefixThunks) {
    stage(thunk.offset,thunk.code);
    const redirect = Buffer.alloc(4), call = Buffer.alloc(4);
    redirect.writeUInt32LE(relativeBranch(0x14000000,plan.imageBase + thunk.patch.rva,thunk.address));
    call.writeUInt32LE(relativeBranch(0x94000000,plan.imageBase + thunk.patch.callRva,thunk.patch.targetAddress));
    stage(thunk.patch.fileOffset,redirect);stage(thunk.patch.callFileOffset,call);
  }
  for (const [offset,bytes] of writes) bytes.copy(buffer,offset);
  return {translated:plan.patches.length, missing:plan.missing.length, codeBytes};
}
