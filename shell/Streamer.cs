using System.Diagnostics;

namespace VirtualDesk.App;

/// <summary>
/// 原生推流:直接把虚拟显示器编码成 H.264,通过 TCP/MPEG-TS 发给平板。
///
/// 为什么需要它:浏览器方案要求用户在浏览器里手动点「共享」、每次在系统弹窗里挑屏,
/// 而且平板那边也要开浏览器。这里改为进程内驱动 ffmpeg 直接抓虚拟屏并推流,
/// 平板用任意支持 MPEG-TS 的播放器(VLC / mpv)就能看,不需要浏览器。
///
/// 关于选型(均为实测结论,详见 README):
///   - 捕获用 gdigrab:DXGI Desktop Duplication 看不到 IddCx 虚拟显示器
///     (它不在同一块适配器上),而 GDI 按桌面区域截图可以拿到真实画面。
///   - 编码优先 h264_nvenc → h264_mf → libx264,逐个探测可用性。
///   - 1080p30 实测 1 个 CPU 核、稳定达标;1080p60 在 GDI 路径上只能到 45fps。
///   - 传输用 TCP 而不是 UDP:USB 直连是点对点可靠链路,TCP 不会丢包导致花屏;
///     实测本机 UDP 收发不通,TCP 一次通过。
/// </summary>
internal sealed class Streamer : IDisposable
{
    private Process? _process;
    private readonly object _gate = new();

    public string Encoder { get; private set; } = "(未选择)";
    public string CaptureRegion { get; private set; } = "(未知)";

    /// <summary>平板端应当连接的地址</summary>
    public string ClientUrl { get; private set; } = "(未知)";

