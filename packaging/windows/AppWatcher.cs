using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace AntigravityChineseHelper
{
    public sealed class AntigravityLaunchState
    {
        public const string TargetProcessName = "Antigravity";
        private readonly Dictionary<int, long> _handledProcesses = new Dictionary<int, long>();

        public static bool IsTargetProcess(string processName)
        {
            if (string.IsNullOrEmpty(processName))
            {
                return false;
            }
            return string.Equals(processName, TargetProcessName, StringComparison.OrdinalIgnoreCase)
                || string.Equals(processName, TargetProcessName + ".exe", StringComparison.OrdinalIgnoreCase);
        }

        public bool ShouldOpenHelper(string processName, int processId, long startTimeTicks)
        {
            if (!IsTargetProcess(processName) || processId <= 0)
            {
                return false;
            }
            long recordedTicks;
            if (_handledProcesses.TryGetValue(processId, out recordedTicks) && recordedTicks == startTimeTicks)
            {
                return false;
            }
            _handledProcesses[processId] = startTimeTicks;
            return true;
        }

        public void ApplicationTerminated(string processName, int processId)
        {
            if (!IsTargetProcess(processName))
            {
                return;
            }
            _handledProcesses.Remove(processId);
        }

        public void SynchronizeActiveProcesses(IDictionary<int, long> activeTargetProcesses)
        {
            List<int> exited = new List<int>();
            foreach (KeyValuePair<int, long> entry in _handledProcesses)
            {
                long currentTicks;
                if (!activeTargetProcesses.TryGetValue(entry.Key, out currentTicks) || currentTicks != entry.Value)
                {
                    exited.Add(entry.Key);
                }
            }
            for (int i = 0; i < exited.Count; i++)
            {
                _handledProcesses.Remove(exited[i]);
            }
        }
    }

    public static class AsarBridgeMonitor
    {
        public const string BridgeMarker = "/*__AGH_CDP_BRIDGE_V1__*/";
        private static readonly byte[] MarkerBytes = Encoding.ASCII.GetBytes(BridgeMarker);

        public static bool ContainsBridgeMarker(string asarPath)
        {
            if (string.IsNullOrEmpty(asarPath) || !File.Exists(asarPath))
            {
                return false;
            }
            try
            {
                using (FileStream fs = new FileStream(asarPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    byte[] header = new byte[16];
                    if (ReadExact(fs, header, 16) < 16)
                    {
                        return false;
                    }
                    uint headerPayloadSize = BitConverter.ToUInt32(header, 4);
                    long dataOffset = 8L + headerPayloadSize;
                    if (dataOffset < 16 || dataOffset >= fs.Length)
                    {
                        return false;
                    }

                    fs.Seek(dataOffset, SeekOrigin.Begin);
                    long remaining = Math.Min(fs.Length - dataOffset, 8L * 1024 * 1024);
                    byte[] buffer = new byte[65536];
                    int overlap = MarkerBytes.Length - 1;
                    int carry = 0;
                    while (remaining > 0 || carry >= MarkerBytes.Length)
                    {
                        int toRead = (int)Math.Min(buffer.Length - carry, remaining);
                        int read = toRead > 0 ? fs.Read(buffer, carry, toRead) : 0;
                        if (read <= 0)
                        {
                            break;
                        }
                        remaining -= read;
                        int total = carry + read;
                        if (IndexOfBytes(buffer, total, MarkerBytes) >= 0)
                        {
                            return true;
                        }
                        if (remaining <= 0)
                        {
                            break;
                        }
                        carry = Math.Min(overlap, total);
                        Buffer.BlockCopy(buffer, total - carry, buffer, 0, carry);
                    }
                }
            }
            catch
            {
                return false;
            }
            return false;
        }

        private static int ReadExact(Stream stream, byte[] buffer, int count)
        {
            int offset = 0;
            while (offset < count)
            {
                int n = stream.Read(buffer, offset, count - offset);
                if (n <= 0) break;
                offset += n;
            }
            return offset;
        }

        private static int IndexOfBytes(byte[] haystack, int haystackLen, byte[] needle)
        {
            int limit = haystackLen - needle.Length;
            byte first = needle[0];
            for (int i = 0; i <= limit; i++)
            {
                if (haystack[i] != first) continue;
                bool match = true;
                for (int j = 1; j < needle.Length; j++)
                {
                    if (haystack[i + j] != needle[j])
                    {
                        match = false;
                        break;
                    }
                }
                if (match) return i;
            }
            return -1;
        }

        public static string FindAntigravityAsarPath()
        {
            string explicitApp = Environment.GetEnvironmentVariable("ANTIGRAVITY_APP_PATH");
            if (!string.IsNullOrWhiteSpace(explicitApp))
            {
                string fromExplicit = ResolveAsarCandidate(explicitApp.Trim());
                if (fromExplicit != null) return fromExplicit;
            }

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(localAppData))
            {
                localAppData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Local");
            }
            string programFiles = Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files";
            string programFilesX86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? @"C:\Program Files (x86)";

            string[] roots = new string[]
            {
                Path.Combine(localAppData, "Programs", "antigravity"),
                Path.Combine(localAppData, "Programs", "Antigravity"),
                Path.Combine(localAppData, "Antigravity"),
                Path.Combine(programFiles, "Antigravity"),
                Path.Combine(programFilesX86, "Antigravity")
            };
            for (int i = 0; i < roots.Length; i++)
            {
                string candidate = Path.Combine(roots[i], "resources", "app.asar");
                if (File.Exists(candidate)) return candidate;
            }

            return FindFromUninstallRegistry(Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Uninstall")
                ?? FindFromUninstallRegistry(Registry.LocalMachine, @"Software\Microsoft\Windows\CurrentVersion\Uninstall")
                ?? FindFromUninstallRegistry(Registry.LocalMachine, @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall");
        }

        private static string ResolveAsarCandidate(string path)
        {
            if (path.EndsWith(".asar", StringComparison.OrdinalIgnoreCase) && File.Exists(path))
            {
                return path;
            }
            if (path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir))
                {
                    string asar = Path.Combine(dir, "resources", "app.asar");
                    if (File.Exists(asar)) return asar;
                }
            }
            string nested = Path.Combine(path, "resources", "app.asar");
            if (File.Exists(nested)) return nested;
            return null;
        }

        private static string FindFromUninstallRegistry(RegistryKey hive, string subKeyPath)
        {
            try
            {
                using (RegistryKey root = hive.OpenSubKey(subKeyPath))
                {
                    if (root == null) return null;
                    string[] names = root.GetSubKeyNames();
                    for (int i = 0; i < names.Length; i++)
                    {
                        using (RegistryKey item = root.OpenSubKey(names[i]))
                        {
                            if (item == null) continue;
                            string displayName = item.GetValue("DisplayName") as string;
                            if (string.IsNullOrEmpty(displayName) || displayName.IndexOf("Antigravity", StringComparison.OrdinalIgnoreCase) < 0)
                            {
                                continue;
                            }
                            string installLoc = item.GetValue("InstallLocation") as string;
                            if (!string.IsNullOrEmpty(installLoc))
                            {
                                string found = ResolveAsarCandidate(installLoc.Trim('"'));
                                if (found != null) return found;
                            }
                            string displayIcon = item.GetValue("DisplayIcon") as string;
                            if (!string.IsNullOrEmpty(displayIcon))
                            {
                                int comma = displayIcon.LastIndexOf(',');
                                if (comma > 0) displayIcon = displayIcon.Substring(0, comma);
                                string found = ResolveAsarCandidate(displayIcon.Trim().Trim('"'));
                                if (found != null) return found;
                            }
                        }
                    }
                }
            }
            catch { }
            return null;
        }

        public static bool EnsurePatchedViaNode(string executablePath)
        {
            try
            {
                string runtimeDir = NodeRuntime.ResolveRuntimeFolder(executablePath);
                string bridgeScript = Path.Combine(runtimeDir, "asar-bridge.mjs");
                if (!File.Exists(bridgeScript)) return false;

                string nodePath = NodeRuntime.FindExecutable(runtimeDir);
                if (string.IsNullOrEmpty(nodePath)) return false;

                string supportDir = NodeRuntime.ResolveSupportFolder();
                ProcessStartInfo info = NodeRuntime.BuildNodeCommandInfo(
                    nodePath,
                    runtimeDir,
                    supportDir,
                    "\"" + bridgeScript + "\" --patch");
                NodeCommandResult res = NodeRuntime.RunCommand(info, 25000);
                return res.Exited && res.ExitCode == 0;
            }
            catch
            {
                return false;
            }
        }
    }

    public static class AppWatcher
    {
        public const string WatcherMutexName = @"Local\AntigravityChineseHelper.Watcher";
        public const string TrayMutexName = @"Local\AntigravityChineseHelper.Tray";

        public static int Run()
        {
            bool createdNew;
            using (Mutex watcherMutex = new Mutex(true, WatcherMutexName, out createdNew))
            {
                if (!createdNew)
                {
                    return 0;
                }

                AntigravityLaunchState state = new AntigravityLaunchState();
                string executablePath = Assembly.GetExecutingAssembly().Location;
                AutoResetEvent wakeSignal = new AutoResetEvent(false);
                FileSystemWatcher fsw = null;
                string watchedDir = null;
                string lastCheckedStamp = string.Empty;
                DateTime nextAsarCheckUtc = DateTime.MinValue;

                try
                {
                    while (true)
                    {
                        try
                        {
                            DateTime nowUtc = DateTime.UtcNow;
                            if (nowUtc >= nextAsarCheckUtc)
                            {
                                nextAsarCheckUtc = nowUtc.AddSeconds(10);
                                string asarPath = AsarBridgeMonitor.FindAntigravityAsarPath();
                                if (!string.IsNullOrEmpty(asarPath) && File.Exists(asarPath))
                                {
                                    string resourcesDir = Path.GetDirectoryName(asarPath);
                                    if (!string.Equals(watchedDir, resourcesDir, StringComparison.OrdinalIgnoreCase))
                                    {
                                        if (fsw != null) { try { fsw.Dispose(); } catch { } fsw = null; }
                                        watchedDir = resourcesDir;
                                        fsw = CreateResourcesWatcher(resourcesDir, delegate
                                        {
                                            nextAsarCheckUtc = DateTime.MinValue;
                                            try { wakeSignal.Set(); } catch { }
                                        });
                                    }

                                    FileInfo fi = new FileInfo(asarPath);
                                    string stamp = asarPath + "|" + fi.Length + "|" + fi.LastWriteTimeUtc.Ticks;
                                    if (!string.Equals(stamp, lastCheckedStamp, StringComparison.Ordinal))
                                    {
                                        if (AsarBridgeMonitor.ContainsBridgeMarker(asarPath))
                                        {
                                            lastCheckedStamp = stamp;
                                        }
                                        else if (AsarBridgeMonitor.EnsurePatchedViaNode(executablePath))
                                        {
                                            fi.Refresh();
                                            if (fi.Exists)
                                            {
                                                lastCheckedStamp = asarPath + "|" + fi.Length + "|" + fi.LastWriteTimeUtc.Ticks;
                                            }
                                        }
                                    }
                                }
                            }

                            Dictionary<int, long> active = new Dictionary<int, long>();
                            Process[] processes = Process.GetProcessesByName(AntigravityLaunchState.TargetProcessName);
                            bool shouldLaunchHelper = false;

                            for (int i = 0; i < processes.Length; i++)
                            {
                                Process proc = processes[i];
                                using (proc)
                                {
                                    bool exited = false;
                                    try
                                    {
                                        exited = proc.HasExited;
                                    }
                                    catch
                                    {
                                        // Access denied to HasExited means the process is still alive.
                                    }
                                    if (exited)
                                    {
                                        continue;
                                    }

                                    long startTicks = 0;
                                    try
                                    {
                                        startTicks = proc.StartTime.ToUniversalTime().Ticks;
                                    }
                                    catch
                                    {
                                        startTicks = 0;
                                    }

                                    active[proc.Id] = startTicks;
                                    if (state.ShouldOpenHelper(AntigravityLaunchState.TargetProcessName, proc.Id, startTicks))
                                    {
                                        shouldLaunchHelper = true;
                                    }
                                }
                            }

                            state.SynchronizeActiveProcesses(active);

                            if (shouldLaunchHelper && !IsTrayHelperRunning())
                            {
                                StartHelperInBackground(executablePath);
                            }
                        }
                        catch
                        {
                            // Watcher stays resilient across transient process enumeration or installer lock failures.
                        }

                        wakeSignal.WaitOne(2000);
                    }
                }
                finally
                {
                    if (fsw != null) { try { fsw.Dispose(); } catch { } }
                    wakeSignal.Dispose();
                }
            }
        }

        private static FileSystemWatcher CreateResourcesWatcher(string resourcesDir, Action onChanged)
        {
            if (string.IsNullOrEmpty(resourcesDir) || !Directory.Exists(resourcesDir)) return null;
            try
            {
                FileSystemWatcher watcher = new FileSystemWatcher(resourcesDir);
                watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime;
                watcher.IncludeSubdirectories = false;
                FileSystemEventHandler handler = delegate(object s, FileSystemEventArgs e)
                {
                    if (e != null && !string.IsNullOrEmpty(e.Name) && e.Name.IndexOf("app.asar", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        onChanged();
                    }
                };
                RenamedEventHandler renamed = delegate(object s, RenamedEventArgs e)
                {
                    if (e != null && (
                        (!string.IsNullOrEmpty(e.Name) && e.Name.IndexOf("app.asar", StringComparison.OrdinalIgnoreCase) >= 0) ||
                        (!string.IsNullOrEmpty(e.OldName) && e.OldName.IndexOf("app.asar", StringComparison.OrdinalIgnoreCase) >= 0)))
                    {
                        onChanged();
                    }
                };
                watcher.Changed += handler;
                watcher.Created += handler;
                watcher.Renamed += renamed;
                watcher.EnableRaisingEvents = true;
                return watcher;
            }
            catch
            {
                return null;
            }
        }

        public static bool IsTrayHelperRunning()
        {
            Mutex existing;
            if (Mutex.TryOpenExisting(TrayMutexName, out existing))
            {
                existing.Dispose();
                return true;
            }
            return false;
        }

        private static void StartHelperInBackground(string executablePath)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = executablePath;
                info.Arguments = "--background";
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                Process started = Process.Start(info);
                if (started != null)
                {
                    started.Dispose();
                }
            }
            catch
            {
                // Will retry on next Antigravity launch.
            }
        }
    }
}
