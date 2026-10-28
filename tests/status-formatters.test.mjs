import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../runtime/renderer.js', import.meta.url), 'utf8');
const factoryStart = renderer.indexOf('(function installStatusFormatters');
const factoryEnd = renderer.indexOf('\n});', factoryStart);
assert.ok(factoryStart >= 0 && factoryEnd > factoryStart, 'status formatter factory is present');
const factorySource = renderer.slice(factoryStart, factoryEnd + 3);
const uninstallSource = renderer.match(/\n    uninstall\(\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(uninstallSource, 'renderer uninstall method is present');

function fixture(options = {}) {
  const window = {};
  window.window = window;
  const context = vm.createContext(window);
  const install = vm.runInContext(factorySource, context);
  const registered = [];
  return {
    window,
    evaluate: source => vm.runInContext(source, context),
    install: () => install({
      strings: options.strings ?? {},
      translate: options.translate,
      register: (key, original, wrapper, kind, owner) => registered.push({key, original, wrapper, kind, owner})
    }),
    uninstall: () => vm.runInContext(`(function(nativeMenuHooks) {
      let stopped = false;
      const clearPending = () => {}, restore = () => {};
      const contextRings = {dispose() {}};
      const originalLang = null;
      const document = {documentElement: {removeAttribute() {}, setAttribute() {}}};
      const api = {${uninstallSource}};
      return api.uninstall;
    })`, context)(registered)
  };
}

const runningSource = '(function runningFormatter(active) { const marker={toolSummary:active}; return active?"Running command":"Exploring"; })';

test('closure loss falls back once, including cached wrapper references and native errors', () => {
  const f = fixture();
  const native = f.evaluate(`(() => {
    const calls = [];
    const hidden = function(input, suffix) {
      calls.push({receiver: this, input, suffix});
      if (input.error) throw input.error;
      return this.prefix + input.path + suffix;
    };
    return {
      calls,
      formatter: function pathFormatter(input, suffix) {
        const directoryPathUri = input.path, read_file = true;
        return \`Searching \${hidden.call(this, input, suffix)}\`;
      }
    };
  })()`);
  f.window.path = native.formatter;
  f.window.running = f.evaluate(runningSource);
  const adapters = f.install();
  const saved = f.window.path;
  const receiver = {prefix: 'owner:'};
  const input = {path: '/file'};
  assert.equal(adapters.count, 2);
  assert.equal(saved.call(receiver, input, ':tail'), 'Searching owner:/file:tail');
  assert.equal(f.window.path, native.formatter);
  assert.equal(native.calls[0].receiver, receiver);
  assert.equal(native.calls[0].input, input);
  assert.equal(native.calls[0].suffix, ':tail');

  let retried = 0;
  f.window.hidden = () => { retried++; return 'wrong binding'; };
  assert.equal(saved.call(receiver, input, ':again'), 'Searching owner:/file:again');
  assert.equal(retried, 0, 'saved wrapper must never try localization again');
  const nativeError = new Error('native formatter failure');
  assert.throws(() => saved.call(receiver, {error: nativeError}, ':error'), error => error === nativeError);
  assert.equal(native.calls.length, 3, 'each fallback calls the original exactly once');
  assert.equal(f.window.running(true), '正在运行命令');
  assert.equal(adapters.count, 1, 'the failed adapter is no longer reported as installed');
});

test('an un-compilable formatter stays native while later adapters still install', () => {
  const f = fixture();
  const original = f.evaluate('({path(input) { const directoryPathUri=input,read_file=true;return `Searching ${directoryPathUri}`; }}).path');
  f.window.path = original;
  f.window.running = f.evaluate(runningSource);
  const adapters = f.install();
  assert.equal(f.window.path, original);
  assert.equal(f.window.path('query'), 'Searching query');
  assert.deepEqual(Array.from(adapters.hooks, hook => hook.kind), ['status-running']);
  assert.equal(f.window.running(true), '正在运行命令');
  assert.equal(adapters.count, 1);
  f.uninstall()();
  assert.equal(f.window.path, original);
  assert.equal(f.window.running(false), 'Exploring');
});

test('fallback and an old uninstall preserve subsequent owners', () => {
  const f = fixture();
  f.window.path = f.evaluate('(() => { const hidden=value=>value;return function pathFormatter(input) { const directoryPathUri=input,read_file=true;return `Searching ${hidden(directoryPathUri)}`; }; })()');
  f.install();
  const saved = f.window.path;
  const uninstall = f.uninstall();
  const later = () => 'later owner';
  f.window.path = later;
  assert.equal(saved('query'), 'Searching query');
  assert.equal(f.window.path, later, 'a failed saved wrapper does not replace the current owner');
  uninstall();
  assert.equal(f.window.path, later, 'old uninstall does not overwrite a later replacement');
});

function nativeFixture(options = {}) {
  const f = fixture(options);
  f.evaluate(`
    var A = {
      Fragment: Symbol.for('react.fragment'),
      createElement(type, props, ...children) {
        return Object.freeze({$$typeof:Symbol.for('react.element'),type,key:props?.key ?? null,
          props:Object.freeze({...props,...(children.length ? {children:children.length === 1 ? children[0] : children} : {})})});
      },
      isValidElement(value) { return Boolean(value && value.$$typeof === Symbol.for('react.element')); },
      cloneElement(value, props) { return Object.freeze({...value,props:Object.freeze({...value.props,...props})}); }
    };
  `);
  return f;
}

test('native UI adapts fixed hosts while preserving Hooks, closures and dynamic children', () => {
  const f = nativeFixture();
  const native = f.evaluate(`(() => {
    const callback = () => 'private callback';
    const secret = {calls:0};
    const Code = () => null, File = () => null;
    const code = A.createElement(Code,{code:'JavaScript Result'},'JavaScript Result');
    const file = A.createElement(File,{fileUri:'file:///Show JavaScript Result.js'});
    return {secret,callback,code,file,
      view:function resultView(props) {
        secret.calls++;
        const [expanded] = props.hook();
        return A.createElement('div',{onClick:callback,expanded},
          A.createElement('button',{onClick:callback},file,'Show JavaScript Result'),
          A.createElement('p',{className:'font-semibold'},'JavaScript Result'),
          A.createElement('p',null,'No Javascript Result Output'),code,
          A.createElement('pre',null,props.output));
      }};
  })()`);
  f.window.resultView = native.view;
  let hooks = 0;
  const output = 'JavaScript Result\nShow JavaScript Result  /tmp/a  b.js';
  const props = {hook:() => { hooks++;return [true]; },output};
  const installed = f.install();
  assert.deepEqual(Array.from(installed.uiKeys), ['resultView']);
  const result = f.window.resultView(props);
  assert.equal(native.secret.calls, 1, 'the original closure is called once');
  assert.equal(hooks, 1, 'the original hook call remains with its owner');
  assert.equal(result.props.expanded, true);
  assert.equal(result.props.onClick, native.callback);
  assert.equal(result.props.children[0].props.onClick, native.callback);
  assert.equal(result.props.children[0].props.children[0], native.file);
  assert.equal(result.props.children[0].props.children[1], '显示 JavaScript 结果');
  assert.equal(result.props.children[1].props.children, 'JavaScript 结果');
  assert.equal(result.props.children[3], native.code, 'the code component and its string child are untouched');
  assert.equal(result.props.children[4].props.children, output, 'code/output bytes remain unchanged');
});

test('native sequences preserve dynamic nodes and follow dictionary refresh and uninstall', () => {
  const f = nativeFixture();
  const native = f.evaluate(`(() => {
    const onClick = () => 'same handler';
    const project = A.createElement('span',{className:'font-semibold'},'Show  more... \"项目\"');
    const component = function existingProject() {
      return A.createElement('div',{onClick},'Project ',project,' already exists for this ',
        'combination of folders','. Would you like to continue using it or make a new one?');
    };
    const heading = function toolResult() {
      return A.createElement('div',null,A.createElement('button',null,null,'Show JavaScript Result'),
        A.createElement('p',null,'No Javascript Result Output'));
    };
    return {project,onClick,component,heading};
  })()`);
  f.window.project = native.component;
  f.window.heading = native.heading;
  const adapters = f.install();
  const result = f.window.project();
  assert.equal(result.props.children[1], native.project, 'the project name element retains its identity and bytes');
  assert.equal(result.props.children[0], '此文件夹组合已有关联项目 ');
  assert.equal(result.props.onClick, native.onClick);
  adapters.setStrings({'Show JavaScript Result':'展开 JavaScript 结果'});
  assert.equal(f.window.heading().props.children[0].props.children[1], '展开 JavaScript 结果');
  const uninstall = f.uninstall();
  const later = () => 'later owner';
  f.window.project = later;
  uninstall();
  assert.equal(f.window.project, later);
  assert.equal(f.window.heading, native.heading);
  assert.equal(f.window.heading().props.children[0].props.children[1], 'Show JavaScript Result');
});

test('blocked media translates only its fixed labels and preserves alt and URL bytes', () => {
  const f = nativeFixture();
  f.window.blockedMedia = f.evaluate(`(function blockedMedia({src,alt}) {
    return A.createElement('div',null,
      A.createElement('span',{className:'opacity-70 text-xs'},'Image rendering blocked (strict mode enabled)'),
      A.createElement('span',null,A.createElement('span',{className:'opacity-70'},'Alt text:'),' ',alt),
      A.createElement('span',{title:src},A.createElement('span',{className:'opacity-70'},'Image URL:'),' ',src),
      A.createElement('button',{title:'Copy full URL to clipboard',onClick:() => src}));
  })`);
  f.install();
  const src = 'https://example.com/a  b?label=Alt text:';
  const alt = 'Image rendering blocked (strict mode enabled)';
  const result = f.window.blockedMedia({src,alt});
  assert.equal(result.props.children[0].props.children, '图片渲染已禁用（已启用严格模式）');
  assert.equal(result.props.children[1].props.children[2], alt);
  assert.equal(result.props.children[2].props.children[2], src);
  assert.equal(result.props.children[2].props.title, src);
  assert.equal(result.props.children[3].props.title, '复制完整 URL 到剪贴板');
  assert.equal(result.props.children[3].props.onClick(), src);
});

test('log placeholders translate before rendering while actual log bytes remain intact', () => {
  const f = nativeFixture({strings:{'No logs available.':'暂无日志。','Loading logs...':'正在加载日志…'}});
  let log = '', hooks = 0;
  f.window.A.useState = () => { hooks++;return [log,() => {}]; };
  const native = f.evaluate(`(function logViewer({loading}) {
    const [output] = A.useState("");
    return A.createElement("div",{"data-testid":"sidecar-logs-content"},
      loading && !output ? A.createElement("p",null,"Loading logs...") :
      A.createElement("pre",null,output||"No logs available."));
  })`);
  f.window.logs = native;
  const adapters = f.install();
  const text = loading => f.window.logs({loading}).props.children.props.children;
  assert.equal(text(false), '暂无日志。');
  assert.equal(text(true), '正在加载日志…');
  log = 'No logs available.';
  assert.equal(text(false), log, 'actual logs matching a UI literal are still raw content');
  log = 'Settings\n/tmp/a  b.js';
  assert.equal(text(false), log);
  assert.equal(hooks, 4, 'each render calls the original hook exactly once');
  adapters.setStrings({'No logs available.':'当前没有日志'});
  log = '';
  assert.equal(text(false), '当前没有日志');
  f.uninstall()();
  assert.equal(f.window.logs, native);
  assert.equal(text(false), 'No logs available.');
});


test('tool errors preserve native dynamic suffixes and distinguish the MCP fixed fallback', () => {
  const f = nativeFixture();
  f.window.errorTitle = f.evaluate(`(function errorTitle(input) {
    if (input.status === 'invalid') return 'Invalid tool call';
    if (input.step.case === 'editNotebook') return A.createElement('span',null,'Error while editing notebook',input.file);
    if (input.step.case === 'generic') return 'Error while running: '+input.command;
    return 'Error while running MCP tool';
  })`);
  f.window.mcp = f.evaluate(`(function mcp({errorDetailsProp}) {
    const ErrorView = () => null;
    const header = A.createElement('span',null,'Tool arguments');
    const footer = A.createElement('span',null,'Full output written to');
    return A.createElement('div',null,header,footer,A.createElement(ErrorView,{text:A.createElement('span',null,
      A.createElement('span',{className:'overflow-hidden text-ellipsis'},errorDetailsProp.userErrorMessage || 'Agent encountered an internal error.'))}));
  })`);
  f.install();
  assert.equal(f.window.errorTitle({status:'invalid',step:{case:'error'}}), '无效的工具调用');
  const command = 'echo  "a  b"  \n';
  assert.equal(f.window.errorTitle({step:{case:'generic'},command}), '运行时出错：'+command);
  const file = {type:() => null,props:{fileUri:'file:///Error while editing notebook'}};
  const title = f.window.errorTitle({step:{case:'editNotebook'},file});
  assert.equal(title.props.children[0], '编辑笔记本时出错');
  assert.equal(title.props.children[1], file);
  const fallback = f.window.mcp({errorDetailsProp:{errorCode:0}}).props.children[2].props.text.props.children.props.children;
  assert.equal(fallback, '智能体遇到内部错误。');
  const originalMessage = 'Agent encountered an internal error.';
  const dynamic = f.window.mcp({errorDetailsProp:{userErrorMessage:originalMessage}}).props.children[2].props.text.props.children.props.children;
  assert.equal(dynamic, originalMessage, 'an identical real error message remains owned by its source');
});

test('conversation system notices translate fixed labels without changing response content', () => {
  const f = nativeFixture();
  const native = f.evaluate(`(() => {
    const Banner = () => null, Content = () => null;
    const body = A.createElement(Content,{response:'User cancelled agent execution.'},'User cancelled agent execution.');
    return {body,
      compaction:function compaction({enabled}) {
        const enableCompactionNotification = enabled;
        return enableCompactionNotification ? A.createElement(Banner,{
          text:'The conversation was compacted while generating this response.',
          tooltipContent:A.createElement(A.Fragment,null,'The conversation was compacted to fit within the context window.'),iconName:'info'}) : null;
      },
      response:function response({showClearedNotice,body}) {
        return A.createElement('div',{"data-turn-content":"latest"},body,
          A.createElement('div',null,'User cancelled agent execution.'));
      }};
  })()`);
  f.window.compaction = native.compaction;
  f.window.response = native.response;
  const adapters = f.install();
  assert.equal(f.window.compaction({enabled:false}), null, 'the native feature gate stays in control');
  const notice = f.window.compaction({enabled:true});
  assert.equal(notice.props.text, '生成此回复期间，对话内容已压缩。');
  assert.equal(notice.props.tooltipContent.props.children, '对话已压缩，以适应上下文窗口。');
  assert.equal(notice.type, native.compaction({enabled:true}).type, 'the original banner component is retained');
  const response = f.window.response({showClearedNotice:true,body:native.body});
  assert.equal(response.props.children[0], native.body, 'response components and their contents stay untouched');
  assert.equal(response.props.children[1].props.children, '用户已取消智能体执行。');
  adapters.setStrings({'The conversation was compacted while generating this response.':'此回复生成期间已压缩上下文'});
  assert.equal(f.window.compaction({enabled:true}).props.text, '此回复生成期间已压缩上下文');
});

test('protected native controls translate scalar and mixed children while keeping output and callbacks', () => {
  const f = nativeFixture({strings:{Confirm:'确认',Deny:'拒绝',Submit:'提交'}});
  const native = f.evaluate(`(() => {
    const Button = () => null, Tooltip = () => null, Markdown = () => null;
    const callback = () => 'native callback';
    return {callback,
      browser:function browser() {
        const aria = 'Confirm Browser Interaction';
        return A.createElement('div',null,A.createElement('span',null,'Confirmation required to execute this step'),
          A.createElement(Button,{variant:'secondary',size:'xs',onClick:callback},'Deny'),
          A.createElement(Button,{variant:'primary',size:'xs','aria-label':aria,onClick:callback},'Confirm'));
      },
      question:function question({answer}) {
        return A.createElement('div',null,
          A.createElement(Button,{'data-testid':'ask-question-dismiss-button'},'Cancel'),
          A.createElement(Button,{'data-testid':'interaction-continue-button',onClick:callback},'Submit',A.createElement('span',null,'↵')),
          A.createElement(Markdown,null,answer));
      },
      output:function output({combinedOutput}) {
        return A.createElement('div',null,A.createElement('button',null,'Logs'),
          A.createElement('pre',null,A.createElement('div',null,2,' ','lines',' above hidden'),combinedOutput));
      },
      command:function command({cwd,command}) {
        const copy = 'Copy Command';
        return A.createElement('pre',null,A.createElement(Tooltip,{place:'top-start'},'Working Directory: ',cwd),
          A.createElement(Markdown,{commandLine:command},command));
      },
      appError:function appError({message}) {
        const makeFrame = () => document.createElement('iframe'), testid = 'mcp-app-view';
        return A.createElement('div',{className:'text-sm text-secondary-foreground'},'Could not load the app view: ',message);
      }};
  })()`);
  for (const key of ['browser','question','output','command','appError']) f.window[key] = native[key];
  f.install();
  const browser = f.window.browser().props.children;
  assert.equal(browser[0].props.children, '执行此步骤需要确认');
  assert.equal(browser[1].props.children, '拒绝');
  assert.equal(browser[2].props.children, '确认');
  assert.equal(browser[2].props['aria-label'], 'Confirm Browser Interaction');
  assert.equal(browser[2].props.onClick, native.callback);
  const question = f.window.question({answer:'Submit'}).props.children;
  assert.equal(question[0].props.children, '取消');
  assert.equal(question[1].props.children[0], '提交');
  assert.equal(question[1].props.children[1].props.children, '↵');
  assert.equal(question[2].props.children, 'Submit');
  const raw = 'Logs\nOutput\nErrors  /tmp/a  b';
  const output = f.window.output({combinedOutput:raw}).props.children;
  assert.equal(output[0].props.children, '日志');
  assert.equal(output[1].props.children[0].props.children.join(''), '已隐藏上方 2 行');
  assert.equal(output[1].props.children[1], raw);
  const command = f.window.command({cwd:'Working Directory: ',command:'Copy Command'}).props.children;
  assert.equal(command[0].props.children[0], '工作目录：');
  assert.equal(command[0].props.children[1], 'Working Directory: ');
  assert.equal(command[1].props.commandLine, 'Copy Command');
  assert.equal(command[1].props.children, 'Copy Command');
  const error = f.window.appError({message:'Could not load the app view: '}).props.children;
  assert.equal(error[0], '无法加载应用视图：');
  assert.equal(error[1], 'Could not load the app view: ', 'the real error is preserved even when it matches the fixed prefix');
});

test('protected fallback labels are distinct from identical account names, schema titles and input text', () => {
  const f = nativeFixture();
  f.evaluate(`var Avatar = () => null;
    var account = function account({name,email}) {
      const profilePictureUrl = undefined;
      return A.createElement('button',{'data-testid':'settings-nav-item-Account'},
        A.createElement(Avatar,{name,email,src:profilePictureUrl}),
        A.createElement('div',null,A.createElement('span',null,name || email || "Account"),email && A.createElement('span',null,email)));
    };
    var checkbox = function checkbox({schema:schema,value}) {
      return A.createElement('div',null,A.createElement('input',{type:"checkbox",checked:value}),
        A.createElement('label',{className:'ml-2 text-sm select-none cursor-pointer'},schema.title||"Enabled"));
    };
    var writeIn = function writeIn({writeInPlaceholder,value}) {
      return A.createElement('textarea',{'data-testid':'ask-question-writein',placeholder:writeInPlaceholder ?? 'Other (write your answer)',value});
    };
    var badge = function badge() {
      return A.createElement('span',{role:'button','data-testid':'google3-deprecated-badge',title:'Google3 projects are deprecated. Learn more',
        'aria-label':'Google3 projects are deprecated. Learn more'},'Deprecated');
    };
  `);
  f.install();
  const accountText = props => f.window.account(props).props.children[1].props.children[0].props.children;
  assert.equal(accountText({}), '账户');
  assert.equal(accountText({name:'Account'}), 'Account');
  assert.equal(accountText({email:'Account'}), 'Account');
  assert.equal(f.window.checkbox({schema:{},value:true}).props.children[1].props.children, '已启用');
  assert.equal(f.window.checkbox({schema:{title:'Enabled'},value:true}).props.children[1].props.children, 'Enabled');
  const raw = 'Other (write your answer)';
  const fallback = f.window.writeIn({value:raw});
  assert.equal(fallback.props.placeholder, '其他（请填写你的答案）');
  assert.equal(fallback.props.value, raw);
  assert.equal(f.window.writeIn({writeInPlaceholder:raw,value:raw}).props.placeholder, raw);
  const badge = f.window.badge();
  assert.equal(badge.props.children, '已弃用');
  assert.equal(badge.props.title, 'Google3 项目已弃用。了解更多');
  assert.equal(badge.props['aria-label'], 'Google3 projects are deprecated. Learn more');
});

test('native display props translate before transitions while queries, prompts and custom media descriptions stay intact', () => {
  const f = nativeFixture({strings:{Searching:'正在搜索',Searched:'已搜索'}});
  f.evaluate(`var Transition = () => null, Card = () => null, Image = () => null;
    var search = function search({prefixOverride,query}) {
      const external = 'Open search in external browser', plural = 'result":"results';
      return A.createElement(Card,{title:A.createElement('div',null,
        A.createElement(Transition,{text:prefixOverride || 'Searching'}),A.createElement('span',null,query))});
    };
    var image = function image({step}) {
      const generatedMedia = step.generatedMedia;
      return A.createElement('div',null,A.createElement('div',{className:'text-muted-foreground text-sm mb-0.5'},'Prompt'),
        A.createElement('div',{className:'text-sm whitespace-pre-wrap'},step.prompt),
        A.createElement(Image,{alt:'Generated image preview',src:generatedMedia}));
    };
    var media = function media({item}) {
      return A.createElement(Image,{alt:item.alt||"Generated media",src:item.uri});
    };
  `);
  f.install();
  const search = f.window.search({query:'Searching'}).props.title.props.children;
  assert.equal(search[0].props.text, '正在搜索');
  assert.equal(search[1].props.children, 'Searching');
  assert.equal(f.window.search({prefixOverride:'Searching',query:'x'}).props.title.props.children[0].props.text, 'Searching');
  const image = f.window.image({step:{prompt:'Prompt',generatedMedia:'file:///Prompt'}}).props.children;
  assert.equal(image[0].props.children, '提示词');
  assert.equal(image[1].props.children, 'Prompt');
  assert.equal(image[2].props.alt, '生成图片预览');
  assert.equal(image[2].props.src, 'file:///Prompt');
  assert.equal(f.window.media({item:{uri:'file:///Generated media'}}).props.alt, '生成的媒体');
  assert.equal(f.window.media({item:{alt:'Generated media',uri:'file:///x'}}).props.alt, 'Generated media');
});

test('notification defaults keep their links and debug callback while supplied error text stays raw', () => {
  const strings = JSON.parse(fs.readFileSync(new URL('../runtime/translations.json',import.meta.url),'utf8')).strings;
  const f = nativeFixture({strings});
  const native = f.evaluate(`(() => {
    const Card = () => null, Button = () => null;
    const payload = 'Trajectory ID: fixture-id\\nError: original  error';
    const copy = () => payload, retry = () => 'native retry';
    const link = A.createElement('a',{href:'https://example.com/help',target:'_blank',rel:'noopener noreferrer'},'troubleshooting guide');
    const paragraph = 'You can prompt the model to try again or start a new conversation if the error persists.';
    return {copy,retry,link,paragraph,payload,
      message:A.createElement(A.Fragment,null,paragraph,A.createElement('span',null,' ','See our',' ',link,' ','for more help.')),
      view:function notificationView({message}) {
        const autoDismissMs = 0, shouldShowCopiedFeedback = true;
        return A.createElement(Card,{footerActions:A.createElement(A.Fragment,null,
          A.createElement(Button,{variant:'secondary',onClick:copy},'Copy debug info'),
          A.createElement(Button,{variant:'primary',onClick:retry},'Retry'))},
          A.createElement('div',{className:'flex flex-col gap-2 pt-1.5 pb-0.5'},message));
      }};
  })()`);
  f.window.notification = native.view;
  f.install();
  const result = f.window.notification({message:native.message});
  const body = result.props.children.props.children.props.children;
  assert.equal(body[0], '你可以让模型重试；如果错误持续出现，请新建对话。');
  const help = body[1].props.children;
  assert.equal(help[0], '请参阅我们的');
  assert.equal(help[1].props.children, '故障排查指南');
  assert.equal(help[2], '，获取更多帮助。');
  assert.equal(help[1].props.href, native.link.props.href);
  assert.equal(help[1].props.target, native.link.props.target);
  assert.equal(help[1].props.rel, native.link.props.rel);
  const buttons = result.props.footerActions.props.children;
  assert.equal(buttons[0].props.children, '复制调试信息');
  assert.equal(buttons[0].props.onClick, native.copy);
  assert.equal(buttons[0].props.onClick(), native.payload);
  assert.equal(buttons[1].props.children, '重试');
  assert.equal(buttons[1].props.onClick, native.retry);
  const custom = f.evaluate(`A.createElement('span',null,${JSON.stringify(native.paragraph)})`);
  const supplied = f.window.notification({message:custom}).props.children.props.children;
  assert.equal(supplied.props.children, native.paragraph);
  assert.equal(supplied.props['data-ch-keep'], true, 'the DOM pass also preserves the supplied message');
});

test('timer and agent-message titles translate at their native title owner while names and message content stay intact', () => {
  const f = nativeFixture();
  f.evaluate(`
    var titlePart = () => null;
    var formatTitle = function formatTitle(a,b) {
      var c=a?.titleParts??[];
      return c.length===0?a?.title||void 0:c.every(e=>e.part.case==="text")?c.map(e=>e.part.value).join(" ")||void 0:
        A.createElement('span',{className:'inline-flex items-center gap-1 overflow-hidden text-muted-foreground'},
          c.map((e,f)=>A.createElement(titlePart,{key:f,part:e,diffContext:b})));
    };
    var transition = function transition(props) { return A.createElement(A.Fragment,null,props.text); };
    var summary = function summary({prefix:p,content:c,progressMessage:g,customTitle:t,tooltipText:h}) {
      return A.createElement('div',{progressMessage:g,customTitle:t,tooltipText:h},
        typeof p==='string'?A.createElement(transition,{text:p}):p,c);
    };
  `);
  f.install();
  const prompt = Object.freeze({case:'markdown',value:'等待子代理返回报告。'});
  const part = Object.freeze({part:Object.freeze({case:'text',value:'30 seconds'})});
  const timer = Object.freeze({icon:'timer',aggregationKey:'timers',titlePrefix:'Timed',titleParts:Object.freeze([part]),contentBlocks:Object.freeze([prompt])});
  assert.equal(f.window.formatTitle(timer), '30 秒');
  assert.equal(part.part.value, '30 seconds');
  assert.equal(timer.contentBlocks[0], prompt);
  assert.equal(f.window.formatTitle({title:'0.5s timer: Timer has expired'}), '0.5s timer: Timer has expired', 'a plain title has no task-notification provenance');
  assert.equal(f.window.formatTitle({titleParts:[part],icon:'file',aggregationKey:'actions'}), '30 seconds');
  const header = f.window.summary({prefix:'Timed',content:f.window.formatTitle(timer),progressMessage:'Timer has expired',customTitle:'30 seconds'});
  assert.equal(header.props.children[0].props.text, '已计时');
  assert.equal(header.props.children[1], '30 秒');
  assert.equal(header.props.progressMessage, 'Timer has expired');
  assert.equal(header.props.customTitle, '30 seconds');
  assert.equal(f.window.summary({prefix:'Timing'}).props.children[0].props.text, '正在计时');
  const agent = 'Agent  $&  "Message from A" (research)';
  assert.equal(f.window.formatTitle({title:'Message from '+agent}), '来自 '+agent+' 的消息');
  assert.equal(f.window.formatTitle({title:'Message to '+agent}), '发给 '+agent+' 的消息');
  assert.equal(f.window.formatTitle({title:'Message from Parent Agent'}), '来自父智能体的消息');
  const recipient = Object.freeze({part:Object.freeze({case:'text',value:'Message from A'})});
  assert.equal(f.window.formatTitle({titleParts:[recipient],icon:'send',aggregationKey:'actions'}), 'Message from A', 'an identical agent name is data, not a notification template');
  const message = f.window.summary({prefix:'Messaged',content:agent,progressMessage:'Message from A'});
  assert.equal(message.props.children[0].props.text, '已发消息给');
  assert.equal(message.props.children[1], agent);
  assert.equal(message.props.progressMessage, 'Message from A');
  assert.equal(f.window.summary({prefix:'Messaging'}).props.children[0].props.text, '正在发消息给');
  const filePart = Object.freeze({part:Object.freeze({case:'file',value:'Message from A'})});
  assert.equal(f.window.formatTitle({titleParts:[filePart]}).props.children[0].props.part, filePart);
});

test('summary item nouns install before compiled running and completed summaries capture them', () => {
  const f = fixture();
  f.evaluate(`var items = function items({count,artifacts}) {
    return count>0?artifacts?count===1?"artifact":"artifacts":count===1?"file":"files":"";
  };
  var group = function group({steps:a,isRunning:b}) {
    if(b)return "Working";
    var parts=[];
    if(a.other){const n=items({count:a.other,artifacts:a.artifacts});parts.push(n?\`Explored \${n}\`:"Explored");}
    if(a.commands)parts.push(\`\${parts.length===0?"Ran":"ran"} \${a.commands===1?"command":"commands"}\`);
    if(a.edits)parts.push(\`\${parts.length===0?"Edited":"edited"} \${items({count:a.edits,artifacts:a.artifacts})}\`);
    return parts.length?parts.join(", "):"Done";
  };
  var running = function running(input) {
    const marker={toolSummary:input};
    return input.edit?\`Editing \${items(input)}\`:input.command?"Running command":"Exploring";
  };`);
  f.install();
  assert.equal(f.window.group({steps:{other:2,commands:1,edits:3},isRunning:false}), '已查看 文件, 已运行 命令, 已编辑 文件');
  assert.equal(f.window.group({steps:{other:1,artifacts:true},isRunning:false}), '已查看 交付物');
  assert.equal(f.window.running({edit:true,count:2,artifacts:true}), '正在编辑 交付物');
  assert.equal(f.window.items({count:0}), '');
});

test('native conversation log labels localize while real names, paths and caller labels stay raw', () => {
  const f = nativeFixture();
  let hooks = 0;
  f.window.A.useMemo = fn => { hooks++;return fn(); };
  const native = f.evaluate(`(() => {
    const Tooltip = () => null, open = () => 'native open';
    return {Tooltip,open,view:function chip({fileUri:a,artifactsDir:c,contentOverride:m,contentCustomizer:n,conversationName}) {
      var y=A.useMemo(()=>isWebUri(a),[a]),x=A.useMemo(()=>y?a:normalizeUri(a),[y,a]),file=fileKind(x,c??"_"),kind=file.kind,name=conversationName??"Conversation";
      var text=kind===8?"Task Log":kind===2||kind===3||kind===4||kind===5?A.createElement('span',null,name,
        A.createElement(A.Fragment,null,A.createElement('span',null,': '),
          A.createElement('span',{className:'text-muted-foreground'},kind===2?'Overview':kind===3?'Sections':kind===4?file.sectionName:file.displayName))):x.split('/').at(-1);
      text=m??text;
      return A.createElement(Tooltip,{tooltip:'native tooltip'},
        A.createElement('button',{'data-quotable-inline':'true','data-uri':x,onClick:open},n?n(text):text));
    }};
  })()`);
  f.evaluate(`var normalizeUri = uri=>uri,isWebUri=uri=>/^https?:/.test(uri);
    var fileKind = function fileKind(uri,root) {
      const system=".system_generated",tasks="tasks";
      if(typeof uri!=='string'||!uri.startsWith(root))return {kind:0};
      if(uri.includes('/'+system+'/'+tasks+'/'))return {kind:8};
      const resource=uri.split('/'+system+'/')[1];
      if(resource===undefined||resource.startsWith('steps/'))return {kind:0};
      if(resource==='logs')return {kind:3};
      if(resource==='logs/overview.txt')return {kind:2};
      const name=resource.split('/').at(-1).replace(/\\.[^.]+$/,'').split('_').map(part=>part[0].toUpperCase()+part.slice(1)).join(' ');
      return resource.startsWith('logs/')&&resource.endsWith('.txt')?{kind:4,sectionName:name}:{kind:5,displayName:name};
    };`);
  f.window.chip = native.view;
  f.window.Tooltip = native.Tooltip;
  f.window.open = native.open;
  f.install();
  const path = '/artifacts/convo/.system_generated/tasks/log';
  const props = {fileUri:path,artifactsDir:'/artifacts'};
  const task = f.window.chip(props).props.children;
  assert.equal(task.props.children, '任务日志');
  assert.equal(task.props['data-uri'], path);
  assert.equal(task.props.onClick, native.open);
  assert.equal(props.contentOverride, undefined, 'the caller props are unchanged');
  const file = f.window.chip({fileUri:'/project/Task Log',artifactsDir:'/artifacts'}).props.children;
  assert.equal(file.props.children, 'Task Log');
  assert.equal(file.props['data-ch-keep'], true, 'the dictionary pass also preserves the real file name');
  assert.equal(f.window.chip({...props,contentOverride:'Task Log'}).props.children.props.children, 'Task Log');
  assert.equal(f.window.chip({...props,contentCustomizer:()=>'Task Log'}).props.children.props.children, 'Task Log');
  const overview = f.window.chip({...props,fileUri:'/artifacts/convo/.system_generated/logs/overview.txt',conversationName:'Overview'}).props.children.props.children;
  assert.equal(overview.props.children[0], 'Overview', 'the same-word conversation name stays raw');
  assert.equal(overview.props.children[1].props.children[1].props.children, '概览');
  const sections = f.window.chip({...props,fileUri:'/artifacts/convo/.system_generated/logs',conversationName:'Sections'}).props.children.props.children;
  assert.equal(sections.props.children[0], 'Sections');
  assert.equal(sections.props.children[1].props.children[1].props.children, '分区');
  assert.equal(f.window.chip({...props,fileUri:'/project/Overview'}).props.children.props.children, 'Overview');
  assert.equal(f.window.chip({...props,fileUri:'/project/Sections'}).props.children.props.children, 'Sections');
  const unnamed={...props,fileUri:'/artifacts/convo/.system_generated/logs/overview.txt'};
  assert.equal(f.window.chip(unnamed).props.children.props.children.props.children[0], '对话');
  assert.equal(f.window.chip({...unnamed,conversationName:'Conversation'}).props.children.props.children.props.children[0], 'Conversation');
  assert.equal(f.window.chip({...unnamed,contentOverride:'Conversation'}).props.children.props.children, 'Conversation');
  assert.equal(f.window.chip({...unnamed,contentCustomizer:()=> 'Conversation'}).props.children.props.children, 'Conversation');
  const transcriptProps={...props,fileUri:'/artifacts/convo/.system_generated/logs/transcript.jsonl',conversationName:'Transcript'};
  const transcript=f.window.chip(transcriptProps).props.children;
  assert.equal(transcript.props.children.props.children[0], 'Transcript', 'the conversation name stays raw');
  assert.equal(transcript.props.children.props.children[1].props.children[1].props.children, '对话记录');
  assert.equal(transcript.props['data-uri'], transcriptProps.fileUri);
  assert.equal(transcript.props.onClick, native.open);
  assert.equal(f.window.chip({...transcriptProps,contentOverride:'Transcript'}).props.children.props.children, 'Transcript');
  assert.equal(f.window.chip({...transcriptProps,contentCustomizer:()=> 'Transcript'}).props.children.props.children, 'Transcript');
  assert.equal(f.window.chip({...props,fileUri:'/project/transcript.jsonl'}).props.children.props.children, 'transcript.jsonl');
  const generatedFile=f.window.chip({...transcriptProps,fileUri:'/artifacts/convo/.system_generated/notes/transcript.jsonl'}).props.children.props.children;
  assert.equal(generatedFile.props.children[1].props.children[1].props.children, 'Transcript', 'another generated file is not the native transcript log');
  assert.equal(hooks, 34, 'each native render runs both URI Hooks once');
  const resources=[
    ['logs/transcript_full.jsonl','完整对话记录'],['logs/media','媒体'],['file_diffs.txt','文件差异'],
    ['messages','消息记录'],['subagents','子智能体'],['terminals','终端']
  ];
  for(const [relativePath,expected] of resources) {
    const fileUri='/artifacts/convo/.system_generated/'+relativePath;
    const chip=f.window.chip({...props,fileUri,conversationName:'Transcript Full'}).props.children;
    assert.equal(chip.props.children.props.children[0],'Transcript Full');
    assert.equal(chip.props.children.props.children[1].props.children[1].props.children,expected);
    assert.equal(chip.props['data-uri'],fileUri);
    assert.equal(chip.props.onClick,native.open);
  }
  assert.equal(f.window.chip({...props,fileUri:'/artifacts/convo/.system_generated/logs/custom_report.md'}).props.children.props.children.props.children[1].props.children[1].props.children,'Custom Report');
  assert.equal(f.window.chip({...props,fileUri:'/artifacts/convo/.system_generated/steps/1/output.txt'}).props.children.props.children,'output.txt');

});

test('artifact action descriptors and dialog titles localize without changing export callbacks or file names', () => {
  const strings = JSON.parse(fs.readFileSync(new URL('../runtime/translations.json',import.meta.url),'utf8')).strings;
  const f = fixture({strings});
  const native = f.evaluate(`(() => {
    const save = () => 'native export', defaultPath = () => 'Export Artifact', service = {saveFileWithDialog:save};
    const action = {tooltip:'Export Artifact',onClick:save,iconName:'download'};
    const raw = {tooltip:'Custom action',onClick:save};
    return {save,defaultPath,service,action,raw,
      dialog:function dialog({dialogService:a,getSourceUri:c,getDefaultPath:e,dialogTitle:f="Export"}) {
        const supported = a.saveFileWithDialog;
        return {service:a,source:c,path:e,title:f,save:supported};
      },
      actions:function actions() {
        const exportAsPdf = true, name = "Export Artifact";
        return {mainActions:[],overflowActions:[action,raw]};
      }};
  })()`);
  f.window.dialog = native.dialog;
  f.window.actions = native.actions;
  f.install();
  const actions = f.window.actions().overflowActions;
  assert.equal(actions[0].tooltip, '导出交付物');
  assert.equal(actions[0].onClick, native.save);
  assert.equal(actions[1], native.raw);
  assert.equal(native.action.tooltip, 'Export Artifact', 'the native descriptor is unchanged');
  const props = {dialogService:native.service,getDefaultPath:native.defaultPath,dialogTitle:'Export Artifact'};
  const dialog = f.window.dialog(props);
  assert.equal(dialog.title, '导出交付物');
  assert.equal(dialog.path, native.defaultPath);
  assert.equal(dialog.path(), 'Export Artifact', 'a same-name export file is still the original file name');
  assert.equal(dialog.service, native.service);
  assert.equal(dialog.save, native.save);
  assert.equal(props.dialogTitle, 'Export Artifact');
  assert.equal(f.window.dialog({...props,dialogTitle:undefined}).title, '导出');
  assert.equal(f.window.dialog({...props,dialogTitle:'My export'}).title, 'My export');
});

test('native export filters and Drive notification labels preserve file parameters, actions and supplied text', () => {
  const f = nativeFixture();
  let hooks = 0;
  const nativeCallbacks=[];
  f.window.A.useCallback = fn => { hooks++;nativeCallbacks.push(fn);return fn; };
  const native = f.evaluate(`(() => {
    const calls={saves:[],notifications:[],shown:[],built:[]};
    const extensions=['*'], source=()=>'file:///All Files/Uploading to Google Drive….html';
    const path=()=>'All Files', action=()=>'native action';
    class DialogService {
      #owner='native service';
      saveFileWithDialog(...args) { calls.saves.push({owner:this.#owner,args});return 'native save result'; }
    }
    const service=new DialogService();
    const extension={showNotification(options) { calls.shown.push(options);return 'native notification result'; }};
    return {calls,service,source,path,action,extensions,
      dialog:function dialog({dialogService:a,windowId:b,getSourceUri:c,getDefaultPath:e,dialogTitle:f="Export"}) {
        return A.useCallback(()=>{
          const options={title:f,defaultPath:e(),filters:[{name:"All Files",extensions}]};
          calls.built.push(options);
          return a.saveFileWithDialog(b,options,c(),action);
        },[a,b,c,e,f]);
      },
      notifications:function notifications() {
        return A.useCallback((notification,...rest)=>{
          calls.notifications.push({notification,rest});
          const {title:f,message:c,primaryAction:h,plainTextFallback:q}=notification;
          return extension.showNotification({title:f??"",message:c??q??f??"",primaryActionLabel:h?.label});
        },[]);
      }
    };
  })()`);
  f.window.dialog = native.dialog;
  f.window.notifications = native.notifications;
  const installed = f.install();
  assert.ok(installed.hooks.some(hook => hook.kind === 'native-upload-notification'));
  const exportProps={dialogService:native.service,windowId:42,getSourceUri:native.source,getDefaultPath:native.path};
  const handleExport=f.window.dialog(exportProps);
  assert.equal(handleExport(), 'native save result');
  assert.equal(native.calls.saves[0].owner, 'native service', 'the private service receiver stays native');
  const [windowId,options,uri,extra]=native.calls.saves[0].args;
  assert.equal(windowId, 42);
  assert.equal(options.title, '导出');
  assert.equal(options.defaultPath, 'All Files');
  assert.equal(options.filters[0].name, '所有文件');
  assert.equal(options.filters[0].extensions, native.extensions);
  assert.equal(uri, native.source());
  assert.equal(extra, native.action);
  assert.equal(native.calls.built[0].filters[0].name, 'All Files', 'native options are not mutated');
  assert.equal(exportProps.dialogService, native.service);
  const notify=f.window.notifications();
  f.window.A.useCallback = () => { hooks++;return nativeCallbacks[1]; };
  assert.equal(f.window.notifications(), notify, 'the native memoized callback retains its identity across renders');
  const url='https://drive.google.com/All%20Files';
  const progress={tag:'upload-to-drive-progress',title:'Uploading to Google Drive…',autoDismissMs:0};
  assert.equal(notify(progress), 'native notification result');
  assert.equal(native.calls.shown[0].title, '正在上传到 Google 云端硬盘…');
  assert.equal(native.calls.notifications[0].notification.autoDismissMs, 0);
  const success={tag:'upload-to-drive-toast',title:'Uploaded to Google Drive',message:'Link copied to clipboard.',
    primaryAction:{label:'Open',url},actionCallback:native.action,openUri:native.action};
  notify(success,'tail');
  const localized=native.calls.notifications[1].notification;
  assert.equal(localized.title, '已上传到 Google 云端硬盘');
  assert.equal(localized.message, '链接已复制到剪贴板。');
  assert.equal(localized.primaryAction.label, '打开');
  assert.equal(localized.primaryAction.url, url);
  assert.equal(localized.actionCallback, native.action);
  assert.equal(localized.openUri, native.action);
  assert.equal(native.calls.notifications[1].rest[0], 'tail');
  assert.equal(success.primaryAction.label, 'Open');
  notify({tag:'upload-to-drive-error-toast',title:'Failed to upload HTML artifact to Drive'});
  assert.equal(native.calls.shown[2].title, 'HTML 交付物上传到云端硬盘失败');
  const supplied={tag:'upload-to-drive-toast',title:'My upload',message:'Uploaded to Google Drive',primaryAction:{label:'Custom',url}};
  notify(supplied);
  assert.equal(native.calls.notifications[3].notification, supplied, 'supplied text stays verbatim on the native tag');
  const unrelated={...success,tag:'custom-notification'};
  notify(unrelated);
  assert.equal(native.calls.notifications[4].notification, unrelated, 'another notification retains identical English text');
  assert.equal(hooks, 3, 'each native Hook factory runs once per render');
});

test('artifact fallback literals and review failure labels stay distinct from supplied errors and comment text', () => {
  const f = nativeFixture({strings:{'Export Artifact':'导出交付物'}});
  let hooks = 0;
  f.window.A.useMemo = fn => { hooks++;return fn(); };
  f.evaluate(`
    var artifactState={type:'deleted'}, hasRecord=false;
    var currentArtifact=()=>artifactState, artifactRecord=()=>hasRecord, ArtifactViewer=()=>null;
    var artifactActions=function artifactActions(){const exportAsPdf=true;return {overflowActions:[{tooltip:"Export Artifact"}]};};
    var artifactOwner=function artifactOwner({auxArtifactViewState:a}) {
      const F=currentArtifact(),G=artifactRecord();
      const state=A.useMemo(()=>{var error=F?.type==="error"?F.error:void 0;
        F?.type!=="deleted"||G||(error="Artifact not found");return {error};},[F,G]);
      return A.createElement(ArtifactViewer,{fileStateProvider:state,uri:a.artifact.sourceUri,actions:artifactActions()});
    };
    var review=function review() {
      const labels={"Submit comment":true,"Review ":true};
      return A.createElement('div',null,
        A.createElement('div',{className:'text-error text-xs px-1'},'Failed to submit comment. Please try again.'),
        A.createElement('p',null,'Failed to submit comment. Please try again.'));
    };
  `);
  f.install();
  const props={auxArtifactViewState:{artifact:{sourceUri:'file:///Artifact not found.md'}}};
  const missing=f.window.artifactOwner(props);
  assert.equal(missing.props.fileStateProvider.error, '未找到交付物');
  assert.equal(missing.props.uri, props.auxArtifactViewState.artifact.sourceUri);
  assert.equal(missing.props.actions.overflowActions[0].tooltip, '导出交付物', 'the compiled owner captures its adapted menu dependency');
  f.window.artifactState={type:'error',error:'Artifact not found'};
  assert.equal(f.window.artifactOwner(props).props.fileStateProvider.error, 'Artifact not found');
  f.window.artifactState={type:'deleted'};
  f.window.hasRecord=true;
  assert.equal(f.window.artifactOwner(props).props.fileStateProvider.error, undefined);
  assert.equal(hooks, 3, 'a native owner executes once for each render');
  const review=f.window.review().props.children;
  assert.equal(review[0].props.children, '评论提交失败，请重试。');
  assert.equal(review[1].props.children, 'Failed to submit comment. Please try again.');
});



test('step registry renderers localize native summaries while preserving matching data and Hooks', () => {
  const f=nativeFixture();
  f.evaluate(`
    var hookCalls=0;
    A.useMemo=(fn)=>{hookCalls++;return fn()};A.useState=value=>{hookCalls++;return [value,()=>{}]};
    A.useEffect=()=>{hookCalls++};A.useId=()=>{hookCalls++;return 'fixture'};A.useContext=()=>{hookCalls++;return null};
    var XY=()=>null,cZ=()=>null,gZ=()=>null,PC=()=>null,QEb=()=>null,mBb=()=>null,kBb=()=>null,fz=()=>null,X=()=>null,AA=()=>null;
    var WC=()=>({openUrlInSystemBrowser:()=>{}});
    var transition=props=>A.createElement(A.Fragment,null,props.text);
    var aZ=function({prefix:p,content:c,progressMessage:g,customTitle:t,tooltipText:h}) {
      return A.createElement('div',{progressMessage:g,customTitle:t,tooltipText:h},typeof p==='string'?A.createElement(transition,{text:p}):p,c);
    };
    var T={CortexStepStatus:{RUNNING:1,DONE:2,WAITING:3}},cN=value=>value===1||value===3;
    var BO=()=>null,VAb=key=>[key],WAb=keys=>A.createElement('kbd',null,keys.join('+'));
    var nBb=text=>JSON.parse(text??'{}').explanation,nC=path=>path,mC=path=>path,sC=value=>value;
    var wz=()=>({workspaceInfo:{homeDir:'/',workspaceUris:[]},chatParams:{artifactsDir:'/artifacts'},renderers:{markdown:()=>null},stepHandler:{openFile:()=>{}}});
    var oC=()=>({kind:8}),mAb=()=>true;
    var namedGeneric=props=>A.createElement(XY,{title:A.createElement(aZ,{content:'Generic Tool'})});
  `);
  f.evaluate("var lFb={generic:{renderer:namedGeneric},systemMessage:{renderer:()=>A.createElement(A.Fragment,null)},\"browserClickElement\":{renderer:(({step:a,status:b,metadata:c})=>A.createElement(cZ,{loading:cN(b),title:A.createElement(aZ,{content:(cN(b)?\"Clicking\":\"Clicked\")+' element \"'+(a.description||\"in Browser\")+'\"'}),supplementaryView:null,cta:null,status:b,sourceTrajectoryStepInfo:c?.sourceTrajectoryStepInfo??null,url:a.pageMetadata?.url}))},\"browserPressKey\":{renderer:(({step:a,status:b,metadata:c})=>{var e=BO();if(a.text)var f={text:cN(b)?`Typing '${a.text}' in Browser`:`Typed '${a.text}' in Browser`};else a.key?(f=cN(b)?\"Pressing\":\"Pressed\",e=VAb(a.key,e),f={text:f+\" \"+e.join(\"+\")+\" in Browser\",node:A.createElement(A.Fragment,null,f,\" \",WAb(e),\" in Browser\")}):f={text:cN(b)?\"Simulating Key Press in Browser\":\"Simulated Key Press in Browser\"};return A.createElement(cZ,{loading:cN(b),title:A.createElement(aZ,\n{content:f.node?A.createElement(\"span\",{title:f.text,className:\"truncate\"},f.node):f.text}),supplementaryView:null,status:b,cta:null,sourceTrajectoryStepInfo:c?.sourceTrajectoryStepInfo??null,url:a.pageMetadata?.url})})},\"captureBrowserScreenshot\":{renderer:(({step:a,metadata:b,status:c,error:e})=>{var f=nBb(b?.toolCall?.argumentsJson),g=cN(c);return A.createElement(cZ,{loading:g,title:A.createElement(aZ,{content:f?g?f.replace(/^Captured/,\"Capturing\"):f:g?\"Taking Screenshot\":\"Took Screenshot\"}),supplementaryView:e?null:A.createElement(mBb,{step:a,status:c}),cta:A.createElement(kBb,{step:a}),status:c,sourceTrajectoryStepInfo:b?.sourceTrajectoryStepInfo??null,url:a.pageMetadata?.url})})},\"browserMouseWheel\":{renderer:(({step:a})=>{var b=A.createElement;var c=a.dx;a=a.dy;var e=[];c!==0&&e.push(`${c}px horizontally`);\na!==0&&e.push(`${a}px vertically`);c=e.length===0?A.createElement(aZ,{prefix:\"Scrolled\",content:A.createElement(\"span\",{className:\"font-medium\"},\"0px\")}):A.createElement(aZ,{prefix:\"Scrolled\",content:A.createElement(\"span\",{className:\"font-medium\"},e.join(\",\"))});return b.call(A,XY,{title:c,supplementaryView:null,cta:null,loading:!1})})},\"viewFile\":{renderer:(({step:a,status:b,metadata:c})=>{var e=a.absolutePathUri,\nf=sC(a.startLine),g=sC(a.endLine),{chatParams:{artifactsDir:h}}=wz();h=oC(e,h).kind===8;var k=b===T.CortexStepStatus.WAITING;k=mAb()?cN(b):k;a=h?A.createElement(aZ,{content:c?.toolSummary||(k?\"Analyzing Task Log\":\"Analyzed Task Log\")}):A.createElement(aZ,{prefix:k?\"Analyzing\":\"Analyzed\",content:A.createElement(PC,{className:\"text-muted-foreground\",fileUri:e,startLine:f,endLine:g,iconOverride:a.isSkillFile?A.createElement(IC,{icon:a.skillMetadata?.icon,logo:a.skillMetadata?.logo,size:16,className:\"stroke-1\"}):\nvoid 0})});return A.createElement(XY,{testId:\"view-file-step\",loading:cN(b),title:a,status:b,supplementaryView:null,cta:null})})},\"mquery\":{renderer:(({step:a,status:b,error:c})=>{var e=a.input,f=!!e&&e.targetDirectories.length==0&&e.targetFiles.length>0,{workspaceInfo:g}=wz(),h=(0,A.useMemo)(()=>(e?e.targetDirectories.map(l=>nC(l,g.homeDir,g.workspaceUris)):[]).join(\", \"),[e,g]),k=(0,A.useMemo)(()=>{var l=\nf?e?.targetFiles[0]:void 0;return A.createElement(\"div\",{className:\"flex items-center gap-1 overflow-hidden\"},l?A.createElement(PC,{className:\"text-muted-foreground\",fileUri:l},mC(l)):A.createElement(\"span\",{className:\"truncate text-muted-foreground\"},h),e?.goal&&A.createElement(A.Fragment,null,A.createElement(\"span\",{className:\"text-muted-foreground\"},\"for\"),A.createElement(\"span\",null,'\"',e.goal,'\"')))},[f,e?.targetFiles,e?.goal,h]);return A.createElement(gZ,{status:b,error:c,query:k,prefixOverride:cN(b)?\n\"Semantic searching\":\"Semantic searched\",numResults:a.numItemsScored})})},\"checkpoint\":{renderer:(function({step:a,debugMode:b}){var {renderers:c}=wz();c=c.markdown;var e=a.checkpointIndex;e=A.createElement(aZ,{content:`${e!==void 0&&e!==null?`Checkpoint #${e}`:\"Checkpoint\"}${a.includedStepIndexStart!==void 0&&a.includedStepIndexEnd!==void 0&&a.includedStepIndexEnd>\na.includedStepIndexStart?` (Steps ${a.includedStepIndexStart}\\u2013${a.includedStepIndexEnd-1})`:\"\"}${a.intentOnly?\" (Intent Only)\":\"\"}`});return a.userIntent?.trim()||a.sessionSummary?.trim()||a.codeChangeSummary?.trim()||a.modelSummarizationFailed||a.usedFallbackSummary?A.createElement(\"div\",{className:\"w-full my-0.5\"},A.createElement(jW,{trigger:e,maxHeight:400,defaultExpanded:b},A.createElement(\"div\",{className:\"text-secondary-foreground pl-2 pt-1 flex flex-col gap-3\"},(a.modelSummarizationFailed||\na.usedFallbackSummary)&&A.createElement(\"div\",{className:\"flex flex-row gap-2\"},a.modelSummarizationFailed&&A.createElement(\"span\",{className:\"text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium\"},\"Model Summarization Failed\"),a.usedFallbackSummary&&A.createElement(\"span\",{className:\"text-[11px] px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 font-medium\"},\"Fallback Summary Used\")),a.userIntent&&a.userIntent.trim()!==\n\"\"&&A.createElement(\"div\",null,A.createElement(\"div\",{className:\"text-xs font-semibold text-muted-foreground mb-1\"},\"User Intent\"),A.createElement(\"div\",{className:\"text-sm\"},A.createElement(c,null,a.userIntent))),a.sessionSummary&&a.sessionSummary.trim()!==\"\"&&A.createElement(\"div\",null,A.createElement(\"div\",{className:\"text-xs font-semibold text-muted-foreground mb-1\"},\"Session Summary\"),A.createElement(\"div\",{className:\"text-sm\"},A.createElement(c,null,a.sessionSummary))),a.codeChangeSummary&&\na.codeChangeSummary.trim()!==\"\"&&A.createElement(\"div\",null,A.createElement(\"div\",{className:\"text-xs font-semibold text-muted-foreground mb-1\"},\"Code Change Summary\"),A.createElement(\"div\",{className:\"text-sm\"},A.createElement(c,null,a.codeChangeSummary)))))):A.createElement(\"div\",{className:\"w-full my-0.5 px-2 min-h-8 py-1 flex items-center select-none text-sm\"},e)})},\"listResources\":{renderer:(({step:a,status:b})=>{var [c,e]=(0,A.useState)(!1),f=(0,A.useCallback)(h=>h?.startsWith(\"image/\")?A.createElement(X,{name:\"image\",className:\"h-4 w-4 text-blue-500\"}):A.createElement(X,{name:\"description\",className:\"h-4 w-4 text-gray-500\"}),[]),g=a.resources.length>3;return A.createElement(XY,{loading:cN(b),cta:A.createElement(\"div\",{className:\"text-sm\"},a.resources.length,\" result\",a.resources.length===1?\"\":\"s\"),title:A.createElement(\"div\",\nnull,A.createElement(\"span\",{className:\"text-secondary-foreground\"},\"List resources: \"),A.createElement(\"span\",null,a.serverName)),supplementaryView:a.resources.length==0?A.createElement(\"div\",{className:\"p-3 text-center text-gray-500\"},\"No resources available\"):A.createElement(\"div\",{className:\"flex max-h-80 flex-col gap-1 overflow-y-auto p-1\"},a.resources.slice(0,c?void 0:3).map(h=>{var k=h.name||h.uri||\"Unnamed resource\",l=h.description;return A.createElement(\"div\",{key:h.uri,className:\"flex items-center gap-2 rounded-md px-1 py-1\"},\nf(h.mimeType),A.createElement(\"div\",{className:\"flex w-full min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap\"},A.createElement(\"span\",{className:\"shrink-0\"},k),l&&A.createElement(\"span\",{className:\"truncate text-muted-foreground\",\"data-tooltip-id\":h.uri},l),A.createElement(fz,{id:h.uri},l)))}),g&&A.createElement(\"div\",{className:\"flex items-center gap-2 rounded-md px-1 py-0.5\",onClick:()=>{e(h=>!h)}},A.createElement(\"span\",{className:\"shrink-0 cursor-pointer text-sm text-blue-500 underline opacity-80 hover:opacity-100\"},\nc?\"Show fewer resources\":\"Show all resources\")))})})},\"finish\":{renderer:(({step:a})=>\n{var {stepHandler:b}=wz(),c=(0,A.useId)();if(a.output.raw_json!==void 0)try{var e=JSON.parse(a.output.raw_json).FilesToEdit}catch(f){console.error(\"Error parsing JSON:\",f)}if(!e)return\"\";try{return A.createElement(\"div\",null,A.createElement(\"p\",null,\"Files to edit:\"),e.map((f,g)=>{var h=f.AbsolutePath;return A.createElement(\"div\",{key:h,\"data-tooltip-id\":`${c}-${g}`},A.createElement(\"div\",{className:\"flex flex-row\"},A.createElement(\"a\",{href:h,onClick:()=>{b?.openFile(h)},className:\"direction-[rtl] grow overflow-hidden text-ellipsis whitespace-nowrap text-left font-mono underline\"},\nmC(h))),A.createElement(fz,{id:`${c}-${g}`},mC(h)))}))}catch(f){return console.error(f),null}})},\"buildCleaner\":{renderer:(({step:a,status:b,error:c})=>{var [e,f]=A.useState(!1),g=A.useId(),h=b===T.CortexStepStatus.DONE,k=cN(b),l=(a.args?.workspacePaths??[]).map(r=>r.split(\"/\").pop()),m=a.reply?.updatedBuildFiles??[],n=m.length;a=A.createElement(\"div\",\n{\"data-tooltip-id\":g},A.createElement(aZ,{prefix:h?\"Build Cleaner completed for\":\"Build Cleaner is running on\",content:A.createElement(\"span\",{className:\"truncate\"},l.join(\", \"))}));var q=h?A.createElement(\"span\",{className:\"pl-1 text-sm\"},n,\" \",n===1?\"file\":\"files\",\" \",\"updated\"):A.createElement(A.Fragment,null);m=h?A.createElement(\"div\",{className:\"px-2 py-1\"},n>0?A.createElement(\"ul\",{className:\"w-full list-inside list-none\"},m.map(r=>A.createElement(\"li\",{key:r,className:\"flex w-full flex-row items-center justify-start gap-2\"},\nA.createElement(\"p\",{className:\"text-nowrap inline-block max-w-full overflow-x-clip text-ellipsis text-secondary-foreground\"},r)))):A.createElement(\"p\",{className:\"text-nowrap inline-block max-w-full overflow-x-clip text-ellipsis text-secondary-foreground\"},\"No build files are updated.\")):null;return A.createElement(A.Fragment,null,A.createElement(XY,{loading:k,title:a,cta:q,supplementaryView:m,status:b,error:c,isExpanded:e,onToggle:()=>{h&&f(!e)},hasSupplementaryView:!!m}),A.createElement(fz,{id:g},\nA.createElement(\"div\",{className:\"max-w-md break-all whitespace-pre-wrap\"},l.join(\"\\n\"))))})},\"retrieveContent\":{renderer:(({step:a,status:b,error:c})=>{var e=a.args?.uri??[],f=(0,A.useId)(),{openUrlInSystemBrowser:g}=WC(),[h,k]=(0,A.useState)(!1),l=cN(b);a=a.reply?.results??[];var m=a.length;\ne=A.createElement(\"div\",{\"data-tooltip-id\":f},A.createElement(aZ,{prefix:l?\"Analyzing\":\"Analyzed\",content:A.createElement(\"span\",{className:\"truncate\",title:e.join(\", \")},e.join(\", \"))}));var n=l||m===0?A.createElement(A.Fragment,null):A.createElement(\"div\",{className:\"flex items-center gap-1 pl-1 text-sm text-gray-500\"},`${m}`,\" result\",m===1?\"\":\"s\");a=!l&&m>0?A.createElement(\"div\",{className:\"px-2 py-1\"},A.createElement(\"ol\",{className:\"w-full list-inside list-none\"},a.slice(0,15).map((q,r)=>{var t=\nq.title?q.title:q.binaryContent?\"Binary file\":\"\";return A.createElement(\"li\",{key:q.uri,className:\"flex w-full flex-row items-center justify-start gap-2\"},A.createElement(\"button\",{onClick:u=>{u.preventDefault();u=q.uri;u=u.startsWith(\"http://\")||u.startsWith(\"https://\")?u:`http://${u}`;g(u)},\"data-tooltip-id\":`${f}-${r}`},A.createElement(X,{name:\"link\",size:12,className:\"cursor-pointer\"})),A.createElement(\"p\",{className:\"text-nowrap inline-block max-w-[calc(100%-38px)] overflow-x-clip text-ellipsis text-secondary-foreground\"},\nt))}),m>15?A.createElement(\"li\",{key:\"more-results\",className:\"truncate text-xs\"},\"...and \",m-15,\" more\"):null)):null;return A.createElement(XY,{loading:l,title:e,cta:n,supplementaryView:a,status:b,error:c,isExpanded:h,onToggle:()=>{k(!h)},hasSupplementaryView:!!a})})}}; function lookup(a){var b=a.step.case;return(b?lFb[b]:void 0)?.isRendered(a,!1)??!1}");
  const original=f.window.lFb.browserPressKey.renderer,namedOriginal=f.window.namedGeneric;
  const adapters=f.install();
  assert.ok(adapters.hooks.some(h=>h.owner===f.window.lFb.browserPressKey&&h.key==='renderer'));
  assert.equal(f.window.namedGeneric,f.window.lFb.generic.renderer,'the global and registry aliases share one adapter');
  assert.equal(f.window.lFb.generic.renderer({}).props.title.props.content,'通用工具');
  assert.equal(f.window.lFb.generic.renderer({metadata:{toolSummary:'Generic Tool'}}).props.title.props.content,'Generic Tool');
  const description='Clicking in Browser  $&  \"quoted\"';
  const click=f.window.lFb.browserClickElement.renderer({step:{description},status:1});
  assert.equal(click.props.title.props.content,'正在点击元素“'+description+'”');
  assert.equal(f.window.lFb.browserClickElement.renderer({step:{},status:2}).props.title.props.content,'已点击浏览器中的元素');
  const text='Typed \"same\"  \n  in Browser';
  const typing=f.window.lFb.browserPressKey.renderer({step:{text},status:1});
  assert.equal(typing.props.title.props.content,'正在浏览器中输入“'+text+'”');
  const before=f.window.hookCalls;
  const key=f.window.lFb.browserPressKey.renderer({step:{key:'Pressing'},status:1}).props.title.props.content;
  assert.equal(f.window.hookCalls,before,'this native branch adds no Hooks');
  assert.equal(key.props.title,'正在浏览器中按下 Pressing');
  const keyParts=key.props.children.props.children;
  assert.equal(keyParts[0],'正在浏览器中按下 ');
  assert.equal(keyParts[1].props.children,'Pressing','key data retains its bytes');
  const fallback=f.window.lFb.captureBrowserScreenshot.renderer({step:{},status:2});
  assert.equal(fallback.props.title.props.content,'已截图');
  const supplied=f.window.lFb.captureBrowserScreenshot.renderer({step:{},metadata:{toolCall:{argumentsJson:JSON.stringify({explanation:'Took Screenshot'})}},status:2});
  assert.equal(supplied.props.title.props.content,'Took Screenshot','a supplied explanation matching a fixed label stays raw');
  const file={step:{absolutePathUri:'file:///task.md'},status:2,metadata:{toolSummary:'Analyzed Task Log'}};
  assert.equal(f.window.lFb.viewFile.renderer(file).props.title.props.content,'Analyzed Task Log');
  assert.equal(f.window.lFb.viewFile.renderer({...file,metadata:{}}).props.title.props.content,'已分析任务日志');
  const query={step:{input:{targetDirectories:[],targetFiles:[],goal:'Semantic searching'},numItemsScored:2},status:1};
  const search=f.window.lFb.mquery.renderer(query);
  assert.equal(search.props.prefixOverride,'正在进行语义搜索');
  assert.equal(search.props.query.props.children[1].props.children[1].props.children[1],'Semantic searching');
  const wheel=f.window.lFb.browserMouseWheel.renderer({step:{dx:12,dy:-3}});
  assert.equal(wheel.props.title.props.content.props.children,'12px（水平），-3px（垂直）');
  const checkpoint=f.window.lFb.checkpoint.renderer({step:{checkpointIndex:2,includedStepIndexStart:4,includedStepIndexEnd:7,intentOnly:true}});
  assert.equal(checkpoint.props.children.props.content,'检查点 #2（步骤 4–6）（仅意图）');
  const finish=f.window.lFb.finish.renderer({step:{output:{raw_json:JSON.stringify({FilesToEdit:[{AbsolutePath:'Files to edit:'}]})}}});
  assert.equal(finish.props.children[0].props.children,'待编辑文件：');
  assert.equal(finish.props.children[1][0].props.children[0].props.children.props.children,'Files to edit:','a matching file name is preserved');
  const cleaner=f.window.lFb.buildCleaner.renderer({step:{reply:{updatedBuildFiles:['No build files are updated.']}},status:2});
  assert.equal(cleaner.props.children[0].props.supplementaryView.props.children.props.children[0].props.children.props.children,'No build files are updated.','a matching updated file name is preserved');
  const emptyCleaner=f.window.lFb.buildCleaner.renderer({step:{reply:{updatedBuildFiles:[]}},status:2});
  assert.equal(emptyCleaner.props.children[0].props.supplementaryView.props.children.props.children,'没有更新构建文件。');
  f.uninstall()();
  assert.equal(f.window.lFb.browserPressKey.renderer,original,'uninstall restores the specific registry owner');
  assert.equal(f.window.namedGeneric,namedOriginal);
  assert.equal(f.window.lFb.generic.renderer,namedOriginal,'uninstall also restores a registry alias of a global function');
});


test('native status helpers retain lexical selectors and preserve initialization messages',()=>{
  const f=nativeFixture();
  f.evaluate(`
    var hookCalls=0,state={executionStatus:{status:{case:'initialization',value:'Model unavailable, retrying in 5s (attempt 1/3)'}}};
    A.useContext=()=>{hookCalls++;return {cascadeContext:{state:{agentStateProvider:{}}}}};
    A.useState=initial=>{hookCalls++;return [typeof initial==='function'?initial():initial,()=>{}]};A.useEffect=()=>{hookCalls++};
    var vz={},Ch={},il=(provider,selector)=>selector.selector(state),wz=()=>({cascadeContext:{state:{agentStateProvider:{}}}});
    var ce=value=>({getTime:()=>value}),DFb=value=>Math.floor(value/1000)+'s';
    var T={CortexStepStatus:{RUNNING:1,DONE:2,WAITING:3,PENDING:4,GENERATING:5}},oLa=()=>true,IFb=steps=>steps.at(-1),gz=()=>0,IZ=()=>false,cN=()=>false;
    var Xh=(...values)=>values.filter(Boolean).join(' '),WY=({children:a,active:b})=>A.createElement('span',{className:"animate-shimmer-text",active:b},a);
    const EFb={selector:value=>value.activeHook},GFb={selector:value=>value.executionStatus},CFb={context_summary:'Compacting'};
  `);
  f.window.Date={now:()=>100000};
  f.evaluate("function FFb(){var a=(0,A.useContext)(vz)?.cascadeContext.state.agentStateProvider??Ch,b=il(a,EFb);a=b?CFb[b.hookName]:void 0;var c=a!==void 0&&b?.startedAt?ce(b.startedAt).getTime():void 0,[e,f]=(0,A.useState)(()=>Date.now());(0,A.useEffect)(()=>{if(c!==void 0){f(Date.now());var g=setInterval(()=>{f(Date.now())},1E3);return()=>{clearInterval(g)}}},[c]);if(a!==void 0&&c!==void 0&&(b=e-c,!(b<5E3)))return b<3E4?a:`${a} \\u00b7 ${DFb(b)}`};function HFb(){var {cascadeContext:{state:{agentStateProvider:a}}}=wz(),b=il(a,GFb),c=b?.status.case===\"modelRequest\"&&b.status.value.retryAt?ce(b.status.value.retryAt).getTime():void 0,[e,f]=(0,A.useState)(()=>Date.now());(0,A.useEffect)(()=>{if(c!==void 0){f(Date.now());var g=setInterval(()=>{var h=Date.now();f(h);h>=c&&clearInterval(g)},1E3);return()=>{clearInterval(g)}}},[c]);if(b?.status.case===\"initialization\")return b.status.value;if(b?.status.case===\"modelRequest\")return a=b.status.value.attempt,\nb=b.status.value.maxAttempts,a=a>0&&b>0?` (attempt ${a}/${b})`:\"\",b=c!==void 0?Math.max(0,Math.ceil((c-e)/1E3)):0,b>0?`Model unavailable, retrying in ${b}s${a}`:`Model unavailable, retrying${a}`};var JFb=({isRunning:a,steps:b,trajectoryLength:c,className:e,getStepRendererConfig:f,loadingStateTextOverride:g,hookStatusText:h})=>{var k=FFb();h=HFb()??h??k;c=c===void 0||oLa(b,c);var l=IFb(b,f);f=gz(l?.metadata);k=l?.status===T.CortexStepStatus.WAITING;var m=l?.step,n=m?.case===\"plannerResponse\",q=n?(m.value.rawThinking?.length??0)+(m.value.thinking?.length??0)+(m.value.response?.length??0):0,r=b[b.length-1];b=(()=>{if(r?.step.case!==\"checkpoint\")return!1;var y=r.step.value;return(r.status===T.CortexStepStatus.RUNNING||\nr.status===T.CortexStepStatus.PENDING||r.status===T.CortexStepStatus.GENERATING||r.status===T.CortexStepStatus.WAITING)&&!y?.intentOnly&&!!y?.renderLatestCheckpoint})();var t=n&&(l?.status===T.CortexStepStatus.RUNNING||l?.status===T.CortexStepStatus.GENERATING)&&!(!m.value.rawThinking&&!m.value.thinking)&&!m.value.response&&!m.value.thinkingDuration;l=l!==void 0&&!n&&!IZ(l)&&m?.case!==\"userInput\"&&m?.case!==\"errorMessage\"&&cN(l.status)&&!l.taskDetails;var u=a&&!k&&!t&&!l&&c,[v,w]=(0,A.useState)(null),\nx=`${u}-${n}-${q}-${f}`;(0,A.useEffect)(()=>{if(u){var y=setTimeout(()=>{w(x)},1E3);return()=>{clearTimeout(y)}}w(null)},[u,x]);a=m?.case!==\"userInput\";return!u||a&&v!==x?null:A.createElement(\"div\",{\"data-testid\":\"agent-loading\",className:Xh(\"flex items-center whitespace-nowrap py-1 text-sm text-muted-foreground min-h-8 tabular-nums\",e)},A.createElement(WY,null,g??h??(b?\"Compacting\":\"Working\")))}");
  const adapters=f.install();
  assert.equal(adapters.hooks.filter(h=>h.kind==='status-hook').length,2);
  assert.equal(f.window.HFb(),'Model unavailable, retrying in 5s (attempt 1/3)','the initialization message bypasses fixed retry templates');
  assert.equal(f.window.hookCalls,2,'the Hook helper executes once');
  const loadingProps={isRunning:true,steps:[{step:{case:'userInput',value:{}},status:2}]};
  const displayed=(props=loadingProps)=>{const node=f.window.JFb(props).props.children;return f.window.WY(node.props).props.children};
  assert.equal(displayed(),'Model unavailable, retrying in 5s (attempt 1/3)');
  f.window.state.executionStatus.status.value='Building';
  assert.equal(displayed(),'Building','an initialization label is not classified by a generic shimmer');
  f.window.state.executionStatus.status.value='Working';
  assert.equal(displayed(),'Working','an initialization label matching the native fallback stays raw');
  f.window.state.executionStatus={status:{case:'idle'}};
  assert.equal(displayed(),'等待中','the renderer owns its default fallback');
  assert.equal(displayed({...loadingProps,loadingStateTextOverride:'Working'}),'Working','a loading override retains its text');
  assert.equal(displayed({...loadingProps,hookStatusText:'Compacting'}),'Compacting','a supplied hook status retains its text');
  f.window.state.executionStatus={status:{case:'modelRequest',value:{retryAt:105000,attempt:1,maxAttempts:3}}};
  assert.equal(f.window.HFb(),'模型暂不可用，5 秒后重试（第 1/3 次尝试）');
  f.window.state.executionStatus={status:{case:'modelRequest',value:{attempt:0,maxAttempts:3}}};
  assert.equal(f.window.HFb(),'模型暂不可用，正在重试');
  f.window.state.activeHook={hookName:'context_summary',startedAt:69000};
  assert.equal(f.window.FFb(),'正在压缩 · 31秒');
  f.window.state.activeHook={hookName:'other',startedAt:69000};
  assert.equal(f.window.FFb(),undefined,'unrecognized hook status stays native');
});

test('render-info summary reuses plain titles while preserving structured data and item identity',()=>{
  const f=nativeFixture();
  f.evaluate(`var jCb=()=>null,Bf=uri=>uri.split('/').pop();`);
  f.evaluate("function kZ(a,b){var c=a?.titleParts??[];return c.length===0?a?.title||void 0:c.every(e=>e.part.case===\"text\")?c.map(e=>e.part.value).join(\" \")||void 0:A.createElement(\"span\",{className:\"inline-flex items-center gap-1 overflow-hidden text-muted-foreground\"},c.map((e,f)=>A.createElement(jCb,{key:f,part:e,diffContext:b})))};function uda(a){if(!a)return\"\";if(a){var b=[];var c=new Set;for(let e of a.titleParts??[])switch(e.part.case){case \"text\":e.part.value&&b.push(e.part.value);break;case \"file\":case \"fileDiff\":let f=e.part.value.uri;f&&!c.has(f)&&(c.add(f),b.push(Bf(f)));break;case \"agent\":e.part.value.title&&b.push(e.part.value.title)}b=b.length>0?b.join(\" \"):a.title??\"\"}else b=\"\";return(a=a.titlePrefix??\"\")&&b?`${a} ${b}`:b||a}");
  f.install();
  const part=Object.freeze({part:Object.freeze({case:'text',value:'Message from Parent Agent'})});
  const data=Object.freeze({titlePrefix:'Ran',titleParts:Object.freeze([part]),title:'Message from Parent Agent'});
  assert.equal(f.window.uda(data),'已运行 Message from Parent Agent');
  assert.equal(data.titleParts[0],part);
  assert.equal(part.part.value,'Message from Parent Agent');
  assert.equal(f.window.uda({titlePrefix:'Timed',title:'0.5s timer: Timer has expired'}),'已计时 0.5s timer: Timer has expired');
  assert.equal(f.window.uda({titlePrefix:'Custom prefix',title:'custom  title'}),'Custom prefix custom  title');
});

test('agent and task list counts share native card and running-summary ownership without translating data',()=>{
  const f=nativeFixture();
  f.evaluate(`
    var part=()=>null,card=()=>null;
    var transition=props=>A.createElement(A.Fragment,null,props.text);
    function title({prefix:p,content:c,progressMessage:g,customTitle:t,tooltipText:h}) {
      return A.createElement('div',{progressMessage:g,customTitle:t,tooltipText:h},typeof p==='string'?A.createElement(transition,{text:p}):p,c);
    }
    function formatTitle(a,b) {
      var c=a?.titleParts??[];
      return c.length===0?a?.title||void 0:c.every(e=>e.part.case==="text")?c.map(e=>e.part.value).join(" ")||void 0:
        A.createElement('span',null,c.map((e,f)=>A.createElement(part,{key:f,part:e,diffContext:b})));
    }
    function infoSummary(a) {
      if(!a)return "";var values=[];
      for(const item of a.titleParts??[])switch(item.part.case) {
        case "text":values.push(item.part.value);break;
        case "fileDiff":values.push(item.part.value.uri);break;
        case "agent":values.push(item.part.value.title);
      }
      var content=values.length?values.join(" "):a.title??"";
      return (a=a.titlePrefix??"")&&content?\`\${a} \${content}\`:content||a;
    }
    function generic(props) {
      const info=props.step.result.stepRenderInfo;
      return A.createElement(card,{status:props.status,title:A.createElement(title,{prefix:info.titlePrefix,content:formatTitle(info)}),
        supplementaryView:A.createElement('pre',null,props.step.result.output)});
    }
    var registry={generic:{renderer:generic},systemMessage:{renderer:()=>A.createElement(A.Fragment,null)}};
    function lookup(a){var b=a.step.case;return(b?registry[b]:void 0)?.isRendered(a,!1)??!1}
    function running(step) {
      const selected={toolSummary:step.metadata?.toolSummary};
      if(step.metadata?.toolAction)return step.metadata.toolAction;
      if(selected.toolSummary)return selected.toolSummary;
      const info=step.step?.value?.result?.stepRenderInfo;
      if(info)return infoSummary(info);
      return step.command?"Running command":"Exploring";
    }
    function group({steps:a,isRunning:b}) {
      if(b)return running(a[0]);
      const parts=[];
      if(a.length)parts.push("Explored");
      if(a.commands)parts.push(\`\${parts.length===0?"Ran":"ran"} commands\`);
      return parts.length?parts.join(", "):"Done";
    }
  `);
  f.install();
  const list=(tool,text,extra={})=>{
    const task=tool==='manage_task';
    const info=Object.freeze({title:'',titlePrefix:task?'Listed':'Found',icon:task?'task_alt':'robot_2',aggregationKey:task?'tasks':'actions',
      titleParts:Object.freeze([Object.freeze({part:Object.freeze({case:'text',value:text})})]),...extra});
    const value=Object.freeze({args:Object.freeze({Action:'list',Name:'self'}),result:Object.freeze({stepRenderInfo:info,output:'11 subagents\n1 task'})});
    return Object.freeze({step:Object.freeze({case:'generic',value}),metadata:Object.freeze({toolCall:Object.freeze({name:tool})})});
  };
  const render=(record,status)=>f.window.registry.generic.renderer({step:record.step.value,metadata:record.metadata,status});
  for(const [record,expected] of [[list('manage_subagents','11 subagents'),'11 个子智能体'],[list('manage_task','1 task'),'1 个任务'],[list('manage_task','0 tasks'),'0 个任务']]) {
    for(const status of [1,2]) {
      const node=render(record,status);
      assert.equal(node.props.title.props.content,expected);
      assert.equal(node.props.status,status);
      assert.equal(node.props.supplementaryView.props.children,'11 subagents\n1 task');
    }
    const prefix=record.step.value.result.stepRenderInfo.titlePrefix==='Found'?'已找到':'已列出';
    assert.equal(f.window.group({steps:[record],isRunning:true}),prefix+' '+expected);
    assert.equal(f.window.group({steps:[record],isRunning:false}),'已查看');
    assert.equal(record.step.value.args.Name,'self');
    assert.equal(f.window.formatTitle(record.step.value.result.stepRenderInfo),record.step.value.result.stepRenderInfo.titleParts[0].part.value,'the shared title formatter does not translate unscoped text parts');
  }
  const reference=Object.freeze({block:Object.freeze({case:'agent',value:Object.freeze({conversationId:'owned-agent',title:'subagent',subtitle:''})})});
  for(const [prefix,translated] of [['Found','已找到'],['Killed','已终止']]) {
    const raw=list('manage_subagents','subagent',{titlePrefix:prefix,contentBlocks:Object.freeze([reference])});
    const record={...raw,step:{...raw.step,value:{...raw.step.value,args:Object.freeze({})}}};
    assert.equal(render(record,2).props.title.props.content,'子智能体');
    assert.equal(f.window.running(record),translated+' 子智能体');
    assert.equal(record.step.value.result.stepRenderInfo.contentBlocks[0],reference);
    assert.equal(reference.block.value.title,'subagent','an identical actual agent name remains supplied data');
    assert.equal(record.step.value.result.stepRenderInfo.titleParts[0].part.value,'subagent');
    assert.equal(f.window.formatTitle(record.step.value.result.stepRenderInfo),'subagent');
    const noReference={...record,step:{...record.step,value:{...record.step.value,result:{...record.step.value.result,stepRenderInfo:{...record.step.value.result.stepRenderInfo,contentBlocks:[]}}}}};
    assert.equal(render(noReference,2).props.title.props.content,'subagent','a bare title without the owned AgentRef result stays raw');
    const custom={...record,metadata:{toolCall:{name:'custom_reader'}}};
    assert.equal(render(custom,2).props.title.props.content,'subagent');
  }
  const good=list('manage_subagents','11 subagents');
  const wrongAction={...good,step:{...good.step,value:{...good.step.value,args:{Action:'read',Name:'self'}}}};
  const wrongTool={...good,metadata:{toolCall:{name:'custom_reader'}}};
  const wrongIcon=list('manage_subagents','11 subagents',{icon:'send'});
  const wrongKey=list('manage_task','1 task',{aggregationKey:'actions'});
  const wrongPrefix=list('manage_task','1 task',{titlePrefix:'Read'});
  for(const record of [wrongAction,wrongTool,wrongIcon,wrongKey,wrongPrefix]) {
    const info=record.step.value.result.stepRenderInfo,text=info.titleParts[0].part.value;
    assert.equal(render(record,2).props.title.props.content,text);
    assert.equal(f.window.running(record),f.window.infoSummary(info));
  }
  const agentPart=Object.freeze({part:Object.freeze({case:'agent',value:Object.freeze({title:'11 subagents',conversationId:'agent-id'})})});
  const named=list('manage_subagents','11 subagents',{titleParts:Object.freeze([agentPart])});
  assert.equal(render(named,2).props.title.props.content.props.children[0].props.part,agentPart);
  assert.equal(f.window.running(named),'已找到 11 subagents');
  const supplied={...good,metadata:{...good.metadata,toolAction:'Found 11 subagents'}};
  assert.equal(f.window.running(supplied),'Found 11 subagents');
  for(const [prefix,expected] of [['Checked task','已检查任务'],['Killed task','已终止任务']]) {
    const name='Task  $&  "self"';
    const result=f.window.title({prefix,content:name});
    assert.equal(result.props.children[0].props.text,expected);
    assert.equal(result.props.children[1],name);
  }
});

test('native quota owners translate their own templates and retain server copy, links and callbacks', () => {
  const f = nativeFixture();
  const sources = {"J2a": "(a,b,c,e,f)=>{var g=\"\";(e=e!==void 0)&&c&&(g=`You need ${f?\"at least \"+f:\"more\"} AI Credits to send messages. To continue using ${a||\"this model\"} now, purchase more AI Credits.`);if(b)try{let h=(new Date(b)).toLocaleString();g+=` Your plan's baseline quota will refresh on ${h}.`}catch(h){console.warn(\"Failed to parse quota reset timestamp\",h)}e&&!c&&(g+=\" To continue using this model now, enable AI Credit overages.\");return g}", "NM": "(a,b,c,e)=>{if(!a)return null;var f=a.quotaInfo;if(!f||f.remainingFraction>0)return null;f=(f.resetTime&&ce(f.resetTime))?.toUTCString();return!f||new Date(f)<new Date?null:J2a(a.label,f,b,c,e)}", "K2a": "(a,b,c,e,f,g,h,k)=>{a:{if(a)try{let m=JSON.parse(a);for(let n of m?.error?.details||[])if(n?.metadata){var l={reason:n.reason,model:n.metadata.model,quotaResetDelay:n.metadata.quotaResetDelay,quotaResetUTCTimestamp:n.metadata.quotaResetTimeStamp};break a}}catch(m){console.warn(\"Failed to parse quota metadata\",m)}l=void 0}a=l;if(!a)return null;if(a.reason===\"RATE_LIMIT_EXCEEDED\")return{message:\"Too many requests, please try again in a bit!\",quotaBucketType:0,resetTimestamp:a?.quotaResetUTCTimestamp,\nmodelName:a?.model,quotaRefilled:!1};if(a.reason===\"QUOTA_EXHAUSTED\")return l=a?.quotaResetUTCTimestamp,b=J2a(a?.model===f&&g?g:void 0,l,h)+(\" \"+b),c=aD(c,\"utm_campaign\",\"ARGON_LIMIT_REACHED\"),{message:A.createElement(A.Fragment,null,A.createElement(\"span\",null,b,c&&A.createElement(A.Fragment,null,\" \",A.createElement(\"a\",{href:c,onClick:k,target:\"_blank\",rel:\"noopener noreferrer\",className:\"underline opacity-70 transition-opacity hover:opacity-100 cursor-pointer underline-offset-2\"},e||\"See plans\"),\n\".\"))),quotaBucketType:1,resetTimestamp:a?.quotaResetUTCTimestamp,modelName:a?.model,quotaRefilled:l?new Date(l)<new Date:!0};console.warn(\"Unknown quota limit error reason\",a.reason);return null}"};
  f.evaluate('var ce = value => new Date(value); var aD = url => url; const J2a = '+sources.J2a+'; var NM = '+sources.NM+'; var K2a = '+sources.K2a+';');
  const nativeText = f.window.NM, nativeQuotaError = f.window.K2a;
  assert.equal(Object.getOwnPropertyDescriptor(f.window,'J2a'), undefined, 'the message helper is an unwritable lexical const');
  const reset = '2099-10-24T03:04:05Z';
  const model = {label:'Gemini {time} $& “Preview”',quotaInfo:{remainingFraction:0,resetTime:reset}};
  const nativeDate = f.evaluate(`new Date(${JSON.stringify(reset)}).toLocaleString()`);
  f.install();
  assert.equal(f.window.NM(model,true,0,50), `发送消息需要至少 50 AI 积分。如需立即继续使用 ${model.label}，请购买更多 AI 积分。 你的套餐基础额度将于 ${nativeDate} 重置。`);
  assert.equal(f.window.NM(model,true,0,0), `发送消息需要更多 AI 积分。如需立即继续使用 ${model.label}，请购买更多 AI 积分。 你的套餐基础额度将于 ${nativeDate} 重置。`);
  assert.equal(f.window.NM(model,false,0,50), ` 你的套餐基础额度将于 ${nativeDate} 重置。 如需立即继续使用此模型，请启用 AI 积分超额使用。`);
  assert.equal(f.window.NM(model,false,undefined,50), ` 你的套餐基础额度将于 ${nativeDate} 重置。`);
  assert.equal(f.window.NM(null,true,0,50), null);
  assert.equal(f.window.NM({...model,quotaInfo:{...model.quotaInfo,remainingFraction:0.5}},true,0,50), null);
  const details = reason => JSON.stringify({error:{details:[{reason,metadata:{model:'model-id',quotaResetTimeStamp:reset}}]}});
  const backend = " Your plan's baseline quota will refresh on backend-date. See plans";
  const callback = () => 'native upgrade';
  const rate = f.window.K2a(details('RATE_LIMIT_EXCEEDED'),backend,'https://example.com/plans',undefined,'model-id',model.label,true,callback);
  assert.equal(rate.message,'请求过于频繁，请稍后重试！');
  const quota = f.window.K2a(details('QUOTA_EXHAUSTED'),backend,'https://example.com/plans',undefined,'model-id',model.label,true,callback);
  const span = quota.message.props.children;
  assert.equal(span.props.children[0], ` 你的套餐基础额度将于 ${nativeDate} 重置。 ${backend}`);
  assert.equal(span.props['data-ch-keep'],true, 'backend copy is also protected from the DOM dictionary pass');
  const link = span.props.children[1].props.children[1];
  assert.equal(link.props.children,'查看套餐');
  assert.equal(link.props.href,'https://example.com/plans');
  assert.equal(link.props.onClick,callback);
  const custom = f.window.K2a(details('QUOTA_EXHAUSTED'),backend,'https://example.com/plans','See plans','model-id',model.label,true,callback);
  assert.equal(custom.message.props.children.props.children[1].props.children[1].props.children,'See plans','identical supplied link text belongs to the server');
  f.uninstall()();
  assert.equal(f.window.NM,nativeText);
  assert.equal(f.window.K2a,nativeQuotaError);
});

test('system notifications localize native event titles and prefixes while retaining title parts and message summaries', () => {
  const f = nativeFixture();
  const sources = {"pOb": "a=>{var b=a.renderInfo,c=a.eventType,d=a.message;a=fZ(b);if(a!==void 0)return(b=b?.titlePrefix)?typeof a===\"string\"?`${b} ${a}`:A.createElement(\"span\",{className:\"inline-flex items-center gap-1\"},b,a):a;if(c)switch(c){case \"goal_stop\":return\"Goal Verification\";case \"idle_no_message\":return\"Idle Guard Warning\";case \"fork_notice\":return\"Fork Environment Notice\";default:return c.split(\"_\").map(f=>f.charAt(0).toUpperCase()+f.slice(1)).join(\" \")}return d?(b=d.split(\"\\n\")[0]||\"\",b.length>60?b.slice(0,\n57)+\"...\":b||\"System Message\"):\"System Message\"}", "renderer": "({step:a,debugMode:b})=>{var c=a.metadata?.auto_proceed_uri;if(c)return A.createElement(\"div\",{className:\"w-full my-0.5\"},A.createElement(AHb,{isTurboReviewMode:!0,autoProceedUris:[c]}));c=a.renderInfo;var d=a.message,f=pOb(a);a=eZ(c,b)||!!d?.trim();f=A.createElement(NY,{content:f});return a?A.createElement(\"div\",{className:\"w-full my-0.5\"},A.createElement(mS,{trigger:f,maxHeight:200,defaultExpanded:b},A.createElement(\"div\",{className:\"text-secondary-foreground pl-2\"},\nA.createElement(gZ,{renderInfo:c,fallbackMarkdown:d})))):A.createElement(\"div\",{className:\"w-full my-0.5 px-2 min-h-8 py-1 flex items-center select-none text-sm\"},f)}"};
  f.evaluate(`
    var NY = () => null, mS = () => null, gZ = () => null, AHb = () => null;
    var eZ = () => false;
    var fZ = function(a) {
      var c=a?.titleParts??[];
      return c.length===0?a?.title||void 0:c.every(e=>e.part.case==='text')?c.map(e=>e.part.value).join(' ')||void 0:
        A.createElement('span',{className:'structured-native-title'},c);
    };
  `+'const pOb = '+sources.pOb+'; const rOb = {systemMessage:{isRendered:()=>true,renderer:'+sources.renderer+'},generic:{renderer:()=>null}}; var lookup = function(a) {return (true?rOb[a]:void 0)?.isRendered(a);};');
  const installed = f.install();
  assert.ok(installed.uiKeys.includes('rOb.systemMessage.renderer'));
  const render = step => {
    f.window.stepFixture = step;
    return f.evaluate('rOb.systemMessage.renderer({step:stepFixture,debugMode:false})');
  };
  const title = result => result.props.children.props.trigger?.props.content ?? result.props.children.props.content;
  for (const [eventType,expected] of [['goal_stop','目标验证'],['idle_no_message','空闲保护提醒'],['fork_notice','分支环境通知']]) {
    const result = render({eventType,message:'Goal Verification'});
    assert.equal(title(result),expected);
    assert.equal(result.props.children.props.children.props.children.props.fallbackMarkdown,'Goal Verification');
  }
  assert.equal(title(render({})), '系统消息');
  assert.equal(title(render({message:'\nraw supplied body'})), '系统消息');
  assert.equal(title(render({message:'Goal Verification'})), 'Goal Verification');
  assert.equal(title(render({eventType:'system_message'})), 'System Message','unknown event names keep native formatting');
  assert.equal(title(render({eventType:'goal_stop',renderInfo:{title:'Goal Verification'}})), 'Goal Verification');
  assert.equal(title(render({eventType:'goal_stop',renderInfo:{titleParts:[{part:{case:'text',value:''}}]}})), '目标验证');
  assert.equal(title(render({renderInfo:{titlePrefix:'Timed',title:'30 seconds'}})), '已计时 30 seconds');
  assert.equal(title(render({renderInfo:{titlePrefix:'Custom prefix',title:'30 seconds'}})), 'Custom prefix 30 seconds');

  for (const name of ['5m timer','0.5s timer','Tea: $& 1h30m']) {
    const info = Object.freeze({title:name+': Timer has expired',icon:'',aggregationKey:'',titleParts:Object.freeze([])});
    const step = Object.freeze({eventType:'task_notification',renderInfo:info,message:'Timer has expired'});
    const result = render(step);
    assert.equal(title(result),name+'：时间已到');
    assert.equal(info.title,name+': Timer has expired','the original timer name and title remain intact');
    const body = result.props.children.props.children.props.children.props;
    assert.equal(body.renderInfo,info);
    assert.equal(body.fallbackMarkdown,step.message,'the notification body remains supplied content');
    assert.equal(title(render({renderInfo:info})),info.title,'a matching ordinary title stays raw');
    assert.equal(title(render({eventType:'goal_stop',renderInfo:info})),info.title,'another system event stays raw');
  }
  assert.equal(title(render({eventType:'task_notification',renderInfo:{titlePrefix:'Timed',title:'5m timer: Timer has expired'}})), '已计时 5m timer：时间已到');
  assert.equal(title(render({eventType:'task_notification',renderInfo:{titleParts:[{part:{case:'text',value:'5m timer: Timer has expired'}}]}})), '5m timer: Timer has expired');

  const part = Object.freeze({part:Object.freeze({case:'fileUri',value:'file:///Goal Verification'})});
  const structured = title(render({renderInfo:{titlePrefix:'Read',titleParts:[part]}}));
  assert.equal(structured.props.children[0], '已读取');
  assert.equal(structured.props.children[1].props.children[0],part);
});

test('notification fallback owners distinguish supplied permission details and customization errors', () => {
  const f = nativeFixture();
  const sources = {"NJb": "function NJb({conversation:a,expanded:b,onGo:c,onDismiss:e,handleCollapse:f}){var {handleCascadeUserInteraction:g}=oz(),h=(0,A.useMemo)(()=>a.summary.annotations?.title||a.summary.summary||\"Untitled Conversation\",[a.summary.annotations?.title,a.summary.summary]),k=(0,A.useMemo)(()=>{if(b){var H=a.summary.waitingSteps[0];if(H?.step){var K=H.step.requestedInteraction;K&&K.interaction.case===\"askQuestion\"?(K=K.interaction.value,H=K?.questions?.length?{questions:K.questions,trajectoryId:a.summary.trajectoryId,\nstepIndex:H.stepIndex}:null):H=null}else H=null}else H=null;return H},[b,a]),l=(0,A.useMemo)(()=>{var H;if(!k&&b)a:if(H=a.summary.waitingSteps[0]?.step)switch(H.requestedInteraction?.interaction?.case){case \"permission\":H=H.requestedInteraction?.interaction?.value;let K=H?.resource,J=K?.action??\"\";H=J===\"escalate_admin\"?{label:\"Administrator access (UAC)\",detail:H?.reason||\"Grant one-time administrator access\",canInlineApprove:!0}:{label:`Permission: ${J}`,detail:(K?.target??\"\")||\"Grant permission\",\ncanInlineApprove:!0};break a;default:H={label:\"Input required\",detail:H.metadata?.toolCall?.name??\"Waiting for your input\",canInlineApprove:!1}}else H={label:\"Input required\",detail:\"Waiting for your input\",canInlineApprove:!1};else H=null;return H},[k,b,a]),[m,n]=(0,A.useState)([]),[q,r]=(0,A.useState)(0),[t,u]=(0,A.useState)(!1),v=(0,A.useRef)(!1),[w,x]=(0,A.useState)([]);A.useEffect(()=>{k&&(n(k.questions.map(()=>[])),x(k.questions.map(()=>\"\")),r(0))},[k?`${k.trajectoryId}:${k.stepIndex}`:null]);\nvar y=(0,A.useCallback)(async(H,K)=>{var J=d,L=d;try{if(k&&!v.current){v.current=!0;u(!0);try{let N=MJb(k.trajectoryId,k.stepIndex,k.questions,H,K);L(await J(g(a.cascadeId,N)));e()}catch(N){L(),console.error(\"[InlineActionToast] Failed to submit answer:\",N),v.current=!1,u(!1)}}}finally{J()}},[k,g,a.cascadeId,e]),B=(0,A.useCallback)((H,K)=>{if(k&&!v.current){var J=k.questions[H];J&&(J.isMultiSelect?n(L=>{L=[...L];var N=L[H]??[];N.includes(K)?L[H]=N.filter(O=>O!==K):L[H]=[...N,K];return L}):(n(L=>{L=\n[...L];L[H]=[K];return L}),H>=k.questions.length-1||r(H+1)))}},[k]),C=(0,A.useCallback)(async H=>{var K=d,J=d;try{let L=a.summary.waitingSteps[0];if(L?.step&&!t){u(!0);try{let N=j_(L.step,H);N?(J(await K(g(a.cascadeId,N))),e()):(u(!1),c())}catch(N){J(),console.error(\"[InlineActionToast] Failed to send interaction:\",N),u(!1)}}}finally{K()}},[a,t,g,c,e]),D=k?.questions[q],E=k?.questions.length??0,G=E>1,F=q>=E-1;return A.createElement(\"div\",{className:\"bg-background rounded-lg shadow-lg border overflow-hidden flex flex-col text-foreground border-l-2 border-l-orange-500\"},\nA.createElement(\"div\",{className:\"p-4 pb-2\"},A.createElement(\"div\",{className:\"flex items-center justify-between gap-2\"},A.createElement(\"button\",{className:\"text-[15px] font-medium leading-snug truncate flex-1 text-left hover:underline cursor-pointer\",onClick:H=>{H.stopPropagation();c()}},h),k&&G&&A.createElement(\"div\",{className:\"flex items-center gap-1 shrink-0\"},A.createElement(\"button\",{className:\"text-secondary-foreground hover:text-foreground text-[11px] p-0.5 rounded hover:bg-secondary/50 transition-colors\",\nonClick:H=>{H.stopPropagation();r(q>0?q-1:E-1)},\"aria-label\":\"Previous question\"},\"\\u25c0\"),A.createElement(\"span\",{className:\"text-[11px] text-secondary-foreground tabular-nums\"},q+1,\"/\",E),A.createElement(\"button\",{className:\"text-secondary-foreground hover:text-foreground text-[11px] p-0.5 rounded hover:bg-secondary/50 transition-colors\",onClick:H=>{H.stopPropagation();r(q<E-1?q+1:0)},\"aria-label\":\"Next question\"},\"\\u25b6\")),f&&A.createElement(\"button\",{className:\"text-secondary-foreground hover:text-foreground inline-flex items-center justify-center p-0.5 shrink-0\",\nonClick:H=>{H.stopPropagation();f()},\"aria-label\":\"Collapse toast\"},A.createElement(\"svg\",{viewBox:\"0 0 16 16\",fill:\"currentColor\",\"aria-hidden\":\"true\",className:\"w-4 h-4\"},A.createElement(\"path\",{d:\"M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.62-.618 4.356 4.357z\"}))),A.createElement(\"button\",{className:\"text-secondary-foreground hover:text-foreground text-sm leading-none p-0.5 shrink-0\",onClick:H=>{H.stopPropagation();e()},\"aria-label\":\"Dismiss toast\"},\"\\u2715\")),k&&D&&A.createElement(\"div\",\n{className:\"mt-2 flex flex-col gap-1\"},A.createElement(\"p\",{className:\"text-sm text-secondary-foreground leading-snug\"},D.question,D.isMultiSelect&&A.createElement(\"span\",{className:\"ml-1.5 inline-block text-[10px] px-1.5 py-0 rounded-full bg-secondary text-secondary-foreground border border-border align-middle\"},\"Multi-select\")),A.createElement(\"div\",{className:\"flex flex-col gap-1\"},D.options.map((H,K)=>{var J=(m[q]??[]).includes(H.id);return A.createElement(\"button\",{key:H.id,disabled:t,className:`text-[12px] px-2 py-1 rounded border transition-colors text-left ${J?\n\"bg-primary text-primary-foreground border-primary\":\"bg-secondary/30 text-foreground border-border hover:bg-secondary/60\"} ${t?\"opacity-50 cursor-not-allowed\":\"cursor-pointer\"}`,onClick:L=>{L.stopPropagation();B(q,H.id)},onDoubleClick:L=>{L.stopPropagation();D.isMultiSelect||(F?y(m,w):r(q+1))}},A.createElement(\"span\",{className:\"opacity-50 mr-1\"},K+1,\".\"),H.text)})),A.createElement(\"div\",{className:`flex items-center text-[12px] px-2 py-1 rounded border [color-scheme:dark] ${(w[q]??\"\").trim()?\"bg-primary text-primary-foreground border-primary\":\n\"bg-secondary/30 text-foreground border-border\"} ${t?\"opacity-50 cursor-not-allowed\":\"\"}`},A.createElement(\"span\",{className:\"opacity-50 mr-1 shrink-0\"},D.options.length+1,\".\"),A.createElement(\"input\",{type:\"text\",placeholder:\"Other (write your answer)\",value:w[q]??\"\",disabled:t,className:\"bg-transparent outline-none flex-1 placeholder:text-secondary-foreground/50\",onChange:H=>{var K=H.currentTarget.value;x(J=>{J=[...J];J[q]=K;return J})},onKeyDown:H=>{H.key===\"Enter\"&&(H.stopPropagation(),k&&(F?\ny(m,w):r(q+1)))}}))),l&&l.canInlineApprove&&A.createElement(\"div\",{className:\"mt-2 flex flex-col gap-1\"},A.createElement(\"p\",{className:\"text-[12px] font-medium text-secondary-foreground\"},l.label),A.createElement(\"p\",{className:\"text-[12px] text-secondary-foreground/80 leading-snug truncate font-mono\"},l.detail)),l&&!l.canInlineApprove&&A.createElement(\"p\",{className:\"text-sm leading-relaxed text-secondary-foreground mt-2 line-clamp-2\"},l.detail)),(k||l&&l.canInlineApprove)&&A.createElement(\"div\",\n{className:\"flex justify-start gap-2 px-4 py-3\"},k&&!F&&A.createElement(AA,{size:\"md\",variant:\"primary\",onClick:H=>{H.stopPropagation();r(q+1)}},\"Next\"),k&&F&&A.createElement(AA,{size:\"md\",variant:\"primary\",disabled:t,onClick:H=>{H.stopPropagation();y(m,w)}},\"Submit\"),l&&l.canInlineApprove&&A.createElement(A.Fragment,null,A.createElement(AA,{size:\"md\",variant:\"primary\",onClick:H=>{H.stopPropagation();C(!0)}},\"Allow\"),A.createElement(AA,{size:\"md\",variant:\"secondary\",onClick:H=>{H.stopPropagation();\nC(!1)}},\"Deny\"))))}", "V2b": "function V2b({errors:a}){var b=(0,A.useMemo)(()=>a.map(q=>`${q.path}\\u0000${q.errorDetail}`).sort().join(\"\\u0001\"),[a]),{hasDismissed:c,dismiss:e}=Q2b(a.length>0?b:void 0),[f,g]=(0,A.useState)(null),h=f===b;if(a.length===0||c)return null;var k=a.length===1?\"A customization failed to load\":`${a.length} customizations failed to load`,l=a.length>3,m=l&&!h?a.slice(0,3):a,n=a.length-3;return A.createElement(z4,{className:\"animate-in fade-in duration-200 overflow-hidden\",title:k,titleIcon:A.createElement(X,\n{name:\"error\",size:12,className:\"text-error\"}),headerActions:A.createElement(AA,{variant:\"ghost\",size:\"icon-sm\",onClick:e,\"aria-label\":\"Dismiss\"},A.createElement(X,{name:\"close\",size:16}))},A.createElement(\"div\",{className:\"flex flex-col gap-2 pt-1.5 pb-0.5 max-h-[180px] overflow-y-auto pr-1\"},m.map(q=>{var r=A.createElement,t={key:`${q.path}\\u0000${q.errorDetail}`},u=A.createElement,v={className:\"flex items-center gap-1.5 min-w-0\",title:q.path},w=A.createElement(\"span\",{className:\"shrink-0 text-muted-foreground\"},\nT2b[q.type]??\"Customization\"),x=A.createElement,y;if(!(y=q.name)){var B=q.path;y=B.split(/[/\\\\]/).filter(Boolean).pop()??B;/^[A-Z_]+\\.[a-z]+$/.test(y)&&(B=B.split(/[/\\\\]/).filter(Boolean),B.pop(),y=(B=B.pop())?`${B}/${y}`:y)}return r.call(A,\"div\",t,u.call(A,\"div\",v,w,x.call(A,\"span\",{className:\"font-mono truncate\"},y)),A.createElement(\"div\",{className:\"text-xs text-muted-foreground break-words\"},q.errorDetail||\"Unknown error.\"))})),l&&A.createElement(\"div\",{className:\"pt-1\"},A.createElement(\"button\",\n{type:\"button\",onClick:()=>{g(q=>q===b?null:b)},className:\"text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer\"},h?\"Show less\":`+${n} more (Show all)`)))}"};
  f.evaluate(`
    A.useMemo = fn => fn(); A.useCallback = fn => fn; A.useState = initial => [initial,()=>{}];
    A.useRef = value => ({current:value}); A.useEffect = () => {};
    var nativeDismiss = () => 'dismiss';
    var oz = () => ({handleCascadeUserInteraction:()=>{}}), Q2b = () => ({hasDismissed:false,dismiss:nativeDismiss});
    var z4 = () => null, AA = () => null, X = () => null, T2b = {skill:'Skill'};
  `+'var NJb = '+sources.NJb+'; var V2b = '+sources.V2b+';');
  f.install();
  const elements = value => Array.isArray(value) ? value.flatMap(elements) : value?.props ? [value,...elements(value.props.children)] : [];
  const render = step => f.window.NJb({conversation:{cascadeId:'fixture',summary:{annotations:{},summary:'Grant permission',waitingSteps:step?[{stepIndex:0,step}]:[]}},expanded:true});
  const detailClass='text-[12px] text-secondary-foreground/80 leading-snug truncate font-mono';
  const detail = step => elements(render(step)).find(node=>node.type==='p'&&node.props.className===detailClass);
  const permission = value => ({requestedInteraction:{interaction:{case:'permission',value}}});
  assert.equal(detail(permission({resource:{action:'escalate_admin'}})).props.children,'授予一次性管理员权限');
  assert.equal(detail(permission({resource:{action:'read'}})).props.children,'授予权限');
  for (const [value,expected] of [[{resource:{action:'escalate_admin'},reason:'Grant one-time administrator access'},'Grant one-time administrator access'],[{resource:{action:'read',target:'Grant permission'}},'Grant permission']]) {
    const supplied=detail(permission(value));
    assert.equal(supplied.props.children,expected);
    assert.equal(supplied.props['data-ch-keep'],true);
  }
  const waitingClass='text-sm leading-relaxed text-secondary-foreground mt-2 line-clamp-2';
  const waiting=step=>elements(render(step)).find(node=>node.type==='p'&&node.props.className===waitingClass);
  assert.equal(waiting().props.children,'等待你输入');
  const conversationTitle=elements(render()).find(node=>node.type==='button'&&node.props.children==='Grant permission');
  assert.equal(conversationTitle.props['data-ch-keep'],true);
  const supplied=waiting({metadata:{toolCall:{name:'Waiting for your input'}}});
  assert.equal(supplied.props.children,'Waiting for your input');
  assert.equal(supplied.props['data-ch-keep'],true);
  const error={path:'A customization failed to load',name:'A customization failed to load',type:'skill',errorDetail:'Waiting for your input'};
  const one=f.window.V2b({errors:[error]});
  assert.equal(one.props.title,'有一项自定义内容加载失败');
  assert.equal(one.props.headerActions.props.onClick,f.window.nativeDismiss);
  const name=elements(one).find(node=>node.type==='span'&&node.props.className==='font-mono truncate');
  assert.equal(name.props.children,error.name);
  const errorNode=elements(one).find(node=>node.type==='div'&&node.props.className==='text-xs text-muted-foreground break-words');
  assert.equal(errorNode.props.children,error.errorDetail);
  assert.equal(errorNode.props['data-ch-keep'],true);
  const path=elements(one).find(node=>node.props.title===error.path);
  assert.equal(path.props.title,error.path,'a path identical to the title fallback is preserved');
  assert.equal(path.props['data-ch-keep'],true,'paths and supplied names are also protected from the DOM dictionary pass');
  assert.equal(path.props.children[0].props.children,'技能');
  assert.equal(f.window.V2b({errors:[error,{...error,path:'other'}]}).props.title,'有 2 项自定义内容加载失败');
});

test('native OS notification services translate owned fields once and preserve notification data and question bodies', async () => {
  const f = nativeFixture();
  const sources = {"Yzc": "class{constructor(a,b,c){var e=window.nativeNotifications;this.JSC$18110_permissionRequestManager=a;this.storageService=b;this.JSC$18110_bridge=e;this.JSC$18110_stateStore=c;this.JSC$18110_bridge?.onClicked(f=>{f&&f.cascadeId&&Jgc(f.cascadeId)})}async sendNotification(a){if(this.JSC$18110_stateStore?.getEnableNotificationsForSpecialEvents()??!0){if(this.JSC$18110_bridge){if(!this.storageService.get(\"didAskForNotificationPermission\")&&this.JSC$18110_permissionRequestManager){this.storageService.store(\"didAskForNotificationPermission\",\n\"true\");let b=\"Choose whether to be notified when the agent needs your attention or completes a task.\";pi()&&(b=\"Allow Gemini to notify you when the agent needs your attention or completes a task.\");Lk(this.JSC$18110_permissionRequestManager,{id:\"notifications\",title:\"Notification Preferences\",message:b,actions:[{label:\"Dismiss\",style:\"outline\",onClick:()=>{this.JSC$18110_permissionRequestManager?.dismissPermission(\"notifications\")}},{label:\"Open Preferences\",style:\"primary\",onClick:()=>{this.openPreferences();\nthis.JSC$18110_permissionRequestManager?.dismissPermission(\"notifications\")}}]})}return this.JSC$18110_bridge.send({...a,silent:a.silent??R9(this.JSC$18110_stateStore)})}throw Error(\"Missing notifications functionality\");}}async playSound(a){var b=d,c=d;try{c(await b(Xzc(a.soundFile,this.JSC$18110_stateStore)))}finally{b()}}async openPreferences(){if(this.JSC$18110_bridge)return this.JSC$18110_bridge.openSystemPreferences();throw Error(\"Missing notifications functionality\");}async clearNotifications(){}}", "dAc": "class{constructor(a,b,c,e){this.JSC$18127_permissionRequestManager=a;this.storageService=b;this.onNavigate=Jgc;this.extensionApi=c;this.JSC$18127_stateStore=e;this.sentNotificationIds=new Set;this.tracker=new bAc;this.JSC$18127_activeNotifications=new Map;this.requiresPwaInstall=!1;this.isEmbedded=vi();this.extensionApi?this.extensionApi.getBrowserNotificationPermissionState({}).then(f=>{this.notificationPermission=f.permission??\"denied\"}).catch(f=>{console.error(\"[WebNotificationService] Failed to get permission state:\",\nf);this.notificationPermission=\"denied\"}):this.isEmbedded?(szc(f=>{Y0(f,d1(f,g1,7))&&(f=f1(f,kyc,7),this.notificationPermission=q1(f,1)??\"default\",this.requiresPwaInstall=m1(f,2)??!1,console.log(\"[WebNotificationService] Received permission state from parent:\",this.notificationPermission,\"requiresPwaInstall:\",this.requiresPwaInstall),this.notificationPermission===\"denied\"&&this.JSC$18127_stateStore?.setEnableNotificationsForSpecialEvents(!1))}),N9(Eyc())):typeof Notification!==\"undefined\"&&(this.notificationPermission=\nNotification.permission)}async playSound(a){var b=d,c=d;try{c(await b(Xzc(a.soundFile,this.JSC$18127_stateStore)))}finally{b()}}async sendNotification(a){var b=d,c=d;try{if((this.JSC$18127_stateStore?.getEnableNotificationsForSpecialEvents()??!0)&&!this.sentNotificationIds.has(a.id))if(this.requiresPwaInstall)cAc(this);else{var e=!!this.storageService.get(\"didAskForNotificationPermission\");this.notificationPermission!==\"default\"||e||(this.storageService.store(\"didAskForNotificationPermission\",\"true\"),\nthis.extensionApi?this.notificationPermission=c(await b(this.extensionApi.requestBrowserNotificationPermission({}))).permission??\"denied\":Lk(this.JSC$18127_permissionRequestManager,{id:\"notifications\",title:\"Enable Notifications\",message:\"Get notified when the agent needs your attention or completes a task.\",actions:[{label:\"Block\",style:\"outline\",onClick:()=>{this.JSC$18127_permissionRequestManager.dismissPermission(\"notifications\");this.JSC$18127_stateStore?.setEnableNotificationsForSpecialEvents(!1)}},\n{label:\"Allow\",style:\"primary\",onClick:()=>{this.isEmbedded?(N9(Fyc()),this.JSC$18127_permissionRequestManager.dismissPermission(\"notifications\")):Notification.requestPermission().then(h=>{this.notificationPermission=h;this.JSC$18127_permissionRequestManager.dismissPermission(\"notifications\");h===\"granted\"?this.sendNotification(a):this.JSC$18127_stateStore?.setEnableNotificationsForSpecialEvents(!1)})}}]}));if(this.notificationPermission===\"granted\"){this.sentNotificationIds.add(a.id);var f=a.silent??\nR9(this.JSC$18127_stateStore);if(this.extensionApi)typeof document!==\"undefined\"&&document.hasFocus()||this.extensionApi.showBrowserNotification({payload:{id:a.id,title:a.title,body:a.body,silent:f,cascadeId:a.payload?.cascadeId,path:a.payload?.cascadeId?`/c/${a.payload.cascadeId}`:void 0}}).catch(h=>{console.error(\"[WebNotificationService] Failed to show notification:\",h)});else if(this.isEmbedded){let h=nyc(myc(lyc(new K9,a.id).setTitle(a.title),a.body),f);a.payload?.cascadeId&&(h.setCascadeId(a.payload.cascadeId),\nC1(h,5,`/c/${a.payload.cascadeId}`));N9(Dyc(new L9,oyc(h)))}else if(typeof document===\"undefined\"||!document.hasFocus()){var g=new Notification(a.title,{body:a.body,silent:f,tag:a.id});a.payload?.cascadeId&&this.tracker.track(a.payload.cascadeId,g);this.JSC$18127_activeNotifications.set(a.id,g);g.onclose=()=>{this.JSC$18127_activeNotifications.get(a.id)===g&&this.JSC$18127_activeNotifications.delete(a.id)};g.onclick=()=>{window.focus();if(a.payload?.cascadeId)this.onNavigate(a.payload.cascadeId);\nthis.JSC$18127_activeNotifications.get(a.id)===g&&this.JSC$18127_activeNotifications.delete(a.id);g.close()}}}}}finally{b()}}async clearNotifications(a){if(!this.extensionApi)if(this.isEmbedded){var b=new L9;a=(new gyc).setCascadeId(a);b=j1(b,19,g1,a);N9(b)}else this.tracker.clear(a)}async openPreferences(){console.log(\"[WebNotificationService] openSystemPreferences is a no-op in browser\")}}"};
  f.evaluate('var d = value => value; var R9 = () => true; var document = {hasFocus:()=>false}; var Yzc = '+sources.Yzc+'; var dAc = '+sources.dAc+';');
  const nativeDesktop = f.window.Yzc.prototype.sendNotification, nativeWeb = f.window.dAc.prototype.sendNotification;
  const installed = f.install();
  assert.equal(installed.hooks.filter(hook=>hook.kind==='native-os-notification').length,2);
  const calls = [];
  const desktop = Object.assign(Object.create(f.window.Yzc.prototype),{
    storageService:{get:()=>true},JSC$18110_stateStore:{getEnableNotificationsForSpecialEvents:()=>true},
    JSC$18110_bridge:{send(notification){calls.push({owner:this,notification});return 'native desktop result';}}
  });
  const payload=Object.freeze({type:'request_action',cascadeId:'fixture-cascade',workspaceUri:'file:///raw  workspace',extra:{retained:true}});
  const suffixes=['  printf "$HOME"; echo “原样”\n./script  a','return document.querySelector("Code: ");\n// URL: https://example.com','https://example.com/path?q=URL:%20&x=$&'];
  const cases=[
    ['Requesting your permission in Terminal:','Command: '+suffixes[0],'终端操作需要你的许可：','命令：'+suffixes[0]],
    ['Requesting your permission to execute JavaScript:','Code: '+suffixes[1],'执行 JavaScript 需要你的许可：','代码：'+suffixes[1]],
    ['Requesting your permission to open URL:','URL: '+suffixes[2],'打开网址需要你的许可：','URL：'+suffixes[2]],
    ['The agent has a question for you:','Click to respond to the question.','智能体有一个问题需要你回答：','Click to respond to the question.'],
    ['The agent has questions for you:','Agent finished: raw question','智能体有几个问题需要你回答：','Agent finished: raw question'],
    ['Requesting your permission:','/tmp/Grant permission','需要你的许可：','/tmp/Grant permission'],
    ['Action requires your attention','The agent is waiting for your input.','有操作需要你处理','智能体正在等待你输入。']
  ];
  for (const [title,body,expectedTitle,expectedBody] of cases) {
    const notification=Object.freeze({id:String(calls.length)+payload.cascadeId,title,body,payload,silent:false,extra:'native extra'});
    assert.equal(await desktop.sendNotification(notification),'native desktop result');
    const sent=calls.at(-1).notification;
    assert.equal(sent.title,expectedTitle);
    assert.equal(sent.body,expectedBody);
    assert.equal(sent.payload,payload);
    assert.equal(sent.extra,notification.extra);
    assert.equal(sent.silent,false);
    assert.equal(notification.title,title);
    assert.equal(notification.body,body);
  }
  const summary='Agent finished: user  summary\nRequesting your permission:';
  await desktop.sendNotification({id:'agent-finished-'+payload.cascadeId+'-1',title:'Antigravity',body:'Agent finished: '+summary,payload});
  assert.equal(calls.at(-1).notification.title,'Antigravity');
  assert.equal(calls.at(-1).notification.body,'智能体已完成：'+summary);
  await desktop.sendNotification({id:'agent-finished-'+payload.cascadeId+'-2',title:'Antigravity',body:'Agent finished',payload});
  assert.equal(calls.at(-1).notification.body,'智能体已完成');
  const unrelated={id:'custom-id',title:'Antigravity',body:'Agent finished: '+summary,payload};
  await desktop.sendNotification(unrelated);
  assert.equal(calls.at(-1).notification.body,unrelated.body);
  const custom={id:'custom-id-2',title:cases[0][0],body:cases[0][1],payload:{...payload,type:'custom'}};
  await desktop.sendNotification(custom);
  assert.equal(calls.at(-1).notification.title,custom.title);
  assert.equal(calls.at(-1).notification.body,custom.body);
  const coincidentTitle=cases[6][0];
  await desktop.sendNotification({id:'agent-finished-'+payload.cascadeId+'-3',title:coincidentTitle,body:'Agent finished: '+summary,payload});
  assert.equal(calls.at(-1).notification.title,coincidentTitle,'the application name of a finished notification stays supplied');
  assert.equal(calls.at(-1).notification.body,'智能体已完成：'+summary);
  const foreign={id:'custom-request-id',title:cases[0][0],body:cases[0][1],payload};
  await desktop.sendNotification(foreign);
  assert.equal(calls.at(-1).notification.title,foreign.title,'only the native step-index and cascade ID form owns request labels');
  assert.equal(calls.at(-1).notification.body,foreign.body);
  assert.equal(calls.length,cases.length+6,'the native service is called once for each notification');
  const webCalls=[];
  const web=Object.assign(Object.create(f.window.dAc.prototype),{
    JSC$18127_stateStore:{getEnableNotificationsForSpecialEvents:()=>true},sentNotificationIds:new Set(),requiresPwaInstall:false,
    storageService:{get:()=>true},notificationPermission:'granted',
    extensionApi:{showBrowserNotification(notification){webCalls.push(notification);return Promise.resolve();}}
  });
  await web.sendNotification({id:'10'+payload.cascadeId,title:cases[1][0],body:cases[1][1],payload,silent:true});
  assert.equal(webCalls.length,1);
  assert.equal(webCalls[0].payload.title,cases[1][2]);
  assert.equal(webCalls[0].payload.body,cases[1][3]);
  assert.equal(webCalls[0].payload.silent,true);
  assert.equal(webCalls[0].payload.cascadeId,payload.cascadeId);
  assert.equal(webCalls[0].payload.path,'/c/'+payload.cascadeId);
  f.uninstall()();
  assert.equal(f.window.Yzc.prototype.sendNotification,nativeDesktop);
  assert.equal(f.window.dAc.prototype.sendNotification,nativeWeb);
});

test('conversation notification factories keep supplied identical body and action text while localizing native defaults', () => {
  const f = nativeFixture();
  const sources = {"P2b": "()=>{var a=M2b(),b=N2b(),c=O2b();return a||b||c}", "M2b": "()=>{var a=\nwz(),b=Mc().core.authService,{openUrlInSystemBrowser:c}=WC(),e=a.sendMessage,f=xz(),g=Az(),h=F2b(),k=h?.errorDetails;h=h?.stepIndex;var l=a.customLinks?.troubleshooting,m=Li().get(\"disableTOSInboxCard\")||!1,n=a.userStatus,{modelLabel:q,modelName:r}=E2b(n?.cascadeModelConfigData?.clientModelConfigs),t=n?.userTier?.upgradeSubscriptionUri??a.customLinks?.pricing,u=k?H2b({errorDetails:k,userStatus:n,upgradeSubscriptionUri:t,modelName:r,modelLabel:q,useAICredits:a?.stepHandler?.useAICredits,onUpgradeClick:()=>\n{a?.stepHandler?.logEvent(\"upgrade_subscription_clicked\",{extra:{upgrade_subscription_uri:t}})}}):void 0;A.useEffect(()=>{u?.kind===\"tosViolation\"&&b?.checkCurrentAuthStatus?.()},[u?.kind,b]);if(k&&h!==void 0&&u&&(u.kind!==\"tosViolation\"||!m))return L2b(u,{notificationId:`cortex_error-${g}-${h}`,notificationIcon:\"chat_error\",trajectoryId:g,errorDetails:k,troubleshootingLink:l,isGoogleInternal:a.chatParams.isGoogleInternal,upgradeSubscriptionUri:t,userStatus:n,stepHandler:a.stepHandler,selectedModel:a.cascadeContext.state.selectedModel,\nopenUrlInSystemBrowser:c,sendMessage:e,cascadeId:f,onReauthenticate:b?()=>{(async()=>{var v=d,w=d;try{w(await v(b.logout())),w(await v(b.showLoginFlow()))}finally{v()}})()}:void 0})}", "N2b": "()=>{var {cascadeContext:{state:{selectedModel:a},\nlayout:{setIsModelSelectorOpen:b}},stepHandler:c,userStatus:e,customLinks:f}=wz(),g=c?.useAICredits??!1,h=c?.availableCredits,{openUrlInSystemBrowser:k}=WC(),l=e?.userTier?.upgradeSubscriptionUri??f?.pricing;if(a){var m=OM(a,g,h,c?.minimumCreditAmountForUsage??50);if(m&&m.code&&m.message)return I2b({notificationId:J2b(a.label,(a.quotaInfo?.resetTime&&ce(a.quotaInfo.resetTime))?.toUTCString()),icon:\"chat_error\",message:m.message,useAICredits:g,availableCredits:h,minimumCreditAmountForUsage:c?.minimumCreditAmountForUsage??\n50,purchaseCreditsUrl:\"https://antigravity.google/g1-credits?utm_source=antigravity&utm_medium=web\",utmCampaign:\"argon_insufficient_credits_add_credits\",upgradeSubscriptionUri:l,upgradeButtonText:e?.userTier?.upgradeButtonText,email:e?.email,openUrlInSystemBrowser:k,logEvent:(n,q)=>c?.logEvent(n,q),openSetting:n=>c?.openSetting(n)??Promise.resolve(),selectAnotherModel:()=>{b(!0)}})}}", "O2b": "()=>{var {cascadeContext:{state:{selectedModel:a},layout:{setIsModelSelectorOpen:b}},authState:c,userStatus:e}=\nwz(),f=c?.state,g=(0,A.useContext)(rz),h=Li().get(\"instantPromptInput\")?!e?.cascadeModelConfigData:!1,k=e?.cascadeModelConfigData,l=k?.clientModelConfigs||[],m=!!k,[n,q]=A.useState(!1);A.useEffect(()=>{if(l.length>0||!m)q(!1);else{var r=setTimeout(()=>{q(!0)},1E3);return()=>clearTimeout(r)}},[l.length,m]);if(!(h||a||f!==\"signedIn\"&&g!==\"Cider\"))return(f=k?.errorMessage)?{id:\"model-config-error\",icon:\"chat_error\",title:\"Error Loading Models\",message:f}:l.length===0?n?{id:\"no-models-available-error\",\nicon:\"chat_error\",title:\"No Models Available\",message:\"No models are available for your current project or account. Please check your project settings and IAM permissions.\"}:void 0:{id:\"no-model-error\",icon:\"chat_error\",title:\"Select Model to Send Message\",message:\"Select a model using the model selector in the input box\",primaryAction:{label:\"Select Model\",onClick:()=>{b(!0)}}}}", "L2b": "(a,b)=>{var c=b.notificationId,e=b.notificationIcon,f=b.trajectoryId,g=b.errorDetails,h=b.troubleshootingLink,k=b.isGoogleInternal,l=b.upgradeSubscriptionUri,m=b.userStatus,n=b.stepHandler,q=b.selectedModel,\nr=b.openUrlInSystemBrowser,t=b.sendMessage,u=b.cascadeId;b=b.onReauthenticate;var v=()=>({label:\"Copy debug info\",onClick:()=>{UD(`Trajectory ID: ${f}\\nError: ${g.fullError||g.shortError}`)},shouldShowCopiedFeedback:!0}),w=x=>({label:x,onClick:()=>{t({type:7,cascadeId:u})}});switch(a.kind){case \"longTermQuotaExceeded\":return c=a.quotaLimitMessage,I2b({notificationId:J2b(c.modelName||\"model\",c.resetTimestamp),icon:e,message:c.message,useAICredits:n?.useAICredits??!1,availableCredits:n?.availableCredits,\nminimumCreditAmountForUsage:n?.minimumCreditAmountForUsage??50,purchaseCreditsUrl:\"https://antigravity.google/g1-credits?utm_source=antigravity&utm_medium=web\",upgradeSubscriptionUri:l,upgradeButtonText:m?.userTier?.upgradeButtonText,utmCampaign:\"ARGON_LIMIT_REACHED_BANNER\",email:m?.email,openUrlInSystemBrowser:r,logEvent:(B,C)=>n?.logEvent(B,C),openSetting:B=>n?.openSetting(B)??Promise.resolve()});case \"insufficientCredits\":return a=NM(q,n?.useAICredits,n?.availableCredits,n?.minimumCreditAmountForUsage),\nK2b({notificationId:`${c}-insufficient-credits`,icon:e,message:a??\"Your AI credits balance is too low to continue.\",purchaseUrl:\"https://antigravity.google/g1-credits?utm_source=antigravity&utm_medium=web\",upgradeUri:l,openUrlInSystemBrowser:r,logEvent:(B,C)=>n?.logEvent(B,C),email:m?.email});case \"verificationRequired\":let x=a.validationUrl;return{id:c,icon:e,title:\"Verification required\",message:A.createElement(\"span\",null,\"Please verify your account to continue using\",\" \",k?\"Jetski\":\"Antigravity\",\n\".\",h&&A.createElement(A.Fragment,null,\" \",A.createElement(\"a\",{href:h,target:\"_blank\",rel:\"noopener noreferrer\",className:\"underline opacity-70 transition-opacity hover:opacity-100 cursor-pointer underline-offset-2\"},\"Learn more\"))),primaryAction:{label:\"Complete verification\",onClick:()=>{r(x)}}};case \"tosViolation\":let y=a.tosErrorInfo;return{id:c,icon:e,title:\"Action required\",message:A.createElement(\"span\",null,y.message),primaryAction:{label:y.appealLinkText,onClick:()=>{r(y.appealUrl)}}};case \"unauthenticated\":return{id:c,\nicon:e,title:\"Authentication expired\",message:\"Your session has expired. Please log back in to continue.\",primaryAction:b?{label:\"Log back in\",onClick:b}:w(\"Retry\"),secondaryAction:v()};case \"retryable\":return{id:c,icon:e,title:\"Agent terminated due to error\",message:a.customMessage??\"This error is likely temporary. You can prompt the model to try again after some time.\",primaryAction:w(\"Try again\"),secondaryAction:v()};case \"generic\":return{id:c,icon:e,title:\"Agent terminated due to error\",message:a.customMessage?\nA.createElement(\"span\",null,a.customMessage):A.createElement(A.Fragment,null,\"You can prompt the model to try again or start a new conversation if the error persists.\",h&&A.createElement(\"span\",null,\" \",\"See our\",\" \",A.createElement(\"a\",{href:h,target:\"_blank\",rel:\"noopener noreferrer\",className:\"underline opacity-70 transition-opacity hover:opacity-100 cursor-pointer underline-offset-2\"},\"troubleshooting guide\"),\" \",\"for more help.\")),primaryAction:w(\"Retry\"),secondaryAction:v()}}}", "I2b": "a=>{var b=a.notificationId,c=a.icon,e=a.message,f=a.useAICredits,g=a.availableCredits,h=a.minimumCreditAmountForUsage,k=a.purchaseCreditsUrl,\nl=a.upgradeSubscriptionUri,m=a.upgradeButtonText,n=a.utmCampaign,q=a.email,r=a.openUrlInSystemBrowser,t=a.logEvent,u=a.openSetting;a=a.selectAnotherModel;if(g===void 0){let v=n?aD(l,\"utm_campaign\",n):l;return{id:b,icon:c,title:\"Model quota reached\",message:e,secondaryAction:a?{label:\"Select another model\",onClick:a}:void 0,primaryAction:v?{label:m||\"Upgrade\",onClick:()=>{r(v);t(\"upgrade_subscription_clicked\",{extra:{upgrade_subscription_uri:v}})}}:void 0}}m=n?aD(l,\"utm_campaign\",n):l;k=q?aD(k,\"email\",\nq):k;return f?g>=h?void 0:K2b({notificationId:b,icon:c,message:e,purchaseUrl:k,upgradeUri:m,openUrlInSystemBrowser:r,logEvent:t}):{id:b,icon:c,title:\"Baseline model quota reached\",message:e,primaryAction:{label:\"Enable Overages\",onClick:()=>{u({settingId:\"useAICredits\"});t(\"enable_overages_clicked\")}},secondaryAction:{label:\"See Plans\",onClick:()=>{r(l);t(\"upgrade_subscription_clicked\",{extra:{upgrade_subscription_uri:l}})},shouldShowCopiedFeedback:!1}}}", "D4": "({className:a})=>{var b=P2b(),{hasDismissed:c,dismiss:e}=Q2b(b?.id),[f,g]=(0,A.useState)(!1);(0,A.useEffect)(()=>{if(b?.autoDismissMs&&!c){var k=setTimeout(()=>{e()},b.autoDismissMs);return()=>clearTimeout(k)}},[b?.id,b?.autoDismissMs,c,e]);var h=(0,A.useCallback)(k=>{k.stopPropagation();b?.secondaryAction?.onClick();b?.secondaryAction?.shouldShowCopiedFeedback&&(g(!0),setTimeout(()=>g(!1),2E3))},[b?.secondaryAction]);return c||!b?null:A.createElement(z4,{className:a,title:A.createElement(R2b,\n{Icon:b.icon,title:b.title}),headerActions:A.createElement(AA,{variant:\"ghost\",size:\"icon-sm\",onClick:k=>{k.stopPropagation();e()},\"aria-label\":\"Dismiss\"},A.createElement(X,{name:\"close\",size:16})),footerActions:A.createElement(A.Fragment,null,b.secondaryAction&&A.createElement(AA,{variant:\"secondary\",onClick:h},f?\"Copied!\":b.secondaryAction.label),b.primaryAction&&A.createElement(AA,{variant:\"primary\",onClick:k=>{k.stopPropagation();e();b.primaryAction?.onClick()}},b.primaryAction.label))},A.createElement(\"div\",\n{className:\"flex flex-col gap-2 pt-1.5 pb-0.5\"},b?.message))}", "K2b": "a=>{var b=a.notificationId,c=a.icon,e=a.message,f=a.purchaseUrl,g=a.upgradeUri,h=a.openUrlInSystemBrowser,k=a.logEvent;a=a.email;var l=aD(\"https://antigravity.google/g1-credits?utm_source=antigravity&utm_medium=web\",\"utm_campaign\",\"argon_insufficient_credits_add_credits\");a&&(l=aD(f,\"email\",a));return{id:b,icon:c,\ntitle:\"Insufficient AI Credits\",message:e,primaryAction:{label:\"Purchase Credits\",onClick:()=>{h(l);k(\"purchase_credits_clicked\",{extra:{purchase_credits_url:l}})}},secondaryAction:{label:\"See Plans\",onClick:()=>{h(g);k(\"upgrade_subscription_clicked\",{extra:{upgrade_subscription_uri:g}})},shouldShowCopiedFeedback:!1}}}"};
  f.evaluate(`
    var counts = {contexts:0,error:0,effects:0};
    var errorFixture;
    var actionSpy = () => 'native action';
    var contextFixture = {cascadeContext:{state:{selectedModel:null},layout:{setIsModelSelectorOpen:actionSpy}},
      authState:{state:'signedIn'},userStatus:{cascadeModelConfigData:{clientModelConfigs:[{}]},userTier:{}},
      customLinks:{pricing:'https://example.com/plans'},chatParams:{isGoogleInternal:false},sendMessage:actionSpy,stepHandler:{logEvent:actionSpy}};
    var wz = () => {counts.contexts++; return contextFixture;};
    var Mc = () => ({core:{}}), WC = () => ({openUrlInSystemBrowser:actionSpy}), xz = () => 'cascade', Az = () => 'trajectory';
    var F2b = () => {counts.error++;return errorFixture ? {errorDetails:{details:'native'},stepIndex:0} : undefined;};
    var H2b = () => errorFixture, E2b = () => ({}), Li = () => ({get:()=>false});
    var OM = () => ({code:'quota',message:'raw quota template'}), J2b = () => 'quota-id', NM = () => null, aD = url => url;
    var rz = {}, d = value => value;
    const Q2b = () => ({hasDismissed:false,dismiss:actionSpy}), R2b = () => null;
    var z4 = () => null, AA = () => null, X = () => null;
    A.useState = initial => [initial,()=>{}]; A.useCallback = fn => fn; A.useContext = () => 'Cider';
    A.useEffect = () => {counts.effects++;};
  `+Object.entries(sources).map(([name,source])=>(name==='D4'?'var ':'const ')+name+' = '+source+';').join(''));
  const original=f.window.D4;
  f.install();
  const render = () => {
    const before={...f.window.counts};
    const result=f.window.D4({className:'native'});
    assert.equal(f.window.counts.contexts-before.contexts,3,'all three native providers run once in their existing order');
    assert.equal(f.window.counts.error-before.error,1);
    assert.equal(f.window.counts.effects-before.effects,3,'native effects are neither repeated nor skipped');
    return result;
  };
  const body=result=>result.props.children.props.children;
  const primary=result=>result.props.footerActions.props.children[1];
  const nativeRetry='This error is likely temporary. You can prompt the model to try again after some time.';
  f.window.errorFixture={kind:'retryable',customMessage:nativeRetry};
  const supplied=body(render());
  assert.equal(supplied.props.children,nativeRetry);
  assert.equal(supplied.props['data-ch-keep'],true);
  f.window.errorFixture={kind:'retryable'};
  assert.equal(body(render()).props.children,'这可能是暂时性错误。你可以稍后让模型重试。');
  f.window.errorFixture={kind:'unauthenticated'};
  assert.equal(body(render()).props.children,'你的登录已过期，请重新登录后继续。');
  f.window.errorFixture=undefined;
  const modelError='Your session has expired. Please log back in to continue.';
  f.window.contextFixture.userStatus.cascadeModelConfigData.errorMessage=modelError;
  const modelBody=body(render());
  assert.equal(modelBody.props.children,modelError);
  assert.equal(modelBody.props['data-ch-keep'],true);
  delete f.window.contextFixture.userStatus.cascadeModelConfigData.errorMessage;
  assert.equal(body(render()).props.children,'请使用输入框中的模型选择器选择模型');
  f.window.errorFixture={kind:'tosViolation',tosErrorInfo:{message:'Your session has expired. Please log back in to continue.',appealLinkText:'Retry',appealUrl:'https://example.com/appeal'}};
  const tos=render();
  assert.equal(body(tos).props.children,f.window.errorFixture.tosErrorInfo.message);
  assert.equal(primary(tos).props.children.props.children,'Retry');
  assert.equal(primary(tos).props.children.props['data-ch-keep'],true);
  f.window.errorFixture=undefined;
  f.window.contextFixture.cascadeContext.state.selectedModel={label:'native model'};
  f.window.contextFixture.userStatus.userTier.upgradeButtonText='Upgrade';
  const quota=render();
  assert.equal(primary(quota).props.children.props.children,'Upgrade');
  assert.equal(primary(quota).props.children.props['data-ch-keep'],true);
  delete f.window.contextFixture.userStatus.userTier.upgradeButtonText;
  assert.equal(primary(render()).props.children,'升级');
  f.uninstall()();
  assert.equal(f.window.D4,original,'uninstall restores the original component rather than the inlined provider body');
});


test('official marketplace copy follows catalog identity and current source without touching installation data', () => {
  const id='antigravity-plugins-official/plugin/gdocs', description='Read, draft, and edit docs.';
  const nameKey=`marketplace:${id}:name:Google Docs`,descriptionKey=`marketplace:${id}:description:${description}`;
  const f = nativeFixture({strings:{[nameKey]:'Google 文档',[descriptionKey]:'阅读、起草和编辑文档。'}});
  const native = f.evaluate(`(() => {
    const state={calls:0};
    const callback = () => 'native install';
    const Action = () => null;
    const card = function catalogCard({name,description}) {
      return A.createElement('div',{"data-testid":"customization-card","data-card-name":name},name,description);
    };
    return {state,callback,card,
      page:function catalogPage({items,hook}) {
        state.calls++;
        hook();
        const catalogEntries=items;
        return A.createElement('div',{'data-testid':'customizations-marketplace'},catalogEntries.map(item=>
          A.createElement(card,{key:item.search.id,name:item.name,description:item.description,
            params:item.params,search:item.search,onClick:callback,logo:item.logo,
            action:A.createElement(Action,{name:item.name,onInstall:callback})})));
      }};
  })()`);
  f.window.catalogCard=native.card;
  f.window.catalogPage=native.page;
  const adapters=f.install();
  const item={name:'Google Docs',description,logo:'https://example.com/Google%20Docs.svg',
    params:{marketplace:'antigravity-plugins-official',pluginId:'gdocs'},search:{id,marketplace:'antigravity-plugins-official'}};
  const thirdParty={...item,search:{id:'third-party/plugin/gdocs',marketplace:'third-party'}};
  const missingSource={...item,search:{id}};
  const changed={...item,description:'Read updated docs.'};
  let hooks=0;
  const original=native.page({items:[item],hook:()=>{}}).props.children[0];
  const result=f.window.catalogPage({items:[item,thirdParty,missingSource,changed],hook:()=>{hooks++;}}).props.children;
  assert.equal(hooks,1,'the native page keeps its Hook call order');
  assert.equal(native.state.calls,2,'the adapter invokes its native closure once');
  assert.equal(result[0].props.name,'Google 文档');
  assert.equal(result[0].props.description,'阅读、起草和编辑文档。');
  assert.equal(result[0].props.action.props.name,'Google 文档');
  assert.equal(result[0].props.params,item.params);
  assert.equal(result[0].props.search,item.search);
  assert.equal(result[0].props.logo,item.logo);
  assert.equal(result[0].props.onClick,native.callback);
  assert.equal(result[0].props.action.props.onInstall,native.callback);
  assert.equal(original.props.name,'Google Docs','the original React element is not mutated');
  assert.equal(item.name,'Google Docs','catalog and installation data retain their original metadata');
  assert.equal(result[1].props.name,'Google Docs','a same-name third-party card stays unchanged');
  assert.equal(result[1].props.description,description);
  assert.equal(result[2].props.name,'Google Docs','an ID alone does not establish the official source');
  assert.equal(result[3].props.name,'Google 文档');
  assert.equal(result[3].props.description,'Read updated docs.','new upstream copy cannot inherit an old translation');
  adapters.setStrings({[nameKey]:'Google 在线文档'});
  assert.equal(f.window.catalogPage({items:[item],hook:()=>{}}).props.children[0].props.name,'Google 在线文档');
  f.uninstall()();
  assert.equal(f.window.catalogPage,native.page,'uninstall restores the native catalog renderer');
});


test('background fallbacks and combined idle counters localize at their source while supplied task and section labels stay native', () => {
  const f = nativeFixture();
  let hooks = 0;
  f.window.A.useMemo = callback => { hooks++;return callback(); };
  f.window.A.useContext = context => { hooks++;return context.value; };
  f.window.eval = source => f.evaluate(source);
  f.evaluate(`
    var state = {}, provider = {};
    var wz = () => ({cascadeContext:{state:{agentStateProvider:provider}}});
    var il = (owner,selection) => selection.selector(state);
    var wda = value => value, SS = value => value.subagents ?? [], MS = value => value.runningIds ?? [], qfb = value => value;
    var T = {RenderLocation:{ABOVE_INPUT:1},CortexStepStatus:{RUNNING:1}};
    const Eda = {selector:value => value.backgroundTasks}, Fda = {selector:value => value.sections};
    const IdleContext = {Provider:{},value:null};
    const idleHook = a=>{var {cascadeContext:{state:{agentStateProvider:b}}}=wz(),c=il(b,{selector:wda}),e=SS(c),f=qfb(MS(c));c=il(b,Eda);var g=il(b,Fda),h=c?.length??0,k=(0,A.useMemo)(()=>(g??[]).filter(t=>t.locations&&t.locations.length!==0?t.locations.includes(T.RenderLocation.ABOVE_INPUT):!1),[g]),{runningCount:l,blockedCount:m}=(0,A.useMemo)(()=>{var t=e.filter(v=>v.needsAttention),u=new Set(t.map(v=>v.conversationId));return{runningCount:a==="direct"?f.filter(v=>!u.has(v)).length:e.filter(v=>!v.needsAttention&&v.status===T.CortexStepStatus.RUNNING).length,blockedCount:t.length}},[e,f,a]),n=(0,A.useMemo)(()=>{var t=l+h+k.length;if(t===0&&m===0)return"";var u=[],v=l+h;if(v>0){let w=l>0,x=h>0;u.push(\`\${v} \${w&&x?"subagents/tasks":w?l>1?"subagents":"subagent":h>1?"tasks":"task"} running\`)}for(let w of k)u.push(\`\${w.items?.length??0} \${(w.title||w.key||"accumulated items").toLowerCase()}\`);m>0&&(t===0?u.push(\`\${m} \${m>1?"subagents":"subagent"} blocked\`):u.push(\`\${m} blocked\`));return u.join(", ")},[l,m,h,k]),q=l+m>0,r=h>0;return(0,A.useMemo)(()=>({text:n,mentionsSubagents:q,mentionsTasks:r}),[n,q,r])};
    var WY = () => null;
    var idleView = function idleView(){var {text:b,mentionsSubagents:c,mentionsTasks:e}=idleHook("direct"),f=(0,A.useContext)(IdleContext);return A.createElement('div',{'data-testid':"idle-status-text",mentionsSubagents:c,mentionsTasks:e},A.createElement(WY,null,b));};
    var Gda = snapshot => snapshot?.id, Ida = id => id;
    var tasks = {selector:function(a){var b=new Map;for(var c of a?.backgroundTasks??[]){var e=c.taskSnapshot,f=Gda(e);f!==void 0&&b.set(f,{taskId:f,description:e?.description||e?.toolSummary||"Background Task",summary:e?.toolSummary||void 0,iconName:"progress_activity",isRunning:!0,stepIndex:e?.stepIndex})}c=[...b.values()].sort((g,h)=>(h.stepIndex??0)-(g.stepIndex??0));e=(a?.accumulatedSections??[]).find(g=>g.key==="background_tasks");a=[];for(let g of e?.items??[]){e=g.renderInfo;if(!e||b.has(g.id))continue;f=e.content;f=f?.case==="taskView"?f.value:void 0;a.push({taskId:g.id,description:f?.header||e.label||"Background Task",summary:e.label||void 0,iconName:e.icon||"check_circle",isRunning:!1,stepIndex:Ida(g.id),logUri:f?.logUri})}return[...c,...a]}};
    var taskConsumer = function taskConsumer(value){var rows=il(value,tasks);return rows.map(item=>({...item,key:\`task__\${item.taskId}\`,isRunning:item.isRunning}));};
  `);
  const installed = f.install();
  assert.ok(installed.hooks.some(hook => hook.kind === 'status-idle-summary'));
  assert.ok(installed.hooks.some(hook => hook.kind === 'status-background-selector'));
  f.window.state = {runningIds:['running','blocked'],subagents:[{conversationId:'blocked',needsAttention:true}],
    backgroundTasks:[{}],sections:[{locations:[1],title:'1 Subagent Running',items:[1,2]}]};
  const result = f.window.idleView();
  assert.equal(result.props.children.props.children, '2 个子代理/任务运行中, 2 1 subagent running, 1 个受阻');
  assert.equal(result.props.mentionsSubagents, true);
  assert.equal(result.props.mentionsTasks, true);
  assert.equal(hooks, 5, 'the native Hook sequence runs once');
  f.window.state = {subagents:[{conversationId:'blocked',needsAttention:true}]};
  assert.equal(f.window.idleView().props.children.props.children, '1 个子代理受阻');
  f.window.state = {sections:[{locations:[1],items:[1,2]}]};
  assert.equal(f.window.idleView().props.children.props.children, '2 累计项目');
  const input = {backgroundTasks:[{taskSnapshot:{id:'missing'}},{taskSnapshot:{id:'named',description:'Background Task'}}],
    accumulatedSections:[{key:'background_tasks',items:[{id:'done',renderInfo:{}}]}]};
  const rows = f.window.tasks.selector(input);
  assert.equal(rows[0].description, '后台任务');
  assert.equal(rows[1].description, 'Background Task', 'a supplied same-name description stays unchanged');
  assert.equal(rows[2].description, '后台任务');
});


test('official plugin detail localizes display owners while preserving source objects and prompt callbacks', () => {
  const id='antigravity-plugins-official/plugin/gcalendar',prefix=`marketplace:${id}:`;
  const strings={
    [`${prefix}name:Google Calendar`]:'Google 日历',
    [`${prefix}description:Check availability.`]:'查看空闲时间。',
    [`${prefix}readme:# Google Calendar`]:'# Google 日历',
    [`${prefix}readme:Read [calendar docs](https://example.com/calendar) with \`gcalendar\`.`]:'使用 `gcalendar` 阅读[日历文档](https://example.com/calendar)。',
    [`${prefix}readme:Do not change code`]: '这段代码不能翻译',
    [`${prefix}skill-description:Manage calendar events.`]:'管理日历活动。',
    [`${prefix}prompt:Find a time tomorrow`]: '查找明天的空闲时间'
  };
  const f=nativeFixture({strings});
  f.evaluate(`
    var detailState={local:null,installed:null,hooks:0,promptCalls:[],lookupArgs:[]};
    var detailFind=(id,items)=>items;
    var detailLocalLookup=function detailLocalLookup(a){const b={installedPlugins:detailState.local};detailState.lookupArgs.push(a);return{plugin:detailFind(a,b.installedPlugins),isLoading:b.isLoadingPlugins,refetch:b.refresh};};
    var detailCatalogLookup=function detailCatalogLookup(a){const b={installedPlugins:detailState.installed};detailState.lookupArgs.push(a);return{plugin:detailFind(a,b.installedPlugins),isLoading:b.isLoadingPlugins,refetch:b.refresh};};
    var detailProvenance=function detailProvenance({entry}){const depotPath='http://cs/';return null;};
    var detailMarkdown=()=>null,detailDoc=()=>null;
    var detailSkills=function detailSkills({skills:a,showPaths:b}){return A.createElement('div',null,a.map(skill=>A.createElement(detailDoc,{title:'/'+skill.name,description:skill.description.trim(),content:skill.content,copyPath:b?skill.path:void 0})));};
    var detailOverview=function detailOverview({plugin:a,otherSidecars:b}){const hooksJson=a.hooksJson;return A.createElement('section',{'aria-label':"Readme"},A.createElement(detailMarkdown,{markdown:a.readme,baseDirUri:a.path}),A.createElement(detailSkills,{skills:a.skills,showPaths:false}));};
    var detailPrompts=function detailPrompts({prompts:a,skills:b,onPromptSelected:f}){return A.createElement('div',null,a.map(r=>A.createElement('button',{'data-testid':'plugin-suggested-prompt-row',onClick:()=>f(r,b)},A.createElement('span',null,r.trim()))));};
    var detailPage=function detailPage({catalogId:a,entry,preview,activeTab='overview',onPromptSelected}) {
      detailState.hooks++;
      const local=detailLocalLookup('file:///plugin'),installed=detailCatalogLookup(entry),plugin=local.plugin??installed.plugin??preview;
      return A.createElement('div',null,A.createElement('h1',null,entry.displayName),A.createElement(detailProvenance,{entry}),A.createElement('p',null,entry.description),
        A.createElement(detailPrompts,{prompts:plugin.suggestedPrompts,skills:plugin.skills,onPromptSelected}),
        A.createElement('div',{id:'plugin-detail-tabpanel'},activeTab==='overview'?A.createElement(detailOverview,{plugin,otherSidecars:[],isInstalled:!!(local.plugin??installed.plugin)}):A.createElement(detailSkills,{skills:plugin.skills,showPaths:true})));
    };
  `);
  const entry={id,marketplace:'antigravity-plugins-official',displayName:'Google Calendar',description:'Check availability.'};
  const skill={name:'gcalendar',path:'file:///calendar/SKILL.md',description:'Manage calendar events.',content:'Run gcalendar with the original instructions.'};
  const preview={name:'gcalendar',readme:'# Google Calendar\n\nRead [calendar docs](https://example.com/calendar) with `gcalendar`.\n\n```js\nDo not change code\n```',
    path:'file:///calendar',skills:[skill],suggestedPrompts:['Find a time tomorrow'],hooksJson:'[]'};
  const selected=(text,skills)=>f.window.detailState.promptCalls.push({text,skills});
  const props={catalogId:id,entry,preview,onPromptSelected:selected};
  const originalPage=f.window.detailPage,originalSkills=f.window.detailSkills,adapters=f.install();
  const page=f.window.detailPage(props).props.children;
  assert.equal(f.window.detailState.hooks,1,'the detail owner invokes its original Hook sequence once');
  assert.equal(page[0].props.children,'Google 日历');
  assert.equal(page[2].props.children,'查看空闲时间。');
  const promptOwner=page[3];
  assert.equal(promptOwner.props.prompts,preview.suggestedPrompts);
  assert.equal(promptOwner.props.skills,preview.skills);
  const promptRow=f.window.detailPrompts(promptOwner.props).props.children[0];
  assert.equal(promptRow.props.children.props.children,'查找明天的空闲时间');
  promptRow.props.onClick();
  assert.equal(f.window.detailState.promptCalls[0].text,'Find a time tomorrow','selecting translated copy still submits the original prompt');
  assert.equal(f.window.detailState.promptCalls[0].skills,preview.skills,'native command matching keeps original descriptions and names');
  const overviewOwner=page[4].props.children;
  assert.equal(overviewOwner.props.plugin,preview,'the overview receives the original plugin, including budget inputs');
  const overview=f.window.detailOverview(overviewOwner.props).props.children;
  assert.equal(overview[0].props.markdown,'# Google 日历\n\n使用 `gcalendar` 阅读[日历文档](https://example.com/calendar)。\n\n```js\nDo not change code\n```');
  assert.equal(overview[0].props.baseDirUri,preview.path);
  const doc=f.window.detailSkills(overview[1].props).props.children[0];
  assert.equal(doc.props.description,'管理日历活动。');
  assert.equal(doc.props.title,'/gcalendar');
  assert.equal(doc.props.content,skill.content,'skill instructions remain original');
  assert.equal(skill.description,'Manage calendar events.');
  assert.equal(entry.displayName,'Google Calendar');
  assert.equal(preview.readme.startsWith('# Google Calendar'),true);
  f.window.detailState.local={...preview,installedFrom:{id:'third-party/plugin/gcalendar',marketplace:'third-party'}};
  const third=f.window.detailPage({...props,activeTab:'skills'}).props.children;
  assert.equal(third[0].props.children,'Google Calendar','a forged official catalog route cannot relabel a different installed plugin');
  assert.equal(third[4].props.children.props.chMarketplaceId,undefined);
  f.window.detailState.local={...preview,installedFrom:{id,marketplace:'antigravity-plugins-official'}};
  const installed=f.window.detailPage({...props,activeTab:'skills'}).props.children;
  assert.equal(installed[0].props.children,'Google 日历');
  assert.equal(installed[4].props.children.props.skills,preview.skills);
  assert.equal(f.window.detailSkills(installed[4].props.children.props).props.children[0].props.description,'管理日历活动。');
  assert.equal(f.window.detailSkills({skills:preview.skills}).props.children[0].props.description,'Manage calendar events.','the reusable list is unchanged outside an official detail owner');
  adapters.setStrings({[`${prefix}name:Google Calendar`]:'Google 在线日历'});
  assert.equal(f.window.detailPage(props).props.children[0].props.children,'Google 在线日历');
  f.uninstall()();
  assert.equal(f.window.detailPage,originalPage);
  assert.equal(f.window.detailSkills,originalSkills);
});


test('official plugin breadcrumbs translate display segments only on their exact catalog route', () => {
  const id='antigravity-plugins-official/plugin/gcalendar',nameKey=`marketplace:${id}:name:Google Calendar`;
  const f=fixture({strings:{Customizations:'自定义项',[nameKey]:'Google 日历'}});
  const native=f.evaluate(`(() => {
    const onClick=()=> 'native navigation',onRename=()=> 'native rename';
    const tail={name:'Google Calendar',onClick};
    const segments=Object.freeze([Object.freeze({name:'Customizations',onClick}),Object.freeze({name:'Google Calendar'}),tail]);
    const state={calls:0,segments};
    return {state,onClick,onRename,tail,segments,
      owner:function breadcrumbOwner({disableRename:c}) {
        const route='/customizations/plugins/',skeleton='breadcrumb-name-skeleton';
        state.calls++;return state.segments;
      }};
  })()`);
  f.window.breadcrumb=native.owner;
  f.window.location={pathname:'/customizations/marketplaces/antigravity-plugins-official/plugins/gcalendar'};
  const adapters=f.install(),result=f.window.breadcrumb({disableRename:true});
  assert.equal(native.state.calls,1,'the existing breadcrumb owner runs once');
  assert.equal(result[0].name,'自定义项');
  assert.equal(result[1].name,'Google 日历');
  assert.equal(result[0].onClick,native.onClick);
  assert.equal(result[2],native.tail,'later conversation or file segments retain their identity and original text');
  assert.equal(native.segments[0].name,'Customizations');
  assert.equal(native.segments[1].name,'Google Calendar');
  for (const pathname of ['/customizations/marketplaces/third-party/plugins/gcalendar',
    '/customizations/plugins/file-calendar','/c/Google%20Calendar',
    '/customizations/marketplaces/antigravity-plugins-official/plugins/unknown-plugin']) {
    f.window.location={pathname,search:`?id=${id}&marketplace=antigravity-plugins-official`};
    assert.equal(f.window.breadcrumb({disableRename:true}),native.segments,'a query ID does not authorize translation on another route');
  }
  f.window.location={pathname:'/customizations/marketplaces/antigravity-plugins-official/plugins/gcalendar'};
  const editable=[native.segments[0],{name:'Google Calendar',onRename:native.onRename}];
  native.state.segments=editable;
  assert.equal(f.window.breadcrumb({disableRename:false}),editable,'editable business titles remain native');
  native.state.segments=[native.segments[0],{name:'Firebase'}];
  f.window.location={pathname:'/customizations/marketplaces/antigravity-plugins-official/plugins/firebase'};
  const firebase=f.window.breadcrumb({disableRename:true});
  assert.equal(firebase[0].name,'自定义项');
  assert.equal(firebase[1].name,'Firebase','the Firebase brand remains unchanged');
  f.window.location={pathname:'/customizations/marketplaces/antigravity-plugins-official/plugins/gcalendar'};
  native.state.segments=native.segments;
  adapters.setStrings({Customizations:'自定义项',[nameKey]:'Google 在线日历'});
  assert.equal(f.window.breadcrumb({disableRename:true})[1].name,'Google 在线日历');
  f.uninstall()();
  assert.equal(f.window.breadcrumb,native.owner);
});

test('installed plugin breadcrumbs resolve official provenance through the native store even with a cached name selector', () => {
  const id='antigravity-plugins-official/plugin/chrome-devtools-plugin',key=`marketplace:${id}:name:Chrome DevTools`;
  const f=fixture({strings:{Customizations:'自定义项',[key]:'Chrome DevTools（开发者工具）'}});
  f.evaluate(`
    var bcState={plugins:[],cachedName:'chrome-devtools-plugin',path:'file:///plugins/chrome',selectorCalls:0,storeCalls:0,ownerCalls:0};
    var bcProvider={getState(){return {installedPlugins:bcState.plugins};}};
    var bcStoreValue={provider:bcProvider};
    var bcStore=function bcStore(){bcState.storeCalls++;return bcStoreValue;};
    var bcLookup=function bcLookup(path,plugins){return plugins.find(plugin=>plugin.path===path);};
    var bcSelector=function bcSelector(state,path){bcState.selectorCalls++;return bcLookup(path,state.installedPlugins)?.name};
    var bcSelect=function bcSelect(provider,options,path){return bcState.cachedName;};
    var bcName=function bcName(a){var b=bcStore();return bcSelect(b.provider,{selector:bcSelector},a)};
    var bcClick=()=>bcState.path;
    var bcOwner=function bcOwner({disableRename:c}) {
      const route='/customizations/plugins/',skeleton='breadcrumb-name-skeleton';
      bcState.ownerCalls++;const name=bcName(bcState.path);
      return [{name:'Customizations',onClick:bcClick},{name,onClick:bcClick}];
    };
  `);
  const originalStore=f.window.bcStore,originalName=f.window.bcName,originalOwner=f.window.bcOwner;
  const official={path:'file:///plugins/chrome',name:'chrome-devtools-plugin',displayName:'Chrome DevTools',
    installedFrom:{id,marketplace:'antigravity-plugins-official'}};
  f.window.bcState.plugins=[official];
  f.window.location={pathname:'/customizations/plugins/encoded-install-dir'};
  f.install();
  for(let i=0;i<2;i++) {
    const result=f.window.bcOwner({disableRename:true});
    assert.equal(result[0].name,'自定义项');
    assert.equal(result[1].name,'Chrome DevTools（开发者工具）');
    assert.equal(result[1].onClick,f.window.bcClick);
    assert.equal(result[1].onClick(),'file:///plugins/chrome');
  }
  assert.equal(f.window.bcState.storeCalls,2,'the native store Hook runs exactly once for each breadcrumb render');
  assert.equal(f.window.bcState.ownerCalls,2);
  assert.equal(f.window.bcState.selectorCalls,0,'provenance remains available when the native selector reuses its cached name');
  assert.equal(official.name,'chrome-devtools-plugin');
  assert.equal(official.displayName,'Chrome DevTools');
  f.window.location.search=`?id=${id}&marketplace=antigravity-plugins-official`;
  for (const installedFrom of [{id:'third-party/plugin/chrome-devtools-plugin',marketplace:'third-party'},
    {id,marketplace:'third-party'},{id},undefined]) {
    f.window.bcState.plugins=[{...official,installedFrom}];
    const result=f.window.bcOwner({disableRename:true});
    assert.equal(result[0].name,'Customizations');
    assert.equal(result[1].name,'chrome-devtools-plugin','same-name local and third-party plugins retain their original breadcrumb');
  }
  f.uninstall()();
  assert.equal(f.window.bcStore,originalStore);
  assert.equal(f.window.bcName,originalName);
  assert.equal(f.window.bcOwner,originalOwner);
});

// Replacement for the old single-self badge test at the end of status-formatters.test.mjs.
// Reuses existing fixture/nativeFixture. Exact English variants come only from the saved scoped catalog.
const builtinAgentTestTypes = ['self','research','browser','teamwork_preview','DeepCoder','DeepInvestigator','image-generator'];
function builtinAgentTestCatalog() {
  const file = JSON.parse(fs.readFileSync(new URL('../runtime/translations.json', import.meta.url),'utf8'));
  const strings = file.strings ?? file;
  const rows = builtinAgentTestTypes.flatMap(type => {
    const prefix = `builtin-agent:${type}:description:`;
    return Object.entries(strings).filter(([key]) => key.startsWith(prefix)).map(([key,description]) => ({
      type,english:key.slice(prefix.length),name:strings[`builtin-agent:${type}:name`],description,key
    }));
  });
  const chrome = {"prefix":"\nTroubleshooting: If the agent repeatedly fails to connect, manually configure the following MCP entry in the user's mcp_config.json file, then restart the browser agent:\n  \"chrome_devtools\": ","suffix":"Browser agent that can perform actions in user's Google Chrome browser with the given task description. The agent has access to tools for interacting with web page content (clicking, typing, navigating, etc) and controlling the browser window itself (resizing window and emulating). Please make sure to define a clear condition to return on. Note: All browser interactions are automatically recorded and saved as WebM videos to the artifacts directory. The recording video generation is asynchronous, and you'll be notified by a separate message once it's available.\n\nThe chrome_devtools MCP server is started automatically when this agent is invoked — no manual setup is required."};
  const config = "{\n  \"command\": \"/tmp/Browser  App\",\n  \"args\": [\"--label=research\", \"$&\"],\n  \"env\": {\"DEMO_VALUE\": \"Leave Me Raw\"}\n}\n";
  rows.push({type:'browser',english:chrome.prefix+config+chrome.suffix,
    name:strings['builtin-agent:browser:name'],
    description:strings['builtin-agent:browser:description-prefix']+config+strings['builtin-agent:browser:description-suffix']});
  assert.equal(new Set(rows.map(row=>row.type)).size,7,'the saved catalog covers all seven native types');
  assert.ok(rows.every(row=>row.english && row.description && row.name && row.name!==row.type));
  return {strings,rows};
}
function builtinAgentTestScript(row,changes={}) {
  const source = Object.freeze({case:'config',value:Object.freeze({opaque:'native source bytes must stay opaque'})});
  return Object.freeze({name:row.type,description:row.english,source,...changes});
}
function builtinAgentTestRecord(row,script=builtinAgentTestScript(row),path=`file:///native/builtin/agents/${row.type}`) {
  return Object.freeze({agent:script,path,isGlobal:true,content:Object.freeze({raw:'prompt bytes are not display copy'})});
}
function builtinAgentTestElements(value,predicate) {
  const found=[];
  const visit=node=>{
    if(Array.isArray(node)){node.forEach(visit);return;}
    if(!node || typeof node!=='object' || node.$$typeof!==Symbol.for('react.element')) return;
    if(predicate(node))found.push(node);
    visit(node.props.children);
    for(const key of ['title','supplementaryView','trigger','cta'])visit(node.props[key]);
  };
  visit(value);return found;
}
function builtinAgentOwnerFixture(strings) {
  const f=nativeFixture({strings});
  f.evaluate(`
    var agentTestHooks=0,agentTestEffects=[],agentTestSelections=[],agentTestViews=[],agentTestLogs=[];
    A.useState=value=>{agentTestHooks++;return [value,()=>{}]};
    A.useMemo=fn=>{agentTestHooks++;return fn()};A.useCallback=fn=>{agentTestHooks++;return fn};
    A.useEffect=fn=>{agentTestHooks++;agentTestEffects.push(fn)};
    A.useContext=()=>{agentTestHooks++;return {product:{customLinks:{}}}};
    A.useId=()=>{agentTestHooks++;return 'agent-fixture'};
    var Z=()=>null,B3=()=>null,EW=()=>null,NZb=()=>null,MZb=()=>null,p_b=()=>null,PV=()=>null,CW=()=>null;
    var VM=()=>null,WM=()=>null,Tz=()=>null,XM=()=>null,cN=()=>null,dN=()=>null,Mz=()=>null,U4=()=>null,kdc=()=>null;
    var ddc=()=>null,edc=()=>null,fdc=()=>null,gdc=()=>null,oS={};
    var SV=path=>path,UV=path=>path.split('/').at(-1),rub=UV,TV=path=>path;
    var vub=item=>item.content;
    var kX=()=>({triggerShowAgentScriptConfigModal:()=>{},registerOpenSelector:()=>({dispose(){}})});
    var gj=()=>({get:key=>key==='agentScriptsFeature'?{mainAgentName:'Main Agent',allowNewAgentScript:false}:undefined});
    var PB=()=>({updateCustomization:()=>{}}),jdc=()=>true;
    var agentSelect=(...args)=>agentTestSelections.push(args);
    var aHb=new Set(),Xh={},KY=()=>null,yY=()=>null;
    var V={CortexStepStatus:{RUNNING:1,DONE:2,CANCELED:3}},CN=value=>value===1;
    var hg={VIEW_SUBAGENT_FROM_CHAT:'view-subagent-from-chat'}; var KO=()=>((...args)=>agentTestLogs.push(args));
    var sC=()=>({stepHandler:{onViewSubagent:data=>agentTestViews.push(data)},trajectorySummariesProvider:null});
    var wl=()=>null;
    var agentTestSpec,agentTestSelectorCalls=0;
    var Ok=select=>{agentTestSelectorCalls++;return select({})};
    var ul=()=>({trajectoryMetadata:{subagentSpec:agentTestSpec}});
  `);
  f.evaluate("function rbc({conversationAgentScript:a,isSubagent:b}){return a?A.createElement(\"div\",{className:\"py-1 px-2 flex items-center gap-1 rounded-md text-secondary-foreground\",title:b?\"Subagent\":\"Agent Script\"},A.createElement(Z,{name:b?\"robot_2\":\"article_spark\",size:14,className:\"text-secondary-foreground\"}),A.createElement(\"span\",{className:\"text-xs select-none\"},a.name)):null}");
  f.evaluate("var ldc=({agentScriptsEnabled:a,selectedAgentScriptItem:b,setSelectedAgentScriptItem:c,agentCustomizations:e,refreshAgentScripts:f,isLoadingAgentScripts:g,agentScriptsError:h})=>{var [k,l]=(0,A.useState)(!1),{triggerShowAgentScriptConfigModal:m,registerOpenSelector:n}=kX(),p=gj().get(\"agentScriptsFeature\")?.mainAgentName??\"Main Agent\",r=gj(),t=r.get(\"agentScriptsFeature\"),u=t?.disableScriptModification,v=t?.allowNewAgentScript,w=t?.disableScriptCreation,x=t?.allowScriptConfiguration!==!1;r=r.get(\"inputComponent\");\nt=(0,A.useContext)(oS)?.product?.customLinks?.docsAgents;var {updateCustomization:y}=PB(),B=(0,A.useCallback)(async E=>{var G=d,F=d;try{try{E.agent&&(F(await G(y(q(Fh,{path:E.path,operation:2,customization:{case:\"agent\",value:E.agent}})))),f())}catch(H){F(),console.error(\"Failed to remove agent:\",H)}}finally{G()}},[y,f]);(0,A.useEffect)(()=>{var E=n(()=>{!g&&a&&l(!0)});return()=>{E.dispose()}},[n,g,a]);var D=(0,A.useCallback)(E=>{l(E);E&&f()},[f]),C=(0,A.useMemo)(()=>e.filter(E=>!E.agent?.disabled),\n[e]);(0,A.useEffect)(()=>{g||h||!b||C.find(E=>E.agent?.name===b.name)||c(void 0)},[g,h,b,C,c]);return jdc({agentScriptsEnabled:a,isLoadingAgentScripts:g,agentScriptsError:h,hideAgentSelectorIfEmpty:r?.hideAgentSelectorIfEmpty,agentCustomizationsCount:e.length,selectedAgentScriptItem:b})?A.createElement(VM,{open:k,onOpenChange:D},A.createElement(WM,{asChild:!0},A.createElement(Tz,{\"aria-label\":\"Select Agent\"},A.createElement(\"span\",{className:\"select-none\",\"data-testid\":\"agent-selector-label\"},b?.name??\np),A.createElement(Z,{name:\"keyboard_arrow_down\",size:14}))),A.createElement(XM,{align:\"end\",className:\"border-border w-max min-w-[200px] max-w-[280px] max-h-80 overflow-y-auto overscroll-contain\"},A.createElement(cN,null,A.createElement(dN,{className:\"flex items-center gap-1\"},A.createElement(\"span\",null,\"Agents\"),t&&A.createElement(A.Fragment,null,A.createElement(Mz,{id:\"custom-agents-docs-tooltip\",place:\"top\"},\"Click to Open Docs\"),A.createElement(\"a\",{href:t,target:\"_blank\",rel:\"noopener noreferrer\",\n\"data-tooltip-id\":\"custom-agents-docs-tooltip\",\"aria-label\":\"Click to open docs\",className:\"text-muted-foreground hover:text-foreground inline-flex items-center p-0.5 rounded hover:bg-secondary transition-colors\",onClick:E=>E.stopPropagation()},A.createElement(Z,{name:\"info\",size:13})))),A.createElement(U4,{icon:ddc,label:p,onSelect:()=>{c(void 0)}}),C.map(E=>{var G=E.agent;if(!G)return null;var F=!u?.(G.name);return A.createElement(U4,{key:`${E.path}/${G.name}`,icon:ddc,label:G.name,onSelect:()=>\n{c(G,E.path)},kebab:F?A.createElement(kdc,{showConfigure:x,onConfigure:()=>{m({initialCustomization:E});l(!1)},onRemove:()=>{B(E)}}):void 0})}),g?A.createElement(U4,{icon:edc,iconClassNames:\"animate-spin\",label:\"Getting scripts...\",disabled:!0}):h?A.createElement(U4,{icon:fdc,iconClassNames:\"text-red-500\",label:`Error: ${h.message}`,disabled:!0}):v&&!w&&A.createElement(U4,{icon:gdc,label:\"New Agent Script\",onSelect:()=>{m({})}})))):null};");
  f.evaluate("const QZb=({item:a,onOpenAgentConfig:b,\nonToggleAgent:c,onDeleteAgent:e,onCopyPath:f,isLast:g,showBadge:h=!0})=>{var k=a.agentCustomization,l=a.path.includes(\"/builtin/\");return A.createElement(B3,{name:a.name,path:a.path,onCopyPath:f,description:a.description,badge:A.createElement(\"div\",{className:\"flex gap-1 items-center\"},(h||a.isGlobal)&&A.createElement(NZb,{isGlobal:a.isGlobal,workspaceName:a.workspaceName}),a.pluginName&&A.createElement(MZb,{pluginName:a.pluginName})),disabled:a.disabled,isLast:g,onEdit:b&&k?()=>b(k):void 0,editTitle:\"Edit config\",\nonDelete:!l&&e&&k?()=>{e(k)}:void 0,deleteTitle:\"Delete agent\",onToggle:c&&k?m=>c(k,m):void 0,toggleChecked:!a.disabled})};");
  f.evaluate("var q_b=({agents:a,onOpenConfig:b,onRemove:c,onToggle:e,noBorder:f})=>{if(a.length===0)return null;var g=a.map((h,k)=>{var l=h.agent;if(!l)return null;var m=!l.disabled;k=k===a.length-1;return A.createElement(B3,{key:l.name,name:l.name,description:l.description,badge:A.createElement(p_b,{type:l.source.case===\"commandSpec\"?\"command\":l.source.case===\"pythonSpec\"?\"python\":l.source.case===\"configPath\"?\"config\":l.source.case===\"config\"?\"subagent\":\"agent\"}),disabled:!m,isLast:k||f,onEdit:b?()=>b(h):void 0,\neditTitle:\"Edit config\",onDelete:c?()=>c(h):void 0,deleteTitle:\"Remove\",onToggle:e?n=>e(h,n):void 0,toggleChecked:m})});return f?A.createElement(A.Fragment,null,g):A.createElement(\"div\",{className:\"border border-border rounded divide-y divide-border\"},g)}");
  f.evaluate("function Hub(a,b){var c=SV(a.path),e=a.agent?.name||UV(a.path)||\"Agent\",f=!a.agent?.disabled;return{key:`agent-${c||e}`,name:e,description:a.agent?.description,path:c,content:vub(a),disabled:!f,actionsPaddingClass:a.isGlobal&&c?\"pr-24\":\"pr-14\",actions:A.createElement(A.Fragment,null,c&&A.createElement(PV,{path:c,label:\"Copy Path\",stopPropagation:!0,onCopy:b.onCopyPath}),a.isGlobal&&A.createElement(\"div\",{onClick:g=>{g.stopPropagation()}},A.createElement(CW,{checked:f,onCheckedChange:g=>{b.onToggle(a,\ng)},\"aria-label\":`Toggle ${e}`})))}}");
  f.evaluate("function qvb({agents:a,showPaths:b=!1,MarkdownRenderer:c}){return A.createElement(\"div\",null,a.map((e,f)=>{var g=SV(e.path),h=A.createElement,k=e.path||e.agent?.name||f;f=e.agent?.name||(e.path?rub(e.path):void 0)||`Unnamed Agent ${(f??0)+1}`;return h.call(A,EW,{key:k,title:f,displayPath:b?TV(e.path):void 0,copyPath:b?g:void 0,description:e.agent?.description?.trim(),content:vub(e),actions:b&&g?A.createElement(PV,{path:g,stopPropagation:!0}):void 0,MarkdownRenderer:c})}))}");
  f.evaluate("function cHb({conversationId:a,title:b,subtitle:c,canceled:e}){var f=KO(),{stepHandler:g,trajectorySummariesProvider:h}=sC(),k=(0,A.useMemo)(()=>({selector:x=>{x=a?x?.summaries[a]:void 0;return a&&x?MA(a,x):void 0}}),[a]),l=wl(h??Xh,k);k=!(!a||!aHb.has(a));e=e||k;k=l?.killed;var m=!e&&!k&&(!a||!!h&&!l||l?.status===V.CortexStepStatus.RUNNING),n=!!l?.needsAttention;l=l?.firstWaitingStep?.metadata?.toolCall?.name;var p=!!a,r=(0,A.useId)(),t=b||c||\"Subagent\",u=p?b&&c?`Open Subagent: ${b} (${c})`:`Open Subagent: ${t}`:\nvoid 0,v=(0,A.useCallback)(x=>{x?.stopPropagation();a&&(f(hg.VIEW_SUBAGENT_FROM_CHAT,\"agent_ref\"),g?.onViewSubagent?.({conversationId:a,subagentName:c||\"\",toolSummary:b||\"\"}))},[a,c,b,f,g]),w=(0,A.useCallback)(x=>{x.target!==x.currentTarget||x.key!==\"Enter\"&&x.key!==\" \"||(x.preventDefault(),x.stopPropagation(),v())},[v]);return A.createElement(A.Fragment,null,A.createElement(\"div\",{role:p?\"button\":void 0,tabIndex:p?0:void 0,\"aria-label\":p?u:void 0,\"data-tooltip-id\":u?r:void 0,className:`inline-flex items-center gap-1 max-w-full overflow-hidden rounded-sm ${p?\n\"group/agent-ref cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring\":\"\"}`,onClick:p?v:void 0,onKeyDown:p?w:void 0},A.createElement(KY,{isPendingUserInteraction:n,toolName:l,isLoading:m,isUnread:!1,idleFallback:k?A.createElement(Z,{name:\"block\",size:16,className:\"shrink-0 opacity-50\",\"data-testid\":\"agent-status-killed\"}):e?A.createElement(Z,{name:\"cancel\",size:16,className:\"shrink-0 opacity-50\",\"data-testid\":\"agent-status-canceled\"}):A.createElement(Z,{name:\"check_circle\",\nsize:16,className:\"shrink-0 opacity-50\",\"data-testid\":\"agent-status-done\"})}),A.createElement(\"span\",{className:\"truncate min-w-0 text-muted-foreground group-hover/agent-ref:text-foreground transition-colors\"},t)),u&&A.createElement(Mz,{id:r},u))};");
  f.evaluate("function Tic(a,b){return Ok(c=>{if(a)return c=ul(c,a)?.trajectoryMetadata?.subagentSpec,c?.role||c?.typeName||void 0})||b||\"Subagent\"}");
  f.evaluate("var agentTestRegistry={generic:{renderer:()=>A.createElement(\"div\",null)},systemMessage:{renderer:()=>A.createElement(A.Fragment,null)},invokeSubagent:{renderer:function({step:a,status:b}){var [c,e]=(0,A.useState)(!1),f=(0,A.useCallback)(()=>{e(m=>!m)},[]),g=CN(b),h=b===V.CortexStepStatus.CANCELED,k=a.results||[];a=(a.subagents||[]).map((m,n)=>A.createElement(cHb,{key:n,conversationId:k[n]?.conversationId,title:m.role,subtitle:m.typeName===\"self\"?void 0:m.typeName,canceled:h}));var l=a.length>1;return A.createElement(yY,{loading:g,status:b,title:A.createElement(\"div\",{className:\"flex items-center gap-1 overflow-hidden whitespace-nowrap text-muted-foreground\"},\nA.createElement(\"span\",null,g?\"Starting\":\"Started\"),a.length===1?a[0]:A.createElement(\"span\",null,a.length,\" subagents\")),supplementaryView:l?A.createElement(\"div\",{className:\"flex flex-col gap-0.5\"},a.map((m,n)=>A.createElement(\"div\",{key:n,className:\"flex items-center min-h-8 text-sm\"},m))):null,cta:null,isExpanded:l?c:void 0,onToggle:l?f:void 0,hasSupplementaryView:l})}}};function agentTestLookup(a){var b=a.step.case;return(b?agentTestRegistry[b]:void 0)?.isRendered(a,!1)??!1}");
  f.evaluate(`var agentTestCustomizationRows=[];var LZb=()=>({data:{skills:[],rules:[],agents:agentTestCustomizationRows},isLoading:false,refresh:()=>{}});
    var SZb=()=>null,PZb=()=>null,RZb=()=>null,I2=()=>null,NB=()=>null;var d=value=>value;`);
  f.evaluate("var TZb=({workspaceUris:a,onOpenFile:b,onOpenAgentConfig:c,onToggleAgent:e,onDeleteAgent:f,plugins:g,onRefreshPlugins:h,onOpenPluginConfig:k,onTogglePlugin:l,onDeletePlugin:m,scrollable:n=!0,showGlobalOnly:p=!1})=>{var {data:r,isLoading:t,error:u,refresh:v}=LZb(a),w=gj().get(\"copyFilePath\"),x=(0,A.useCallback)(K=>{w?.copy?.(void 0,K)},[w]),y=p?r.skills.filter(K=>K.isGlobal):r.skills,B=p?r.rules.filter(K=>K.isGlobal):r.rules,D=p?r.agents.filter(K=>K.isGlobal):r.agents,C=p?(g??[]).filter(K=>K.isGlobal):\ng??[];g=y.length+B.length+D.length+C.length;var E=a.length>1,G=(0,A.useCallback)(async(K,L)=>{var M=d,O=d;try{O(await M(e?.(K,L))),v()}finally{M()}},[e,v]),F=(0,A.useCallback)(async K=>{var L=d,M=d;try{M(await L(f?.(K))),v()}finally{L()}},[f,v]),H=(0,A.useCallback)(async(K,L)=>{var M=d,O=d;try{let N=O(await M(l?.(K,L)));O(await M(h?.()));return N??null}finally{M()}},[l,h]),J=(0,A.useCallback)(async K=>{var L=d,M=d;try{let O=M(await L(m?.(K)));M(await L(h?.()));return O??null}finally{L()}},[m,h]);\nreturn t?A.createElement(\"div\",{className:\"flex items-center gap-2 py-4 text-sm opacity-60\"},A.createElement(NB,{className:\"w-4 h-4\"}),\"Loading workspace customizations...\"):u?A.createElement(\"div\",{className:\"flex items-center gap-2 text-sm text-red-400 py-2\"},A.createElement(Z,{name:\"error\",className:\"w-4 h-4 shrink-0\"}),u):g===0?null:A.createElement(\"div\",{\"data-testid\":\"workspace-customizations-view\",className:`flex flex-col gap-6 ${n?\"overflow-y-auto max-h-[400px]\":\"\"}`},y.length>0&&A.createElement(I2,\n{title:\"Skills\",count:y.length,collapsible:!0},A.createElement(SZb,{items:y,renderItem:(K,L)=>A.createElement(PZb,{key:K.path,item:K,onOpenFile:b,onCopyPath:x,isLast:L,showBadge:E})})),B.length>0&&A.createElement(I2,{title:\"Rules\",count:B.length,collapsible:!0},A.createElement(SZb,{items:B,renderItem:(K,L)=>A.createElement(PZb,{key:K.path,item:K,onOpenFile:b,onCopyPath:x,isLast:L,showBadge:E})})),C.length>0&&A.createElement(I2,{title:\"Plugins\",count:C.length,collapsible:!0},A.createElement(\"div\",\n{className:\"border border-border rounded-xl overflow-hidden\"},C.map((K,L)=>A.createElement(RZb,{key:K.name,plugin:K,onOpenPluginConfig:k,onTogglePlugin:H,onDeletePlugin:J,onCopyPath:x,isLast:L===C.length-1})))),D.length>0&&A.createElement(I2,{title:\"Custom Agents\",count:D.length,collapsible:!0},A.createElement(SZb,{items:D,renderItem:(K,L)=>A.createElement(QZb,{key:K.path,item:K,onOpenAgentConfig:c,onToggleAgent:G,onDeleteAgent:F,onCopyPath:x,isLast:L,showBadge:E})})))};");
  return f;
}

test('all built-in agent badges and selector labels localize display only, retaining validation and selection',()=>{
  const {strings,rows}=builtinAgentTestCatalog(),f=builtinAgentOwnerFixture(strings);
  const originalBadge=f.window.rbc,originalSelector=f.window.ldc,adapters=f.install();
  for(const row of rows){
    const record=builtinAgentTestRecord(row),script=record.agent;
    const badgeProps=Object.freeze({conversationAgentScript:script,isSubagent:true});
    const badge=f.window.rbc(badgeProps);
    assert.equal(badge.props.children[1].props.children,row.name);
    assert.equal(badge.props.title,row.description);
    assert.equal(badge.props.children[0].props.name,'robot_2');
    assert.equal(badgeProps.conversationAgentScript,script);
    assert.equal(script.name,row.type);assert.equal(script.description,row.english);
    const props=Object.freeze({agentScriptsEnabled:true,selectedAgentScriptItem:script,
      agentCustomizations:Object.freeze([record]),setSelectedAgentScriptItem:f.window.agentSelect,
      refreshAgentScripts:()=>{},isLoadingAgentScripts:false});
    f.window.agentTestEffects.length=0;f.window.agentTestSelections.length=0;
    const before=f.window.agentTestHooks,selector=f.window.ldc(props);
    assert.ok(f.window.agentTestHooks>before,'the native selector still owns its original Hooks');
    assert.equal(f.window.agentTestEffects.length,2,'the original subscription and selection-validation effects remain');
    f.window.agentTestEffects[1]();
    assert.equal(f.window.agentTestSelections.length,0,'raw name matching must keep a valid selected built-in');
    assert.equal(builtinAgentTestElements(selector,node=>node.props['data-testid']==='agent-selector-label')[0].props.children,row.name);
    const option=builtinAgentTestElements(selector,node=>node.key===`${record.path}/${script.name}`)[0];
    assert.equal(option.props.label,row.name);assert.equal(option.key,`${record.path}/${row.type}`);
    option.props.onSelect();
    assert.equal(f.window.agentTestSelections.at(-1)[0],script);
    assert.equal(f.window.agentTestSelections.at(-1)[1],record.path);
    const main=builtinAgentTestElements(selector,node=>node.props.label==='Main Agent')[0];
    main.props.onSelect();assert.equal(f.window.agentTestSelections.at(-1)[0],undefined);
    // A missing original selection still triggers the native validation effect.
    f.window.agentTestEffects.length=0;f.window.agentTestSelections.length=0;
    f.window.ldc({...props,agentCustomizations:[]});f.window.agentTestEffects[1]();
    assert.equal(f.window.agentTestSelections.length,1);assert.equal(f.window.agentTestSelections[0][0],undefined);
  }
  const self=rows.find(row=>row.type==='self');
  for(const sourceCase of ['commandSpec','pythonSpec']){
    const inherited=builtinAgentTestScript(self,{source:Object.freeze({case:sourceCase,value:Object.freeze({opaque:'original script'})})});
    const badge=f.window.rbc({conversationAgentScript:inherited,isSubagent:true});
    assert.equal(badge.props.children[1].props.children,self.name);
    assert.equal(inherited.source.case,sourceCase);
  }
  const row=rows[0],script=builtinAgentTestScript(row);
  for(const custom of [
    builtinAgentTestScript(row,{description:'User-provided description with the same type name'}),
    builtinAgentTestScript(row,{pluginName:'third-party-plugin'}),
    builtinAgentTestScript(row,{source:Object.freeze({case:'file',value:'file:///custom/agent.md'})}),
    builtinAgentTestScript(row,{source:undefined})
  ]){
    const badge=f.window.rbc({conversationAgentScript:custom,isSubagent:true});
    assert.equal(badge.props.children[1].props.children,row.type,'same-name custom/plugin/file/unsourced metadata stays raw');
    assert.equal(badge.props.title,'Subagent');
  }
  const customPath=builtinAgentTestRecord(row,script,`file:///Users/test/.agents/agents/${row.type}`);
  const customSelector=f.window.ldc({agentScriptsEnabled:true,selectedAgentScriptItem:script,agentCustomizations:[customPath],
    setSelectedAgentScriptItem:f.window.agentSelect,refreshAgentScripts:()=>{}});
  assert.equal(builtinAgentTestElements(customSelector,node=>node.props['data-testid']==='agent-selector-label')[0].props.children,row.type);
  const refreshed={...strings,[`builtin-agent:${row.type}:name`]:'updated native display', [row.key]:'updated native description'};
  adapters.setStrings(refreshed);
  assert.equal(f.window.rbc({conversationAgentScript:script,isSubagent:true}).props.children[1].props.children,'updated native display');
  f.uninstall()();assert.equal(f.window.rbc,originalBadge);assert.equal(f.window.ldc,originalSelector);
  assert.equal(f.window.rbc({conversationAgentScript:script,isSubagent:true}).props.children[1].props.children,row.type);
});

test('built-in agent cards translate only returned display fields and keep indexed callbacks and source data',()=>{
  const {strings,rows}=builtinAgentTestCatalog(),f=builtinAgentOwnerFixture(strings);
  const originals=Object.fromEntries(['TZb','q_b','Hub','qvb'].map(key=>[key,f.window[key]]));
  const calls=[],open=value=>calls.push(['open',value]),remove=value=>calls.push(['remove',value]),
    toggle=(value,enabled)=>calls.push(['toggle',value,enabled]),copy=path=>calls.push(['copy',path]);
  f.install();
  for(const row of rows){
    const record=builtinAgentTestRecord(row),script=record.agent;
    const view=Object.freeze({name:script.name,description:script.description,path:record.path,
      agentCustomization:record,isGlobal:true,disabled:false});
    assert.equal(f.window.QZb,undefined,'the native row renderer is a lexical const, so the writable list owner adapts its display projection');
    f.window.agentTestCustomizationRows=[view];
    const list=f.window.TZb({workspaceUris:[],onOpenAgentConfig:open,onToggleAgent:toggle,onDeleteAgent:remove});
    const listBody=builtinAgentTestElements(list,node=>Array.isArray(node.props.items)&&typeof node.props.renderItem==='function')[0];
    assert.notEqual(listBody.props.items[0],view);
    assert.equal(listBody.props.items[0].agentCustomization,record);
    assert.equal(listBody.props.items[0].path,view.path);
    const detailElement=listBody.props.renderItem(listBody.props.items[0],true);
    const detail=detailElement.type(detailElement.props);
    assert.equal(detail.props.name,row.name);assert.equal(detail.props.description,row.description);
    assert.equal(detail.props.path,record.path);
    detail.props.onEdit();assert.equal(calls.at(-1)[1],record);
    detail.props.onToggle(false);assert.equal(calls.at(-1)[1],record);assert.equal(calls.at(-1)[2],false);
    assert.equal(detail.props.onDelete,undefined,'native built-in deletion remains unavailable');
    const user=builtinAgentTestRecord(row,builtinAgentTestScript(row,{description:'Own description'}),`file:///custom/${row.type}`);
    const agents=Object.freeze([record,Object.freeze({path:'file:///empty',isGlobal:true}),user]);
    const settings=f.window.q_b({agents,onOpenConfig:open,onRemove:remove,onToggle:toggle,noBorder:false}).props.children;
    assert.equal(settings[0].props.name,row.name);assert.equal(settings[0].props.description,row.description);
    assert.equal(settings[1],null,'an absent agent keeps its original map slot');
    assert.equal(settings[2].props.name,row.type);assert.equal(settings[2].props.description,'Own description');
    assert.equal(settings[0].key,row.type);assert.equal(settings[0].props.badge.props.type,'subagent');
    settings[0].props.onEdit();assert.equal(calls.at(-1)[1],record);
    settings[0].props.onDelete();assert.equal(calls.at(-1)[1],record);
    settings[0].props.onToggle(false);assert.equal(calls.at(-1)[1],record);assert.equal(calls.at(-1)[2],false);
    const hub=f.window.Hub(record,{onToggle:toggle,onCopyPath:copy});
    assert.equal(hub.name,row.name);assert.equal(hub.description,row.description);
    assert.equal(hub.key,`agent-${record.path}`);assert.equal(hub.path,record.path);assert.equal(hub.content,record.content);
    const nativeToggle=builtinAgentTestElements(hub.actions,node=>node.props.checked===true&&typeof node.props.onCheckedChange==='function')[0];
    nativeToggle.props.onCheckedChange(false);assert.equal(calls.at(-1)[1],record);
    const markdown=()=>null;
    const cards=f.window.qvb({agents:[record,user],showPaths:true,MarkdownRenderer:markdown}).props.children;
    assert.equal(cards[0].props.title,row.name);assert.equal(cards[0].props.description,row.description.trim());
    assert.equal(cards[0].key,record.path);assert.equal(cards[0].props.displayPath,record.path);assert.equal(cards[0].props.copyPath,record.path);
    assert.equal(cards[0].props.content,record.content);assert.equal(cards[0].props.MarkdownRenderer,markdown);
    assert.equal(cards[1].props.title,row.type);assert.equal(cards[1].props.description,'Own description');
    for(const custom of [user,builtinAgentTestRecord(row,script,`file:///custom/same-description/${row.type}`),
      builtinAgentTestRecord(row,builtinAgentTestScript(row,{pluginName:'third-party-plugin'}))]){
      const raw=f.window.Hub(custom,{onToggle:toggle,onCopyPath:copy});
      assert.equal(raw.name,row.type);assert.equal(raw.description,custom.agent.description);
      const card=f.window.qvb({agents:[custom],showPaths:false}).props.children[0];
      assert.equal(card.props.title,row.type);assert.equal(card.props.description,custom.agent.description.trim());
    }
    assert.equal(view.name,row.type);assert.equal(view.description,row.english);
    assert.equal(record.agent,script);assert.equal(script.source.case,'config');assert.equal(record.content.raw,'prompt bytes are not display copy');
  }
  f.uninstall()();for(const [key,original] of Object.entries(originals))assert.equal(f.window[key],original);
});

test('explicit invokeSubagent types change display hints without changing roles, subtitles or navigation',()=>{
  const {strings,rows}=builtinAgentTestCatalog(),f=builtinAgentOwnerFixture(strings);
  const originals={renderer:f.window.agentTestRegistry.invokeSubagent.renderer,reference:f.window.cHb,Tic:f.window.Tic};
  const adapters=f.install(),row=rows.find(row=>row.type==='research');
  const subagents=Object.freeze([
    Object.freeze({typeName:row.type,role:''}),Object.freeze({typeName:row.type,role:row.type}),
    Object.freeze({typeName:'self',role:''}),Object.freeze({typeName:'my-user-agent',role:'role bytes'})
  ]),results=Object.freeze(subagents.map((_,index)=>Object.freeze({conversationId:`convo-${index}`}))),
    step=Object.freeze({subagents,results}),props=Object.freeze({step,status:2});
  const render=f.window.agentTestRegistry.invokeSubagent.renderer(props);
  const refs=render.props.supplementaryView.props.children.map(node=>node.props.children);
  for(let index=0;index<refs.length;index++){
    assert.equal(refs[index].key,index);assert.equal(refs[index].props.conversationId,results[index].conversationId);
    assert.equal(refs[index].props.title,subagents[index].role);
    assert.equal(refs[index].props.subtitle,index===2?undefined:subagents[index].typeName);
    assert.equal(refs[index].props.canceled,false);
  }
  assert.equal(refs[0].props.__chBuiltinAgentTypeName,row.type);
  assert.equal(refs[1].props.__chBuiltinAgentTypeName,row.type);
  assert.equal(refs[2].props.__chBuiltinAgentTypeName,undefined,'self keeps its native hidden subtitle');
  assert.equal(refs[3].props.__chBuiltinAgentTypeName,undefined);
  const plain=f.window.cHb(refs[0].props),plainButton=plain.props.children[0];
  assert.equal(plainButton.props.children[1].props.children,row.name);
  assert.equal(plainButton.props['aria-label'],`Open Subagent: ${row.type}`,'native operation labels stay canonical');
  assert.equal(plain.props.children[1].props.children,`打开子智能体：${row.name}`);
  plainButton.props.onClick({stopPropagation(){}});
  assert.equal(f.window.agentTestViews.at(-1).conversationId,'convo-0');
  assert.equal(f.window.agentTestViews.at(-1).subagentName,row.type);
  assert.equal(f.window.agentTestViews.at(-1).toolSummary,'');
  const role=f.window.cHb(refs[1].props),roleButton=role.props.children[0];
  assert.equal(roleButton.props.children[1].props.children,row.type,'an explicit role matching a built-in name stays raw');
  assert.equal(roleButton.props['aria-label'],`Open Subagent: ${row.type} (${row.type})`,'native operation labels stay canonical');
  assert.equal(role.props.children[1].props.children,`打开子智能体：${row.type}（${row.name}）`);
  roleButton.props.onClick({stopPropagation(){}});
  assert.equal(f.window.agentTestViews.at(-1).subagentName,row.type);
  assert.equal(f.window.agentTestViews.at(-1).toolSummary,row.type);
  const unscoped=f.window.cHb({conversationId:'custom',title:'',subtitle:row.type});
  assert.equal(unscoped.props.children[0].props.children[1].props.children,row.type,'the reusable reference never infers a built-in type from subtitle alone');
  const changed={...strings,[`builtin-agent:${row.type}:name`]:'refreshed type label'};adapters.setStrings(changed);
  assert.equal(f.window.cHb(refs[0].props).props.children[0].props.children[1].props.children,'refreshed type label',
    'the display hint keeps the type key so cached reference props follow dictionary refresh');
  assert.equal(step.subagents,subagents);assert.equal(step.results,results);
  f.uninstall()();assert.equal(f.window.agentTestRegistry.invokeSubagent.renderer,originals.renderer);assert.equal(f.window.cHb,originals.reference);
});

test('subagent tab metadata localizes only the explicit typeName fallback and preserves same-name roles and title fallbacks',()=>{
  const {strings,rows}=builtinAgentTestCatalog(),f=builtinAgentOwnerFixture(strings),original=f.window.Tic;
  const adapters=f.install();
  for(const row of rows){
    f.window.agentTestSpec=Object.freeze({role:'',typeName:row.type});
    assert.equal(f.window.Tic('conversation','fallback'),row.name);
    const before=f.window.agentTestSelectorCalls;
    f.window.agentTestSpec=Object.freeze({role:row.type,typeName:row.type});
    assert.equal(f.window.Tic('conversation','fallback'),row.type,'a role is business content even when it equals an internal type');
    assert.equal(f.window.agentTestSelectorCalls,before+1,'native metadata selector runs once');
    f.window.agentTestSpec=Object.freeze({role:'',typeName:'user-defined'});
    assert.equal(f.window.Tic('conversation',row.type),'user-defined');
    f.window.agentTestSpec=undefined;
    assert.equal(f.window.Tic('conversation',row.type),row.type,'the supplied tab title fallback is not a type source');
    assert.equal(f.window.Tic(undefined,row.type),row.type);
  }
  const row=rows[0];f.window.agentTestSpec={role:'',typeName:row.type};
  adapters.setStrings({...strings,[`builtin-agent:${row.type}:name`]:'updated tab type'});
  assert.equal(f.window.Tic('conversation'),'updated tab type');
  f.uninstall()();assert.equal(f.window.Tic,original);assert.equal(f.window.Tic('conversation'),row.type);
});

test('accumulated fallback localizes before composition while supplied labels titles keys and content stay native', () => {
  const f = nativeFixture({strings:{'Accumulated State':'累计状态'}});
  f.evaluate('function u1b(a,b,c){var e=b.renderInfo,f=e?.icon||a.icon||"progress_activity",g=e?.content,h=g?.case==="fileUri"?g.value:void 0;g=(g?.case==="markdown"?g.value:void 0)||h||"";var k=a.title||a.key||"Accumulated State";return{iconName:f,isSpinning:f==="progress_activity"||f==="sync",fileUri:h,label:e?.label||(g?`${k}: ${g}`:k),itemKey:b.id||`${a.key}-${c}`}}');
  const original = f.window.u1b, installed = f.install();
  assert.ok(installed.hooks.some(hook => hook.kind === 'native-accumulated-fallback'));
  const content = 'Conversation Log  /tmp/a  b.md\nTask Log';
  const item = Object.freeze({id:'item-id',renderInfo:Object.freeze({content:Object.freeze({case:'markdown',value:content})})});
  assert.equal(f.window.u1b({},item,0).label, `累计状态: ${content}`);
  assert.equal(f.window.u1b({}, {renderInfo:{}},0).label, '累计状态');
  assert.equal(f.window.u1b({title:'Accumulated State'},item,0).label, `Accumulated State: ${content}`);
  assert.equal(f.window.u1b({key:'Accumulated State'},item,0).label, `Accumulated State: ${content}`);
  assert.equal(f.window.u1b({}, {renderInfo:{label:'Accumulated State',content:{case:'markdown',value:content}}},0).label, 'Accumulated State');
  const row = f.window.u1b({key:'section'},item,0);
  assert.equal(row.itemKey,'item-id');
  assert.equal(item.renderInfo.content.value,content);
  installed.setStrings({'Accumulated State':'累积状态'});
  assert.equal(f.window.u1b({},item,0).label,`累积状态: ${content}`);
  f.uninstall()();
  assert.equal(f.window.u1b,original);
});

test('lexical subagent rows localize counts through writable q1b and q5 owners and keep supplied names callbacks keys and refs', () => {
  const f = nativeFixture();
  f.window.eval = source => f.evaluate(source);
  f.evaluate(`
    var rowHookCalls=0,sectionHookCalls=0;
    A.useState=value=>{rowHookCalls++;return [value,()=>{}]};
    function q1b({testId:a,label:e,labelClassName:f,detail:h,detailClassName:k,trailing:l}){return A.createElement(A.Fragment,null,A.createElement("span",{className:f},e),h&&A.createElement("span",{"data-testid":a?\`\${a}-detail\`:void 0,className:k},h),l)}
    var O3=props=>A.createElement(q1b,props);
    const r3b=({count:a,label:b,onExpand:c})=>A.createElement(O3,{testId:"subagent-node",label:b,detail:A.createElement(A.Fragment,null,"(",a," subagent",a===1?"":"s",")"," ",A.createElement("span",{"data-testid":"subagent-expand",onClick:c}))});
    const Chc=({conversationId:a,count:b,label:c,onExpand:e,child:f})=>{A.useState(false);return A.createElement("div",null,A.createElement("span",null,c),A.createElement("span",null,"(",b," subagent",b===1?"":"s",")"),A.createElement("button",{"data-testid":"subagent-expand",onClick:e}),f&&A.createElement(Chc,{key:f,conversationId:f,count:1,label:c,onExpand:e}))};
    var q5=({children:a})=>{sectionHookCalls++;return A.createElement("div",null,a(5))};
    var Dhc=({count:a,label:b,onExpand:c,rowRef:e,child:f})=>{var p=['agent-id'];return A.createElement(q5,{title:"Subagents",actions:[{tooltip:"Stop All Subagents"}]},u=>A.createElement("div",null,p.length===0?"No subagents":p.map(v=>A.createElement(Chc,{key:v,conversationId:v,depth:0,activeConversationId:"",count:a,label:b,onExpand:c,ref:e,child:f}))))};
  `);
  const originalQ1b=f.window.q1b,originalQ5=f.window.q5;
  const lexicalRow=f.evaluate('Chc'), lexicalDetail=f.evaluate('r3b');
  assert.equal(f.window.Chc,undefined);
  assert.equal(f.window.r3b,undefined);
  const installed=f.install();
  assert.ok(installed.uiKeys.includes('q1b'));
  assert.ok(installed.hooks.some(hook=>hook.kind==='native-subagent-sidebar-count'));
  const callback=()=>{}, rowRef={current:null}, label='Accumulated State';
  for(const count of [1,3]) {
    const rowElement=lexicalDetail({count,label,onExpand:callback});
    const ownerElement=f.window.O3(rowElement.props);
    const detail=f.window.q1b(ownerElement.props).props.children;
    assert.equal(detail[0].props.children,label);
    assert.equal(detail[1].props.children.props.children.slice(0,3).join(''),`（${count} 个子智能体）`);
    assert.equal(detail[1].props.children.props.children[4].props.onClick,callback);
  }
  const unrelated=f.window.q1b({testId:'other-node',detail:f.window.A.createElement(f.window.A.Fragment,null,'(',2,' subagent','s',')')});
  assert.equal(unrelated.props.children[1].props.children.props.children.join(''),'(2 subagents)');
  const suppliedLabel=f.window.A.createElement(f.window.A.Fragment,null,'(',2,' subagent','s',')');
  const supplied=f.window.q1b({testId:'subagent-node',label:suppliedLabel,detail:suppliedLabel});
  assert.equal(supplied.props.children[0].props.children,suppliedLabel,'only the owned detail changes');
  const sectionElement=f.window.Dhc({count:3,label,onExpand:callback,rowRef,child:'nested-id'});
  const section=f.window.q5(sectionElement.props);
  const row=section.props.children.props.children[0];
  assert.notEqual(row.type,lexicalRow);
  assert.equal(row.key,'agent-id');
  assert.equal(row.props.ref,rowRef);
  assert.equal(row.props.onExpand,callback);
  const rendered=row.type(row.props);
  assert.equal(rendered.props.children[0].props.children,label);
  assert.equal(rendered.props.children[1].props.children.join(''),'（3 个子智能体）');
  assert.equal(rendered.props.children[2].props.onClick,callback);
  const nested=rendered.props.children[3];
  assert.equal(nested.type,row.type,'expanded descendants use the same stable display wrapper');
  assert.equal(nested.key,'nested-id');
  assert.equal(nested.type(nested.props).props.children[1].props.children.join(''),'（1 个子智能体）');
  assert.equal(f.window.rowHookCalls,2,'each rendered native const row runs its Hooks once');
  assert.equal(f.window.sectionHookCalls,1,'the native section executes its children callback once');
  assert.equal(f.window.q5(sectionElement.props).props.children.props.children[0].type,row.type);
  f.uninstall()();
  assert.equal(f.window.q1b,originalQ1b);
  assert.equal(f.window.q5,originalQ5);
  const stopped=row.type(row.props);
  assert.equal(stopped.props.children[1].props.children.join(''),'(3 subagents)');
  assert.equal(stopped.props.children[3].type,lexicalRow,'an already mounted display wrapper becomes native after uninstall');
});

test('canonical skills section titles share the overview sidebar and item label while supplied names and content stay native', () => {
  const strings={'conversation-section:skill_used':'已使用的技能'};
  const f=nativeFixture({strings});
  f.evaluate(`
    function u1b(a,b,c){var e=b.renderInfo,g=e?.content,h=g?.case==="fileUri"?g.value:void 0;g=(g?.case==="markdown"?g.value:void 0)||h||"";var k=a.title||a.key||"Accumulated State";return{label:e?.label||(g?\`\${k}: \${g}\`:k),itemKey:b.id||\`\${a.key}-\${c}\`}}
    var Header=()=>null,Items=()=>null,Panel=()=>null;
    function z1b({section:a}){var maxVisibleItems=a.maxVisibleItems||4,f=a.title||a.key||"Accumulated State";return A.createElement('div',{'data-testid':\`overview-accumulated-section-\${a.key}\`},A.createElement(Header,{label:f}),A.createElement(Items,{section:a}))}
    function xhc({sections:a}){return A.createElement(A.Fragment,null,a.filter(n=>n.key!=="background_tasks").map(n=>A.createElement(Panel,{key:n.key,title:n.title||n.key,defaultVisibleCount:n.maxVisibleItems,onToggle:()=>\`aux_sidebar_\${n.key}_toggle\`},A.createElement(Items,{section:n}))))}
  `);
  const originalOverview=f.window.z1b,originalSidebar=f.window.xhc;
  const installed=f.install();
  assert.ok(installed.uiKeys.includes('z1b'));
  assert.ok(installed.uiKeys.includes('xhc'));
  const section=Object.freeze({key:'skill_used',title:'Skills Used',items:[]});
  const item=Object.freeze({renderInfo:Object.freeze({content:{case:'markdown',value:'Skills Used /path  with spaces'}})});
  const overview=f.window.z1b({section}).props.children;
  assert.equal(overview[0].props.label,'已使用的技能');
  assert.equal(overview[1].props.section,section);
  const sidebar=f.window.xhc({sections:[section]}).props.children[0];
  assert.equal(sidebar.props.title,'已使用的技能');
  assert.equal(sidebar.key,'skill_used');
  assert.equal(sidebar.props.children.props.section,section);
  assert.equal(f.window.u1b(section,item,0).label,'已使用的技能: Skills Used /path  with spaces');
  assert.equal(f.window.u1b(section,{renderInfo:{label:'Skills Used'}},0).label,'Skills Used');
  for(const custom of [{...section,key:'custom'},{...section,title:'My Skills'}]) {
    assert.equal(f.window.z1b({section:custom}).props.children[0].props.label,custom.title);
    assert.equal(f.window.xhc({sections:[custom]}).props.children[0].props.title,custom.title);
    assert.equal(f.window.u1b(custom,item,0).label,custom.title+': '+item.renderInfo.content.value);
  }
  assert.equal(section.title,'Skills Used');
  installed.setStrings({'conversation-section:skill_used':'所用技能'});
  assert.equal(f.window.z1b({section}).props.children[0].props.label,'所用技能');
  f.uninstall()();
  assert.equal(f.window.z1b,originalOverview);
  assert.equal(f.window.xhc,originalSidebar);
});

test('the current workspace list localizes built-in rows before its const renderer and preserves native callbacks',async()=>{
  const {strings,rows}=builtinAgentTestCatalog(),row=rows.find(item=>item.type==='self');
  const builtin=builtinAgentTestRecord(row),custom=builtinAgentTestRecord(row,undefined,'file:///user/agents/self');
  const builtinRow=Object.freeze({name:builtin.agent.name,description:builtin.agent.description,path:builtin.path,isGlobal:true,disabled:false,agentCustomization:builtin});
  const customRow=Object.freeze({name:custom.agent.name,description:custom.agent.description,path:custom.path,isGlobal:true,disabled:false,agentCustomization:custom});
  const f=nativeFixture({strings});
  f.evaluate(`
    A.useCallback=fn=>fn;
    var e=value=>value,agentRows,refreshCount=0;
    var Tgb=()=>({data:agentRows,isLoading:false,error:null,refresh:()=>{refreshCount++}});
    var ij=()=>({get:()=>undefined});
    var ZB=()=>null,wP=()=>null,$gb=()=>null,Xgb=()=>null,Zgb=()=>null,vR=()=>null,Vgb=()=>null,Ugb=()=>null;
  `);
  f.window.agentRows=Object.freeze({skills:[],rules:[],agents:Object.freeze([builtinRow,customRow])});
  f.evaluate("const Ygb=({item:a,onToggleAgent:b,onDeleteAgent:c,onCopyPath:d,isLast:f,showBadge:g=!0})=>{var h=a.agentCustomization,k=a.path.includes(\"/builtin/\");\nreturn A.createElement(vR,{name:a.name,path:a.path,onCopyPath:d,description:a.description,badge:A.createElement(\"div\",{className:\"flex gap-1 items-center\"},(g||a.isGlobal)&&A.createElement(Vgb,{isGlobal:a.isGlobal,workspaceName:a.workspaceName}),a.pluginName&&A.createElement(Ugb,{pluginName:a.pluginName})),disabled:a.disabled,isLast:f,onDelete:!k&&c&&h?()=>{c(h)}:void 0,deleteTitle:\"Delete agent\",onToggle:b&&h?l=>b(h,l):void 0,toggleChecked:!a.disabled})};");
  f.evaluate('var ahb='+"({workspaceUris:a,onToggleAgent:b,onDeleteAgent:c,plugins:d,onRefreshPlugins:f,onTogglePlugin:g,onDeletePlugin:h,scrollable:k=!0,showGlobalOnly:l=!1})=>{var {data:m,isLoading:n,error:q,refresh:r}=Tgb(a),t=ij().get(\"copyFilePath\"),u=(0,A.useCallback)(F=>{t?.copy?.(void 0,F)},[t]),v=l?m.skills.filter(F=>F.isGlobal):m.skills,w=l?m.rules.filter(F=>F.isGlobal):m.rules,x=l?m.agents.filter(F=>F.isGlobal):m.agents,y=l?(d??[]).filter(F=>F.isGlobal):d??[];d=v.length+w.length+x.length+y.length;var B=\na.length>1,C=(0,A.useCallback)(async(F,H)=>{var J=e,K=e;try{K(await J(b?.(F,H))),r()}finally{J()}},[b,r]),D=(0,A.useCallback)(async F=>{var H=e,J=e;try{J(await H(c?.(F))),r()}finally{H()}},[c,r]),E=(0,A.useCallback)(async(F,H)=>{var J=e,K=e;try{let L=K(await J(g?.(F,H)));K(await J(f?.()));return L??null}finally{J()}},[g,f]),G=(0,A.useCallback)(async F=>{var H=e,J=e;try{let K=J(await H(h?.(F)));J(await H(f?.()));return K??null}finally{H()}},[h,f]);return n?A.createElement(\"div\",{className:\"flex items-center gap-2 py-4 text-sm opacity-60\"},\nA.createElement(ZB,{className:\"w-4 h-4\"}),\"Loading workspace customizations...\"):q?A.createElement(\"div\",{className:\"flex items-center gap-2 text-sm text-red-400 py-2\"},A.createElement(Z,{name:\"error\",className:\"w-4 h-4 shrink-0\"}),q):d===0?null:A.createElement(\"div\",{\"data-testid\":\"workspace-customizations-view\",className:`flex flex-col gap-6 ${k?\"overflow-y-auto max-h-[400px]\":\"\"}`},v.length>0&&A.createElement(wP,{title:\"Skills\",count:v.length,collapsible:!0},A.createElement($gb,{items:v,renderItem:(F,\nH)=>A.createElement(Xgb,{key:F.path,item:F,onCopyPath:u,isLast:H,showBadge:B})})),w.length>0&&A.createElement(wP,{title:\"Rules\",count:w.length,collapsible:!0},A.createElement($gb,{items:w,renderItem:(F,H)=>A.createElement(Xgb,{key:F.path,item:F,onCopyPath:u,isLast:H,showBadge:B})})),y.length>0&&A.createElement(wP,{title:\"Plugins\",count:y.length,collapsible:!0},A.createElement(\"div\",{className:\"border border-border rounded-xl overflow-hidden\"},y.map((F,H)=>A.createElement(Zgb,{key:F.name,plugin:F,\nonTogglePlugin:E,onDeletePlugin:G,onCopyPath:u,isLast:H===y.length-1})))),x.length>0&&A.createElement(wP,{title:\"Custom Agents\",count:x.length,collapsible:!0},A.createElement($gb,{items:x,renderItem:(F,H)=>A.createElement(Ygb,{key:F.path,item:F,onToggleAgent:C,onDeleteAgent:D,onCopyPath:u,isLast:H,showBadge:B})})))}"+';');
  const original=f.window.ahb,toggles=[],deletions=[];
  const props=Object.freeze({workspaceUris:['file:///workspace'],onToggleAgent:(agent,enabled)=>{toggles.push({agent,enabled});},onDeleteAgent:agent=>{deletions.push(agent);}});
  const adapters=f.install();
  assert.ok(adapters.uiKeys.includes('ahb'));
  assert.equal(Object.hasOwn(f.window,'Ygb'),false,'the native row remains a lexical const, not an invented writable binding');
  const value=f.window.ahb(props);
  const list=builtinAgentTestElements(value,node=>Array.isArray(node.props.items)&&typeof node.props.renderItem==='function')[0];
  assert.ok(list,'the real current owner returns its native items/renderItem list');
  assert.equal(list.props.items[0].name,row.name);assert.equal(list.props.items[0].description,row.description);
  assert.equal(list.props.items[0].agentCustomization,builtin);assert.equal(list.props.items[0].path,builtin.path);
  assert.equal(list.props.items[1],customRow,'same-name custom path remains entirely untouched');
  const nativeRow=f.evaluate('Ygb');
  const builtinElement=list.props.renderItem(list.props.items[0],false),builtinCard=nativeRow(builtinElement.props);
  assert.equal(builtinElement.key,builtin.path);assert.equal(builtinCard.props.name,row.name);assert.equal(builtinCard.props.description,row.description);
  assert.equal(builtinCard.props.path,builtin.path);assert.equal(builtinCard.props.onDelete,undefined,'the original builtin-path deletion guard remains active');
  await builtinCard.props.onToggle(true);
  assert.equal(toggles[0].agent,builtin);assert.equal(toggles[0].enabled,true);
  const customElement=list.props.renderItem(list.props.items[1],true),customCard=nativeRow(customElement.props);
  assert.equal(customCard.props.name,row.type);assert.equal(customCard.props.description,row.english);
  await customCard.props.onDelete();assert.equal(deletions[0],custom);
  assert.equal(f.window.refreshCount,2);
  assert.equal(builtinRow.name,row.type);assert.equal(customRow.name,row.type);
  f.uninstall()();assert.equal(f.window.ahb,original);
});


// The current native detail page puts its source element in the shared header's
// subtitle property. These fixtures preserve that actual structure and the real
// agent/overview display owners without running plugin callbacks or services.
function currentPluginHeaderFixture(strings) {
  const f=nativeFixture({strings});
  f.evaluate(`
    var pluginCalls={detail:0,agents:0};
    A.useMemo=fn=>fn();A.useState=initial=>[initial,()=>{}];
    var vi=(...parts)=>parts.filter(Boolean).join(' '),c1=()=>null,M1=()=>null,W1=()=>null,$1=()=>null,D1b=()=>null;
    var ij=()=>({get:()=>undefined}),v1b=()=>false,x1b=()=>[];
    var pR=path=>path,qR=path=>path,P0b=path=>path?.split('/').at(-1),T0b=item=>item.content;
    var pluginState={installed:undefined};
    var pluginStore={provider:{},refresh:()=>{}};
    var eV=()=>pluginStore,yl=()=>({installedPlugins:pluginState.installed?[pluginState.installed]:[],isLoadingPlugins:false});
    var tR=(key,plugins)=>plugins.find(plugin=>plugin.path===key);
  `);
  f.evaluate("function E0b({name:a,titleId:b,logo:c,badges:d,subtitle:f,actions:g,description:h,layout:k=\"page\"}){k=k===\"modal\";return A.createElement(\"div\",{className:\"flex flex-col gap-3\"},A.createElement(\"div\",{className:vi(\"flex items-center justify-between gap-3 min-w-0\",k&&\"pr-16\")},A.createElement(\"div\",{className:\"flex items-center gap-3 min-w-0\"},A.createElement(c1,{src:c,name:a,className:\"w-12 h-12 rounded-xl\",iconClassName:\"w-6 h-6 text-muted-foreground/60\"}),A.createElement(\"div\",{className:\"flex flex-col gap-0.5 min-w-0\"},\nA.createElement(\"div\",{className:\"flex items-center gap-3 min-w-0\"},A.createElement(\"h1\",{id:b,className:\"text-lg font-medium tracking-tight leading-tight text-foreground truncate min-w-0\"},a),d),f)),A.createElement(\"div\",{className:vi(\"flex items-center gap-1 flex-shrink-0\",k&&\"self-start\")},g)),h&&A.createElement(\"p\",{className:\"text-sm text-muted-foreground leading-relaxed\"},h))}");
  f.evaluate("function a0b({entry:a}){a?.source?.source?.case===\"google3\"?a=(a=a.source.source.value.depotPath)?a.startsWith(\"//depot/\")?a.substring(8):a:\"\":a=\"\";return a?A.createElement(\"div\",{className:\"flex items-center gap-1 text-xs text-muted-foreground font-mono min-w-0\"},A.createElement(\"a\",{href:`http://cs/${a}`,target:\"_blank\",rel:\"noopener noreferrer\",title:a,className:\"truncate rounded-sm hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline transition-colors\"},\na),A.createElement(M1,{key:a,path:a})):null}");
  f.evaluate("function e0b(a){var b=eV(),c=yl(b.provider);return{plugin:tR(a,c.installedPlugins),isLoading:c.isLoadingPlugins,error:c.error,refetch:b.refresh}}");
  f.evaluate("function U0b({agents:a,showPaths:b=!1,MarkdownRenderer:c}){pluginCalls.agents++;return A.createElement(\"div\",null,a.map((d,f)=>{var g=pR(d.path),h=A.createElement,k=d.path||d.agent?.name||f;f=d.agent?.name||(d.path?P0b(d.path):void 0)||`Unnamed Agent ${(f??0)+1}`;return h.call(A,W1,{key:k,title:f,displayPath:b?qR(d.path):void 0,copyPath:b?g:void 0,description:d.agent?.description?.trim(),content:T0b(d),actions:b&&g?A.createElement(M1,{path:g,stopPropagation:!0}):void 0,MarkdownRenderer:c})}))}");
  f.evaluate("function O1b({plugin:a,uiExtensions:b=[],otherSidecars:c=[],contextProviders:d=[],isInstalled:f=!1,MarkdownRenderer:g}){var h=ij().get(\"customizations\")?.enablePluginThemes===!0,[k,l]=(0,A.useMemo)(()=>[(a.skills??[]).filter(v1b),(a.skills??[]).filter(n=>!v1b(n))],[a.skills]),m=(0,A.useMemo)(()=>x1b(a.hooksJson)?.length??0,[a.hooksJson]);return A.createElement(\"div\",{className:\"flex flex-col gap-6\"},a.readme&&A.createElement(\"section\",{\"aria-label\":\"Readme\",className:\"px-3\"},A.createElement(g,{markdown:a.readme,\nbaseDirUri:a.path||void 0,className:\"text-sm\"})),k.length>0&&A.createElement($1,{title:\"Commands\",count:k.length},A.createElement(N1b,{skills:k,showPaths:f,MarkdownRenderer:g})),l.length>0&&A.createElement($1,{title:\"Skills\",count:l.length},A.createElement(N1b,{skills:l,showPaths:f,MarkdownRenderer:g})),a.agents.length>0&&A.createElement($1,{title:\"Agents\",count:a.agents.length},A.createElement(U0b,{agents:a.agents,showPaths:f,MarkdownRenderer:g})),a.mcpServers.length>0&&A.createElement($1,{title:\"MCP servers\",\ncount:a.mcpServers.length},A.createElement(A1b,{mcpServers:a.mcpServers})),a.rules.length>0&&A.createElement($1,{title:\"Rules\",count:a.rules.length},A.createElement(E1b,{rules:a.rules,showPaths:f,MarkdownRenderer:g})),m>0&&A.createElement($1,{title:\"Hooks\",count:m},A.createElement(z1b,{hooksJson:a.hooksJson})),b.length>0&&A.createElement($1,{title:\"UI extensions\",count:b.length},A.createElement(a2,{sidecars:b,isInstalled:f,type:\"extension\",pluginName:a.name})),c.length>0&&A.createElement($1,{title:\"Automations\",\ncount:c.length},A.createElement(a2,{sidecars:c,isInstalled:f,type:\"sidecar\",pluginName:a.name})),d.length>0&&A.createElement($1,{title:\"Context Providers\",count:d.length},A.createElement(t1b,{contextProviders:d})),h&&a.themes.length>0&&A.createElement($1,{title:\"Themes\",count:a.themes.length},A.createElement(\"div\",{className:\"flex flex-col gap-1.5\"},a.themes.map(n=>{var q=n.label||n.id||\"Unnamed Theme\",r=n.mode===\"light\";return A.createElement(\"div\",{key:n.id||q,className:\"flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/40 px-3 py-2.5\"},\nA.createElement(\"div\",{className:\"flex items-center gap-3 min-w-0\"},A.createElement(\"div\",{className:\"h-6 w-6 rounded-md shrink-0 flex items-center justify-center\",style:{background:n.seeds?.primary||\"#007acc\",padding:\"1.5px\"}},A.createElement(\"div\",{className:\"h-full w-full rounded-[4px]\",style:{background:n.seeds?.background||(r?\"#F9F9F9\":\"#101010\")}})),A.createElement(\"div\",{className:\"flex flex-col min-w-0\"},A.createElement(\"span\",{className:\"text-sm font-medium text-foreground truncate\"},q),\nA.createElement(\"span\",{className:\"text-xs text-muted-foreground font-mono truncate\"},n.id))),A.createElement(\"div\",{className:\"flex items-center gap-2 shrink-0\"},A.createElement(\"span\",{className:\"inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground capitalize\"},n.mode||\"dark\")))}))),A.createElement(\"div\",{className:\"px-3\"},A.createElement(D1b,{plugin:a})))}");
  f.evaluate(`
    var detailPage=function detailPage({catalogId:a,entry:b,preview:c,installDir:d,MarkdownRenderer:f,onPromptSelected:g}) {
      pluginCalls.detail++;
      const {plugin:h}=e0b(d??'');const plugin=h??c;
      return A.createElement('div',null,
        A.createElement(E0b,{name:plugin.displayName||plugin.name,description:plugin.description,
          titleId:'plugin-title',subtitle:A.createElement(a0b,{entry:b}),actions:plugin.actions}),
        A.createElement('div',{id:'plugin-detail-tabpanel'},
          A.createElement(O1b,{plugin,otherSidecars:[],MarkdownRenderer:f}),
          A.createElement(U0b,{agents:plugin.agents,showPaths:true,MarkdownRenderer:f})),
        plugin.dynamicContent);
    };
  `);
  return f;
}

test('current plugin detail header reads its native subtitle catalog and projects display props without changing plugin data',()=>{
  const id='antigravity-plugins-official/plugin/gcalendar';
  const f=currentPluginHeaderFixture({
    [`marketplace:${id}:name:Google Calendar`]:'Google 日历',
    [`marketplace:${id}:description:Manage schedules.`]:'管理日程。',
    [`marketplace:${id}:readme:# Google Calendar`]:'# Google 日历'
  });
  const action=()=> 'native action',dynamic={raw:'Manage schedules.'},markdown=()=>null;
  const plugin=Object.freeze({name:'gcalendar',displayName:'Google Calendar',description:'Manage schedules.',path:'file:///plugins/gcalendar',
    skills:[],agents:[],mcpServers:[],rules:[],themes:[],hooksJson:'[]',readme:'# Google Calendar\n\n```txt\n# Google Calendar\n```',actions:action,dynamicContent:dynamic});
  const entry=Object.freeze({id,marketplace:'antigravity-plugins-official'}),props=Object.freeze({catalogId:id,entry,preview:plugin,MarkdownRenderer:markdown});
  const original=f.window.detailPage,adapters=f.install(),result=f.window.detailPage(props).props.children;
  assert.equal(f.window.pluginCalls.detail,1,'the existing native render still executes exactly once');
  const header=result[0];
  assert.equal(header.props.name,'Google 日历');assert.equal(header.props.description,'管理日程。');
  assert.equal(header.props.subtitle.props.entry,entry,'the original catalog object stays in the original display slot');
  assert.equal(header.props.actions,action);assert.equal(header.props.titleId,'plugin-title');
  assert.equal(result[2],dynamic);
  const overviewOwner=result[1].props.children[0];
  assert.equal(overviewOwner.props.chMarketplaceId,id,'sections receive official scope after the subtitle catalog is found');
  assert.equal(overviewOwner.props.plugin,plugin);assert.equal(overviewOwner.props.MarkdownRenderer,markdown);
  const overview=f.window.O1b(overviewOwner.props);
  const readme=overview.props.children[0].props.children;
  assert.equal(readme.props.markdown,'# Google 日历\n\n```txt\n# Google Calendar\n```','code fences retain original text');
  assert.equal(readme.props.baseDirUri,plugin.path);
  assert.equal(plugin.displayName,'Google Calendar');assert.equal(plugin.description,'Manage schedules.');
  assert.equal(plugin.readme,'# Google Calendar\n\n```txt\n# Google Calendar\n```');
  f.window.pluginState.installed={...plugin,installedFrom:{id:'third-party/plugin/gcalendar',marketplace:'third-party'}};
  const foreign=f.window.detailPage({...props,installDir:plugin.path}).props.children;
  assert.equal(foreign[0].props.name,'Google Calendar','same-name installed provenance must reject an unrelated official catalog');
  assert.equal(foreign[1].props.children[0].props.chMarketplaceId,undefined);
  f.window.pluginState.installed=undefined;
  const other=f.window.detailPage({...props,entry:{...entry,marketplace:'third-party'}}).props.children;
  assert.equal(other[0].props.name,'Google Calendar');assert.equal(other[1].props.children[0].props.chMarketplaceId,undefined);
  adapters.setStrings({[`marketplace:${id}:name:Google Calendar`]:'Google 在线日历'});
  assert.equal(f.window.detailPage(props).props.children[0].props.name,'Google 在线日历');
  f.uninstall()();assert.equal(f.window.detailPage,original);
});

test('current official plugin agent sections compose with the built-in agent adapter in one native render',()=>{
  const file=JSON.parse(fs.readFileSync(new URL('../runtime/translations.json',import.meta.url),'utf8')),catalog=file.strings??file,
    descriptionKey=Object.keys(catalog).find(key=>key.startsWith('builtin-agent:self:description:'));
  assert.ok(descriptionKey,'the native self description variant is present in the saved catalog');
  const english=descriptionKey.slice('builtin-agent:self:description:'.length),id='antigravity-plugins-official/plugin/gcalendar';
  const f=currentPluginHeaderFixture({
    'builtin-agent:self:name':'分身',[descriptionKey]:'继承父代理配置。',
    [`marketplace:${id}:agent-description:Review calendar changes.`]:'检查日历变更。'
  });
  const content=Object.freeze({raw:'Agent prompt bytes remain original'}),
    builtin=Object.freeze({path:'file:///native/builtin/agents/self',agent:Object.freeze({name:'self',description:english,source:Object.freeze({case:'config'})}),content}),
    official=Object.freeze({path:'file:///plugins/gcalendar/agents/reviewer',agent:Object.freeze({name:'calendar-reviewer',description:'Review calendar changes.',source:Object.freeze({case:'config'})}),content});
  const agents=Object.freeze([builtin,official]),markdown=()=>null,props=Object.freeze({agents,showPaths:true,MarkdownRenderer:markdown,chMarketplaceId:id});
  const original=f.window.U0b,adapters=f.install(),cards=f.window.U0b(props).props.children;
  assert.equal(f.window.pluginCalls.agents,1,'the shared native owner renders once, preserving all its projections');
  assert.equal(cards[0].props.title,'分身');assert.equal(cards[0].props.description,'继承父代理配置。');
  assert.equal(cards[1].props.title,'calendar-reviewer');assert.equal(cards[1].props.description,'检查日历变更。');
  assert.equal(adapters.hooks.filter(hook=>hook.key==='U0b'&&hook.wrapper===f.window.U0b).length,1,'later generic installation must not replace a separate detail-section wrapper');
  for(let index=0;index<cards.length;index++){
    assert.equal(cards[index].key,agents[index].path);assert.equal(cards[index].props.content,content);
    assert.equal(cards[index].props.displayPath,agents[index].path);assert.equal(cards[index].props.copyPath,agents[index].path);
    assert.equal(cards[index].props.MarkdownRenderer,markdown);
  }
  assert.equal(official.agent.description,'Review calendar changes.');assert.equal(builtin.agent.name,'self');
  const unscoped=f.window.U0b({...props,chMarketplaceId:undefined}).props.children;
  assert.equal(unscoped[0].props.title,'分身');
  assert.equal(unscoped[1].props.description,'Review calendar changes.','the reusable agent list keeps nonofficial metadata outside detail scope');
  adapters.setStrings({'builtin-agent:self:name':'分身',[descriptionKey]:'继承父代理配置。',
    [`marketplace:${id}:agent-description:Review calendar changes.`]:'审查日历变更。'});
  assert.equal(f.window.U0b(props).props.children[1].props.description,'审查日历变更。');
  f.uninstall()();assert.equal(f.window.U0b,original);
});

test('single-select questionnaire localizes trailing actions without changing native answer data', () => {
  const f = nativeFixture({strings:{Submit:'提交',Continue:'继续',Skip:'跳过'}});
  const native = f.evaluate(`(() => {
    const Button = () => null, Entry = () => null, Tooltip = () => null;
    const callback = () => 'native submit';
    const shortcut = A.createElement('span',{className:'native-shortcut'},'↵');
    const entry = {question:'Submit',options:[{id:'Continue',text:'Skip'}],isMultiSelect:false};
    return {callback,shortcut,entry,
      question:function question({last,multi}) {
        const dismissId = 'ask-question-dismiss-button';
        const m = A.createElement(A.Fragment,null,
          A.createElement(Button,{variant:'ghost',size:'sm',onClick:callback,'data-testid':'interaction-skip-button'},'Skip'),
          A.createElement(Button,{variant:'primary',size:'sm',onClick:callback,'data-testid':'interaction-continue-button'},last?'Submit':'Continue',shortcut),
          A.createElement(Tooltip,{id:'native-tooltip',place:'top'},last?'Submit (↵)':'Continue (↵)'),
          A.createElement(Tooltip,{id:'skip-tooltip',place:'top'},'Skip (Esc), Skip All (⌘Esc)'),
          A.createElement(Tooltip,{id:'cancel-tooltip',place:'top'},'Cancel Questionnaire and Stop the Agent (⌘.)'));
        return A.createElement('div',null,
          A.createElement(Entry,{entry,trailingActions:multi?undefined:m,onToggle:callback}),
          multi?A.createElement('div',null,m):null);
      }};
  })()`);
  f.window.question = native.question;
  f.install();
  for (const last of [false,true]) {
    const result = f.window.question({last,multi:false});
    const entryNode = result.props.children[0];
    assert.equal(entryNode.props.entry,native.entry);
    assert.equal(entryNode.props.entry.options[0].id,'Continue');
    assert.equal(entryNode.props.entry.options[0].text,'Skip');
    assert.equal(entryNode.props.onToggle,native.callback);
    const actions = entryNode.props.trailingActions.props.children;
    assert.equal(actions[0].props.children,'跳过');
    assert.equal(actions[0].props.onClick,native.callback);
    assert.equal(actions[0].props['data-testid'],'interaction-skip-button');
    assert.equal(actions[1].props.children[0],last?'提交':'继续');
    assert.equal(actions[1].props.children[1],native.shortcut);
    assert.equal(actions[1].props.onClick,native.callback);
    assert.equal(actions[2].props.children,last?'提交（↵）':'继续（↵）');
    assert.equal(actions[3].props.children,'跳过（Esc），全部跳过（⌘Esc）');
    assert.equal(actions[4].props.children,'取消问卷并停止智能体（⌘.）');
  }
  const multi = f.window.question({last:true,multi:true}).props.children;
  assert.equal(multi[0].props.trailingActions,undefined);
  assert.equal(multi[1].props.children.props.children[1].props.children[0],'提交');
});

const notificationAuditSources = {"noc": "({permissionSpec:a,trajectoryId:b,stepIndex:c,cascadeId:d,toolName:f})=>{var g=a.resource,{sendInteraction:h}=XY(),{logEvent:k}=EE(),{stepHandler:l,tokenizationService:m}=HC(),n=ij(),q=Zk(),r=n.get(\"rawCommandDetails\")?.isEnabled??!0,t=nD(),u=(0,A.useContext)(bE),v=l?.projectId;n=v?q.getProjectStateProvider(v):void 0;var w=Al(n)?.project?.isWorkspaceOnly??!1,x=f===\"ask_permission\"||f===\"ask_custom_permission\",[y,B]=(0,A.useState)(g?.target),[C,D]=(0,A.useState)(!1);f=a.persistSuggestionType;\nvar E=a.suggestedPersistPattern,G=f===W.PermissionInteractionSpec_PersistSuggestionType.BLOCKED,F=f===W.PermissionInteractionSpec_PersistSuggestionType.SUGGESTED,H=(0,A.useMemo)(()=>g?`${g.action}(${y})`:\"\",[g,y]),J=(0,A.useMemo)(()=>g&&F&&E?`${g.action}(${E})`:H,[g,E,F,H]),K=g?.action===\"command\"||g?.action===\"unsandboxed\";f=moc({cascadeId:d,commandLine:K?g?.target:void 0,shellName:a.shellName});var L=y===g?.target?f:void 0,N;K&&(N=f===void 0?\"pending\":\"settled\");f=(0,A.useMemo)(()=>{if(!g)return null;\nvar da=joc(g.action,x,a.actionDescription,{verbatim:!!L});return A.createElement(\"div\",{className:\"flex flex-col gap-0.5 w-full min-w-0 pb-1\",\"data-command-plugin-state\":N},L&&A.createElement(\"span\",{className:\"text-xs font-medium text-secondary-foreground animate-in fade-in duration-200\",\"data-testid\":\"permission-app-header\"},L.displayName||L.name),A.createElement(\"span\",{className:\"text-sm font-medium text-foreground min-w-0 break-words\"},da))},[g,x,a.actionDescription,L,N]);var M=r||!K||!a.actionDescription?.trim();\nn=(0,A.useMemo)(()=>{var da=g?.action===\"unsandboxed\",pa=g?.action===\"custom\",wa=g?.action===\"escalate_admin\",Ga=A.createElement(\"div\",{className:\"grid min-w-0 w-full rounded-lg bg-muted max-h-32 overflow-y-auto\"},A.createElement(\"pre\",{\"aria-hidden\":\"true\",className:\"col-start-1 row-start-1 m-0 min-w-0 w-full px-2.5 py-1.5 font-mono text-xs text-foreground whitespace-pre-wrap break-all pointer-events-none\"},K?A.createElement(MJb,{commandLine:y??\"\",shellName:a.shellName||void 0,tokenizationService:m}):\ny,y?.endsWith(\"\\n\")?\" \":null),A.createElement(\"textarea\",{value:y??\"\",onChange:ra=>{B(ra.target.value)},onKeyDown:ra=>{ra.key===\"Enter\"&&ra.preventDefault()},rows:1,spellCheck:!1,\"data-testid\":\"permission-target-editor\",className:\"col-start-1 row-start-1 min-w-0 w-full h-full px-2.5 py-1.5 font-mono text-xs bg-transparent border-none text-transparent caret-foreground focus:outline-none no-focus-ring resize-none overflow-hidden break-all\",\"aria-label\":\"Edit permission target\"}));return A.createElement(\"div\",\n{className:\"flex flex-col gap-1 px-1 w-full\"},a.reason&&A.createElement(\"p\",{className:\"px-1 pb-0.5 text-xs text-secondary-foreground leading-relaxed\"},a.reason),da&&A.createElement(\"div\",{className:\"flex items-center gap-2 px-1 text-xs text-amber-500\"},A.createElement(\"span\",{className:\"shrink-0 flex items-center justify-center w-4\"},\"\\u26a0\\ufe0f\"),A.createElement(\"span\",{className:\"leading-relaxed truncate block\"},\"Confirm the command is safe to run outside of the sandbox with full network and disk access.\")),\n!pa&&!wa&&(M?Ga:A.createElement(\"div\",{className:\"flex flex-col gap-1 w-full\"},A.createElement(\"button\",{type:\"button\",onClick:()=>D(ra=>!ra),\"aria-expanded\":C,\"data-testid\":\"permission-details-toggle\",className:\"flex items-center gap-0.5 px-1 text-xs text-secondary-foreground hover:text-foreground transition-colors cursor-pointer select-none w-fit\"},A.createElement(Z,{name:\"chevron_right\",className:`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${C?\"rotate-90\":\"\"}`}),A.createElement(\"span\",\nnull,\"Show details\")),C&&Ga)))},[g,K,y,a.reason,a.shellName,m,M,C]);(0,A.useEffect)(()=>{if(g){var da=g.action===\"escalate_admin\"?\"Requesting a one-time administrator (UAC) elevation\":`Requesting permission to ${(hoc[g.action]??\"Access\").toLowerCase()} ${g.target}`;Hm(da);Q([\"1\"]);S(\"\");Y(!1);B(g.target);D(!1)}},[g]);var [O,P]=(0,A.useState)([\"1\"]),Q=P,[R,T]=(0,A.useState)(\"\"),S=T,[U,V]=(0,A.useState)(!1),Y=V,{entry:ea,idToScopeMap:ba}=(0,A.useMemo)(()=>{var da=[],pa=new Map;if(!g)return{entry:p(W.AskQuestionEntrySchema,\n{question:\"\",options:[],isMultiSelect:!1}),idToScopeMap:pa};var wa=1,Ga=a.approvalScopeFilter,ra=(qa,ya)=>{if(ya===W.PermissionScope.ONCE||!Ga?.length||Ga.includes(ya))da.push(p(W.AskQuestionOptionSchema,{id:String(wa),text:qa})),pa.set(String(wa),ya),wa++},ha=g.action===\"escalate_admin\",oa=F&&r?E:\"\";x||(ha?ra(\"Yes, allow\",W.PermissionScope.ONCE):ra(\"Yes, allow this time\",W.PermissionScope.ONCE));G||ha||(g.action!==\"custom\"&&ra(x?oa?`Yes, save rule for '${oa}' in this conversation`:\"Yes, save rule in this conversation\":\noa?`Yes, and always allow '${oa}' in this conversation`:\"Yes, and always allow in this conversation\",W.PermissionScope.CONVERSATION),t?.projectSettingsProvider&&v&&!w&&(ha=v===\"outside-of-project\",ra(x?oa?`Yes, save rule for '${oa}' ${ha?\"when not in a project\":\"in this project\"}`:`Yes, save rule ${ha?\"when not in a project\":\"in this project\"}`:oa?`Yes, and always allow '${oa}' ${ha?\"when not in a project\":\"in this project\"}`:`Yes, and always allow ${ha?\"when not in a project\":\"in this project\"}`,\nW.PermissionScope.PROJECT)),u!==\"Cider\"&&ra(x?oa?`Yes, save rule for '${oa}' globally`:\"Yes, save rule globally\":oa?`Yes, and always allow '${oa}'`:\"Yes, and always allow\",W.PermissionScope.GLOBAL));return{entry:p(W.AskQuestionEntrySchema,{question:H,options:da,isMultiSelect:!1}),idToScopeMap:pa}},[H,g,t,v,x,G,F,E,r,u,w,a.approvalScopeFilter]);q=(0,A.useMemo)(()=>O.filter(da=>ba.has(da)),[O,ba]);var na=(0,A.useMemo)(()=>{var da=new Map,pa=a.triggerSource,wa;pa?.type===W.PermissionInteractionSpec_TriggerSource_Type.EFFECTIVE_GRANT&&\npa.detail?wa=`Conflicts with your configured Ask permission: ${pa.detail}`:pa?.type===W.PermissionInteractionSpec_TriggerSource_Type.FORCE_ASK_HOOK&&(wa=pa.detail?`Requires manual confirmation: ${pa.detail}`:\"Requires manual confirmation.\");if(wa)for(let [Ga,ra]of ba.entries())pa=Ga,ra!==W.PermissionScope.ONCE&&da.set(pa,wa);return da},[a.triggerSource,ba]),la=(0,A.useCallback)(async(da,pa=\"\")=>{var wa=e,Ga=e;try{if(g){var ra=W.PermissionScope.ONCE;if(da&&!U){var ha=ba.get(O[0]);if(ha===void 0)return;\nra=ha}var oa=y!==g.target?y:void 0;ha=ra;var qa=ra===W.PermissionScope.GLOBAL||ra===W.PermissionScope.PROJECT||ra===W.PermissionScope.WORKSPACE||ra===W.PermissionScope.CONVERSATION?J:H;var ya=qa&&ha!==W.PermissionScope.ONCE?p(I.PermissionGrantsConfigSchema,{allow:da?[qa]:[],deny:da?[]:[qa]}):void 0;qa=\"ONCE\";ra===W.PermissionScope.GLOBAL?qa=\"GLOBAL\":ra===W.PermissionScope.PROJECT?qa=\"PROJECT\":ra===W.PermissionScope.WORKSPACE?qa=\"WORKSPACE\":ra===W.PermissionScope.CONVERSATION&&(qa=\"CONVERSATION\");\nk(\"permission_decision\",{extra:{allow:da.toString(),scope:qa}});Ga(await wa(h(d,b,c,{case:\"permission\",value:p(W.PermissionInteractionSchema,{allow:da,scope:ra,userDenyInstruction:pa,persistGrants:ya,editedTarget:oa})})))}}finally{wa()}},[g,U,ba,O,H,J,h,d,b,c,y,k]),ia=(0,A.useCallback)(()=>{U?la(!1,R):la(!0)},[la,U,R]),ca=(0,A.useCallback)(()=>{la(!1)},[la]),aa=(0,A.useCallback)(()=>{la(!1)},[la]);return g?A.createElement(dZ,{questions:[ea],questionNodes:[f],headerIcon:L&&A.createElement(loc,{name:L.name,\nlogo:L.logo,size:18}),headerInputSlot:n,toolName:\"ask_permission\",permissionAction:g?.action,selections:[q],writeIns:[R],clampedIdx:0,count:1,handlePrev:()=>{},handleNext:()=>{},handleSubmit:ia,handleSkip:ca,handleSkipAll:aa,animationKey:0,onToggle:da=>{Q([da]);U&&Y(!1)},onClearSelections:()=>{Q([])},onWriteInChange:S,onWriteInActiveChange:Y,onNextNoWrap:()=>{},writeInActive:()=>U,writeInLabel:\"No\",writeInPlaceholder:\"(tell the agent what to do instead)\",disabledOptionIds:na}):null}", "joc": "(a,b,c,d={})=>{if((c=c?.trim())&&(a===\"command\"||a===\"unsandboxed\"||a===\"custom\")){if(d.verbatim&&!b)return c;a=c.charAt(0).toLowerCase()+c.slice(1);a.endsWith(\".\")&&(a=a.slice(0,-1));return b?`Save rule to always allow ${a}?`:`Allow ${a}?`}a=ioc[a]??\"access to this resource\";return b?`Save rule to always allow ${a}?`:`Allow ${a}?`}", "Iib": "function Iib({hookName:a,hookSpec:b,toggleEnabled:c,deleteHook:d,updateMatcher:f,addEventHandler:g,addHookToHandler:h,deleteHandler:k,updateHookObject:l,deleteHookCard:m}){var [n,q]=(0,A.useState)(\"PreToolUse\"),[r,t]=(0,A.useState)(!1),[u,v]=(0,A.useState)(\"*\"),[w,x]=(0,A.useState)(\"\"),[y,B]=(0,A.useState)(30),C=()=>{w.trim()?(g(a,n,{matcher:u,hooks:[{type:\"command\",command:w,timeout:y}]}),v(\"*\"),x(\"\"),B(30),t(!1)):alert(\"Command is required\")},D=b[n]&&b[n].length>0;return A.createElement(\"div\",{className:\"border border-border p-6 rounded-lg shadow-sm\"},\nA.createElement(\"div\",{className:\"flex justify-between items-center\"},A.createElement(\"h3\",{className:\"text-base font-semibold text-foreground\"},a),A.createElement(\"div\",{className:\"flex items-center gap-4\"},A.createElement(\"div\",{className:\"flex items-center gap-2 text-sm text-foreground/60\"},A.createElement(yP,{checked:b.enabled!==!1,onCheckedChange:()=>c(a)})),A.createElement(Gib,{actions:[{label:\"Delete Hook\",icon:\"delete\",onClick:()=>d(a),destructive:!0}]}))),A.createElement(\"div\",{className:\"inline-flex h-10 items-center justify-center rounded-md bg-muted/10 p-1 text-foreground/60 mt-4 w-full\"},\nDib.map(E=>{var G=(b[E]||[]).reduce((H,J)=>H+(J.hooks?J.hooks.length:0),0),F=n===E;return A.createElement(\"button\",{key:E,onClick:()=>{q(E)},className:`inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all cursor-pointer flex-1 ${F?\"bg-background text-foreground shadow-sm\":\"hover:text-foreground\"}`},A.createElement(\"span\",null,Eib[E]),G>0&&A.createElement(\"span\",{className:`ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold rounded-full ${F?\n\"bg-primary text-primary-foreground\":\"bg-muted/20 text-foreground/60\"}`},G))})),A.createElement(\"div\",{className:\"text-xs text-foreground/60 mt-2 px-1\"},Fib[n]),A.createElement(\"div\",{className:\"mt-4\"},D?A.createElement(\"div\",{className:\"space-y-4\"},b[n].map((E,G)=>{var F=dS.find(H=>H.value===(E.matcher||\"*\"));return A.createElement(\"div\",{key:G,className:\"bg-muted/5 border border-border p-4 rounded-lg\"},A.createElement(\"div\",{className:\"flex justify-between items-center mb-2\"},A.createElement(\"div\",\n{className:\"text-xs text-foreground/40\"},\"Handler #\",G+1),A.createElement(Gib,{actions:[{label:\"Add Hook Card\",icon:\"add\",onClick:()=>h(a,n,G)},{label:\"Delete Handler\",icon:\"delete\",onClick:()=>k(a,n,G),destructive:!0}]})),A.createElement(\"div\",{className:\"mb-3 text-sm flex flex-col gap-1\"},A.createElement(\"div\",{className:\"flex items-center gap-2\"},A.createElement(\"strong\",{className:\"text-foreground/80 font-medium\"},\"Matcher:\"),A.createElement(\"select\",{value:E.matcher||\"*\",onChange:H=>f(a,n,G,\nH.target.value),className:\"p-1 border rounded-md text-sm bg-muted text-foreground\"},dS.map(H=>A.createElement(\"option\",{key:H.value,value:H.value},H.label)))),F&&A.createElement(\"div\",{className:\"text-xs text-foreground/60\"},F.description)),A.createElement(\"div\",{className:\"space-y-2\"},E.hooks.map((H,J)=>A.createElement(Hib,{key:J,hook:H,onUpdate:K=>l(a,n,G,J,K),onDelete:()=>m(a,n,G,J)}))))})):r?null:A.createElement(\"div\",{className:\"text-foreground/60 p-4 text-sm border border-dashed border-border rounded-lg flex justify-between items-center gap-3\"},\nA.createElement(\"span\",null,\"No handlers configured for \",Eib[n],\".\"),A.createElement(Uz,{variant:\"secondary\",size:\"xs\",onClick:()=>{t(!0)}},\"Add Handler\")),r&&A.createElement(\"div\",{className:\"mt-4 border border-dashed border-border p-4 rounded-lg\"},A.createElement(\"h4\",{className:\"text-sm font-semibold mb-3 text-foreground/80\"},\"Add New Handler to \",Eib[n]),A.createElement(\"div\",{className:\"flex flex-col gap-3 text-sm\"},A.createElement(\"div\",{className:\"flex flex-col gap-1\"},A.createElement(\"div\",\n{className:\"flex gap-2 items-center\"},A.createElement(\"label\",{className:\"w-16 font-medium text-foreground/60\"},\"Matcher:\"),A.createElement(\"select\",{value:u,onChange:E=>v(E.target.value),className:\"p-1.5 border rounded-md text-sm text-foreground bg-muted\"},dS.map(E=>A.createElement(\"option\",{key:E.value,value:E.value},E.label)))),A.createElement(\"div\",{className:\"text-xs text-foreground/40 ml-18\"},dS.find(E=>E.value===u)?.description)),A.createElement(\"div\",{className:\"flex gap-2 items-center\"},\nA.createElement(\"label\",{className:\"w-16 font-medium text-foreground/60\"},\"Command:\"),A.createElement(\"input\",{type:\"text\",value:w,onChange:E=>x(E.target.value),placeholder:\"./script.sh\",className:\"p-1.5 border rounded-md flex-grow focus:outline-none focus:ring-2 focus:ring-primary text-foreground bg-muted\"})),A.createElement(\"div\",{className:\"flex gap-6 items-center flex-wrap\"},A.createElement(\"div\",{className:\"flex gap-2 items-center\"},A.createElement(\"label\",{className:\"font-normal text-foreground/60\"},\n\"Timeout:\"),A.createElement(\"input\",{type:\"number\",value:y,onChange:E=>B(parseInt(E.target.value,10)||0),className:\"p-1.5 border rounded-md w-16 text-sm text-foreground text-center bg-muted\"}),A.createElement(\"span\",{className:\"text-foreground/60\"},\"s\"))),A.createElement(\"div\",{className:\"flex gap-2 mt-2 justify-end\"},A.createElement(Uz,{variant:\"primary\",size:\"xs\",onClick:C},\"Add Handler\"),A.createElement(Uz,{variant:\"muted\",size:\"xs\",onClick:()=>{t(!1)}},\"Cancel\")))),D&&!r&&A.createElement(Uz,{variant:\"secondary\",\nsize:\"xs\",onClick:()=>{t(!0)},className:\"mt-4\"},\"Add Handler\")))}", "Jib": "({geminiDir:a})=>{var [b,c]=(0,A.useState)({}),[d,f]=(0,A.useState)(\"\"),[g,h]=(0,A.useState)(!1),[k,l]=(0,A.useState)(!1),[m,n]=(0,A.useState)(null),[q,r]=(0,A.useState)(!1),{readFile:t,writeFile:u}=aC(),v=(0,A.useMemo)(()=>{if(a)return Vt(a,\"hooks.json\").toString()},[a]),w=(0,A.useCallback)(async()=>{var K=e,L=e;try{if(v){r(!0);n(null);try{let N=L(await K(t({uri:v}))),M=(new TextDecoder(\"utf-8\")).decode(N.content),O=ho(M,Cib);c(O.success?O.data:{})}catch(N){L();let M=String(N).toLowerCase();\nM.includes(\"not found\")||M.includes(\"no such file\")?c({}):(n(\"Failed to load hooks.json: \"+N),console.error(\"Failed to read hooks.json:\",N))}finally{r(!1)}}}finally{K()}},[v,t]);(0,A.useEffect)(()=>{w()},[w]);var x=(0,A.useCallback)(async()=>{var K=e,L=e;try{if(v){l(!0);n(null);try{let N=JSON.stringify(b,null,2),M=(new TextEncoder).encode(N);L(await K(u({uri:v,content:M,overwrite:!0})));L(await K(w()));alert(\"Configuration saved successfully!\")}catch(N){L(),n(\"Failed to save hooks.json: \"+N),console.error(\"Failed to write hooks.json:\",\nN)}finally{l(!1)}}}finally{K()}},[v,u,w,b]),y=K=>{c(L=>{var N=L[K];return{...L,[K]:{...N,enabled:N.enabled===!1}}})},B=()=>{d.trim()&&(b[d]?alert(\"Hook with this name already exists\"):(c(K=>({...K,[d]:{enabled:!0}})),f(\"\"),h(!1)))},C=K=>{window.confirm(`Are you sure you want to delete the hook \"${K}\"?`)&&c(L=>{L={...L};delete L[K];return L})},D=(K,L,N,M)=>{c(O=>{var P={...O[K]},Q=[...P[L]];Q[N]={...Q[N],matcher:M};P[L]=Q;return{...O,[K]:P}})},E=(K,L,N)=>{c(M=>{var O={...M[K]};O[L]=[...(O[L]||[]),\nN];return{...M,[K]:O}})},G=(K,L,N)=>{c(M=>{var O={...M[K]},P=[...O[L]],Q=[...P[N].hooks,{type:\"command\",command:\"\",timeout:30}];P[N]={...P[N],hooks:Q};O[L]=P;return{...M,[K]:O}})},F=(K,L,N)=>{window.confirm(\"Are you sure you want to delete this handler?\")&&c(M=>{var O={...M[K]},P=[...O[L]];P.splice(N,1);P.length===0?delete O[L]:O[L]=P;return{...M,[K]:O}})},H=(K,L,N,M,O)=>{c(P=>{var Q={...P[K]},R=[...Q[L]],T=[...R[N].hooks];T[M]=O;R[N]={...R[N],hooks:T};Q[L]=R;return{...P,[K]:Q}})},J=(K,L,N,M)=>{window.confirm(\"Are you sure you want to delete this hook card?\")&&\nc(O=>{var P={...O[K]},Q=[...P[L]],R=[...Q[N].hooks];R.splice(M,1);Q[N]={...Q[N],hooks:R};P[L]=Q;return{...O,[K]:P}})};return q?A.createElement(\"div\",{className:\"flex items-center justify-center py-4 gap-2\"},A.createElement(ZB,{className:\"w-4 h-4 text-muted-foreground\"}),A.createElement(\"span\",{className:\"text-sm text-muted-foreground\"},\"Loading hooks...\")):A.createElement(\"div\",{className:\"p-8 font-sans text-left text-foreground min-h-screen\"},m&&A.createElement(\"div\",{className:\"border border-red-500/20 rounded p-4 bg-red-500/5 text-red-500 text-sm mb-4\"},\nm),A.createElement(\"div\",{className:\"flex justify-between items-center mb-6\"},A.createElement(\"h2\",{className:\"text-lg font-bold text-foreground\"},\"Agent Hooks Configuration\"),!g&&A.createElement(Uz,{variant:\"secondary\",size:\"xs\",onClick:()=>{h(!0)}},\"+ Add Hook\")),g&&A.createElement(\"div\",{className:\"mb-6 border border-dashed border-border p-4 rounded-lg flex gap-3 items-center\"},A.createElement(\"input\",{type:\"text\",placeholder:\"New hook name\",value:d,onChange:K=>f(K.target.value),className:\"p-2.5 border rounded-md flex-grow focus:outline-none focus:ring-1 focus:ring-primary text-sm bg-muted text-foreground\"}),\nA.createElement(Uz,{variant:\"primary\",size:\"sm\",onClick:B},\"Add\"),A.createElement(Uz,{variant:\"muted\",size:\"sm\",onClick:()=>{h(!1);f(\"\")}},\"Cancel\")),A.createElement(\"div\",{className:\"flex flex-col gap-6\"},Object.entries(b).map(([K,L])=>A.createElement(Iib,{key:K,hookName:K,hookSpec:L,toggleEnabled:y,deleteHook:C,updateMatcher:D,addEventHandler:E,addHookToHandler:G,deleteHandler:F,updateHookObject:H,deleteHookCard:J}))),A.createElement(\"div\",{className:\"mt-8 flex justify-end\"},A.createElement(Uz,\n{variant:\"primary\",size:\"xs\",onClick:x,disabled:k},k?\"Saving...\":\"Save Configuration\")))}", "MD": "function MD(a,b){return(typeof a===\"function\"?a(b):a).filter(c=>!!c).map(c=>({...c,onClick:c.onClick??c.click,disabled:c.disabled??(c.enabled!==void 0?!c.enabled:!1),items:c.items?MD(c.items):void 0}))}", "mSa": "function mSa(a,b,c=\"cmi\"){return a.map((d,f)=>{f=d.id||`${c}-${f}`;d.onClick&&b.set(f,d.onClick);var g={id:f,label:d.label,type:d.type&&d.type!==\"item\"&&d.type!==\"label\"?d.type:\"normal\",checked:d.checked,disabled:d.type===\"label\"?!0:d.disabled,accelerator:lSa(d.accelerator)};d.items&&d.items.length>0&&(g.submenu=mSa(d.items,b,`${f}-sub`));return g})}", "nSa": "function nSa(a){var b=new Map;a=mSa(a,b);window.electronNative?.showContextMenu?.(a)?.then(c=>{c&&b.has(c)&&b.get(c)()}).catch(c=>{console.warn(\"Failed to display native context menu:\",c)})}"};
const notificationAuditStrings = {"Open in External Browser": "在外部浏览器中打开", "native-confirm:dangerous-link": "是否前往 {url}？\n\n警告：此链接可能有危险", "permission-action:read_file": "读取此路径", "permission-action:write_file": "写入此路径", "permission-action:read_url": "读取此网址", "permission-action:execute_url": "在此网址上执行操作", "permission-action:command": "运行此命令", "permission-action:unsandboxed": "在沙箱外运行此命令", "permission-action:mcp": "使用此 MCP 工具", "permission-action:escalate_admin": "进行一次性管理员（UAC）提权", "permission-action:resource": "访问此资源", "permission-question:allow": "允许{action}？", "permission-question:save-rule": "保存规则，始终允许{action}？", "permission-choice:allow": "是，允许", "permission-choice:allow-once": "是，仅允许这一次", "permission-choice:save-rule": "是，保存规则", "permission-choice:save-rule-pattern": "是，保存“{pattern}”规则", "permission-choice:always-allow": "是，并始终允许", "permission-choice:always-allow-pattern": "是，并始终允许“{pattern}”", "permission-choice:deny": "否", "permission-choice:deny-instruction": "（告诉智能体接下来怎么做）", "permission-scope:conversation": "（仅此对话）", "permission-scope:project": "（仅此项目）", "permission-scope:outside-project": "（未打开项目时）", "permission-scope:global": "（全局）", "permission-disabled:configured-ask": "与你配置的询问权限冲突：{detail}", "permission-disabled:manual-detail": "需要手动确认：{detail}", "permission-disabled:manual": "需要手动确认。", "native-alert:Command is required": "请输入命令", "native-alert:Configuration saved successfully!": "配置已保存！", "native-alert:Hook with this name already exists": "已存在同名钩子"};

function notificationAuditTree(value,predicate) {
  const found=[];
  const visit=node=>{
    if(Array.isArray(node)){node.forEach(visit);return;}
    if(!node?.props)return;
    if(predicate(node))found.push(node);
    visit(node.props.children);
    for(const key of ['questionNodes','headerInputSlot'])visit(node.props[key]);
  };
  visit(value);return found;
}

test('current permission source localizes owned titles and choices while preserving command metadata and native decision fields',()=>{
  const f=nativeFixture({strings:notificationAuditStrings});
  f.window.eval=source=>f.evaluate(source);
  f.evaluate(`
    var permissionState={hooks:0,effects:[],projectId:'project-id',plugin:undefined,rawDetails:true,original:null};
    A.useState=value=>{permissionState.hooks++;return [value,()=>{}]};
    A.useMemo=fn=>{permissionState.hooks++;return fn()};A.useCallback=fn=>{permissionState.hooks++;return fn};
    A.useContext=()=>{permissionState.hooks++;return 'desktop'};A.useEffect=fn=>{permissionState.hooks++;permissionState.effects.push(fn)};
    var bE={},W={PermissionInteractionSpec_PersistSuggestionType:{BLOCKED:1,SUGGESTED:2},PermissionScope:{ONCE:1,CONVERSATION:2,PROJECT:3,GLOBAL:4,WORKSPACE:5},
      PermissionInteractionSpec_TriggerSource_Type:{EFFECTIVE_GRANT:1,FORCE_ASK_HOOK:2},AskQuestionEntrySchema:{},AskQuestionOptionSchema:{}};
    var I={},p=(schema,value)=>({...value}),XY=()=>({sendInteraction:()=>{throw Error('no permission action expected')}}),EE=()=>({logEvent:()=>{}});
    var HC=()=>({stepHandler:{projectId:permissionState.projectId},tokenizationService:{}}),ij=()=>({get:()=>({isEnabled:permissionState.rawDetails})});
    var Zk=()=>({getProjectStateProvider:()=>({})}),nD=()=>({projectSettingsProvider:{}}),Al=()=>({project:{isWorkspaceOnly:false}});
    var moc=()=>permissionState.plugin,Hm=()=>{throw Error('no effect expected')},loc=()=>null,MJb=()=>null,Z=()=>null,dZ=()=>null;
    const ioc={read_file:'read access to this path',write_file:'write access to this path',read_url:'reading this URL',execute_url:'executing actions on this URL',command:'running this command',unsandboxed:'running this command outside the sandbox',mcp:'using this MCP tool',escalate_admin:'a one-time administrator (UAC) elevation'};
    const permissionCreateElement=A.createElement;
    A.createElement=(type,props,...children)=>{const element=permissionCreateElement(type,props,...children);if(type===dZ)permissionState.original=element;return element};
  `);
  f.evaluate(`var joc=${notificationAuditSources.joc};var noc=${notificationAuditSources.noc};`);
  const originalTitle=f.window.joc,originalView=f.window.noc;
  const installed=f.install();
  assert.ok(installed.hooks.some(hook=>hook.kind==='native-permission-question'));
  assert.ok(installed.uiKeys.includes('noc'));
  assert.equal(f.window.joc('read_file',false),'允许读取此路径？');
  assert.equal(f.window.joc('read_file',true),'保存规则，始终允许读取此路径？');
  const description='Run "Overview"  $&\nKeep CASE.';
  const nativeDescription=originalTitle('command',false,description).slice('Allow '.length,-1);
  assert.equal(f.window.joc('command',false,description),`允许${nativeDescription}？`);
  assert.equal(f.window.joc('command',false,description,{verbatim:true}),description);
  const target='echo "Yes, allow"  $&\n/tmp/a  b',pattern='command(echo "$&"  /tmp/a  b)',detail='Overview  /tmp/A  B';
  const spec=Object.freeze({resource:Object.freeze({action:'unsandboxed',target}),persistSuggestionType:2,suggestedPersistPattern:pattern,
    actionDescription:description,reason:'Select Model',triggerSource:Object.freeze({type:2,detail})});
  const input=Object.freeze({permissionSpec:spec,trajectoryId:'trajectory-id',stepIndex:7,cascadeId:'cascade-id',toolName:'run_command'});
  const rendered=f.window.noc(input),raw=f.window.permissionState.original;
  const questions=rendered.props.questions[0],nativeQuestions=raw.props.questions[0];
  assert.deepEqual(Array.from(questions.options,option=>option.text),['是，仅允许这一次',`是，并始终允许“${pattern}”（仅此对话）`,`是，并始终允许“${pattern}”（仅此项目）`,`是，并始终允许“${pattern}”（全局）`]);
  assert.deepEqual(Array.from(questions.options,option=>option.id),Array.from(nativeQuestions.options,option=>option.id));
  assert.equal(questions.question,`unsandboxed(${target})`);
  assert.equal(nativeQuestions.options[0].text,'Yes, allow this time','the generated native data stays unchanged');
  assert.equal(questions.isMultiSelect,nativeQuestions.isMultiSelect);
  assert.equal(rendered.props.writeInLabel,'否');
  assert.equal(rendered.props.writeInPlaceholder,'（告诉智能体接下来怎么做）');
  assert.equal(spec.resource.target,target);assert.equal(spec.actionDescription,description);
  assert.equal(notificationAuditTree(rendered,node=>node.props['data-testid']==='permission-target-editor')[0].props.value,target);
  for(const key of ['handleSubmit','handleSkip','handleSkipAll','onToggle','onWriteInChange'])assert.equal(rendered.props[key],raw.props[key]);
  assert.deepEqual(Array.from(rendered.props.disabledOptionIds.keys()),Array.from(raw.props.disabledOptionIds.keys()));
  assert.ok(Array.from(rendered.props.disabledOptionIds.values()).every(value=>value===`需要手动确认：${detail}`));
  assert.ok(Array.from(raw.props.disabledOptionIds.values()).every(value=>value===`Requires manual confirmation: ${detail}`));
  const hookCount=f.window.permissionState.hooks;f.window.permissionState.hooks=0;
  originalView(input);assert.equal(f.window.permissionState.hooks,hookCount,'the native Hook sequence runs once');
  f.window.permissionState.projectId='outside-of-project';
  const saving=f.window.noc({...input,toolName:'ask_permission'});
  assert.deepEqual(Array.from(saving.props.questions[0].options,option=>option.text),[`是，保存“${pattern}”规则（仅此对话）`,`是，保存“${pattern}”规则（未打开项目时）`,`是，保存“${pattern}”规则（全局）`]);
  f.window.permissionState.plugin={displayName:'Overview',name:'Readme'};
  const plugin=f.window.noc(input),header=plugin.props.questionNodes[0].props.children;
  assert.equal(header[0].props.children,'Overview');assert.equal(header[1].props.children,description);
  f.uninstall()();assert.equal(f.window.joc,originalTitle);assert.equal(f.window.noc,originalView);
});

test('current native menu and confirm boundaries preserve supplied group names and complete terminal URLs',async()=>{
  const start=renderer.indexOf('  function computerUseAppName('),end=renderer.indexOf('  function patchText(',start);
  const calls={menus:[],confirm:[]},receiver={};
  const environment={dictionary:{...notificationAuditStrings,Overview:'概览'},calls,console};environment.window=environment;
  environment.confirm=function(...args){calls.confirm.push({receiver:this,args});return false};
  environment.electronNative={showContextMenu:items=>{calls.menus.push(items);return Promise.resolve(null)}};
  const context=vm.createContext(environment);
  vm.runInContext(`let strings,normalizedStrings;const nativeMenuHooks=[];const projectPlaceholders=new Set();var lSa=value=>value;
    ${renderer.slice(start,end)}
    ${notificationAuditSources.MD}\n${notificationAuditSources.mSa}\n${notificationAuditSources.nSa}
    setStrings(dictionary);installNativeMenuHooks();`,context);
  const callback=()=>{throw Error('no menu action expected')};
  environment.items=[{id:'open-external',label:'Open in External Browser',onClick:callback},
    {id:'move-to-group',label:'Overview',items:[{id:'group-user-id',label:'Overview',type:'checkbox',testId:'conversation-group-Overview',checked:true,onClick:callback}]}];
  vm.runInContext('nSa(MD(items))',context);await Promise.resolve();
  assert.equal(calls.menus[0][0].label,'在外部浏览器中打开');
  assert.equal(calls.menus[0][1].label,'概览');
  assert.equal(calls.menus[0][1].submenu[0].label,'Overview');
  assert.equal(calls.menus[0][1].submenu[0].id,'group-user-id');assert.equal(calls.menus[0][1].submenu[0].checked,true);
  assert.equal(environment.items[0].label,'Open in External Browser');assert.equal(environment.items[1].items[0].onClick,callback);
  const url='https://example.com/a?x=$&  \nNext?z="Overview"';
  const message=`Do you want to navigate to ${url}?\n\nWARNING: This link could potentially be dangerous`;
  assert.equal(environment.confirm.call(receiver,message,'extra'),false);
  assert.equal(calls.confirm[0].args[0],`是否前往 ${url}？\n\n警告：此链接可能有危险`);
  assert.equal(calls.confirm[0].args[1],'extra');assert.equal(calls.confirm[0].receiver,receiver);
  environment.confirm(message+'!');assert.equal(calls.confirm[1].args[0],message+'!');
});

test('current hook owner alert callbacks localize only their fixed branches and return to English after uninstall',async()=>{
  const f=nativeFixture({strings:notificationAuditStrings});f.window.eval=source=>f.evaluate(source);
  f.evaluate(`
    var hookState={values:[],index:0,hooks:0,alerts:[],writes:[],effects:[]};
    A.useState=value=>{hookState.hooks++;const selected=hookState.index<hookState.values.length?hookState.values[hookState.index]:value;hookState.index++;return [selected,()=>{}]};
    A.useMemo=fn=>{hookState.hooks++;return fn()};A.useCallback=fn=>{hookState.hooks++;return fn};
    A.useEffect=fn=>{hookState.hooks++;hookState.effects.push(fn)};
    var alert=value=>hookState.alerts.push(value),Uz=()=>null,yP=()=>null,Gib=()=>null,Hib=()=>null,ZB=()=>null;
    const Dib=['PreToolUse'],Eib={PreToolUse:'Before Tool Use'},Fib={PreToolUse:'description'},dS=[{value:'*',label:'All',description:'matcher'}];
    const Cib={};var aC=()=>({readFile:async()=>({content:new TextEncoder().encode('{}')}),writeFile:async data=>hookState.writes.push(data)});
    var Vt=(directory,name)=>({toString:()=>directory+'/'+name}),ho=()=>({success:true,data:{}}),e=value=>value;
  `);
  f.window.TextEncoder=TextEncoder;f.window.TextDecoder=TextDecoder;
  f.evaluate(`var Iib=${notificationAuditSources.Iib};var Jib=${notificationAuditSources.Jib};`);
  const originalHandler=f.window.Iib,originalConfig=f.window.Jib;
  const installed=f.install();assert.ok(installed.uiKeys.includes('Iib'));
  assert.ok(installed.hooks.some(hook=>hook.key==='Jib'&&hook.kind==='native-hook-alert'));
  f.window.hookState.values=['PreToolUse',true,'*','',30];
  const handler=f.window.Iib({hookName:'Overview',hookSpec:{},addEventHandler:()=>{throw Error('blank command must not create a handler')}});
  const addHandler=notificationAuditTree(handler,node=>node.props.variant==='primary'&&node.props.children==='Add Handler')[0].props.onClick;
  addHandler();assert.equal(f.window.hookState.alerts.at(-1),'请输入命令');assert.equal(f.window.hookState.hooks,5);
  f.window.hookState.values=[{Overview:{enabled:true}},'Overview',true,false,null,false];f.window.hookState.index=0;
  const config=f.window.Jib({geminiDir:'/tmp/source-fixture'});
  const addHook=notificationAuditTree(config,node=>node.props.variant==='primary'&&node.props.children==='Add')[0].props.onClick;
  const save=notificationAuditTree(config,node=>node.props.children==='Save Configuration')[0].props.onClick;
  addHook();assert.equal(f.window.hookState.alerts.at(-1),'已存在同名钩子');
  await save();assert.equal(f.window.hookState.alerts.at(-1),'配置已保存！');
  assert.equal(f.window.hookState.writes[0].uri,'/tmp/source-fixture/hooks.json');
  assert.equal(f.window.hookState.writes[0].overwrite,true);
  const nested=notificationAuditTree(config,node=>node.props.hookName==='Overview')[0];
  assert.equal(nested.type,f.window.Iib,'the compiled parent captures the already-adapted child owner');
  f.uninstall()();assert.equal(f.window.Iib,originalHandler);assert.equal(f.window.Jib,originalConfig);
  addHandler();assert.equal(f.window.hookState.alerts.at(-1),'Command is required');
  addHook();assert.equal(f.window.hookState.alerts.at(-1),'Hook with this name already exists');
  await save();assert.equal(f.window.hookState.alerts.at(-1),'Configuration saved successfully!');
});

test('lexical MCP app view reuses fixed UI rules and preserves its native gate, Hooks and error data', () => {
  const f = nativeFixture();
  f.window.eval = source => f.evaluate(source);
  const nativeSources = {"PNb": "({serverName:a,resourceUri:b,argumentsJson:c=\"\",callToolResultJson:d=\"\",title:f,placement:g,cascadeId:h,modelContext:k})=>{var {getMcpAppResource:l}=aC(),{hostCapabilities:m,register:n}=NNb({serverName:a,resourceUri:b,cascadeId:h,modelContext:k});k=Qk(us);var q=(0,A.useRef)(null),[r,t]=(0,A.useState)({status:\"loading\"}),[u,v]=(0,A.useState)(150),w=g===\"pane\";h=(0,A.useCallback)(K=>{if(K){var L=document.createElement(\"iframe\");L.dataset.testid=\"mcp-app-view\";L.style.border=\"none\";L.style.background=\n\"transparent\";L.style.width=\"100%\";K.appendChild(L);q.current=L}else q.current?.remove(),q.current=null},[]);(0,A.useLayoutEffect)(()=>{var K=q.current;K&&(K.title=f,K.style.height=w?\"100%\":`${u}px`,K.style.transition=w?\"\":\"height 0.2s ease-out\")},[f,u,w,r.status]);var x=k?.type===\"light\"||k?.type===\"hcLight\"?\"light\":\"dark\",y=(0,A.useMemo)(()=>c?jo(c)??{}:{},[c]),B=(0,A.useMemo)(()=>{if(d)try{return JSON.parse(d)}catch{}},[d]),C=(0,A.useRef)(x),D=(0,A.useRef)(g),E=(0,A.useRef)(y),G=(0,A.useRef)(B);\n(0,A.useEffect)(()=>{C.current=x;D.current=g;E.current=y;G.current=B});var F=(0,A.useRef)(null),H=(0,A.useRef)(!1);(0,A.useEffect)(()=>{if(l&&b){var K=!1;t({status:\"loading\"});v(150);l(a,b).then(({html:L,metaJson:N})=>{if(!K){a:if(N){try{var M=JSON.parse(N)}catch{N={csp:eKb};break a}M=gKb(gKb(M)?.ui);N=gKb(M?.csp);M=M?.prefersBorder;N={csp:{connectDomains:jZ(N?.connectDomains),resourceDomains:jZ(N?.resourceDomains),frameDomains:jZ(N?.frameDomains),baseUriDomains:jZ(N?.baseUriDomains)},prefersBorder:typeof M===\n\"boolean\"?M:void 0}}else N={csp:eKb};L=`<!DOCTYPE html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"${hKb(N.csp)}\">`+L;t({status:\"ready\",document:L,prefersBorder:N.prefersBorder})}},L=>{K||t({status:\"error\",message:L instanceof Error?L.message:String(L)})});return()=>{K=!0}}},[l,a,b]);var J=r.status===\"ready\"?r.document:\"\";(0,A.useEffect)(()=>{var K=q.current,L=K?.contentWindow;if(K&&L&&J){var N=new mMb(m,{hostContext:ONb(C.current,K,D.current)});F.current=N;H.current=!1;N.addEventListener(\"initialized\",\n()=>{H.current=!0;N.sendToolInput({arguments:E.current});G.current&&N.sendToolResult(G.current)});N.addEventListener(\"sizechange\",({height:O})=>{D.current===\"inline\"&&typeof O===\"number\"&&O>0&&v(Math.min(Math.ceil(O),800))});n(N);var M=!1;N.connect(new NLb(L,L)).then(()=>{M||vn(K,2,J)});return()=>{M=!0;F.current=null;H.current=!1;N.close()}}},[J,m,n]);(0,A.useEffect)(()=>{H.current&&F.current?.sendToolInput({arguments:y})},[y]);(0,A.useEffect)(()=>{H.current&&B&&F.current?.sendToolResult(B)},[B]);\n(0,A.useEffect)(()=>{var K=requestAnimationFrame(()=>{var L=F.current,N=q.current;if(L&&N){N=ONb(x,N,g);let M={},O=!1;for(let P of Object.keys(N)){let Q=N[P];JSON.stringify(L._hostContext[P])!==JSON.stringify(Q)&&(Object.assign(M,{[P]:Q}),O=!0)}O&&(L._hostContext=N,L.notification({method:\"ui/notifications/host-context-changed\",params:M}))}});return()=>{cancelAnimationFrame(K)}},[x,k,g]);if(r.status===\"error\")return A.createElement(\"div\",{className:\"text-sm text-secondary-foreground\"},\"Could not load the app view: \",\nr.message);k=[w?\"h-full w-full\":\"\",r.status===\"ready\"&&r.prefersBorder?\"rounded-md border border-border\":\"\"].filter(Boolean).join(\" \");return A.createElement(\"div\",{ref:h,className:k||void 0,\"aria-busy\":r.status===\"loading\"})}", "QNb": "a=>{var {getMcpAppResource:b}=aC();return b&&a.resourceUri?A.createElement(PNb,{...a}):null}"};
  f.evaluate(`
    var mcpState = {views:0,effects:0,hooks:0,loads:0,error:'Could not load the app view: '};
    var aC = () => ({getMcpAppResource() { mcpState.loads++; throw Error('resource loading must remain deferred'); }});
    var NNb = () => { mcpState.views++;return {hostCapabilities:{},register() {}}; };
    var Qk = () => ({type:'dark'}), us = {}, jo = value => JSON.parse(value);
    A.useRef = () => {mcpState.hooks++;return {current:null};};
    A.useState = value => {mcpState.hooks++;return [typeof value==='object'&&value.status==='loading'?{status:'error',message:mcpState.error}:value,()=>{}];};
    A.useCallback = callback => {mcpState.hooks++;return callback;};
    A.useMemo = read => {mcpState.hooks++;return read();};
    A.useEffect = () => {mcpState.hooks++;mcpState.effects++;};
    A.useLayoutEffect = () => {mcpState.hooks++;mcpState.effects++;};
    const PNb = ${nativeSources.PNb};
    var QNb = ${nativeSources.QNb};
  `);
  const nativeGate = f.window.QNb, nativeView = f.evaluate('PNb');
  assert.equal(Object.prototype.hasOwnProperty.call(f.window,'PNb'),false,'the source view remains a lexical const');
  const callback = () => 'native callback', ref = {current:null};
  const context = Object.freeze({text:'Overview'});
  const props = Object.freeze({key:'native-mcp-key',ref,serverName:'Overview',resourceUri:'ui://native/view',title:'Overview',
    argumentsJson:'{"value":"Overview"}',callToolResultJson:'{"result":"Overview"}',modelContext:context,onClose:callback});
  const before = nativeGate(props);
  const raw = nativeView(before.props), nativeHookCount = f.window.mcpState.hooks;
  f.window.mcpState.hooks=0;f.window.mcpState.views=0;
  const installed = f.install();
  assert.ok(installed.uiKeys.includes('QNb.PNb'),'the identified const uses the common UI visitor');
  const element = f.window.QNb(props), again = f.window.QNb(props);
  assert.notEqual(element.type,nativeView);
  assert.equal(element.type,again.type,'the proxy component identity stays stable');
  assert.equal(element.key,before.key);
  assert.equal(element.props.ref,ref);
  assert.equal(element.props.onClose,callback);
  assert.equal(element.props.modelContext,context);
  assert.equal(element.props.argumentsJson,props.argumentsJson);
  assert.equal(element.props.callToolResultJson,props.callToolResultJson);
  assert.equal(element.props.resourceUri,props.resourceUri);
  const view = element.type(element.props);
  assert.equal(f.window.mcpState.views,1,'the native Hook component renders exactly once');
  assert.equal(f.window.mcpState.hooks,nativeHookCount,'the native Hook sequence is retained');
  assert.equal(view.type,raw.type);
  assert.equal(view.props.className,raw.props.className);
  assert.equal(view.props.children[0],'无法加载应用视图：');
  assert.equal(view.props.children[1],raw.props.children[1],'the real error remains native even when it equals the fixed English prefix');
  assert.equal(view.props['data-ch-keep'],true,'sidebar DOM translation cannot rewrite the supplied error');
  assert.equal(f.window.QNb({...props,resourceUri:''}),null,'the native resource gate still controls visibility');
  assert.equal(f.window.mcpState.loads,0,'no resource request or effect was executed');
  f.uninstall()();
  assert.equal(f.window.QNb,nativeGate);
  assert.equal(f.window.QNb(props).type,nativeView);
  const cached = element.type(element.props);
  assert.equal(cached.props.children[0],raw.props.children[0],'a cached proxy delegates to the native holder after uninstall');
  assert.equal(cached.props.children[1],raw.props.children[1]);
  assert.equal(cached.props['data-ch-keep'],undefined);
  assert.equal(f.window.mcpState.loads,0);
});


test('current native mquery translates its owned query connector and preserves supplied values', () => {
  const f = nativeFixture();
  f.evaluate("Object.assign(A,{useMemo:f=>f(),useState:v=>[v,()=>{}],useCallback:f=>f,useContext:()=>null});\nfunction HC(){return{workspaceInfo:{homeDir:'file:///fixture',workspaceUris:['file:///fixture']},artifactsDir:'/fixture'}}\nfunction PC(){return{openUrlInSystemBrowser(){throw Error('unexpected external action')}}}\nfunction JC(){}function IY(){}function MY(){}function Z(){}function Uz(){}\nfunction RB(x){return x}function QB(x){return x.split('/').at(-1)}function lY(){return false}\nvar W={CortexStepStatus:{ERROR:7}};\nvar bZ=(({status:a,error:b,query:c,prefixOverride:d,numResults:f,supplementaryView:g,userInteraction:h,searchUrl:k})=>{var [l,m]=(0,A.useState)(!!b||a===W.CortexStepStatus.ERROR),{openUrlInSystemBrowser:n}=PC(),q=(0,A.useMemo)(()=>A.createElement(\"div\",{className:\"flex items-center gap-1 overflow-hidden text-sm group\"},A.createElement(\"span\",{className:\"text-muted-foreground shrink-0\"},A.createElement(MY,{text:d||(lY(a)?\"Searching\":\"Searched\")})),A.createElement(\"span\",{className:\"overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground\"},\nc),f>0&&A.createElement(\"span\",{className:\"shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none text-muted-foreground\"},f,\" \",f===1?\"result\":\"results\")),[a,c,f,d]),r=(0,A.useCallback)(v=>{v.stopPropagation();k&&n(k)},[k,n]),t=(0,A.useMemo)(()=>k?A.createElement(Uz,{variant:\"ghost\",size:\"icon\",\"aria-label\":\"Open search in external browser\",onClick:r},A.createElement(Z,{name:\"open_in_new\",className:\"h-3.5 w-3.5\"})):null,[k,r]),u=(0,A.useMemo)(()=>{if(!b)return null;var {userErrorMessage:v,\nerrorCodePrefix:w,errorParts:x}=Jq(b),y=x&&x.length>0?x.map((B,C)=>B.part.case===\"text\"?A.createElement(\"span\",{key:C},B.part.value):null):v;return A.createElement(\"div\",{className:\"inline-flex flex-row flex-wrap items-center gap-1 text-secondary-foreground\"},w,y)},[b]);return A.createElement(IY,{loading:lY(a),status:a,error:b,title:q,cta:t,supplementaryView:g||h?A.createElement(A.Fragment,null,h,A.createElement(\"div\",{className:\"text-secondary-foreground text-sm\"},g)):null,errorView:u,isExpanded:l,\nonToggle:()=>m(!l),hasSupplementaryView:!(!g&&!h)})});\nvar rOb={generic:{renderer:p=>A.createElement('div',null),isRendered:()=>true},systemMessage:{renderer:p=>A.createElement('div',null),isRendered:()=>true},mquery:{renderer:(({step:a,status:b,error:c})=>{var d=a.input,f=!!d&&d.targetDirectories.length==0&&d.targetFiles.length>0,{workspaceInfo:g}=HC(),h=(0,A.useMemo)(()=>(d?d.targetDirectories.map(l=>RB(l,g.homeDir,g.workspaceUris)):[]).join(\", \"),[d,g]),k=(0,A.useMemo)(()=>{var l=f?d?.targetFiles[0]:\nvoid 0;return A.createElement(\"div\",{className:\"flex items-center gap-1 overflow-hidden\"},l?A.createElement(JC,{className:\"text-muted-foreground\",fileUri:l},QB(l)):A.createElement(\"span\",{className:\"truncate text-muted-foreground\"},h),d?.goal&&A.createElement(A.Fragment,null,A.createElement(\"span\",{className:\"text-muted-foreground\"},\"for\"),A.createElement(\"span\",null,'\"',d.goal,'\"')))},[f,d?.targetFiles,d?.goal,h]);return A.createElement(bZ,{status:b,error:c,query:k,prefixOverride:lY(b)?\"Semantic searching\":\n\"Semantic searched\",numResults:a.numItemsScored})}),isRendered:()=>true}};\nfunction nativeRegistryLookup(step){var kind=step.step.case;return(kind?rOb[kind]:void 0)?.isRendered(step,false)}");
  f.install();
  const result = f.evaluate("(()=>{\n const props={status:3,step:{input:{targetDirectories:[],targetFiles:['file:///fixture/sample.txt'],goal:'fixture goal'},numItemsScored:2}};\n const nativeResult=rOb.mquery.renderer(props),rendered=bZ(nativeResult.props);\n function texts(value,out=[]){if(typeof value==='string'||typeof value==='number')out.push(String(value));else if(Array.isArray(value))value.forEach(child=>texts(child,out));else if(value?.props){texts(value.props.children,out);for(const key of ['title','content','prefix','trigger','cta','supplementaryView'])if(value.props[key]&&typeof value.props[key]==='object')texts(value.props[key],out)}return out}\n return{prefixOverride:nativeResult.props.prefixOverride,texts:texts(rendered)};\n})()");
  assert.equal(result.prefixOverride, '已完成语义搜索');
  assert.deepEqual(Array.from(result.texts), ['sample.txt','目标：','"','fixture goal','"','2',' 项结果']);
});

test('current native critique translates its overflow count without changing file paths', () => {
  const f = nativeFixture();
  f.evaluate("Object.assign(A,{useId:()=> 'fixture',useState:v=>[v,()=>{}]});\nfunction PC(){return{openUrlInSystemBrowser(){throw Error('unexpected external action')}}}\nfunction lY(){return false}function NY(){}function IY(){}function Uz(){}function Z(){}function Rz(){}\nvar rOb={generic:{renderer:p=>A.createElement('div',null),isRendered:()=>true},systemMessage:{renderer:p=>A.createElement('div',null),isRendered:()=>true},critique:{renderer:(({step:a,status:b,error:c})=>{var d=(0,A.useId)(),{openUrlInSystemBrowser:f}=PC(),[g,h]=(0,A.useState)(!1),k=a.args?.changelist??\"\";if(!k)return null;var l=`http://cl/${k}`,m=()=>{f(l)},n=lY(b);a=a.reply?.modifiedPaths??[];var q=a.length,r=!n&&q>0;k=A.createElement(\"div\",{\"data-tooltip-id\":d,className:\"flex-1 overflow-hidden\"},\nA.createElement(NY,{prefix:n?\"Analyzing\":\"Analyzed\",content:`cl/${k}`}));m=n?A.createElement(A.Fragment,null):A.createElement(Uz,{variant:\"ghost\",size:\"xs\",onClick:m,className:\"flex items-center gap-1 pl-1 text-sm font-normal\"},\"Open in Critique\",A.createElement(Z,{name:\"open_in_new\",size:14}));a=r?A.createElement(\"div\",{className:\"px-2 py-1\"},A.createElement(\"div\",{className:\"semi-bold\"},\"Modified files:\"),A.createElement(\"ol\",{className:\"w-full list-inside list-none\"},a.slice(0,20).map((t,u)=>{u=\n`${d}-path-${u}`;return A.createElement(A.Fragment,{key:t},A.createElement(\"li\",{className:\"flex w-full flex-row items-center justify-start gap-2\"},A.createElement(\"p\",{className:\"text-nowrap inline-block max-w-full overflow-x-clip text-ellipsis text-secondary-foreground\",\"data-tooltip-id\":u},t)),A.createElement(Rz,{id:u},A.createElement(\"div\",{className:\"max-w-md break-all\"},t)))}),q>20?A.createElement(\"li\",{key:\"more-paths\",className:\"truncate text-xs\"},\"...and \",q-20,\" more\"):null)):null;return A.createElement(IY,\n{loading:n,title:k,cta:m,supplementaryView:a,status:b,error:c,isExpanded:g,onToggle:()=>{h(!g)},hasSupplementaryView:!!a})}),isRendered:()=>true}};\nfunction nativeRegistryLookup(step){var kind=step.step.case;return(kind?rOb[kind]:void 0)?.isRendered(step,false)}");
  f.install();
  const texts = Array.from(f.evaluate("(()=>{\n const props={step:{args:{changelist:'fixture'},reply:{modifiedPaths:Array.from({length:23},(_,index)=>'/fixture/file'+index)}},status:3};\n const rendered=rOb.critique.renderer(props);\n function texts(value,out=[]){if(typeof value==='string'||typeof value==='number')out.push(String(value));else if(Array.isArray(value))value.forEach(child=>texts(child,out));else if(value?.props){texts(value.props.children,out);for(const key of ['title','content','prefix','trigger','cta','supplementaryView'])if(value.props[key]&&typeof value.props[key]==='object')texts(value.props[key],out)}return out}\n return texts(rendered);\n})()"));
  assert.ok(texts.includes('在 Critique 中打开'));
  assert.ok(texts.includes('已修改的文件：'));
  assert.ok(texts.join('').includes('…另有 3 项'));
  assert.ok(texts.includes('/fixture/file0'));
  assert.ok(!texts.includes('...and '));
  assert.ok(!texts.includes(' more'));
});


const matchedGeneralNativeSources = {"Boc": "function Boc({convoViewContainerRef:a,cascadeId:b}){var {getLexicalEditor:c,inputBoxRef:d}=(0,A.useContext)(WD),f=ij(),g=f.get(\"dragAndDrop\")?.requireShiftKey??!1,h=Pk(),k=Qk(oAa),l=Qk(pAa);k=b!=null&&k===b;var m=chc(),n=(0,A.useCallback)(async u=>{var v=e,w=e;try{let x=w(await v(m(u.flatMap(y=>y.scopeItem.case===\"file\"?[y.scopeItem.value.absoluteUri]:[]))));x&&d.current?.showUploadError?.(x)}finally{v()}},[m,d]),q=(0,A.useCallback)(u=>{var v=c();if(v){u=Array.isArray(u)?u:[u];for(let w of u)fO(v,\nw);n(u)}},[c,n]);(0,A.useEffect)(()=>{if(l&&l.cascadeId===b){var u=c();u&&C5a(u,l.absoluteUri);h(xr(null))}},[l,b,c,h]);var {isDraggedOver:r,isShiftRequiredAndMissing:t}=tqb(q,{requireShiftKey:g});uqb(q,a,f.get(\"dragAndDrop\")?.dropOnDragEndFallback??!1);f=c();f=d.current?.getInputCardElement?.()??f?.getRootElement();return(r||k)&&a.current&&f?A.createElement(A.Fragment,null,A.createElement(FMa,{style:Coc(a.current.getBoundingClientRect())}),(0,Aw.createPortal)(A.createElement(GMa,null,t&&A.createElement(\"span\",\n{className:\"flex items-center gap-1.5\"},\"Hold \",A.createElement(HMa,null),\" to add to Agent\")),f)):null}", "FJb": "({sourceTrajectoryStepInfo:a,schema:b})=>{var c=(0,A.useMemo)(()=>{var m={};for(let [n,q]of Object.entries(b.properties??{}))m[n]=yJb(q);return m},[b.properties]),[d,f]=(0,A.useState)(c),[g,h]=(0,A.useState)({}),k=(0,A.useCallback)((m,n)=>{f(q=>({...q,[m]:n}))},[]),l=EJb(a);a=(0,A.useCallback)(m=>{m.preventDefault();m={};var n=new Set(b.required||[]);for(let [r,t]of Object.entries(b.properties??{})){let u=r,v=t;var q=d[u];let w=q===void 0||q===null||q===\"\"||Array.isArray(q)&&q.length===0;\nif(n.has(u)&&w)m[u]=\"This field is required\";else if(!w)switch(v.type){case \"string\":\"minLength\"in v&&v.minLength!==void 0&&q.length<v.minLength&&(m[u]=`Minimum length is ${v.minLength}`);\"maxLength\"in v&&v.maxLength!==void 0&&q.length>v.maxLength&&(m[u]=`Maximum length is ${v.maxLength}`);if(\"pattern\"in v&&v.pattern!==void 0)try{(new RegExp(v.pattern)).test(q)||(m[u]=`Input must match ${v.pattern}`)}catch(x){console.warn(\"Invalid regex pattern in schema\",v.pattern,x)}break;case \"number\":case \"integer\":v.minimum!==\nvoid 0&&q<v.minimum&&(m[u]=`Minimum value is ${v.minimum}`);v.maximum!==void 0&&q>v.maximum&&(m[u]=`Maximum value is ${v.maximum}`);break;case \"array\":v.minItems!==void 0&&q.length<v.minItems&&(m[u]=`Select at least ${v.minItems} items`),v.maxItems!==void 0&&q.length>v.maxItems&&(m[u]=`Select at most ${v.maxItems} items`)}}h(m);Object.keys(m).length>0||l(\"accept\",d)},[l,d,b]);c=(0,A.useCallback)(()=>{l(\"decline\")},[l]);return A.createElement(\"form\",{onSubmit:a,onClick:m=>m.stopPropagation(),className:\"flex flex-col gap-1\"},\nA.createElement(\"div\",{className:\"flex flex-col gap-2\"},Object.entries(b.properties??{}).map(([m,n])=>A.createElement(DJb,{key:m,propertyKey:m,property:n,updateValue:k,value:d[m],error:g[m]}))),A.createElement(\"div\",{className:\"flex items-center justify-end gap-4 pt-2\"},A.createElement(Uz,{variant:\"ghost\",size:\"xs\",type:\"button\",onClick:c},\"Decline\"),A.createElement(Uz,{variant:\"primary\",type:\"submit\",size:\"xs\"},\"Submit\")))}", "DJb": "({propertyKey:a,property:b,value:c,updateValue:d,error:f})=>A.createElement(\"div\",null,A.createElement(\"div\",{className:\"pb-0.5\"},A.createElement(xJb,{property:b})),(()=>{switch(b.type){case \"array\":return\"items\"in b&&(b.items?.enum||b.items?.anyOf)?A.createElement(AJb,{key:a,name:a,schema:b,value:c||[],onChange:g=>d(a,g)}):null;case \"string\":return\"enum\"in b||\"oneOf\"in b?A.createElement(zJb,{key:a,name:a,schema:b,value:c,onChange:g=>d(a,g)}):A.createElement(CJb,{key:a,name:a,schema:b,value:c,\nonChange:g=>d(a,g)});case \"number\":case \"integer\":return A.createElement(BJb,{key:a,name:a,schema:b,value:c,onChange:g=>d(a,g)});case \"boolean\":return A.createElement(wJb,{key:a,name:a,schema:b,value:c,onChange:g=>d(a,g)});default:return null}})(),f&&A.createElement(\"p\",{className:\"text-red-500 text-xs pl-1\"},f))", "Tbc": "function Tbc({projectManagementService:a,sidebarDropdownEntrypoints:b}){var c=ij(),d=c.get(\"enableStandaloneConversations\")??!1,f=c.get(\"currentWorkspace\")?.workspaceUri,g=Rk().useOpenSettings(),{showPseudoProject:h,isPseudoProjectSelected:k,pseudoProjectLabel:l,selectPseudoProject:m}=uAb(f),n=Pk(),q=GE(),[r,t]=(0,A.useState)(!1),[u,v]=(0,A.useState)(\"\"),w=c.get(\"projectsCustomizations\"),x=w?.renameProjectsToWorkspaces??!1,y=x?\"workspaces\":\"projects\",B=w?.projectSearchPlaceholder??(x?\"Search Recent Workspaces\":\n\"Search Projects\"),C=Gbc(),D=Hbc(),E=Ibc(),G=(0,A.useCallback)(()=>{n(Dr(!1));n(Fr(!1));q(mg.PROJECT_SELECT_EXISTING,\"existing_project_button\");D();t(!1)},[D,q,n]),F=(0,A.useCallback)(()=>{n(Dr(!1));n(Fr(!1));q(mg.PROJECT_SELECT_SCRATCH,\"scratch_project_button\");C();t(!1)},[C,q,n]),H=(0,A.useCallback)(()=>{n(Dr(!1));n(Fr(!1));E();t(!1)},[E,n]),J=Qbc(),K=(0,A.useCallback)(()=>{n(Dr(!1));n(Fr(!1));q(mg.PROJECT_SELECT_EXISTING,\"existing_project_button\");J();t(!1)},[J,q,n]),L=DZ(),N=Jbc(),M=(0,A.useCallback)(()=>\n{n(Dr(!1));n(Fr(!1));N();t(!1)},[N,n]),O=Kbc(),P=(0,A.useCallback)(()=>{n(Dr(!1));n(Fr(!1));O();t(!1)},[O,n]),Q=X5(),R=yl(a.cloudEnabledProvider),T=(0,A.useCallback)(()=>{n(Dr(!1));n(Fr(!1));Q();t(!1)},[Q,n]),S=(0,A.useCallback)(()=>{n(Dr(!0));n(Fr(!1));t(!1)},[n]),U=Rqb(),V=(0,A.useContext)(GS)?.show,Y=c.get(\"abfsWorkspaceUi\")??!1,ea=!(c.get(\"vcsWorkspaceCreation\")?.entrypoints??!0);c=qH();var ba=oH(),na=ba===\"outside-of-project\",la=!na&&ba?ba:\"\",ia=yl(a.projectListStateProvider);ba=!!la&&!!ia?.projectIds?.includes(la);\nvar ca=Sbc({isMagicWorkspaceSelected:c,isPseudoProjectSelected:k,isStandalone:na,isSectionProjectValid:ba}),aa=$G(),da=A.useMemo(()=>{var Ta=new Map;for(let {summary:Qa}of aa){let sb=Qa.trajectoryMetadata?.projectId;sb&&!Ta.has(sb)&&Ta.set(sb,gl(Qa)||0)}return Ta},[aa]),pa=A.useMemo(()=>{var Ta=(ia?.projectIds??[]).filter(Qa=>Qa!==\"outside-of-project\");Ta.sort((Qa,sb)=>{Qa=da.get(Qa)||0;return(da.get(sb)||0)-Qa});if(la){let Qa=Ta.indexOf(la);Qa>-1&&(Ta.splice(Qa,1),Ta.unshift(la))}return Ta},[ia?.projectIds,\nla,da]),wa=yl(a.projectsStateProvider),Ga=A.useMemo(()=>{var Ta=new Map;for(let Qa of wa??[])Ta.set(Qa.project.id,Qa.project.name||Qa.project.id);return Ta},[wa]);c=A.useMemo(()=>{var Ta=u.trim();return Ta?pa.map(Qa=>({id:Qa,label:Ga.get(Qa)??\"\"})).filter(Qa=>YV.filter(Ta,Qa)).map(Qa=>({id:Qa.id,score:YV.score(Ta,Qa).score})).sort((Qa,sb)=>sb.score-Qa.score).map(Qa=>Qa.id):pa},[pa,Ga,u]);na=pa.length>6;ba=ME(\"toggleProjectSelector\");var ra=(0,A.useId)();LE(w?.hideWorkspaceSelector?void 0:\"toggleProjectSelector\",\n()=>{t(Ta=>!Ta)});var ha=(w?.magicWorkspaceEnabled??!1)||d,oa=(w?.magicWorkspaceEnabled??!1)&&!d,qa=(0,A.useCallback)(()=>{w?.magicWorkspaceEnabled?S():(n(Dr(!1)),n(Fr(!1)),L(\"outside-of-project\"),t(!1))},[w?.magicWorkspaceEnabled,S,n,L]),ya=(0,A.useCallback)(async Ta=>{var Qa=e,sb=e;try{ca===\"project\"&&Ta===la&&ha?qa():(n(Dr(!1)),n(Fr(!1)),Ta&&Ta!==\"outside-of-project\"&&n(Gr(Ta)),L(Ta),t(!1),a&&Ta&&Ta!==\"outside-of-project\"&&sb(await Qa(a.enrichProject(Ta))))}finally{Qa()}},[ca,la,ha,qa,n,L,a]),\nua=(0,A.useMemo)(()=>{if(!b)return[];var Ta=b({handleStartExistingFlow:G,handleStartScratchFlow:F,handleStartQuickCitcSelection:H,handleStartMagicWorkspace:S,handleStartOsFolderPicker:K,handleStartCogWorkspace:M,handleStartAbfsWorkspace:Y?P:void 0,handleSelectProject:ya,handleStartCloudProject:T,isCloudEnabled:R,magicWorkspaceVcs:U,showQuickInputBox:V});return ea?Ta.filter(Qa=>!Qa.createsVcsWorkspace):Ta},[b,G,F,H,S,K,M,P,ya,T,Y,R,U,V,ea]),ma=(0,A.useCallback)(()=>{ca===\"pseudoProject\"&&ha?qa():(m(),\nt(!1))},[ca,ha,qa,m]),ta=a.getProjectStateProvider(la),sa=yl(ta);ta=ca===\"project\"&&(bX(sa)||cX(sa))?\"cloud\":\"folder\";var Aa=ca===\"project\"&&mX(sa),Ia=x?\"Select Workspace\":\"Select Project\";x=(()=>{switch(ca){case \"magicWorkspace\":return\"New Workspace\";case \"pseudoProject\":return l??Ia;case \"standalone\":return\"No Project\";case \"project\":return sa?.project?.name??Ia;case \"none\":return Ia}})();var Ja=ca===\"none\",{getLexicalEditor:La}=(0,A.useContext)(WD),Wa=TN(),Va=(0,A.useCallback)(()=>La()?.getRootElement()??\n!0,[La]);return w?.hideWorkspaceSelector?null:A.createElement(\"div\",{className:\"flex items-center gap-0.5\"},A.createElement(IR,{open:r,searchQuery:u,onSearchQueryChange:v,onOpenChange:Ta=>{t(Ta);Ta||v(\"\")}},A.createElement(JR,{asChild:!0},A.createElement(Uz,{variant:\"ghost\",size:\"sm\",\"data-testid\":\"project-selector-trigger\",\"data-tooltip-id\":ra,\"aria-label\":`Select project, current: ${x}`,className:vi(\"rounded-full max-w-[300px] w-fit select-none font-normal\",Ja?\"text-secondary-foreground\":\"text-foreground hover:text-foreground\")},\nca===\"magicWorkspace\"?A.createElement(Ul,{size:14,className:\"text-secondary-foreground shrink-0\"}):Aa?A.createElement(Z,{name:\"warning\",size:16,className:\"text-warning-foreground shrink-0\"}):(ca===\"pseudoProject\"||ca===\"project\")&&A.createElement(Z,{name:ta,size:16,className:\"shrink-0\",[\"data-project-icon\"]:ta}),A.createElement(\"span\",{className:\"truncate flex-1 min-w-0\"},x),A.createElement(Z,{name:\"keyboard_arrow_down\",size:14,className:\"shrink-0\"}))),A.createElement(KR,{pad:!1,className:\"border-border w-max min-w-[200px] max-w-[80vw] translate-x-0.5\",\nside:\"bottom\",align:\"start\",finalFocus:Wa?Va:void 0},na&&A.createElement(Zhb,{\"data-testid\":\"project-selector-search\",placeholder:B}),A.createElement($hb,{filter:!1},oa&&A.createElement(LR,{\"data-testid\":\"project-selector-new-workspace\",selected:ca===\"magicWorkspace\",onClick:S},A.createElement(Ul,{size:16,className:\"text-secondary-foreground shrink-0\"}),A.createElement(\"span\",{className:\"truncate flex-1 min-w-0\",title:tbc(U)},\"New Workspace (Do not use for PII/NTK data)\")),h&&A.createElement(LR,{\"data-testid\":\"project-selector-item\",\n\"data-project-name\":l??f,\"data-pseudo-project\":\"true\",selected:ca===\"pseudoProject\",className:\"group\",onClick:ma},A.createElement(Z,{name:\"folder\",size:16,className:\"shrink-0 w-4 h-4\"}),A.createElement(\"span\",{className:\"truncate flex-1 min-w-0\",title:l??f??void 0},l??f)),pa.length!==0||h?c.length===0&&u.trim()?A.createElement(\"div\",{className:\"text-xs px-2 py-2 text-muted-foreground\"},\"No matching \",y):c.map(Ta=>A.createElement(Rbc,{key:Ta,id:Ta,isSelected:ca===\"project\"&&Ta===la,onSelect:ya,projectManagementService:a,\nopenSettings:g})):A.createElement(\"div\",{className:\"text-xs px-2 py-2 text-muted-foreground\"},\"No \",y,\" found\")),d&&A.createElement(A.Fragment,null,A.createElement(PR,null),A.createElement(QR,null,ua.map((Ta,Qa)=>A.createElement(LR,{key:Qa,disabled:Ta.disabled,selected:Ta.selects&&Ta.selects===ca,onClick:Ta.onClick},Ta.icon,A.createElement(\"span\",{className:\"truncate flex-1 min-w-0\",title:Ta.tooltipText??Ta.label},Ta.label)))),A.createElement(PR,null),A.createElement(QR,null,A.createElement(LR,{selected:ca===\n\"standalone\",action:{icon:A.createElement(Z,{name:\"settings\",size:14}),label:\"Project Settings\",position:\"right\",showOnHover:!0,onClick:()=>{g({targetProjectId:\"outside-of-project\"})}},onClick:()=>ya(\"outside-of-project\")},A.createElement(Z,{name:\"folder_off\",size:16,className:\"text-secondary-foreground shrink-0 w-4 h-4\"}),A.createElement(\"span\",{className:\"truncate flex-grow min-w-0\"},\"No Project\")))))),A.createElement(Rz,{id:ra,place:\"top\"},Aa?A.createElement(\"div\",{className:\"text-xs max-w-[220px]\"},\n\"Google3 projects are being deprecated. Select a CitC workspace instead.\"):ca===\"magicWorkspace\"?A.createElement(\"div\",{className:\"text-xs\"},tbc(U),A.createElement(\"div\",null,\"Change VCS in General settings, under Advanced\")):A.createElement(\"div\",{className:\"text-xs\"},A.createElement(\"span\",null,\"Select Project\"),ba&&A.createElement(\"span\",{className:\"ml-1 opacity-50\"},ba))))}"};
const matchedGeneralUIStrings = {"elicitation-validation:required": "此字段为必填项", "elicitation-validation:minLength": "最少需要 {value} 个字符", "elicitation-validation:maxLength": "最多允许 {value} 个字符", "elicitation-validation:pattern": "输入必须匹配 {value}", "elicitation-validation:minimum": "最小值为 {value}", "elicitation-validation:maximum": "最大值为 {value}", "elicitation-validation:minItems": "至少选择 {value} 项", "elicitation-validation:maxItems": "最多选择 {value} 项", "project-selector:no-matching:projects": "未找到匹配的项目。", "project-selector:no-matching:workspaces": "未找到匹配的工作区。"};

test('native drag portal translates owned labels while preserving its portal and shortcut boundaries', () => {
  const f=nativeFixture();f.window.eval=source=>f.evaluate(source);
  f.evaluate(`
    var WD={},oAa={},pAa={},portalTarget={id:'native-input-target'},portalState={missingShift:true,portals:[]};
    var Aw={createPortal:function(children,containerInfo,key='native-portal-key') {
      const portal=Object.freeze({$$typeof:Symbol.for('react.portal'),children,containerInfo,key});
      portalState.portals.push(portal);return portal;
    }};
    var FMa=()=>null,GMa=()=>null,HMa=()=>null;
    var ij=()=>({get:()=>({requireShiftKey:true})}),Pk=()=>()=>{},Qk=()=>null,chc=()=>()=>{throw Error('no upload expected')},
      tqb=()=>({isDraggedOver:true,isShiftRequiredAndMissing:portalState.missingShift}),uqb=()=>{},Coc=value=>value;
    A.useContext=()=>({getLexicalEditor:()=>null,inputBoxRef:{current:{getInputCardElement:()=>portalTarget}}});
    A.useCallback=value=>value;A.useEffect=()=>{};
    var Boc=${matchedGeneralNativeSources.Boc};
  `);
  const createElement=f.window.A.createElement,createPortal=f.window.Aw.createPortal;
  const installed=f.install();assert.ok(installed.uiKeys.includes('Boc'));
  const props={convoViewContainerRef:{current:{getBoundingClientRect:()=>({left:0,top:0,width:10,height:10})}},cascadeId:'test'};
  const result=f.window.Boc(props),portal=result.props.children[1],native=f.window.portalState.portals[0];
  const label=portal.children.props.children.props.children,nativeLabel=native.children.props.children.props.children;
  assert.equal(label[0],'按住 ');assert.equal(label[2],' 添加到智能体');
  assert.equal(label[1],nativeLabel[1],'the native shortcut element is retained');
  assert.equal(portal.$$typeof,native.$$typeof);assert.equal(portal.key,native.key);
  assert.equal(portal.containerInfo,native.containerInfo);assert.equal(portal.containerInfo,f.window.portalTarget);
  assert.equal(portal.children.type,native.children.type);
  assert.equal(f.window.A.createElement,createElement);assert.equal(f.window.Aw.createPortal,createPortal,'native React owners are not patched');
  f.window.portalState.missingShift=false;f.window.portalState.portals.length=0;
  const unchanged=f.window.Boc(props).props.children[1];
  assert.equal(unchanged,f.window.portalState.portals[0],'an unchanged native portal is not recreated');
  assert.equal(f.window.portalState.portals.length,1);
});

test('native elicitation validation localizes only generated field errors and retains schema and answer data', () => {
  const f=nativeFixture({strings:matchedGeneralUIStrings});f.window.eval=source=>f.evaluate(source);
  const pattern='^Keep "$&"  \\d+\nNext$';
  const properties={
    required:{type:'string',title:'This field is required'},
    short:{type:'string',minLength:4},long:{type:'string',maxLength:8},pattern:{type:'string',pattern},
    lower:{type:'number',minimum:-2.5},upper:{type:'number',maximum:4.5},
    few:{type:'array',items:{enum:['a','b','c']},minItems:2},many:{type:'array',items:{enum:['a','b','c']},maxItems:2},
    raw:{type:'string',pattern:'expected-pattern'}
  };
  const values=Object.freeze({required:'This field is required',short:'a',long:'very long string',pattern:'Overview  /tmp/A  B',
    lower:-3,upper:5,few:Object.freeze([]),many:Object.freeze(['a','b','c']),raw:'Input must match expected-pattern'});
  const errors=Object.freeze({required:'This field is required',short:'Minimum length is 4',long:'Maximum length is 8',pattern:`Input must match ${pattern}`,
    lower:'Minimum value is -2.5',upper:'Maximum value is 4.5',few:'Select at least 2 items',many:'Select at most 2 items',raw:'Input must match a different raw pattern $&'});
  f.window.fieldValues=values;f.window.fieldErrors=errors;
  f.evaluate(`
    var fieldStateIndex=0,sourceFields=[];
    A.useMemo=read=>read();A.useCallback=value=>value;
    A.useState=()=>{const index=fieldStateIndex++;return [index===0?fieldValues:fieldErrors,()=>{}]};
    var EJb=()=>()=>{throw Error('no submission expected')},yJb=()=>'',Uz=()=>null;
    var xJb=()=>null,CJb=()=>null,BJb=()=>null,AJb=()=>null;
    var DJb=${matchedGeneralNativeSources.DJb};var FJb=${matchedGeneralNativeSources.FJb};
    var sourceCreateElement=A.createElement;
    A.createElement=(type,props,...children)=>{const value=sourceCreateElement(type,props,...children);if(type===DJb)sourceFields.push(value);return value;};
  `);
  const installed=f.install();assert.ok(installed.uiKeys.includes('FJb'));
  const schema=Object.freeze({type:'object',required:['required'],properties});
  const value=f.window.FJb({sourceTrajectoryStepInfo:{},schema});
  const fields=value.props.children[0].props.children,expected={required:'此字段为必填项',short:'最少需要 4 个字符',long:'最多允许 8 个字符',pattern:`输入必须匹配 ${pattern}`,
    lower:'最小值为 -2.5',upper:'最大值为 4.5',few:'至少选择 2 项',many:'最多选择 2 项',raw:errors.raw};
  fields.forEach((field,index)=>{
    const key=field.props.propertyKey,original=f.window.sourceFields[index];
    assert.equal(field.props.error,expected[key]);
    assert.equal(field.props.property,properties[key]);assert.equal(field.props.value,values[key]);
    assert.equal(field.props.updateValue,original.props.updateValue);assert.equal(field.key,original.key);
    const output=f.window.DJb(field.props);
    assert.equal(output.props.children[0].props.children.props.property,properties[key],'schema titles remain with their source');
    assert.equal(output.props.children[2].props.children,expected[key]);
  });
  assert.equal(properties.required.title,'This field is required');assert.equal(properties.pattern.pattern,pattern);
  assert.equal(f.window.fieldValues,values);assert.equal(f.window.fieldErrors,errors);
  const buttons=value.props.children[1].props.children;
  assert.equal(buttons[0].props.children,'拒绝');assert.equal(buttons[1].props.children,'提交');
});

test('native project search empty state covers both project and workspace labels', () => {
  const f=nativeFixture({strings:matchedGeneralUIStrings});f.window.eval=source=>f.evaluate(source);
  f.evaluate(`
    var stateIndex=0,noAction=()=>{},WD={},GS={},featureState={workspaces:false};
    A.useState=value=>[stateIndex++===1?'missing project':value,noAction];
    A.useMemo=read=>read();A.useCallback=value=>value;A.useId=()=>'native-id';
    A.useContext=context=>context===WD?{getLexicalEditor:()=>null}:{};
    var ij=()=>({get:key=>key==='projectsCustomizations'?{renameProjectsToWorkspaces:featureState.workspaces}:undefined}),
      Rk=()=>({useOpenSettings:()=>noAction}),uAb=()=>({showPseudoProject:false,isPseudoProjectSelected:false,selectPseudoProject:noAction});
    var Pk=()=>noAction,GE=()=>noAction,Gbc=()=>noAction,Hbc=Gbc,Ibc=Gbc,Qbc=Gbc,DZ=Gbc,Jbc=Gbc,Kbc=Gbc,X5=Gbc;
    var yl=value=>value,Rqb=()=>1,qH=()=>false,oH=()=>undefined,Sbc=()=> 'none',$G=()=>[],ME=()=>'',LE=noAction,TN=()=>false;
    var YV={filter:()=>false,score:()=>({score:0})};var vi=(...values)=>values.filter(Boolean).join(' ');
    var IR=noAction,JR=noAction,Uz=noAction,Z=noAction,KR=noAction,Zhb=noAction,$hb=noAction,LR=noAction,Ul=noAction,PR=noAction,QR=noAction,Rz=noAction;
    var Tbc=${matchedGeneralNativeSources.Tbc};
  `);
  const installed=f.install();assert.ok(installed.uiKeys.includes('Tbc'));
  const props={projectManagementService:{projectListStateProvider:{projectIds:['test-id']},projectsStateProvider:[{project:{id:'test-id',name:'No matching projects'}}],getProjectStateProvider:()=>undefined}};
  for(const workspaces of [false,true]) {
    f.window.stateIndex=0;f.window.featureState.workspaces=workspaces;
    const value=f.window.Tbc(props),labels=[];
    const visit=node=>{if(Array.isArray(node)){node.forEach(visit);return;}if(!node?.props)return;
      if(node.type==='div'&&node.props.className==='text-xs px-2 py-2 text-muted-foreground')labels.push(node.props.children);
      visit(node.props.children);};
    visit(value);assert.deepEqual(labels,[workspaces?'未找到匹配的工作区。':'未找到匹配的项目。']);
  }
  assert.equal(props.projectManagementService.projectsStateProvider[0].project.name,'No matching projects');
});


// Current native a2 -> L1b -> fD -> jRa.render. All services/Effects below
// are inert fixture stubs; tests render the native output without firing actions.
function catalogSidecarModalFixture(strings) {
  const f=nativeFixture({strings});
  f.evaluate(`
    var fixtureOwner='',fixtureSelected=null,fixtureEndpoints=[],fixtureActions=0,fixtureSets=0,fixtureNativeNodes=[];
    A.useState=initial=>[fixtureOwner==='sidecars'&&initial===null?fixtureSelected:typeof initial==='function'?initial():initial,()=>{fixtureSets++}];
    A.useMemo=fn=>fn();A.useCallback=fn=>fn;A.useRef=value=>({current:value});A.useEffect=()=>{};
    var vi=(...parts)=>parts.filter(Boolean).join(' '),Z=()=>null,Uz=()=>null,gD=()=>null,TPb=()=>null,I1b=()=>null,Rz=()=>null,F1b=()=>null,ZB=()=>null,M1=()=>null,c1=()=>null;
    var uv=()=>()=>{},ij=()=>({get:()=>undefined}),gC=()=>({copy:()=>{fixtureActions++}}),RZ=()=>{},UR=()=>fixtureEndpoints,yXb=()=>()=>{fixtureActions++};
    var tW=()=>'',qW=()=>'',Kz=id=>id??'modal-title',Py=()=>{},$C=()=>({store:{}});
    var Zw=(tag,props,options)=>A.createElement(tag,Object.assign({},props,...options.props));
    var W={SidecarStatus:{RUNNING:1,STOPPED:2,STARTING:3,ERRORED:4,BACKOFF:5},SidecarErrorSource:{MANAGER:1}};
    const rawCreate=A.createElement;
    A.createElement=function(type,props,...children){const node=rawCreate.call(A,type,props,...children);fixtureNativeNodes.push(node);return node;};
  `);
  f.evaluate("function e2b({catalogId:a,installDir:b,titleId:c,onUninstalled:d,onDisconnected:f,onPromptSelected:g,layout:h=\"page\",MarkdownRenderer:k}){var [l,m]=(0,A.useState)(\"overview\"),[n,q]=(0,A.useState)(void 0),{plugin:r,isLoading:t,error:u,refetch:v}=e0b(b??\"\"),{processingIds:w,installPlugin:x,uninstallPlugin:y,togglePlugin:B}=i0b(),C=Q1({togglePlugin:B,installPlugin:x}),D=C.requestTogglePlugin,E=C.requestInstallPlugin,{catalogEntry:G,pluginPreview:F,skillPreview:H,isLoading:J,isPreviewLoading:K,error:L}=\nT1b(a??r?.installedFrom?.id??\"\"),{plugin:N,refetch:M}=f0b(G),O=r??N,P=r?v:M,Q=t||J,R=u??L,T=!!O,S=O??F,U=c2(\"PLUGIN_INSTALL_BUTTON\",[\"click\"]),V=c2(\"PLUGIN_UNINSTALL_BUTTON\",[\"click\"]),{logInstall:Y,logUninstall:ea,logShare:ba}=P1(),{copy:na}=gC(),{isGoogleInternal:la}=uH().product,ia=l0b(O?.path,S?.sidecars),[ca,aa]=(0,A.useMemo)(()=>[ia.filter(Zb=>!!Zb.config?.hasWebUi),ia.filter(Zb=>!Zb.config?.hasWebUi)],[ia]),da=W1b({pluginName:O?.name,pluginPath:O?.path,pluginDisabled:O?.disabled,activeTab:l}),\n[pa,wa]=(0,A.useState)(null),[Ga,ra]=(0,A.useState)(null),[ha,oa]=(0,A.useState)(new Set),qa=T?sR(O):lR(G),ya=w.has(qa),ua=!!C.pluginUnderReview;!ua||n!==\"install\"&&n!==\"enable\"||q(void 0);var ma=!!O?.disabled,ta=n===\"enable\"&&!ua,sa=n===\"install\"&&!ua||!T&&ya,Aa=n===\"uninstall\"||n===void 0&&T&&ya,Ia=T&&!ma&&!O?.forceDisabled,Ja=ij(),La=Ja.get(\"pluginAuth\")??!1,Wa=La&&(Ja.get(\"mcpPluginAuth\")?.enabled??!1),{setupRequiredRows:Va,configuredRows:Ta,unstartedSpecs:Qa,specStatus:sb,live:Ob,refresh:Ha}=\nY1b({plugin:S,installed:T,installing:sa,uninstalling:Aa,disabled:ma||!!O?.forceDisabled,splitSetupRequired:!Wa}),Ma=(0,A.useCallback)(async(Zb,Bc)=>{var Rc=e,jd=e;try{jd(await Rc(Promise.all([Ha(Zb,Bc),P()])))}finally{Rc()}},[Ha,P]),Na=(0,A.useMemo)(()=>({specs:S?.mcpServers??[],live:Ob,specStatus:sb}),[S,Ob,sb]),{handleAuthorize:Za,handleSubmitAuthCode:$a,handleDisconnect:hb}=xib({onRefresh:Ma,onError:wa}),Fb=uv(),xb=(0,A.useCallback)(Zb=>{ra(null);P();Ha(!1,Zb).catch(Bc=>{Fb(ng.MCP_SERVER_RESTART_FAILED,\nBc);ra(`Error restarting ${Zb}: ${Lq(Bc)}`)})},[Ha,P,Fb]),Ab=(0,A.useCallback)(()=>{ra(null)},[]),Xb=$1b({plugin:O,active:Ia,restartServer:xb}),kc=Xb.configurableServerNames,eb=Xb.serversNeedingConfiguration,qb=Xb.serverUnderConfiguration,[ib,ab]=(0,A.useMemo)(()=>{if(eb.size===0)return[Va,Ta];var Zb=Bc=>eb.has(Bc.spec?.serverName??\"\");return[Va.filter(Bc=>!Zb(Bc)),[...Va.filter(Zb),...Ta]]},[Va,Ta,eb]),Bb=n!==void 0&&!ua||ya,Jb=H1(Bb),fc=(0,A.useRef)(\"\");Bb&&(fc.current=Aa?\"Removing...\":ta?\"Enabling...\":\n\"Adding...\");var [Cb,qc]=(0,A.useState)({visible:!1,needsSignIn:!1}),wd=(0,A.useContext)($B)?.setDefaultPluginAuthAccount,[Xd,Fd]=(0,A.useState)({}),[Ie,Gf]=(0,A.useState)(0),kf=S?sR(S):\"\";(0,A.useEffect)(()=>{var Zb=Cb.providerAccounts;Zb&&kf&&Fd(Bc=>{var Rc=[];for(let [jd,tb]of Zb){let Ua=`${kf}/${jd}`,Dc=Bc[Ua];if(!Dc)continue;let ne=tb.find(Jf=>Jf.isDefault)?.accountId;(Dc.accountId!==void 0?ne===Dc.accountId:ne!==Dc.fromAccountId)&&Rc.push(Ua)}if(Rc.length===0)return Bc;Bc={...Bc};for(let jd of Rc)delete Bc[jd];\nreturn Bc})},[Cb.providerAccounts,kf]);var Wf=(0,A.useCallback)((Zb,Bc,Rc,jd)=>{if(wd){var tb=`${Zb}/${Bc}`;Fd(Ua=>({...Ua,[tb]:{fromAccountId:jd,accountId:Rc}}));wd({plugin:Zb,provider:Bc,accountId:Rc}).then(()=>{Gf(Ua=>Ua+1)},Ua=>{Fd(Dc=>Dc[tb]?.accountId===Rc?{...Dc,[tb]:{fromAccountId:jd,error:Lq(Ua)}}:Dc)})}},[wd]),Te=(0,A.useMemo)(()=>{var Zb=new Map;if(!La)return Zb;var Bc=A.createElement(Uz,{variant:\"link\",size:\"custom\",className:\"text-xs\",onClick:()=>{m(\"accounts\")}},\"Accounts tab\"),Rc=()=>\n{m(\"accounts\")},jd=(tb,Ua)=>{var Dc=Cb.providerAccounts?.get(tb);if(!Dc)return null;var ne=Xd[`${kf}/${tb}`],Jf=Dc.find(zf=>zf.isDefault)?.accountId;return A.createElement(N0b,{accounts:Dc,switchingTo:ne?.accountId,busy:Ua||ne?.accountId!==void 0,error:ne?.error,onOpenAccounts:Rc,onSelectAccount:wd&&kf?zf=>{Wf(kf,tb,zf,Jf)}:void 0})};for(let tb of[...Va,...Ta]){let Ua=tb.spec;if(Ua)if(Ua.pluginAuthProvider){let Dc=jd(Ua.pluginAuthProvider,!1);Dc&&Zb.set(Ua.serverName,Dc)}else Wa&&tb.hasAuthToken&&\nf1b(tb)&&Zb.set(Ua.serverName,A.createElement(A.Fragment,null,\"To switch accounts, sign out in the \",Bc,\" and sign in again.\"))}if(sb===\"starting\")for(let tb of Qa){if(!tb.pluginAuthProvider)continue;(Bc=jd(tb.pluginAuthProvider,!0))&&Zb.set(tb.serverName,Bc)}return Zb},[La,Wa,Cb.providerAccounts,Va,Ta,Qa,sb,kf,wd,Xd,Wf]);if(G?.kind.case===\"skill\")return A.createElement(M0b,{skill:G,skillPreview:H,error:R,titleId:c,onUninstalled:d,layout:h,MarkdownRenderer:k});var Yc=c2b.filter(Zb=>d2b(Zb.id,S,ca.length,\naa.length,La&&Cb.visible,da.length)),lf=Yc.some(Zb=>Zb.id===l)?l:\"overview\",Tb=()=>{if(!S)return null;switch(lf){case \"overview\":return A.createElement(O1b,{plugin:S,uiExtensions:ca,otherSidecars:aa,contextProviders:da,isInstalled:T,MarkdownRenderer:k});case \"skills\":return A.createElement(N1b,{skills:S.skills,showPaths:T,MarkdownRenderer:k});case \"mcp\":return A.createElement(A.Fragment,null,pa&&A.createElement(\"div\",{className:\"mb-3\"},A.createElement(bS,{title:\"MCP Authentication Error:\",message:pa,\nonDismiss:()=>{wa(null)}})),Ga&&A.createElement(\"div\",{className:\"mb-3\"},A.createElement(bS,{title:\"MCP Restart Error:\",message:Ga,onDismiss:Ab})),ib.length>0&&A.createElement(\"div\",{className:\"mb-5\"},A.createElement(\"div\",{className:\"flex items-center gap-1.5 mb-1.5 px-3 text-sm font-semibold text-foreground\"},\"Setup required\",A.createElement(J1,{variant:\"muted\"},ib.length)),A.createElement(\"p\",{className:\"px-3 text-xs text-muted-foreground mb-2 leading-relaxed\"},ib.length===1?\"This server needs you to sign in before the agent can use its tools.\":\n\"These servers need you to sign in before the agent can use their tools.\"),A.createElement(K0b,{mcpStates:ib,expandedServers:ha,onExpandedChange:oa,onAuthorize:Za,onSubmitAuthCode:(Zb,Bc)=>{$a(Zb,Bc)},onRestart:xb,onConfigure:Xb.configure,configurableServerNames:kc,serversNeedingConfiguration:eb,hidePluginBadge:!0,serverNotes:Te})),(ab.length>0||Qa.length>0)&&A.createElement(\"div\",{className:ib.length>0?\"border-t border-border pt-5\":void 0},ib.length>0&&A.createElement(\"div\",{className:\"mb-2 px-3 text-sm font-semibold text-foreground\"},\n\"Configured servers\"),A.createElement(K0b,{mcpStates:ab,expandedServers:ha,onExpandedChange:oa,onAuthorize:Wa?void 0:Za,onSubmitAuthCode:Wa?void 0:(Zb,Bc)=>{$a(Zb,Bc)},onRestart:xb,onConfigure:Xb.configure,configurableServerNames:kc,serversNeedingConfiguration:eb,onDisconnect:Wa?void 0:Zb=>{hb(Zb)},hidePluginBadge:!0,serverNotes:Te}),Qa.length>0&&A.createElement(\"div\",{className:ab.length>0?\"mt-1\":void 0},A.createElement(A1b,{mcpServers:Qa,serverNotes:Te,statusLabel:a2b[sb],statusBusy:sb===\"starting\"||\nsb===\"stopping\"}))));case \"agents\":return A.createElement(U0b,{agents:S.agents,showPaths:T,MarkdownRenderer:k});case \"hooks\":return A.createElement(z1b,{hooksJson:S.hooksJson});case \"rules\":return A.createElement(E1b,{rules:S.rules,showPaths:T,MarkdownRenderer:k});case \"uiExtensions\":return A.createElement(a2,{sidecars:ca,isInstalled:T,type:\"extension\",pluginName:Ac});case \"sidecars\":return A.createElement(a2,{sidecars:aa,isInstalled:T,type:\"sidecar\",pluginName:Ac});case \"context-providers\":return A.createElement(t1b,\n{contextProviders:da});default:return null}},ub=!O&&!G;if(Q&&ub)return A.createElement(S1,{layout:h},A.createElement(T1,{noun:\"plugin\"}));if(R&&ub)return A.createElement(S1,{layout:h},A.createElement(\"div\",{role:\"alert\",className:\"mt-4 p-3 bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-md\"},R));if(ub)return A.createElement(S1,{layout:h},A.createElement(D0b,{noun:\"plugin\",id:b||a}));var Ac=O?.displayName||G?.displayName||O?.name||b||a||\"\",Qc=O?.description||G?.description||\n\"No description available.\",Zd=O?.logo||G?.logo,Gd=O?.version||O?.installedFrom?.version||G?.version||F?.version,$d=T?pR(O?.path):\"\",Je=nR(O?.path),Ke=T&&!Je,za=async Zb=>{var Bc=e,Rc=e;try{Y({id:lR(G),marketplace:G?.marketplace??\"\",kind:\"plugin\",surface:\"detail\"});q(\"install\");try{return Rc(await Bc(E(qa,Zb)))}finally{Rc(),q(void 0)}}finally{Bc()}},Ka=async Zb=>{var Bc=e,Rc=e;try{q(\"enable\");try{return Rc(await Bc(D(Zb,!0,{awaitReview:!0})))!==!1}finally{Rc(),q(void 0)}}finally{Bc()}},Ya=()=>{T?\n(ea({id:lR(G),marketplace:G?.marketplace??\"\",kind:\"plugin\",surface:\"detail\"}),q(\"uninstall\"),y(qa).then(Zb=>{Zb&&d?.()}).finally(()=>{q(void 0)})):za()},jb=()=>{if(!S||!Ia)return null;var Zb=S.accounts,Bc=S.authorizeUri;return Zb?.length?A.createElement(O0b,{accounts:Zb,authorizeUri:Bc,onAuthorize:Za,onDisconnect:Rc=>{hb(S.name,Rc)}}):S.authRequired?S.isAuthenticated?A.createElement(U1,{tone:\"success\",message:\"Account connected.\",action:{label:\"Disconnect\",onClick:()=>{hb(S.name).then(()=>{f?.()})}}}):\nA.createElement(U1,{tone:\"warning\",message:\"This plugin requires authentication before the agent can use its tools.\",action:{label:\"Authenticate\",onClick:()=>{S.authorizeUri&&Za(S.authorizeUri)}}}):ib.length>0&&lf!==\"mcp\"?A.createElement(U1,{tone:\"warning\",message:\"This plugin requires authentication before the agent can use its tools.\",action:{label:\"Set up authentication\",onClick:()=>{m(\"mcp\")}}}):null},zb=La&&Ia&&Cb.needsSignIn&&lf!==\"accounts\",Cc=Jb&&fc.current===\"Enabling...\",xc=Jb&&fc.current===\n\"Adding...\"?\"Adding...\":Cc?\"Enabling...\":void 0,Zc=O!==void 0&&ma&&!O.forceDisabled,yd=la&&G&&h!==\"modal\"?A.createElement(S1b,{link:b2b(G),onCopy:()=>{ba(lR(G),G?.marketplace??\"\")}}):null,Uc=A.createElement(A.Fragment,null,(!T||xc!==void 0||Zc)&&A.createElement(Uz,{ref:T?void 0:U,variant:xc?\"secondary\":\"primary\",size:\"sm\",disabled:t||xc!==void 0||!T&&!qa||T&&Bb,className:xc?\"disabled:opacity-100\":void 0,onClick:T?Zc?()=>{O&&Ka(O)}:void 0:Ya},t?\"Loading...\":xc??(T?\"Enable\":\"Add\")),(Ke||T)&&A.createElement(V1,\n{name:Ac,sources:Je?[{category:W.DiscoveryCategory.BUILTIN,source:$d}]:void 0,pluginDisabled:T?ma:void 0,onToggle:T&&O&&!O.forceDisabled?Zb=>{Zb?Ka(O):D(O,!1)}:void 0,copyablePath:$d,onCopyPath:na,canUninstall:Ke,onUninstall:Ya,disabled:t||Bb||Jb,busyLabel:Jb&&fc.current===\"Removing...\"?fc.current:void 0,uninstallVeRef:V,triggerSize:\"icon-lg\"})),zd=A.createElement(A.Fragment,null,yd,Uc);return A.createElement(S1,{layout:h},R&&A.createElement(\"div\",{role:\"alert\",className:\"mt-2 p-3 bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-md\"},\nR),A.createElement(E0b,{name:Ac,titleId:c,logo:Zd,badges:ma&&!Cc&&A.createElement(J1,{variant:\"muted\"},\"Disabled\"),subtitle:A.createElement(a0b,{entry:G}),actions:zd,description:Qc,layout:h}),t||K&&!S?A.createElement(T1,{noun:\"plugin\",underHeader:!0,layout:h}):S?A.createElement(\"div\",{className:vi(h===\"modal\"?\"mt-6\":\"mt-10\",\"flex flex-col gap-6\")},O?.forceDisabled&&A.createElement(\"div\",{className:\"p-3 rounded-md border border-error/30 bg-error/10 text-sm text-error flex items-center gap-2\"},A.createElement(Z,\n{name:\"block\",className:\"w-4 h-4 flex-shrink-0\"}),O.disabledReason||\"This plugin was force disabled.\"),jb(),zb&&A.createElement(U1,{tone:\"warning\",message:\"Sign in required.\",action:{label:\"Go to Accounts\",onClick:()=>{m(\"accounts\")}}}),S.suggestedPrompts&&S.suggestedPrompts.length>0&&A.createElement(R1b,{prompts:S.suggestedPrompts,skills:S.skills,logo:Zd,pluginName:Ac,isInstalled:T,isDisabled:ma||!!O?.forceDisabled||t||Bb||Jb||ua,onPromptSelected:g,onInstall:t||Bb||Jb||ua||!qa?void 0:()=>za({awaitReview:!0}),\nonEnable:!O||O.forceDisabled||t||Bb||Jb||ua?void 0:()=>Ka(O)}),A.createElement(\"div\",{className:\"flex flex-col gap-6\"},A.createElement(\"div\",{role:\"tablist\",\"aria-label\":\"Plugin details\",className:\"flex flex-wrap items-center gap-0.5\"},Yc.map(Zb=>{var Bc=lf===Zb.id,Rc=Zb.id===\"mcp\"&&(ib.length>0||eb.size>0)||Zb.id===\"accounts\"&&Cb.needsSignIn||Zb.id===\"context-providers\"&&da.some(jd=>jd.disabled);return A.createElement(\"button\",{key:Zb.id,type:\"button\",role:\"tab\",id:`plugin-detail-tab-${Zb.id}`,\"aria-selected\":Bc,\n\"aria-controls\":\"plugin-detail-tabpanel\",\"aria-label\":Rc?`${Zb.label}, setup required`:void 0,onClick:()=>{m(Zb.id)},className:`inline-flex items-center gap-1.5 cursor-pointer h-7 px-3 rounded-lg text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary select-none ${Bc?\"bg-secondary text-foreground\":\"text-muted-foreground hover:text-foreground\"}`},Zb.label,Zb.id===\"context-providers\"&&A.createElement(\"span\",{className:\"text-xs opacity-70\"},\"(\",da.length,\")\"),Rc&&\nA.createElement(\"span\",{\"aria-hidden\":\"true\",title:\"Setup required\",className:\"w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0\"}))})),A.createElement(\"div\",{id:\"plugin-detail-tabpanel\",role:\"tabpanel\",\"aria-labelledby\":`plugin-detail-tab-${lf}`,className:\"min-h-[350px]\"},Tb(),La&&S&&A.createElement(\"div\",{hidden:lf!==\"accounts\"},A.createElement(l1b,{pluginDir:sR(S),pluginEnabled:Ia,shown:lf===\"accounts\",refreshCount:Ie,pluginName:S.name,mcpServers:Na,hasMcpServers:Wa&&S.mcpServers.length>0,onStatusChange:qc}))))):\nA.createElement(\"div\",{className:vi(h===\"modal\"?\"mt-6\":\"mt-10\",\"rounded-lg border border-border/60 bg-muted/40 py-12 px-6 text-center\")},A.createElement(\"p\",{className:\"text-sm text-muted-foreground\"},\"Install this plugin to see the commands it adds, along with its skills, agents and MCP servers.\")),!t&&!!Gd&&A.createElement(\"footer\",{\"aria-label\":\"Plugin metadata\",\"data-testid\":\"plugin-detail-footer\",className:\"mt-10 pt-4 border-t border-border/60 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground\"},\nA.createElement(\"div\",{className:\"flex items-center gap-1.5\"},A.createElement(\"span\",{className:\"text-muted-foreground/70\"},\"Version\"),A.createElement(\"span\",{\"data-testid\":\"plugin-detail-footer-version\"},Gd))),A.createElement(N1,{flow:C}),qb&&A.createElement(eS,{key:qb.serverName,isOpen:!0,title:`Configure ${qb.serverName}`,description:\"Enter the configuration values this MCP server needs. Saving restarts the server with them.\",variables:qb.variables,initialValues:qb.initialValues,confirmLabel:\"Save\",\ndisableUntilChanged:!0,onSave:Xb.save,onClose:Xb.close}))}");
  f.evaluate("function a0b({entry:a}){a?.source?.source?.case===\"google3\"?a=(a=a.source.source.value.depotPath)?a.startsWith(\"//depot/\")?a.substring(8):a:\"\":a=\"\";return a?A.createElement(\"div\",{className:\"flex items-center gap-1 text-xs text-muted-foreground font-mono min-w-0\"},A.createElement(\"a\",{href:`http://cs/${a}`,target:\"_blank\",rel:\"noopener noreferrer\",title:a,className:\"truncate rounded-sm hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline transition-colors\"},\na),A.createElement(M1,{key:a,path:a})):null}");
  f.evaluate("function E0b({name:a,titleId:b,logo:c,badges:d,subtitle:f,actions:g,description:h,layout:k=\"page\"}){k=k===\"modal\";return A.createElement(\"div\",{className:\"flex flex-col gap-3\"},A.createElement(\"div\",{className:vi(\"flex items-center justify-between gap-3 min-w-0\",k&&\"pr-16\")},A.createElement(\"div\",{className:\"flex items-center gap-3 min-w-0\"},A.createElement(c1,{src:c,name:a,className:\"w-12 h-12 rounded-xl\",iconClassName:\"w-6 h-6 text-muted-foreground/60\"}),A.createElement(\"div\",{className:\"flex flex-col gap-0.5 min-w-0\"},\nA.createElement(\"div\",{className:\"flex items-center gap-3 min-w-0\"},A.createElement(\"h1\",{id:b,className:\"text-lg font-medium tracking-tight leading-tight text-foreground truncate min-w-0\"},a),d),f)),A.createElement(\"div\",{className:vi(\"flex items-center gap-1 flex-shrink-0\",k&&\"self-start\")},g)),h&&A.createElement(\"p\",{className:\"text-sm text-muted-foreground leading-relaxed\"},h))}");
  f.evaluate("function a2({sidecars:a,isInstalled:b,type:c=\"extension\",pluginName:d}){var [f,g]=(0,A.useState)(null),h=(0,A.useMemo)(()=>f?a.find(k=>k.sidecarId===f):null,[a,f]);return A.createElement(A.Fragment,null,A.createElement(\"div\",{\"data-testid\":`plugin-${c}-list`},a.map((k,l)=>{var m=M1b(k.sidecarId,k.config?.displayName)||(c===\"extension\"?`UI Extension ${l+1}`:`Automation ${l+1}`),n=k.config?.mode?.case===\"command\"?k.config.mode.value:void 0;n=k.config?.description||(c===\"sidecar\"?n:void 0)||k.sidecarId;\nm=A.createElement(A.Fragment,null,A.createElement(\"span\",{className:\"text-sm font-medium text-foreground flex-shrink-0\"},m),A.createElement(\"span\",{className:\"text-sm text-muted-foreground truncate\",title:n},n));return b?A.createElement(\"button\",{key:k.sidecarId||l,type:\"button\",onClick:()=>{b&&g(k.sidecarId)},title:n,className:\"w-full cursor-pointer px-3 py-1.5 text-left rounded-lg hover:bg-secondary transition-colors outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary flex items-baseline gap-2.5 min-w-0\",\n\"data-testid\":`sidecar-row-${k.sidecarId}`},m):A.createElement(\"div\",{key:k.sidecarId||l,title:n,className:\"flex items-baseline gap-2.5 min-w-0 rounded-lg px-3 py-1.5\",\"data-testid\":`sidecar-row-${k.sidecarId}`},m)})),h&&A.createElement(L1b,{isOpen:!0,onClose:()=>{g(null)},sidecar:h,pluginName:d,type:c}))}");
  f.evaluate("function M1b(a,b){if(b)return b;b=a.lastIndexOf(\"/\");return b===-1?a:a.slice(b+1)}");
  f.evaluate("function L1b({isOpen:a,onClose:b,sidecar:c,pluginName:d,type:f=\"extension\"}){var g=uv(),h=ij().get(\"extensibility\"),{copy:k}=gC(),[l,m]=(0,A.useState)(!1),[n,q]=(0,A.useState)(!1),r=c.config?.displayName||c.sidecarId,t=c.userConfig?.enabled??!0,u=c.status===W.SidecarStatus.RUNNING&&!!c.startTimeMs,v=J1b(c.status),[w,x]=(0,A.useState)(()=>Date.now());RZ(()=>{x(Date.now())},u&&a?1E3:null);var y=u?tW(Math.max(0,w-Number(c.startTimeMs))):\"\\u2014\",B=K1b(c),C=c.baseUrl||(c.webPort?`http://127.0.0.1:${c.webPort}`:\n\"\\u2014\"),D=f===\"extension\"||c.config?.hasWebUi?\"UI Extension (AuxPane)\":c.config?.mode?.case===\"builtin\"&&c.config?.mode?.value===\"schedule\"?\"Scheduled Task\":\"Automation\",E=UR(),G=yXb(),F=(0,A.useMemo)(()=>E.find(R=>R.sidecarId===c.sidecarId),[E,c.sidecarId]),[H,J]=(0,A.useState)([]),[K,L]=(0,A.useState)(!1),N=(0,A.useCallback)(async()=>{var R=e,T=e;try{if(a&&h?.getEvents){L(!0);try{let S=[...T(await R(h.getEvents(c.sidecarId)))].sort((U,V)=>Number(V.timestampMs)-Number(U.timestampMs));J(S)}catch{T()}finally{L(!1)}}else L(!1)}finally{R()}},\n[a,c.sidecarId,h]);(0,A.useEffect)(()=>{if(a&&h?.getEvents){var R=!1;L(!0);h.getEvents(c.sidecarId).then(T=>{R||(T=[...T].sort((S,U)=>Number(U.timestampMs)-Number(S.timestampMs)),J(T))}).catch(()=>{}).finally(()=>{R||L(!1)});return()=>{R=!0}}L(!1)},[a,c.sidecarId,c.status,c.startTimeMs,h]);var M=async()=>{var R=e,T=e;try{if(c&&h?.restartSidecar&&!n&&t){q(!0);try{T(await R(h.restartSidecar(c.sidecarId))),T(await R(N()))}catch(S){T(),g(ng.SIDECAR_RESTART_FAILED,S)}finally{q(!1)}}}finally{R()}},O=(0,A.useCallback)((R,\nT,S,U)=>h?.subscribeToLogs?h.subscribeToLogs(R,T,V=>{S(String(V))},U):()=>{},[h]),P=u&&!!F,Q=c.status===W.SidecarStatus.ERRORED||!!c.lastError;return A.createElement(A.Fragment,null,A.createElement(gD,{isOpen:a,onClose:b,className:\"max-w-2xl max-h-[85vh]\",innerContentClassName:\"!overflow-hidden flex flex-col min-h-0\"},A.createElement(\"div\",{\"data-testid\":\"plugin-sidecar-modal\",className:\"flex flex-col min-h-0 flex-1\"},A.createElement(\"div\",{className:\"pb-3 border-b border-border flex items-start justify-between gap-4 shrink-0\"},\nA.createElement(\"div\",{className:\"flex flex-col gap-0.5 min-w-0\"},A.createElement(\"div\",{className:\"flex items-center gap-2\"},A.createElement(fD,{className:\"text-sm font-semibold text-foreground leading-tight truncate\"},r),A.createElement(\"span\",{className:vi(\"inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0\",v.badgeClass)},A.createElement(\"span\",{className:vi(\"w-1.5 h-1.5 rounded-full\",v.dotClass)}),v.label)),A.createElement(\"div\",{className:\"flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono\"},\nA.createElement(Z,{name:\"folder\",size:14,className:\"text-muted-foreground shrink-0\"}),A.createElement(\"span\",{className:\"truncate\"},c.sidecarId))),A.createElement(\"div\",{className:\"flex items-center gap-1 shrink-0\"},A.createElement(TPb,{sidecar:c,isEnabled:t,isRestarting:n,onRestart:M,onViewLogs:()=>{m(!0)},onBeforeManagePermissions:b,triggerSize:\"icon-lg\",triggerClassName:\"text-muted-foreground hover:bg-secondary\",triggerTestId:\"plugin-sidecar-modal-kebab\"}),A.createElement(Uz,{variant:\"ghost\",size:\"icon-lg\",\nonClick:b,\"aria-label\":\"Close\",className:\"text-muted-foreground hover:text-foreground\"},A.createElement(Z,{name:\"close\",size:18})))),A.createElement(\"div\",{className:\"py-3.5 flex flex-col gap-5 overflow-y-auto flex-1 min-h-0\"},(P||Q)&&A.createElement(\"div\",{className:\"flex flex-col gap-3\"},P&&F&&A.createElement(\"div\",{\"data-testid\":\"sidecar-auxpane-callout\",className:\"flex items-center justify-between gap-3 p-3 rounded-xl border border-border bg-card text-xs\"},A.createElement(\"div\",{className:\"flex items-center gap-2.5 min-w-0\"},\nA.createElement(\"div\",{className:\"w-8 h-8 rounded-lg bg-blue-500/15 text-blue-500 flex items-center justify-center shrink-0\"},A.createElement(Z,{name:\"dock_to_right\",size:20})),A.createElement(\"div\",{className:\"min-w-0\"},A.createElement(\"div\",{className:\"font-medium text-foreground leading-tight\"},\"Side Pane UI Available\"),A.createElement(\"div\",{className:\"text-[11px] text-muted-foreground truncate\"},\"Stream and control \",r,\" directly in the side pane.\"))),A.createElement(\"div\",{className:\"flex items-center gap-1.5 shrink-0\"},\nA.createElement(Uz,{variant:\"secondary\",size:\"xs\",onClick:()=>{G(F);b?.()},className:\"font-medium\"},\"Open in Side Pane\"))),Q&&A.createElement(\"div\",{\"data-testid\":\"sidecar-error-banner\",className:\"flex items-center justify-between gap-3 p-3 rounded-xl border border-border bg-card text-xs\"},A.createElement(\"div\",{className:\"flex items-center gap-2.5 min-w-0\"},A.createElement(\"div\",{className:\"w-8 h-8 rounded-lg bg-red-500/15 text-red-500 flex items-center justify-center shrink-0\"},A.createElement(Z,\n{name:\"error\",size:20})),A.createElement(\"div\",{className:\"min-w-0\"},A.createElement(\"div\",{className:\"font-medium text-foreground leading-tight\"},c.errorSource===W.SidecarErrorSource.MANAGER?\"Manager Error\":\"Process Error\"),A.createElement(\"div\",{className:\"text-[11px] text-muted-foreground font-mono truncate\",title:c.lastError||\"Process exited with an error\"},c.lastError||\"Process exited with an error\"))),A.createElement(\"div\",{className:\"flex items-center gap-1.5 shrink-0\"},A.createElement(Uz,\n{variant:\"ghost\",size:\"xs\",onClick:()=>{m(!0)},className:\"text-muted-foreground hover:text-foreground font-normal\"},\"View Logs\"),A.createElement(Uz,{variant:\"secondary\",size:\"xs\",disabled:n||!t,onClick:M,className:\"font-medium\"},\"Retry\")))),A.createElement(\"div\",{className:\"border border-border rounded-xl divide-y divide-border overflow-hidden text-xs\"},A.createElement(\"div\",{className:\"flex items-center justify-between px-3.5 py-2 bg-muted/20\"},A.createElement(\"span\",{className:\"text-muted-foreground\"},\n\"Status\"),A.createElement(\"span\",{className:\"inline-flex items-center gap-1.5 text-foreground\"},A.createElement(\"span\",{className:vi(\"w-2 h-2 rounded-full\",v.dotClass)}),A.createElement(\"span\",null,v.label))),A.createElement(\"div\",{className:\"flex items-center justify-between px-3.5 py-2\"},A.createElement(\"span\",{className:\"text-muted-foreground\"},\"Type\"),A.createElement(\"span\",{className:\"text-foreground\"},D)),B&&A.createElement(\"div\",{className:\"flex items-center justify-between px-3.5 py-2 bg-muted/20\"},\nA.createElement(\"span\",{className:\"text-muted-foreground\"},\"Command\"),A.createElement(\"div\",{className:\"flex items-center gap-1.5 font-mono text-foreground bg-secondary px-2 py-0.5 rounded border border-border\"},A.createElement(\"span\",{className:\"truncate max-w-xs\"},B),A.createElement(\"button\",{type:\"button\",\"aria-label\":\"Copy command\",className:\"cursor-pointer text-muted-foreground hover:text-foreground inline-flex items-center\",onClick:()=>{k(B)},title:\"Copy command\"},A.createElement(Z,{name:\"content_copy\",\nsize:13})))),A.createElement(\"div\",{className:\"flex items-center justify-between px-3.5 py-2\"},A.createElement(\"span\",{className:\"text-muted-foreground\"},\"Uptime\"),A.createElement(\"span\",{className:\"font-mono text-foreground\"},y)),A.createElement(\"div\",{className:\"flex items-center justify-between px-3.5 py-2 bg-muted/20 gap-3\"},A.createElement(\"span\",{className:\"text-muted-foreground shrink-0\"},\"Host Endpoint\"),A.createElement(\"span\",{className:\"font-mono text-muted-foreground truncate max-w-sm\",\ntitle:C},C))),A.createElement(\"div\",{className:\"flex flex-col gap-2\"},A.createElement(\"div\",{className:\"flex items-center justify-between\"},A.createElement(\"span\",{className:\"text-xs font-semibold text-foreground\"},\"Recent Events\"),A.createElement(Uz,{variant:\"ghost\",size:\"xs\",onClick:()=>{m(!0)},className:\"font-normal text-muted-foreground hover:text-foreground\"},\"Full Logs\")),K&&H.length===0?A.createElement(\"div\",{className:\"min-h-[120px] p-4 border border-border rounded-xl flex flex-col items-center justify-center text-center gap-2 bg-muted/20 text-xs text-muted-foreground\"},\nA.createElement(ZB,{className:\"w-4 h-4 text-muted-foreground\"}),A.createElement(\"span\",null,\"Loading events...\")):H.length>0?A.createElement(\"div\",{className:\"flex flex-col gap-1.5\"},H.slice(0,5).map((R,T)=>{var S=qW(new Date(Number(R.timestampMs)));return A.createElement(\"div\",{key:`${R.timestampMs}-${T}`,className:\"p-2.5 rounded-lg bg-secondary/60 border border-border text-xs flex items-center justify-between gap-2\"},A.createElement(\"div\",{className:\"flex items-center gap-2 min-w-0\"},A.createElement(\"span\",\n{className:vi(\"w-1.5 h-1.5 rounded-full shrink-0\",R.error?\"bg-red-500\":\"bg-green-500\")}),A.createElement(\"div\",{className:\"truncate font-mono text-foreground\"},A.createElement(F1b,{payload:R.payload}))),S&&A.createElement(\"span\",{className:\"text-[10px] text-muted-foreground font-mono shrink-0\"},S))})):A.createElement(\"div\",{className:\"min-h-[120px] p-4 border border-border rounded-xl flex flex-col items-center justify-center text-center gap-1.5 bg-muted/20\"},A.createElement(\"div\",{className:\"text-xs font-medium text-foreground\"},\n\"No events recorded\"),A.createElement(\"p\",{className:\"text-[11px] text-muted-foreground max-w-sm\"},u?\"Events and stdout streams will appear here as they occur.\":f===\"sidecar\"?\"This automation is currently stopped. Events and stdout streams will appear here once started.\":\"This extension is currently stopped. Events and stdout streams will appear here once started.\"),!u&&A.createElement(Uz,{variant:\"secondary\",size:\"sm\",disabled:n||!t,onClick:M,className:\"mt-1\"},f===\"sidecar\"?\"Start Automation\":\"Start Extension\")))),\nA.createElement(\"div\",{className:\"pt-3 border-t border-border flex items-center justify-between text-xs shrink-0\"},d?A.createElement(\"span\",{className:\"text-muted-foreground\"},\"Managed by plugin\",\" \",A.createElement(\"strong\",{className:\"text-foreground font-semibold\"},d)):A.createElement(\"span\",null),A.createElement(\"div\",{className:\"flex items-center gap-2\"},A.createElement(Uz,{variant:\"outline\",size:\"sm\",onClick:b},\"Close\"),A.createElement(Uz,{variant:\"secondary\",size:\"sm\",disabled:n||!t,onClick:M,\nclassName:\"gap-1.5 font-medium\"},n?A.createElement(ZB,{size:15}):A.createElement(Z,{name:u?\"refresh\":\"play_arrow\",size:15}),A.createElement(\"span\",null,u?\"Restart\":\"Start\")))))),A.createElement(I1b,{isOpen:l,sidecarId:c.sidecarId,onClose:()=>{m(!1)},subscribeToLogs:O,listLogs:h?.listLogs}))}");
  f.evaluate("function J1b(a){switch(a){case W.SidecarStatus.RUNNING:return{label:\"Running\",dotClass:\"bg-green-500\",badgeClass:\"bg-green-500/10 text-green-600 dark:text-green-400\"};case W.SidecarStatus.STARTING:return{label:\"Starting\",dotClass:\"bg-blue-500\",badgeClass:\"bg-blue-500/10 text-blue-600 dark:text-blue-400\"};case W.SidecarStatus.STOPPED:return{label:\"Stopped\",dotClass:\"bg-neutral-400\",badgeClass:\"bg-neutral-500/10 text-neutral-500\"};case W.SidecarStatus.ERRORED:return{label:\"Error\",dotClass:\"bg-red-500\",\nbadgeClass:\"bg-red-500/10 text-red-600 dark:text-red-400\"};case W.SidecarStatus.BACKOFF:return{label:\"Backoff\",dotClass:\"bg-amber-500\",badgeClass:\"bg-amber-500/10 text-amber-600 dark:text-amber-400\"};default:return{label:\"Unknown\",dotClass:\"bg-neutral-400\",badgeClass:\"bg-neutral-500/10 text-neutral-500\"}}}");
  f.evaluate("function K1b(a){if(a.config?.mode?.case===\"command\")return[a.config.mode.value,...(a.config.args??[])].filter(Boolean).join(\" \")}");
  f.evaluate("var fD=({children:a,className:b})=>A.createElement(jRa,{className:vi(\"font-medium text-foreground text-md\",b)},a);");
  f.evaluate("var jRa={render:function(a,b){var {render:c,className:d,style:f,id:g,...h}=a,{store:k}=$C(),l=Kz(g);Py(k,\"titleElementId\",l);return Zw(\"h2\",a,{ref:b,props:[{id:l},h]})}};");
  return f;
}
function catalogModalNodes(value,predicate,out=[]) {
  if(Array.isArray(value)){value.forEach(child=>catalogModalNodes(child,predicate,out));return out;}
  if(!value||value.$$typeof!==Symbol.for('react.element'))return out;
  if(predicate(value))out.push(value);catalogModalNodes(value.props.children,predicate,out);return out;
}
function catalogModalRender(f,props) {
  f.window.fixtureOwner='sidecars';f.window.fixtureSelected=props.sidecars[0].sidecarId;f.window.fixtureNativeNodes.length=0;
  const list=f.window.a2(props),modal=list.props.children[1];
  const rawModal=f.window.fixtureNativeNodes.find(node=>node.type===f.window.L1b);
  f.window.fixtureOwner='modal';const view=f.window.L1b(modal.props);
  const title=catalogModalNodes(view,node=>node.type===f.window.fD)[0],primitive=f.window.fD(title.props),h2=f.window.jRa.render(primitive.props,null);
  const callout=catalogModalNodes(view,node=>node.type==='div'&&node.props.className==='text-[11px] text-muted-foreground truncate')[0];
  return {list,modal,rawModal,view,h2,callout};
}

test('official sidecar selected modal carries display scope through the current native title and callout',()=>{
  const id='antigravity-plugins-official/plugin/science',name='Biomolecular Structure Viewer',translated='生物分子结构查看器',
    key=`marketplace:${id}:sidecar-name:${name}`,f=catalogSidecarModalFixture({[key]:translated});
  const originalList=f.window.a2,originalModal=f.window.L1b,adapters=f.install();
  const config=Object.freeze({displayName:name,description:'Interactive 3D biomolecular structure viewer via Mol*',hasWebUi:true}),
    sidecar=Object.freeze({sidecarId:'science/viewer',config,status:2}),props=Object.freeze({sidecars:Object.freeze([sidecar]),isInstalled:true,type:'extension',pluginName:'Science',chMarketplaceId:id});
  const stopped=catalogModalRender(f,props);
  assert.equal(stopped.modal.props.chMarketplaceId,id);assert.equal(stopped.h2.type,'h2');assert.equal(stopped.h2.props.children,translated);
  assert.equal(stopped.modal.props.sidecar,sidecar);assert.equal(stopped.modal.props.sidecar.config,config);
  assert.equal(stopped.modal.props.pluginName,'Science');assert.equal(stopped.modal.props.onClose,stopped.rawModal.props.onClose);
  assert.equal(stopped.rawModal.props.chMarketplaceId,undefined,'scope projection does not mutate the native element');
  const dialog=catalogModalNodes(stopped.view,node=>node.type===f.window.gD)[0];
  assert.equal(dialog.props.onClose,stopped.modal.props.onClose);
  assert.equal(catalogModalNodes(stopped.view,node=>node.props['aria-label']==='Close')[0].props.onClick,stopped.modal.props.onClose);
  assert.ok(catalogModalNodes(stopped.view,node=>node.props['aria-label']==='Close').length,'the explicit native Close aria-label stays unchanged');
  const runningSidecar=Object.freeze({...sidecar,status:1,startTimeMs:1}),runningProps={...props,sidecars:Object.freeze([runningSidecar])};
  f.window.fixtureEndpoints=[{sidecarId:sidecar.sidecarId}];
  const running=catalogModalRender(f,runningProps);
  assert.equal(running.h2.props.children,translated);
  assert.deepEqual(Array.from(running.callout.props.children),['直接在侧边窗格中查看和控制 ',translated,'。'],
    'the existing side-pane sentence projection and official metadata projection both apply');
  assert.equal(running.modal.props.sidecar,runningSidecar);assert.equal(config.displayName,name);
  const menu=catalogModalNodes(running.view,node=>node.type===f.window.TPb)[0],rawMenu=f.window.fixtureNativeNodes.find(node=>node.type===f.window.TPb);
  assert.equal(menu,rawMenu,'restart/permission/menu callbacks and their original sidecar payload are untouched');
  assert.equal(menu.props.sidecar,runningSidecar);assert.equal(f.window.fixtureActions,0);assert.equal(f.window.fixtureSets,0);
  adapters.setStrings({[key]:'更新后的查看器'});
  assert.equal(catalogModalRender(f,runningProps).h2.props.children,'更新后的查看器');
  f.uninstall()();assert.equal(f.window.a2,originalList);assert.equal(f.window.L1b,originalModal);
  assert.equal(catalogModalRender(f,props).h2.props.children,name);
});

test('sidecar modal display metadata stays original without an exact official catalog scope and source',()=>{
  const id='antigravity-plugins-official/plugin/science',name='Biomolecular Structure Viewer',
    f=catalogSidecarModalFixture({[`marketplace:${id}:sidecar-name:${name}`]:'生物分子结构查看器'});
  f.install();
  for(const [scope,displayName] of [[undefined,name],['third-party/plugin/science',name],['antigravity-plugins-official/plugin/firebase',name],[id,'Custom viewer name']]){
    const sidecar=Object.freeze({sidecarId:'science/viewer',config:Object.freeze({displayName,hasWebUi:true}),status:1,startTimeMs:1});
    f.window.fixtureEndpoints=[{sidecarId:sidecar.sidecarId}];
    const result=catalogModalRender(f,{sidecars:[sidecar],isInstalled:true,type:'extension',pluginName:'Science',chMarketplaceId:scope});
    assert.equal(result.h2.props.children,displayName);assert.equal(result.callout.props.children[1],displayName);
    assert.equal(result.modal.props.sidecar,sidecar);assert.equal(result.modal.props.pluginName,'Science');
  }
  assert.equal(f.window.fixtureActions,0);assert.equal(f.window.fixtureSets,0);
});


const osQuestionNativeSources = {"QGa": "function QGa(){var a=new Set,b=new Set,c,d=\"Jetski\",f={},g,h=l=>{var m=new Map,n=[];for(let [q,r]of l)l=r,m.set(l,q),n.push(l);MGa(a,n,q=>{var r=q.summary.workspaces?.[0]?.workspaceFolderAbsoluteUri,t=q.step.step?.metadata?.sourceTrajectoryStepInfo?.cascadeId||m.get(q.summary)||q.summary.trajectoryId;a:{q=q.step;var u=q.step;if(u){var v=jf(u).step;if(v.case){switch(v.case){case \"runCommand\":u=v.value;v=\"Requesting your permission in Terminal:\";u=`Command: ${u.commandLine}`;break;case \"openBrowserUrl\":u=\nv.value;v=\"Requesting your permission to open URL:\";u=`URL: ${u.url}`;break;case \"askQuestion\":u=v.value;let w=u.questions?.length??0;v=w>1?\"The agent has questions for you:\":\"The agent has a question for you:\";u=u.questions?.[0]?.question||(w>1?\"Click to respond to the questions.\":\"Click to respond to the question.\");break;default:v=u.requestedInteraction?.interaction,(u=v?.case===\"permission\"?v.value.resource?.target:void 0)?v=\"Requesting your permission:\":(v=\"Action requires your attention\",u=\n\"The agent is waiting for your input.\")}r={id:q.stepIndex.toString()+t,title:v,body:u,payload:{cascadeId:t,workspaceUri:r,type:\"request_action\"}};break a}}r=void 0}r&&(f.actionRequired&&g?.({soundFile:f.actionRequired}),c?.(r))})},k=l=>{for(let [m,n]of l){l=m;let q=n;q.latestExecutorTerminationReason!==W.ExecutorTerminationReason.USER_CANCELED&&(f.cascadeDone&&g?.({soundFile:f.cascadeDone}),c?.({id:`agent-finished-${l}-${Date.now()}`,title:d,body:q.summary?`Agent finished: ${q.summary}`:\"Agent finished\",\npayload:{cascadeId:l,type:\"request_action\",workspaceUri:void 0}}))}};return l=>m=>n=>{if(OGa.match(n)){var q=n.payload.appName,r=n.payload.soundFiles;let t=n.payload.playSound;c=n.payload.sendNotification;d=PGa(q);f=r;g=t;q=sl(l.getState());q=Object.entries(q).filter(([,u])=>!u.trajectoryMetadata?.sourceMetadata?.hideFromConversationList);NGa(b,q,[]);h(q);return m(n)}return pl.match(n)?(q=m(n),c&&(r=n.payload.deletes,n=n.payload.updates.filter(([,t])=>kna(t.source)&&!t.trajectoryMetadata?.sourceMetadata?.hideFromConversationList),\nk(NGa(b,n,r)),h(n)),q):m(n)}}", "MGa": "async function MGa(a,b,c){var d=e,f=e;try{let g=b.filter(h=>h.status===W.CascadeRunStatus.RUNNING||h.status===W.CascadeRunStatus.BUSY||h.hasActiveChildren);for(let h of g)for(let k of h.waitingSteps){let l=h.trajectoryId+\"-\"+k.stepIndex;a.has(l)||(a.add(l),f(await d(c({trajectoryStepId:l,step:k,summary:h}))))}}finally{d()}}", "NGa": "function NGa(a,b,c){var d=[];for(let [f,g]of b){b=f;let h=g;h.notFullyIdle?a.add(b):a.delete(b)&&(h.trajectoryMetadata?.parentConversationId||d.push([b,h]))}for(let f of c)a.delete(f);return d}", "PGa": "function PGa(a){var b=a.toLowerCase();return b.startsWith(\"antigravity\")?\"Antigravity\":b.startsWith(\"jetski\")?\"Jetski\":a}", "jf": "function jf(a){var b=hf.get(a);if(b)return b;if(a.step.case!==\"generic\"){let {toolAction:h,toolSummary:k}=yca(a.metadata);b=zca(a.metadata,h,k);b=b!==a.metadata?{...a,metadata:b}:a;hf.set(a,b);return b}var c=ef(a.step),{toolAction:d,toolSummary:f}=yca(a.metadata,c?.metadata,a.step.value.args);b=zca(a.metadata,d,f);var g=gf(a);if(!g||g===\"generic\")return b=b!==a.metadata?{...a,metadata:b}:a,hf.set(a,b),b;if(c&&c.step.case===g)return b={...a,metadata:b,step:c.step},hf.set(a,b),b;c=xca(a.step,g);if(!c)return b=\nb!==a.metadata?{...a,metadata:b}:a,hf.set(a,b),b;b={...a,metadata:b,step:{case:g,value:c}};hf.set(a,b);return b}", "cIc": "class{constructor(a,b,c){var d=window.nativeNotifications;this.JSC$18263_permissionRequestManager=a;this.storageService=b;this.JSC$18263_bridge=d;this.JSC$18263_stateStore=c;this.JSC$18263_bridge?.onClicked(f=>{f&&f.cascadeId&&Kuc(f.cascadeId)})}async sendNotification(a){if(this.JSC$18263_stateStore?.getEnableNotificationsForSpecialEvents()??!0){if(this.JSC$18263_bridge){if(!this.storageService.get(\"didAskForNotificationPermission\")&&this.JSC$18263_permissionRequestManager){this.storageService.store(\"didAskForNotificationPermission\",\n\"true\");let b=\"Choose whether to be notified when the agent needs your attention or completes a task.\";Oi()&&(b=\"Allow Gemini to notify you when the agent needs your attention or completes a task.\");dl(this.JSC$18263_permissionRequestManager,{id:\"notifications\",title:\"Notification Preferences\",message:b,actions:[{label:\"Dismiss\",style:\"outline\",onClick:()=>{this.JSC$18263_permissionRequestManager?.dismissPermission(\"notifications\")}},{label:\"Open Preferences\",style:\"primary\",onClick:()=>{this.openPreferences();\nthis.JSC$18263_permissionRequestManager?.dismissPermission(\"notifications\")}}]})}return this.JSC$18263_bridge.send({...a,silent:a.silent??C9(this.JSC$18263_stateStore)})}throw Error(\"Missing notifications functionality\");}}async playSound(a){var b=e,c=e;try{c(await b(bIc(a.soundFile,this.JSC$18263_stateStore)))}finally{b()}}async openPreferences(){if(this.JSC$18263_bridge)return this.JSC$18263_bridge.openSystemPreferences();throw Error(\"Missing notifications functionality\");}async clearNotifications(){}}"};

function osQuestionSourceFixture() {
  const f=nativeFixture();f.window.eval=source=>f.evaluate(source);
  f.evaluate(`
    var osCase={sent:[],raw:[]},e=value=>value;
    var W={CascadeRunStatus:{RUNNING:1,BUSY:2},ExecutorTerminationReason:{USER_CANCELED:1}};
    var OGa={match:action=>action.type==='os-init'},pl={match:action=>action.type==='os-updates'};
    var sl=state=>state.summaries,kna=()=>true;
    var hf=new WeakMap,yca=()=>({}),zca=metadata=>metadata,C9=()=>false;
  `+Object.entries(osQuestionNativeSources).map(([name,source])=>'var '+name+'='+source+';').join(''));
  f.evaluate(`
    var osService=Object.assign(Object.create(cIc.prototype),{
      JSC$18263_stateStore:{getEnableNotificationsForSpecialEvents:()=>true},storageService:{get:()=>true},
      JSC$18263_bridge:{send:notification=>{osCase.sent.push(notification);return Promise.resolve()}}
    });
    var osStore={getState:()=>({summaries:{}})};
    var osMiddleware=QGa()(osStore)(action=>action);
    osMiddleware({type:'os-init',payload:{appName:'Jetski',soundFiles:{},sendNotification:notification=>{
      osCase.raw.push(notification);return osService.sendNotification(notification)
    }}});
  `);
  const originalWaiting=f.window.MGa,originalMiddleware=f.window.QGa,originalSend=f.window.cIc.prototype.sendNotification;
  const installed=f.install();
  assert.ok(installed.hooks.some(hook=>hook.key==='MGa'&&hook.kind==='native-notification-request-source'));
  assert.notEqual(f.window.MGa,originalWaiting);
  assert.equal(f.window.QGa,originalMiddleware,'the middleware was created before replacing its dynamic waiting-step helper');
  return {...f,installed,originalWaiting,originalSend};
}
function osQuestionSummary(id,index,questions) {
  const metadata=Object.freeze({sourceTrajectoryStepInfo:Object.freeze({cascadeId:id}),marker:{identity:id}});
  const value=Object.freeze({questions:Object.freeze(questions.map(question=>Object.freeze({question})))});
  const cortex=Object.freeze({metadata,step:Object.freeze({case:'askQuestion',value})});
  const waiting=Object.freeze({stepIndex:index,step:cortex});
  return Object.freeze({trajectoryId:'trajectory-'+id,status:1,notFullyIdle:true,source:{},waitingSteps:Object.freeze([waiting]),
    trajectoryMetadata:{},workspaces:[{workspaceFolderAbsoluteUri:'file:///workspace'}]});
}
function osQuestionPayload(id,index,plural=false) {
  return {id:String(index)+id,title:plural?'The agent has questions for you:':'The agent has a question for you:',
    body:plural?'Click to respond to the questions.':'Click to respond to the question.',payload:{cascadeId:id,type:'request_action'}};
}

test('existing native QGa middleware picks up MGa question provenance after hot replacement without changing native records',async()=>{
  const f=osQuestionSourceFixture();
  const cases=[
    [[], '点击回答这个问题。'],[[''],'点击回答这个问题。'],[['','second question'],'点击回答这些问题。'],
    [['Click to respond to the question.'],'Click to respond to the question.'],
    [['Click to respond to the questions.','second question'],'Click to respond to the questions.'],[['  '],'  ']
  ];
  for(const [position,[questions,expected]] of cases.entries()) {
    const id='cascade-'+position,index=position+1,summary=osQuestionSummary(id,index,questions);
    f.window.osMiddleware({type:'os-updates',payload:{updates:[[id,summary]],deletes:[]}});
    await Promise.resolve();
    const raw=f.window.osCase.raw.at(-1),sent=f.window.osCase.sent.at(-1);
    assert.equal(sent.body,expected);assert.equal(raw.body,questions[0]||(questions.length>1?'Click to respond to the questions.':'Click to respond to the question.'));
    assert.equal(sent.payload,raw.payload,'the native notification metadata retains its identity');
    assert.equal(sent.payload.cascadeId,id);assert.equal(sent.id,String(index)+id);
    assert.equal(summary.waitingSteps[0].step.metadata.marker.identity,id);
    assert.deepEqual(Array.from(summary.waitingSteps[0].step.step.value.questions,question=>question.question),questions);
  }
  assert.equal(f.window.osCase.sent.length,cases.length,'each native callback delivers once');
  const outside=osQuestionPayload('cascade-2',3,true);await f.window.osService.sendNotification(outside);
  assert.equal(f.window.osCase.sent.at(-1).body,outside.body,'no source context survives the middleware callback');
  f.uninstall()();assert.equal(f.window.MGa,f.originalWaiting);assert.equal(f.window.cIc.prototype.sendNotification,f.originalSend);
});

test('nested native waiting callbacks restore the outer question scope and clear it on synchronous failure',async()=>{
  const f=osQuestionSourceFixture(),outer=osQuestionSummary('outer',21,['']),inner=osQuestionSummary('inner',22,['','second']);
  const pending=[];
  await f.window.MGa(new Set(),[outer],record=>{
    assert.equal(record.step,outer.waitingSteps[0]);assert.equal(record.summary,outer);
    const first=osQuestionPayload('outer',21);f.window.osService.sendNotification(first);
    assert.equal(f.window.osCase.sent.at(-1).body,'点击回答这个问题。');
    pending.push(f.window.MGa(new Set(),[inner],nested=>{
      assert.equal(nested.step,inner.waitingSteps[0]);assert.equal(nested.summary,inner);
      f.window.osService.sendNotification(osQuestionPayload('inner',22,true));
      assert.equal(f.window.osCase.sent.at(-1).body,'点击回答这些问题。');
      const mismatch=osQuestionPayload('inner',23,true);f.window.osService.sendNotification(mismatch);
      assert.equal(f.window.osCase.sent.at(-1).body,mismatch.body,'a different step ID cannot borrow the current scope');
      const wrongCount=osQuestionPayload('inner',22);f.window.osService.sendNotification(wrongCount);
      assert.equal(f.window.osCase.sent.at(-1).body,wrongCount.body,'singular metadata cannot borrow a plural source');
    }));
    f.window.osService.sendNotification(osQuestionPayload('outer',21));
    assert.equal(f.window.osCase.sent.at(-1).body,'点击回答这个问题。','the nested callback restores the outer scope synchronously');
  });
  await Promise.all(pending);
  const failure=new Error('source callback failure');
  await assert.rejects(f.window.MGa(new Set(),[outer],()=>{throw failure}),error=>error===failure);
  const outside=osQuestionPayload('outer',21);await f.window.osService.sendNotification(outside);
  assert.equal(f.window.osCase.sent.at(-1).body,outside.body,'finally also restores the context on an exception');
  const supplied=osQuestionSummary('supplied',24,['Click to respond to the question.']);
  await f.window.MGa(new Set(),[outer],()=>{
    pending.push(f.window.MGa(new Set(),[supplied],()=>{
      const message=osQuestionPayload('outer',21);f.window.osService.sendNotification(message);
      assert.equal(f.window.osCase.sent.at(-1).body,message.body,'a supplied question suspends the outer missing-question scope');
    }));
    f.window.osService.sendNotification(osQuestionPayload('outer',21));
    assert.equal(f.window.osCase.sent.at(-1).body,'点击回答这个问题。');
  });
  await Promise.all(pending);
  f.uninstall()();
});


// Current native section/header/leaf sources; only synthetic command data is used.
function backgroundCommandsFixture(strings = {}) {
  const f = nativeFixture({strings});
  f.evaluate(`
    var fixtureActions=0,fixtureBodyCalls=0,fixtureNodes=[];
    var fixtureCommand='Background Commands --title="Skills Used" $(printf synthetic)';
    A.useContext=()=>({collapsible:true,surface:'overview_panel'});
    var Z6={},Hi=(...parts)=>parts.filter(Boolean).join(' '),Z=()=>null,yoc=()=>null;
    var CF=()=>({logEvent:()=>{fixtureActions++}});
    var xoc=()=>({open:true,toggle:()=>{fixtureActions++},expanded:false,setExpanded:()=>{fixtureActions++}});
    function fixtureBody(props){fixtureBodyCalls++;return A.createElement('pre',{title:fixtureCommand},fixtureCommand);}
    const rawCreate=A.createElement;
    A.createElement=function(type,props,...children){const node=rawCreate.call(A,type,props,...children);fixtureNodes.push(node);return node;};
  `);
  f.evaluate("function $6({title:a,testId:b,sectionId:c,count:d,runningCount:f,Body:g,cascadeId:h,treeId:k,onOpened:l}){var {collapsible:m,surface:n=\"overview_panel\"}=A.useContext(Z6),{logEvent:q}=CF(),r=c??a.toLowerCase().replace(/\\s+/g,\"_\");c=f!==void 0&&(m||f>0);var {open:t,toggle:u,expanded:v,setExpanded:w}=xoc(d,f),x=m?t:!0,y=c?Math.max(0,(d??0)-f):0,z=c&&!v&&f>0,C=!c&&x&&d!==void 0&&d>4;f=c&&x&&f>0&&(v||y>0);return d===0?null:A.createElement(\"div\",{className:\"p-1\",\"data-testid\":b},A.createElement(X6,{label:a,\nbadge:d,onClick:m?()=>{q(\"overview_section_header_click\",{extra:{sectionId:r,surface:n,action:x?\"collapse\":\"expand\"}});u()}:void 0,trailing:m?A.createElement(yoc,{open:x}):void 0}),x&&g&&A.createElement(g,{cascadeId:h,treeId:k,onOpened:l,visibleCount:c||v?\"all\":4,hideIdle:z}),(C||f)&&A.createElement(\"button\",{onClick:()=>{var D=!v;q(\"overview_section_see_all_click\",{extra:{sectionId:r,surface:n,action:D?\"see_all\":\"see_less\"}});w(D)},className:\"text-xs text-muted-foreground hover:text-secondary-foreground cursor-pointer select-none pl-2 text-left transition-colors\"},\nv?\"See less\":\"See all\"))}");
  f.evaluate("function X6({onClick:a,...b}){var c=Hi(\"flex w-full items-center gap-1.5 rounded-lg border-none text-left outline-none focus-visible:ring-1 focus-visible:ring-ring\",\"bg-transparent h-6 pl-2 pr-1.5\",a?\"group cursor-pointer\":\"\"),d=A.createElement(uoc,{...b,labelClassName:Hi(\"text-xs opacity-50 font-medium select-none\",a?\"group-hover:opacity-100 transition-opacity\":\"\")});return a?A.createElement(\"button\",{type:\"button\",\"data-testid\":b.testId,onClick:a,className:c},d):A.createElement(\"div\",{\"data-testid\":b.testId,\nclassName:c},d)}");
  f.evaluate("function uoc({testId:a,icon:b,iconNode:c,label:d,labelClassName:f,badge:g,detail:h,detailClassName:k=\"shrink-0 text-xs text-muted-foreground\",trailing:l}){return A.createElement(A.Fragment,null,b?A.createElement(Z,{name:b,size:16,className:\"shrink-0\"}):c,A.createElement(\"span\",{className:f},d),g!==void 0&&A.createElement(\"span\",{className:\"text-[10px] font-medium opacity-50 bg-border rounded-full px-1.5 py-0.5 leading-none group-hover:opacity-100 transition-opacity\"},g),h&&A.createElement(\"span\",\n{\"data-testid\":a?`${a}-detail`:void 0,className:k},h),l)}");
  return f;
}

test('current native background-command section translates only its fixed header and preserves the badge and command body',()=>{
  const key='conversation-section:background_commands',f=backgroundCommandsFixture(),original=f.window.$6,adapters=f.install();
  assert.ok(adapters.uiKeys.includes('$6'),'the current writable section owner is installed');
  const tree=Object.freeze({kind:'cascadeId',cascadeId:'synthetic'}),onOpened=()=>{throw new Error('must not invoke a native action')};
  const props=Object.freeze({sectionId:'backgroundTasks',title:'Background Commands',count:18,runningCount:2,
    Body:f.window.fixtureBody,cascadeId:'synthetic',treeId:tree,onOpened});
  const view=f.window.$6(props),header=view.props.children[0],rawHeader=f.window.fixtureNodes.find(node=>node.type===f.window.X6);
  assert.equal(header.props.label,'后台命令');assert.equal(header.props.badge,18);
  assert.equal(header.props.onClick,rawHeader.props.onClick);assert.equal(header.props.trailing,rawHeader.props.trailing);
  assert.equal(rawHeader.props.label,'Background Commands','the native result is not mutated');
  const headerHost=f.window.X6(header.props),leaf=f.window.uoc(headerHost.props.children.props),leafChildren=leaf.props.children;
  assert.equal(leafChildren[1].props.children,'后台命令','the current native leaf span receives the translated title');
  assert.equal(leafChildren[2].props.children,18,'the count remains in its separate native badge');
  const body=view.props.children[1];assert.equal(body.type,f.window.fixtureBody);assert.equal(body.props.treeId,tree);assert.equal(body.props.onOpened,onOpened);
  assert.equal(f.window.fixtureBodyCalls,0,'the adapter does not render or inspect the body');
  assert.equal(f.window.fixtureBody(body.props).props.children,f.window.fixtureCommand,'synthetic command text and arguments remain verbatim');
  assert.equal(props.title,'Background Commands');assert.equal(props.count,18);assert.equal(f.window.fixtureActions,0);
  const custom=f.window.$6({...props,sectionId:'custom-section'});
  assert.equal(custom.props.children[0].props.label,'Background Commands','a supplied section with the same name stays unchanged');
  const renamed=f.window.$6({...props,title:'My command names'});
  assert.equal(renamed.props.children[0].props.label,'My command names');
  assert.equal(f.window.$6({...props,count:0}),null);
  adapters.setStrings({[key]:'后台命令测试'});assert.equal(f.window.$6({...props,count:20}).props.children[0].props.label,'后台命令测试');
  assert.equal(f.window.$6({...props,count:20}).props.children[0].props.badge,20);
  f.uninstall()();assert.equal(f.window.$6,original);assert.equal(f.window.$6(props).props.children[0].props.label,'Background Commands');
});


test('current timer renderInfo localizes only the Fired status suffix and preserves supplied content', () => {
  const f = nativeFixture();
  f.evaluate(`
    var Markdown = function(){ throw Error('Markdown must remain with its native renderer'); };
    var INb = function Media(){}, NNb = function Terminal(){}, HNb = function Agent(){}, ONb = function Step(){};
    var J = {CortexStepStatus:{CANCELED:3}};
    function bC(){return {renderers:{markdown:Markdown},cascadeContext:{debug:{debugMode:false}}};}
  `);
  const source = "function SZ({renderInfo:a,fallbackMarkdown:b,status:c}){var {renderers:d,cascadeContext:{debug:{debugMode:f}}}=bC(),g=d.markdown,h=c===J.CortexStepStatus.CANCELED;return a?.contentBlocks?.length?A.createElement(A.Fragment,null,a.contentBlocks.map((k,l)=>{if(!f&&k.block.case===\"step\"&&k.block.value.renderInfo?.hidden)return null;switch(k.block.case){case \"markdown\":return A.createElement(g,{key:l,disableMath:!0},k.block.value);case \"media\":return A.createElement(INb,{key:l,item:k.block.value});case \"terminal\":return A.createElement(NNb,\n{key:l,block:k.block.value});case \"agent\":return k=k.block.value,A.createElement(\"div\",{key:l,className:\"flex items-center min-h-8 text-sm\"},A.createElement(HNb,{conversationId:k.conversationId,title:k.title,subtitle:k.subtitle,canceled:h}));case \"step\":return A.createElement(\"div\",{key:l,className:\"-ml-2\"},A.createElement(ONb,{block:k.block.value}));default:return null}})):(a=a?.markdown||b)?A.createElement(g,{disableMath:!0},a):null}";
  f.evaluate(source);
  const original = f.window.SZ;
  const adapters = f.install();
  assert.ok(adapters.uiKeys.includes('SZ'));
  const prompt = '> Timer name: Status: Fired /tmp/Fired.js\n> **Status**: Fired';
  const markdown = prompt+'\n\n**Status**: Fired';
  const block = Object.freeze({case:'markdown',value:markdown});
  const timer = Object.freeze({icon:'timer',aggregationKey:'timers',title:'Status: Fired',
    titleParts:Object.freeze([{part:{case:'text',value:'Fired'}}]),
    contentBlocks:Object.freeze([Object.freeze({block})])});
  const props = Object.freeze({renderInfo:timer,status:2});
  const localized = f.window.SZ(props).props.children[0];
  assert.equal(localized.type,f.window.Markdown);
  assert.equal(localized.key,0);
  assert.equal(localized.props.disableMath,true);
  assert.equal(localized.props.children,prompt+'\n\n**状态**：已触发');
  assert.equal(timer.contentBlocks[0].block,block);
  assert.equal(block.value,markdown);
  assert.equal(timer.title,'Status: Fired');
  assert.equal(timer.titleParts[0].part.value,'Fired');
  assert.equal(props.status,2);
  const plain = f.window.SZ({...props,renderInfo:{...timer,icon:'task'}});
  assert.equal(plain.props.children[0].props.children,markdown,'non-timer Markdown stays supplied content');
  const pending = f.window.SZ({...props,renderInfo:{...timer,contentBlocks:[{block:{case:'markdown',value:'**Status**: Pending'}}]}});
  assert.equal(pending.props.children[0].props.children,'**Status**: Pending');
  const withoutPrompt = f.window.SZ({...props,renderInfo:{...timer,contentBlocks:[{block:{case:'markdown',value:'**Status**: Fired'}}]}});
  assert.equal(withoutPrompt.props.children[0].props.children,'**状态**：已触发');
  const callback = () => 'same callback',media=Object.freeze({caption:'Status: Fired',callback});
  const withMedia = f.window.SZ({...props,renderInfo:{...timer,contentBlocks:[{block},{block:{case:'media',value:media}}]}});
  assert.equal(withMedia.props.children[1].props.item,media);
  assert.equal(withMedia.props.children[1].props.item.callback,callback);
  adapters.setStrings({'Status':'计时器状态','timer-status:Fired':'已响铃'});
  assert.equal(f.window.SZ(props).props.children[0].props.children,prompt+'\n\n**计时器状态**：已响铃');
  f.uninstall()();
  assert.equal(f.window.SZ,original);
  assert.equal(f.window.SZ(props).props.children[0].props.children,markdown);
});


// Current native status-line popup/header/leaf sources with synthetic command data.
function backgroundTooltipFixture(strings = {}) {
  const f = nativeFixture({strings});
  f.evaluate(`
    var fixtureActions=0,fixtureBodyCalls=0,fixtureNodes=[];
    var fixtureCommand='Run Round5 --name="Background Commands" --limit=18';
    var Hi=(...parts)=>parts.filter(Boolean).join(' '),Z=()=>null;
    function aqc(){throw new Error('must not render the subagent list');}
    function Poc(props){fixtureBodyCalls++;return A.createElement('span',{title:fixtureCommand},fixtureCommand);}
    const rawCreate=A.createElement;
    A.createElement=function(type,props,...children){const node=rawCreate.call(A,type,props,...children);fixtureNodes.push(node);return node;};
  `);
  f.evaluate("function Wvc({cascadeId:a,treeId:b,sections:c,onOpened:d}){return A.createElement(\"div\",{className:\"divide-y divide-border\"},c.includes(\"subagents\")&&A.createElement(\"div\",{\"data-testid\":\"running-items-subagents\",className:\"p-1\"},A.createElement(X6,{label:\"Subagents\"}),A.createElement(aqc,{cascadeId:a,treeId:b,visibleCount:\"all\",hideIdle:!0,source:\"status_line_card\",onOpened:d})),c.includes(\"backgroundTasks\")&&A.createElement(\"div\",{\"data-testid\":\"running-items-tasks\",className:\"p-1\"},A.createElement(X6,\n{label:\"Background Commands\"}),A.createElement(Poc,{cascadeId:a,visibleCount:\"all\",hideIdle:!0,showPreview:!1,source:\"status_line_card\",onOpened:d})))}");
  f.evaluate("function X6({onClick:a,...b}){var c=Hi(\"flex w-full items-center gap-1.5 rounded-lg border-none text-left outline-none focus-visible:ring-1 focus-visible:ring-ring\",\"bg-transparent h-6 pl-2 pr-1.5\",a?\"group cursor-pointer\":\"\"),d=A.createElement(uoc,{...b,labelClassName:Hi(\"text-xs opacity-50 font-medium select-none\",a?\"group-hover:opacity-100 transition-opacity\":\"\")});return a?A.createElement(\"button\",{type:\"button\",\"data-testid\":b.testId,onClick:a,className:c},d):A.createElement(\"div\",{\"data-testid\":b.testId,\nclassName:c},d)}");
  f.evaluate("function uoc({testId:a,icon:b,iconNode:c,label:d,labelClassName:f,badge:g,detail:h,detailClassName:k=\"shrink-0 text-xs text-muted-foreground\",trailing:l}){return A.createElement(A.Fragment,null,b?A.createElement(Z,{name:b,size:16,className:\"shrink-0\"}):c,A.createElement(\"span\",{className:f},d),g!==void 0&&A.createElement(\"span\",{className:\"text-[10px] font-medium opacity-50 bg-border rounded-full px-1.5 py-0.5 leading-none group-hover:opacity-100 transition-opacity\"},g),h&&A.createElement(\"span\",\n{\"data-testid\":a?`${a}-detail`:void 0,className:k},h),l)}");
  return f;
}

test('current native status popup reuses the fixed background-command title without changing the command list',()=>{
  const key='conversation-section:background_commands',f=backgroundTooltipFixture(),original=f.window.Wvc,adapters=f.install();
  assert.ok(adapters.uiKeys.includes('Wvc'),'the current writable popup owner is installed');
  const tree=Object.freeze({kind:'cascadeId',cascadeId:'synthetic'}),onOpened=()=>{throw new Error('must not invoke a native action')};
  const props=Object.freeze({sections:Object.freeze(['subagents','backgroundTasks']),cascadeId:'synthetic',treeId:tree,onOpened});
  const popup=f.window.Wvc(props),section=popup.props.children[1],header=section.props.children[0],body=section.props.children[1];
  const rawSection=f.window.fixtureNodes.find(node=>node.props['data-testid']==='running-items-tasks'),rawHeader=rawSection.props.children[0];
  assert.equal(section.props['data-testid'],'running-items-tasks');assert.equal(header.props.label,'后台命令');
  assert.equal(rawHeader.props.label,'Background Commands','the native element remains untouched');
  const headerHost=f.window.X6(header.props),leaf=f.window.uoc(headerHost.props.children.props);
  assert.equal(leaf.props.children[1].type,'span');assert.equal(leaf.props.children[1].props.children,'后台命令');
  assert.equal(body,rawSection.props.children[1],'the command-list element keeps its original reference');
  assert.equal(body.type,f.window.Poc);assert.equal(body.props.cascadeId,props.cascadeId);assert.equal(body.props.treeId,undefined,'native command-list props do not include a tree ID');assert.equal(body.props.onOpened,onOpened);
  assert.equal(body.props.visibleCount,'all');assert.equal(body.props.hideIdle,true);assert.equal(body.props.showPreview,false);assert.equal(body.props.source,'status_line_card');
  assert.equal(f.window.fixtureBodyCalls,0,'the popup adapter never executes the command list');
  const command=f.window.Poc(body.props);assert.equal(command.props.children,f.window.fixtureCommand);assert.equal(command.props.title,f.window.fixtureCommand);
  assert.equal(popup.props.children[0].props.children[0].props.label,'Subagents','the unrelated section label is unchanged');
  assert.equal(f.window.Wvc({...props,sections:['subagents']}).props.children[1],false);
  assert.equal(props.sections[1],'backgroundTasks');assert.equal(f.window.fixtureActions,0);
  adapters.setStrings({[key]:'后台命令测试'});assert.equal(f.window.Wvc(props).props.children[1].props.children[0].props.label,'后台命令测试');
  f.uninstall()();assert.equal(f.window.Wvc,original);assert.equal(f.window.Wvc(props).props.children[1].props.children[0].props.label,'Background Commands');
});
