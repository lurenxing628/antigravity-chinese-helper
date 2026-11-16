/*
 * Adapted from claude-code-mod-statusline/statusline.js and mod/hooks/format.ts.
 * MIT License
 * Copyright (c) 2026 lurenxing628
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const paint = code => text => text === '' ? '' : `\x1b[22;${code}m${text}\x1b[0m`;
const label = paint('97'), light = paint('37'), green = paint('1;92');
const yellow = paint('1;93'), red = paint('1;91'), blue = paint('1;94');
const magenta = paint('1;95'), cyan = paint('1;96'), orange = paint('1;38;5;208');
const sky = paint('1;38;5;117'), softBlue = paint('1;38;5;111');
const EFFORT_COLORS = {low:'92',medium:'96',high:'93',xhigh:'38;5;208',max:'91'};
const SGR = /\x1b\[[0-9;]*m/g;
const graphemes = new Intl.Segmenter(undefined, {granularity:'grapheme'});
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// Dynamic names belong to one terminal line and cannot inject cursor controls.
const name = value => typeof value === 'string' ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x1f\x7f-\x9f]/g,' ').trim() : '';
const wide = cp => cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
  (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd));
const clusterWidth = text => {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(text)) return 2;
  const character = [...text].find(ch => !/[\p{Mark}\p{Format}]/u.test(ch));
  if (!character) return 0;
  return wide(character.codePointAt(0)) ? 2 : 1;
};

/** Terminal columns, including CJK, combining marks and joined emoji. */
export const cliHudWidth = text => [...graphemes.segment(text.replace(SGR,''))]
  .reduce((sum, item) => sum + clusterWidth(item.segment),0);

function clip(text, columns) {
  if (cliHudWidth(text) <= columns) return text;
  if (columns <= 0) return '';
  let result = '', used = 0;
  for (const token of text.split(/(\x1b\[[0-9;]*m)/)) {
    if (token.startsWith('\x1b[')) { result += token; continue; }
    for (const {segment} of graphemes.segment(token)) {
      const cells = clusterWidth(segment);
      if (used + cells > columns - 1) return `${result}…\x1b[0m`;
      result += segment; used += cells;
    }
  }
  return result;
}

const formatTokens = value => value >= 1e6 ? `${+(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`
  : value >= 1e4 ? `${Math.round(value / 1e3)}k` : value >= 1e3 ? `${+(value / 1e3).toFixed(1)}k` : String(value);
const formatTotal = value => value >= 999950 ? `${(value / 1e6).toFixed(1)}M`
  : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const duration = ms => {
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60);
  return seconds < 60 ? `${seconds}s` : minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2,'0')}s`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2,'0')}m`;
};
const countdown = ms => {
  const minutes = Math.max(0,Math.ceil(ms / 60000)), hours = Math.floor(minutes / 60);
  return minutes < 60 ? `${minutes}m` : hours < 24 ? `${hours}h${String(minutes % 60).padStart(2,'0')}m`
    : `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2,'0')}h`;
};

const FLEX = '\t';
const gapWidth = (parts,gap) => parts.reduce((sum,part) => sum + cliHudWidth(part),0) + Math.max(0,parts.length - 1) * gap;
const figure = (value,color,format = String) => numeric(value) ? color(format(value)) : label('—');

function fit(text,columns) {
  const clipped = clip(text,columns);
  return clipped + ' '.repeat(Math.max(0,columns - cliHudWidth(clipped)));
}

function modelName(value,effort) {
  const text = name(value), suffix = /\s*\((low|medium|high|xhigh|max)\)$/i.exec(text);
  return suffix && suffix[1].toLowerCase() === effort.toLowerCase() ? text.slice(0,suffix.index).trimEnd() : text;
}

// Same complete-part alignment as the user's Claude Code plugin. A unit such
// as " 文件" belongs to its value; the tab absorbs space between label/value.
function measureColumn(rows,gap) {
  const count = rows[0].length;
  if (count > 1 && rows.every(parts => parts.length === count)) {
    return Array.from({length:count},(_,index) => Math.max(...rows.map(parts => cliHudWidth(parts[index]))))
      .reduce((sum,width) => sum + width,0) + gap * (count - 1);
  }
  return Math.max(...rows.map(parts => gapWidth(parts,gap)));
}

function layoutColumn(rows,columns) {
  const count = rows[0].length;
  const aligned = count > 0 && rows.every(parts => parts.length === count);
  const widths = aligned ? Array.from({length:count},(_,index) =>
    Math.max(...rows.map(parts => cliHudWidth(parts[index])))) : null;
  return rows.map(parts => {
    const natural = widths ? widths.reduce((sum,width) => sum + width,0) : parts.reduce((sum,part) => sum + cliHudWidth(part),0);
    const between = parts.length - 1, room = Math.max(0,columns - natural);
    const line = parts.map((part,index) => {
      const spare = widths ? widths[index] - cliHudWidth(part) : 0;
      const fitted = part.includes(FLEX) ? part.replace(FLEX,' '.repeat(1 + spare)) : part + ' '.repeat(spare);
      return (index && between ? ' '.repeat(Math.floor(room / between) + (index <= room % between ? 1 : 0)) : '') + fitted;
    }).join('');
    return fit(line,columns);
  });
}

