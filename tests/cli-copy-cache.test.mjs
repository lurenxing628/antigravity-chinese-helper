import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCachedCliCopy } from '../runtime/cli-copy-cache.mjs';

const script = (version, language) => `#!/bin/sh\n# ${language}\nprintf '%s\\n' '${version}'\n`;

async function executable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o700);
}

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'agy-cache-test-'));
  t.after(() => rm(stateDir, {recursive:true, force:true}));
  const officialCliPath = join(stateDir, 'official');
  await executable(officialCliPath, script('1.0.0', 'official'));
  return {stateDir, officialCliPath, inputs:{dictionary:1, adapter:1, mainTokens:null, contextOverridesEnabled:false},
    async build({destinationPath, version}) {
      await executable(destinationPath, script(version, '中文'));
      return {localization:{translated:14}};
    }};
}

test('rebuilds legacy and overwritten same-version copies; only verified copies can be fallback', async t => {
  const options = {...await fixture(t), allowFallback:true};
  const folder = join(options.stateDir, 'builds', '1.0.0');
  await mkdir(folder, {recursive:true});
  await executable(join(folder, 'agy'), script('1.0.0', 'overwritten'));
  await writeFile(join(folder, 'copy.json'), '{"localization":{"translated":14}}');
  const first = await prepareCachedCliCopy(options);
  const intact = await prepareCachedCliCopy({...options, build:() => assert.fail('should have reused cache')});
  assert.equal(intact.binaryPath, first.binaryPath);
  await executable(first.binaryPath + '.replacement', script('1.0.0', 'official'));
  await rename(first.binaryPath + '.replacement', first.binaryPath);
  const repaired = await prepareCachedCliCopy(options);
  assert.notEqual(first.binaryPath, repaired.binaryPath);
  assert.match(await readFile(join(folder, 'agy'), 'utf8'), /中文/);
  await executable(options.officialCliPath, script('1.1.0', 'official'));
  const incompatible = new Error('layout changed');
  const failure = {...options, build:() => { throw incompatible; }, isIncompatible:error => error === incompatible};
  await assert.rejects(prepareCachedCliCopy({...failure, allowFallback:false}), incompatible);
  const previous = await prepareCachedCliCopy({...failure, allowFallback:true});
  assert.equal(previous.binaryPath, repaired.binaryPath);
  assert.equal(previous.fallback.version, '1.1.0');
  const relocated = join(options.stateDir, 'official-new-location');
  await rename(options.officialCliPath, relocated);
  failure.officialCliPath = relocated;
  assert.equal((await prepareCachedCliCopy(failure)).binaryPath, repaired.binaryPath);
  await executable(repaired.binaryPath, script('1.0.0', 'official'));
  await assert.rejects(prepareCachedCliCopy({...failure, allowFallback:true}), incompatible);
});

test('a source replaced during preparation is retried under its actual version', async t => {
  const options = await fixture(t);
  const builtVersions = [];
  const result = await prepareCachedCliCopy({...options, async build(request) {
    builtVersions.push(request.version);
    if (request.version === '1.0.0') await executable(options.officialCliPath, script('1.1.0', 'official'));
    return options.build(request);
  }});
  assert.deepEqual(builtVersions, ['1.0.0', '1.1.0']);
  assert.equal(result.version, '1.1.0');
});

test('simultaneous publishers leave one matching binary and receipt and both launched candidates usable', async t => {
  const options = await fixture(t);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let arrived = 0;
  const race = {...options, async build(request) {
    if (++arrived === 2) release();
    await barrier;
    return options.build(request);
  }};
  const candidates = await Promise.all([prepareCachedCliCopy(race), prepareCachedCliCopy(race)]);
  for (const copy of candidates) assert.match(await readFile(copy.binaryPath, 'utf8'), /中文/);
  const cached = await prepareCachedCliCopy({...options, build:() => assert.fail('incomplete publication')});
  assert.ok(candidates.some(candidate => candidate.binaryPath === cached.binaryPath));
});

test('an English candidate cannot be promoted or used in place of a screen-verified fallback', async t => {
  const options = {...await fixture(t), allowFallback:true};
  const unverified = await prepareCachedCliCopy(options);
  const verifyCandidate = async path => {
    if (!(await readFile(path, 'utf8')).includes('中文')) throw new Error('English screen');
  };
  async function englishBuild({destinationPath, version}) {
    await executable(destinationPath, script(version, 'English'));
    return {localization:{translated:14}};
  }
  await assert.rejects(prepareCachedCliCopy({...options, verifyCandidate, build:englishBuild}), /English screen/);
  const verified = await prepareCachedCliCopy({...options, verifyCandidate});
  assert.notEqual(verified.binaryPath, unverified.binaryPath);
  await executable(options.officialCliPath, script('1.2.0', 'official'));
  const fallback = await prepareCachedCliCopy({...options, verifyCandidate, build:englishBuild});
  assert.equal(fallback.binaryPath, verified.binaryPath);
  assert.equal(fallback.fallback.reason, 'English screen');
});
