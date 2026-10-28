import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../runtime/renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('  function computerUseAppName(');
const end = renderer.indexOf('  function translatedMenu(', start);
assert.ok(start >= 0 && end > start, 'the actual translation functions are present');
const translationSource = renderer.slice(start, end);
const nativeHooksEnd = renderer.indexOf('  function patchText(', end);
assert.ok(nativeHooksEnd > end, 'native dialog and menu hooks are present');
const nativeHooksSource = renderer.slice(end, nativeHooksEnd);
const restoreHooksSource = renderer.match(/for\(const hook of nativeMenuHooks\)\{[^\n]+\}/)?.[0];
assert.ok(restoreHooksSource, 'the actual native hook restoration is present');

function fixture(dictionary = {}, window) {
  const context = vm.createContext({dictionary, window});
  return vm.runInContext(`
    let strings, normalizedStrings;
    const nativeMenuHooks = [];
    const projectPlaceholders = new Set(['No Project','Select Project','Select Workspace','New Workspace']);
    ${translationSource}
    ${nativeHooksSource}
    setStrings(dictionary);
    ({translate, setStrings, installNativeMenuHooks, restoreNativeHooks() {
      ${restoreHooksSource}
      nativeMenuHooks.length = 0;
    }});
  `, context);
}

test('quote normalization works on both sides without changing exact choices or spacing', () => {
  const f = fixture({
    "Don't ask again": '不再询问',
    'Show “Edit” buttons': '显示“编辑”按钮',
    'Good response': '回答不错',
    'Good Response': '好回答',
    'Choose "Agent"': '选择智能体',
    'Choose “Agent”': '选择“智能体”',
  });
  assert.equal(f.translate('\n  Don’t ask again  '), '\n  不再询问  ');
  assert.equal(f.translate('Show "Edit" buttons'), '显示“编辑”按钮');
  assert.equal(f.translate('Show\n  “Edit” buttons'), '显示“编辑”按钮');
  assert.equal(f.translate('Choose "Agent"'), '选择智能体');
  assert.equal(f.translate('Choose “Agent”'), '选择“智能体”');
  assert.equal(f.translate('Good response'), '回答不错');
  assert.equal(f.translate('Good Response'), '好回答');
  assert.equal(f.translate('GOOD RESPONSE'), null);
  assert.equal(f.translate("Please Don't ask again tomorrow"), null);

  f.setStrings({strings:{'Don’t ask again':'以后不再询问'}});
  assert.equal(f.translate("Don't ask again"), '以后不再询问');
  assert.equal(f.translate('Show "Edit" buttons'), null, 'replacing a dictionary removes old normalized keys');
});

test('native confirmations translate current UI text and preserve names, decisions and calls', () => {
  const dictionary = JSON.parse(fs.readFileSync(new URL('../runtime/translations.json', import.meta.url))).strings;
  const calls = [];
  let decision = false;
  const original = function(...args) { calls.push({receiver:this, args}); return decision; };
  const window = {confirm:original};
  const f = fixture(dictionary, window);
  f.installNativeMenuHooks();
  const receiver = {}, extra = {};
  assert.equal(window.confirm.call(receiver, 'Are you sure you want to delete this handler?', extra), false);
  assert.equal(calls[0].receiver, receiver);
  assert.equal(calls[0].args[0], '确定要删除此处理程序吗？');
  assert.equal(calls[0].args[1], extra);
  decision = true;
  assert.equal(window.confirm('Are you sure you want to delete the hook "My  Hook"?'), true);
  assert.equal(calls.at(-1).args[0], '确定要删除钩子“My  Hook”吗？');
  window.confirm('Are you sure you want to delete this hook card?');
  assert.equal(calls.at(-1).args[0], '确定要删除此钩子卡片吗？');
  window.confirm('Delete my  custom text?');
  assert.equal(calls.at(-1).args[0], 'Delete my  custom text?');
  const message = {toString() { throw new Error('the wrapper must not coerce values'); }};
  window.confirm(message);
  assert.equal(calls.at(-1).args[0], message);
  window.confirm();
  assert.equal(calls.at(-1).args.length, 0);
  f.setStrings({'Are you sure you want to delete this handler?':'删除此处理程序？'});
  window.confirm('Are you sure you want to delete this handler?');
  assert.equal(calls.at(-1).args[0], '删除此处理程序？');
  f.restoreNativeHooks();
  assert.equal(window.confirm, original);
});

