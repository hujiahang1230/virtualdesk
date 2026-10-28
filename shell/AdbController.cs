using System.Diagnostics;

namespace VirtualDesk.App;

/// <summary>
/// ADB 编排:让 PC 端能够"直接控制平板"。
///
/// 为什么需要它:
///   - 平板不需要手工装 APK —— PC 自动 adb install
///   - 平板不需要输入任何 IP —— adb reverse 把平板上的 127.0.0.1:port 隧道到 PC
///   - 平板不需要手动点开 App —— adb shell am start 自动拉起
///   - 顺带保持屏幕常亮,副屏不会自己熄掉
///
/// 前置条件只有一条:平板上打开过一次「USB 调试」。(之后 PC 记住授权,不用重复)
/// </summary>
internal static class Adb
{
    public const string PackageName = "com.virtualdesk.viewer";
    public const string ActivityName = ".MainActivity";

    /// <summary>
    /// 定位 adb.exe:环境变量 → 程序目录 → 项目工具链(逐层向上找)→ PATH → 常见安装位置。
    /// </summary>
    public static string? ResolveAdb()
    {
        // 显式指定优先,便于排查与自定义部署
        var configured = Environment.GetEnvironmentVariable("VD_ADB");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;

        var candidates = new List<string>
        {
            Path.Combine(AppPaths.ExeDir, "adb.exe"),
            Path.Combine(AppPaths.ExeDir, "platform-tools", "adb.exe"),
        };

        // 开发时用的工具链在项目内 .android-build 下;打包版放在 dist 下。
        // 两者离 exe 的层数不同,所以逐层向上找而不是写死相对路径。
        var toolchain = AppPaths.FindUpwards(Path.Combine(".android-build", "sdk", "platform-tools", "adb.exe"));
        if (toolchain is not null) candidates.Add(toolchain);

        var pathVariable = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                candidates.Add(Path.Combine(directory.Trim(), "adb.exe"));
            }
            catch
            {
                // PATH 里可能有非法项
            }
        }

        candidates.Add(@"C:\Android\platform-tools\adb.exe");
        candidates.Add(@"C:\platform-tools\adb.exe");

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

        return null;
    }

    /// <summary>执行 adb 并返回输出(失败返回 null)</summary>
    public static string? Run(string adb, IEnumerable<string> arguments, int timeoutMs = 20_000)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = adb,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);

            using var process = Process.Start(startInfo);
            if (process is null) return null;

            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            process.WaitForExit(timeoutMs);

            var combined = (output + "\n" + error).Trim();
            if (process.ExitCode != 0)
            {
                Log.Warn($"adb {string.Join(' ', arguments)} → 退出码 {process.ExitCode}:{combined}");
            }
            return combined;
        }
        catch (Exception ex)
        {
            Log.Error("执行 adb 失败:" + ex.Message);
            return null;
        }
    }

    /// <summary>
    /// 找一个可用于安装的设备。
    /// 返回 (serial, 状态说明);没有设备时 serial 为 null。
    /// </summary>
    public static (string? Serial, string Message) FindDevice(string adb)
    {
        var output = Run(adb, ["devices"]);
        if (output is null) return (null, "无法执行 adb,请检查 adb.exe 是否存在");

        var lines = output.Split('\n')
            .Select((l) => l.Trim())
            .Where((l) => l.Length > 0 && !l.StartsWith("List of devices", StringComparison.OrdinalIgnoreCase))
            .ToList();

        var unauthorized = lines.FirstOrDefault((l) => l.Contains("unauthorized", StringComparison.OrdinalIgnoreCase));
        if (unauthorized is not null)
        {
            return (null,
                "平板已连接但**未授权**。请在平板上弹出的「允许 USB 调试吗?」里点「允许」\n" +
                "(建议勾选「一律允许使用这台计算机进行调试」)。\n" +
                "如果没看到弹窗:开发者选项 → 撤销 USB 调试授权,再重新插线。");
        }

        var offline = lines.FirstOrDefault((l) => l.Contains("offline", StringComparison.OrdinalIgnoreCase));
        if (offline is not null)
        {
            return (null, "平板处于 offline 状态,请重新插拔数据线,或执行 adb kill-server 后重试。");
        }

        var ready = lines.FirstOrDefault((l) => l.Contains("device", StringComparison.Ordinal));
        if (ready is null)
        {
            return (null,
                "没有检测到通过 ADB 连接的平板。请确认:\n" +
                "  1. 数据线已连接(充电线可能没有数据线芯)\n" +
                "  2. 平板已打开「开发者选项 → USB 调试」\n" +
                "  3. 平板上已允许本机的调试授权");
        }

        return (ready.Split('\t', ' ')[0], "已连接");
    }

    /// <summary>建立端口反向隧道:平板上的 127.0.0.1:port 会转发到 PC 的 127.0.0.1:port</summary>
    public static bool Reverse(string adb, int port)
    {
        var output = Run(adb, ["reverse", $"tcp:{port}", $"tcp:{port}"]);
        return output is not null && output.IndexOf("error", StringComparison.OrdinalIgnoreCase) < 0;
    }

    /// <summary>安装(或覆盖安装)APK</summary>
    public static bool Install(string adb, string apkPath)
    {
        Log.Info("安装 APK:" + apkPath);
        var output = Run(adb, ["install", "-r", "-g", apkPath], timeoutMs: 120_000);
        if (output is null) return false;
        // adb install 成功时输出 Success
        return output.Contains("Success", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>包是否已安装</summary>
    public static bool IsPackageInstalled(string adb)
    {
        var output = Run(adb, ["shell", "pm", "list", "packages", PackageName]);
        return output is not null && output.Contains($"package:{PackageName}", StringComparison.Ordinal);
    }

    /// <summary>
    /// 读取平板 App 当前安装的 versionCode,读不到返回 null。
    /// </summary>
    public static int? GetInstalledVersionCode(string adb)
    {
        var output = Run(adb, ["shell", "dumpsys", "package", PackageName]);
        if (output is null) return null;

        var match = System.Text.RegularExpressions.Regex.Match(output, @"versionCode=(\d+)");
        if (!match.Success) return null;
        return int.TryParse(match.Groups[1].Value, out var code) ? code : null;
    }

    /// <summary>
    /// 只有在平板上的版本落后时才安装。
    ///
    /// 为什么按 versionCode 而不是文件哈希:
    ///   最初用 APK 的 SHA256 判断,结果每改一行平板端代码哈希就变,
    ///   用户每次启动都会重装一次、并在平板上弹确认框 —— 而他明明已经装过。
    ///   改成版本号后,只有功能真的升级(versionCode 增加)才装一次,符合直觉。
    ///
    /// forceReinstall=true 时无条件重装(给"重新安装 App"按钮用)。
    /// </summary>
    public static (bool Ready, bool InstalledNow, string Message) InstallIfNeeded(
        string adb, string apkPath, string markerDir, int desiredVersionCode, bool forceReinstall = false)
    {
        var installed = IsPackageInstalled(adb);

        if (!installed)
        {
            Log.Info("平板上未安装 App,开始安装");
            return DoInstall(adb, apkPath, markerDir, desiredVersionCode);
        }

        if (forceReinstall)
        {
            Log.Info("用户要求重新安装");
            return DoInstall(adb, apkPath, markerDir, desiredVersionCode);
        }

        if (desiredVersionCode <= 0)
        {
            // 没有嵌入版本号(开发构建),无法比较 —— 已装就不再打扰用户
            Log.Warn("没有嵌入 APK 版本号,无法比较;已安装则跳过");
            return (true, false, "已安装(版本未知,跳过)");
        }

        var installedVersion = GetInstalledVersionCode(adb);
        if (installedVersion is not null && installedVersion.Value >= desiredVersionCode)
        {
            Log.Info($"平板 App 已是最新(versionCode {installedVersion} >= {desiredVersionCode}),跳过安装");
            return (true, false, $"已安装 v{installedVersion}(跳过)");
        }

        Log.Info($"平板 App 版本落后(已装 {installedVersion?.ToString() ?? "?"},需要 {desiredVersionCode}),重新安装");
        return DoInstall(adb, apkPath, markerDir, desiredVersionCode);
    }

    private static (bool Ready, bool InstalledNow, string Message) DoInstall(
        string adb, string apkPath, string markerDir, int versionCode)
    {
        if (!Install(adb, apkPath))
        {
            return (false, false,
                "安装失败。若提示 INSTALL_FAILED_UPDATE_INCOMPATIBLE,请先在平板上卸载旧的「VirtualDesk」;\n" +
                "若平板一直弹「是否安装」,请在开发者选项里打开「USB 安装」");
        }

        // 记录装过的版本,便于排查(不作为判断依据)
        try
        {
            Directory.CreateDirectory(markerDir);
            File.WriteAllText(Path.Combine(markerDir, ".apk-installed-version"), versionCode.ToString());
        }
        catch (Exception ex)
        {
            Log.Warn("写入安装记录失败:" + ex.Message);
        }

        return (true, true, $"安装成功(v{versionCode})");
    }

    private static string Sha256Of(string path)
    {
        using var stream = File.OpenRead(path);
        using var sha = System.Security.Cryptography.SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(stream));
    }

    /// <summary>
    /// 读取 exe 内嵌的 APK versionCode(由 tools/build-apk.mjs 生成、pack 时嵌入)。
    /// 读不到返回 0 —— 调用方据此退化为"已装就不动"。
    /// </summary>
    public static int ReadEmbeddedApkVersion()
    {
        try
        {
            using var stream = typeof(Adb).Assembly.GetManifestResourceStream("VirtualDesk.Viewer.version");
            if (stream is null) return 0;
            using var reader = new StreamReader(stream);
            var text = reader.ReadToEnd().Trim();
            return int.TryParse(text, out var version) ? version : 0;
        }
        catch (Exception ex)
        {
            Log.Warn("读取内嵌 APK 版本失败:" + ex.Message);
            return 0;
        }
    }

    /// <summary>停止 App(用于"停止副屏")</summary>
    public static void ForceStop(string adb) =>
        Run(adb, ["shell", "am", "force-stop", PackageName]);

    /// <summary>
    /// 启动 App,并把端口与显示模式作为启动参数传进去。
    ///
    /// fill = true  等比铺满屏幕,溢出部分裁掉(默认)
    /// fill = false 等比缩放到完整可见,留黑边
    /// </summary>
    public static bool StartApp(string adb, int port, bool fill = true, int fps = 60)
    {
        var output = Run(adb, [
            "shell", "am", "start", "-n", $"{PackageName}/{ActivityName}",
            "--ei", "port", port.ToString(),
            "--ez", "fill", fill ? "true" : "false",
            "--ei", "fps", fps.ToString(),
        ]);
        return output is not null && !output.Contains("Error", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>插着线时保持屏幕常亮(副屏不该自己熄掉)</summary>
    public static void StayAwake(string adb) =>
        Run(adb, ["shell", "svc", "power", "stayon", "true"]);

    /// <summary>让平板按视频分辨率调整显示(可选,失败不影响主流程)</summary>
    public static void TryMatchResolution(string adb, int width, int height)
    {
        var output = Run(adb, ["shell", "wm", "size", $"{width}x{height}"]);
        if (output is not null && output.Contains("Error", StringComparison.OrdinalIgnoreCase))
        {
            Log.Warn("设置平板分辨率失败(不影响使用):" + output);
        }
    }
}
