import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../runtime/renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('  function computerUseAppName(');
const end = renderer.indexOf('  function translatedMenu(', start);
assert.ok(start >= 0 && end > start, 'the actual translation functions are present');
const translationSource = renderer.slice(start, end);

function fixture(dictionary = {}) {
  const context = vm.createContext({dictionary});
  return vm.runInContext(`
    let strings, normalizedStrings;
    const projectPlaceholders = new Set(['No Project','Select Project','Select Workspace','New Workspace']);
    ${translationSource}
    setStrings(dictionary);
    ({translate, setStrings});
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

test('dynamic labels preserve shortcuts, counts and model punctuation', () => {
  const {translate} = fixture();
  const examples = [
    ['Enter Sends immediately', 'Enter 立即发送'],
    ['⌥⌅ Queues after the turn', '⌥⌅ 排队，当前轮次结束后发送'],
    ['1 active conversation', '1 个进行中对话'],
    ['12 archived conversations', '12 个已归档对话'],
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
});
