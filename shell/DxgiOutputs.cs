using Vortice.DXGI;

namespace VirtualDesk.App;

/// <summary>
/// 把 Windows 显示器映射到 DXGI 输出序号。
///
/// 为什么需要它:ffmpeg 的 ddagrab 只能按 **DXGI 输出序号** 选屏
/// (ddagrab=output_idx=N),而我们的显示器信息来自 Win32 的 EnumDisplayMonitors
/// (设备名形如 \\.\DISPLAY7)。两者顺序不一定一致,必须按设备名精确匹配,
/// 否则会抓错屏 —— 表现就是平板显示的是主屏画面。
///
/// 另外:早期版本用 gdigrab 按坐标截取,而 ddagrab 走的是 DXGI 桌面复制,
/// 只能在"已连接到桌面"的输出上使用;虚拟显示器必须先被扩展出来(见 README)。
/// </summary>
internal static class DxgiOutputs
{
    internal sealed record Output(int Index, string DeviceName, int Width, int Height, bool Attached);

    /// <summary>枚举所有适配器上的所有输出</summary>
    public static List<Output> Enumerate()
    {
        var results = new List<Output>();
        try
        {
            using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
            var globalIndex = 0;

            for (uint a = 0; ; a += 1)
            {
                IDXGIAdapter1 adapter;
                try
                {
                    var hr = factory.EnumAdapters1(a, out adapter);
                    if (hr.Failure) break;
                }
                catch
                {
                    break;
                }

                using (adapter)
                {
                    for (uint o = 0; ; o += 1)
                    {
                        IDXGIOutput output;
                        try
                        {
                            var hr = adapter.EnumOutputs(o, out output);
                            if (hr.Failure) break;
                        }
                        catch
                        {
                            break;
                        }

                        using (output)
                        {
                            var desc = output.Description;
                            var w = desc.DesktopCoordinates.Right - desc.DesktopCoordinates.Left;
                            var h = desc.DesktopCoordinates.Bottom - desc.DesktopCoordinates.Top;
                            results.Add(new Output(globalIndex, desc.DeviceName, w, h, desc.AttachedToDesktop));
                            Log.Info($"DXGI 输出 {globalIndex}: {desc.DeviceName} {w}×{h} " +
                                     $"附加到桌面={desc.AttachedToDesktop}");
                            globalIndex += 1;
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn("枚举 DXGI 输出失败:" + ex.Message);
        }

        return results;
    }

    /// <summary>
    /// 找到指定显示器对应的 DXGI 输出序号;找不到返回 null(调用方回退到 gdigrab)。
    /// </summary>
    public static int? FindIndex(string deviceName)
    {
        var outputs = Enumerate();
        if (outputs.Count == 0) return null;

        var match = outputs.FirstOrDefault(
            o => string.Equals(o.DeviceName, deviceName, StringComparison.OrdinalIgnoreCase));
        if (match is null)
        {
            Log.Warn($"没有找到与 {deviceName} 匹配的 DXGI 输出,将回退到 gdigrab");
            return null;
        }

        if (!match.Attached)
        {
            // 未附加到桌面的输出无法做桌面复制 —— 这通常意味着虚拟屏没被"扩展"出来
            Log.Warn($"DXGI 输出 {match.Index}({deviceName})未附加到桌面,将回退到 gdigrab");
            return null;
        }

        Log.Info($"采集源:dxgi 输出 {match.Index}({deviceName} {match.Width}×{match.Height})");
        return match.Index;
    }
}
