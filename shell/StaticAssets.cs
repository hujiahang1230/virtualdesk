using System.IO.Compression;
using System.Reflection;

namespace VirtualDesk.App;

/// <summary>
/// 前端静态资源。
///
/// 打包时 next export 的产物被压成一个 zip,作为嵌入资源编进程序集,
/// 运行时直接对 zip 建索引 —— 不往磁盘解压,不产生临时文件,
/// 数据处理策略要求里"免安装"这一条就是这么满足的。
///
/// 开发时允许用 VD_WEB_DIR 指向 out/ 目录,省去每次重新打包。
/// </summary>
internal sealed class StaticAssets : IDisposable
{
    private const string ResourceName = "VirtualDesk.Web.zip";

    private readonly ZipArchive? _archive;
    private readonly string? _directory;
    private readonly Dictionary<string, ZipArchiveEntry> _entries = new(StringComparer.OrdinalIgnoreCase);

    public int FileCount => _directory is not null
        ? Directory.GetFiles(_directory, "*", SearchOption.AllDirectories).Length
        : _entries.Count;

    private StaticAssets(ZipArchive? archive, string? directory)
    {
        _archive = archive;
        _directory = directory;

        if (archive is null) return;
        foreach (var entry in archive.Entries)
        {
            if (entry.Name.Length == 0) continue; // 目录项
            _entries[Normalize(entry.FullName)] = entry;
        }
    }

    public static StaticAssets Load()
    {
        // 开发用:直接从目录读,方便改前端
        var dir = Environment.GetEnvironmentVariable("VD_WEB_DIR");
        if (!string.IsNullOrWhiteSpace(dir) && Directory.Exists(dir))
        {
            Log.Info("静态资源来自目录(开发模式):" + dir);
            return new StaticAssets(null, dir);
        }

        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName);
        if (stream is null)
        {
            throw new InvalidOperationException(
                "程序里没有嵌入前端资源。请先运行打包脚本生成 web.zip(node app/scripts/build-web.mjs)。");
        }

        var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        var assets = new StaticAssets(archive, null);
        Log.Info($"静态资源已从嵌入包加载,共 {assets.FileCount} 个文件");
        return assets;
    }

    private static string Normalize(string path) => path.Replace('\\', '/').TrimStart('/');

    public bool Contains(string path)
    {
        var key = Normalize(path);
        if (_directory is not null)
        {
            return File.Exists(Path.Combine(_directory, key.Replace('/', Path.DirectorySeparatorChar)));
        }
        return _entries.ContainsKey(key);
    }

    public byte[] Read(string path)
    {
        var key = Normalize(path);

        if (_directory is not null)
        {
            return File.ReadAllBytes(Path.Combine(_directory, key.Replace('/', Path.DirectorySeparatorChar)));
        }

        if (!_entries.TryGetValue(key, out var entry))
        {
            throw new FileNotFoundException("静态资源不存在:" + key);
        }

        using var stream = entry.Open();
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    public void Dispose() => _archive?.Dispose();
}
