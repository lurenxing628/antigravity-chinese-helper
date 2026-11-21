import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCliUiLiterals } from '../runtime/cli-ui-literals.mjs';
import { applyCliStatusLocalizationPatches } from '../runtime/cli-status-localization.mjs';
import { addressInstructions, pageAddress, stringLengthImmediate } from '../runtime/cli-localization.mjs';

test('only the renderer that consumes the literal gets its Chinese string', () => {
  const imageBase = 0x100000000, buffer = Buffer.alloc(1024);
  const english = 'Quick Reference', chinese = '快速参考';
  const fn = {name:'google3/third_party/jetski/cli/model/model.SettingsErrorModel.errorBody', fileOffset:0, rva:0, size:84};
  const render = {name:'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render', rva:0x100};
  const meta = {imageBase, functions:new Map([[fn.name,fn],[render.name,render]]),
    segments:[{name:'__TEXT',sections:[{name:'__rodata',address:imageBase + 512,fileOffset:512,size:64}]}]};
  const instructions = [
    ...addressInstructions(3,imageBase + 512,imageBase),0xb2400fe4,0x911323fb,0xa9001363,
    0x910023e3,0x91400be4,0x91188084,0xd2800158,0xacc14490,0xac814470,0xacc14490,
    0xac814470,0xd1000718,0xb5ffff78,0xf9400099,0xf9000079,0x911323e0,0xb24003e1,0xaa0103e2,
    0x94000000 | (render.rva - 80) / 4,
  ];
  instructions.forEach((word, index) => buffer.writeUInt32LE(word >>> 0,index * 4));
  buffer.write(english,512);
  const dict = {strings:{'cli-ui:Quick Reference':chinese}};
  const collect = () => collectCliUiLiterals(buffer,dict,meta);
  const plan = collect();
  assert.deepEqual(plan.patches.map(p => p.original),[english]);
  assert.deepEqual(collectCliUiLiterals(buffer,dict,meta,plan.patches).patches,[]);
  // Another slice was passed to Style.Render. This producer has no proven UI consumer.
  buffer.writeUInt32LE(0x911363e0,68);
  assert.equal(collect().patches.length,0);
  buffer.writeUInt32LE(instructions[17],68);

  for (const spelling of ['/agents', '/keybindings', '  ~/path/to/plugin', 'https://docs.test', '[x]']) {
    buffer.write(spelling,512);
    buffer.writeUInt32LE((0xd2800004 | (Buffer.byteLength(spelling) << 5)) >>> 0,8);
    assert.deepEqual(collect().missing,[]);
    assert.deepEqual(collect().patches,[]);
  }
  buffer.write(english,512);
  buffer.writeUInt32LE(instructions[2],8);
  applyCliStatusLocalizationPatches(buffer,plan,bytes => { bytes.copy(buffer,768); return imageBase + 768; });
  const address = pageAddress(buffer.readUInt32LE(0),imageBase) + ((buffer.readUInt32LE(4) >>> 10) & 4095);
  const length = stringLengthImmediate(buffer.readUInt32LE(8),4);
  assert.equal(buffer.toString('utf8',address-imageBase,address-imageBase+length),chinese);
  assert.equal(buffer.toString('utf8',512,512+english.length),english);
});
