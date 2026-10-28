using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace VirtualDesk.App;

/// <summary>
/// 面向自研 Android App 的推流服务。
///
/// 与 <see cref="Streamer"/> 的区别:
///   - Streamer 输出 MPEG-TS,面向 VLC 等通用播放器(自带解封装与缓冲,延迟高)
///   - 这里输出**裸 H.264**,并在流开头写 12 字节头告诉 App 分辨率,
///     App 端可以直接喂 MediaCodec,不需要解封装,延迟最低
///
/// 协议:
///   "VDS1"(4) + width(int32 LE,4) + height(int32 LE,4) + 连续 Annex-B H.264(AUD 已插入)
///
/// 之所以要自己写头:App 若要走标准路径就得解析 SPS 拿分辨率(需要实现指数哥伦布解码),
/// 而分辨率我们本来就知道 —— 直接用 12 字节头告诉它,App 端代码能少一半。
///
/// 连接模型:本机监听 → 平板经 adb reverse 连 127.0.0.1:port → 每来一个客户端就
/// 起一份 ffmpeg,客户端断开则杀掉并等待下一个(支持反复重连)。
/// </summary>
internal sealed class AppStreamServer : IDisposable
{
    private readonly int _port;
    private readonly int _fps;
    private readonly string _bitrate;
    private readonly string _ffmpeg;
    private readonly string _encoder;
    private readonly DisplayInfo.Display _display;

    private TcpListener? _listener;
    private Thread? _thread;
    private Process? _ffmpegProcess;
    private volatile bool _stopping;
    private volatile bool _clientConnected;
    private readonly object _gate = new();

    public string CaptureRegion => $"{_display.Width}×{_display.Height} @({_display.X},{_display.Y})";
    public string Encoder => _encoder;
    public int Port => _port;

    /// <summary>平板当前是否连着(控制面板用)</summary>
    public bool IsClientConnected => _clientConnected;

    /// <summary>是否已经在监听</summary>
    public bool IsListening { get; private set; }

    public int CaptureWidth => _display.Width;
    public int CaptureHeight => _display.Height;

    public AppStreamServer(int port, int fps, string bitrate)
    {
        _port = port;
        _fps = fps;
        _bitrate = bitrate;

        _ffmpeg = Streamer.ResolveFfmpeg()
            ?? throw new InvalidOperationException(
                "找不到 ffmpeg.exe。请把它放到程序目录,或设置环境变量 VD_FFMPEG 指向它。");

        _display = PickDisplay()
            ?? throw new InvalidOperationException(
                "没有找到可用的虚拟显示器。请先启用虚拟显示驱动(见 README)。");

        _encoder = PickEncoder(_ffmpeg);
    }

    private static DisplayInfo.Display? PickDisplay()
    {
        var displays = DisplayInfo.Enumerate();
        return displays.FirstOrDefault((d) => !d.IsPrimary && d.IsLikelyVirtual)
               ?? displays.FirstOrDefault((d) => !d.IsPrimary);
    }

    private static string PickEncoder(string ffmpeg)
    {
        foreach (var encoder in new[] { "h264_nvenc", "h264_mf", "libx264" })
        {
            if (CanEncode(ffmpeg, encoder, EncoderArgs(encoder, 60)))
            {
                Log.Info("App 推流编码器:" + encoder);
                return encoder;
            }
        }
        throw new InvalidOperationException("没有可用的 H.264 编码器");
    }

