import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Check from the official install after selecting this session's localized copy. */
export async function scheduleOfficialCliUpdate({ officialCliPath, stateDir, env = process.env }) {
  const defaultBinary = join(env.HOME || homedir(), '.local', 'bin', 'agy');
  if (officialCliPath !== defaultBinary || env.ANTIGRAVITY_HELPER_CLI ||
      /^(?:true|1)$/i.test(env.AGY_CLI_DISABLE_AUTO_UPDATE ?? '')) return false;

  try {
    const folder = join(stateDir, 'update-checks');
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(folder, { recursive:true, mode:0o700 });
    // Exclusive creation also elects one updater when multiple terminals open together.
    await writeFile(join(folder, day), '', { flag:'wx', mode:0o600 });
    for (const previous of await readdir(folder)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(previous) && previous < day) {
        await rm(join(folder, previous), { force:true });
      }
    }
    const child = spawn(officialCliPath, ['update'], { env, detached:true, stdio:'ignore' });
    return await new Promise(resolve => {
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
  } catch {
    // An already claimed day or an unavailable updater must not interrupt the CLI.
    return false;
  }
}
