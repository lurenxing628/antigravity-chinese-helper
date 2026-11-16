import test from 'node:test';
import assert from 'node:assert/strict';
import {renderCliHud,cliHudWidth} from '../runtime/cli-hud-render.mjs';

const plain = text => text.replace(/\x1b\[[0-9;]*m/g,'');
const sample = {
  model:'OPUS 5.5',effort:'xhigh',context:{used:447000,window:1000000,compactAt:567000},
  ttftMs:1234,input:1260500000,output:3100000,cacheRead:1241970650,tps:137.8,
  edits:{files:141,added:4384,removed:981},activeMs:6 * 3600000 + 13 * 60000,isActive:true,
  project:'----',branch:'main',now:1000000,
  quota:{fiveHour:{remainingPercent:25,resetsAt:8200000},weekly:{remainingPercent:10,resetsAt:17200000}},
};

test('the transplanted wide HUD preserves both rows and aligned column separators',() => {
  const text = renderCliHud(sample,{columns:240}), lines = text.split('\n');
  assert.equal(lines.length,2);
  assert.equal(text.endsWith('\n'),false);
  assert.match(plain(lines[0]),/OPUS 5\.5 xhigh.*上下文\s+447k.*┃567k.*1M.*改动\s+141 文件.*\+4384.*-981 行.*项目 ----.*5h剩余\s+25%/);
  assert.match(plain(lines[1]),/首字时间\s+1\.2s.*输入\s+1260\.5M.*输出\s+3\.1M.*TPS\s+137\.8.*活跃\s+6h13m.*缓存\s+98\.53%.*分支 main.*周剩余\s+10%/);
  assert.match(lines[0],/\x1b\[22;1;93m25%\x1b\[0m/);
  assert.match(lines[1],/\x1b\[22;1;91m10%\x1b\[0m/);
  assert.doesNotMatch(plain(text),/费用|\$/);
  assert.doesNotMatch(plain(text),/5小时|5h\s+剩余|首字(?!时间)/);
  const quotas = lines.map(line => plain(line).split('丨').at(-1));
  const valueEnd = (text,value) => cliHudWidth(text.slice(0,text.indexOf(value) + value.length));
  assert.equal(valueEnd(quotas[0],'25%'),valueEnd(quotas[1],'10%'));
  assert.equal(valueEnd(quotas[0],'2h00m'),valueEnd(quotas[1],'4h30m'));
  const positions = line => [...plain(line).matchAll(/丨/g)].map(match => cliHudWidth(plain(line).slice(0,match.index)));
  assert.deepEqual(positions(lines[0]),positions(lines[1]));
});

test('missing readings remain unknown while measured zero stays zero',() => {
  const unknown = plain(renderCliHud({}, {columns:240}));
  assert.match(unknown,/首字.*—/);
  assert.match(unknown,/输入\s+—.*输出\s+—.*TPS\s+—/);
  assert.doesNotMatch(unknown,/NaN|undefined|null/);
  const zero = plain(renderCliHud({...sample,ttftMs:0,input:0,output:0,cacheRead:0,tps:0,activeMs:0}, {columns:240}));
  assert.match(zero,/首字时间\s+0\.0s/); assert.match(zero,/输入\s+0.*输出\s+0.*TPS\s+0\.0/);
  assert.match(zero,/缓存\s+—/);
});

test('CJK, combining marks and emoji remain within narrow terminal widths',() => {
  assert.equal(cliHudWidth('中e\u0301👩‍💻'),5);
  for (const columns of [240,120,80,45,40,16,1,0]) {
    const text = renderCliHud({...sample,model:'自定义模型👩‍💻'.repeat(4),project:'项目\n名\x1b[2J',branch:'功能/e\u0301'}, {columns});
    assert.equal(text.split('\n').length,2);
    for (const line of text.split('\n')) assert(cliHudWidth(line) <= columns);
    assert.doesNotMatch(text,/\x1b\[2J|\ufffd/);
    assert.doesNotMatch(plain(text),/\x1b/);
    if (columns === 80 || columns === 40) {
      assert.match(plain(text.split('\n')[0]),/上下文.*5h剩余\s*25%/);
      assert.match(plain(text.split('\n')[1]),/周剩余\s*10%/);
    }
  }
});

test('children fit the parent columns without empty child slots or dropping metrics',() => {
  const snapshot = {...sample,subagentMetrics:{ttftMs:3456,inputTokens:45000,outputTokens:6200,tps:42.1,cacheHitRate:0.75}};
  const wide = plain(renderCliHud(snapshot,{columns:180}));
  assert.match(wide,/首字时间\s+1\.2s\(3\.5s\)/);
  assert.match(wide,/入1261M\(45k\).*出3\.1M\(6\.2k\).*TPS137\.8\(42\.1\)/);
  assert.match(wide,/缓存\s+98\.53%\(75\.0%\)/);
  const columns = 100;
  const narrow = renderCliHud(snapshot,{columns});
  assert.doesNotMatch(plain(narrow),/\([^)]*\)/);
  assert.match(plain(narrow),/输入\s+1260\.5M.*输出\s+3\.1M.*TPS\s+137\.8/);
  for (const line of narrow.split('\n')) assert(cliHudWidth(line) <= columns);
});

test('main and child sessions keep identical widths and separator positions without filling the terminal',() => {
  const positions = line => [...plain(line).matchAll(/丨/g)].map(match => cliHudWidth(plain(line).slice(0,match.index)));
  for (const columns of [80,120,180,240,300]) {
    const states = [sample,
      {...sample,subagentMetrics:{ttftMs:3456,inputTokens:45000,outputTokens:6200,tps:42.1,cacheHitRate:0.75}},
      {...sample,subagentMetrics:{ttftMs:120000,inputTokens:1200000000000,outputTokens:12000000000,tps:12345.6,cacheHitRate:1}},
    ].map(snapshot => renderCliHud(snapshot,{columns}).split('\n'));
    const expected = positions(states[0][0]);
    const width = cliHudWidth(states[0][0]);
    for (const lines of states) for (const line of lines) {
      assert.equal(cliHudWidth(line),width);
      assert(width <= columns);
      assert.deepEqual(positions(line),expected);
    }
  }
  assert.equal(renderCliHud(sample,{columns:240}),renderCliHud(sample,{columns:400}),'extra terminal space must not spread the HUD');
});

test('Claude-style whole parts align, zero deltas stay visible and project names determine their own width',() => {
  const end = (line,value) => {
    const text = plain(line), index = text.indexOf(value);
    assert(index >= 0,`missing visible value ${value}`);
    return cliHudWidth(text.slice(0,index + value.length));
  };
  for (const subagentMetrics of [undefined,{ttftMs:3456,inputTokens:45000,outputTokens:6200,tps:42.1,cacheHitRate:0.75}]) {
    const rows = renderCliHud({...sample,model:'Gemini 4 Hydrogen (High)',effort:'high',subagentMetrics},{columns:300}).split('\n');
    assert.match(plain(rows[0]),/^Gemini 4 Hydrogen high\s+丨/);
    assert.doesNotMatch(plain(rows[0]),/\(High\)/);
    assert.equal(end(rows[0],'1M'),end(rows[1],subagentMetrics ? '42.1)' : '137.8'));
    assert.equal(end(rows[0],'141 文件'),end(rows[1],'6h13m'));
    assert.equal(end(rows[0],'-981 行'),end(rows[1],subagentMetrics ? '75.0%)' : '98.53%'));
    assert.match(plain(rows[0]),/项目 ---- 丨/,'a short project must not have a wide reserved column');
    assert(cliHudWidth(rows[0]) < 150,'the screenshot-sized readings must use a compact content width');
    const zero = plain(renderCliHud({...sample,edits:{files:1,added:299,removed:0},subagentMetrics},{columns:300}));
    assert.match(zero,/\+299\s+-0 行/);
  }
  const custom = plain(renderCliHud({...sample,model:'My (Preview)',effort:'high'},{columns:300}));
  assert.match(custom,/My \(Preview\) high/);
});
