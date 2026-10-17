using System.Diagnostics;

namespace VirtualDesk.App;

/// <summary>
/// 运行资源与数据目录定位。
///
/// 资源:前端静态文件嵌在程序集里,不需要外部文件;
/// 数据:SQLite 数据库与日志必须放在真正可写的位置 ——
/// 受控环境里 %LOCALAPPDATA% 可能连目录都建不出来,所以逐个试写。
/// </summary>
internal static class AppPaths
{
    public static string ExePath => Environment.ProcessPath ?? Application.ExecutablePath;

    public static string ExeDir => Path.GetDirectoryName(ExePath)!;

    /// <summary>数据目录候选:第一个真正可写的胜出</summary>
    public static IEnumerable<(string Dir, string Label)> DataDirCandidates()
    {
        var overrideDir = Environment.GetEnvironmentVariable("VD_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(overrideDir)) yield return (overrideDir, "环境变量 VD_DATA_DIR");

        yield return (Path.Combine(ExeDir, "第二块屏-数据"), "exe 同级的「第二块屏-数据」目录");
        yield return (Path.Combine(ExeDir, "VirtualDesk-data"), "exe 同级目录");

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (!string.IsNullOrWhiteSpace(localAppData))
        {
            yield return (Path.Combine(localAppData, "VirtualDesk"), "用户目录 %LOCALAPPDATA%");
        }
    }

    /// <summary>试写文件确认目录可写(只看路径存在是不够的)</summary>
    public static bool IsWritable(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            var probe = Path.Combine(dir, ".write-probe-" + Guid.NewGuid().ToString("N"));
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static string ResolveDataDir()
    {
        var failures = new List<string>();
        foreach (var (dir, label) in DataDirCandidates())
        {
            if (IsWritable(dir))
            {
                if (failures.Count > 0)
                {
                    Log.Warn("以下位置不可写,已跳过: " + string.Join(" / ", failures));
                }
                Log.Info($"数据目录:{dir}({label})");
                return dir;
            }
            failures.Add($"{dir}({label})");
        }

        throw new InvalidOperationException(
            "找不到可写的数据目录,以下位置都写不进去:\n  " + string.Join("\n  ", failures) +
            "\n\n建议把程序放到你有写权限的位置(例如桌面或 D 盘)再运行。");
    }

    /// <summary>
    /// 判断一个网卡是不是虚拟网卡(VMware / VirtualBox / Hyper-V / VPN 等)。
    ///
    /// 为什么要区分:这台机器上同时存在 VMware 的 192.168.150.1 和真实 Wi-Fi 的
    /// 192.168.1.7。两者都是合法私有地址,但平板只能访问真实网卡那一个。
    /// 早期版本按字符串排序挑地址,结果选中了 VMware 虚拟网卡,平板永远连不上。
    /// </summary>
    private static bool IsVirtualAdapter(System.Net.NetworkInformation.NetworkInterface ni)
    {
        var text = (ni.Name + " " + ni.Description).ToLowerInvariant();

        string[] virtualKeywords =
        [
            "vmware", "virtualbox", "vbox", "hyper-v", "vethernet", "virtual",
            "tap-", "tap adapter", "openvpn", "wireguard", "vpn", "zerotier",
            "tailscale", "docker", "wsl", "npcap", "loopback", "bluetooth",
            "wan miniport", "hamachi", "radmin", "vpn client", "teredo",
        ];

        foreach (var keyword in virtualKeywords)
        {
            if (text.Contains(keyword, StringComparison.Ordinal)) return true;
        }

        // 明确是物理网卡类型的,不算虚拟
        return ni.NetworkInterfaceType
            is not (System.Net.NetworkInformation.NetworkInterfaceType.Wireless80211
                or System.Net.NetworkInformation.NetworkInterfaceType.Ethernet
                or System.Net.NetworkInformation.NetworkInterfaceType.GigabitEthernet
                or System.Net.NetworkInformation.NetworkInterfaceType.FastEthernetT
                or System.Net.NetworkInformation.NetworkInterfaceType.FastEthernetFx
                or System.Net.NetworkInformation.NetworkInterfaceType.Ethernet3Megabit);
    }

    /// <summary>
    /// 本机局域网 IPv4 地址,最可能被平板访问到的排在前面。
    ///
    /// 评分规则:
    ///   +100 物理无线网卡(WLAN)—— 平板通常连的就是同一个 Wi-Fi
    ///   +90  物理有线网卡
    ///   -100 虚拟网卡(VMware / Hyper-V / VPN 等)—— 平板基本不可能访问到
    ///   + 私有地址段加分(192.168 > 10 > 172.16-31)
    /// 这样真实 Wi-Fi 会稳定排在 VMware 虚拟网卡之前,不再依赖名字的字母序。
    /// </summary>
    public static List<(string Address, string Label)> LanAddresses()
    {
        var candidates = new List<(string Address, string Label, int Score)>();

        foreach (var ni in ActiveInterfaces())
        {
            var isVirtual = IsVirtualAdapter(ni);
            var isWireless = ni.NetworkInterfaceType ==
                             System.Net.NetworkInformation.NetworkInterfaceType.Wireless80211;

            foreach (var info in ni.GetIPProperties().UnicastAddresses)
            {
                if (System.Net.IPAddress.IsLoopback(info.Address)) continue;
                if (info.Address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) continue;

                var parts = info.Address.ToString().Split('.');
                if (parts.Length != 4) continue;
                if (!int.TryParse(parts[0], out var a) || !int.TryParse(parts[1], out var b)) continue;

                var rangeScore = 0;
                if (a == 192 && b == 168) rangeScore = 100;
                else if (a == 10) rangeScore = 90;
                else if (a == 172 && b >= 16 && b <= 31) rangeScore = 80;
                if (rangeScore == 0) continue;

                var typeBonus = isVirtual ? -200 : isWireless ? 100 : 90;

                candidates.Add((info.Address.ToString(), ni.Name, rangeScore + typeBonus));
            }
        }

        return candidates
            .OrderByDescending((c) => c.Score)
            .ThenBy((c) => c.Label, StringComparer.Ordinal)
            .Select((c) => (c.Address, c.Label))
            .ToList();
    }

    /// <summary>最推荐给平板的地址;没有局域网地址时返回 null</summary>
    public static string? PreferredLanAddress() =>
        LanAddresses().Select((c) => c.Address).FirstOrDefault();

    private static IEnumerable<System.Net.NetworkInformation.NetworkInterface> ActiveInterfaces()
    {
        foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
            yield return ni;
        }
    }

    /// <summary>
    /// 确保临时目录可写。
    ///
    /// .NET 与 WinForms 会在 %TEMP% 里建文件(例如 Application.EnableVisualStyles
    /// 要写一个 manifest),%TEMP% 不可写时程序会在启动最初期抛 UnauthorizedAccessException,
    /// 表现就是"双击没反应 / 一句报错都看不到"。
    ///
    /// 启动器已经会把 TEMP/TMP 指向可写位置,这里是第二道防线:
    /// 直接运行内部程序、或从别的入口启动时也能兜住。
    /// </summary>
    public static void EnsureWritableTemp()
    {
        var current = Path.GetTempPath();
        if (IsWritable(current)) return;

        Log.Warn("系统临时目录不可写:" + current);

        foreach (var candidate in new[]
                 {
                     Path.Combine(ExeDir, "第二块屏-数据", "temp"),
                     Path.Combine(ExeDir, "VirtualDesk-data", "temp"),
                 })
        {
            if (!IsWritable(candidate)) continue;

            Environment.SetEnvironmentVariable("TEMP", candidate);
            Environment.SetEnvironmentVariable("TMP", candidate);
            Log.Info("临时目录已切换到:" + candidate);
            return;
        }

        Log.Error("找不到可写临时目录,继续启动可能会失败");
    }

    /// <summary>
    /// 当前进程是否以管理员权限运行。
    ///
    /// 这件事很关键:如果本程序以管理员启动,它拉起的浏览器也会继承管理员令牌。
    /// 而用户平时开着的浏览器是普通权限,Windows 不允许同一浏览器混用两种权限,
    /// 于是弹出「现有实例正在以提升的权限运行,是否用普通权限重启」这类询问框,
    /// 用户点"否"就打不开共享页。程序本身不需要管理员权限,所以这里要能识别并提醒。
    /// </summary>
    public static bool IsElevated
    {
        get
        {
            try
            {
                using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
                var principal = new System.Security.Principal.WindowsPrincipal(identity);
                return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch
            {
                return false;
            }
        }
    }

    /// <summary>
    /// 用系统默认浏览器打开地址。
    ///
    /// 这里刻意准备了多条路径。关键在于主进程若以管理员运行,直接 CreateProcess 会让
    /// 浏览器也变成管理员,和用户已有的普通权限实例冲突(Windows 会弹
    /// 「现有实例正在以提升的权限运行,是否用普通权限重启」)。explorer.exe 由资源管理器
    /// 代劳时会落到用户会话,能作为兜底,所以提权时优先走它。
    /// </summary>
    public static bool OpenInBrowser(string url)
    {
        Log.Info("用系统浏览器打开:" + url);

        if (IsElevated)
        {
            Log.Warn("当前以管理员权限运行,浏览器可能出现权限冲突提示");
            // 提权时先交给资源管理器:它代开的程序是普通权限,不会和已有实例冲突
            if (TryStart("explorer.exe", false, url))
            {
                Log.Info("已通过资源管理器打开(普通权限)");
                return true;
            }
        }

        // 常规路径:走 shell 关联(等价于双击链接)
        if (TryStart(url, true)) return true;

        // 兜底 1:资源管理器代开
        if (TryStart("explorer.exe", false, url)) return true;

        // 兜底 2:直接调注册表里的默认浏览器程序
        var browser = DefaultBrowserExecutable();
        if (browser is not null && TryStart(browser, false, url)) return true;

        Log.Error("三种方式都无法打开浏览器:" + url);
        return false;
    }

    private static bool TryStart(string fileName, bool useShellExecute, string? argument = null)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = fileName,
                UseShellExecute = useShellExecute,
            };
            if (argument is not null) startInfo.ArgumentList.Add(argument);
            using var process = Process.Start(startInfo);
            Log.Info($"已启动 {fileName}" + (argument is null ? "" : " " + argument));
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"启动 {fileName} 失败:{ex.Message}");
            return false;
        }
    }

    /// <summary>从注册表读默认浏览器的可执行文件路径,读不到返回 null</summary>
    private static string? DefaultBrowserExecutable()
    {
        try
        {
            using var userChoice = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice");
            var progId = userChoice?.GetValue("ProgId") as string;
            if (string.IsNullOrEmpty(progId)) return null;

            using var command = Microsoft.Win32.Registry.ClassesRoot.OpenSubKey(
                $@"{progId}\shell\open\command");
            var raw = command?.GetValue(null) as string;
            if (string.IsNullOrEmpty(raw)) return null;

            // 形如 "C:\...\msedge.exe" --single-argument %1,取出引号内的路径
            var trimmed = raw.Trim();
            if (trimmed.StartsWith('"'))
            {
                var end = trimmed.IndexOf('"', 1);
                return end > 1 ? trimmed[1..end] : null;
            }
            var space = trimmed.IndexOf(' ');
            return space > 0 ? trimmed[..space] : trimmed;
        }
        catch (Exception ex)
        {
            Log.Warn("读取默认浏览器失败:" + ex.Message);
            return null;
        }
    }
}
