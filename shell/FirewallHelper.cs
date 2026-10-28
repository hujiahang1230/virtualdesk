using System.Diagnostics;

namespace VirtualDesk.App;

/// <summary>
/// Windows 防火墙相关操作。
///
/// 为什么需要它:程序监听局域网端口时,Windows 会弹一次「允许应用通过防火墙」。
/// 如果当时点了取消,或系统策略直接阻止,平板就完全连不上 —— 而程序自身
/// 看起来一切正常,极难自查。这里提供检测与一键放行。
///
/// 放行需要管理员权限,所以走 UAC 提权(runas 方式让 Windows 弹确认框)。
/// </summary>
internal static class FirewallHelper
{
    /// <summary>规则名:既用于创建,也用于检测是否已存在</summary>
    private const string RuleName = "VirtualDesk (VirtualDesk)";

    /// <summary>
    /// 检测防火墙规则是否已存在。
    /// 用 netsh 查询,不需要管理员权限。
    /// </summary>
    public static bool HasRule()
    {
        try
        {
            var output = RunNetsh(["advfirewall", "firewall", "show", "rule", $"name={RuleName}"], elevated: false);
            return output.Contains(RuleName, StringComparison.Ordinal);
        }
        catch (Exception ex)
        {
            Log.Warn("查询防火墙规则失败:" + ex.Message);
            return false;
        }
    }

    /// <summary>
    /// 为指定程序添加放行规则(TCP 入站,专用+公用网络)。
    /// 会触发 UAC 提权确认。
    /// </summary>
    public static bool Allow(string exePath)
    {
        Log.Info("请求放行防火墙:" + exePath);
        try
        {
            var output = RunNetsh(
            [
                "advfirewall", "firewall", "add", "rule",
                $"name={RuleName}",
                "dir=in",
                "action=allow",
                $"program={exePath}",
                "enable=yes",
                "profile=private,public",
            ], elevated: true);

            var ok = output.Contains("Ok", StringComparison.OrdinalIgnoreCase) ||
                     output.Contains("确定", StringComparison.Ordinal) ||
                     output.Contains("正确", StringComparison.Ordinal);

            Log.Info(ok ? "防火墙放行成功" : "防火墙放行结果:" + output.Trim());
            return ok;
        }
        catch (Exception ex)
        {
            Log.Error("防火墙放行失败:" + ex.Message);
            return false;
        }
    }

    /// <summary>没有管理员权限时,给用户一条可自己执行的命令</summary>
    public static string ManualCommand(string exePath) =>
        $"netsh advfirewall firewall add rule name=\"{RuleName}\" dir=in action=allow " +
        $"program=\"{exePath}\" enable=yes profile=private,public";

    /// <summary>
    /// 当前活动的网络专用类型是否为「公用网络」。
    ///
    /// 为什么关心:放行规则是 profile=private,public —— 家用路由器一般是专用网络,
    /// 没问题;但在咖啡馆 / 机场这类公用网络下,这条规则意味着同网段的任何人都能
    /// 连到本程序。这里不做检测就默默生效,等于默认接受了更大的暴露面,
    /// 所以启动时主动查一次并提醒用户。
    /// </summary>
    public static bool IsOnPublicNetwork()
    {
        try
        {
            var output = RunNetsh(["advfirewall", "show", "currentprofile"], elevated: false);
            // 英文 Windows: Public / Private / DomainAuthenticated
            // 中文 Windows: 公用 / 专用 / 域
            return output.Contains("Public", StringComparison.OrdinalIgnoreCase)
                || output.Contains("公用", StringComparison.Ordinal);
        }
        catch (Exception ex)
        {
            // 查不到不是错误,不值得打扰用户
            Log.Warn("查询当前网络配置失败:" + ex.Message);
            return false;
        }
    }

    private static string RunNetsh(string[] arguments, bool elevated)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "netsh.exe",
            UseShellExecute = elevated,
            RedirectStandardOutput = !elevated,
            RedirectStandardError = !elevated,
            CreateNoWindow = !elevated,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);

        if (elevated)
        {
            // UseShellExecute + runas:让 Windows 自己弹 UAC 确认框
            startInfo.Verb = "runas";
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            using var process = Process.Start(startInfo);
            process?.WaitForExit(20_000);
            return string.Empty;
        }

        using var quiet = Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法启动 netsh");
        var output = quiet.StandardOutput.ReadToEnd() + quiet.StandardError.ReadToEnd();
        quiet.WaitForExit(10_000);
        return output;
    }
}
