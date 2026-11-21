import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const debugProfile = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.security.get-task-allow</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>
`;

/** Transform and sign an owned executable. The official installation is read-only. */
export async function prepareSignedNativeCopy({ sourcePath, destinationPath, transform, debugEntitlements = false }) {
  const source = await realpath(sourcePath), destination = resolve(destinationPath);
  if (source === destination) throw new Error('助手副本不能覆盖官方程序');
  const folder = dirname(destination);
  await mkdir(folder, { recursive:true, mode:0o700 });
  const temporary = await mkdtemp(join(folder, '.prepare-'));
  const binaryPath = join(temporary, basename(destination));
  try {
    const result = await transform(await readFile(source));
    await writeFile(binaryPath, result.binary, { mode:0o755 });
    const args = ['--force', '--sign', '-', '--timestamp=none'];
    let entitlements = debugProfile;
    if (!debugEntitlements) {
      // The desktop server uses hardened runtime and its own JIT entitlement.
      // Keep the source entitlements when signing the localized executable.
      args.push('--options', 'runtime');
      const result = await exec('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', source]);
      entitlements = result.stdout;
    }
    if (entitlements.trim()) {
      const entitlementsPath = join(temporary, 'entitlements.plist');
      await writeFile(entitlementsPath, entitlements, { mode:0o600 });
      args.push('--entitlements', entitlementsPath);
    }
    await exec('/usr/bin/codesign', [...args, binaryPath],
      { timeout:30000, maxBuffer:1024 * 1024 });
    await exec('/usr/bin/codesign', ['--verify', '--strict', binaryPath], { timeout:30000, maxBuffer:1024 * 1024 });
    await rename(binaryPath, destination);
    const { binary, ...details } = result;
    return { ...details, binaryPath:await realpath(destination) };
  } finally {
    await rm(temporary, { recursive:true, force:true });
  }
}