    /// <summary>
    /// 启动推流。监听在本机所有地址上,等待平板连过来。
    /// </summary>
    /// <param name="displayHost">给用户看的本机地址(用于拼 ClientUrl)</param>
    /// <param name="port">TCP 端口</param>
    /// <param name="fps">帧率,默认 30(1080p60 在 GDI 路径上跑不满)</param>
    /// <param name="bitrate">码率,例如 "6M"</param>
    public void Start(string? displayHost, int port, int fps, string bitrate)
    {
        var ffmpeg = ResolveFfmpeg()
            ?? throw new InvalidOperationException(
                "找不到 ffmpeg.exe。请把它放到程序目录,或设置环境变量 VD_FFMPEG 指向它。");

        var display = PickDisplay()
            ?? throw new InvalidOperationException(
                "没有找到可用的虚拟显示器。请先启用虚拟显示驱动(见 README)。");

        CaptureRegion = $"{display.Width}×{display.Height} @({display.X},{display.Y})";
        Encoder = PickEncoder(ffmpeg);
        ClientUrl = $"tcp://{displayHost ?? "127.0.0.1"}:{port}";

        var listen = $"tcp://0.0.0.0:{port}?listen=1";

        var arguments = new List<string>
        {
            "-hide_banner", "-loglevel", "warning", "-nostdin",
            // 捕获:按虚拟屏在虚拟桌面里的偏移与尺寸截取
            "-f", "gdigrab",
            "-framerate", fps.ToString(),
            "-offset_x", display.X.ToString(),
            "-offset_y", display.Y.ToString(),
            "-video_size", $"{display.Width}x{display.Height}",
            "-i", "desktop",
            // 编码
            "-c:v", Encoder,
            "-preset", "ultrafast",        // 只对 libx264 生效,其它编码器会忽略
            "-tune", "zerolatency",        // 同上
            "-bf", "0",                    // 不要 B 帧:副屏要的是低延迟
            "-g", (fps * 2).ToString(),    // 关键帧间隔 2 秒,便于中途接入
            "-b:v", bitrate,
            // 封装与传输:MPEG-TS over TCP,ffmpeg 在这里等待平板接入
            "-f", "mpegts",
            "-muxdelay", "0",
            "-flush_packets", "1",
            listen,
        };

        Log.Info($"启动推流:{ffmpeg}");
        Log.Info("  捕获区域 " + CaptureRegion);
        Log.Info("  编码器   " + Encoder);
        Log.Info($"  监听     {listen}");
        Log.Info($"  平板连   {ClientUrl}  ({fps}fps, {bitrate})");
        Log.Info("  参数     " + string.Join(' ', arguments));

        var startInfo = new ProcessStartInfo
        {
            FileName = ffmpeg,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data)) Log.Warn("[ffmpeg] " + e.Data);
        };
        process.OutputDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data)) Log.Info("[ffmpeg] " + e.Data);
        };

        process.Start();
        process.BeginErrorReadLine();
        process.BeginOutputReadLine();

        lock (_gate) _process = process;
    }

    public bool HasExited
    {
        get
        {
            lock (_gate) return _process is null || _process.HasExited;
        }
    }

    /// <summary>
    /// 选一块用来推流的显示器:优先"非主屏 + 看起来是虚拟屏",否则退而取第一个非主屏。
    /// </summary>
    private static DisplayInfo.Display? PickDisplay()
    {
        var displays = DisplayInfo.Enumerate();
        if (displays.Count == 0) return null;

        return displays.FirstOrDefault((d) => !d.IsPrimary && d.IsLikelyVirtual)
               ?? displays.FirstOrDefault((d) => !d.IsPrimary);
    }

    /// <summary>
    /// 逐个探测编码器是否真的能用。
    ///
    /// 为什么必须探测:'h264_nvenc' 在显卡驱动偏旧时会在启动瞬间报
    /// "Driver does not support the required nvenc API version",但 ffmpeg 把这条
    /// 当作运行时错误 —— 等发现时推流已经失败了。这里先用一帧空画面试一次。
    /// </summary>
    private static string PickEncoder(string ffmpeg)
    {
        string[] candidates = ["h264_nvenc", "h264_mf", "libx264"];

        foreach (var encoder in candidates)
        {
            if (CanEncode(ffmpeg, encoder))
            {
                Log.Info("编码器探测:" + encoder + " 可用");
                return encoder;
            }
            Log.Warn("编码器探测:" + encoder + " 不可用,继续尝试下一个");
        }

        throw new InvalidOperationException(
            "h264_nvenc / h264_mf / libx264 都不可用,无法编码。请检查 ffmpeg 是否完整。");
    }

    private static bool CanEncode(string ffmpeg, string encoder)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = ffmpeg,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
            };
            foreach (var argument in new[]
                     {
                         "-hide_banner", "-loglevel", "error", "-nostdin",
                         "-f", "lavfi", "-i", "nullsrc=size=320x240:rate=1",
                         "-frames:v", "1", "-c:v", encoder, "-f", "null", "-",
                     })
            {
                startInfo.ArgumentList.Add(argument);
            }

            using var probe = Process.Start(startInfo);
            if (probe is null) return false;

            var error = probe.StandardError.ReadToEnd();
            probe.WaitForExit(15_000);

            if (probe.ExitCode == 0) return true;
            Log.Warn($"  {encoder} 探测失败:{error.Trim().Split('\n').FirstOrDefault()}");
            return false;
        }
        catch (Exception ex)
        {
            Log.Warn($"  {encoder} 探测异常:{ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// 定位 ffmpeg:程序目录 → VD_FFMPEG 环境变量 → PATH → 常见安装位置。
    /// </summary>
    public static string? ResolveFfmpeg()
    {
        var local = Path.Combine(AppPaths.ExeDir, "ffmpeg.exe");
        if (File.Exists(local)) return local;

        var configured = Environment.GetEnvironmentVariable("VD_FFMPEG");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;

        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                 .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(directory.Trim(), "ffmpeg.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // PATH 里可能有非法项,忽略
            }
        }

        // 开发机上常见的第三方目录
        string[] known =
        [
            @"E:\Cpp_Libraries\FFmpeg\ffmpeg-7.1.1-full_build-shared\bin\ffmpeg.exe",
            @"C:\ffmpeg\bin\ffmpeg.exe",
        ];
        return known.FirstOrDefault(File.Exists);
    }

    /// <summary>平板在 USB 直连链路里就是网关地址,用它作为默认推流目标</summary>
    public static string? GuessTabletAddress()
    {
        foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;

            var text = (ni.Name + " " + ni.Description).ToLowerInvariant();
            if (!text.Contains("rndis") && !text.Contains("remote ndis")) continue;

            var gateway = ni.GetIPProperties().GatewayAddresses
                .FirstOrDefault((g) => g.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork);
            if (gateway is not null) return gateway.Address.ToString();
        }

        return null;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_process is null) return;

            try
            {
                if (!_process.HasExited)
                {
                    _process.Kill(entireProcessTree: true);
                    _process.WaitForExit(5_000);
                }
            }
            catch (Exception ex)
            {
                Log.Warn("停止推流失败:" + ex.Message);
            }
            finally
            {
                _process.Dispose();
                _process = null;
            }
        }
    }
}
