import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// agy binds an ephemeral local listener on startup. The check never connects to any server.
const profile = `(version 1)(allow default)(deny network*)
  (allow network-inbound (local ip "localhost:*"))
  (deny file-write*)(deny file-read-data (subpath (param "USER_HOME")))
  (allow file-read* (literal (param "BINARY")))
  (allow file-read* file-write* (subpath (param "CHECK_DIR")))
  (allow file-write* (literal "/dev/null") (regex #"^/dev/ttys[0-9]+$"))
  (deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.secd"))`;

export async function verifyLocalizedCliScreen(binaryPath) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agy-screen-')));
  const home = join(directory, 'home'), work = join(directory, 'workspace'), pidFile = join(directory, 'pid');
  let child, exited, timer;
  try {
    await Promise.all([mkdir(home), mkdir(work)]);
    const binary = await realpath(binaryPath);
    // script creates an independent PTY session. Its CLI process group is recorded before exec
    // so both the recorder and its children can be stopped even if initialization times out.
    child = spawn('/usr/bin/script', ['-q', '/dev/null', '/bin/sh', '-c',
      'stty rows 32 cols 100; echo $$ > "$1"; shift; exec "$@"', 'sh', pidFile,
      '/usr/bin/sandbox-exec', '-D', `USER_HOME=${homedir()}`, '-D', `BINARY=${binary}`, '-D', `CHECK_DIR=${directory}`,
      '-p', profile, binary], {cwd:work, stdio:['ignore', 'pipe', 'pipe'],
      env:{HOME:home, TMPDIR:directory, PATH:'/usr/bin:/bin:/usr/sbin:/sbin', TERM:'xterm-256color', LANG:'en_US.UTF-8',
        AGY_CLI_DISABLE_AUTO_UPDATE:'true'}});
    exited = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => {
      let screen = '', diagnostics = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        screen = (screen + chunk).slice(-32768);
        // The fresh workspace has no prompts or user content. Accept multiple visible Chinese
        // labels without pinning the helper to one release's onboarding text or punctuation.
        const rendered = screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        if (screen.includes('\x1b[') && new Set(rendered.match(/\p{Script=Han}{2,}/gu)).size >= 2) resolve();
      });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-400); });
      child.once('error', reject);
      exited.then(code => reject(new Error(`汉化副本未显示中文启动界面（退出码 ${code ?? 'signal'}）${diagnostics.trim()}`)));
      timer = setTimeout(() => reject(new Error('汉化副本启动界面在 8 秒内未显示中文')), 8000);
    });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 1) {
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      child.kill('SIGKILL');
    }
    if (exited) await exited;
    await rm(directory, {recursive:true, force:true});
  }
}
