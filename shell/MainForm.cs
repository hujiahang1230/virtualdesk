using System.Drawing;
using System.Windows.Forms;

namespace VirtualDesk.App;

/// <summary>
/// 第二块屏 · 控制面板
///
/// 只服务一件事:把这块 Windows 虚拟显示器推到平板上的自研 App 里。
///
/// 为什么砍掉了浏览器那一套:
///   早期版本用浏览器做屏幕采集 + WebRTC,需要用户开浏览器、点「开始共享」、
///   在系统弹窗里选屏,平板端还要开浏览器扫码。那套流程每一步都要手动介入,
///   而且平板一断线就得重来。现在改为 PC 端直接捕获并推流、平板端自研 App 解码,
///   两边浏览器都不需要了 —— 所以面板上的地址、二维码、共享页全部删掉,
///   只留与 Android 相关的状态和按钮。
///
/// 平板端不需要任何操作:插上线,点「启动副屏」即可。
/// </summary>
internal sealed class MainForm : Form
{
    private const int DefaultPort = 5000;
    private const int DefaultFps = 60;
    private const string DefaultBitrate = "12M";

    private readonly string _dataDir;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 2000 };

    private readonly Label _headline = new()
    {
        AutoSize = false,
        Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold),
        ForeColor = Color.FromArgb(34, 211, 238),
        Text = "正在检测…",
    };

    private readonly Label _detail = new()
    {
        AutoSize = false,
        Font = new Font("Microsoft YaHei UI", 9.5F),
        ForeColor = Color.FromArgb(203, 213, 225),
    };

    private readonly Label _deviceLine = new()
    {
        AutoSize = false,
        Font = new Font("Microsoft YaHei UI", 9F),
        ForeColor = Color.FromArgb(148, 163, 184),
    };

    private readonly Label _displayLine = new()
    {
        AutoSize = false,
        Font = new Font("Microsoft YaHei UI", 9F),
        ForeColor = Color.FromArgb(148, 163, 184),
    };

    private readonly Label _streamLine = new()
    {
        AutoSize = false,
        Font = new Font("Microsoft YaHei UI", 9F),
        ForeColor = Color.FromArgb(148, 163, 184),
    };

    private Button _startButton = null!;
    private Button _stopButton = null!;
    private Button _fillButton = null!;

    private AppStreamServer? _server;
    private string? _adb;
    private string? _apk;
    private bool _fill = true;
    private bool _starting;
    private string? _lastError;

    public MainForm(string dataDir)
    {
        _dataDir = dataDir;

        Text = "第二块屏 · 把平板变成副屏";
        Width = 720;
        Height = 540;
        MinimumSize = new Size(680, 500);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(7, 11, 20);
        ForeColor = Color.FromArgb(226, 232, 245);
        TrySetIcon();

        BuildLayout();

        _timer.Tick += (_, _) => RefreshStatus();
        _timer.Start();

        Shown += (_, _) => RefreshStatus();
    }

    private void TrySetIcon()
    {
        try
        {
            var stream = typeof(MainForm).Assembly.GetManifestResourceStream("VirtualDesk.Icon.ico");
            if (stream is not null) Icon = new Icon(stream);
        }
        catch
        {
            // 没图标不影响使用
        }
    }

    // ------------------------------------------------------------ 界面

    private void BuildLayout()
    {
        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 76,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Padding = new Padding(20, 14, 20, 14),
            BackColor = Color.FromArgb(7, 11, 20),
        };

        _startButton = MakeButton("▶ 启动副屏", Color.FromArgb(34, 211, 238), StartSecondScreen);
        _stopButton = MakeButton("■ 停止", Color.FromArgb(45, 58, 84), StopSecondScreen);
        _stopButton.Enabled = false;
        _fillButton = MakeButton("显示:铺满", Color.FromArgb(45, 58, 84), ToggleFill);

        buttons.Controls.Add(_startButton);
        buttons.Controls.Add(_stopButton);
        buttons.Controls.Add(_fillButton);
        buttons.Controls.Add(MakeButton("📂 数据目录", Color.FromArgb(30, 41, 59), OpenDataDir));
        Controls.Add(buttons);

        var body = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(7, 11, 20) };

        _headline.Location = new Point(24, 18);
        _headline.Size = new Size(650, 38);
        _detail.Location = new Point(24, 60);
        _detail.Size = new Size(650, 44);

        var caption = new Label
        {
            AutoSize = true,
            Location = new Point(24, 112),
            Text = "运行状态",
            Font = new Font("Microsoft YaHei UI", 8.5F),
            ForeColor = Color.FromArgb(100, 116, 139),
        };

        _deviceLine.Location = new Point(24, 134);
        _deviceLine.Size = new Size(650, 22);
        _displayLine.Location = new Point(24, 160);
        _displayLine.Size = new Size(650, 22);
        _streamLine.Location = new Point(24, 186);
        _streamLine.Size = new Size(650, 22);

        var hint = new Label
        {
            AutoSize = false,
            Location = new Point(24, 226),
            Size = new Size(650, 150),
            Font = new Font("Microsoft YaHei UI", 8.5F),
            ForeColor = Color.FromArgb(100, 116, 139),
            Text =
                "使用前提(只需准备一次):\r\n" +
                "  1. 数据线连接平板,平板打开「开发者选项 → USB 调试」,\r\n" +
                "     并在弹窗中点「允许」(建议勾选「一律允许」)\r\n" +
                "  2. 显示设置里保持虚拟显示器为「扩展」状态\r\n" +
                "\r\n" +
                "之后每次只需点「启动副屏」。平板上不需要任何操作。",
        };

        body.Controls.Add(_headline);
        body.Controls.Add(_detail);
        body.Controls.Add(caption);
        body.Controls.Add(_deviceLine);
        body.Controls.Add(_displayLine);
        body.Controls.Add(_streamLine);
        body.Controls.Add(hint);
        Controls.Add(body);
        body.BringToFront();
    }

    private static Button MakeButton(string text, Color backColor, Action onClick)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = false,
            Width = 148,
            Height = 44,
            FlatStyle = FlatStyle.Flat,
            BackColor = backColor,
            ForeColor = Color.FromArgb(4, 18, 26),
            Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
            Margin = new Padding(0, 0, 10, 0),
        };
        button.FlatAppearance.BorderSize = 0;
        button.Click += (_, _) => onClick();
        return button;
    }

    // ------------------------------------------------------------ 状态刷新

    private void RefreshStatus()
    {
        try
        {
            var displays = DisplayInfo.Enumerate();
            var virtualDisplay = displays.FirstOrDefault((d) => !d.IsPrimary && d.IsLikelyVirtual)
                                 ?? displays.FirstOrDefault((d) => !d.IsPrimary);

            _adb ??= Adb.ResolveAdb();
            _apk ??= Program.ResolveApkPath();

            var device = _adb is null ? ("找不到 adb.exe", false) : DescribeDevice(_adb);
            var canStart = device.Item2 && virtualDisplay is not null && _apk is not null && !_starting;

            if (_starting)
            {
                _headline.Text = "正在启动…";
                _headline.ForeColor = Color.FromArgb(250, 204, 21);
                _detail.Text = "正在建立连接并检查平板端 App,请稍候。";
            }
            else if (_server is not null)
            {
                if (_server.IsClientConnected)
                {
                    _headline.Text = "副屏已连接 · 正在传输";
                    _headline.ForeColor = Color.FromArgb(74, 222, 128);
                    _detail.Text = $"平板正在显示扩展桌面({_server.CaptureWidth}×{_server.CaptureHeight}, " +
                                   $"{DefaultFps}fps, {DefaultBitrate})。";
                }
                else
                {
                    _headline.Text = "已启动 · 等待平板连接";
                    _headline.ForeColor = Color.FromArgb(250, 204, 21);
                    _detail.Text = "推流服务已就绪,正在等待平板上的 App 接入。";
                }
            }
            else if (device.Item2 && virtualDisplay is null)
            {
                _headline.Text = "缺少虚拟显示器";
                _headline.ForeColor = Color.FromArgb(250, 204, 21);
                _detail.Text = "请启用虚拟显示驱动:设备管理器 → 显示适配器 → Virtual Display Driver → 启用设备。";
            }
            else if (device.Item2)
            {
                _headline.Text = "准备就绪";
                _headline.ForeColor = Color.FromArgb(34, 211, 238);
                _detail.Text = "点「启动副屏」,平板会自动打开并显示画面。";
            }
            else
            {
                _headline.Text = "等待平板连接";
                _headline.ForeColor = Color.FromArgb(250, 204, 21);
                _detail.Text = device.Item1;
            }

            _deviceLine.Text = "平板    " + device.Item1;
            _deviceLine.ForeColor = device.Item2 ? Color.FromArgb(74, 222, 128) : Color.FromArgb(148, 163, 184);

            if (virtualDisplay is null)
            {
                _displayLine.Text = "虚拟屏  未检测到";
                _displayLine.ForeColor = Color.FromArgb(250, 204, 21);
            }
            else
            {
                var desc = virtualDisplay.Description;
                if (desc.Length > 42) desc = desc[..42] + "…";
                _displayLine.Text = $"虚拟屏  {virtualDisplay.Width}×{virtualDisplay.Height} " +
                                    $"@({virtualDisplay.X},{virtualDisplay.Y})  {desc}";
                _displayLine.ForeColor = Color.FromArgb(74, 222, 128);
            }

            var port = _server?.Port ?? DefaultPort;
            _streamLine.Text = _server is null
                ? $"推流    未启动(端口 {port})"
                : $"推流    监听中 · 编码 {_server.Encoder} · 端口 {port}";
            _streamLine.ForeColor = _server is null ? Color.FromArgb(148, 163, 184) : Color.FromArgb(74, 222, 128);

            _startButton.Enabled = canStart;
            _stopButton.Enabled = _server is not null && !_starting;
            _fillButton.Text = _fill ? "显示:铺满" : "显示:完整";

            if (_lastError is not null && _server is null)
            {
                _detail.Text = _lastError;
                _detail.ForeColor = Color.FromArgb(251, 146, 160);
            }
            else
            {
                _detail.ForeColor = Color.FromArgb(203, 213, 225);
            }
        }
        catch (Exception ex)
        {
            Log.Warn("刷新状态失败:" + ex.Message);
        }
    }

    /// <summary>返回 (状态描述, 是否可用)</summary>
    private static (string, bool) DescribeDevice(string adb)
    {
        var (serial, message) = Adb.FindDevice(adb);
        if (serial is null) return (message.Split('\n')[0], false);

        var model = Adb.Run(adb, ["shell", "getprop", "ro.product.model"])?.Trim();
        var android = Adb.Run(adb, ["shell", "getprop", "ro.build.version.release"])?.Trim();
        return ($"{model ?? serial}(Android {android ?? "?"}) · 已连接", true);
    }

    // ------------------------------------------------------------ 启动 / 停止

    private void StartSecondScreen()
    {
        if (_starting || _server is not null) return;

        _starting = true;
        _lastError = null;
        _startButton.Enabled = false;
        RefreshStatus();

        Task.Run(() =>
        {
            string? error = null;
            AppStreamServer? server = null;

            try
            {
                var adb = _adb ?? throw new InvalidOperationException("找不到 adb.exe");
                var apk = _apk ?? throw new InvalidOperationException("找不到平板端 APK");

                var (serial, message) = Adb.FindDevice(adb);
                if (serial is null) throw new InvalidOperationException(message);

                if (!Adb.Reverse(adb, DefaultPort))
                {
                    throw new InvalidOperationException("adb reverse 失败,无法建立端口隧道");
                }

                var install = Adb.InstallIfNeeded(adb, apk, _dataDir);
                if (!install.Ready) throw new InvalidOperationException(install.Message);
                Log.Info("App 安装状态:" + install.Message);

                // 先把推流服务起来,App 一启动就能连上
                server = new AppStreamServer(DefaultPort, DefaultFps, DefaultBitrate);
                server.Start();

                if (!Adb.StartApp(adb, DefaultPort, _fill))
                {
                    throw new InvalidOperationException("启动平板 App 失败");
                }
                Adb.StayAwake(adb);
            }
            catch (Exception ex)
            {
                error = ex.Message;
                Log.Warn("启动副屏失败:" + ex.Message);
                server?.Dispose();
                server = null;
            }

            BeginInvoke(() =>
            {
                _starting = false;
                _server = server;
                _lastError = error;
                RefreshStatus();
            });
        });
    }

    private void StopSecondScreen()
    {
        var server = _server;
        _server = null;

        Task.Run(() =>
        {
            try
            {
                if (_adb is not null) Adb.ForceStop(_adb);
            }
            catch (Exception ex)
            {
                Log.Warn("停止平板 App 失败:" + ex.Message);
            }

            server?.Dispose();

            BeginInvoke(() =>
            {
                _lastError = null;
                RefreshStatus();
            });
        });
    }

    private void ToggleFill()
    {
        _fill = !_fill;
        RefreshStatus();

        // 已经在跑就重启 App 让新模式生效(不必重建推流服务)
        if (_server is not null && _adb is not null)
        {
            var adb = _adb;
            var fill = _fill;
            Task.Run(() =>
            {
                try
                {
                    Adb.ForceStop(adb);
                    Thread.Sleep(300);
                    Adb.StartApp(adb, DefaultPort, fill);
                }
                catch (Exception ex)
                {
                    Log.Warn("切换显示模式失败:" + ex.Message);
                }
            });
        }
    }

    private void OpenDataDir()
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = _dataDir,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            Log.Warn("打开数据目录失败:" + ex.Message);
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _timer.Stop();
        _timer.Dispose();

        try
        {
            if (_adb is not null) Adb.ForceStop(_adb);
        }
        catch
        {
            // 关闭时不折腾
        }

        _server?.Dispose();
        _server = null;
        base.OnFormClosed(e);
    }
}
