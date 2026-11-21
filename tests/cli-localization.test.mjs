import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliCompatibilityError } from '../runtime/cli-compatibility.mjs';
import { collectCliLocalizationPatches, collectCliDisplayLabels,
  addressInstructions } from '../runtime/cli-localization.mjs';
import { applyCliDisplayStrings } from '../runtime/cli-display.mjs';

function fixture() {
  const buffer = Buffer.alloc(0x10000), imageBase = 0x100000000;
  const functions = new Map([
    ['google3/third_party/jetski/cli/model/model.settingFields.func1', {rva:0x100, fileOffset:0x100, size:40}],
    ['google3/third_party/jetski/cli/model/model.SettingsModel.renderFieldLines', {rva:0x1000, fileOffset:0x1000, size:0x1000}],
    ['runtime.concatstring2', {rva:0x3000, fileOffset:0x3000, size:16}],
    ['runtime.convTstring', {rva:0x3020, fileOffset:0x3020, size:16}],
  ].map(([name, fn]) => [name, {name, ...fn}]));
  // IDA's verified ARM64 copy/load/call shapes, relocated into this small image.
  // Both identities share a backing string, as Go's static strings can do.
  Buffer.from('210000b021000091e20300aab80080d23044c1ac104481ac3044c1ac104481ac180700d178ffffb5', 'hex').copy(buffer, 0x100);
  Buffer.from('fbc319917b734091631340a9e0031faa210000d021000491420080d29c070094', 'hex').copy(buffer, 0x1174);
  Buffer.from('fbc319917b734091631340a9e0031faa210000d021000491420080d281060094', 'hex').copy(buffer, 0x15e0);
  Buffer.from('fbc319917b734091600740a9e7050094', 'hex').copy(buffer, 0x1878);
  for (const [index, length] of [[0,6], [1,11]]) {
    buffer.writeBigUInt64LE(BigInt(imageBase + 0x7000), 0x5000 + index * 160);
    buffer.writeBigUInt64LE(BigInt(length), 0x5008 + index * 160);
  }
  buffer.write('Editor Mode', 0x7000);
  buffer.write('  ', 0x7100);
  buffer.write('Editor', 0x7200);
  buffer.write('Mine', 0x7300);
  const metadata = {imageBase, functions, ambiguousFunctions:new Set(),
    segments:[{address:imageBase, fileOffset:0, fileSize:buffer.length, protection:5}]};
  const dictionary = {strings:{'cli-ui:Editor':'编辑器', 'cli-ui:Editor Mode':'编辑模式'}};
  return {buffer, metadata, dictionary};
}

function install(f) {
  const plan = collectCliDisplayLabels(f.buffer, f.dictionary, f.metadata);
  let pool = 0xb000;
  const result = applyCliDisplayStrings(f.buffer, plan, {
    codeAddress:f.metadata.imageBase + 0x9000, codeFileOffset:0x9000, capacity:4096,
    tableAddress:f.metadata.imageBase + 0xa000,
    allocateString(bytes) { const offset = pool; bytes.copy(f.buffer, offset); pool += bytes.length; return f.metadata.imageBase + offset; },
  });
  result.table.copy(f.buffer, 0xa000);
  return {plan, result};
}

test('display translation keeps the original labels used for settings identity', () => {
  const f = fixture(), before = Buffer.from(f.buffer);
  const {plan, result} = install(f);
  assert.equal(result.translated, 2);
  assert.equal(plan.missing.length, 0);
  assert.deepEqual(plan.entries.map(label => [label.original, label.sourceRva, label.sourceLength]), [
    ['Editor',0x7000,6], ['Editor Mode',0x7000,11],
  ]);
  assert.ok(f.buffer.subarray(0x5000,0x5140).equals(before.subarray(0x5000,0x5140)), 'identity table remains unchanged');
  assert.ok(f.buffer.subarray(0x7000,0x7304).equals(before.subarray(0x7000,0x7304)), 'English labels and custom content remain unchanged');
  for (const site of plan.sites) {
    assert.notEqual(f.buffer.readUInt32LE(site.fileOffset), site.word);
    assert.ok(f.buffer.subarray(site.fileOffset + 4, site.fileOffset + 24).equals(before.subarray(site.fileOffset + 4, site.fileOffset + 24)), 'Go call and continuation stay intact');
  }
});

