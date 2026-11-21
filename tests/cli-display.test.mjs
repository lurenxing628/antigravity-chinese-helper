import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyCliDisplayStrings, applyCliContentDisplayStrings,
  collectCliDisplayStrings, collectCliSettingsDisplayStrings } from '../runtime/cli-display.mjs';

test('a missing specialized renderer keeps the common string display path usable', () => {
  const imageBase = 0x100000000, buffer = Buffer.alloc(512);
  const name = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render';
  const renderer = {rva:0,fileOffset:0,size:16}, join = {rva:0x40};
  [0x94000010,0x910003fb,0xa9007f7f,0xf90003ff].forEach((word, i) => buffer.writeUInt32LE(word,i*4));
  buffer.write('Help',0x80);
  const metadata = {imageBase,functions:new Map([[name,renderer],['strings.Join',join]]),
    segments:[{name:'__TEXT',sections:[{name:'__rodata',fileOffset:0x80,address:imageBase+0x80,size:4}]}]};
  const plan = collectCliDisplayStrings(buffer,{'Help':'帮助'},metadata);
  assert.deepEqual(plan.sites.map(site => site.rva),[4]);
  assert.deepEqual(plan.entries.map(entry => entry.original),['Help']);
  assert.ok(plan.unsupported.includes('快捷键说明'));
});

test('shortcut descriptions follow their rune conversion across frame layouts', () => {
  const imageBase = 0x100000000, buffer = Buffer.alloc(0x900);
  const name = 'google3/third_party/jetski/cli/model/model.HelpModel.renderShortcutsTab';
  const shortcuts = {rva:0x100,fileOffset:0x100,size:0x500}, stringRunes = {rva:0x600};
  const metadata = {imageBase,functions:new Map([[name,shortcuts],['runtime.stringtoslicerune',stringRunes]]),
    segments:[{name:'__TEXT',sections:[{name:'__rodata',fileOffset:0x800,address:imageBase+0x800,size:17}]}]};
  buffer.write('Open shortcut tab',0x800);
  for (const [call, keyLength, keyPointer, descriptionLength, descriptionPointer] of [
    [0x35c,0xf90237e5,0xf9025be4,0xf90233e2,0xf9028fe1],
    [0x370,0xf9023be5,0xf9025fe4,0xf90237e2,0xf90293e1],
  ]) {
    const start = shortcuts.fileOffset + call - 0x20;
    const words = [0x8b0714c3,0xa9401464,keyLength,keyPointer,0xa9410861,descriptionLength,descriptionPointer,0x910cc3e0,
      0x94000000 + (stringRunes.rva - shortcuts.rva - call) / 4];
    buffer.fill(0,shortcuts.fileOffset,shortcuts.fileOffset + shortcuts.size);
    words.forEach((word,index) => buffer.writeUInt32LE(word,start + index * 4));
    const plan = collectCliDisplayStrings(buffer,{'Open shortcut tab':'打开快捷键页'},metadata);
    assert.deepEqual(plan.sites,[{rva:shortcuts.rva + call - 0x10,fileOffset:start + 0x10,word:0xa9410861,
      pointerRegister:1,lengthRegister:2,replayFirst:true,role:'快捷键说明'}]);
    assert.deepEqual(plan.entries.map(entry => entry.translated),['打开快捷键页']);
  }
});

