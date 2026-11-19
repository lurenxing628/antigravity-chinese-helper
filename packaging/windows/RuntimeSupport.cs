using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace AntigravityChineseHelper
{
    public sealed class NodeCommandResult
    {
        public bool Exited { get; private set; }
        public int ExitCode { get; private set; }
        public string Stdout { get; private set; }
        public string Stderr { get; private set; }

        public NodeCommandResult(bool exited, int exitCode, string stdout, string stderr)
        {
            Exited = exited;
            ExitCode = exitCode;
            Stdout = stdout ?? string.Empty;
            Stderr = stderr ?? string.Empty;
        }
    }

    public static class NodeRuntime
    {
        private sealed class Installation : IComparable<Installation>
        {
            public readonly int[] Version;
            public readonly string ExecutablePath;

            public Installation(int[] version, string executablePath)
            {
                Version = version;
                ExecutablePath = executablePath;
            }

            public int CompareTo(Installation other)
            {
                if (other == null) return -1;
                int len = Math.Min(Version.Length, other.Version.Length);
                for (int i = 0; i < len; i++)
                {
                    if (Version[i] != other.Version[i])
                    {
                        // Descending order: higher version comes first.
                        return other.Version[i].CompareTo(Version[i]);
                    }
                }
                return other.Version.Length.CompareTo(Version.Length);
            }
        }

        public static string FindExecutable(string workingDirectory)
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            Dictionary<string, string> env = CurrentEnvironment();
            return FindExecutable(home, env, workingDirectory);
        }

        public static string FindExecutable(string home, IDictionary<string, string> environment, string workingDirectory)
        {
            List<string> candidates = GetCandidates(home, environment);
            return ValidatedExecutable(candidates, environment, workingDirectory);
        }

        public static Dictionary<string, string> CurrentEnvironment()
        {
            Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                if (entry.Key != null && entry.Value != null)
                {
                    result[entry.Key.ToString()] = entry.Value.ToString();
                }
            }
            return result;
        }

        public static List<string> GetCandidates(string home, IDictionary<string, string> environment)
        {
            string appData = GetConfiguredPath(environment, "APPDATA", Path.Combine(home, "AppData", "Roaming"), home);
            string localAppData = GetConfiguredPath(environment, "LOCALAPPDATA", Path.Combine(home, "AppData", "Local"), home);
            string programFiles = GetConfiguredPath(environment, "ProgramFiles", @"C:\Program Files", home);
            string programFilesX86 = GetConfiguredPath(environment, "ProgramFiles(x86)", @"C:\Program Files (x86)", home);

            string nvmWin = GetConfiguredPath(environment, "NVM_HOME", Path.Combine(appData, "nvm"), home);
            string nvmPosix = GetConfiguredPath(environment, "NVM_DIR", Path.Combine(home, ".nvm"), home);
            string volta = GetConfiguredPath(environment, "VOLTA_HOME", Path.Combine(localAppData, "Volta"), home);
            string mise = GetConfiguredPath(environment, "MISE_DATA_DIR", Path.Combine(localAppData, "mise"), home);

            List<string> fnmRoots = new List<string>();
            string explicitFnm = ExpandPath(GetValue(environment, "FNM_DIR"), home);
            if (!string.IsNullOrEmpty(explicitFnm)) fnmRoots.Add(explicitFnm);
            fnmRoots.Add(Path.Combine(appData, "fnm"));
            fnmRoots.Add(Path.Combine(localAppData, "fnm"));

            List<Installation> nvmWinVersions = FindInstalled(nvmWin, "node.exe");
            List<Installation> nvmPosixVersions = FindInstalled(Path.Combine(nvmPosix, "versions", "node"), Path.Combine("bin", "node.exe"));
            nvmPosixVersions.AddRange(FindInstalled(Path.Combine(nvmPosix, "versions", "node"), "node.exe"));

            List<Installation> allVersions = new List<Installation>();
            allVersions.AddRange(nvmWinVersions);
            allVersions.AddRange(nvmPosixVersions);

            for (int i = 0; i < fnmRoots.Count; i++)
            {
                allVersions.AddRange(FindInstalled(Path.Combine(fnmRoots[i], "node-versions"), Path.Combine("installation", "node.exe")));
            }
            allVersions.AddRange(FindInstalled(Path.Combine(volta, "tools", "image", "node"), "node.exe"));

            string miseInstalls = GetConfiguredPath(environment, "MISE_INSTALLS_DIR", Path.Combine(mise, "installs"), home);
            allVersions.AddRange(FindInstalled(Path.Combine(miseInstalls, "node"), "node.exe"));
            allVersions.AddRange(FindInstalled(Path.Combine(miseInstalls, "node"), Path.Combine("bin", "node.exe")));

            List<string> raw = new List<string>();

            string explicitNode = ExpandPath(GetValue(environment, "ANTIGRAVITY_HELPER_NODE"), home);
            if (!string.IsNullOrEmpty(explicitNode))
            {
                raw.Add(explicitNode);
            }

            raw.Add(Path.Combine(home, ".local", "bin", "node.exe"));

            string nvmSymlink = ExpandPath(GetValue(environment, "NVM_SYMLINK"), home);
            if (!string.IsNullOrEmpty(nvmSymlink))
            {
                raw.Add(Path.Combine(nvmSymlink, "node.exe"));
            }
            string nvmBin = ExpandPath(GetValue(environment, "NVM_BIN"), home);
            if (!string.IsNullOrEmpty(nvmBin))
            {
                raw.Add(Path.Combine(nvmBin, "node.exe"));
            }
            string fnmMultishell = ExpandPath(GetValue(environment, "FNM_MULTISHELL_PATH"), home);
            if (!string.IsNullOrEmpty(fnmMultishell))
            {
                raw.Add(Path.Combine(fnmMultishell, "node.exe"));
                raw.Add(Path.Combine(fnmMultishell, "bin", "node.exe"));
            }

            raw.Add(Path.Combine(volta, "bin", "node.exe"));
            raw.Add(Path.Combine(programFiles, "Volta", "node.exe"));

            string miseShims = GetConfiguredPath(environment, "MISE_SHIMS_DIR", Path.Combine(mise, "shims"), home);
            raw.Add(Path.Combine(miseShims, "node.exe"));
            raw.Add(Path.Combine(miseShims, "node.cmd"));

            raw.AddRange(ResolveNvmDefault(nvmPosix, nvmPosixVersions));
            for (int i = 0; i < fnmRoots.Count; i++)
            {
                raw.Add(Path.Combine(fnmRoots[i], "aliases", "default", "node.exe"));
            }

            string pathEnv = GetValue(environment, "PATH") ?? string.Empty;
            string[] pathParts = pathEnv.Split(new char[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < pathParts.Length; i++)
            {
                string expanded = ExpandPath(pathParts[i].Trim().Trim('"'), home);
                if (!string.IsNullOrEmpty(expanded))
                {
                    raw.Add(Path.Combine(expanded, "node.exe"));
                }
            }

            raw.Add(Path.Combine(programFiles, "nodejs", "node.exe"));
            raw.Add(Path.Combine(localAppData, "Programs", "nodejs", "node.exe"));
            raw.Add(Path.Combine(programFilesX86, "nodejs", "node.exe"));
            raw.Add(Path.Combine(home, "scoop", "apps", "nodejs", "current", "node.exe"));
            raw.Add(Path.Combine(home, "scoop", "apps", "nodejs-lts", "current", "node.exe"));

            allVersions.Sort();
            for (int i = 0; i < allVersions.Count; i++)
            {
                raw.Add(allVersions[i].ExecutablePath);
            }

            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> result = new List<string>();
            for (int i = 0; i < raw.Count; i++)
            {
                string item = raw[i];
                if (string.IsNullOrWhiteSpace(item)) continue;
                string normalized;
                try
                {
                    normalized = Path.GetFullPath(item);
                }
                catch
                {
                    continue;
                }
                if (seen.Add(normalized))
                {
                    result.Add(normalized);
                }
            }
            return result;
        }

        public static string ValidatedExecutable(IEnumerable<string> candidates, IDictionary<string, string> environment, string workingDirectory, int timeoutMs = 1500)
        {
            foreach (string candidate in candidates)
            {
                if (string.IsNullOrEmpty(candidate) || !File.Exists(candidate))
                {
                    continue;
                }
                if (ValidateSingleCandidate(candidate, environment, workingDirectory, timeoutMs))
                {
                    return candidate;
                }
            }
            return null;
        }

        private static bool ValidateSingleCandidate(string candidate, IDictionary<string, string> environment, string workingDirectory, int timeoutMs)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                bool isCmd = candidate.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
                    || candidate.EndsWith(".bat", StringComparison.OrdinalIgnoreCase);
                if (isCmd)
                {
                    info.FileName = "cmd.exe";
                    info.Arguments = "/d /s /c \"\"" + candidate + "\" --version\"";
                }
                else
                {
                    info.FileName = candidate;
                    info.Arguments = "--version";
                }
                if (!string.IsNullOrEmpty(workingDirectory) && Directory.Exists(workingDirectory))
                {
                    info.WorkingDirectory = workingDirectory;
                }
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;

                if (environment != null)
                {
                    info.EnvironmentVariables.Clear();
                    foreach (KeyValuePair<string, string> kv in environment)
                    {
                        if (!string.IsNullOrEmpty(kv.Key) && kv.Value != null)
                        {
                            info.EnvironmentVariables[kv.Key] = kv.Value;
                        }
                    }
                }
                info.EnvironmentVariables["MISE_NOT_FOUND_AUTO_INSTALL"] = "false";

                using (Process process = new Process())
                {
                    process.StartInfo = info;
                    StringBuilder stdout = new StringBuilder();
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
                    {
                        if (e.Data != null && stdout.Length < 256)
                        {
                            stdout.AppendLine(e.Data);
                        }
                    };
                    if (!process.Start())
                    {
                        return false;
                    }
                    process.BeginOutputReadLine();
                    if (!process.WaitForExit(timeoutMs))
                    {
                        KillProcessTree(process.Id);
                        return false;
                    }
                    // Wait briefly for buffered output flush without blocking indefinitely on orphaned handles.
                    process.WaitForExit(100);
                    if (process.ExitCode != 0)
                    {
                        return false;
                    }
                    string firstLine = stdout.ToString().Trim();
                    int newlineIndex = firstLine.IndexOfAny(new char[] { '\r', '\n' });
                    if (newlineIndex >= 0)
                    {
                        firstLine = firstLine.Substring(0, newlineIndex).Trim();
                    }
                    int[] version = ParseVersionNumbers(firstLine);
                    return version != null && version.Length >= 1 && version[0] >= 22;
                }
            }
            catch
            {
                return false;
            }
        }

        public static ProcessStartInfo BuildNodeCommandInfo(string nodePath, string workingDirectory, string stateDir, string scriptArguments)
        {
            ProcessStartInfo info = new ProcessStartInfo();
            bool isCmd = nodePath.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
                || nodePath.EndsWith(".bat", StringComparison.OrdinalIgnoreCase);
            if (isCmd)
            {
                info.FileName = "cmd.exe";
                info.Arguments = "/d /s /c \"\"" + nodePath + "\" " + scriptArguments + "\"";
            }
            else
            {
                info.FileName = nodePath;
                info.Arguments = scriptArguments;
            }
            info.WorkingDirectory = workingDirectory;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            if (!string.IsNullOrEmpty(stateDir))
            {
                info.EnvironmentVariables["ANTIGRAVITY_HELPER_STATE_DIR"] = stateDir;
            }
            return info;
        }

        public static string ResolveSupportFolder()
        {
            string explicitDir = Environment.GetEnvironmentVariable("ANTIGRAVITY_HELPER_STATE_DIR");
            if (!string.IsNullOrWhiteSpace(explicitDir))
            {
                return Path.GetFullPath(explicitDir);
            }
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(localAppData))
            {
                localAppData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Local");
            }
            return Path.Combine(localAppData, "AntigravityChineseHelper");
        }

        public static string ResolveRuntimeFolder(string executablePath)
        {
            string supportFolder = ResolveSupportFolder();
            string installedRuntime = Path.Combine(supportFolder, "application", "runtime");
            if (File.Exists(Path.Combine(installedRuntime, "runner.mjs")))
            {
                return installedRuntime;
            }
            if (!string.IsNullOrEmpty(executablePath))
            {
                string exeDir = Path.GetDirectoryName(executablePath);
                if (!string.IsNullOrEmpty(exeDir))
                {
                    string siblingRuntime = Path.Combine(exeDir, "runtime");
                    if (File.Exists(Path.Combine(siblingRuntime, "runner.mjs")))
                    {
                        return siblingRuntime;
                    }
                }
            }
            return installedRuntime;
        }

        public static NodeCommandResult RunCommand(ProcessStartInfo info, int timeoutMs)
        {
            StringBuilder stdout = new StringBuilder();
            StringBuilder stderr = new StringBuilder();
            using (ManualResetEvent stdoutDone = new ManualResetEvent(false))
            using (ManualResetEvent stderrDone = new ManualResetEvent(false))
            using (Process proc = new Process())
            {
                proc.StartInfo = info;
                proc.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data == null)
                    {
                        try { stdoutDone.Set(); } catch { }
                    }
                    else
                    {
                        lock (stdout) { stdout.AppendLine(e.Data); }
                    }
                };
                proc.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data == null)
                    {
                        try { stderrDone.Set(); } catch { }
                    }
                    else
                    {
                        lock (stderr) { stderr.AppendLine(e.Data); }
                    }
                };

                if (!proc.Start())
                {
                    return new NodeCommandResult(false, -1, string.Empty, string.Empty);
                }

                int pid = 0;
                try { pid = proc.Id; } catch { }
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                bool exited = proc.WaitForExit(timeoutMs);
                if (!exited)
                {
                    KillProcessTree(pid);
                    string partialOut;
                    string partialErr;
                    lock (stdout) { partialOut = stdout.ToString(); }
                    lock (stderr) { partialErr = stderr.ToString(); }
                    return new NodeCommandResult(false, -1, partialOut, partialErr);
                }

                // Capture ExitCode while the underlying Win32 handle is still open inside `using`.
                int exitCode = proc.ExitCode;
                stdoutDone.WaitOne(500);
                stderrDone.WaitOne(500);

                string finalOut;
                string finalErr;
                lock (stdout) { finalOut = stdout.ToString(); }
                lock (stderr) { finalErr = stderr.ToString(); }
                return new NodeCommandResult(true, exitCode, finalOut, finalErr);
            }
        }

        public static void KillProcessTree(int pid)
        {
            if (pid <= 0) return;
            try
            {
                ProcessStartInfo killer = new ProcessStartInfo();
                killer.FileName = "taskkill.exe";
                killer.Arguments = "/PID " + pid + " /T /F";
                killer.UseShellExecute = false;
                killer.CreateNoWindow = true;
                killer.RedirectStandardOutput = true;
                killer.RedirectStandardError = true;
                using (Process p = Process.Start(killer))
                {
                    if (p != null) p.WaitForExit(3000);
                }
            }
            catch
            {
                try
                {
                    using (Process direct = Process.GetProcessById(pid))
                    {
                        direct.Kill();
                    }
                }
                catch { }
            }
        }

        private static List<Installation> FindInstalled(string directory, string relativeExecutable)
        {
            List<Installation> list = new List<Installation>();
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
            {
                return list;
            }
            try
            {
                string[] subdirs = Directory.GetDirectories(directory);
                for (int i = 0; i < subdirs.Length; i++)
                {
                    string name = Path.GetFileName(subdirs[i]);
                    int[] version = ParseVersionNumbers(name);
                    if (version != null && version.Length == 3)
                    {
                        list.Add(new Installation(version, Path.Combine(subdirs[i], relativeExecutable)));
                    }
                }
                list.Sort();
            }
            catch { }
            return list;
        }

        private static List<string> ResolveNvmDefault(string root, List<Installation> versions)
        {
            List<string> matches = new List<string>();
            string alias = "default";
            HashSet<string> visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (visited.Add(alias))
            {
                int[] prefix = ParseVersionNumbers(alias);
                if (prefix != null)
                {
                    for (int i = 0; i < versions.Count; i++)
                    {
                        if (StartsWith(versions[i].Version, prefix))
                        {
                            matches.Add(versions[i].ExecutablePath);
                        }
                    }
                    return matches;
                }
                if (alias == "node" || alias == "stable")
                {
                    for (int i = 0; i < versions.Count; i++) matches.Add(versions[i].ExecutablePath);
                    return matches;
                }
                string aliasFile = Path.Combine(root, "alias", alias);
                if (!File.Exists(aliasFile)) break;
                try
                {
                    alias = File.ReadAllText(aliasFile, Encoding.UTF8).Trim();
                }
                catch
                {
                    break;
                }
            }
            return matches;
        }

        private static bool StartsWith(int[] version, int[] prefix)
        {
            if (prefix.Length > version.Length) return false;
            for (int i = 0; i < prefix.Length; i++)
            {
                if (version[i] != prefix[i]) return false;
            }
            return true;
        }

        public static int[] ParseVersionNumbers(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            if (value.StartsWith("v", StringComparison.OrdinalIgnoreCase))
            {
                value = value.Substring(1);
            }
            string[] parts = value.Split('.');
            if (parts.Length < 1 || parts.Length > 3) return null;
            int[] numbers = new int[parts.Length];
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i];
                if (string.IsNullOrEmpty(part)) return null;
                for (int c = 0; c < part.Length; c++)
                {
                    if (part[c] < '0' || part[c] > '9') return null;
                }
                int parsed;
                if (!int.TryParse(part, out parsed)) return null;
                numbers[i] = parsed;
            }
            return numbers;
        }

        private static string GetValue(IDictionary<string, string> env, string key)
        {
            if (env == null) return null;
            string value;
            if (env.TryGetValue(key, out value)) return value;
            foreach (KeyValuePair<string, string> entry in env)
            {
                if (string.Equals(entry.Key, key, StringComparison.OrdinalIgnoreCase))
                {
                    return entry.Value;
                }
            }
            return null;
        }

        private static string GetConfiguredPath(IDictionary<string, string> env, string name, string fallback, string home)
        {
            string expanded = ExpandPath(GetValue(env, name), home);
            return string.IsNullOrEmpty(expanded) ? fallback : expanded;
        }

        private static string ExpandPath(string value, string home)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            value = value.Trim();
            if (value == "~") return home;
            if (value.StartsWith("~/", StringComparison.Ordinal) || value.StartsWith("~\\", StringComparison.Ordinal))
            {
                return Path.Combine(home, value.Substring(2));
            }
            if (!Path.IsPathRooted(value)) return null;
            return value;
        }
    }

    public static class HelperLog
    {
        public const long MaximumSize = 512 * 1024;
        public const long RetainedSize = 256 * 1024;

        public static FileStream Open(string logPath)
        {
            string folder = Path.GetDirectoryName(logPath);
            if (!string.IsNullOrEmpty(folder) && !Directory.Exists(folder))
            {
                Directory.CreateDirectory(folder);
            }
            FileStream stream = new FileStream(logPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
            try
            {
                long size = stream.Length;
                if (size > MaximumSize)
                {
                    stream.Seek(size - RetainedSize - 1, SeekOrigin.Begin);
                    int toRead = (int)(RetainedSize + 1);
                    byte[] tail = new byte[toRead];
                    int totalRead = 0;
                    while (totalRead < toRead)
                    {
                        int n = stream.Read(tail, totalRead, toRead - totalRead);
                        if (n <= 0) break;
                        totalRead += n;
                    }
                    int newline = -1;
                    for (int i = 0; i < totalRead; i++)
                    {
                        if (tail[i] == 0x0A)
                        {
                            newline = i;
                            break;
                        }
                    }
                    stream.SetLength(0);
                    stream.Seek(0, SeekOrigin.Begin);
                    if (newline >= 0 && newline + 1 < totalRead)
                    {
                        stream.Write(tail, newline + 1, totalRead - (newline + 1));
                    }
                }
                stream.Seek(0, SeekOrigin.End);
                return stream;
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }
    }
}
