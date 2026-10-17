using System.Text;

namespace VirtualDesk.App;

/// <summary>
/// 第二块屏 · 单文件免安装版入口。
///
/// 启动顺序:定位数据目录 → 初始化日志 → 打开信令数据库 → 启动内置 HTTP 服务 → 打开浏览器。
///
/// 这一版不需要任何外部依赖:前端静态文件嵌在程序集里,
/// 信令数据存在同目录的 SQLite 文件里,.NET 运行时也一起打包。
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        // 第一件事:确保临时目录可写。
        // 后面的每一件事(.NET 自身、WinForms、SQLite)都可能在 %TEMP% 里建文件,
        // %TEMP% 不可写时会在很早的地方抛 UnauthorizedAccessException,连日志都来不及写。
        AppPaths.EnsureWritableTemp();

        // 第二件事:声明 DPI 感知,否则枚举到的显示器分辨率会被按缩放比虚拟化
        // (1920×1080 在 125% 缩放下读成 1536×864),和浏览器报告的物理像素对不上。
        DisplayInfo.EnsureDpiAwareness();

        if (args.Any((a) => a is "--diagnose" or "-d"))
        {
            RunDiagnose();
            return;
        }

        // --serve:只起服务、不开窗口也不开浏览器,便于自动化测试与排查
        if (args.Any((a) => a is "--serve" or "-s"))
        {
            RunServe();
            return;
        }

        var dataDir = string.Empty;
        try
        {
            dataDir = AppPaths.ResolveDataDir();
            Log.Init(dataDir);
            Log.Info($"第二块屏 单文件版启动,exe = {AppPaths.ExePath}");
            Log.Info($".NET {Environment.Version} / {Environment.OSVersion.VersionString}");
            Log.Info("临时目录:" + Path.GetTempPath());

            // 提权运行会让拉起的浏览器也带上管理员令牌,和用户已有的普通权限实例冲突,
            // 表现为 Edge/Chrome 弹「现有实例正在以提升的权限运行」。程序本身不需要管理员,
            // 所以这里明确提醒一次,并把原因写进日志。
            if (AppPaths.IsElevated)
            {
                Log.Warn("检测到以管理员权限运行 —— 可能引发浏览器的权限冲突提示");
                MessageBox.Show(
                    "第二块屏不需要管理员权限,建议以普通权限重新打开。\n\n" +
                    "当前是管理员权限运行时,程序拉起的浏览器也会带上管理员令牌。\n" +
                    "如果此时你已经开着浏览器,Windows 可能弹出「现有实例正在以提升的权限运行,\n" +
                    "是否用普通权限重启现有实例?」——在那个框里选「是」即可继续。\n\n" +
                    "要避免这个提示:关闭本程序,然后直接双击运行(不要选「以管理员身份运行」)。",
                    "第二块屏 · 权限提示",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }

            using var assets = StaticAssets.Load();
            using var store = new SignalStore(dataDir);
            using var host = new WebHost(assets, store);
            host.Start();

            // 只在这里初始化 WinForms:它需要一个可写的临时目录,
            // 而 --serve / --diagnose 根本用不到界面,不该被它拖累。
            ApplicationConfiguration.Initialize();
            Application.Run(new MainForm(host.LocalUrl, host.LanUrl));
        }
        catch (Exception ex)
        {
            Log.Error("启动失败: " + ex);
            ShowError(
                "第二块屏 启动失败",
                ex.Message + "\n\n完整日志:\n" + (Log.File ?? Path.Combine(dataDir, "运行日志.txt")));
        }
    }

    /// <summary>
    /// 只起服务,不开窗口也不开浏览器。
    /// 用途:自动化测试、以及在窗口有问题时确认"服务本身是好的"。
    /// 输出里会打印访问地址,收到 Ctrl+C 或标准输入 EOF 后退出。
    /// </summary>
    private static void RunServe()
    {
        try
        {
            var dataDir = AppPaths.ResolveDataDir();
            Log.Init(dataDir);

            using var assets = StaticAssets.Load();
            using var store = new SignalStore(dataDir);
            using var host = new WebHost(assets, store);
            host.Start();

            // 把地址写到文件:宿主是 GUI 子系统,没有 stdout 可读,
            // 自动化脚本靠这个文件拿到端口
            var addressFile = Path.Combine(dataDir, "服务地址.txt");
            try
            {
                File.WriteAllText(
                    addressFile,
                    $"本机 {host.LocalUrl}\r\n" +
                    $"平板 {(host.LanUrl is null ? "(未找到局域网地址)" : host.LanUrl)}\r\n",
                    new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                Log.Warn("写服务地址文件失败:" + ex.Message);
            }

            // 给自动化脚本一个稳定的信号:这一行出现就说明可以开始请求了
            Console.WriteLine("SERVING " + host.LocalUrl);
            if (host.LanUrl is not null) Console.WriteLine("LAN " + host.LanUrl);
            Console.Out.Flush();

            // 一直等到进程被终止或收到 Ctrl+C。
            // 不能用 Console.ReadLine():没有 stdin 时它会立刻返回,进程跟着退出。
            using var stop = new ManualResetEventSlim(false);
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                stop.Set();
            };
            AppDomain.CurrentDomain.ProcessExit += (_, _) => stop.Set();
            stop.Wait();

            Log.Info("--serve 模式收到退出信号,正在关闭");
            try
            {
                File.Delete(addressFile);
            }
            catch
            {
                // 删不掉无所谓
            }
        }
        catch (Exception ex)
        {
            Log.Error("--serve 启动失败: " + ex);
            Console.Error.WriteLine("FAILED " + ex.Message);
            Environment.ExitCode = 1;
        }
    }

    /// <summary>自检:检查资源、数据目录可写性、浏览器可用性,并试绑一次端口</summary>
    private static void RunDiagnose()
    {
        var lines = new List<string> { "第二块屏 自检报告(单文件版)" };

        void Check(string name, bool ok, string detail) =>
            lines.Add($"  [{(ok ? "OK  " : "问题")}] {name}: {detail}");

        lines.Add("  exe: " + AppPaths.ExePath);
        lines.Add("  .NET: " + Environment.Version);
        lines.Add("  Windows: " + Environment.OSVersion.VersionString);
        lines.Add("  位宽: " + (Environment.Is64BitProcess ? "64 位" : "32 位"));
        lines.Add("");

        // 提权状态:管理员运行时浏览器会出现权限冲突提示,属于常见困扰,单独列出来
        if (AppPaths.IsElevated)
        {
            lines.Add("  [注意] 当前以管理员权限运行 —— 浏览器可能出现「提升的权限」冲突提示");
            lines.Add("         建议关闭后用普通权限双击运行");
        }
        else
        {
            lines.Add("  [OK  ] 运行权限: 普通权限(推荐)");
        }
        lines.Add("");

        // 前端资源
        try
        {
            using var assets = StaticAssets.Load();
            Check("前端静态资源", assets.FileCount > 0, $"{assets.FileCount} 个文件");
            Check("首页 index.html", assets.Contains("index.html"), "静态导出产物");
        }
        catch (Exception ex)
        {
            Check("前端静态资源", false, ex.Message);
        }

        // 数据目录
        lines.Add("");
        lines.Add("数据目录候选:");
        var chosen = "(无)";
        foreach (var (dir, label) in AppPaths.DataDirCandidates())
        {
            var ok = AppPaths.IsWritable(dir);
            if (ok && chosen == "(无)") chosen = dir;
            lines.Add($"  [{(ok ? "可写" : "不可写")}] {dir}   ({label})");
        }
        Check("数据目录可用", chosen != "(无)", chosen);

        // 信令数据库
        if (chosen != "(无)")
        {
            try
            {
                using var store = new SignalStore(chosen);
                var code = store.CreateUniqueCode();
                store.Insert(code, null);
                var read = store.Get(code);
                Check("信令数据库(SQLite)", read is not null, $"写入并读回配对码 {code}");
                Check("过期清理", store.CleanupExpired() >= 0, "可执行");
            }
            catch (Exception ex)
            {
                Check("信令数据库(SQLite)", false, ex.Message);
            }
        }

        // 局域网地址与端口
        lines.Add("");
        var lan = AppPaths.LanAddresses();
        if (lan.Count == 0)
        {
            lines.Add("  [问题] 局域网地址: 未找到 —— 平板将无法接入");
        }
        else
        {
            for (var i = 0; i < lan.Count; i += 1)
            {
                var (address, label) = lan[i];
                var hint = i == 0 ? "(推荐给平板)" : "(平板通常访问不到)";
                lines.Add($"  [OK  ] 局域网地址: {address}  ({label}) {hint}");
            }
        }

        // 显示器:决定"能不能扩展成副屏"
        lines.Add("");
        var displays = DisplayInfo.Enumerate();
        if (displays.Count == 0)
        {
            lines.Add("  [问题] 显示器: 枚举失败");
        }
        else
        {
            foreach (var d in displays)
            {
                var tags = (d.IsPrimary ? " 主屏" : "") + (d.IsLikelyVirtual ? " 虚拟" : "");
                lines.Add($"  [OK  ] 显示器: {d.Width}×{d.Height}{tags}  ({d.Description})");
            }

            if (displays.Count >= 2)
            {
                var target = displays.FirstOrDefault((d) => !d.IsPrimary && d.IsLikelyVirtual)
                             ?? displays.FirstOrDefault((d) => !d.IsPrimary);
                lines.Add($"  [OK  ] 可以扩展桌面 —— 共享时请选 {target?.Width}×{target?.Height} 那一块");
            }
            else
            {
                lines.Add("  [注意] 只有 1 块屏幕 —— 当前只能镜像,不能扩展");
                lines.Add("         要当副屏用,需要先安装虚拟显示驱动(见 README「把平板当副屏」)");
            }
        }

        // 防火墙:平板连不上最常见的原因之一
        lines.Add("");
        if (FirewallHelper.HasRule())
        {
            lines.Add("  [OK  ] 防火墙: 已存在本程序的放行规则");
        }
        else
        {
            lines.Add("  [注意] 防火墙: 未找到本程序的放行规则");
            lines.Add("         如果平板打不开页面,请点控制面板的「放行防火墙」,或用管理员执行:");
            lines.Add("         " + FirewallHelper.ManualCommand(AppPaths.ExePath));
        }

        // 浏览器
        try
        {
            var browsers = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
            };
            var found = browsers.Where(File.Exists).Select(Path.GetFileName).ToArray();
            Check("本机浏览器(用于采集屏幕)", found.Length > 0,
                found.Length > 0 ? string.Join(", ", found) : "未找到 Chrome/Edge,请安装其一");
        }
        catch (Exception ex)
        {
            Check("本机浏览器(用于采集屏幕)", false, ex.Message);
        }

        var report = string.Join(Environment.NewLine, lines);
        Console.WriteLine(report);
        try
        {
            File.WriteAllText(Path.Combine(AppPaths.ExeDir, "自检报告.txt"), report, new UTF8Encoding(false));
        }
        catch
        {
            // 写不出来就算了
        }

        ShowError("第二块屏 自检", report);
    }

    private static void ShowError(string title, string message)
    {
        try
        {
            MessageBox.Show(message, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch
        {
            // 没有桌面环境时忽略
        }
    }
}
