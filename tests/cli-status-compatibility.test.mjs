import assert from 'node:assert/strict';
import test from 'node:test';
import { addressInstructions } from '../runtime/cli-localization.mjs';
import { collectCliDisplayStrings } from '../runtime/cli-display.mjs';
import { relocateStatusLiteralGroup } from '../runtime/cli-panel-status-profiles.mjs';
import { collectCliStatusLocalizationPatches } from '../runtime/cli-status-localization.mjs';

test('a partial task-list translation preserves the native length shared by both captions', () => {
  const imageBase = 0x100000000, buffer = Buffer.alloc(0x500);
  const tools = 'google3/third_party/oneharness/internal/tools/tools.';
  const name = tools + '(*ManageTaskTool).list', card = tools + 'manageTaskRenderInfo';
  const functions = new Map([[name,{name,rva:0,fileOffset:0,size:0xc0}], [card,{name:card,rva:0x200,fileOffset:0x200,size:4}]]);
  const metadata = {imageBase, functions, segments:[{address:imageBase,fileOffset:0,fileSize:buffer.length}]};
  for (const [offset,source,register,caption] of [[0x54,0x300,2,'1 task'],[0xa4,0x320,0,'Listed']]) {
    buffer.write(caption,source);
    addressInstructions(register,imageBase + source,imageBase + offset).forEach((word,index) => buffer.writeUInt32LE(word,offset + 4 * index));
  }
  buffer.writeUInt32LE(0xd28000c1,0x48); // X1 = 6 bytes for both captions.
  buffer.writeUInt32LE(0x94000000 + (0x200 - 0xac) / 4,0xac);
  const dictionary = {'cli-ui:1 task':'一项任务','cli-ui:Listed':'已经列出'};
  assert.deepEqual(collectCliStatusLocalizationPatches(buffer,dictionary,metadata).patches.map(p => p.translated), ['一项任务','已经列出']);
  delete dictionary['cli-ui:1 task'];
  assert.deepEqual(collectCliStatusLocalizationPatches(buffer,dictionary,metadata).patches, []);
});

test('relocated UI formats require a unique verified call and fail independently', () => {
  const imageBase = 0x100000000, buffer = Buffer.alloc(0x1000);
  const functions = new Map();
  function declare(name, offset, size) {
    functions.set(name, {name, rva:offset, fileOffset:offset, size});
  }
  const escHint = 'google3/third_party/jetski/cli/render/render.EscHint';
  const chip = 'google3/third_party/jetski/cli/model/model.SelectorModel.renderVariantChip';
  declare(escHint, 0, 0x180);
  declare(chip, 0x180, 0x140);
  declare('fmt.Sprintf', 0x600, 4);
  const metadata = {imageBase, functions, segments:[{address:imageBase, fileOffset:0, fileSize:buffer.length}]};
  const dictionary = {'cli-ui:%s to cancel':'按 %s 取消', 'cli-ui:%d of %d':'第 %d/%d 项'};
  function formatSite(offset, source, text, args, callee) {
    buffer.write(text, source);
    const words = [...addressInstructions(0,imageBase + source,imageBase + offset),
      0xd2800001 | (Buffer.byteLength(text) << 5), 0x910323e2, 0xd2800003 | (args << 5), 0xaa0303e4,
      0x94000000 | ((callee - offset - 24) / 4)];
    words.forEach((word, i) => buffer.writeUInt32LE(word >>> 0, offset + i * 4));
  }
  formatSite(0x20, 0x800, '%s to cancel', 1, 0x600);
  formatSite(0x70, 0x800, '%s to cancel', 1, 0x700);
  formatSite(0x1e0, 0x900, '%d of %d', 2, 0x600);
  let plan = collectCliStatusLocalizationPatches(buffer, dictionary, metadata);
  assert.deepEqual(plan.patches.map(patch => patch.pointerFileOffset), [0x20, 0x1e0]);
  formatSite(0x70, 0x800, '%s to cancel', 1, 0x600);
  plan = collectCliStatusLocalizationPatches(buffer, dictionary, metadata);
  assert.ok(plan.unsupported.includes(escHint));
  assert.deepEqual(plan.patches.map(patch => patch.pointerFileOffset), [0x1e0]);
});

test('a moved display label is selected by its conditional instruction', () => {
  const imageBase = 0x100000000, buffer = Buffer.alloc(0x400);
  const name = 'scrollLabel', choice = 0x9a830040, source = 0x200;
  const sourceText = 'line';
  const functions = new Map([[name,{name,rva:0,fileOffset:0,size:0x100}]]);
  const metadata = {imageBase, functions, segments:[{address:imageBase,fileOffset:0,fileSize:buffer.length}]};
  buffer.write(sourceText,source);
  // Two identical string loads, but only the second belongs to the conditional.
  for (const [offset, instruction] of [[0x20,0xd503201f],[0x60,choice]]) {
    const words = [...addressInstructions(2,imageBase + source,imageBase + offset),0xd2800081,instruction];
    words.forEach((word,index) => buffer.writeUInt32LE(word,offset + 4 * index));
  }
  const profile = {name,literals:[[0,8,2,1,sourceText]],guards:[[12,choice]]};
  const located = relocateStatusLiteralGroup(buffer,metadata,profile);
  assert.equal(located.literals[0][0],0x60);
  assert.deepEqual(located.guards,[[0x6c,choice]]);
});

test('the tip prefix and body follow the relocated final concatenation', () => {
  const imageBase = 0x100000000, buffer = Buffer.alloc(0x1000);
  const name = 'google3/third_party/jetski/cli/store/store.(*Manager).GetTip';
  const functions = new Map([
    [name, {name, rva:0x100, fileOffset:0x100, size:0x370}],
    ['runtime.concatstring2', {rva:0x600}],
  ]);
  const metadata = {imageBase, functions, segments:[{
    name:'__TEXT', address:imageBase, fileOffset:0, fileSize:buffer.length,
    sections:[{name:'__rodata', address:imageBase + 0x800, fileOffset:0x800, size:0x100}],
  }]};
  const original = '└ Tip: ', body = 'Press ? for shortcuts.';
  const dictionary = {'cli-ui:└ Tip: ':'└ 提示：', [`cli-ui:${body}`]:'按 ? 查看快捷键。'};
  const prefixOffset = 0x100 + 0x2e0;
  const words = [0xf86578c3, 0xf94004e4, 0xaa1f03e0,
    ...addressInstructions(1, imageBase + 0x800, imageBase + prefixOffset),
    0xd2800122, 0x94000000 | ((0x600 - prefixOffset - 12) / 4)];
  words.forEach((word, index) => buffer.writeUInt32LE(word >>> 0, prefixOffset - 12 + index * 4));
  buffer.write(original, 0x800);
  buffer.write(body, 0x820);

  const status = collectCliStatusLocalizationPatches(buffer, dictionary, metadata);
  const prefix = status.patches.find(patch => patch.functionName === name);
  assert.equal(prefix.pointerFileOffset, prefixOffset);
  assert.equal(prefix.translated, '└ 提示：');
  const display = collectCliDisplayStrings(buffer, dictionary, metadata);
  assert.deepEqual(display.sites.map(({fileOffset,pointerRegister,lengthRegister}) =>
    [fileOffset,pointerRegister,lengthRegister]), [[prefixOffset - 8,3,4]]);
  assert.ok(display.entries.some(entry => entry.original === body));
});