    /// <summary>
    /// 编码器专属参数。
    ///
    /// 关键点:必须同时给 `-pix_fmt nv12`。
    /// h264_mf 在强制硬件(`-hw_encoding true`)时只接受 NV12,否则报
    ///   "format negotiation failed (1/0)"
    /// 并且**静默退回软件编码** —— 那会白吃一两个 CPU 核,延迟也更高。
    ///
    /// `-scenario display_remoting` / `-rate_control ld_vbr` 是 Media Foundation
    /// 为屏幕共享准备的低延迟档位;不指定的话它按默认场景(偏画质/吞吐)工作,
    /// 内部会积压若干帧,表现为"帧率够但拖窗口明显滞后"。
    ///
    /// 注意 h264_mf **不接受** -preset/-tune:ffmpeg 只会警告一句
    /// "Codec AVOption preset has not been used",然后忽略。
    /// </summary>
    private static List<string> EncoderArgs(string encoder, int fps)
    {
        if (encoder == "h264_mf")
        {
            return
            [
                "-pix_fmt", "nv12",
                "-hw_encoding", "true",
                "-scenario", "display_remoting",
                "-rate_control", "ld_vbr",
                "-quality", "50",
            ];
        }

        // nvenc / x264 走通用参数
        return
        [
            "-preset", encoder == "h264_nvenc" ? "p1" : "ultrafast",
            "-tune", "zerolatency",
            "-bf", "0",
            "-g", (fps * 2).ToString(),
        ];
    }

    private static bool CanEncode(string ffmpeg, string encoder, List<string> encoderArgs)
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
            var probeArgs = new List<string>
            {
                "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "lavfi", "-i", "nullsrc=size=320x240:rate=1",
                "-frames:v", "1", "-c:v", encoder,
            };
            probeArgs.AddRange(encoderArgs);
            probeArgs.AddRange(["-f", "null", "-"]);
            foreach (var argument in probeArgs) startInfo.ArgumentList.Add(argument);

