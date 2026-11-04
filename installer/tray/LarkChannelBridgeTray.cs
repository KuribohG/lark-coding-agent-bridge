// Lark Channel Bridge tray launcher.
//
// Lives in <install dir>\bin and drives the bundled runtime/app relative to
// itself:
//   ..\runtime\node.exe  ..\app\bin\run-lark-cc.mjs
//
// Double-click (or "启动") starts the GUI supervisor in the background and
// shows a tray icon; the tray menu can open the console, restart, open the
// configuration directory, or stop everything and exit.
//
// Compiled by installer/build.ps1 with the .NET Framework csc.exe; no NuGet
// packages and no self-contained runtime are required.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace LarkChannelBridge
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            bool quiet = false;
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (string.Equals(arg, "/selftest", StringComparison.OrdinalIgnoreCase)) return SelfTest();
                if (string.Equals(arg, "/quiet", StringComparison.OrdinalIgnoreCase)) quiet = true;
            }

            // One tray icon per session.  A second double-click exits quietly
            // instead of starting a competing supervisor.
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Local\\LarkChannelBridgeTray", out createdNew))
            {
                if (!createdNew) return 0;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try
                {
                    Application.Run(new TrayContext(quiet));
                    return 0;
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Lark Channel Bridge 无法启动：\r\n\r\n" + ex.Message,
                        "Lark Channel Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
            }
        }

        /// <summary>Validate the installed layout without touching the bridge.</summary>
        private static int SelfTest()
        {
            string root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), ".."));
            bool ok = File.Exists(Path.Combine(root, "runtime", "node.exe"))
                && File.Exists(Path.Combine(root, "app", "bin", "run-lark-cc.mjs"));
            return ok ? 0 : 1;
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        private readonly string _root;
        private readonly string _node;
        private readonly string _launcher;
        private readonly string _channelHome;
        private readonly bool _quiet;
        private readonly Form _anchor;
        private readonly NotifyIcon _icon;
        private readonly ToolStripMenuItem _statusItem;
        private readonly object _sync = new object();

        private bool _busy;
        private bool _exitRequested;
        private bool _exitStarted;
        private Process _active;

        public TrayContext(bool quiet)
        {
            _quiet = quiet;
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            _root = Path.GetFullPath(Path.Combine(exeDir, ".."));
            _node = Path.Combine(_root, "runtime", "node.exe");
            _launcher = Path.Combine(_root, "app", "bin", "run-lark-cc.mjs");

            string home = Environment.GetEnvironmentVariable("LARK_CHANNEL_HOME");
            _channelHome = string.IsNullOrEmpty(home)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".lark-channel")
                : home;

            // A message-only anchor: gives worker threads a UI-thread
            // synchronization point without showing a window.
            _anchor = new Form();
            _anchor.ShowInTaskbar = false;
            _anchor.FormBorderStyle = FormBorderStyle.None;
            _anchor.StartPosition = FormStartPosition.Manual;
            _anchor.Location = new Point(-32000, -32000);
            _anchor.Size = new Size(1, 1);
            _anchor.CreateControl();
            if (_anchor.Handle == IntPtr.Zero) throw new InvalidOperationException("cannot create the tray anchor window");

            ContextMenuStrip menu = new ContextMenuStrip();
            _statusItem = new ToolStripMenuItem("正在启动…");
            _statusItem.Enabled = false;
            menu.Items.Add(_statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("打开控制台", null, delegate { OpenConsole(); }));
            menu.Items.Add(new ToolStripMenuItem("重启 Bridge", null, delegate { RestartBridge(); }));
            menu.Items.Add(new ToolStripMenuItem("打开配置目录", null, delegate { OpenConfigDir(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("退出", null, delegate { ExitFromMenu(); }));

            _icon = new NotifyIcon();
            _icon.Icon = LoadIcon();
            _icon.Text = "Lark Channel Bridge";
            _icon.ContextMenuStrip = menu;
            _icon.Visible = true;
            _icon.DoubleClick += delegate { OpenConsole(); };

            StartBridge();
        }

        private static Icon LoadIcon()
        {
            try
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("tray.ico"))
                {
                    if (stream != null) return new Icon(stream);
                }
            }
            catch { }
            return SystemIcons.Application;
        }

        // --- operations -----------------------------------------------------

        /// <summary>Start the supervisor; called on the UI thread at launch.</summary>
        private void StartBridge()
        {
            RunOperation("正在启动…", delegate { StartBridgeCore(); });
        }

        private void StartBridgeCore()
        {
            if (!File.Exists(_node) || !File.Exists(_launcher))
            {
                SetStatus("安装不完整");
                Balloon("Bridge 未安装完整", "找不到内置的 node.exe 或 run-lark-cc.mjs，请重新安装。");
                return;
            }

            int code;
            string output = RunLauncher(_quiet ? "start --print" : "start", 180000, out code);
            if (code == 0)
            {
                SetStatus("运行中");
                if (!_quiet) Balloon("Lark Channel Bridge", "已在后台运行。双击托盘图标打开控制台，右键可退出。", ToolTipIcon.Info);
                return;
            }

            SetStatus("启动失败");
            Balloon("Bridge 启动失败", output);
        }

        private void RestartBridge()
        {
            RunOperation("正在重启…", delegate
            {
                int code;
                RunLauncher("stop", 30000, out code);
                if (!_exitRequested) StartBridgeCore();
            });
        }

        private void OpenConsole()
        {
            RunOperation("正在打开控制台…", delegate
            {
                int code;
                string output = RunLauncher("ui", 20000, out code);
                SetStatus("运行中");
                if (code != 0) Balloon("无法打开控制台", output);
            });
        }

        private void OpenConfigDir()
        {
            try
            {
                if (Directory.Exists(_channelHome))
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + _channelHome + "\"")
                    {
                        UseShellExecute = true
                    });
                }
                else
                {
                    Balloon("配置目录不存在", _channelHome);
                }
            }
            catch (Exception ex)
            {
                Balloon("无法打开配置目录", ex.Message);
            }
        }

        private void ExitFromMenu()
        {
            lock (_sync) { _exitRequested = true; }
            if (!_busy)
            {
                BeginExit();
                return;
            }
            // Let the running operation finish, then its completion handler
            // calls BeginExit.  Kill a hung `start` so exit is not held hostage.
            Process active;
            lock (_sync) { active = _active; }
            if (active != null)
            {
                try { active.Kill(); } catch { }
            }
            SetStatus("正在退出…");
        }

        private void BeginExit()
        {
            lock (_sync)
            {
                if (_exitStarted) return;
                _exitStarted = true;
            }
            SetStatus("正在退出…");
            ThreadPool.QueueUserWorkItem(delegate
            {
                int code;
                RunLauncher("stop", 30000, out code);
                try
                {
                    _anchor.BeginInvoke(new Action(delegate
                    {
                        try { _icon.Visible = false; _icon.Dispose(); } catch { }
                        try { _anchor.Close(); } catch { }
                        ExitThread();
                    }));
                }
                catch { }
            });
        }

        // --- helpers --------------------------------------------------------

        private void RunOperation(string busyText, Action body)
        {
            lock (_sync)
            {
                if (_busy)
                {
                    Balloon("正在处理中", "请等待当前操作完成。");
                    return;
                }
                _busy = true;
            }
            SetStatus(busyText);
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    body();
                }
                catch (Exception ex)
                {
                    SetStatus("操作失败");
                    Balloon("操作失败", ex.Message);
                }
                finally
                {
                    bool exit;
                    lock (_sync)
                    {
                        _busy = false;
                        exit = _exitRequested;
                    }
                    if (exit) BeginExit();
                }
            });
        }

        /// <summary>
        /// Run `run-lark-cc &lt;action&gt;`.  Returns the combined output so a
        /// failure can be shown in a balloon tip.
        /// </summary>
        private string RunLauncher(string action, int timeoutMs, out int exitCode)
        {
            exitCode = -1;
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = _node;
            psi.Arguments = "\"" + _launcher + "\" " + action;
            psi.WorkingDirectory = _root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            Process process = null;
            try
            {
                process = Process.Start(psi);
                lock (_sync) { _active = process; }
                System.Threading.Tasks.Task<string> stdout = process.StandardOutput.ReadToEndAsync();
                System.Threading.Tasks.Task<string> stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch { }
                    process.WaitForExit(5000);
                    return "操作超时（" + (timeoutMs / 1000) + " 秒）";
                }
                exitCode = process.ExitCode;
                string output = "";
                try { output = stdout.Result + stderr.Result; } catch { }
                return output;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
            finally
            {
                lock (_sync)
                {
                    if (object.ReferenceEquals(_active, process)) _active = null;
                }
                if (process != null) process.Dispose();
            }
        }

        private void SetStatus(string text)
        {
            try
            {
                _anchor.BeginInvoke(new Action(delegate { _statusItem.Text = text; }));
            }
            catch { }
        }

        private void Balloon(string title, string text)
        {
            Balloon(title, text, ToolTipIcon.Error);
        }

        private void Balloon(string title, string text, ToolTipIcon icon)
        {
            string trimmed = text;
            if (trimmed != null && trimmed.Length > 900) trimmed = trimmed.Substring(0, 900) + "…";
            try
            {
                _anchor.BeginInvoke(new Action(delegate
                {
                    try { _icon.ShowBalloonTip(8000, title, trimmed, icon); } catch { }
                }));
            }
            catch { }
        }
    }
}
