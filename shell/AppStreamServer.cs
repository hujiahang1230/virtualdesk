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
    private readonly object _gate = new();

    public string CaptureRegion => $"{_display.Width}×{_display.Height} @({_display.X},{_display.Y})";
    public string Encoder => _encoder;
    public int Port => _port;

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
            if (CanEncode(ffmpeg, encoder))
            {
                Log.Info("App 推流编码器:" + encoder);
                return encoder;
            }
        }
        throw new InvalidOperationException("没有可用的 H.264 编码器");
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
            client.ReceiveBufferSize = 512 * 1024;
            client.SendBufferSize = 512 * 1024;
        }
        catch
        {
            // 某些系统不允许调整,忽略
        }

        var remote = client.Client.RemoteEndPoint?.ToString() ?? "(未知)";
        Log.Info("平板已连接:" + remote);

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

        try
        {
            while (!_stopping)
            {
                var read = stdout.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                network.Write(buffer, 0, read);
                totalBytes += read;
            }
        }
        catch (Exception ex)
        {
            Log.Info("写入中断(平板可能已断开):" + ex.Message);
        }
        finally
        {
            Log.Info($"会话结束,共转发 {totalBytes / 1024} KiB");
            StopFfmpeg();
        }
    }

    private static byte[] BuildHeader(int width, int height)
    {
        var header = new byte[12];
        header[0] = (byte)'V';
        header[1] = (byte)'D';
        header[2] = (byte)'S';
        header[3] = (byte)'1';
        BitConverter.GetBytes(width).CopyTo(header, 4);
        BitConverter.GetBytes(height).CopyTo(header, 8);
        return header;
    }

    private Process? StartFfmpeg()
    {
        var arguments = new List<string>
        {
            "-hide_banner", "-loglevel", "warning", "-nostdin",
            "-f", "gdigrab",
            "-framerate", _fps.ToString(),
            "-offset_x", _display.X.ToString(),
            "-offset_y", _display.Y.ToString(),
            "-video_size", $"{_display.Width}x{_display.Height}",
            "-i", "desktop",
            "-c:v", _encoder,
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-bf", "0",
            "-g", (_fps * 2).ToString(),
            "-b:v", _bitrate,
            // 插入访问单元分隔符:App 端据此切分帧,不用自己判断帧边界
            "-bsf:v", "h264_metadata=aud=insert",
            // 裸 H.264 写到 stdout(不落地文件)
            "-f", "h264", "-",
        };

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