test('settings display loads follow the shared label when the renderer layout moves', () => {
  const {buffer, dictionary, metadata} = fixture();
  const displacement = 0x40;
  const blocks = [[0x1174,32], [0x15e0,32], [0x1878,16]];
  for (const [start, length] of blocks) {
    const moved = start + displacement;
    buffer.copy(buffer, moved, start, start + length);
    buffer.fill(0, start, start + length);
    buffer.writeUInt32LE(0x9123c3fb, moved); // ADD X27,SP,#0x8f0
    const call = moved + length - 4;
    buffer.writeUInt32LE(buffer.readUInt32LE(call) - displacement / 4, call);
  }
  const plan = collectCliDisplayLabels(buffer, dictionary, metadata);
  assert.deepEqual(plan.sites.map(site => site.fileOffset), blocks.map(([start]) => start + displacement + 8));
  buffer.writeUInt32LE(0x9119c3fb, blocks[2][0] + displacement);
  assert.throws(() => collectCliDisplayLabels(buffer, dictionary, metadata), CliCompatibilityError);
});

test('verified command descriptions survive other incompatible fixed text sources', () => {
  const {buffer, dictionary, metadata} = fixture();
  const commandPrefix = 'google3/third_party/jetski/cli/commands/commands.';
  const mainSettings = 'google3/third_party/jetski/cli/model/model.settingFields.func1';
  const supported = commandPrefix + 'Editor.Description', ambiguous = commandPrefix + 'Another.Description';
  for (const [name, rva] of [[supported,0x3100], [ambiguous,0x3120]]) {
    metadata.functions.set(name, {name, rva, fileOffset:rva, size:16});
    [...addressInstructions(0, metadata.imageBase + 0x7200, metadata.imageBase + rva), 0xd28000c1, 0xd65f03c0]
      .forEach((word, index) => buffer.writeUInt32LE(word, rva + index * 4));
  }
  metadata.ambiguousFunctions.add(ambiguous);
  buffer.writeUInt32LE(0xd503201f, metadata.functions.get(mainSettings).fileOffset);
  const plan = collectCliLocalizationPatches(buffer, dictionary, metadata);
  assert.deepEqual(plan.patches.map(patch => [patch.functionName,patch.translated]), [[supported,'编辑器']]);
  assert.deepEqual(plan.unsupported, [ambiguous,mainSettings]);
});

test('settings sources include the live array tail and external singleton for labels and hints', () => {
  const f = fixture(), {buffer, metadata, dictionary} = f;
  const prefix = 'google3/third_party/jetski/cli/model/model.';
  const main = metadata.functions.get(prefix + 'settingFields.func1');
  const copy = Buffer.from(buffer.subarray(main.fileOffset, main.fileOffset + 40));
  buffer.copy(buffer, 0xa000, 0x5000, 0x5140);
  Object.assign(main, {rva:0x4000, fileOffset:0x4000, size:0x1450});
  copy.copy(buffer, main.fileOffset);
  const writeAddress = (offset, register, target) => addressInstructions(register,
    metadata.imageBase + target, metadata.imageBase + offset)
    .forEach((word, index) => buffer.writeUInt32LE(word, offset + index * 4));
  writeAddress(main.fileOffset, 1, 0xa000);
  const live = {name:prefix + 'liveSettingFields', rva:0x6000, fileOffset:0x6000, size:0x268};
  metadata.functions.set(live.name, live);
  metadata.functions.set('runtime.newobject', {name:'runtime.newobject', rva:0x3040, fileOffset:0x3040, size:16});
  const liveWords = [0,0,0xaa0003e2,0xb27e07f8,0xacc14430,0xac814410,0xacc14430,0xac814410,
    0xd1000718,0xb5ffff78,0xad404430,0xad004410,0xf94067e1,0xf9004441,0,0,
    (0x94000000 | (((0x3040 - (live.rva + 0x264)) / 4) & 0x3ffffff)) >>> 0];
  liveWords.forEach((word, index) => buffer.writeUInt32LE(word, live.fileOffset + 0x224 + index * 4));
  writeAddress(live.fileOffset + 0x224, 1, 0xa400);
  writeAddress(live.fileOffset + 0x25c, 0, 0x3100);
  const singletonWords = [0x910463e1,0,0,0xad404450,0xad004430,0xad414450,0xad014430,
    0xad424450,0xad024430,0xad434450,0xad034430,0xad444450,0xad044430];
  singletonWords.forEach((word, index) => buffer.writeUInt32LE(word, main.fileOffset + 0x141c + index * 4));
  writeAddress(main.fileOffset + 0x1420, 2, 0xa800);
  let pool = 0xb000;
  const put = (offset, original, translated) => {
    const bytes = Buffer.from(original);
    bytes.copy(buffer, pool);
    buffer.writeBigUInt64LE(BigInt(metadata.imageBase + pool), offset);
    buffer.writeBigUInt64LE(BigInt(bytes.length), offset + 8);
    dictionary.strings['cli-ui:' + original] = translated;
    pool += bytes.length + 1;
  };
  const labels = ['Voice Mode','Voice Mode › Voice','Voice Mode › Full Duplex',
    'Voice Mode › Volume','Voice Mode › Playback Speed'];
  for (const [index, label] of labels.entries()) {
    put(0xa400 + index * 160, label, `语音设置${index}`);
    if (index < 4) put(0xa410 + index * 160, `Voice setting hint ${index}`, `语音说明${index}`);
  }
  put(0xa800, 'Use AI Credits', '使用 AI 点数');
  put(0xa810, 'Use AI credits after quota', '额度用尽后使用 AI 点数');
  const labelPlan = collectCliDisplayLabels(buffer, dictionary, metadata);
  assert.deepEqual(labelPlan.entries.map(label => label.original), ['Editor','Editor Mode','Use AI Credits',...labels]);
  const hintPlan = collectCliLocalizationPatches(buffer, dictionary, metadata);
  assert.equal(hintPlan.missing.length, 0);
  assert.deepEqual(hintPlan.patches.map(patch => [patch.original,patch.fileOffset]), [
    ['Use AI credits after quota',0xa810],
    ...[0,1,2,3].map(index => [`Voice setting hint ${index}`,0xa410 + index * 160]),
  ]);
  buffer.writeUInt32LE(0xd503201f, live.fileOffset + 0x250);
  const partial = collectCliLocalizationPatches(buffer, dictionary, metadata);
  assert.deepEqual(partial.patches.map(patch => patch.original), ['Use AI credits after quota']);
  assert.deepEqual(partial.unsupported, [live.name]);
  assert.throws(() => collectCliDisplayLabels(buffer, dictionary, metadata), /settings table copy changed/);
});