function smallNumber(value,precision = 3) {
  for (const [unit,suffix] of [[1e18,'E'],[1e15,'P'],[1e12,'T'],[1e9,'G'],[1e6,'M'],[1e3,'k']]) {
    if (value >= unit) return String(+(value / unit).toPrecision(precision)) + suffix;
  }
  return String(+value.toPrecision(precision));
}

function metric(value,child,color,format,childFormat = format) {
  return figure(value,color,format) + (child === undefined ? '' : light('(') + figure(child,color,childFormat) + light(')'));
}

function speedParts(s,sub,level = 0) {
  const tokenFormat = level < 2 ? formatTotal : level < 4 ? formatTokens : value => smallNumber(value,level === 4 ? 3 : 2);
  const childFormat = level === 1 ? formatTokens : tokenFormat;
  const speedFormat = level < 5 ? value => value.toFixed(1) : value => String(Math.round(value));
  const titles = level >= 3 ? ['入','出','TPS'] : level >= 2 ? ['输入','输出','TPS'] : ['输入 ','输出 ','TPS '];
  return [
    label(titles[0]) + metric(s.input,sub?.inputTokens,blue,tokenFormat,childFormat),
    label(titles[1]) + metric(s.output,sub?.outputTokens,magenta,tokenFormat,childFormat),
    label(titles[2]) + metric(s.tps,sub?.tps,cyan,speedFormat),
  ];
}

function contextPart(context,columns) {
  const {used,window,compactAt} = context ?? {};
  const pressure = used / (numeric(compactAt) && compactAt > 0 ? compactAt : window || 1);
  const fill = pressure < 0.6 ? green : pressure < 0.85 ? yellow : red;
  let reading = label('上下文 ') + figure(used,fill,value => (context?.isEstimate ? '~' : '') + formatTokens(value));
  let capacity = figure(window,softBlue,formatTokens);
  const cells = columns - cliHudWidth(reading) - cliHudWidth(capacity) - 2;
  if (cells < 4 || !numeric(used) || !numeric(window) || window === 0) {
    const room = columns - cliHudWidth(reading) - cliHudWidth(capacity);
    return room > 0 ? reading + ' '.repeat(room) + capacity : fit(reading + label('/') + capacity,columns);
  }
  const filled = Math.min(cells,Math.round(used / window * cells));
  const run = (from,to) => fill('█'.repeat(Math.max(0,Math.min(to,filled) - from))) +
    light('░'.repeat(Math.max(0,to - Math.max(from,filled))));
  let bar = run(0,cells);
  if (numeric(compactAt) && compactAt > 0) {
    const mark = Math.min(cells - 1,Math.round(compactAt / window * cells)), text = formatTokens(compactAt);
    if (mark + text.length + 1 <= cells) bar = run(0,mark) + orange('┃' + text) + run(mark + text.length + 1,cells);
    else if (mark >= text.length) bar = run(0,mark - text.length) + orange(text + '┃') + run(mark + 1,cells);
    else bar = run(0,mark) + orange('┃') + run(mark + 1,cells);
  }
  return reading + ' ' + bar + ' ' + capacity;
}

function editParts(s) {
  const files = Array.isArray(s.edits?.files) ? s.edits.files.length : s.edits?.files;
  return [
    label('改动') + FLEX + figure(files,blue) + label(' 文件'),
    figure(s.edits?.added,green,value => '+' + value) + FLEX +
      figure(s.edits?.removed,red,value => '-' + value) + label(' 行'),
  ];
}

function workParts(s,sub,level = 0) {
  const hit = numeric(s.input) && s.input > 0 && numeric(s.cacheRead) ? Math.min(100,s.cacheRead / s.input * 100) : null;
  const childHit = sub === undefined ? undefined : numeric(sub.cacheHitRate) ? Math.min(100,sub.cacheHitRate * 100) : null;
  const color = rate => rate >= 80 ? green : rate >= 50 ? yellow : red;
  const precision = level < 3 ? 2 : level === 3 ? 1 : 0;
  const childPrecision = level === 0 ? 2 : level === 1 || level === 3 ? 1 : 0;
  const cache = figure(hit,color(hit),value => value.toFixed(precision) + '%') +
    (childHit === undefined ? '' : light('(') + figure(childHit,color(childHit),value => value.toFixed(childPrecision) + '%') + light(')'));
  return [
    label('活跃') + FLEX + figure(s.activeMs,s.isActive ? cyan : softBlue,duration),
    label('缓存') + FLEX + cache,
  ];
}

