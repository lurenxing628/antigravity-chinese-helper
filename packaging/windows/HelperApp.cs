using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AntigravityChineseHelper
{
    internal sealed class HelperTrayContext : ApplicationContext
    {
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        private const int ShutdownGraceSeconds = 10;

        private readonly SynchronizationContext _uiContext;
        private readonly NotifyIcon _notifyIcon;
        private readonly ContextMenuStrip _menu;
        private readonly ToolStripMenuItem _statusItem;
        private readonly ToolStripMenuItem _launchItem;
        private readonly ToolStripMenuItem _reloadItem;
        private readonly ToolStripMenuItem _toggleItem;
        private readonly System.Windows.Forms.Timer _statusTimer;
        private readonly object _logLock = new object();

        private Process _runner;
        private FileStream _runnerLogStream;
        private StreamWriter _runnerLogWriter;
        private bool _wantsTranslation = true;
        private bool _isQuitting;
        private bool _stopping;
        private bool _launching;
        private string _lastError;

        public HelperTrayContext(bool startInBackground)
        {
            _uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(_uiContext);

            _menu = new ContextMenuStrip();
            _statusItem = new ToolStripMenuItem("正在启动汉化…");
            _statusItem.Enabled = false;
            _menu.Items.Add(_statusItem);
            _menu.Items.Add(new ToolStripSeparator());

            _launchItem = new ToolStripMenuItem("通过助手启动 Antigravity", null, OnLaunchClicked);
            _menu.Items.Add(_launchItem);

            _reloadItem = new ToolStripMenuItem("重新加载词库", null, OnReloadClicked);
            _menu.Items.Add(_reloadItem);

            _toggleItem = new ToolStripMenuItem("暂停汉化并恢复英文", null, OnToggleClicked);
            _menu.Items.Add(_toggleItem);

            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(new ToolStripMenuItem("打开中文词库", null, OnOpenTranslationsClicked));
            _menu.Items.Add(new ToolStripMenuItem("打开使用说明", null, OnOpenReadmeClicked));
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(new ToolStripMenuItem("退出并恢复英文", null, OnQuitClicked));

            _notifyIcon = new NotifyIcon();
            _notifyIcon.Icon = LoadTrayIcon();
            _notifyIcon.Text = "Antigravity 汉化助手";
            _notifyIcon.ContextMenuStrip = _menu;
            _notifyIcon.Visible = true;
            _notifyIcon.MouseUp += OnNotifyIconMouseUp;

            StartReopenPipeListener();

            if (startInBackground)
            {
                StartRunner();
            }
            else
            {
                LaunchAntigravity();
            }

            _statusTimer = new System.Windows.Forms.Timer();
            _statusTimer.Interval = 2000;
            _statusTimer.Tick += delegate { RefreshStatus(); };
            _statusTimer.Start();
        }

        private string SupportFolder
        {
            get { return NodeRuntime.ResolveSupportFolder(); }
        }

        private string HomeFolder
        {
            get
            {
                string installedHome = Path.Combine(SupportFolder, "application");
                if (File.Exists(Path.Combine(installedHome, "runtime", "runner.mjs")))
                {
                    return installedHome;
                }
                string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                if (!string.IsNullOrEmpty(exeDir) && File.Exists(Path.Combine(exeDir, "runtime", "runner.mjs")))
                {
                    return exeDir;
                }
                return installedHome;
            }
        }

        private string RuntimeFolder
        {
            get { return Path.Combine(HomeFolder, "runtime"); }
        }

        private static Icon LoadTrayIcon()
        {
            try
            {
                string exePath = Assembly.GetExecutingAssembly().Location;
                Icon associated = Icon.ExtractAssociatedIcon(exePath);
                if (associated != null) return associated;
            }
            catch { }
            return IconGenerator.CreateRuntimeIcon();
        }

        private static string ClampTooltip(string value)
        {
            if (string.IsNullOrEmpty(value)) return "Antigravity 汉化助手";
            // NotifyIcon.Text requires fewer than 64 UTF-16 code units on Windows.
            if (value.Length <= 60) return value;
            return value.Substring(0, 59) + "…";
        }

        private bool IsRunnerAlive()
        {
            if (_runner == null) return false;
            try
            {
                return !_runner.HasExited;
            }
            catch
            {
                return false;
            }
        }

        private void OnNotifyIconMouseUp(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                MethodInfo showContextMenu = typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic);
                if (showContextMenu != null)
                {
                    showContextMenu.Invoke(_notifyIcon, null);
                }
                else
                {
                    SetForegroundWindow(_menu.Handle);
                    _menu.Show(Cursor.Position);
                }
            }
        }

        private void HandleReopenRequest()
        {
            if (_isQuitting) return;
            if (_wantsTranslation)
            {
                LaunchAntigravity();
            }
            else
            {
                SetForegroundWindow(_menu.Handle);
                _menu.Show(Cursor.Position);
            }
        }

        private void StartReopenPipeListener()
        {
            Thread listener = new Thread(delegate()
            {
                string pipeName = HelperApp.GetReopenPipeName();
                while (!_isQuitting)
                {
                    try
                    {
                        using (NamedPipeServerStream server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte))
                        {
                            server.WaitForConnection();
                            if (_isQuitting) break;
                            using (StreamReader reader = new StreamReader(server, Encoding.UTF8))
                            {
                                string command = (reader.ReadLine() ?? string.Empty).Trim();
                                if (string.Equals(command, "reopen", StringComparison.OrdinalIgnoreCase))
                                {
                                    _uiContext.Post(delegate { HandleReopenRequest(); }, null);
                                }
                                else if (string.Equals(command, "quit", StringComparison.OrdinalIgnoreCase))
                                {
                                    _uiContext.Post(delegate { OnQuitClicked(this, EventArgs.Empty); }, null);
                                }
                            }
                        }
                    }
                    catch
                    {
                        if (_isQuitting) break;
                        Thread.Sleep(250);
                    }
                }
            });
            listener.IsBackground = true;
            listener.Start();
        }

        private void AppendLog(string line)
        {
            if (line == null) return;
            lock (_logLock)
            {
                if (_runnerLogWriter != null)
                {
                    try
                    {
                        _runnerLogWriter.WriteLine(line);
                    }
                    catch { }
                }
            }
        }

        private void CloseLog()
        {
            lock (_logLock)
            {
                if (_runnerLogWriter != null)
                {
                    try { _runnerLogWriter.Flush(); _runnerLogWriter.Dispose(); } catch { }
                    _runnerLogWriter = null;
                }
                if (_runnerLogStream != null)
                {
                    try { _runnerLogStream.Dispose(); } catch { }
                    _runnerLogStream = null;
                }
            }
        }

        private void StartRunner()
        {
            if (IsRunnerAlive() || _stopping || _isQuitting) return;
            _runner = null;
            CloseLog();

            string scriptPath = Path.Combine(RuntimeFolder, "runner.mjs");
            if (!File.Exists(scriptPath))
            {
                _lastError = "请先运行“安装汉化助手.cmd”安装运行文件";
                RefreshStatus();
                return;
            }

            string nodePath = NodeRuntime.FindExecutable(RuntimeFolder);
            if (string.IsNullOrEmpty(nodePath))
            {
                _lastError = "未找到 Node.js 22 或更新版本，打开说明查看运行要求";
                RefreshStatus();
                return;
            }

            try
            {
                Directory.CreateDirectory(SupportFolder);
                string logPath = Path.Combine(SupportFolder, "helper.log");
                lock (_logLock)
                {
                    _runnerLogStream = HelperLog.Open(logPath);
                    _runnerLogWriter = new StreamWriter(_runnerLogStream, new UTF8Encoding(false));
                    _runnerLogWriter.AutoFlush = true;
                }

                ProcessStartInfo info = BuildNodeProcessInfo(nodePath, "\"" + scriptPath + "\"");
                info.EnvironmentVariables["ANTIGRAVITY_HELPER_SHUTDOWN_TIMEOUT_MS"] = ((ShutdownGraceSeconds - 1) * 1000).ToString();
                info.EnvironmentVariables["ANTIGRAVITY_HELPER_STATE_DIR"] = SupportFolder;

                Process process = new Process();
                process.StartInfo = info;
                process.EnableRaisingEvents = true;
                process.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) AppendLog(e.Data);
                };
                process.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) AppendLog(e.Data);
                };
                process.Exited += delegate(object s, EventArgs e)
                {
                    int exitCode = 1;
                    try { exitCode = process.ExitCode; } catch { }
                    _uiContext.Post(delegate
                    {
                        if (!ReferenceEquals(_runner, process))
                        {
                            try { process.Dispose(); } catch { }
                            return;
                        }
                        _runner = null;
                        try { process.Dispose(); } catch { }
                        CloseLog();
                        if (_wantsTranslation && !_isQuitting && !_stopping)
                        {
                            _lastError = "运行已结束（" + exitCode + "），点“重新加载词库”重试";
                        }
                        RefreshStatus();
                    }, null);
                };

                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                _runner = process;
                _lastError = null;
                _statusItem.Text = "正在连接 Antigravity…";
            }
            catch (Exception ex)
            {
                _lastError = "启动失败：" + ex.Message;
                CloseLog();
            }
            RefreshStatus();
        }

        private ProcessStartInfo BuildNodeProcessInfo(string nodePath, string scriptArguments)
        {
            return NodeRuntime.BuildNodeCommandInfo(nodePath, RuntimeFolder, SupportFolder, scriptArguments);
        }

        private void StopRunner(Action completion)
        {
            Process process = _runner;
            if (process == null || !IsRunnerAlive())
            {
                _runner = null;
                CloseLog();
                if (completion != null) completion();
                return;
            }

            _stopping = true;
            _statusItem.Text = "正在恢复英文…";
            RefreshStatus();

            string nodePath = NodeRuntime.FindExecutable(RuntimeFolder);
            string scriptPath = Path.Combine(RuntimeFolder, "runner.mjs");
            int runnerPid = 0;
            try { runnerPid = process.Id; } catch { }

            ThreadPool.QueueUserWorkItem(delegate
            {
                // Request graceful IPC shutdown first so runner.mjs uninstalls renderer scripts cleanly.
                if (!string.IsNullOrEmpty(nodePath) && File.Exists(scriptPath))
                {
                    try
                    {
                        ProcessStartInfo stopInfo = BuildNodeProcessInfo(nodePath, "\"" + scriptPath + "\" --stop");
                        NodeRuntime.RunCommand(stopInfo, (ShutdownGraceSeconds - 1) * 1000);
                    }
                    catch { }
                }

                try
                {
                    if (!process.WaitForExit(ShutdownGraceSeconds * 1000))
                    {
                        AppendLog("恢复英文的等待时间已结束，结束汉化助手进程。");
                        NodeRuntime.KillProcessTree(runnerPid);
                        process.WaitForExit(2000);
                    }
                }
                catch { }

                _uiContext.Post(delegate
                {
                    if (ReferenceEquals(_runner, process))
                    {
                        _runner = null;
                    }
                    try { process.Dispose(); } catch { }
                    _stopping = false;
                    CloseLog();
                    if (completion != null) completion();
                }, null);
            });
        }

        private void RefreshStatus()
        {
            _toggleItem.Text = _wantsTranslation ? "暂停汉化并恢复英文" : "恢复汉化";
            _toggleItem.Enabled = !_stopping && !_launching;
            _launchItem.Text = _launching ? "正在启动 Antigravity…" : "通过助手启动 Antigravity";
            _launchItem.Enabled = _wantsTranslation && !_stopping && !_isQuitting && !_launching;
            _reloadItem.Enabled = _wantsTranslation && !_stopping && !_isQuitting;

            if (!_stopping)
            {
                if (!_wantsTranslation)
                {
                    _statusItem.Text = "已暂停 · 英文界面";
                }
                else if (!string.IsNullOrEmpty(_lastError))
                {
                    _statusItem.Text = _lastError;
                }
                else if (!IsRunnerAlive())
                {
                    _statusItem.Text = "汉化助手尚未运行";
                }
                else
                {
                    string statusPath = Path.Combine(SupportFolder, "status.json");
                    RunnerStatus parsed = null;
                    if (File.Exists(statusPath))
                    {
                        try
                        {
                            string json = File.ReadAllText(statusPath, Encoding.UTF8);
                            parsed = RunnerStatus.Parse(json);
                        }
                        catch { }
                    }
                    if (parsed == null)
                    {
                        _statusItem.Text = _launching ? "正在通过助手启动 Antigravity…" : "正在连接 Antigravity…";
                    }
                    else
                    {
                        _statusItem.Text = _launching ? "正在通过助手启动 Antigravity…" : parsed.MenuTitle;
                    }
                }
            }

            _notifyIcon.Text = ClampTooltip("Antigravity 汉化助手：" + _statusItem.Text);
        }

        private void LaunchAntigravity()
        {
            if (!_wantsTranslation || _stopping || _isQuitting || _launching) return;
            _launching = true;
            if (!IsRunnerAlive()) StartRunner();
            RefreshStatus();

            string nodePath = NodeRuntime.FindExecutable(RuntimeFolder);
            string scriptPath = Path.Combine(RuntimeFolder, "runner.mjs");
            if (string.IsNullOrEmpty(nodePath))
            {
                FinishLaunch("未找到 Node.js 22 或更新版本，打开说明查看运行要求。", true);
                return;
            }

            ThreadPool.QueueUserWorkItem(delegate
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                bool ready = false;
                while (DateTime.UtcNow < deadline && !_isQuitting && _wantsTranslation && !_stopping)
                {
                    if (!IsRunnerAlive())
                    {
                        _uiContext.Post(delegate
                        {
                            FinishLaunch(_lastError ?? "汉化助手未能启动，请先恢复汉化后重试。", true);
                        }, null);
                        return;
                    }
                    if (ProbeRunnerStatus(nodePath, scriptPath))
                    {
                        ready = true;
                        break;
                    }
                    Thread.Sleep(120);
                }

                if (_isQuitting || !_wantsTranslation || _stopping)
                {
                    _uiContext.Post(delegate
                    {
                        _launching = false;
                        RefreshStatus();
                    }, null);
                    return;
                }

                if (!ready)
                {
                    _uiContext.Post(delegate
                    {
                        FinishLaunch("等待汉化助手启动超时，请重新加载助手后重试。", true);
                    }, null);
                    return;
                }

                RunLaunchCommand(nodePath, scriptPath);
            });
        }

        private bool ProbeRunnerStatus(string nodePath, string scriptPath)
        {
            try
            {
                ProcessStartInfo info = BuildNodeProcessInfo(nodePath, "\"" + scriptPath + "\" --status");
                NodeCommandResult result = NodeRuntime.RunCommand(info, 3000);
                return result.Exited && result.ExitCode == 0 && result.Stdout.Contains("\"running\": true");
            }
            catch
            {
                return false;
            }
        }

        private void RunLaunchCommand(string nodePath, string scriptPath)
        {
            try
            {
                ProcessStartInfo info = BuildNodeProcessInfo(nodePath, "\"" + scriptPath + "\" --launch");
                NodeCommandResult result = NodeRuntime.RunCommand(info, 95000);
                string stdout = result.Stdout;
                string stderr = result.Stderr.Trim();
                bool exited = result.Exited;
                int exitCode = result.ExitCode;

                _uiContext.Post(delegate
                {
                    if (!exited)
                    {
                        FinishLaunch("启动 Antigravity 等待超时，请稍后重试。", true);
                        return;
                    }
                    if (exitCode != 0)
                    {
                        FinishLaunch(string.IsNullOrEmpty(stderr) ? "启动 Antigravity 失败。" : stderr, true);
                        return;
                    }
                    LaunchReply reply = LaunchReply.TryParse(stdout);
                    if (reply != null)
                    {
                        FinishLaunch(reply.Launched ? null : reply.Message, false);
                    }
                    else
                    {
                        FinishLaunch("无法读取 Antigravity 启动结果。", true);
                    }
                }, null);
            }
            catch (Exception ex)
            {
                _uiContext.Post(delegate { FinishLaunch("启动失败：" + ex.Message, true); }, null);
            }
        }

        private void FinishLaunch(string message, bool failed)
        {
            _launching = false;
            RefreshStatus();
            if (_isQuitting || string.IsNullOrEmpty(message)) return;
            MessageBox.Show(
                message,
                failed ? "无法启动 Antigravity" : "Antigravity 启动提示",
                MessageBoxButtons.OK,
                failed ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
        }

        private void OnLaunchClicked(object sender, EventArgs e)
        {
            LaunchAntigravity();
        }

        private void OnReloadClicked(object sender, EventArgs e)
        {
            if (_stopping || !_wantsTranslation) return;
            if (!IsRunnerAlive())
            {
                StartRunner();
                return;
            }
            string nodePath = NodeRuntime.FindExecutable(RuntimeFolder);
            string scriptPath = Path.Combine(RuntimeFolder, "runner.mjs");
            if (string.IsNullOrEmpty(nodePath)) return;

            _statusItem.Text = "正在重新加载词库…";
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    ProcessStartInfo info = BuildNodeProcessInfo(nodePath, "\"" + scriptPath + "\" --reload");
                    NodeCommandResult result = NodeRuntime.RunCommand(info, 15000);
                    string stderr = result.Stderr.Trim();
                    if ((!result.Exited || result.ExitCode != 0) && !string.IsNullOrEmpty(stderr))
                    {
                        AppendLog(stderr);
                    }
                }
                catch (Exception ex)
                {
                    _uiContext.Post(delegate
                    {
                        _lastError = "重新加载失败：" + ex.Message;
                        RefreshStatus();
                    }, null);
                }
            });
        }

        private void OnToggleClicked(object sender, EventArgs e)
        {
            if (_stopping) return;
            _wantsTranslation = !_wantsTranslation;
            if (_wantsTranslation)
            {
                StartRunner();
            }
            else
            {
                StopRunner(delegate { RefreshStatus(); });
            }
        }

        private void OnOpenTranslationsClicked(object sender, EventArgs e)
        {
            OpenWithShell(Path.Combine(RuntimeFolder, "translations.json"));
        }

        private void OnOpenReadmeClicked(object sender, EventArgs e)
        {
            OpenWithShell(Path.Combine(HomeFolder, "README.md"));
        }

        private static void OpenWithShell(string filePath)
        {
            if (!File.Exists(filePath))
            {
                MessageBox.Show("未找到文件：" + filePath, "Antigravity 汉化助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = filePath;
                info.UseShellExecute = true;
                using (Process proc = Process.Start(info)) { }
            }
            catch (Exception ex)
            {
                MessageBox.Show("无法打开文件：" + ex.Message, "Antigravity 汉化助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void OnQuitClicked(object sender, EventArgs e)
        {
            if (_isQuitting) return;
            _isQuitting = true;
            _wantsTranslation = false;
            _statusTimer.Stop();

            StopRunner(delegate
            {
                _notifyIcon.Visible = false;
                _notifyIcon.Dispose();
                _menu.Dispose();
                ExitThread();
            });
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _statusTimer.Dispose();
                _notifyIcon.Visible = false;
                _notifyIcon.Dispose();
                _menu.Dispose();
                CloseLog();
            }
            base.Dispose(disposing);
        }
    }

    internal static class HelperApp
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        public static string GetReopenPipeName()
        {
            string user = Environment.UserName ?? "default";
            StringBuilder sanitized = new StringBuilder();
            for (int i = 0; i < user.Length; i++)
            {
                char ch = user[i];
                if (char.IsLetterOrDigit(ch) || ch == '_' || ch == '-')
                {
                    sanitized.Append(ch);
                }
            }
            return "AntigravityChineseHelper.Reopen." + sanitized.ToString();
        }

        private static bool HasArg(string[] args, string flag)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static void SignalRunningTrayInstance()
        {
            try
            {
                using (NamedPipeClientStream client = new NamedPipeClientStream(".", GetReopenPipeName(), PipeDirection.Out))
                {
                    client.Connect(1000);
                    using (StreamWriter writer = new StreamWriter(client, new UTF8Encoding(false)))
                    {
                        writer.WriteLine("reopen");
                        writer.Flush();
                    }
                }
            }
            catch { }
        }

        [STAThread]
        public static int Main(string[] args)
        {
            if (args.Length >= 2 && string.Equals(args[0], "--generate-icon", StringComparison.OrdinalIgnoreCase))
            {
                IconGenerator.WriteIcoFile(args[1]);
                return 0;
            }

            if (HasArg(args, "--watch-antigravity"))
            {
                return AppWatcher.Run();
            }

            try { SetProcessDPIAware(); } catch { }
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                MessageBox.Show("运行异常：" + e.Exception.Message, "Antigravity 汉化助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            };
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool background = HasArg(args, "--background");
            bool createdNew;
            using (Mutex trayMutex = new Mutex(true, AppWatcher.TrayMutexName, out createdNew))
            {
                if (!createdNew)
                {
                    if (!background)
                    {
                        SignalRunningTrayInstance();
                    }
                    return 0;
                }

                using (HelperTrayContext context = new HelperTrayContext(background))
                {
                    Application.Run(context);
                }
            }
            return 0;
        }
    }
}
