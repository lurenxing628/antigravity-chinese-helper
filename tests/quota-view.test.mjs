import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../runtime/renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('(function createContextRingView');
const end = renderer.indexOf('\n});', start);
assert.ok(start >= 0 && end > start, 'the actual view factory is present');
const viewSource = renderer.slice(start, end + 3);

// Only the DOM operations used by the real view are needed for these tests.
class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase(); this.children = []; this.dataset = {};
    this.attributes = new Map(); this.listeners = new Map(); this.isConnected = true;
    this.style = {setProperty() {}}; this.textContent = '';
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  prepend(child) { child.parentElement = this; this.children.unshift(child); }
  get lastChild() { return this.children.at(-1); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  attachShadow() { return this.shadowRoot = new Element('shadow'); }
  createTHead() { return this.appendChild(new Element('thead')); }
  createTBody() { return this.appendChild(new Element('tbody')); }
  insertRow() { return this.appendChild(new Element('tr')); }
  insertCell() { return this.appendChild(new Element('td')); }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  getBoundingClientRect() { return {left:10, top:10, right:110, bottom:30, width:100, height:20}; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, properties = {}) {
    const event = {target:this, defaultPrevented:false, propagationStopped:false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }, ...properties};
    let element = this;
    do {
      event.currentTarget = element;
      for (const callback of element.listeners.get(type) ?? []) callback(event);
      element = event.bubbles && !event.propagationStopped ? element.parentElement : null;
    } while (element);
    return event;
  }
  remove() { this.isConnected = false; }
}