test('changed display loads and callees are rejected before writing native code', () => {
  const f = fixture();
  f.buffer.writeUInt32LE(0xa9400760, 0x117c);
  assert.throws(() => collectCliDisplayLabels(f.buffer, f.dictionary, f.metadata), /load at renderer/);
  const g = fixture();
  g.buffer.writeUInt32LE(0x94000000, 0x1884);
  assert.throws(() => collectCliDisplayLabels(g.buffer, g.dictionary, g.metadata), /load at renderer/);
  const h = fixture(), plan = collectCliDisplayLabels(h.buffer, h.dictionary, h.metadata), before = Buffer.from(h.buffer);
  let allocations = 0;
  assert.throws(() => applyCliDisplayStrings(h.buffer, plan, {codeAddress:0x100009000, tableAddress:0x10000a000,
    codeFileOffset:0x9000, capacity:128, allocateString() { allocations++; return 0x10000b000; }}), /显示代码空间不足/);
  assert.equal(allocations, 0);
  assert.ok(h.buffer.equals(before));
});

test('adding settings labels only grows the read-only table within this instruction range', () => {
  const small = install(fixture()).result;
  const f = fixture();
  const plan = collectCliDisplayLabels(f.buffer, f.dictionary, f.metadata);
  for (let i = 0; i < 24; i++) {
    plan.entries.push({original:'Editor', translated:'编辑器', sourceRva:0x900 + i * 8, sourceLength:6});
  }
  const larger = applyCliDisplayStrings(f.buffer, plan, {codeAddress:0x100009000, codeFileOffset:0x9000,
    capacity:small.codeSize, tableAddress:0x10000a000, allocateString:() => 0x10000b000});
  assert.equal(larger.codeSize, small.codeSize);
  assert.equal(larger.table.length - small.table.length, 24 * 16);
});

