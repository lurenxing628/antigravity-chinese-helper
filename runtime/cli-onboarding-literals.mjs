import { CliCompatibilityError } from './cli-compatibility.mjs';
import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

const onboarding = 'google3/third_party/jetski/cli/onboarding/onboarding.';
const wizard = onboarding + 'OnboardingModel.';
const color = wizard + 'partsColorAndMigration', consent = wizard + 'partsSecurityNotice';
const style = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render';
const addLine = onboarding + '(*lineBuilder).add';
const namespace = 'cli-onboarding:';
const securityNotice = 'AI coding agents are known to have certain security risks, including autonomous code execution, data exfiltration, prompt injection and supply chain risks. Ensure that you monitor and verify all actions taken by the agent.';
const analyticsNotice = '%s does not collect any of your prompts, content, or model responses but does collect general usage patterns such as feature adoption and active user counts (“product analytics data”). Product analytics data will be handled in accordance with the Google Privacy Policy.';

const rendered = (name, original, register, call) => ({
  name, literals:[[0,8,register,register+1,original]], verifiedCalls:[[call,style]],
});
// The style argument copy can gain an instruction when Go's stack frame grows.
function renderButton(name, label, register) {
  return {name, literals:[[0,8,register,register+1,label]],
    resolve(buffer, metadata, profile) {
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      const fn = metadata.functions.get(name), target = metadata.functions.get(style);
      const start = located.literals[0][0];
      for (let offset = start + 12; offset + 4 <= fn.size && offset <= start + 0x58; offset += 4) {
        const word = buffer.readUInt32LE(fn.fileOffset + offset);
        if (word >>> 26 !== 0x25) continue;
        if (target && !metadata.ambiguousFunctions?.has(style) && fn.rva + offset + (word << 6 >> 6) * 4 === target.rva) {
          return {...located, verifiedCalls:[[offset,style]]};
        }
        break;
      }
      throw new CliCompatibilityError('引导页按钮显示位置已变化');
    }};
}
const preview = 'google3/third_party/jetski/cli/types/types.ColorSchemePreviewFull';
const schemes = ['terminal','light','solarized light','colorblind-friendly light','dark',
  'solarized dark','colorblind-friendly dark','tokyo night'];