function fixture(initialTime = new Date(2026, 9, 22, 12).getTime(), {windowGlobals = {}, actions = {}} = {}) {
  let now = initialTime, sequence = 0;
  const timers = new Map(), elements = [];
  const window = new Element('window');
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.setTimeout = (callback, delay) => {
    const id = ++sequence; timers.set(id, {callback, at:now + delay}); return id;
  };
  window.clearTimeout = id => timers.delete(id);
  Object.assign(window, windowGlobals);
  const document = new Element('document');
  document.defaultView = window; document.documentElement = {clientWidth:1200, clientHeight:800};
  document.createElement = tag => { const element = new Element(tag); elements.push(element); return element; };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const view = vm.runInNewContext(viewSource, {Date:ClockDate})(document, {}, actions);
  const button = key => elements.find(element => element.dataset.ring === key);
  const row = (key, label) => {
    const tooltip = elements.find(element => element.id === `context-${key}-tooltip`);
    const details = tooltip.children[0].children.find(element => element.tagName === 'DL');
    return details.children[details.children.findIndex(element => element.textContent === label) + 1].textContent;
  };
  return {
    view, timers, row, now:() => now,
    element:testId => {
      const element = elements.find(element => element.getAttribute('data-testid') === testId);
      assert.ok(element, `view contains ${testId}`);
      return element;
    },
    settingReference:label => elements.find(element => element.className === 'setting-reference' && element.children[0]?.textContent === label)?.children[1].textContent,
    open:key => button(key).parentElement.emit('pointerenter'),
    close:key => button(key).parentElement.emit('pointerleave'),
    click:key => button(key).emit('click'),
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = target;
    }
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const subagentStatus = (targetTokens, extra = {}) => ({targetTokens, active:true, error:null, message:'已就绪', ...extra});
function subagentBridge(initialRead) {
  const listeners = new Set(), requests = [];
  return {
    api: {
      getStatus:() => initialRead,
      setLimit:tokens => {
        const request = {tokens, ...deferred()}; requests.push(request); return request.promise;
      },
      subscribe:listener => { listeners.add(listener); return () => listeners.delete(listener); }
    },
    listeners, requests,
    broadcast:status => { for (const listener of listeners) listener(status); }
  };
}

test('subagent context is unavailable without its bridge and its keyboard events stay in the settings card', t => {
  const f = fixture(); t.after(() => f.view.dispose());
  for (const name of ['input', 'apply', 'reset']) {
    assert.equal(f.element(`subagent-context-${name}`).disabled, true);
  }
  assert.equal(f.element('subagent-context-status').textContent, '子代理上下文服务未连接');
  for (const type of ['keydown', 'keyup', 'keypress']) {
    const event = f.element('subagent-context-input').emit(type, {key:'Enter', bubbles:true});
    assert.equal(event.propagationStopped, true, `${type} does not reach the chat composer`);
    assert.equal(event.defaultPrevented, false, `${type} retains normal input behavior`);
  }
});

test('subagent context loads, saves independently of the main model, reports failures and restores defaults', async t => {
  const read = deferred(), bridge = subagentBridge(read.promise), mainWrites = [];
  const f = fixture(undefined, {windowGlobals:{__antigravitySubagentContext:bridge.api},
    actions:{setContextLimit:tokens => mainWrites.push(tokens)}});
  t.after(() => f.view.dispose());
  const input = f.element('subagent-context-input'), form = f.element('subagent-context-form');
  const apply = f.element('subagent-context-apply'), reset = f.element('subagent-context-reset');
  const status = f.element('subagent-context-status');
  assert.equal(input.disabled, true);
  assert.equal(apply.disabled, true);
  assert.equal(reset.disabled, true);
  read.resolve(subagentStatus(256000)); await settle();
  assert.equal(input.value, '256');
  assert.equal(input.disabled, false);
  assert.equal(apply.disabled, false);

  f.view.update({contextSetting:{modelKey:'small-model', modelLabel:'Small Fixture', customLimit:null,
    effectiveLimit:80000, defaultLimit:80000, maxLimit:98304, pending:false, supported:true, error:null}});
  input.value = '500'; input.emit('input');
  assert.equal(form.emit('submit').defaultPrevented, true);
  await settle();
  assert.equal(bridge.requests[0]?.tokens, 500000, 'subagents are not clamped to the main model capacity');
  assert.deepEqual(mainWrites, [], 'subagent edits do not write the main model setting');
  bridge.requests[0].resolve(subagentStatus(500000, {message:'子代理设置已应用'})); await settle();
  assert.equal(input.value, '500');
  assert.match(status.textContent, /子代理设置已应用/);

  input.value = '600'; input.emit('input'); form.emit('submit'); await settle();
  bridge.requests[1].resolve(subagentStatus(500000, {error:'配置保存失败', message:'配置保存失败'})); await settle();
  assert.equal(input.value, '500', 'a rejected change retains the previously saved limit');
  assert.match(status.textContent, /配置保存失败/);
  assert.equal(apply.disabled, false, 'a failed save can be retried');

  input.value = '700'; input.emit('input'); form.emit('submit'); await settle();
  bridge.requests[2].reject(new Error('连接中断')); await settle();
  assert.match(status.textContent, /连接中断/);
  assert.equal(reset.disabled, false, 'transport failure does not leave the form locked');
  reset.emit('click'); await settle();
  assert.equal(bridge.requests[3]?.tokens, null);
  bridge.requests[3].resolve(subagentStatus(null, {message:'已恢复默认'})); await settle();
  assert.equal(input.value, '');
  assert.match(status.textContent, /已恢复默认/);
});

test('subagent context rejects limits outside the positive uint32 range before calling the bridge', async t => {
  const bridge = subagentBridge(Promise.resolve(subagentStatus(null)));
  const f = fixture(undefined, {windowGlobals:{__antigravitySubagentContext:bridge.api}});
  t.after(() => f.view.dispose());
  await settle();
  const input = f.element('subagent-context-input'), form = f.element('subagent-context-form');
  for (const value of ['', '0', '4294967.296']) {
    input.value = value; input.emit('input'); form.emit('submit'); await settle();
    assert.ok(input.validationMessage, `invalid limit ${JSON.stringify(value)} is explained`);
  }
  assert.equal(bridge.requests.length, 0);
});

test('subagent broadcasts supersede stale reads and disposing unsubscribes and ignores late responses', async () => {
  const read = deferred(), bridge = subagentBridge(read.promise);
  const f = fixture(undefined, {windowGlobals:{__antigravitySubagentContext:bridge.api}});
  const input = f.element('subagent-context-input'), status = f.element('subagent-context-status');
  assert.equal(bridge.listeners.size, 1);
  bridge.broadcast(subagentStatus(500000, {active:false, message:'等待子代理服务启动'})); await settle();
  assert.equal(input.value, '500');
  assert.match(status.textContent, /等待子代理服务启动/);
  read.resolve(subagentStatus(256000)); await settle();
  assert.equal(input.value, '500', 'an older initial read does not overwrite a broadcast');
  assert.match(status.textContent, /等待子代理服务启动/);
  bridge.broadcast(subagentStatus(600000, {message:'子代理服务已生效'})); await settle();
  assert.equal(input.value, '600');
  assert.match(status.textContent, /子代理服务已生效/);

  input.value = '700'; input.emit('input'); f.element('subagent-context-form').emit('submit'); await settle();
  assert.equal(bridge.requests[0]?.tokens, 700000);
  f.view.dispose();
  assert.equal(bridge.listeners.size, 0);
  const disposedState = {input:input.value, status:status.textContent, disabled:input.disabled};
  bridge.requests[0].resolve(subagentStatus(700000, {message:'迟到保存结果'}));
  bridge.broadcast(subagentStatus(800000, {message:'卸载后的广播'})); await settle();
  assert.deepEqual({input:input.value, status:status.textContent, disabled:input.disabled}, disposedState);

  const lateRead = deferred(), lateBridge = subagentBridge(lateRead.promise);
  const pending = fixture(undefined, {windowGlobals:{__antigravitySubagentContext:lateBridge.api}});
  const pendingInput = pending.element('subagent-context-input'), pendingStatus = pending.element('subagent-context-status');
  pending.view.dispose();
  const beforeRead = {input:pendingInput.value, status:pendingStatus.textContent};
  lateRead.resolve(subagentStatus(900000, {message:'卸载后的读取结果'})); await settle();
  assert.equal(lateBridge.listeners.size, 0);
  assert.deepEqual({input:pendingInput.value, status:pendingStatus.textContent}, beforeRead);
});

test('context settings name an unknown backend default and replace it when a catalog budget is available', t => {
  const f = fixture(); t.after(() => f.view.dispose());
  const contextSetting = {modelKey:'1417', modelLabel:'Gemini Fixture', customLimit:500000, effectiveLimit:500000,
    defaultLimit:null, maxLimit:1032192, pending:false, supported:true, error:null};
  f.view.update({contextSetting});
  assert.equal(f.settingReference('默认上下文'), '后端默认');
  f.view.update({contextSetting:{...contextSetting,defaultLimit:256000}});
  assert.equal(f.settingReference('默认上下文'), '256.00K');
});

test('quota reset timestamps survive normalization and update even when remaining quota is unchanged', t => {
  const f = fixture(); t.after(() => f.view.dispose());
  const snapshot = {
    fiveHourQuota:{remainingFraction:.4, resetAtMs:f.now() + 163 * 60000},
    weeklyQuota:{remainingFraction:.8, resetAtMs:f.now() + 2 * 86400000}
  };
  assert.equal(f.view.update(snapshot), true);
  assert.equal(f.row('five-hour', '恢复时间'), '14:43（2小时43分后）');
  assert.equal(f.row('weekly', '恢复时间'), '10/24 12:00（2天后）');
  assert.equal(f.timers.size, 0, 'closed cards do not run countdown timers');
  assert.equal(f.view.update(snapshot), false);
  snapshot.fiveHourQuota.resetAtMs += 60000;
  assert.equal(f.view.update(snapshot), true, 'a changed reset timestamp updates the view');
  assert.equal(f.row('five-hour', '恢复时间'), '14:44（2小时44分后）');
  assert.equal(f.row('five-hour', '剩余比例'), '40%');
});

test('open countdowns follow minute boundaries, stop when closed, and never claim quota has refilled', t => {
  const f = fixture(new Date(2026, 9, 22, 12, 0, 10).getTime()); t.after(() => f.view.dispose());
  f.view.update({fiveHourQuota:{remainingFraction:.4, resetAtMs:new Date(2026, 9, 22, 12, 3).getTime()}});
  f.open('five-hour');
  assert.equal(f.row('five-hour', '恢复时间'), '12:03（3分后）');
  assert.equal(f.timers.size, 1);
  f.advance(50000);
  assert.equal(f.row('five-hour', '恢复时间'), '12:03（2分后）');
  f.close('five-hour');
  assert.equal(f.timers.size, 0);
  f.advance(60000);
  assert.equal(f.row('five-hour', '恢复时间'), '12:03（2分后）', 'hidden text is not periodically rewritten');
  f.open('five-hour');
  assert.equal(f.row('five-hour', '恢复时间'), '12:03（1分后）', 'reopening recomputes from the current clock');
  f.click('five-hour'); f.close('five-hour');
  assert.equal(f.timers.size, 1, 'a pinned card stays live after the pointer leaves');
  f.advance(60000);
  assert.equal(f.row('five-hour', '恢复时间'), '12:03（已到重置时间）');
  assert.equal(f.row('five-hour', '剩余比例'), '40%', 'only a new quota response can change remaining quota');
  assert.equal(f.timers.size, 0, 'an expired timestamp does not keep scheduling');
});

test('missing or disabled quotas do not count down; switching and disposing cards clear their timers', () => {
  const f = fixture();
  f.open('five-hour');
  assert.equal(f.row('five-hour', '恢复时间'), '—');
  assert.equal(f.timers.size, 0);
  for (const resetAtMs of [null, undefined, NaN, Infinity, 0]) {
    f.view.update({fiveHourQuota:{remainingFraction:.4, resetAtMs}});
    assert.equal(f.row('five-hour', '恢复时间'), '—');
    assert.equal(f.timers.size, 0);
  }
  f.view.update({fiveHourQuota:{remainingFraction:.4, resetAtMs:f.now() + 60000, disabled:true}});
  assert.equal(f.row('five-hour', '恢复时间'), '—');
  assert.equal(f.row('five-hour', '剩余比例'), '—');
  assert.equal(f.timers.size, 0);
  f.view.update({
    fiveHourQuota:{remainingFraction:.4, resetAtMs:f.now() + 60000},
    weeklyQuota:{remainingFraction:.8, resetAtMs:f.now() + 86400000}
  });
  const previousTimer = [...f.timers.keys()][0];
  f.open('weekly');
  assert.equal(f.timers.has(previousTimer), false, 'switching cards cancels the previous timer');
  assert.equal(f.timers.size, 1);
  f.view.dispose();
  assert.equal(f.timers.size, 0, 'disposing an open card cancels the timer');
  f.open('weekly'); f.advance(60000);
  assert.equal(f.timers.size, 0, 'disposed event listeners cannot restart the timer');
});


test('main budget feedback confirms persistence and keeps native readiness separate', async t => {
  let f;
  const setting = {modelKey:'1417',modelLabel:'Fixture',customLimit:null,effectiveLimit:256000,defaultLimit:256000,
    maxLimit:1032192,pending:false,supported:true,error:null,nativeReady:false,message:''};
  f = fixture(undefined, {actions:{setContextLimit:async tokens => {
    f.view.update({contextSetting:{...setting,customLimit:tokens,effectiveLimit:tokens,message:'设置已保存，等待后端接入'}});
    return true;
  }}});
  t.after(() => f.view.dispose());
  f.view.update({contextSetting:setting});
  const input=f.element('context-limit-input'),apply=f.element('context-limit-apply'),status=f.element('context-limit-status');
  input.value='512';input.emit('input');f.element('context-limit-form').emit('submit');await settle();
  assert.equal(apply.textContent,'已保存');
  assert.equal(status.textContent,'设置已保存，等待后端接入');
  assert.equal(status.getAttribute('data-error'),'false');
  f.view.update({contextSetting:{...setting,customLimit:512000,effectiveLimit:512000,nativeReady:true,message:'后端已接入'}});
  assert.equal(status.textContent,'后端已接入','readiness-only broadcasts must update the visible message');
});
