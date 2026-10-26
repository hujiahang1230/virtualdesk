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

        // --stream-app:推给自研 Android App(ADB 自动安装/启动/端口反代)
        var appIndex = Array.IndexOf(args, "--stream-app");
        if (appIndex >= 0)
        {
            RunAppStream(args, appIndex);
            return;
        }

        // --stream:原生推流(不走浏览器)。把虚拟显示器编码成 H.264 推到平板。
        //   --stream              自动猜平板地址(USB 链路的网关)
        //   --stream 127.0.0.1    指定地址,便于本机自测
        var streamIndex = Array.IndexOf(args, "--stream");
        if (streamIndex >= 0)
        {
            RunStream(args, streamIndex);
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

            // 程序本身不需要管理员权限。以前这里有一条"提权会让拉起的浏览器带上管理员令牌"
            // 的提示 —— 现在不再启动浏览器,那条提示已经没有意义,只保留日志记录。
            if (AppPaths.IsElevated)
            {
                Log.Warn("以管理员权限运行;本程序不需要管理员权限");
            }

            // 界面只服务 Android 副屏这一条路径:不再启动 HTTP 服务、不再打开浏览器。
            // (Web 版信令服务仍保留给 --serve 与 npm run dev 使用。)
            ApplicationConfiguration.Initialize();
            Application.Run(new MainForm(dataDir));
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
    /// 面向自研 Android App 的一键副屏。
    ///
    /// 做的事情(全部由 PC 发起,平板上不需要任何操作):
    ///   1. 找到 adb 与已连接的平板
    ///   2. adb reverse 建立端口隧道(平板上的 127.0.0.1:port 直达 PC)
    ///   3. adb install 安装/升级 APK
    ///   4. 启动推流服务(等平板来连)
    ///   5. adb shell am start 拉起 App,并保持屏幕常亮
    ///
    /// 用法:
    ///   --stream-app                 默认端口 5000 / 60fps / 12M
    ///   --stream-app 5000 30 8M      指定端口/帧率/码率(帧率调低可省 CPU/带宽)
    ///   --stream-app --fit           完整显示(留黑边),默认是铺满(裁切)
    ///   --stream-app 5000 30 8M      指定端口/帧率/码率
    /// </summary>
    private static void RunAppStream(string[] args, int index)
    {
        var dataDir = string.Empty;
        try
        {
            dataDir = AppPaths.ResolveDataDir();
            Log.Init(dataDir);
            Log.Info("===== 一键副屏(Android App)=====");

            var port = index + 1 < args.Length && int.TryParse(args[index + 1], out var p) ? p : 5000;
            // 默认 60fps:虚拟屏本身就是 60Hz,实测 1080p@60 只占 1.7 个核、能跑满。
            // 早先默认 30 是照搬了"GDI 最多 45fps"的旧测量结果 —— 那是在机器有其他负载时测的。
            var fps = index + 2 < args.Length && int.TryParse(args[index + 2], out var f) ? f : 60;
            // USB 直连带宽充裕,12M 给 60fps 留足余量(1080p60 一般 6~12M)
            var bitrate = index + 3 < args.Length ? args[index + 3] : "12M";

            // ---- adb ----
            // VD_SKIP_ADB=1 时跳过 ADB 环节,只起推流服务。
            // 用途:平板已手动装好 App、或没有可用 adb 时仍能推流;也便于自动化测试协议。
            var skipAdb = Environment.GetEnvironmentVariable("VD_SKIP_ADB") == "1";
            string? adb = null;

            if (!skipAdb)
            {
                adb = Adb.ResolveAdb();
                if (adb is null)
                {
                    Fail("找不到 adb.exe。请把 platform-tools 里的 adb.exe 放到程序目录,或加入 PATH。\n" +
                         "若想跳过 ADB 手工装 App,可设置环境变量 VD_SKIP_ADB=1。");
                    return;
                }
                Log.Info("adb = " + adb);

                var (serial, message) = Adb.FindDevice(adb);
                if (serial is null)
                {
                    Fail("没有可用的平板:\n" + message);
                    return;
                }
                Log.Info($"设备 {serial} 已就绪");
            }
            else
            {
                Log.Info("VD_SKIP_ADB=1,跳过 ADB(不安装/不启动,只推流)");
                Console.WriteLine("  ⚠ 已跳过 ADB:请自行在平板上安装并打开「第二块屏」");
            }

            // ---- APK ----
            // 即使跳过 ADB 也解析一次:一是把结果打出来便于排查,二是顺带验证
            // 内嵌资源能否正常释放(单文件分发时这是唯一来源)。
            var apk = ResolveApkPath();
            if (apk is null)
            {
                if (!skipAdb)
                {
                    Fail("找不到 APK(virtualdesk-viewer.apk)。请把它放到程序目录,或先运行 tools/build-apk.mjs。");
                    return;
                }
                Console.WriteLine("  ⚠ 未找到 APK(跳过 ADB 模式,不影响推流)");
            }
            else
            {
                Log.Info("APK = " + apk + $"({new FileInfo(apk).Length / 1024} KiB)");
                Console.WriteLine($"  ✓ APK 就绪:{Path.GetFileName(apk)}({new FileInfo(apk).Length / 1024} KiB)");
            }

            // ---- 端口隧道 ----
            if (!skipAdb)
            {
                if (!Adb.Reverse(adb!, port))
                {
                    Fail("adb reverse 失败,无法建立端口隧道。");
                    return;
                }
                Log.Info($"端口隧道已建立:tcp:{port} → 平板 127.0.0.1:{port}");
                Console.WriteLine($"  ✓ 端口隧道已建立(平板 127.0.0.1:{port} → 本机)");

                // ---- 安装(只在 APK 变化或未安装时才真正执行)----
                var install = Adb.InstallIfNeeded(adb!, apk!, dataDir, Adb.ReadEmbeddedApkVersion());
                if (!install.Ready)
                {
                    Fail(install.Message);
                    return;
                }
                Console.WriteLine("  ✓ App " + install.Message);
            }

            // ---- 推流服务(先起来,等平板连)----
            using var server = new AppStreamServer(port, fps, bitrate);
            server.Start();

            Console.WriteLine();
            Console.WriteLine("  一键副屏已就绪");
            Console.WriteLine("    捕获区域  " + server.CaptureRegion);
            Console.WriteLine("    编码器    " + server.Encoder);
            Console.WriteLine($"    参数      {fps}fps, {bitrate}");
            Console.WriteLine();

            // ---- 启动 App ----
            if (!skipAdb)
            {
                // --fit:显示完整画面(留黑边);默认是铺满(裁掉溢出的两侧)
                var fill = !args.Contains("--fit");
                if (!Adb.StartApp(adb!, port, fill, fps))
                {
                    Console.WriteLine("  ⚠ 自动启动失败,请手动点开平板上的「第二块屏」");
                }
                else
                {
                    Console.WriteLine($"  ✓ 已在平板上启动「第二块屏」({(fill ? "铺满" : "完整显示")})");
                }
                Adb.StayAwake(adb!);
            }

            Console.WriteLine();
            Console.WriteLine(skipAdb
                ? "  等待平板上的「第二块屏」连接(按回车停止)…"
                : "  平板端不需要任何操作。按回车停止…");

            var stop = new ManualResetEventSlim(false);
            if (!Console.IsInputRedirected)
            {
                _ = Task.Run(() =>
                {
                    try
                    {
                        Console.ReadLine();
                    }
                    catch
                    {
                        // 忽略
                    }
                    stop.Set();
                });
            }
            else
            {
                Log.Info("标准输入已重定向,不等待回车;结束进程即可停止");
            }

            while (!stop.IsSet)
            {
                Thread.Sleep(500);
            }

            Log.Info("一键副屏结束");
        }
        catch (Exception ex)
        {
            Log.Error("一键副屏启动失败:" + ex);
            Fail(ex.Message);
        }
    }

    /// <summary>
    /// 找 APK:优先程序目录,其次开发时的构建输出,最后用 exe 内嵌的那份。
    ///
    /// 内嵌是为了"单文件分发":用户只拿到一个 第二块屏.exe,也能把 App 装到平板上,
    /// 不需要另外拷一个 apk 文件。释放位置放在数据目录,便于复用与排查。
    /// 控制面板也复用这个方法。
    /// </summary>
    internal static string? ResolveApkPath()
    {
        string[] candidates =
        [
            Path.Combine(AppPaths.ExeDir, "virtualdesk-viewer.apk"),
        ];

        // 开发时 APK 在项目 tools/apk 下,与 exe 的层级关系随构建方式而变,逐层向上找
        var dev = AppPaths.FindUpwards(Path.Combine("tools", "apk", "virtualdesk-viewer.apk"));
        if (dev is not null) candidates = [.. candidates, dev];

        foreach (var candidate in candidates)
        {
            try
            {
                var full = Path.GetFullPath(candidate);
                if (File.Exists(full)) return full;
            }
            catch
            {
                // 忽略非法路径
            }
        }

        // 退回内嵌资源:释放到数据目录
        try
        {
            using var resource = typeof(Program).Assembly.GetManifestResourceStream("VirtualDesk.Viewer.apk");
            if (resource is null) return null;

            var target = Path.Combine(AppPaths.ResolveDataDir(), "virtualdesk-viewer.apk");
            using (var file = File.Create(target))
            {
                resource.CopyTo(file);
            }
            Log.Info("已从内嵌资源释放 APK:" + target);
            return target;
        }
        catch (Exception ex)
        {
            Log.Warn("释放内嵌 APK 失败:" + ex.Message);
            return null;
        }
    }

    private static void Fail(string message)
    {
        Log.Error(message);
        Console.Error.WriteLine();
        Console.Error.WriteLine("  ✗ " + message.Replace("\n", "\n    "));
        Console.Error.WriteLine();
        Environment.ExitCode = 1;
    }

    /// <summary>
    /// 原生推流模式:不起 HTTP 服务,也不开浏览器,直接把虚拟显示器推给平板。
    ///
    /// 用法:
    ///   --stream                 自动猜本机地址(优先 USB 直连链路)
    ///   --stream 127.0.0.1       指定给用户看的地址(本机自测)
    ///   --stream 192.168.42.1 5000 30 6M   指定地址/端口/帧率/码率
    ///
    /// 平板端用 VLC 打开 tcp://本机IP:端口 即可观看。按回车或 Ctrl+C 停止。
    /// </summary>
    private static void RunStream(string[] args, int index)
    {
        var dataDir = string.Empty;
        try
        {
            dataDir = AppPaths.ResolveDataDir();
            Log.Init(dataDir);
            Log.Info("===== 原生推流模式 =====");

            // 参数:--stream [host] [port] [fps] [bitrate]
            string? host = index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal)
                ? args[index + 1]
                : null;
            var port = index + 2 < args.Length && int.TryParse(args[index + 2], out var p) ? p : 5000;
            var fps = index + 3 < args.Length && int.TryParse(args[index + 3], out var f) ? f : 60;
            var bitrate = index + 4 < args.Length ? args[index + 4] : "12M";

            if (host is null)
            {
                // 优先用 USB 直连链路的地址:平板和它在同一网段,直接可达
                host = AppPaths.LanAddresses().Select((c) => c.Address).FirstOrDefault()
                       ?? Streamer.GuessTabletAddress()
                       ?? "127.0.0.1";
                Log.Info("自动选择本机地址:" + host);
            }

            using var streamer = new Streamer();
            streamer.Start(host, port, fps, bitrate);

            Console.WriteLine();
            Console.WriteLine("  原生推流已启动(不经过浏览器)");
            Console.WriteLine("    捕获区域  " + streamer.CaptureRegion);
            Console.WriteLine("    编码器    " + streamer.Encoder);
            Console.WriteLine($"    平板连接  {streamer.ClientUrl}");
            Console.WriteLine($"    参数      {fps}fps, {bitrate}");
            Console.WriteLine();
            Console.WriteLine("  平板端(VLC):");
            Console.WriteLine("    「网络」→「流」→ 输入 " + streamer.ClientUrl);
            Console.WriteLine("    建议把网络缓存调到 100~200ms 以降低延迟");
            Console.WriteLine();
            Console.WriteLine("  注意:ffmpeg 会先等待平板连接,连上之后才开始编码。");
            Console.WriteLine("  按回车停止推流…");
            Console.WriteLine();

            // 停止条件:
            //   1. 标准输入可用时,读一行(用户在终端里按回车)
            //   2. 标准输入被重定向/关闭时,不去读 —— 否则 ReadLine 会立刻返回 null,
            //      程序瞬间退出,而调用方还以为在推流(这个坑踩过一次:导致接收端一直干等)
            var stop = new ManualResetEventSlim(false);
            if (!Console.IsInputRedirected)
            {
                _ = Task.Run(() =>
                {
                    try
                    {
                        Console.ReadLine();
                    }
                    catch
                    {
                        // 忽略
                    }
                    stop.Set();
                });
            }
            else
            {
                Log.Info("标准输入已重定向,不等待回车;结束进程即可停止推流");
            }

            // 守护循环:ffmpeg 在客户端断开后会以 -10053 之类错误退出,
            // 这里自动重新起一次,让平板随时可以重连(否则用户一断线就得回电脑重启)。
            var restarts = 0;
            while (!stop.IsSet)
            {
                while (!stop.IsSet && !streamer.HasExited)
                {
                    Thread.Sleep(500);
                }

                if (stop.IsSet) break;

                restarts += 1;
                Log.Warn($"推流中断,准备第 {restarts} 次重连(等平板重新连接)");
                Console.WriteLine($"  推流中断,已自动重启第 {restarts} 次 —— 平板可以重新连接");

                streamer.Dispose();
                Thread.Sleep(1000);
                if (stop.IsSet) break;

                try
                {
                    streamer.Start(host, port, fps, bitrate);
                }
                catch (Exception ex)
                {
                    Log.Error("重启推流失败:" + ex.Message);
                    break;
                }
            }

            Log.Info("推流结束");
        }
        catch (Exception ex)
        {
            Log.Error("推流启动失败:" + ex);
            Console.Error.WriteLine("推流启动失败:" + ex.Message);
            Environment.ExitCode = 1;
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
        if (AppPaths.HasUsbTethering())
        {
            lines.Add("  [OK  ] USB 直连: 已检测到 USB 网络共享链路(点对点,优先使用)");
        }
        else
        {
            lines.Add("  [提示] USB 直连: 未检测到。用数据线连平板并开启「USB 共享网络」可绕开 Wi-Fi 问题");
        }
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
            if (FirewallHelper.IsOnPublicNetwork())
            {
                lines.Add("  [注意] 当前网络为「公用网络」:放行规则同样生效,");
                lines.Add("         同一网络下的其他设备可访问本程序的页面与信令接口。");
            }
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
