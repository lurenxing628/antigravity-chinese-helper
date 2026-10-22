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
  setCustomValidity() {}
  getBoundingClientRect() { return {left:10, top:10, right:110, bottom:30, width:100, height:20}; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type) {
    const event = {preventDefault() {}, stopPropagation() {}};
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }
  remove() { this.isConnected = false; }
}

function fixture(initialTime = new Date(2026, 9, 22, 12).getTime()) {
  let now = initialTime, sequence = 0;
  const timers = new Map(), elements = [];
  const window = new Element('window');
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.setTimeout = (callback, delay) => {
    const id = ++sequence; timers.set(id, {callback, at:now + delay}); return id;
  };
  window.clearTimeout = id => timers.delete(id);
  const document = new Element('document');
  document.defaultView = window; document.documentElement = {clientWidth:1200, clientHeight:800};
  document.createElement = tag => { const element = new Element(tag); elements.push(element); return element; };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const view = vm.runInNewContext(viewSource, {Date:ClockDate})(document, {});
  const button = key => elements.find(element => element.dataset.ring === key);
  const row = (key, label) => {
    const tooltip = elements.find(element => element.id === `context-${key}-tooltip`);
    const details = tooltip.children[0].children.find(element => element.tagName === 'DL');
    return details.children[details.children.findIndex(element => element.textContent === label) + 1].textContent;
  };
  return {
    view, timers, row, now:() => now,
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

test('quota reset timestamps survive normalization and update even when remaining quota is unchanged', t => {
  const f = fixture(); t.after(() => f.view.dispose());
  const snapshot = {
    fiveHourQuota:{remainingFraction:.4, resetAtMs:f.now() + 163 * 60000},
    weeklyQuota:{remainingFraction:.8, resetAtMs:f.now() + 2 * 86400000}
  };
  assert.equal(f.view.update(snapshot), true);
  assert.equal(f.row('five-hour', '额度重置'), '14:43（2小时43分后）');
  assert.equal(f.row('weekly', '额度重置'), '10/24 12:00（2天后）');
  assert.equal(f.timers.size, 0, 'closed cards do not run countdown timers');
  assert.equal(f.view.update(snapshot), false);
  snapshot.fiveHourQuota.resetAtMs += 60000;
  assert.equal(f.view.update(snapshot), true, 'a changed reset timestamp updates the view');
  assert.equal(f.row('five-hour', '额度重置'), '14:44（2小时44分后）');
  assert.equal(f.row('five-hour', '剩余比例'), '40%');
});

test('open countdowns follow minute boundaries, stop when closed, and never claim quota has refilled', t => {
  const f = fixture(new Date(2026, 9, 22, 12, 0, 10).getTime()); t.after(() => f.view.dispose());
  f.view.update({fiveHourQuota:{remainingFraction:.4, resetAtMs:new Date(2026, 9, 22, 12, 3).getTime()}});
  f.open('five-hour');
  assert.equal(f.row('five-hour', '额度重置'), '12:03（3分后）');
  assert.equal(f.timers.size, 1);
  f.advance(50000);
  assert.equal(f.row('five-hour', '额度重置'), '12:03（2分后）');
  f.close('five-hour');
  assert.equal(f.timers.size, 0);
  f.advance(60000);
  assert.equal(f.row('five-hour', '额度重置'), '12:03（2分后）', 'hidden text is not periodically rewritten');
  f.open('five-hour');
  assert.equal(f.row('five-hour', '额度重置'), '12:03（1分后）', 'reopening recomputes from the current clock');
  f.click('five-hour'); f.close('five-hour');
  assert.equal(f.timers.size, 1, 'a pinned card stays live after the pointer leaves');
  f.advance(60000);
  assert.equal(f.row('five-hour', '额度重置'), '12:03（已到重置时间）');
  assert.equal(f.row('five-hour', '剩余比例'), '40%', 'only a new quota response can change remaining quota');
  assert.equal(f.timers.size, 0, 'an expired timestamp does not keep scheduling');
});

test('missing or disabled quotas do not count down; switching and disposing cards clear their timers', () => {
  const f = fixture();
  f.open('five-hour');
  assert.equal(f.row('five-hour', '额度重置'), '—');
  assert.equal(f.timers.size, 0);
  for (const resetAtMs of [null, undefined, NaN, Infinity, 0]) {
    f.view.update({fiveHourQuota:{remainingFraction:.4, resetAtMs}});
    assert.equal(f.row('five-hour', '额度重置'), '—');
    assert.equal(f.timers.size, 0);
  }
  f.view.update({fiveHourQuota:{remainingFraction:.4, resetAtMs:f.now() + 60000, disabled:true}});
  assert.equal(f.row('five-hour', '额度重置'), '—');
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