export const cliOnboardingLiteralProfiles = [
  {name:onboarding+'formatExtensionsLabel', literals:[[0,8,0,1,' (%d found: ',24]]},
  {name:onboarding+'formatExtensionsLabel', literals:[[0,8,0,1,'%s%s%s)',24,namespace]]},
  {name:onboarding+'formatExtensionsLabel', literals:[
    [0xec,0xf4,0,1,'%s (%d found)',0x104], [0x148,0x150,0,1,'%s (%d found)',0x160],
    [0x348,0x350,0,1,'%s (%d found)',0x360],
  ]},
  {name:onboarding+'formatExtensionsLabel', literals:[
    [0,8,1,2,'Import extensions from Gemini CLI'], [12,20,3,4,' (0 found)'],
  ], verifiedCalls:[[24,'runtime.concatstring2']]},
  // partsColorAndMigration builds two identical lists: the first indexes the
  // native scheme for the preview, the second feeds the visible option rows.
  {name:color, literals:schemes.map((label, index) =>
    [index*24,index*24+8,2,index < 5 ? 3 : 4,label,undefined,label === 'dark' ? namespace : undefined]),
    verifiedCalls:[[0x3bc-0x2d8,'runtime.concatstring2'],[0x3d0-0x2d8,addLine]],
    resolve(buffer,metadata,profile,dictionary) {
      const located = relocateStatusLiteralGroup(buffer,metadata,profile);
      // X3 still supplies the four-byte selection prefix for the first row.
      const dark = (dictionary?.strings ?? dictionary)?.[namespace+'dark'];
      if (typeof dark === 'string' && dark && Buffer.byteLength(dark) !== 4) {
        throw new CliCompatibilityError('引导页深色标签与行前缀共用四字节长度');
      }
      return {...located,sharedLengths:[located.literals[4][1]]};
    }},
  rendered(color,'Choose your color scheme:',2,0x58),
  rendered(color,'Migration options:',3,0x58),
  rendered(color,'  (widen the terminal to see a preview)',3,0x58),
  {name:color,literals:[[0x6cc,0x6b0,1,2,'Welcome to ',undefined,namespace]],
    verifiedCalls:[[0x6ac,'google3/third_party/jetski/cli/render/render.ProductName'],[0x6d4,'runtime.concatstring3']]},
  ...[
    ['> you: ',0x54], ['add a greeting function',0x58], ["  Here's the change:",0x58],
    ['  ▾ Thought Process',0x58], ["    I need to add a greeting function. I'll use fmt.Printf.",0x58],
    ['  ⚙ tool: ',0x54], ['  ◉ task: ',0x54], ['Implementing greeting',0x58],
    ['  ✗ error: ',0x58], ['compilation failed',0x58], ['  ⚠ warning: ',0x54],
    ['deprecation warning',0x58], ['  → link: ',0x58], ['  ★ accent: ',0x58],
    ['highlighted text',0x58], ['  · dim: press Enter to continue',0x58],
  ].map(([text,call]) => rendered(preview,text,4,call)),
  // The two welcome-button variants are boxed using one common byte length,
  // and the focus style directly renders a second copy of that same selection.
  {name:wizard+'footerColorAndMigration', literals:[
    [0x128,0x150,0,1,'Done',undefined,namespace],[0x134,0x200,0,4,'Next',undefined,namespace],
  ], verifiedCalls:[[0x154,'runtime.convTstring'],[0x250,style]],
    resolve(buffer,metadata,profile,dictionary) {
      const strings = dictionary?.strings ?? dictionary;
      const done = strings?.[namespace+'Done'], next = strings?.[namespace+'Next'];
      if (typeof done !== 'string' || !done || typeof next !== 'string' || !next || Buffer.byteLength(done) !== Buffer.byteLength(next)) {
        throw new CliCompatibilityError('引导页“继续”和“完成”共用字节长度，需要成对提供等长译文');
      }
      return relocateStatusLiteralGroup(buffer,metadata,profile);
    }},
  {name:consent,literals:[[0,8,0,1,analyticsNotice,28]]},
  {name:consent,literals:[[0x2ac,0x290,1,2,securityNotice],[0x2c8,0x2c4,5,2,securityNotice]],
    verifiedCalls:[[0x2b4,'runtime.concatstring3']]},
  rendered(consent,'Terms of Service & Data Use',3,0x58),
  {name:consent,literals:[[0,8,0,1,'Yes, I agree to help improve %s by allowing',28]]},
  {name:consent,literals:[[0,8,0,1,'subject to the Google %s Terms of Service',28]]},
  ...['Google to collect and use my Interactions data,','and Google Privacy Policy. I understand I can',
    'choose to opt out later whenever I want via my','settings.'].map((text,index) => ({
      name:consent,literals:[[0,8,2,3,text]],verifiedCalls:[[
        0x7ac-[0x70c,0x730,0x748,0x760][index],onboarding+'fitsAuthored']],
    })),
  ...[['      Terms and Privacy:',1,12,addLine],['      Links:',1,12,addLine],
    ['Terms of Service: https://cloud.google.com/terms',4,20,onboarding+'hangingWrap'],
    ['Privacy Notice (excluding product analytics data): https://cloud.google.com/terms/cloud-privacy-notice',4,20,onboarding+'hangingWrap'],
    ['Terms of Service: https://antigravity.google/terms',4,20,onboarding+'hangingWrap'],
    ['Privacy Policy: https://policies.google.com/privacy',4,20,onboarding+'hangingWrap']].map(([text,reg,at,consumer]) =>
      ({name:consent,literals:[[0,8,reg,reg+1,text]],verifiedCalls:[[at,consumer]]})),
  ...[['[Previous]',2],['Previous',3],['[Done]',3],['Done',3]].map(([text,reg]) =>
    renderButton(wizard+'footerSecurityNotice',text,reg)),
].map(profile => ({resolve:relocateStatusLiteralGroup,optional:true,...profile}));
