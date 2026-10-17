using System.Runtime.InteropServices;

namespace VirtualDesk.App;

/// <summary>
/// 枚举系统中的显示器。
///
/// 为什么需要:副屏场景要求系统里存在**至少两块**显示器 —— 一块是笔记本自身的屏,
/// 另一块是虚拟显示驱动创建的屏。用户点「开始共享」时,浏览器会弹出选择器,
/// 让他挑一块共享。如果挑错了(选了主屏),平板看到的就是镜像而不是扩展屏,
/// 而画面上一切正常,用户很难意识到自己选错了。
///
/// 所以这里把真实的显示器列表报给控制面板与前端,让"该选哪一块"这件事有据可依,
/// 并在采集后做一次比对。
/// </summary>
internal static class DisplayInfo
{
    /// <summary>一块显示器的快照</summary>
    public sealed record Display(
        int Index,
        string DeviceName,
        string Description,
        int X,
        int Y,
        int Width,
        int Height,
        bool IsPrimary,
        bool IsLikelyVirtual);

    private const int MonitorInfoFlagPrimary = 0x00000001;
    private const int CchDeviceName = 32;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfoEx
    {
        public int cbSize;
        public NativeRect rcMonitor;
        public NativeRect rcWork;
        public int dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CchDeviceName)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public int cb;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CchDeviceName)]
        public string DeviceName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceString;

        public int StateFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceID;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceKey;
    }

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr rect, MonitorEnumProc proc, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfoEx info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayDevices(string? device, uint devNum, ref DisplayDevice data, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    /// <summary>DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 的值是 -4</summary>
    private static readonly IntPtr PerMonitorAwareV2 = new(-4);

    /// <summary>
    /// 声明进程为 Per-Monitor-V2 DPI 感知。
    ///
    /// 为什么必须做:进程若"DPI 不感知",Windows 会把 GetMonitorInfo 的坐标按缩放比
    /// 虚拟化返回 —— 1920×1080 的屏在 125% 缩放下会被读成 1536×864。
    /// 而浏览器报告的是物理像素,两者一比就对不上,前端会误报"你共享错了屏"。
    ///
    /// GUI 路径下 ApplicationConfiguration.Initialize() 已经设过,这里再设一次返回 false,
    /// 无害;但 --serve / --diagnose 路径不走 WinForms 初始化,必须靠这一句兜住。
    /// </summary>
    public static void EnsureDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(PerMonitorAwareV2)) return;
            // 已经设置过(值相同)或系统不支持 V2,都不影响后续枚举,静默忽略
        }
        catch
        {
            // 老系统没有这个 API,忽略
        }
    }

    /// <summary>
    /// 列出所有显示器,主屏排最前面。
    /// 枚举失败时返回空列表(不抛异常,免得因为显示配置异常把整个程序拖挂)。
    /// </summary>
    public static List<Display> Enumerate()
    {
        var found = new List<(int X, int Y, int Width, int Height, bool Primary, string DeviceName)>();

        try
        {
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr monitor, IntPtr _, IntPtr __, IntPtr ___) =>
            {
                var info = new MonitorInfoEx { cbSize = Marshal.SizeOf<MonitorInfoEx>() };
                if (GetMonitorInfo(monitor, ref info))
                {
                    found.Add((
                        info.rcMonitor.Left,
                        info.rcMonitor.Top,
                        info.rcMonitor.Right - info.rcMonitor.Left,
                        info.rcMonitor.Bottom - info.rcMonitor.Top,
                        (info.dwFlags & MonitorInfoFlagPrimary) != 0,
                        info.szDevice ?? string.Empty));
                }
                return true;
            }, IntPtr.Zero);
        }
        catch (Exception ex)
        {
            Log.Warn("枚举显示器失败:" + ex.Message);
            return [];
        }

        var displays = new List<Display>();
        var index = 0;
        foreach (var item in found.OrderByDescending((m) => m.Primary).ThenBy((m) => m.X))
        {
            var description = DescribeDevice(item.DeviceName);
            displays.Add(new Display(
                index,
                item.DeviceName,
                description,
                item.X,
                item.Y,
                item.Width,
                item.Height,
                item.Primary,
                LooksVirtual(description)));
            index += 1;
        }

        return displays;
    }

    /// <summary>取显示器的友好描述(驱动名),失败时返回设备名</summary>
    private static string DescribeDevice(string deviceName)
    {
        try
        {
            var data = new DisplayDevice { cb = Marshal.SizeOf<DisplayDevice>() };
            if (EnumDisplayDevices(deviceName, 0, ref data, 0) && !string.IsNullOrWhiteSpace(data.DeviceString))
            {
                return data.DeviceString;
            }
        }
        catch
        {
            // 忽略
        }
        return deviceName;
    }

    /// <summary>
    /// 根据描述猜这块屏是不是虚拟显示器。
    ///
    /// 只是启发式 —— 用于界面提示"这块可能是你的虚拟副屏",不参与任何判断逻辑,
    /// 猜错也不影响功能。
    /// </summary>
    private static bool LooksVirtual(string description)
    {
        string[] keywords =
        [
            "virtual", "idd", "indirect", "vdd", "parsec", "spacedesk",
            "duet", "usbmmidd", "mtt", "displaylink", "虚拟",
        ];

        var text = description.ToLowerInvariant();
        return keywords.Any((k) => text.Contains(k, StringComparison.Ordinal));
    }

    /// <summary>给日志/报告用的一行摘要</summary>
    public static string Summary()
    {
        var displays = Enumerate();
        if (displays.Count == 0) return "未检测到显示器";
        return string.Join("; ", displays.Select((d) =>
            $"{d.DeviceName} {d.Width}x{d.Height}{(d.IsPrimary ? " 主屏" : "")}{(d.IsLikelyVirtual ? " 虚拟" : "")}"));
    }
}