            using var probe = Process.Start(startInfo);
            if (probe is null) return false;
            var error = probe.StandardError.ReadToEnd();
            probe.WaitForExit(15_000);
            if (probe.ExitCode == 0) return true;
            Log.Warn($"  {encoder} 不可用:{error.Trim().Split('\n').FirstOrDefault()}");
            return false;
        }
        catch
        {
            return false;
        }
    }

    public void Start()
    {
        _listener = new TcpListener(IPAddress.Any, _port);
        _listener.Start();
        IsListening = true;

        _thread = new Thread(AcceptLoop) { IsBackground = true, Name = "vd-app-stream" };
        _thread.Start();

        Log.Info($"App 推流已监听 0.0.0.0:{_port}(捕获 {CaptureRegion},编码 {_encoder})");
    }

    private void AcceptLoop()
    {
        while (!_stopping)
        {
            TcpClient? client = null;
            try
            {
                client = _listener!.AcceptTcpClient();
            }
            catch (Exception ex)
            {
                if (_stopping) return;
                Log.Warn("接受连接失败:" + ex.Message);
                Thread.Sleep(500);
                continue;
            }

            try
            {
                ServeClient(client);
            }
            catch (Exception ex)
            {
                Log.Warn("会话结束:" + ex.Message);
            }
            finally
            {
                try
                {
                    client.Close();
                }
                catch
                {
                    // ignore
                }
            }
        }
    }

    private void ServeClient(TcpClient client)
    {
        client.NoDelay = true;
        try
        {
            // 缓冲区**不能开太大**。
            //
            // 这里原来设成 512 KiB,看起来"多多益善",实际是在给延迟挖坑:
            // 12 Mbps 下 512 KiB 相当于 340 ms 的排队空间 —— 发送端可以远远跑在
            // 平板消费速度前面,数据全堆在缓冲区里。实测积压约 4 帧(~67 ms)。
            // 收到 64 KiB 后,排队上限降到约 40 ms,发送端一快就会被 TCP 压回去,
            // 从而把"链路队列"维持在很浅的水平 —— 这正是低延迟远程桌面要的效果。
            var socketBuffer = 64 * 1024;
            client.ReceiveBufferSize = socketBuffer;
            client.SendBufferSize = socketBuffer;
        }
        catch
        {
            // 某些系统不允许调整,忽略
        }

        var remote = client.Client.RemoteEndPoint?.ToString() ?? "(未知)";
        Log.Info("平板已连接:" + remote);
        _clientConnected = true;

        var network = client.GetStream();

        // 1) 先发 12 字节头,App 据此配置解码器
        var header = BuildHeader(_display.Width, _display.Height);
        network.Write(header, 0, header.Length);
        network.Flush();
        Log.Info($"已发送流头:VDS1 {_display.Width}×{_display.Height}");

        // 2) 起 ffmpeg,把裸 H.264 从 stdout 转发给平板
        using var process = StartFfmpeg();
        if (process is null) return;

        var buffer = new byte[64 * 1024];
        var stdout = process.StandardOutput.BaseStream;
        long totalBytes = 0;

        // 延迟诊断:统计已写出的帧数,并定期连同墙钟一起打日志。
        // 平板端也统计"已渲染帧数 + 墙钟",两边相减就是**积压帧数**,
        // 乘以帧间隔即端到端延迟。这是唯一不依赖外部摄像头/OCR 的能量化延迟的办法。
        long frames = 0;
        long lastReport = Environment.TickCount64;
        long lastFrames = 0;

        // 按访问单元切分,并给每帧加 4 字节长度前缀(协议 VDS2)。
        //
        // 为什么必须这么做:裸 H.264 没有帧长度,App 只能靠"看到下一帧的 AUD"
        // 才知道上一帧结束 —— 等于硬生生多等一整帧(60fps 下 16.7ms)。
        // 实测 App 内部「到达→上屏」约 28ms,其中 16.7ms 就是这个等待。
        // 改成长度前缀后,App 收满 N 字节立刻解码,不需要前瞻。
        var pending = new List<byte>(256 * 1024);

        try
        {
            while (!_stopping)
            {
                var read = stdout.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                totalBytes += read;

                for (var i = 0; i < read; i += 1) pending.Add(buffer[i]);

                // 把 pending 里已经完整的访问单元逐个切出来发走
                while (TryTakeAccessUnit(pending, out var accessUnit))
                {
                    var length = new byte[4];
                    BitConverter.GetBytes(accessUnit.Length).CopyTo(length, 0);
                    network.Write(length, 0, 4);
                    network.Write(accessUnit, 0, accessUnit.Length);
                    frames += 1;
                }

                var now = Environment.TickCount64;
                if (now - lastReport >= 1000)
                {
                    var delta = frames - lastFrames;
                    Log.Info($"[统计] 已发送 {frames} 帧(+{delta}/s) @ {DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}");
                    lastFrames = frames;
                    lastReport = now;
                }
            }
        }
        catch (Exception ex)
        {
            Log.Info("写入中断(平板可能已断开):" + ex.Message);
        }
        finally
        {
            Log.Info($"会话结束,共转发 {totalBytes / 1024} KiB");
            _clientConnected = false;
            StopFfmpeg();
        }
    }

    /// <summary>
    /// 从 pending 里切出一个完整的访问单元(以 AUD 为界)。
    ///
    /// 约定:每个访问单元以 AUD(NAL type 9)开头。找到**下一个** AUD 的起始码时,
    /// 它之前的部分就是一个完整单元。找到就移除并返回 true;否则原样保留。
    ///
    /// 起始码可能是 3 字节(00 00 01)或 4 字节(00 00 00 01),后者要多吃掉一个 0,
    /// 否则切出来的单元会丢掉起始码的第一个字节,App 端解码会失败。
    /// </summary>
    private static bool TryTakeAccessUnit(List<byte> pending, out byte[] accessUnit)
    {
        accessUnit = [];

        // 从 4 开始找:跳过开头那个 AUD 自身的起始码,避免刚放进来的第一帧就被切掉
        for (var i = 4; i + 3 < pending.Count; i += 1)
        {
            if (pending[i] != 0 || pending[i + 1] != 0 || pending[i + 2] != 1) continue;
            if ((pending[i + 3] & 0x1F) != 9) continue;

            // 4 字节起始码:前一个字节也是 0,归入新单元
            var boundary = i;
            if (boundary > 0 && pending[boundary - 1] == 0) boundary -= 1;

            if (boundary < 4) continue; // 太短,继续找

            accessUnit = new byte[boundary];
            pending.CopyTo(0, accessUnit, 0, boundary);
            pending.RemoveRange(0, boundary);
            return true;
        }

        return false;
    }

    private static byte[] BuildHeader(int width, int height)
    {
        var header = new byte[12];
        header[0] = (byte)'V';
        header[1] = (byte)'D';
        header[2] = (byte)'S';
        // VDS2:帧数据改成「4 字节长度 + 访问单元」。
        // VDS1 是裸字节流,App 必须靠下一个 AUD 判断帧边界,白等一帧(16.7ms)。
        header[3] = (byte)'2';
        BitConverter.GetBytes(width).CopyTo(header, 4);
        BitConverter.GetBytes(height).CopyTo(header, 8);
        return header;
    }

    private Process? StartFfmpeg()
    {
        var arguments = new List<string> { "-hide_banner", "-loglevel", "warning", "-nostdin" };

        // VD_TEST_SOURCE=1 时用合成画面代替屏幕采集。
        // 目的:单独测量「编码→传输→解码→显示」这段在高帧率下的能力,
        // 不受 GDI 采集上限(1080p 约 52fps)的干扰。
        var testSource = Environment.GetEnvironmentVariable("VD_TEST_SOURCE") == "1";
        if (testSource)
        {
            Log.Warn($"使用合成测试源(testsrc2 {_display.Width}x{_display.Height}@{_fps}),不采集屏幕");
            arguments.AddRange([
                "-f", "lavfi",
                "-i", $"testsrc2=size={_display.Width}x{_display.Height}:rate={_fps}",
            ]);
        }
        else
        {
            arguments.AddRange([
                "-f", "gdigrab",
                "-framerate", _fps.ToString(),
                "-offset_x", _display.X.ToString(),
                "-offset_y", _display.Y.ToString(),
                "-video_size", $"{_display.Width}x{_display.Height}",
                "-i", "desktop",
            ]);
        }

        arguments.AddRange(["-c:v", _encoder]);

        // 编码器专属参数(与启动探测用的是同一份,避免"探测过但启动失败")
        arguments.AddRange(EncoderArgs(_encoder, _fps));

        // bsf 只给"自己不产生 AUD"的编码器。
        //
        // h264_mf 已经会在每个访问单元前写 AUD(实测 3 秒 60fps = 180 个 AUD,正好一帧一个)。
        // 再挂 h264_metadata=aud=insert 就变成 **每帧两个 AUD** —— 实测 360 个。
        // 后果:App 端按 AUD 切帧会切出一半的空帧,白白多做一轮解析与喂帧。
        if (_encoder != "h264_mf")
        {
            arguments.AddRange(["-bsf:v", "h264_metadata=aud=insert"]);
        }

        arguments.AddRange([
            "-b:v", _bitrate,
            // 裸 H.264 写到 stdout;flush_packets 让每个包立刻写出,不在 muxer 里攒
            "-flush_packets", "1",
            "-f", "h264", "-",
        ]);

        var startInfo = new ProcessStartInfo
        {
            FileName = _ffmpeg,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);

        Log.Info("启动 ffmpeg(裸 H.264 → stdout)");
        var process = new Process { StartInfo = startInfo };
        process.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data)) Log.Warn("[ffmpeg] " + e.Data);
        };

        process.Start();
        process.BeginErrorReadLine();

        lock (_gate) _ffmpegProcess = process;
        return process;
    }

    private void StopFfmpeg()
    {
        lock (_gate)
        {
            var process = _ffmpegProcess;
            _ffmpegProcess = null;
            if (process is null) return;

            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(3_000);
                }
            }
            catch (Exception ex)
            {
                Log.Warn("停止 ffmpeg 失败:" + ex.Message);
            }
            finally
            {
                process.Dispose();
            }
        }
    }

    public void Dispose()
    {
        _stopping = true;
        StopFfmpeg();

        try
        {
            _listener?.Stop();
        }
        catch
        {
            // ignore
        }

        try
        {
            _thread?.Join(1_500);
        }
        catch
        {
            // ignore
        }
    }
}
