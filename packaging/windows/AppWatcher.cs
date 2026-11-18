using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Threading;

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

                while (true)
                {
                    try
                    {
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
                        // Watcher stays resilient across transient process enumeration failures.
                    }

                    Thread.Sleep(2000);
                }
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