function quotaParts(title,window,now,compact = false) {
  const remaining = window?.remainingPercent, color = remaining > 50 ? green : remaining > 20 ? yellow : red;
  const parts = [label(title + '剩余') + FLEX + figure(remaining,color,value => Math.floor(value) + '%')];
  if (!compact) parts.push(label('↻') + FLEX + figure(window?.resetsAt,softBlue,value => countdown(value - now)));
  return parts;
}

function chooseColumn(candidates,columns) {
  // Try progressively tighter forms inside this column, without reserving
  // invisible child slots or clipping the final TPS/cache value away.
  return candidates.find(({rows,gap}) => measureColumn(rows,gap) <= columns) ?? candidates.at(-1);
}

/** Original Claude-style cells; child values fit the parent column envelope. */
export function renderCliHud(snapshot = {},{columns = process.stdout.columns || 160} = {}) {
  const limit = Number.isFinite(columns) ? Math.max(0,Math.floor(columns)) : 160, s = snapshot;
  const effort = name(s.effort), header = magenta(modelName(s.model,effort) || '—') +
    (effort ? ' ' + paint(EFFORT_COLORS[effort] || '96')(effort) : '') + (s.fastMode ? yellow(' ⚡fast') : '');
  const seconds = value => (value / 1000).toFixed(1) + 's';
  const model = [[header],[label('首字时间'),figure(s.ttftMs,cyan,seconds)]];
  const edits = editParts(s), work = workParts(s,undefined);
  const project = [[label('项目 ') + sky(name(s.project) || '—')],[label('分支 ') + green(name(s.branch) || '—')]];
  const quota = [quotaParts('5h',s.quota?.fiveHour,s.now ?? Date.now()),quotaParts('周',s.quota?.weekly,s.now ?? Date.now())];
  const speeds = speedParts(s,undefined);
  const contextMinimum = 7 + (numeric(s.context?.used) ? formatTokens(s.context.used).length : 1) + 20 +
    (numeric(s.context?.window) ? formatTokens(s.context.window).length : 1) + 2;
  const widths = {
    model:Math.min(30,Math.max(20,measureColumn(model,1))),
    context:Math.max(40,contextMinimum,gapWidth(speeds,4)),
    changes:measureColumn([edits,work],6),
    project:Math.min(30,measureColumn(project,1)),
    quota:measureColumn(quota,2),
  };
  let keys = ['model','context','changes','project','quota'];
  const total = () => keys.reduce((sum,key) => sum + widths[key],0) + (keys.length - 1) * 4;
  if (total() > limit && limit >= 150) keys = keys.filter(key => key !== 'project');
  if (total() > limit) widths.context = Math.min(widths.context,32);
  if (total() > limit) widths.changes = measureColumn([edits,work],3);
  if (total() > limit) keys = keys.filter(key => key !== 'project');
  if (total() > limit) widths.model = Math.min(widths.model,12);
  if (total() > limit) keys = keys.filter(key => key !== 'changes');
  if (total() > limit) keys = keys.filter(key => key !== 'model');
  let compactQuota = false;
  if (total() > limit) { widths.quota = Math.min(widths.quota,14); compactQuota = true; }
  if (total() > limit) widths.context = Math.max(0,limit - widths.quota - 4);
  if (limit < widths.quota + 4) { keys = ['quota']; widths.quota = limit; compactQuota = true; }
  const sub = limit >= 150 ? s.subagentMetrics ?? undefined : undefined;
  const rendered = keys.map(key => {
    const width = widths[key];
    if (key === 'model') {
      const rounded = value => Math.round(value / 1000) + 's';
      const candidates = [[seconds,seconds],[seconds,rounded],[rounded,rounded]].map(([format,childFormat]) => ({
        rows:[[header],[label('首字时间'),metric(s.ttftMs,sub?.ttftMs,cyan,format,childFormat)]],gap:1,
      }));
      return layoutColumn(chooseColumn(candidates,width).rows,width);
    }
    if (key === 'context') {
      const top = contextPart(s.context,width);
      const candidates = Array.from({length:6},(_,level) => ({rows:[[top],speedParts(s,sub,level)],gap:level ? 1 : 4}));
      return layoutColumn(chooseColumn(candidates,width).rows,width);
    }
    if (key === 'changes') {
      const candidates = Array.from({length:5},(_,level) => ({rows:[edits,workParts(s,sub,level)],gap:level ? 1 : 6}));
      return layoutColumn(chooseColumn(candidates,width).rows,width);
    }
    if (key === 'project') return layoutColumn(project,width);
    return layoutColumn([quotaParts('5h',s.quota?.fiveHour,s.now ?? Date.now(),compactQuota),
      quotaParts('周',s.quota?.weekly,s.now ?? Date.now(),compactQuota)],width);
  });
  return [0,1].map(row => rendered.map(cell => cell[row]).join(light(' 丨 '))).join('\n');
}
