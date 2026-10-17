using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace VirtualDesk.App;

/// <summary>一次信令会话</summary>
internal sealed record SignalSession(string Code, string? Offer, string? Answer, DateTimeOffset CreatedAt);

/// <summary>
/// 信令存储。
///
/// 只需要存"配对码 → offer/answer"这种键值数据,单个用户、一条连接、
/// 生命周期最多两小时 —— 用 PostgreSQL 属于杀鸡用牛刀,SQLite 足够且零部署。
/// 数据库文件放在数据目录里,退出时随进程关闭。
/// </summary>
internal sealed class SignalStore : IDisposable
{
    /// <summary>配对码长度,与前端 PAIR_CODE_LENGTH 保持一致</summary>
    public const int PairCodeLength = 6;

    /// <summary>会话有效期:2 小时,与前端 SESSION_TTL_MS 一致</summary>
    public static readonly TimeSpan SessionTtl = TimeSpan.FromHours(2);

    private readonly SqliteConnection _connection;
    private readonly Lock _gate = new();

    public string DatabasePath { get; }

    public SignalStore(string dataDir)
    {
        DatabasePath = Path.Combine(dataDir, "signaling.db");

        _connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
        }.ToString());

        _connection.Open();
        // WAL 让读写不互相阻塞;本机单用户其实用不上,但代价为零
        Execute("PRAGMA journal_mode=WAL;");
        Execute("PRAGMA synchronous=NORMAL;");
        EnsureSchema();

        Log.Info("信令数据库就绪:" + DatabasePath);
    }

    private void Execute(string sql)
    {
        using var command = _connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private void EnsureSchema()
    {
        Execute(
            """
            CREATE TABLE IF NOT EXISTS signal_sessions (
              code       TEXT PRIMARY KEY NOT NULL,
              offer      TEXT,
              answer     TEXT,
              created_at TEXT NOT NULL
            );
            """);
        Execute(
            "CREATE INDEX IF NOT EXISTS signal_sessions_created_at_idx ON signal_sessions (created_at);");

        // 自检:字段数不对说明库文件被别的版本写过
        using var check = _connection.CreateCommand();
        check.CommandText =
            "SELECT COUNT(*) FROM pragma_table_info('signal_sessions');";
        var columns = Convert.ToInt32(check.ExecuteScalar());
        if (columns != 4)
        {
            throw new InvalidOperationException(
                $"信令表结构异常:期望 4 个字段,实际 {columns} 个。可以删除「{DatabasePath}」后重试。");
        }
    }

    /// <summary>清理过期会话,返回删除条数</summary>
    public int CleanupExpired()
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "DELETE FROM signal_sessions WHERE created_at < $cutoff;";
            command.Parameters.AddWithValue("$cutoff", Encode(DateTimeOffset.UtcNow - SessionTtl));
            return command.ExecuteNonQuery();
        }
    }

    /// <summary>生成一个当前库中不存在的配对码</summary>
    public string CreateUniqueCode(int maxAttempts = 16)
    {
        for (var attempt = 0; attempt < maxAttempts; attempt += 1)
        {
            var code = GenerateCode();
            if (Get(code) is null) return code;
        }
        throw new InvalidOperationException("生成配对码失败:短时间内冲突过多,请重试。");
    }

    private static string GenerateCode()
    {
        // 纯数字,避免在平板上输入歧义
        Span<char> buffer = stackalloc char[PairCodeLength];
        for (var i = 0; i < PairCodeLength; i += 1)
        {
            buffer[i] = (char)('0' + RandomNumberGenerator.GetInt32(10));
        }
        return new string(buffer);
    }

    public static bool IsValidPairCode(string? value) =>
        value is { Length: PairCodeLength } && value.All(char.IsAsciiDigit);

    public SignalSession? Get(string code)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                "SELECT code, offer, answer, created_at FROM signal_sessions WHERE code = $code LIMIT 1;";
            command.Parameters.AddWithValue("$code", code);

            using var reader = command.ExecuteReader();
            if (!reader.Read()) return null;

            return new SignalSession(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                Decode(reader.GetString(3)));
        }
    }

    public void Insert(string code, string? offer)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                "INSERT INTO signal_sessions (code, offer, answer, created_at) VALUES ($code, $offer, NULL, $created);";
            command.Parameters.AddWithValue("$code", code);
            command.Parameters.AddWithValue("$offer", (object?)offer ?? DBNull.Value);
            command.Parameters.AddWithValue("$created", Encode(DateTimeOffset.UtcNow));
            command.ExecuteNonQuery();
        }
    }

    /// <summary>
    /// 写入 offer 或 answer。
    /// 写 offer 时清空旧的 answer,避免平板拿到上一轮的过期应答。
    /// </summary>
    public bool UpdateSignal(string code, string type, string sdp)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = type == "offer"
                ? "UPDATE signal_sessions SET offer = $sdp, answer = NULL WHERE code = $code;"
                : "UPDATE signal_sessions SET answer = $sdp WHERE code = $code;";
            command.Parameters.AddWithValue("$sdp", sdp);
            command.Parameters.AddWithValue("$code", code);
            return command.ExecuteNonQuery() > 0;
        }
    }

    // SQLite 没有原生时间类型,统一存 ISO-8601 字符串,排序与比较都正确
    private static string Encode(DateTimeOffset value) =>
        value.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

    private static DateTimeOffset Decode(string value) =>
        DateTimeOffset.TryParse(value, out var parsed) ? parsed : DateTimeOffset.UtcNow;

    /// <summary>当前仍在有效期内的会话数</summary>
    public int CountActive()
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM signal_sessions WHERE created_at >= $cutoff;";
            command.Parameters.AddWithValue("$cutoff", Encode(DateTimeOffset.UtcNow - SessionTtl));
            return Convert.ToInt32(command.ExecuteScalar());
        }
    }

    /// <summary>最近一个仍在有效期内的会话(用于在窗口里显示当前配对码)</summary>
    public SignalSession? LatestActive()
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                SELECT code, offer, answer, created_at FROM signal_sessions
                WHERE created_at >= $cutoff
                ORDER BY created_at DESC LIMIT 1;
                """;
            command.Parameters.AddWithValue("$cutoff", Encode(DateTimeOffset.UtcNow - SessionTtl));

            using var reader = command.ExecuteReader();
            if (!reader.Read()) return null;

            return new SignalSession(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                Decode(reader.GetString(3)));
        }
    }

    public void Dispose()
    {
        try
        {
            _connection.Close();
            _connection.Dispose();
        }
        catch
        {
            // 退出阶段忽略
        }
    }
}
