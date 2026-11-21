import assert from 'node:assert/strict';
import test from 'node:test';
import { cliSiteReachesCodeSpace, partitionCliDisplaySites } from '../runtime/cli-code-space.mjs';
import { applyCliDisplayStrings } from '../runtime/cli-display.mjs';
import { pageAddress } from '../runtime/cli-localization.mjs';

test('larger CLI text drops only display sites that cannot reach the owned reservation', () => {
  const imageBase = 0x100000000;
  const early = {rva:15133832}, near = {rva:40000000};
  const space = {codeAddress:imageBase + 154199488, capacity:6720};
  const source = {imageBase, sites:[early, near], site:early};
  const result = partitionCliDisplaySites(source, space);
  assert.deepEqual(result.skippedSites, [early]);
  assert.deepEqual(result.plan.sites, [near]);
  assert.equal(result.plan.site, near);
  assert.equal(source.site, early);

  const sourceWithCall = {...near, callRva:near.rva + 8, targetAddress:imageBase + 220000000};
  assert.equal(cliSiteReachesCodeSpace(imageBase, sourceWithCall, space), false);
});

test('the distant ANSI entry replays its stack comparison and returns to the original conditional branch', () => {
  const imageBase = 0x100000000, codeAddress = imageBase + 0x9000220;
  const buffer = Buffer.alloc(1024);
  const prologue = [0xf9400b90, 0xd10143f1, 0xeb10023f];
  prologue.forEach((word, i) => buffer.writeUInt32LE(word, i * 4));
  const site = {rva:0x1030, fileOffset:0, word:prologue[0], pointerRegister:1, lengthRegister:2,
    wideEntry:Buffer.from(buffer.subarray(0,12))};
  const space = {codeAddress, capacity:512};
  const {plan, skippedSites} = partitionCliDisplaySites({imageBase, entries:[], sites:[site]}, space);
  assert.deepEqual(skippedSites, []);
  const placement = {...space, codeFileOffset:128, tableAddress:codeAddress + 4096};
  const target = (offset, pc) => pageAddress(buffer.readUInt32LE(offset), pc) + ((buffer.readUInt32LE(offset + 4) >>> 10) & 4095);
  const {codeSize} = applyCliDisplayStrings(buffer, plan, placement);
  const end = placement.codeFileOffset + codeSize;
  assert.equal(target(0, imageBase + site.rva), codeAddress);
  assert.equal(buffer.readUInt32LE(8), 0xd61f0120);
  assert.ok(buffer.subarray(end - 24, end - 12).equals(site.wideEntry));
  assert.equal(target(end - 12, codeAddress + codeSize - 12), imageBase + site.rva + 12);
  assert.equal(buffer.readUInt32LE(end - 4), 0xd61f0120);
  site.wideEntry.copy(buffer);
  buffer.writeUInt32LE(0, 8);
  assert.throws(() => applyCliDisplayStrings(buffer, plan, placement), /显示入口已变化/);
});