test('dynamic labels preserve shortcuts, counts and model punctuation', () => {
  const {translate} = fixture({'Send Message':'发送消息'});
  const examples = [
    ['Enter Sends immediately', 'Enter 立即发送'],
    ['⌥⌅ Queues after the turn', '⌥⌅ 排队，当前轮次结束后发送'],
    ['⌥⏎ On empty prompt, sends next in queue', '⌥⏎ 输入框为空时，发送下一条排队消息'],
    ['Alt+Enter On empty prompt, sends next in queue', 'Alt+Enter 输入框为空时，发送下一条排队消息'],
    ['Send Message ⏎', '发送消息 ⏎'],
    ['Send Message Enter', '发送消息 Enter'],
    ['1 active conversation', '1 个进行中对话'],
    ['12 archived conversations', '12 个已归档对话'],
    ['1 Side Question', '1 个临时问题'],
    ['2 Side Questions', '2 个临时问题'],
    ['View 2 side questions', '查看 2 个临时问题'],
    ['2 active conversations and 1 archived conversation', '2 个进行中对话和 1 个已归档对话'],
    ['Gemini “Preview” is now available to paid Pro plan subscribers.', 'Gemini “Preview” 现已向付费 Pro 套餐订阅者开放。'],
    ['Allow Computer Use to use "TextEdit"?', '是否允许电脑操作功能使用“TextEdit”？'],
    ['Allow Computer Use to use "My App’s Editor"?', '是否允许电脑操作功能使用“My App’s Editor”？'],
    ['\tAlt+Enter Sends immediately\n', '\tAlt+Enter 立即发送\n'],
    ['You have used some of your 5-hour limit, it will fully refresh in 2 hours, 3 minutes.', '5 小时额度已使用一部分，将在 2小时 3分钟后全部恢复。'],
  ];
  for (const [original, expected] of examples) assert.equal(translate(original), expected, original);
  assert.equal(translate('There are 2 active conversations and more'), null);
  assert.equal(translate('Enter Sends immediately when ready'), null);
  assert.equal(translate('Alt+Enter On empty prompt, sends next in queue now'), null);
  assert.equal(translate('Send Message to My Agent'), null);
});

test('native UI templates translate counts and notices while preserving dynamic values', () => {
  const {translate} = fixture({
    'System Prompt':'系统提示词', Skills:'技能', Model:'模型',
    'Step Details':'步骤详情', 'Tool Call':'工具调用',
  });
  const examples = [
    ['1 tool enabled', '已启用 1 个工具'],
    ['3 tools disabled', '已禁用 3 个工具'],
    ['Show 2 breakdowns', '显示 2 项明细'],
    ['Send all (3)', '全部发送（3）'],
    ['Failed to save "My  App’s "Editor""', '保存“My  App’s "Editor"”失败'],
    ['\tOpen the My\nPlugin plugin\n', '\t打开 My\nPlugin 插件\n'],
    ['Failed to resolve folder: /tmp/My  Project (Not found: "source")', '解析文件夹失败：/tmp/My  Project（Not found: "source"）'],
    ['There was an error determining the code changes that this undo action will make: Cannot read /tmp/My  Project\nSnapshot "Undo" not found', '无法确定此次撤销会产生哪些代码更改：Cannot read /tmp/My  Project\nSnapshot "Undo" not found'],
    ['Are you sure you want to delete the hook "My  Hook\n\"Undo\""?', '确定要删除钩子“My  Hook\n"Undo"”吗？'],
    ['Use custom repository: "MyOrg/my-repo"', '使用自定义仓库：“MyOrg/my-repo”'],
    ['System Prompt: 1,024 tokens', '系统提示词：1,024 Token'],
    ['Step #12: read_file (Tool Call)', '步骤 #12：read_file（工具调用）'],
    ['1 rule exceeded the rules budget and was demoted from full inline content to a file-path pointer.', '1 条规则超出规则预算，已将完整内联内容降级为文件路径引用。'],
    ['2 items in Skills exceeded the customization budget and were excluded from context.', '技能中的 2 项内容超出自定义内容预算，已从上下文中排除。'],
    ['All tools in this MCP server (1,024 tokens) exceeded the customization budget and were excluded from context.', '此 MCP 服务器中的全部工具（1,024 Token）超出自定义内容预算，已从上下文中排除。'],
    ['You have 3 conversations in progress. Updating will interrupt them, and they will automatically resume once the update completes.', '你有 3 个进行中的对话。更新会中断这些对话，更新完成后将自动恢复。'],
    ["You have 2 conversations in progress. Updating will cancel them and you'll need to manually restart them.", '你有 2 个进行中的对话。更新会取消这些对话，需要手动重新开始。'],
    ['Copy Model', '复制模型'],
    ['Copy entire Step Details JSON', '复制完整的步骤详情 JSON'],
  ];
  for (const [original, expected] of examples) assert.equal(translate(original), expected, original);
  for (const original of ['Copy my-file.json','Copy entire my-file JSON','Allow all operations','Conversation release notes','1 tool enabled after refresh','Enter My title...','Open My title']) {
    assert.equal(translate(original), null, original);
  }
  assert.equal(translate('Open My  conversation', 'fork-title'), '打开 My  conversation');
  assert.equal(translate('Enter Branch...', 'trigger-field-placeholder'), '输入 Branch…');
});
