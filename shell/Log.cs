using System.Text;

namespace VirtualDesk.App;

/// <summary>
/// 日志:写文件 + 输出到控制台。窗口起不来时,日志就是唯一线索。
/// 单文件版没有控制台,所以文件是主要出口。
/// </summary>
internal static class Log
{
    private static readonly Lock Gate = new();
    private static string? _file;

    public static string? File => _file;

    public static void Init(string directory)
    {
        try
        {
            Directory.CreateDirectory(directory);
            _file = Path.Combine(directory, "运行日志.txt");
            Write("===== 启动 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " =====");
        }
        catch
        {
            _file = null;
        }
    }

    public static void Info(string message) => Write("[信息] " + message);

    public static void Warn(string message) => Write("[警告] " + message);

    public static void Error(string message) => Write("[错误] " + message);

    private static void Write(string line)
    {
        var text = DateTime.Now.ToString("HH:mm:ss.fff") + " " + line;
        Console.WriteLine(text);

        if (_file is null) return;
        lock (Gate)
        {
            try
            {
                System.IO.File.AppendAllText(_file, text + Environment.NewLine, new UTF8Encoding(false));
            }
            catch
            {
                // 日志写不进去不能影响主流程
            }
        }
    }
}
