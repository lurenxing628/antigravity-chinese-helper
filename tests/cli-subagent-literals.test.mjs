import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCliSubagentStatusDisplayStrings } from '../runtime/cli-subagent-literals.mjs';

test('子代理状态仅在详情标题拼接时翻译', () => {
  const name = 'google3/third_party/jetski/cli/model/model.SubagentDetailModel.buildHeaderLines';
  const buffer = Buffer.alloc(64);
  const word = 0xf9418fe6;
  const targetRva = 0x140;
  const writeJoin = (offset, statusLength) => {
    const call = 0x94000000 + (targetRva - offset - 16) / 4;
    [0xf941afe5,statusLength,0xaa0003e1,0xaa1f03e0,call]
      .forEach((value, index) => buffer.writeUInt32LE(value, offset + index * 4));
  };
  writeJoin(0, word);
  writeJoin(32, 0xf9418fe4);
  const metadata = {imageBase:0x100000000, functions:new Map([
    [name,{rva:0,fileOffset:0,size:64}], ['runtime.concatstring3',{rva:targetRva}],
  ])};
  const strings = {'cli-ui:running':'运行中', 'cli-subagent-status:done':'已完成',
    'cli-subagent-status:idle':'空闲', 'cli-subagent-status:error':'错误', 'cli-subagent-status:killed':'已终止',
    'cli-ui:sample-user-status':'不能用于这里'};
  const plan = collectCliSubagentStatusDisplayStrings(buffer, strings, metadata);
  assert.deepEqual(plan.sites.map(site => [site.rva,site.word,site.pointerRegister,site.lengthRegister,site.replayFirst]),
    [[4,word,5,6,true]]);
  assert.deepEqual(plan.entries.map(entry => entry.original), ['running','done','idle','error','killed']);
  assert.deepEqual(plan.missing, []);
  writeJoin(32, word);
  assert.throws(() => collectCliSubagentStatusDisplayStrings(buffer, strings, metadata), /状态入口已变化/);
});
