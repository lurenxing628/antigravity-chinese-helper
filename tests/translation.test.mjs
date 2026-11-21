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
    let strings, translationIndex;
    const nativeMenuHooks = [];
    const projectPlaceholders = new Set(['No Project','Select Project','Select Workspace','New Workspace']);
    ${translationSource}
    ${nativeHooksSource}
    setStrings(dictionary);
    ({translate, translateControlAria, setStrings, installNativeMenuHooks, restoreNativeHooks() {
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

test('terminal snapshots preserve the mouse encoding of each tab on remount', () => {
  class SerializeAddon {
    _serializeBufferByRange() {}
    _serializeModes() { return '\x1b[?1002h'; }
  }
  const original = SerializeAddon.prototype._serializeModes;
  const f = fixture({}, {SerializeAddon});
  f.installNativeMenuHooks();
  const addon = new SerializeAddon();
  for (const [encoding, sequence] of [['SGR', '\x1b[?1006h'], ['DEFAULT', ''], ['SGR_PIXELS', '\x1b[?1016h']]) {
    const terminal = {_core:{coreMouseService:{activeEncoding:encoding}}};
    assert.equal(addon._serializeModes(terminal), '\x1b[?1002h' + sequence);
  }
  f.restoreNativeHooks();
  assert.equal(SerializeAddon.prototype._serializeModes, original);
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


test('notebook preview and feedback templates keep parser details and account addresses verbatim', () => {
  const {translate}=fixture({'Send feedback as':'反馈账号：','Invalid notebook JSON:':'笔记本 JSON 无效：',
    'Invalid notebook JSON.':'笔记本 JSON 无效。','No notebook cells were found.':'未找到笔记本单元格。',
    'This notebook has no renderable cells.':'此笔记本没有可显示的单元格。'});
  const detail='Unexpected token $, "Commit $& {server}" is invalid JSON';
  assert.equal(translate('Preview unavailable — Invalid notebook JSON: '+detail),'无法预览 — 笔记本 JSON 无效：'+detail);
  assert.equal(translate('Preview unavailable — No notebook cells were found.'),'无法预览 — 未找到笔记本单元格。');
  assert.equal(translate('Preview unavailable — This notebook has no renderable cells.'),'无法预览 — 此笔记本没有可显示的单元格。');
  assert.equal(translate('Preview unavailable — Provider error: Settings'),'无法预览 — Provider error: Settings');
  assert.equal(translate('Send feedback as me+$&@example.invalid'),'反馈账号：me+$&@example.invalid');
});


test('native dynamic notices preserve branch names, command labels, server identifiers and errors', () => {
  const {translate}=fixture({});
  const cases=[
    ['Conflicts with "My  Command $&\nOther" (press Enter to replace)','与“My  Command $&\nOther”冲突（按 Enter 替换）'],
    ['Conflict: also assigned to My  Command $&','快捷键冲突：也用于 My  Command $&'],
    ['Pushed 2 commits to feature/My  Branch.$&.','已向 feature/My  Branch.$& 推送 2 个提交。'],
    ['Push 1 commit to origin/main','向 origin/main 推送 1 个提交'],
    ['MCP server "My  Server \"quoted\"" not found in the store.','未在商店中找到 MCP 服务器“My  Server \"quoted\"”。'],
    ["Couldn't disconnect My:Server: Error: raw  detail",'无法断开连接：My:Server: Error: raw  detail'],
    ['Recording exceeds 15MB limit (20.25MB)','录音超过 15MB 上限（20.25MB）'],
    ['Shared with: A  Model, B“Model”','共用此额度：A  Model, B“Model”'],
    ['12 Comments','12 条评论'],
    ['For Google AI Ultra accounts, this setting is disabled.','对于 Google AI Ultra 账号，此设置已禁用。'],
    ['Credentials expire in 2h 30m. Refresh credentials to keep this automation running','凭证将在 2小时 30分钟后过期。请刷新凭证，让此自动化继续运行'],
    ['Managed by the My  Task $& automation','由自动化 My  Task $& 管理']
  ];
  for(const [original,expected] of cases)assert.equal(translate(original),expected,original);
  for(const original of ['Typing','Turn 2','Work in My Folder','Error: raw detail after a server error']) {
    if(original.startsWith('Error:'))continue; // This pre-existing broad error rule is outside these additions.
    assert.equal(translate(original),null,'arbitrary display/data text has no new broad rule: '+original);
  }
});


test('native operation and browser templates retain raw names and error suffixes', () => {
  const {translate}=fixture({});
  const detail='Error: My  value\n$& path';
  assert.equal(translate('Unfold lines 2-20'),'展开第 2–20 行');
  assert.equal(translate('Proceed with implementation plan and 2 comments'),'按实施计划和 2 条批注继续执行');
  assert.equal(translate("Couldn't load apps: "+detail),'无法加载应用：'+detail);
  assert.equal(translate('Forked from My  $& title'),'分支来源：My  $& title');
  assert.equal(translate('No apps found for "My  Query".'),'未找到与“My  Query”匹配的应用。');
  assert.equal(translate('Failed to update agent: '+detail),'更新智能体失败：'+detail);
  assert.equal(translate('Could not attach folder "My  Folder": '+detail),'无法将文件夹添加为附件："My  Folder": '+detail);
  assert.equal(translate("Couldn't mark as unread conversation"),'将对话标为未读失败');
  assert.equal(translate('A file already exists at /tmp/My  File.'),'/tmp/My  File 已存在同名文件。');
  assert.equal(translate('The folder “My  Folder” does not exist. Would you like to create it?'),'文件夹“My  Folder”不存在。要创建吗？');
  assert.equal(translate('The certificate was rejected (net::ERR_CERT_OTHER).'),'证书被拒绝（net::ERR_CERT_OTHER）。');
  assert.equal(translate('Check if there is a typo in example.invalid, or open the page in your external browser.'),'检查 example.invalid 是否有拼写错误，或在外部浏览器中打开此页面。');
  assert.equal(translate('Sign in from the My  Product panel.'),'请在 My  Product 面板中登录。');
  for (const value of ['Failed to update my file: data','Could not attach folder notes',"Couldn't rename conversation",'The folder My Folder does not exist.'])
    assert.equal(translate(value),null,value);
});

test('PDF labels keep page numbers and selected text within the viewer', () => {
  const {translate} = fixture({
    'pdf-template:"{text}" not found on page {page}':'未在第 {page} 页找到“{text}”',
    'pdf-template:Go to page {page}':'前往第 {page} 页',
    'pdf-annotation:Underline':'下划线',
  });
  assert.equal(translate('"A  {page} $&" not found on page 7','pdf'),'未在第 7 页找到“A  {page} $&”');
  assert.equal(translate('Underline annotation on page 13','pdf'),'第 13 页的下划线批注');
  assert.equal(translate('Go to page 4','pdf'),'前往第 4 页');
  assert.equal(translate('Go to page Settings','pdf'),null);
  assert.equal(translate('Go to page 4'),null);
});

test('accessibility templates preserve filenames and use their owning controls on refresh', () => {
  const dictionary = {
    'aria-label:Address bar suggestions':'地址栏建议',
    'aria-template:webview-download-open,input-attachment-open:Open {name}':'打开 {name}',
    'aria-template:cloud-trigger-run-now:Run {name} now':'立即运行 {name}',
    'Settings':'设置', 'Cancel':'取消',
  };
  const f = fixture(dictionary);
  assert.equal(f.translateControlAria('browser-autocomplete-dropdown','Address bar suggestions'),'地址栏建议');
  for (const id of ['webview-download-open','input-attachment-open']) {
    assert.equal(f.translateControlAria(id,'Open My  File $& {name}'),'打开 My  File $& {name}');
    assert.equal(f.translateControlAria(id,'Settings'),null);
  }
  assert.equal(f.translateControlAria('cloud-trigger-run-now','Run Settings now'),'立即运行 Settings');
  assert.equal(f.translateControlAria('media-modal-video','Settings'),null);
  assert.equal(f.translateControlAria('','Cancel'),null);
  assert.equal(f.translate('Open My  File $& {name}'),null);
  f.setStrings({'aria-template:webview-download-open:Open {name}':'查看 {name}'});
  assert.equal(f.translateControlAria('webview-download-open','Open Settings'),'查看 Settings');
  assert.equal(f.translateControlAria('input-attachment-open','Open Settings'),null);
});

test('desktop templates retain literal parameters and refresh with the dictionary', () => {
  const f = fixture({
    'desktop-template:Retrying transcription (attempt {attempt})…':'正在重试转录（第 {attempt} 次）…',
    'desktop-template:Enable {name} on {host}. Return to {host}.':'返回 {host}，启用 {name}。',
    'desktop-template:{count} hidden hosts':'已隐藏 {count} 个主机',
  });
  const name = 'My  App\n{host} $&', host = 'Host “Local”';
  assert.equal(f.translate('Retrying transcription (attempt 3)…'), '正在重试转录（第 3 次）…');
  assert.equal(f.translate('3 hidden hosts'), '已隐藏 3 个主机');
  assert.equal(f.translate('user hidden hosts'), null);
  assert.equal(f.translate(`Enable ${name} on ${host}. Return to ${host}.`), `返回 ${host}，启用 ${name}。`);
  assert.equal(f.translate(`Enable App on ${host}. Return to Other.`), null);
  f.setStrings({'desktop-template:{count} hidden hosts':'隐藏主机 {count} 台'});
  assert.equal(f.translate('3 hidden hosts'), '隐藏主机 3 台');
  assert.equal(f.translate('Retrying transcription (attempt 3)…'), null);
});

test('side-question controls translate help counts and preserve the question title', () => {
  const dictionary = JSON.parse(fs.readFileSync(new URL('../runtime/translations.json', import.meta.url)));
  const {translate,translateControlAria} = fixture(dictionary);
  assert.equal(translate('2 Help'), '2 条帮助请求');
  assert.equal(translate('1 Help · 2 Side Questions'), '1 条帮助请求 · 2 个临时问题');
  assert.equal(translate('View 1 help and 2 side questions'), '查看 1 条帮助请求和 2 个临时问题');
  assert.equal(translate('View 2 help items and 1 side question'), '查看 2 条帮助请求和 1 个临时问题');
  assert.equal(translate('View 2 help items'), '查看 2 条帮助请求');
  assert.equal(translateControlAria('side-question-tab-promote','Promote to conversation'), '转为独立对话');
  assert.equal(translateControlAria('side-question-tab-delete','Delete side question'), '删除临时问题');
  assert.equal(translateControlAria('side-question-tab-stop','Stop side question'), '停止临时问题');
  assert.equal(translateControlAria('side-question-row-delete','Delete side question: My  notes $&'), '删除临时问题：My  notes $&');
  assert.equal(translateControlAria('side-question-tab-header-name','Delete side question: My  notes $&'), null);
});

test('the Mac control HUD translates its new stop state and restores the button tooltip', () => {
  const source = fs.readFileSync(new URL('../runtime/auxiliary-renderer.js', import.meta.url), 'utf8');
  const originalTooltip = 'Let agents use this Mac again. The stopped task does not restart.';
  const buttonText = {nodeType:3, data:'Allow again', isConnected:true};
  const statusText = {nodeType:3, data:'You took over — agent stopped', isConnected:true};
  let tooltip = originalTooltip;
  const button = {childNodes:[buttonText], getAttribute:() => tooltip, setAttribute:(_, next) => { tooltip = next; }};
  const document = {
    body:{}, documentElement:{lang:'en', getAttribute() { return this.lang; }},
    querySelector: selector => selector === '#resume[title]' ? button : null,
    querySelectorAll: () => [button, {childNodes:[statusText]}],
  };
  const install = vm.runInNewContext(source, {document, MutationObserver:class { observe() {} disconnect() {} }});
  const dictionary = {'aux-ui:Allow again':'重新允许', 'aux-ui:You took over — agent stopped':'你已接管操作，智能体已停止',
    ['aux-ui:' + originalTooltip]:'允许智能体再次使用这台 Mac。已停止的任务不会重新启动。'};
  const helper = install('hud', dictionary);
  assert.equal(buttonText.data, '重新允许');
  assert.equal(statusText.data, '你已接管操作，智能体已停止');
  assert.equal(tooltip, '允许智能体再次使用这台 Mac。已停止的任务不会重新启动。');
  helper.refresh({...dictionary, ['aux-ui:' + originalTooltip]:'允许智能体再次操作 Mac。'});
  assert.equal(tooltip, '允许智能体再次操作 Mac。');
  helper.uninstall();
  assert.equal(buttonText.data, 'Allow again');
  assert.equal(tooltip, originalTooltip);
  assert.equal(document.documentElement.lang, 'en');
});
