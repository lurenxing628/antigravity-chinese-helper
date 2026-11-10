import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {setImmediate as nextTurn} from 'node:timers/promises';

const source = fs.readFileSync(new URL('../runtime/swarm-renderer.js', import.meta.url), 'utf8');
const nodeTypes = {ELEMENT_NODE:1, TEXT_NODE:3, DOCUMENT_NODE:9};

class TextNode {
  nodeType = nodeTypes.TEXT_NODE;
  constructor(data) { this.data = data; }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  get isConnected() { return this.parentElement?.isConnected ?? false; }
}

// Match the adapter's UI selectors against a small, real-shaped document.
class Element {
  nodeType = nodeTypes.ELEMENT_NODE;
  constructor(tag, attributes = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.childNodes = [];
    this.append(...children);
  }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') child = new TextNode(child);
      child.parentElement = this; child.parentNode = this; this.childNodes.push(child);
    }
  }
  get children() { return this.childNodes.filter(node => node.nodeType === nodeTypes.ELEMENT_NODE); }
  get id() { return this.getAttribute('id') ?? ''; }
  get className() { return this.getAttribute('class') ?? ''; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.childNodes = []; this.append(String(value)); }
  get isConnected() { return this.parentElement?.isConnected ?? this.tagName === 'HTML'; }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); }
  contains(node) { return node === this || this.childNodes.some(child => child === node || child.contains?.(node)); }
  matches(selector) {
    return selector.split(',').some(branch => {
      const parts = branch.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
      const simple = (element, part) => {
        if (!element || element.nodeType !== nodeTypes.ELEMENT_NODE) return false;
        const tag = part.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && element.tagName !== tag.toUpperCase()) return false;
        for (const [, id] of part.matchAll(/#([\w-]+)/g)) if (element.id !== id) return false;
        for (const [, cls] of part.matchAll(/\.([\w-]+)/g)) if (!element.className.split(/\s+/).includes(cls)) return false;
        for (const [, key, value] of part.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
          if (!element.hasAttribute(key) || (value !== undefined && element.getAttribute(key) !== value)) return false;
        }
        return true;
      };
      let element = this, index = parts.length - 1;
      if (!simple(element, parts[index--])) return false;
      while (index >= 0) {
        const direct = parts[index] === '>';
        if (direct) index--;
        element = element.parentElement;
        while (element && !simple(element, parts[index])) {
          if (direct) return false;
          element = element.parentElement;
        }
        if (!element) return false;
        index--;
      }
      return true;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches?.(selector)) return node; return null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function fixture({protocol = 'plugin:', hostname = 'swarm--swarm_board-123', sidecar = {}} = {}) {
  const e = (tag, attrs, ...children) => new Element(tag, attrs, children);
  const elements = {
    title:e('title', {}, 'Swarm'),
    loading:e('div', {id:'loading', 'data-testid':'swarm-loading'}),
    board:e('div', {id:'board', 'data-testid':'swarm-board'}),
    empty:e('section', {id:'empty', 'data-testid':'swarm-empty-state'}),
    tab:e('button', {id:'tabbtn-feed', 'data-testid':'swarm-tab-feed', 'data-tab':'feed'}, 'Board'),
    search:e('input', {id:'f-search', placeholder:'Search', 'aria-label':'Search posts'}),
    live:e('span', {id:'live-label', class:'live-label'}, 'Live'),
    progress:e('b', {}, '2 of 5'),
    active:e('span', {class:'o2-pchip'}, '3 active'),
    acknowledgement:e('div', {id:'ov-ack'}, 'Last change: “Copy $& {text}”'),
    doneNote:e('span', {}, 'No posts yet'),
    memberNow:e('div', {class:'o2-mnow'}, 'Waiting for posts'),
    memberRole:e('div', {class:'o2-mrole'}, 'Task'),
    runNote:e('p', {class:'o2-runnote', title:'Waiting for posts'}, 'Waiting for posts'),
    retiredStatus:e('span', {class:'o2-mstat'}, 'Retired'),
    goal:e('b', {}, 'Waiting for the first post'),
    runningSummary:e('p', {class:'o2-runsum'}, 'Waiting for the first post.'),
    toast:e('div', {id:'toast'}, 'Copied “Copy $& {text}”. Paste it to the coordinator on its machine.'),
    member:e('span', {class:'o2-mauth'}, 'Live'),
    task:e('b', {class:'o2-runt'}, 'Board'),
    message:e('div', {class:'msg-body'}, 'Last change: “Copy $& {text}”'),
    raw:e('pre', {id:'raw', 'data-testid':'swarm-raw'}, 'Board'),
    narrator:e('div', {id:'ov-plain'}, 'Search'),
  };
  elements.loading.append(e('p', {class:'loading-caption'}, "Looking for this conversation's swarm…"));
  elements.liveRoot = e('span', {id:'live', title:'Updates automatically'}, elements.live);
  const doneRow = e('li', {}, e('div', {class:'o2-donem'}, elements.doneNote), e('span', {class:'o2-wchip', title:'@worker'}));
  const runRow = e('li', {class:'o2-runrow'}, elements.runNote, e('span', {class:'o2-wchip', title:'@active-worker'}));
  elements.board.append(e('h1', {id:'swarm-title'}, 'Live'), elements.tab, elements.search, elements.liveRoot,
    e('span', {class:'o2-progt'}, elements.progress), elements.active, elements.acknowledgement,
    e('ul', {}, doneRow, runRow), e('div', {class:'o2-mrow', 'data-open-member':'active-worker'}, elements.memberNow, elements.memberRole),
    e('div', {class:'o2-mrow retired', 'data-open-member':'worker'}, elements.retiredStatus),
    e('div', {class:'o2-goal'}, elements.goal), elements.runningSummary, elements.toast,
    elements.member, elements.task, e('div', {id:'feed'}, elements.message), elements.raw, elements.narrator);
  const html = e('html', {lang:'en'}, e('head', {}, elements.title), e('body', {}, elements.loading, elements.board, elements.empty));
  const document = {
    nodeType:nodeTypes.DOCUMENT_NODE, documentElement:html, body:html.children[1],
    querySelector:selector => html.matches(selector) ? html : html.querySelector(selector),
    querySelectorAll:selector => [...(html.matches(selector) ? [html] : []), ...html.querySelectorAll(selector)],
    getElementById:id => html.querySelector('#'+id),
  };
  Object.defineProperty(document, 'title', {get:() => elements.title.textContent, set:value => { elements.title.textContent = value; }});
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.connected = true; }
    disconnect() { this.connected = false; }
    takeRecords() { return []; }
  }
  const location = {protocol, hostname, pathname:'/'};
  const window = {document, location, sidecar, SwarmHive:{update() {}}}; window.window = window; document.defaultView = window;
  const install = vm.runInNewContext(source, {window, document, location, Node:nodeTypes,
    MutationObserver, queueMicrotask, setTimeout, clearTimeout});
  return {window, document, elements, observers, install,
    async mutate(records) { for (const observer of observers) if (observer.connected) observer.callback(records); await nextTurn(); }
  };
}

const dictionary = {strings:{
  'swarm-ui:Swarm':'协作群', 'swarm-ui:Board':'留言板', 'swarm-ui:Live':'实时',
  'swarm-ui:Reconnecting':'重新连接', 'swarm-ui:Search':'搜索', 'swarm-ui:Search posts':'搜索帖子',
  'swarm-ui:Updates automatically':'自动更新', 'swarm-ui:{count} active':'{count} 个正在执行',
  'swarm-ui:{done} of {total}':'{done} / {total}',
  'swarm-ui:Last change: “{text}”':'最近调整：“{text}”',
  'swarm-ui:No posts yet':'暂无留言',
  'swarm-ui:coordinator':'协调员',
  'swarm-ui:Task':'任务', 'swarm-ui:Tasks':'任务', 'swarm-ui:Waiting':'等待中',
  'swarm-ui:{name} to {recipients}':'{name} 发给 {recipients}',
  'swarm-ui:{name} · {status}':'{name} · {status}',
  'swarm-ui:Go to #{sequence} ({name})':'跳转到 #{sequence}（{name}）',
  'swarm-ui:To {name}':'发给 {name}',
  'swarm-ui:Waiting for posts':'等待留言', 'swarm-ui:its machine':'其所在机器',
  'swarm-ui:Copied “{text}”. Paste it to the coordinator on {machine}.':'已复制“{text}”。请粘贴给{machine}上的协调者。',
  'swarm-ui:Retired':'已退出', 'swarm-ui:Waiting for the first post':'等待第一条留言',
  'swarm-ui:Waiting for the first post.':'等待第一条留言。',
  'swarm-ui:Shared {source} board {id}':'共享 {source} 留言板 {id}',
  'swarm-ui:Error: {detail}':'错误：{detail}',
  'swarm-ui:board CLI not found ({command})':'找不到留言板命令（{command}）',
  'swarm-ui:; set {variable}':'；请设置 {variable}',
  'swarm-ui:swarm watcher exited':'协作群监听进程已退出',
  'swarm-ui:swarm watcher exited ({reason})':'协作群监听进程已退出（{reason}）',
}};

test('Swarm translation rejects an unrelated page before observing or changing content', () => {
  const f = fixture({hostname:'unrelated.invalid'});
  assert.equal(f.install(dictionary), null);
  assert.equal(f.document.title, 'Swarm');
  assert.equal(f.elements.tab.textContent, 'Board');
  assert.equal(f.observers.length, 0);
  const http = fixture({protocol:'http:'});
  assert.equal(http.install(dictionary), null, 'the matching hostname must belong to the plugin protocol');
  assert.equal(http.elements.tab.textContent, 'Board');
  assert.equal(http.observers.length, 0);
});

test('Swarm UI projection follows native updates, protects data, refreshes and restores cleanly', async () => {
  const f = fixture(), api = f.install(dictionary);
  assert.equal(api.version, '0.3.34');
  assert.equal(f.document.title, '协作群');
  assert.equal(f.elements.tab.textContent, '留言板');
  assert.equal(f.elements.tab.getAttribute('data-tab'), 'feed');
  assert.equal(f.elements.search.getAttribute('placeholder'), '搜索');
  assert.equal(f.elements.search.getAttribute('aria-label'), '搜索帖子');
  assert.equal(f.elements.liveRoot.getAttribute('title'), '自动更新');
  assert.equal(f.elements.live.textContent, '实时');
  assert.equal(f.elements.progress.textContent, '2 / 5');
  assert.equal(f.elements.active.textContent, '3 个正在执行');
  assert.equal(f.elements.acknowledgement.textContent, '最近调整：“Copy $& {text}”', 'curly-quote templates preserve captured text byte for byte');
  assert.deepEqual(['member','task','message','raw','narrator'].map(key => f.elements[key].textContent),
    ['Live','Board','Last change: “Copy $& {text}”','Board','Search'], 'same-word names, tasks, replies, Raw and narrator content stay native');
  assert.equal(f.document.getElementById('swarm-title').textContent, 'Live');

  const bodyPlaceholder = new TextNode('No posts yet');
  f.elements.message.append(bodyPlaceholder);
  f.window.SwarmHive.update({members:[{name:'worker',posts:0,status:'waiting'}],messages:[]});
  await nextTurn();
  assert.equal(f.elements.doneNote.textContent, '暂无留言', 'a completed-task note uses the native no-posts fallback');
  assert.equal(bodyPlaceholder.data, 'No posts yet', 'the same words in a reply remain supplied content');
  const controlPost = Object.freeze({seq:1,agent:'worker',control:Object.freeze({op:'create'}),text:'[channel] created #work'});
  const idleWorker = {name:'worker',posts:0,status:'waiting',activity:'Previous tool summary'};
  f.window.SwarmHive.update({members:[idleWorker],messages:[controlPost]});
  await nextTurn();
  assert.equal(f.elements.doneNote.textContent,'暂无留言','control events and idle activity do not replace the no-posts fallback');
  f.window.SwarmHive.update({members:[idleWorker],messages:[{seq:2,agent:'worker',text:'No posts yet'}]});
  await nextTurn();
  assert.equal(f.elements.doneNote.textContent,'No posts yet','an ordinary member post with the same words remains data');

  const activeWorker = {name:'active-worker',posts:0,status:'working',activityKind:'tool',activity:'Waiting for posts'};
  const retiredWorker = {name:'worker',posts:0,status:'waiting',killed:true};
  const coordinator = {name:'coordinator',role:'coordinator',local:false,conversation_id:'coordinator-conversation'};
  const leadCaption = new Element('p',{},['No posts yet']);
  const leadAlias = new Element('span',{class:'o2-mauth'},['@coordinator']);
  const leadRow = new Element('article',{class:'o2-mrow coord','data-open-member':'coordinator'},[leadAlias]);
  f.elements.board.append(new Element('div',{class:'o2-lb'},[leadCaption]),leadRow);
  f.window.SwarmHive.update({members:[activeWorker,retiredWorker,coordinator],messages:[]});
  await nextTurn();
  assert.equal(leadCaption.textContent,'暂无留言');
  assert.equal(leadAlias.textContent,'@协调员');
  assert.equal(leadRow.getAttribute('data-open-member'),'coordinator','the displayed role retains its native conversation key');
  assert.equal(f.elements.memberNow.textContent, '等待留言');
  assert.equal(f.elements.memberRole.textContent, '任务', 'the active member role uses the native missing-task fallback');
  assert.equal(f.elements.runNote.textContent, '等待留言');
  assert.equal(f.elements.runNote.getAttribute('title'), '等待留言');
  assert.equal(f.elements.retiredStatus.textContent, '已退出');
  assert.equal(f.elements.goal.textContent, '等待第一条留言');
  assert.equal(f.elements.runningSummary.textContent, '等待第一条留言。');
  assert.equal(f.elements.toast.textContent, '已复制“Copy $& {text}”。请粘贴给其所在机器上的协调者。');

  const baseSnapshot = {members:[activeWorker,retiredWorker,coordinator],messages:[]};
  const threadName = new Element('b',{},['Tasks']);
  f.elements.board.append(new Element('div',{'data-o2t':'t-other'},[new Element('span',{class:'o2-tht'},[threadName])]));
  const oldPlan = {tasks:{'active-worker':'Task',worker:'Retired'},goal:{title:'Old goal',line:'Old headline'},
    threads:[{id:'t-other',title:'Tasks',tasks:['active-worker']}]};
  const emptyView = {json:{version:1,workstreams:[]}};
  f.window.SwarmHive.update({...baseSnapshot,view:emptyView,plan:oldPlan});
  await nextTurn();
  assert.equal(f.elements.memberRole.textContent,'任务','a narrator view disables old plan task titles before choosing the fallback');
  assert.equal(f.elements.retiredStatus.textContent,'已退出');
  assert.equal(f.elements.goal.textContent,'等待第一条留言','the disabled plan also does not own the headline');
  assert.equal(threadName.textContent,'任务','the disabled plan also does not own a new view\'s fallback thread title');
  f.window.SwarmHive.update({...baseSnapshot,plan:oldPlan});
  await nextTurn();
  assert.equal(f.elements.memberRole.textContent,'Task','the active plan can supply a title equal to the fallback');
  assert.equal(f.elements.retiredStatus.textContent,'Retired','the active plan can supply a real retired member title');
  assert.equal(threadName.textContent,'Tasks','the active plan can supply a same-word thread title');

  const narrator = {name:'narrator',roleWorker:true,narrator:true};
  const goalView = {version:1,goal:{title:'Waiting for the first post',line:'An actual goal detail'},
    workstreams:[{id:'real-work',title:'Actual task',owners:['active-worker'],state:'active'}]};
  const narratorSnapshot = {...baseSnapshot,members:[...baseSnapshot.members,narrator],
    messages:[{seq:3,agent:'narrator',text:'Narrator notes'}],view:{json:goalView}};
  f.window.SwarmHive.update(narratorSnapshot);
  await nextTurn();
  assert.equal(f.elements.goal.textContent,'Waiting for the first post','the explicit goal title remains supplied content');
  assert.equal(f.elements.runningSummary.textContent,'等待第一条留言。','the separate missing-headline summary stays native UI despite a supplied goal');
  f.window.SwarmHive.update({...narratorSnapshot,view:{json:{...goalView,running_summary:'Waiting for the first post.'}}});
  await nextTurn();
  assert.equal(f.elements.runningSummary.textContent,'Waiting for the first post.','an explicit running summary remains data');

  const sourcePrefix = 'Shared Lab $& {source} board swarm-fixture';
  const sourceBadge = new Element('span',{class:'o2-src'},['Lab $& {source} · unavailable']);
  f.elements.board.append(sourceBadge);
  const command = '/tmp/board $& {command} (cli)';
  const rawError = 'native stderr with $& {reason}';
  for (const [error,expected] of [
    [`board CLI not found (${command}); set SWARM_CLI`,`找不到留言板命令（${command}）；请设置 SWARM_CLI`],
    ['swarm watcher exited (SIGTERM)','协作群监听进程已退出（SIGTERM）'],
    ['swarm watcher exited','协作群监听进程已退出'],
    [rawError,rawError],
  ]) {
    sourceBadge.setAttribute('title',sourcePrefix+'\nError: '+error);
    const sourceInfo = Object.freeze({label:'Lab $& {source}',error});
    f.window.SwarmHive.update({...baseSnapshot,source:sourceInfo});
    await nextTurn();
    assert.equal(sourceBadge.getAttribute('title'),'共享 Lab $& {source} 留言板 swarm-fixture\n错误：'+expected);
    assert.equal(sourceInfo.error,error,'only the watcher-owned tooltip copy changes; source data remains native');
  }

  const boardAuthor = new Element('span',{class:'msg-author'},['@coordinator']);
  const boardRecipient = new Element('span',{},['@fix-b1-r2']);
  const incomingAuthor = new Element('span',{class:'msg-author'},['@fix-b1-r2']);
  const incomingRecipient = new Element('span',{},['@coordinator']);
  const bodyMention = new Element('span',{class:'mention',title:'coordinator · Waiting'},['@coordinator']);
  const citation = new Element('button',{class:'seq-ref',title:'Go to #71 (coordinator)','data-seq-ref':'71'},['#71']);
  const body = new Element('div',{class:'msg-body'},['User text stays raw: ',bodyMention,' ',citation]);
  const outgoing = new Element('article',{class:'msg','data-seq':'71','aria-label':'coordinator to fix-b1-r2, 12:00'},[
    new Element('header',{class:'msg-head'},[boardAuthor,new Element('span',{class:'msg-to'},[boardRecipient])]),body]);
  const incoming = new Element('article',{class:'msg','data-seq':'72','aria-label':'fix-b1-r2 to coordinator, 12:01'},[
    new Element('header',{class:'msg-head'},[incomingAuthor,new Element('span',{class:'msg-to'},[incomingRecipient])])]);
  const systemMeta = new Element('span',{class:'sys-text',title:'#73 · coordinator · 12:02'},['coordinator created #main']);
  f.document.getElementById('feed').append(outgoing,incoming,new Element('div',{class:'msg msg-system','data-seq':'73'},[systemMeta]));
  const replayAuthor = new Element('span',{class:'msg-author'},['fix-b1-r2']);
  const replayRecipient = new Element('span',{},['@coordinator']);
  f.elements.board.append(new Element('div',{id:'replay-caption'},[
    new Element('div',{class:'msg-head'},[replayAuthor,new Element('span',{class:'msg-to'},[replayRecipient])])]));
  const waitingTarget = new Element('span',{class:'o2-mstat warn'},['→ @coordinator']);
  const graphName = new Element('text',{class:'node-label'},['coordina…']);
  const recipientOption = new Element('option',{value:'coordinator'},['To coordinator']);
  f.elements.board.append(waitingTarget,new Element('svg',{id:'graph'},[
    new Element('g',{class:'node','data-conv':'coordinator-conversation'},[graphName])]),
    new Element('select',{id:'f-mention'},[recipientOption]));
  const posted = Object.freeze([
    Object.freeze({seq:71,agent:'coordinator',mentions:Object.freeze(['fix-b1-r2']),text:'User text stays raw: @coordinator #71'}),
    Object.freeze({seq:72,agent:'fix-b1-r2',mentions:Object.freeze(['coordinator']),text:'A reply'}),
    Object.freeze({seq:73,agent:'coordinator',control:Object.freeze({type:'create'}),text:'[channel] coordinator created #main'})
  ]);
  const namedSnapshot = {members:[{...activeWorker,activityKind:'thinking'},retiredWorker,
    {...coordinator,owner:{label:'its machine'}},{name:'fix-b1-r2',role:'worker'}],messages:posted,
    plan:oldPlan,view:{json:{headline:'Waiting for the first post',workstreams:[
      {id:'retired-task',title:'Retired',owners:['worker'],state:'done'},
      {id:'active-task',title:'Task',owners:['active-worker'],state:'active',note:'Waiting for posts'},
    ]}}};
  f.window.SwarmHive.update(namedSnapshot);
  await nextTurn();
  assert.equal(f.elements.memberNow.textContent, 'Waiting for posts', 'thinking text remains activity data');
  assert.equal(f.elements.memberRole.textContent, 'Task', 'a supplied same-word task title remains data');
  assert.equal(f.elements.runNote.textContent, 'Waiting for posts');
  assert.equal(f.elements.runNote.getAttribute('title'), 'Waiting for posts');
  assert.equal(f.elements.retiredStatus.textContent, 'Retired', 'a same-word narrator task title remains supplied data');
  assert.equal(f.elements.goal.textContent, 'Waiting for the first post', 'a narrator headline is not a missing-post fallback');
  assert.equal(f.elements.runningSummary.textContent, 'Waiting for the first post.');
  assert.equal(f.elements.toast.textContent, '已复制“Copy $& {text}”。请粘贴给its machine上的协调者。', 'a real machine label remains verbatim');
  assert.deepEqual([boardAuthor.textContent,boardRecipient.textContent,incomingAuthor.textContent,incomingRecipient.textContent],
    ['@协调员','@fix-b1-r2','@fix-b1-r2','@协调员'], 'both Board header directions share the native member alias');
  assert.deepEqual([replayAuthor.textContent,replayRecipient.textContent],['fix-b1-r2','@协调员']);
  assert.equal(outgoing.getAttribute('aria-label'),'协调员 发给 fix-b1-r2, 12:00');
  assert.equal(incoming.getAttribute('aria-label'),'fix-b1-r2 发给 协调员, 12:01');
  assert.equal(bodyMention.getAttribute('title'),'协调员 · 等待中');
  assert.equal(citation.getAttribute('title'),'跳转到 #71（协调员）');
  assert.equal(systemMeta.getAttribute('title'),'#73 · 协调员 · 12:02');
  assert.equal(systemMeta.textContent,'coordinator created #main','the control message body stays supplied content');
  assert.equal(waitingTarget.textContent,'→ @协调员');
  assert.equal(graphName.textContent,'协调员','a clipped node label retains its proven member identity');
  assert.equal(recipientOption.textContent,'发给 协调员');
  assert.equal(recipientOption.getAttribute('value'),'coordinator');
  assert.equal(outgoing.getAttribute('data-seq'),'71');
  assert.equal(citation.getAttribute('data-seq-ref'),'71');
  assert.equal(body.textContent,'User text stays raw: @coordinator #71','authored mentions remain original message content');
  assert.equal(posted[0].agent,'coordinator');
  assert.equal(posted[1].mentions[0],'coordinator','snapshot identities and routing recipients remain untouched');

  replayAuthor.childNodes[0].data = 'coordinator';
  replayRecipient.childNodes[0].data = '@fix-b1-r2';
  await f.mutate([{type:'characterData',target:replayAuthor.childNodes[0]}, {type:'characterData',target:replayRecipient.childNodes[0]}]);
  assert.deepEqual([replayAuthor.textContent,replayRecipient.textContent],['协调员','@fix-b1-r2']);
  f.window.SwarmHive.update({...namedSnapshot,members:namedSnapshot.members.map(member => member.name === 'coordinator' ? {...member,role:'worker'} : member)});
  await nextTurn();
  assert.equal(boardAuthor.textContent,'@coordinator','an ordinary worker with the same name is not the default coordinator');
  assert.equal(incomingRecipient.textContent,'@coordinator');
  assert.equal(replayAuthor.textContent,'coordinator');
  assert.equal(graphName.textContent,'coordina…');
  f.window.SwarmHive.update(namedSnapshot);
  await nextTurn();

  const status = f.elements.live.childNodes[0];
  status.data = 'Reconnecting';
  const added = new Element('span', {class:'o2-pchip'}, ['5 active']);
  f.elements.board.append(added);
  f.elements.search.setAttribute('placeholder', 'Search');
  await f.mutate([{type:'characterData',target:status}, {type:'childList',target:f.elements.board,addedNodes:[added]},
    {type:'attributes',target:f.elements.search,attributeName:'placeholder'}]);
  assert.equal(f.elements.live.textContent, '重新连接');
  assert.equal(added.textContent, '5 个正在执行');
  assert.equal(f.elements.search.getAttribute('placeholder'), '搜索');

  api.refresh({strings:{...dictionary.strings, 'swarm-ui:Board':'公告板', 'swarm-ui:Search':'查找','swarm-ui:coordinator':'统筹员'}});
  assert.equal(f.elements.tab.textContent, '公告板');
  assert.equal(f.elements.search.getAttribute('placeholder'), '查找');
  assert.equal(f.elements.task.textContent, 'Board');
  assert.equal(boardAuthor.textContent,'@统筹员');
  assert.equal(incomingRecipient.textContent,'@统筹员');
  assert.equal(replayAuthor.textContent,'统筹员');
  assert.equal(bodyMention.getAttribute('title'),'统筹员 · 等待中');
  assert.equal(citation.getAttribute('title'),'跳转到 #71（统筹员）');
  assert.equal(body.textContent,'User text stays raw: @coordinator #71');

  api.uninstall();
  assert.equal(f.document.title, 'Swarm');
  assert.equal(f.elements.tab.textContent, 'Board');
  assert.equal(f.elements.search.getAttribute('placeholder'), 'Search');
  assert.equal(f.elements.search.getAttribute('aria-label'), 'Search posts');
  assert.equal(f.elements.liveRoot.getAttribute('title'), 'Updates automatically');
  assert.equal(f.elements.live.textContent, 'Reconnecting', 'restore the latest native state, rather than the initial state');
  assert.equal(f.elements.progress.textContent, '2 of 5');
  assert.equal(f.elements.acknowledgement.textContent, 'Last change: “Copy $& {text}”');
  assert.equal(f.elements.doneNote.textContent, 'No posts yet');
  assert.equal(leadCaption.textContent,'No posts yet');
  assert.equal(leadAlias.textContent,'@coordinator');
  assert.equal(f.elements.memberNow.textContent, 'Waiting for posts');
  assert.equal(f.elements.memberRole.textContent, 'Task');
  assert.equal(f.elements.runNote.textContent, 'Waiting for posts');
  assert.equal(f.elements.runNote.getAttribute('title'), 'Waiting for posts');
  assert.equal(f.elements.retiredStatus.textContent, 'Retired');
  assert.equal(f.elements.goal.textContent, 'Waiting for the first post');
  assert.equal(f.elements.runningSummary.textContent, 'Waiting for the first post.');
  assert.equal(f.elements.toast.textContent, 'Copied “Copy $& {text}”. Paste it to the coordinator on its machine.');
  assert.equal(threadName.textContent,'Tasks');
  assert.equal(sourceBadge.getAttribute('title'),sourcePrefix+'\nError: '+rawError);
  assert.deepEqual([boardAuthor.textContent,boardRecipient.textContent,incomingAuthor.textContent,incomingRecipient.textContent],
    ['@coordinator','@fix-b1-r2','@fix-b1-r2','@coordinator']);
  assert.deepEqual([replayAuthor.textContent,replayRecipient.textContent],['coordinator','@fix-b1-r2']);
  assert.equal(outgoing.getAttribute('aria-label'),'coordinator to fix-b1-r2, 12:00');
  assert.equal(incoming.getAttribute('aria-label'),'fix-b1-r2 to coordinator, 12:01');
  assert.equal(bodyMention.getAttribute('title'),'coordinator · Waiting');
  assert.equal(citation.getAttribute('title'),'Go to #71 (coordinator)');
  assert.equal(systemMeta.getAttribute('title'),'#73 · coordinator · 12:02');
  assert.equal(waitingTarget.textContent,'→ @coordinator');
  assert.equal(graphName.textContent,'coordina…');
  assert.equal(recipientOption.textContent,'To coordinator');
  assert.equal(recipientOption.getAttribute('value'),'coordinator');
  assert.equal(added.textContent, '5 active');
  assert.ok(f.observers.length > 0);
  assert.ok(f.observers.every(observer => !observer.connected));
  status.data = 'Live';
  await f.mutate([{type:'characterData',target:status}]);
  assert.equal(f.elements.live.textContent, 'Live', 'a disconnected observer cannot translate after uninstall');
});
