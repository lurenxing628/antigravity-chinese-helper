import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliHudSnapshot, withCliHud, cliHudDatabasePath } from '../runtime/cli-hud.mjs';

test('native context and quota readings keep their distinct units and model groups', () => {
  const data = {model:{display_name:'Gemini 4 Argon',effort:'high'},context_window:{
    context_window_size:1000000,used_percentage:15,total_input_tokens:8000000,total_output_tokens:20000,
    current_usage:{input_tokens:100000,output_tokens:500,cache_creation_input_tokens:0,cache_read_input_tokens:50000},
  },quota:{'gemini-5h':{remaining_fraction:0.75,reset_time:'2026-11-16T12:00:00Z'},
    '3p-5h':{remaining_fraction:1},'gemini-weekly':{disabled:true}},terminal_width:160};
  const snapshot = cliHudSnapshot(data,{input:123456,output:654,cacheRead:100000,tps:50,ttftMs:1200,context:{compactAt:800000},
    subagentMetrics:{input:100,output:20,tps:30,ttftMs:2000,cacheHitRate:0.5}});
  assert.deepEqual(snapshot.context,{used:150000,window:1000000,compactAt:800000});
  assert.equal(snapshot.input,123456);
  assert.equal(snapshot.quota.fiveHour.remainingPercent,75);
  assert.equal(snapshot.quota.fiveHour.resetsAt,Date.parse('2026-11-16T12:00:00Z'));
  assert.equal(snapshot.quota.weekly,undefined);
  assert.equal(cliHudSnapshot({...data,model:{display_name:'Claude Opus 5.5'}}).quota.fiveHour.remainingPercent,100);
  assert.equal(snapshot.ttftMs,1200);
  assert.deepEqual(snapshot.subagentMetrics,{inputTokens:100,outputTokens:20,tps:30,ttftMs:2000,cacheHitRate:0.5});
  assert.equal(cliHudSnapshot({}).ttftMs,null);
  assert.equal(cliHudSnapshot(data).input,null,'native total_input_tokens is context usage, not cumulative input');
  assert.equal(cliHudDatabasePath({conversation_id:'../settings'}),null);
});

test('HUD settings preserve session options, explicit statusLine and option-looking prompts', async () => {
  const valueFlags = new Set(['-i','-p','--model','--settings']);
  const args = await withCliHud(['-i','--settings','--model','Gemini 4 Argon','--settings','{"colorScheme":"dark"}'],
    {valueFlags,nodePath:'/A folder/node',hudPath:"/A folder/it's-hud.mjs"});
  const settings = JSON.parse(args[1]);
  assert.equal(settings.colorScheme,'dark');
  assert.match(settings.statusLine.command,/^'\/A folder\/node'/);
  assert.match(settings.statusLine.command,/it'\\''s-hud/);
  assert.deepEqual(args.slice(2),['-i','--settings','--model','Gemini 4 Argon']);
  const explicit = await withCliHud(['--settings={"statusLine":{"enabled":false},"model":"mine"}'],{valueFlags});
  assert.deepEqual(JSON.parse(explicit[1]),{statusLine:{enabled:false},model:'mine'});
});

test('settings files merge in place without rewriting the supplied file', async () => {
  const folder = await mkdtemp(join(tmpdir(),'agh-hud-settings-'));
  const file = join(folder,'settings.json');
  try {
    await writeFile(file,'{"permissions":{"allow":["Read"]}}');
    const args = await withCliHud(['--settings',file]);
    assert.deepEqual(JSON.parse(args[1]).permissions,{allow:['Read']});
    await assert.rejects(withCliHud(['--settings','{invalid}']),/无法读取 --settings/);
  } finally { await rm(folder,{recursive:true,force:true}); }
});
