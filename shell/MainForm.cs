using System.Text.Json.Nodes;

namespace VirtualDesk.App;

/// <summary>
/// 第二块屏 · 控制面板。
///
/// 启动后直接显示的主界面:当前状态、配对码、平板接入入口、操作按钮。
///
/// 关于二维码:由前端页面(/qr)在浏览器里用内置的 qrcode-generator 生成。
/// 这里不再自己编码 —— WinForms 的二维码要手写编码器,风险高且难验证;
/// 浏览器端有成熟实现,还能直接把图放大给平板扫。
///
/// 采集那一步仍然必须在系统浏览器里完成:内嵌内核不提供 getDisplayMedia。
/// 所以本窗口的定位是"应用主界面",把该做的事都做完,只在采集时借用浏览器。
/// </summary>
internal sealed class MainForm : Form
{
    private readonly string _localUrl;
    private readonly string? _lanUrl;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 1500 };

    private readonly Label _headline = new()
    {
        AutoSize = false,
        Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold),
        ForeColor = Color.FromArgb(34, 211, 238),
        Text = "正在启动…",
    };

    private readonly Label _detail = new()
    {
        AutoSize = false,
        Font = new Font("Microsoft YaHei UI", 9.5F),
        ForeColor = Color.FromArgb(203, 213, 225),
    };

    private readonly Label _codeLabel = new()
    {
        AutoSize = false,
        Font = new Font("Consolas", 32F, FontStyle.Bold),
        ForeColor = Color.FromArgb(226, 232, 245),
        TextAlign = ContentAlignment.MiddleLeft,
        Text = "— — — — — —",
    };

    private readonly Label _codeCaption = new()
    {
        AutoSize = true,
        Font = new Font("Microsoft YaHei UI", 8.5F),
        ForeColor = Color.FromArgb(100, 116, 139),
        Text = "平板配对码",
    };

    private readonly Label _step1 = new() { AutoSize = true, Font = new Font("Microsoft YaHei UI", 9.5F) };
    private readonly Label _step2 = new() { AutoSize = true, Font = new Font("Microsoft YaHei UI", 9.5F) };
    private readonly Label _step3 = new() { AutoSize = true, Font = new Font("Microsoft YaHei UI", 9.5F) };

    /// <summary>能不能扩展桌面(有几块屏)—— 副屏场景最要紧的一行</summary>
    private readonly Label _displayHint = new()
    {
        AutoSize = false,
        Font = new Font("Microsoft YaHei UI", 9F),
        ForeColor = Color.FromArgb(148, 163, 184),
        Text = "显示器:正在检测…",
    };

    private readonly LinkLabel _computerLink = new()
    {
        AutoSize = true,
        Font = new Font("Consolas", 9.5F),
        LinkColor = Color.FromArgb(148, 197, 255),
        ActiveLinkColor = Color.FromArgb(34, 211, 238),
    };

    private readonly LinkLabel _tabletLink = new()
    {
        AutoSize = true,
        Font = new Font("Consolas", 9.5F),
        LinkColor = Color.FromArgb(148, 197, 255),
        ActiveLinkColor = Color.FromArgb(34, 211, 238),
    };

    private readonly LinkLabel _qrLink = new()
    {
        AutoSize = true,
        Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
        LinkColor = Color.FromArgb(34, 211, 238),
        ActiveLinkColor = Color.FromArgb(165, 243, 252),
        Text = "▶ 打开平板二维码",
    };

    private string? _currentCode;
    private bool _firstRefreshDone;

    public MainForm(string localUrl, string? lanUrl)
    {
        _localUrl = localUrl;
        _lanUrl = lanUrl;

        Text = "第二块屏 · 电脑端";
        Width = 900;
        Height = 620;
        MinimumSize = new Size(860, 580);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(7, 11, 20);
        ForeColor = Color.FromArgb(226, 232, 245);
        TrySetIcon();

        BuildLayout();

        _timer.Tick += (_, _) => RefreshStatus();
        _timer.Start();

        Log.Info("控制面板已创建,服务地址 " + localUrl);
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

    // ------------------------------------------------------------ 界面搭建

    private void BuildLayout()
    {
        // 底部操作按钮(6 个,自动换行成两排)
        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 132,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            Padding = new Padding(20, 12, 20, 12),
            BackColor = Color.FromArgb(7, 11, 20),
        };
        buttons.Controls.Add(MakeButton("🌐 打开共享页", Color.FromArgb(34, 211, 238), () =>
            Open($"{_localUrl}/host")));
        buttons.Controls.Add(MakeButton("🔗 复制电脑端地址", Color.FromArgb(45, 58, 84), () =>
        {
            Clipboard.SetText($"{_localUrl}/host");
            _detail.Text = "已复制电脑端地址。粘贴到浏览器地址栏打开即可。";
        }));
        buttons.Controls.Add(MakeButton("📋 复制平板链接", Color.FromArgb(45, 58, 84), () =>
        {
            var target = _lanUrl is null ? $"{_localUrl}/view" : $"{_lanUrl}/view";
            Clipboard.SetText(target);
            _detail.Text = "已复制平板链接:" + target;
        }));
        buttons.Controls.Add(MakeButton("🛡 放行防火墙", Color.FromArgb(250, 204, 21), AllowFirewall));
        buttons.Controls.Add(MakeButton("📂 数据目录", Color.FromArgb(45, 58, 84), OpenDataDir));
        Controls.Add(buttons);

        // 顶部:两个地址
        var header = new Panel
        {
            Dock = DockStyle.Top,
            Height = 108,
            BackColor = Color.FromArgb(7, 11, 20),
        };

        header.Controls.Add(MakeCaption("电脑端页面(在这台电脑上打开,用来共享屏幕)", 24, 8));
        _computerLink.Text = $"{_localUrl}/host";
        _computerLink.Location = new Point(24, 26);
        _computerLink.LinkClicked += (_, _) => Open($"{_localUrl}/host");
        header.Controls.Add(_computerLink);

        header.Controls.Add(MakeCaption(
            _lanUrl is null ? "平板端地址(未找到局域网地址,平板可能连不上)" : "平板端地址(在平板浏览器里打开)",
            24, 56));
        _tabletLink.Text = _lanUrl is null ? "—" : $"{_lanUrl}/view";
        _tabletLink.Location = new Point(24, 74);
        _tabletLink.LinkClicked += (_, _) =>
        {
            if (_lanUrl is not null) Open($"{_lanUrl}/view");
        };
        header.Controls.Add(_tabletLink);
        Controls.Add(header);

        // 中部:状态、配对码、步骤
        var body = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(7, 11, 20) };

        _headline.Location = new Point(24, 6);
        _headline.Size = new Size(700, 34);
        _detail.Location = new Point(24, 42);
        _detail.Size = new Size(720, 46);

        _codeCaption.Location = new Point(24, 100);
        _codeLabel.Location = new Point(20, 118);
        _codeLabel.Size = new Size(420, 56);

        _qrLink.Location = new Point(24, 186);
        _qrLink.LinkClicked += (_, _) => Open($"{_localUrl}/qr");

        // 能不能扩展 —— 放在步骤上方,因为它决定整个过程是否成立
        _displayHint.Location = new Point(24, 214);
        _displayHint.Size = new Size(760, 22);

        var steps = new FlowLayoutPanel
        {
            Location = new Point(24, 242),
            Width = 740,
            Height = 116,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
        };
        steps.Controls.Add(_step1);
        steps.Controls.Add(_step2);
        steps.Controls.Add(_step3);

        body.Controls.Add(_headline);
        body.Controls.Add(_detail);
        body.Controls.Add(_codeCaption);
        body.Controls.Add(_codeLabel);
        body.Controls.Add(_qrLink);
        body.Controls.Add(_displayHint);
        body.Controls.Add(steps);
        Controls.Add(body);
        body.BringToFront();

        UpdateSteps(null, false, false);
    }

    private static Label MakeCaption(string text, int x, int y) => new()
    {
        AutoSize = true,
        Location = new Point(x, y),
        Text = text,
        Font = new Font("Microsoft YaHei UI", 8.5F),
        ForeColor = Color.FromArgb(100, 116, 139),
    };

    private static Button MakeButton(string text, Color backColor, Action onClick)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = false,
            Width = 200,
            Height = 46,
            FlatStyle = FlatStyle.Flat,
            BackColor = backColor,
            ForeColor = Color.FromArgb(4, 18, 26),
            Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
            Margin = new Padding(0, 0, 10, 8),
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
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            var json = client.GetStringAsync($"{_localUrl}/api/status").GetAwaiter().GetResult();
            var node = JsonNode.Parse(json);

            var code = node?["code"]?.GetValue<string>();
            var sharing = node?["sharing"]?.GetValue<bool>() ?? false;
            var connected = node?["connected"]?.GetValue<bool>() ?? false;
            var displayCount = node?["displayCount"]?.GetValue<int>() ?? 0;
            var canExtend = node?["canExtend"]?.GetValue<bool>() ?? false;
            var recommendedSize = node?["recommendedDisplaySize"]?.GetValue<string>();

            if (code != _currentCode)
            {
                _currentCode = code;
                _codeLabel.Text = code is null ? "— — — — — —" : string.Join(' ', code.ToCharArray());
            }

            UpdateDisplayHint(displayCount, canExtend, recommendedSize);
            _firstRefreshDone = true;
            UpdateSteps(code, sharing, connected);
        }
        catch (Exception ex)
        {
            if (!_firstRefreshDone) _detail.Text = "正在读取状态…";
            Log.Warn("读取状态失败:" + ex.Message);
        }
    }

    /// <summary>
    /// 更新"能不能扩展"这一行。
    ///
    /// 副屏场景的核心前提是系统里有两块屏。装完虚拟显示驱动后不用重启本程序,
    /// 这个提示会随状态刷新自动变过来。
    /// </summary>
    private void UpdateDisplayHint(int count, bool canExtend, string? recommendedSize)
    {
        if (count == 0)
        {
            _displayHint.Text = "显示器:未检测到(读取失败)";
            _displayHint.ForeColor = Color.FromArgb(148, 163, 184);
            return;
        }

        if (canExtend)
        {
            _displayHint.Text = recommendedSize is null
                ? $"✅ 检测到 {count} 块屏幕 · 共享时请选非主屏那一块"
                : $"✅ 检测到 {count} 块屏幕 · 共享时请选 {recommendedSize} 那块(扩展屏)";
            _displayHint.ForeColor = Color.FromArgb(74, 222, 128);
        }
        else
        {
            _displayHint.Text = "⚠ 只有 1 块屏幕 · 当前是镜像,不是扩展。装虚拟显示驱动后会自动变成可扩展";
            _displayHint.ForeColor = Color.FromArgb(250, 204, 21);
        }
    }

    private void UpdateSteps(string? code, bool sharing, bool connected)
    {
        if (connected)
        {
            _headline.Text = "平板已接入,画面传输中";
            _headline.ForeColor = Color.FromArgb(74, 222, 128);
            _detail.Text = "视频在本机与平板之间点对点传输,不经过服务器。";
        }
        else if (sharing)
        {
            _headline.Text = "等待平板接入…";
            _headline.ForeColor = Color.FromArgb(250, 204, 21);
            _detail.Text = "让平板扫描二维码,或打开平板端地址并输入配对码。";
        }
        else
        {
            _headline.Text = "准备就绪 · 等待开始共享";
            _headline.ForeColor = Color.FromArgb(34, 211, 238);
            _detail.Text = "共享页已经帮你打开了。在弹出的浏览器窗口里点「开始共享」,选择共享整个屏幕。";
        }

        _step1.Text = "① 启动内置服务 —— 已完成";
        _step1.ForeColor = Color.FromArgb(148, 163, 184);

        _step2.Text = (code is null ? "② " : "② ✓ ") +
                      (code is null ? "在浏览器里点「开始共享」并选整个屏幕" : $"已在共享,配对码 {code}");
        _step2.ForeColor = code is null ? Color.FromArgb(148, 163, 184) : Color.FromArgb(34, 211, 238);

        _step3.Text = (connected ? "③ ✓ " : "③ ") + "平板扫码或输入配对码接入";
        _step3.ForeColor = connected
            ? Color.FromArgb(74, 222, 128)
            : sharing
                ? Color.FromArgb(250, 204, 21)
                : Color.FromArgb(148, 163, 184);
    }

    /// <summary>
    /// 一键放行防火墙。
    ///
    /// 平板连不上时,最常见的原因就是 Windows 防火墙拦住了入站连接:
    /// 程序首次监听时系统会弹「允许访问网络」,若当时取消了就再也进不来。
    /// 这里用 netsh 加一条入站放行规则,会触发一次 UAC 确认。
    /// </summary>
    private void AllowFirewall()
    {
        var exe = AppPaths.ExePath;

        if (FirewallHelper.HasRule())
        {
            _detail.Text = "防火墙规则已存在,应该不是防火墙的问题。\n" +
                           "请确认平板和电脑连的是同一个 Wi-Fi,且路由器没有开启「AP 隔离」。";
            MessageBox.Show(
                "已经存在放行规则,所以平板连不上大概不是防火墙造成的。\n\n" +
                "请检查:\n" +
                "  1. 平板与电脑是否连的同一个 Wi-Fi(同网段)\n" +
                "  2. 路由器是否开启了「AP 隔离 / 客户端隔离」\n" +
                $"  3. 在平板浏览器里能否打开:{_lanUrl ?? _localUrl}/api/health\n\n" +
                "第 3 条最关键:打不开说明是网络层不通,与画面无关。",
                "第二块屏 · 防火墙",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        _detail.Text = "正在请求放行防火墙…(会弹一次管理员确认)";
        Application.DoEvents();

        if (FirewallHelper.Allow(exe))
        {
            _detail.Text = "防火墙已放行。请让平板重新打开:" +
                           $"{(_lanUrl is null ? _localUrl : _lanUrl)}/view";
            MessageBox.Show(
                "已为程序添加防火墙放行规则。\n\n" +
                "现在让平板重新打开接收页即可。若仍然不行,请在平板浏览器里试这个地址:\n" +
                $"{(_lanUrl is null ? _localUrl : _lanUrl)}/api/health\n\n" +
                "  能打开(显示一段 JSON)→ 网络通了,问题在画面协商\n" +
                "  打不开            → 网络层不通,检查 Wi-Fi 是否同网段",
                "第二块屏 · 已放行",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        else
        {
            _detail.Text = "放行失败。可以手动执行命令(需要管理员权限)";
            MessageBox.Show(
                "自动放行没有成功(可能你在 UAC 弹窗里点了取消)。\n\n" +
                "可以手动放行:用「管理员身份」打开 PowerShell,执行下面这行:\n\n" +
                FirewallHelper.ManualCommand(exe) +
                "\n\n执行完让平板重新打开接收页。",
                "第二块屏 · 防火墙",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private void OpenDataDir()
    {        try
        {
            var dir = Path.GetDirectoryName(Log.File!);
            if (dir is null) return;
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = dir,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            Log.Warn("打开数据目录失败:" + ex.Message);
        }
    }

    private void Open(string url) => AppPaths.OpenInBrowser(url);

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // 启动后直接把共享页开好,用户只需要在弹出的窗口里点一下"共享"
        Open($"{_localUrl}/host");
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _timer.Stop();
        _timer.Dispose();
        base.OnFormClosed(e);
    }
}