test('ARM64 thunks preserve flags, other registers and source identities at all three sites', {
  skip:process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  const f = fixture(), {plan} = install(f);
  // Replace only the harness continuation with a register-return probe, after
  // validating the real caller profile. No Go code runs in this owned fixture.
  for (const site of plan.sites) {
    if (site.pointerRegister === 3) {
      Buffer.from('e00303aae10304aac0035fd6', 'hex').copy(f.buffer, site.fileOffset + 4);
    } else f.buffer.writeUInt32LE(0xd65f03c0, site.fileOffset + 4);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-label-thunk-'));
  try {
    const source = path.join(directory, 'probe.c'), executable = path.join(directory, 'probe');
    const binary = path.join(directory, 'image.bin');
    fs.writeFileSync(binary, f.buffer);
    fs.writeFileSync(source, String.raw`
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <libkern/OSCacheControl.h>

__attribute__((naked)) static void probe(void *entry, uint64_t *header, uint64_t *out) {
  __asm__(
    "stp x29,x30,[sp,#-32]!\n"
    "stp x19,x27,[sp,#16]\n"
    "mov x29,sp\n"
    "mov x19,x2\n"
    "mov x27,x1\n"
    "mov x2,#0x52\n"
    "mov x5,#0x55\n"
    "mov x15,#0x5f\n"
    "mov x17,#0x60000000\n"
    "msr nzcv,x17\n"
    "blr x0\n"
    "stp x0,x1,[x19]\n"
    "str x2,[x19,#16]\n"
    "str x5,[x19,#24]\n"
    "str x15,[x19,#32]\n"
    "str x27,[x19,#40]\n"
    "mrs x17,nzcv\n"
    "str x17,[x19,#48]\n"
    "ldp x19,x27,[sp,#16]\n"
    "ldp x29,x30,[sp],#32\n"
    "ret\n"
  );
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1], O_RDONLY);
  struct stat st;
  if (fd < 0 || fstat(fd, &st)) return 3;
  uint8_t *image = mmap(NULL, st.st_size, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
  if (image == MAP_FAILED) return 4;
  close(fd);
  sys_icache_invalidate(image, st.st_size);
  if (mprotect(image, st.st_size, PROT_READ | PROT_EXEC)) return 5;
  const size_t sites[] = {0x117c, 0x15e8, 0x1880};
  const uint64_t cases[][4] = {
    {0x7000,6,0xb000,9}, {0x7000,11,0xb009,12},
    {0x7000,5,0x7000,5}, {0x7200,6,0x7200,6}, {0x7300,4,0x7300,4}
  };
  unsigned count = 0;
  for (size_t s = 0; s < 3; s++) for (size_t c = 0; c < 5; c++) {
    uint64_t header[] = {(uint64_t)(image + cases[c][0]), cases[c][1]}, out[7] = {0};
    probe(image + sites[s], header, out);
    if (out[0] != (uint64_t)(image + cases[c][2]) || out[1] != cases[c][3] ||
        out[2] != 0x52 || out[3] != 0x55 || out[4] != 0x5f ||
        out[5] != (uint64_t)header || out[6] != 0x60000000 ||
        header[0] != (uint64_t)(image + cases[c][0]) || header[1] != cases[c][1]) {
      fprintf(stderr,"site %zu case %zu register or identity mismatch\n",s,c);
      return 6;
    }
    count++;
  }
  if (memcmp(image + 0x7000,"Editor Mode",11) ||
      memcmp(image + 0xb000,"编辑器",9) || memcmp(image + 0xb009,"编辑模式",12)) return 7;
  printf("{\"nativeCases\":%u,\"flagsPreserved\":true,\"identitiesPreserved\":true}\n",count);
  munmap(image, st.st_size);
  return 0;
}
`);
    execFileSync('xcrun', ['clang','-arch','arm64','-O0',source,'-o',executable], {stdio:'pipe'});
    const result = JSON.parse(execFileSync(executable, [binary], {encoding:'utf8'}));
    assert.deepEqual(result, {nativeCases:15, flagsPreserved:true, identitiesPreserved:true});
  } finally { fs.rmSync(directory, {recursive:true, force:true}); }
});

test('quota model-list prefix keeps arbitrary model names and native ANSI formatting', {
  skip:process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const { applyCliStatusLocalizationPatches } = await import('../runtime/cli-status-localization.mjs');
  const buffer = Buffer.alloc(0x10000), imageBase = 0x100000000;
  // This owned call frame invokes the real generated thunk, then records the
  // five Go string arguments in place of allocating a concatenated Go string.
  buffer.writeUInt32LE(0xa9bf7bfd,0x80); // stp x29,x30,[sp,#-16]!
  buffer.writeUInt32LE(0x1400001f,0x84); // b 0x100
  buffer.writeUInt32LE(0xa8c17bfd,0x10c); // ldp x29,x30,[sp],#16
  buffer.writeUInt32LE(0xd65f03c0,0x110);
  [0xa9000801,0xa9011003,0xa9021805,0xa9032007,0xa9042809,0xd65f03c0]
    .forEach((word,index) => buffer.writeUInt32LE(word,0x3000 + index * 4));
  buffer.write('  ',0x7000);buffer.write('\n\n',0x7100);
  const translated = '组内模型：';buffer.write(translated,0x7200);
  const patch = {kind:'quota-description-prefix',original:'Models within this group: ',translated,
    rva:0x100,fileOffset:0x100,callRva:0x108,callFileOffset:0x108,
    targetAddress:imageBase + 0x3000,indentAddress:imageBase + 0x7000,
    contextFileOffset:0x100,originalContext:Buffer.from(buffer.subarray(0x100,0x10c))};
  const plan = {imageBase,patches:[patch],missing:[],casePatches:[]};
  const result = applyCliStatusLocalizationPatches(buffer,plan,() => imageBase + 0x7200,
    {codeAddress:imageBase + 0x4000,codeFileOffset:0x4000,capacity:2048});
  assert.equal(result.translated,1);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'agy-quota-prefix-'));
  try {
    const binary = path.join(directory,'image.bin'),source = path.join(directory,'probe.c'),executable = path.join(directory,'probe');
    fs.writeFileSync(binary,buffer);
    fs.writeFileSync(source,String.raw`
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <libkern/OSCacheControl.h>
__attribute__((naked)) static void probe(void *entry, uint64_t *out, const char *text, size_t length, const char *newline) {
  __asm__(
    "stp x29,x30,[sp,#-16]!\n"
    "mov x29,sp\n"
    "mov x16,x0\n"
    "mov x0,x1\n"
    "mov x5,x4\n"
    "mov x4,x3\n"
    "mov x3,x2\n"
    "mov x2,#2\n"
    "mov x6,#2\n"
    "blr x16\n"
    "ldp x29,x30,[sp],#16\n"
    "ret\n"
  );
}
int main(int argc,char **argv) {
  if(argc != 2)return 2;
  int fd=open(argv[1],O_RDONLY);struct stat st;
  if(fd<0||fstat(fd,&st))return 3;
  uint8_t *image=mmap(NULL,st.st_size,PROT_READ|PROT_WRITE,MAP_PRIVATE,fd,0);
  close(fd);if(image==MAP_FAILED)return 4;
  sys_icache_invalidate(image,st.st_size);
  if(mprotect(image,st.st_size,PROT_READ|PROT_EXEC))return 5;
  const char *inputs[]={
    "Models within this group: Any Model 9, 自定义模型",
    "\x1b[90mModels within this group: Future Model\x1b[0m",
    "\x1b[1m\x1b[38;2;200;200;200mModels within this group: A\x1b[0m",
    "Custom group description",
    "Models within this group:",
    "\x1b[31GModels within this group: unrecognized escape",
    "\x1b[",
  };
  const char *expected[]={
    "  组内模型：Any Model 9, 自定义模型\n\n",
    "  \x1b[90m组内模型：Future Model\x1b[0m\n\n",
    "  \x1b[1m\x1b[38;2;200;200;200m组内模型：A\x1b[0m\n\n",
    "  Custom group description\n\n",
    "  Models within this group:\n\n",
    "  \x1b[31GModels within this group: unrecognized escape\n\n",
    "  \x1b[\n\n",
  };
  for(size_t c=0;c<sizeof(inputs)/sizeof(*inputs);c++) {
    char *text=strdup(inputs[c]);uint64_t out[10]={0};
    probe(image+0x80,out,text,strlen(text),(const char*)image+0x7100);
    char joined[1024];size_t length=0;
    for(size_t i=0;i<5;i++) {
      if(out[i*2+1] > sizeof(joined)-length-1)return 6;
      if(out[i*2+1])memcpy(joined+length,(void*)out[i*2],out[i*2+1]);
      length+=out[i*2+1];
    }
    joined[length]=0;
    if(strcmp(joined,expected[c])||strcmp(text,inputs[c])) {
      fprintf(stderr,"case %zu mismatch: %s\n",c,joined);return 7;
    }
    free(text);
  }
  puts("{\"nativeCases\":7,\"modelNamesPreserved\":true,\"ansiPreserved\":true}");
  munmap(image,st.st_size);return 0;
}
`);
    execFileSync('clang',['-arch','arm64','-O0',source,'-o',executable]);
    const output = execFileSync(executable,[binary],{encoding:'utf8'});
    assert.deepEqual(JSON.parse(output),{nativeCases:7,modelNamesPreserved:true,ansiPreserved:true});
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