function settingsFixture({ matched = 0x810, frameShift = 0 } = {}) {
  const imageBase = 0x100000000, buffer = Buffer.alloc(0x20000);
  const name = 'google3/third_party/jetski/cli/model/model.SettingsModel.renderFieldLines';
  const fn = {name,rva:0x100,fileOffset:0x100,size:5056};
  const words = [0x912b83fb,0x9140537b,0xa9400b61,0x912b43fb,0x9140537b,
    0xa9401b65,0xf100005f,0x9a861044,0x9a851023];
  const equal = {name:'runtime.memequal', rva:0x6000};
  const equalCall = matched - 0x2c;
  buffer.writeUInt32LE(0x94000000 + (equal.rva - fn.rva - equalCall) / 4, fn.fileOffset + equalCall);
  buffer.writeUInt32LE(0x37000140, fn.fileOffset + equalCall + 4);
  words[0] += frameShift * 1024;
  words[3] += frameShift * 1024;
  words.forEach((word,index) => buffer.writeUInt32LE(word,fn.fileOffset + matched + index * 4));
  const hintName = 'google3/third_party/jetski/cli/model/model.SettingsModel.wrapHint';
  const hint = {name:hintName,rva:0x3000,fileOffset:0x3000,size:496};
  [0xf9400b90,0xd12783f1,0xeb10023f,0x54000e09].forEach((word,index) => buffer.writeUInt32LE(word,hint.fileOffset + index * 4));
  const metadata = {imageBase,functions:new Map([[name,fn],[hintName,hint],[equal.name,equal]]),ambiguousFunctions:new Set()};
  const dictionary = {strings:{'cli-ui:slow':'慢速','cli-ui:colorblind-friendly dark':'色盲友好深色',
    'cli-ui:My editor':'我的编辑器'}};
  return {imageBase,buffer,metadata,dictionary};
}

test('settings content translation is limited to recognized option display text', () => {
  const f = settingsFixture(), before = Buffer.from(f.buffer);
  const plan = collectCliSettingsDisplayStrings(f.buffer,f.dictionary,f.metadata);
  assert.deepEqual(plan.entries.map(({original,translated}) => [original,translated]),
    [['colorblind-friendly dark','色盲友好深色'],['slow','慢速']]);
  assert.equal(plan.sites[0].rva,0x930,'unmatched/custom values jump past this site');
  assert.equal(plan.sites[0].pointerRegister,3);
  assert.equal(plan.sites[0].lengthRegister,4);
  assert.ok(f.buffer.equals(before));
});

test('option layout follows the built-in match and preserves hints when that match changes', () => {
  const f = settingsFixture({matched:0x818, frameShift:0x280});
  const collect = () => collectCliSettingsDisplayStrings(f.buffer,f.dictionary,f.metadata);
  assert.equal(collect().sites[0].rva,0x938);
  f.buffer.writeUInt32LE(0x37000141,0x100 + 0x818 - 0x28); // different condition register
  const plan = collect();
  assert.deepEqual(plan.unsupported,['设置选项']);
  assert.deepEqual(plan.sites.map(site => site.rva),[0x3000]);
  assert.equal(plan.entries.some(entry => entry.original === 'slow'),false);
});

test('settings heap values translate without modifying their original string or other registers', {
  skip:process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  const directory = mkdtempSync(join(tmpdir(),'agy-settings-display-'));
  try {
    const f = settingsFixture(), plan = collectCliSettingsDisplayStrings(f.buffer,f.dictionary,f.metadata);
    const site = plan.sites[0];
    f.buffer.writeUInt32LE(0xd65f03c0,site.fileOffset + 4);
    let pool = 0x7000;
    const result = applyCliContentDisplayStrings(f.buffer,plan,{
      codeAddress:f.imageBase + 0x9000,codeFileOffset:0x9000,capacity:4096,
      tableAddress:f.imageBase + 0xb000,
      allocateString(bytes) { const offset = pool; bytes.copy(f.buffer,pool); pool += bytes.length + 1; return f.imageBase + offset; },
    });
    result.table.copy(f.buffer,0xb000);
    const imagePath = join(directory,'image.bin'),sourcePath = join(directory,'probe.c'),executable = join(directory,'probe');
    writeFileSync(imagePath,f.buffer);
    writeFileSync(sourcePath,String.raw`
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <libkern/OSCacheControl.h>
__attribute__((naked)) static void probe(void *entry, const char *text, uint64_t length, uint64_t *out) {
  __asm__(
    "stp x29,x30,[sp,#-32]!\n"
    "stp x19,x20,[sp,#16]\n"
    "mov x29,sp\n"
    "mov x19,x3\n"
    "mov x20,x0\n"
    "mov x0,#0x50\n"
    "mov x4,x2\n"
    "mov x5,#0x55\n"
    "mov x6,#0x56\n"
    "mov x7,#0x57\n"
    "mov x8,#0x58\n"
    "cmp x2,#0\n"
    "blr x20\n"
    "stp x3,x4,[x19]\n"
    "stp x0,x1,[x19,#16]\n"
    "stp x2,x5,[x19,#32]\n"
    "stp x6,x7,[x19,#48]\n"
    "str x8,[x19,#64]\n"
    "mrs x17,nzcv\n"
    "str x17,[x19,#72]\n"
    "ldp x19,x20,[sp,#16]\n"
    "ldp x29,x30,[sp],#32\n"
    "ret\n"
  );
}
int main(int argc,char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1],O_RDONLY); struct stat st;
  if (fd < 0 || fstat(fd,&st)) return 3;
  uint8_t *image = mmap(NULL,st.st_size,PROT_READ | PROT_WRITE,MAP_PRIVATE,fd,0);
  if (image == MAP_FAILED) return 4;
  close(fd); sys_icache_invalidate(image,st.st_size);
  if (mprotect(image,st.st_size,PROT_READ | PROT_EXEC)) return 5;
  const char *english[] = {"slow","colorblind-friendly dark","slow.json","colorblind-friendly dark!","slo"};
  const char *chinese[] = {"慢速","色盲友好深色"};
  for (unsigned i = 0; i < 5; i++) {
    char *text = strdup(english[i]); if (!text) return 6;
    uint64_t out[10] = {0}; size_t length = strlen(text);
    probe(image + 0x930,text,length,out);
    const char *want = i < 2 ? chinese[i] : text;
    if (out[1] != strlen(want) || memcmp((void *)out[0],want,strlen(want)) ||
        out[2] != 0x50 || out[3] != (uint64_t)text || out[4] != length || out[5] != 0x55 ||
        out[6] != 0x56 || out[7] != 0x57 || out[8] != 0x58 || out[9] != 0x20000000 ||
        strcmp(text,english[i]) || (i >= 2 && out[0] != (uint64_t)text)) return 7;
    free(text);
  }
  puts("5 settings display cases passed");
  munmap(image,st.st_size); return 0;
}
`);
    execFileSync('xcrun',['clang','-arch','arm64','-O0',sourcePath,'-o',executable],{stdio:'pipe'});
    assert.match(execFileSync(executable,[imagePath],{encoding:'utf8'}),/5 settings display cases passed/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('server notices match complete heap text only at their display sites', {
  skip:process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'agy-notice-display-'));
  try {
    const imageBase = 0x100000000, buffer = Buffer.alloc(0x20000);
    let pool = 0x7000;
    const allocateString = bytes => {
      const offset = pool;
      bytes.copy(buffer, pool); pool += bytes.length + 1;
      return imageBase + offset;
    };
    const pairs = [['Auto is now the default agent mode', 'Auto 已成为默认代理模式'],
      ['Press Shift+Tab to switch agent modes, or change Agent Mode in /config.', '按 Shift+Tab 切换代理模式，也可在 /config 中修改代理模式。']];
    const entries = pairs.map(([original, translated]) => ({original, translated,
      sourceRva:allocateString(Buffer.from(original)) - imageBase, sourceLength:Buffer.byteLength(original)}));
    for (const [index, matchContent] of [true, false].entries()) {
      const site = {rva:0x1000 + index * 0x1000, fileOffset:0x1000 + index * 0x1000,
        word:0xa9401ca6, pointerRegister:6, lengthRegister:7, replayFirst:true};
      buffer.writeUInt32LE(site.word, site.fileOffset); // ldp x6,x7,[x5]
      buffer.writeUInt32LE(0xd65f03c0, site.fileOffset + 4);
      const result = applyCliDisplayStrings(buffer, {imageBase, entries, sites:[site], matchContent}, {
        codeAddress:imageBase + 0x9000 + index * 0x1000, codeFileOffset:0x9000 + index * 0x1000,
        capacity:4096, tableAddress:imageBase + 0xb000 + index * 0x1000, allocateString,
      });
      result.table.copy(buffer, 0xb000 + index * 0x1000);
    }
    const imagePath = join(directory, 'image.bin'), sourcePath = join(directory, 'probe.c');
    const executable = join(directory, 'probe');
    writeFileSync(imagePath, buffer);
    writeFileSync(sourcePath, String.raw`
#include <fcntl.h>
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
    "stp x19,x20,[sp,#16]\n"
    "mov x29,sp\n"
    "mov x19,x2\n"
    "mov x20,x0\n"
    "mov x5,x1\n"
    "mov x0,#0x50\n"
    "mov x1,#0x51\n"
    "mov x2,#0x52\n"
    "mov x3,#0x53\n"
    "mov x4,#0x54\n"
    "mov x8,#0x58\n"
    "mov x17,#0x60000000\n"
    "msr nzcv,x17\n"
    "blr x20\n"
    "stp x6,x7,[x19]\n"
    "stp x0,x1,[x19,#16]\n"
    "stp x2,x3,[x19,#32]\n"
    "stp x4,x5,[x19,#48]\n"
    "str x8,[x19,#64]\n"
    "mrs x17,nzcv\n"
    "str x17,[x19,#72]\n"
    "ldp x19,x20,[sp,#16]\n"
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
  close(fd); sys_icache_invalidate(image, st.st_size);
  if (mprotect(image, st.st_size, PROT_READ | PROT_EXEC)) return 5;
  const char *english[] = {
    "Auto is now the default agent mode",
    "Press Shift+Tab to switch agent modes, or change Agent Mode in /config.",
    "Auto is now the default agent mod!", "User notice", "Auto is now the default agent mode"
  };
  const char *chinese[] = {
    "Auto 已成为默认代理模式", "按 Shift+Tab 切换代理模式，也可在 /config 中修改代理模式。"
  };
  unsigned checked = 0;
  for (unsigned mode = 0; mode < 2; mode++) for (unsigned c = 0; c < 5; c++) {
    char *text = strdup(english[c]);
    if (!text) return 6;
    uint64_t length = strlen(text) - (c == 4 ? 1 : 0);
    uint64_t header[] = {(uint64_t)text, length, 0x12345678}, before[3], out[10] = {0};
    memcpy(before, header, sizeof(header));
    probe(image + (mode ? 0x2000 : 0x1000), header, out);
    const int matched = !mode && c < 2;
    const char *expected = matched ? chinese[c] : text;
    const size_t expected_length = matched ? strlen(expected) : length;
    if (out[1] != expected_length || memcmp((void *)out[0], expected, expected_length) ||
        (!matched && out[0] != (uint64_t)text) ||
        out[2] != 0x50 || out[3] != 0x51 || out[4] != 0x52 || out[5] != 0x53 || out[6] != 0x54 ||
        out[7] != (uint64_t)header || out[8] != 0x58 || (!mode && out[9] != 0x60000000) ||
        memcmp(before, header, sizeof(header)) || strcmp(text, english[c])) {
      fprintf(stderr,"notice mode %u case %u mismatch\n",mode,c); return 7;
    }
    free(text); checked++;
  }
  printf("%u notice display cases passed\n", checked);
  munmap(image, st.st_size);
  return 0;
}
`);
    execFileSync('xcrun', ['clang', '-arch', 'arm64', '-O0', sourcePath, '-o', executable], {stdio:'pipe'});
    assert.match(execFileSync(executable, [imagePath], {encoding:'utf8'}), /10 notice display cases passed/);
  } finally { rmSync(directory, {recursive:true, force:true}); }
});
