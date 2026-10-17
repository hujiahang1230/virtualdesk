using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VirtualDesk.App;

/// <summary>
/// 内置 HTTP 服务:提供信令接口 + 托管静态页面。
///
/// 为什么自己实现 HTTP 而不是用 HttpListener:
///   HttpListener 底层是 http.sys,在受控环境里 Start() 会直接抛
///   HttpListenerException「句柄无效」(实测单文件与非单文件都一样)。
///   而 TcpListener 完全可用,所以这里用裸 socket 实现一个够用的 HTTP/1.1 服务端。
///   需求很小:GET/POST/PUT、Content-Length、少量静态文件,不需要分块传输。
///
/// 监听策略:
///   - 127.0.0.1 永远监听:页面就在这里打开
///   - 局域网地址也监听:平板要靠它接入
///   - 绑定具体 IP(而不是通配地址)可以避开多数机器上的端口保留与防火墙规则
/// </summary>
internal sealed class WebHost : IDisposable
{
    private const int SdpMaxLength = 200_000;
    private const int MaxRequestBody = 1024 * 1024; // 1MB,远大于 SDP 上限
    private const string ApiBaseFlag = "__VIRTUALDESK_API_BASE__";
    private const string HostFlag = "__VIRTUALDESK_HOST__";

    private readonly StaticAssets _assets;
    private readonly SignalStore _store;
    private readonly List<TcpListener> _listeners = [];
    private readonly CancellationTokenSource _shutdown = new();

    public int Port { get; private set; }

    /// <summary>本机访问地址</summary>
    public string LocalUrl => $"http://127.0.0.1:{Port}";

    /// <summary>平板可访问的地址(没有局域网地址时为 null)</summary>
    public string? LanUrl { get; private set; }

    public WebHost(StaticAssets assets, SignalStore store)
    {
        _assets = assets;
        _store = store;
    }

    public void Start()
    {
        Port = FindFreePort(38471);

        if (!TryListen(IPAddress.Loopback, "127.0.0.1"))
        {
            throw new InvalidOperationException($"无法在 127.0.0.1:{Port} 上监听,端口可能被占用。");
        }

        // 局域网地址:绑定**全部**候选地址,而不是只绑第一个。
        //
        // 为什么必须全绑:一台机器常有多个私有地址(VMware/VirtualBox 虚拟网卡、
        // 有线 + 无线)。只绑一个的话,万一挑中的是虚拟网卡,平板用真实 Wi-Fi
        // 地址访问就会被直接拒绝连接(out of the box 连不上,且报错信息毫无提示)。
        // 全绑之后无论平板走哪个地址都能连上。
        foreach (var (address, label) in AppPaths.LanAddresses())
        {
            if (!IPAddress.TryParse(address, out var parsed)) continue;

            if (!TryListen(parsed, label))
            {
                Log.Warn($"局域网地址 {address}({label}) 监听失败,跳过");
                continue;
            }

            _lanAddresses.Add((address, label));
            LanUrls.Add($"http://{address}:{Port}");
        }

        // 对外推荐的地址:按评分排序后的第一个,也就是最可能被平板访问到的那个
        LanUrl = LanUrls.Count > 0 ? LanUrls[0] : null;

        if (LanUrl is null)
        {
            Log.Warn("没有可用的局域网地址 —— 平板将无法接入。请检查网络连接或防火墙。");
        }
        else
        {
            Log.Info($"推荐给平板的地址:{LanUrl}");
            if (LanUrls.Count > 1)
            {
                Log.Info("同时监听的其它地址:" + string.Join(" ", LanUrls.Skip(1)));
            }
        }

        Log.Info($"内置服务已就绪:{LocalUrl}");
    }

    /// <summary>所有已监听的局域网地址(第一个是最推荐的)</summary>
    public List<string> LanUrls { get; } = [];

    private readonly List<(string Address, string Label)> _lanAddresses = [];

    private bool TryListen(IPAddress address, string label)
    {
        try
        {
            var listener = new TcpListener(address, Port);
            listener.Start();
            _listeners.Add(listener);
            _ = Task.Run(() => AcceptLoop(listener));
            Log.Info($"监听 {address}:{Port} 成功({label})");
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"监听 {address}:{Port} 失败:{ex.Message}");
            return false;
        }
    }

    private static int FindFreePort(int start)
    {
        for (var port = start; port < start + 40; port += 1)
        {
            try
            {
                using var listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                listener.Stop();
                return port;
            }
            catch
            {
                // 换下一个
            }
        }
        throw new InvalidOperationException($"从 {start} 起连续 40 个端口都被占用。");
    }

    private async Task AcceptLoop(TcpListener listener)
    {
        while (!_shutdown.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(_shutdown.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (SocketException)
            {
                // 单个连接出错不应终止整个循环
                continue;
            }

            _ = Task.Run(() => HandleClient(client));
        }
    }

    // ------------------------------------------------------------ 连接处理

    private void HandleClient(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                using var stream = client.GetStream();

                // 一个连接处理一个请求:前端的 fetch 是短连接
                var request = ReadRequest(stream);
                if (request is null) return;

                var path = request.Path.TrimEnd('/');
                if (path.Length == 0) path = "/";
                Log.Info($"{request.Method} {request.Path}");

                // 路由分流:/api/ 走接口,其余走静态资源
                var response = path.StartsWith("/api/", StringComparison.Ordinal)
                    ? HandleApi(request, path)
                    : HandleStatic(path);

                WriteResponse(stream, response);
            }
            catch (Exception ex)
            {
                Log.Warn($"处理连接出错:{ex.Message}");
            }
        }
    }

    private sealed record HttpRequest(string Method, string Path, string Body);

    private sealed record HttpResponse(int Status, string ContentType, byte[] Body, bool NoCache = false);

    /// <summary>
    /// 读取并解析请求。只实现够用的部分:
    /// 请求行 + 头部 + 按 Content-Length 读取的请求体。
    /// </summary>
    private static HttpRequest? ReadRequest(NetworkStream stream)
    {
        // 头部按字节读到 \r\n\r\n,避免多字节字符被截断
        var headerBytes = new List<byte>(1024);
        var terminator = 0;
        while (terminator < 4)
        {
            var value = stream.ReadByte();
            if (value < 0) return null; // 对端关闭

            headerBytes.Add((byte)value);
            terminator = (terminator, value) switch
            {
                (0, 13) => 1,
                (1, 10) => 2,
                (2, 13) => 3,
                (3, 10) => 4,
                (_, 13) => 1,
                _ => 0,
            };

            if (headerBytes.Count > 64 * 1024) return null; // 头部异常大
        }

        var headerText = Encoding.UTF8.GetString(headerBytes.ToArray());
        var lines = headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0) return null;

        var parts = lines[0].Split(' ');
        if (parts.Length < 2) return null;

        var method = parts[0].ToUpperInvariant();
        var target = parts[1];

        // 去掉查询串并解码
        var queryIndex = target.IndexOf('?');
        if (queryIndex >= 0) target = target[..queryIndex];
        var path = Uri.UnescapeDataString(target);

        var contentLength = 0;
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            var name = line[..colon].Trim();
            if (!name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
            int.TryParse(line[(colon + 1)..].Trim(), out contentLength);
        }

        if (contentLength < 0 || contentLength > MaxRequestBody) return null;

        var body = string.Empty;
        if (contentLength > 0)
        {
            var buffer = new byte[contentLength];
            var read = 0;
            while (read < contentLength)
            {
                var count = stream.Read(buffer, read, contentLength - read);
                if (count <= 0) break;
                read += count;
            }
            body = Encoding.UTF8.GetString(buffer, 0, read);
        }

        return new HttpRequest(method, path, body);
    }

    private static void WriteResponse(NetworkStream stream, HttpResponse response)
    {
        var header = new StringBuilder();
        header.Append("HTTP/1.1 ").Append(response.Status).Append(' ')
            .Append(ReasonPhrase(response.Status)).Append("\r\n");
        header.Append("Content-Type: ").Append(response.ContentType).Append("\r\n");
        header.Append("Content-Length: ").Append(response.Body.Length).Append("\r\n");
        header.Append("Cache-Control: ")
            .Append(response.NoCache ? "no-cache" : "public, max-age=31536000, immutable")
            .Append("\r\n");
        // 允许页面从任意地址访问接口(平板与电脑不同源时也能用)
        header.Append("Access-Control-Allow-Origin: *\r\n");
        header.Append("Connection: close\r\n");
        header.Append("\r\n");

        stream.Write(Encoding.UTF8.GetBytes(header.ToString()));
        stream.Write(response.Body);
        stream.Flush();
    }

    private static string ReasonPhrase(int status) => status switch
    {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    };

    // ---------------------------------------------------------------- 接口

    private HttpResponse HandleApi(HttpRequest request, string path)
    {
        if (path == "/api/health" && request.Method == "GET")
        {
            return Json(200, new JsonObject
            {
                ["status"] = "ok",
                ["storage"] = "sqlite",
                ["database"] = new JsonObject
                {
                    ["reachable"] = true,
                    ["target"] = _store.DatabasePath,
                },
                ["time"] = DateTimeOffset.UtcNow.ToString("o"),
            });
        }

        if (path == "/api/network" && request.Method == "GET")
        {
            // 同时给出"实际已监听"的地址,让页面只推荐真正连得上的那个
            var candidates = new JsonArray();
            foreach (var (address, label) in _lanAddresses)
            {
                candidates.Add(new JsonObject
                {
                    ["address"] = address,
                    ["label"] = label,
                    ["listening"] = true,
                });
            }

            return Json(200, new JsonObject
            {
                ["candidates"] = candidates,
                ["primary"] = LanUrl is null ? null : JsonValue.Create(new Uri(LanUrl).Host),
                ["port"] = Port,
                ["listeningUrls"] = new JsonArray([.. LanUrls.Select((u) => (JsonNode)JsonValue.Create(u)!)]),
            });
        }

        // 控制面板用:汇报当前会话状态,让主窗口不用再开界面就能显示进度
        if (path == "/api/status" && request.Method == "GET")
        {
            var latest = _store.LatestActive();
            var sharing = latest?.Offer is not null;
            var connected = latest?.Answer is not null;

            return Json(200, new JsonObject
            {
                ["activeSessions"] = _store.CountActive(),
                ["code"] = latest?.Code,
                ["sharing"] = sharing,
                ["connected"] = connected,
                ["stage"] = connected ? "connected" : sharing ? "waiting" : latest is null ? "idle" : "ready",
                ["localUrl"] = LocalUrl,
                ["lanUrl"] = LanUrl,
                ["lanUrls"] = new JsonArray([.. LanUrls.Select((u) => (JsonNode)JsonValue.Create(u)!)]),
            });
        }

        if (path == "/api/session" && request.Method == "POST")
        {
            return HandleCreateSession(request);
        }

        if (path.StartsWith("/api/session/", StringComparison.Ordinal))
        {
            var code = path["/api/session/".Length..];

            if (request.Method == "GET") return HandleGetSession(code);
            if (request.Method == "PUT") return HandleUpdateSession(request, code);
        }

        return Json(404, new JsonObject { ["error"] = "接口不存在" });
    }

    private HttpResponse HandleCreateSession(HttpRequest request)
    {
        string? offer = null;

        if (!string.IsNullOrWhiteSpace(request.Body))
        {
            JsonNode? node;
            try
            {
                node = JsonNode.Parse(request.Body);
            }
            catch (JsonException)
            {
                return Json(400, new JsonObject { ["error"] = "请求体不是合法 JSON" });
            }

            if (node is JsonObject obj && obj.TryGetPropertyValue("offer", out var offerNode) &&
                offerNode is not null)
            {
                var raw = offerNode.GetValue<string>();
                if (raw.Length > SdpMaxLength)
                {
                    return Json(413, new JsonObject { ["error"] = "offer 体积超出限制" });
                }
                offer = raw;
            }
        }

        var removed = _store.CleanupExpired();
        var code = _store.CreateUniqueCode();
        _store.Insert(code, offer);

        return Json(201, new JsonObject { ["code"] = code, ["removed"] = removed });
    }

    private HttpResponse HandleGetSession(string code)
    {
        if (!SignalStore.IsValidPairCode(code))
        {
            return Json(400, new JsonObject { ["error"] = "配对码必须是 6 位数字" });
        }

        var session = _store.Get(code);
        if (session is null)
        {
            return Json(404, new JsonObject { ["error"] = "会话不存在或已过期" });
        }

        return Json(200, new JsonObject
        {
            ["code"] = session.Code,
            ["offer"] = session.Offer,
            ["answer"] = session.Answer,
            ["createdAt"] = session.CreatedAt.UtcDateTime.ToString("o"),
        });
    }

    private HttpResponse HandleUpdateSession(HttpRequest request, string code)
    {
        if (!SignalStore.IsValidPairCode(code))
        {
            return Json(400, new JsonObject { ["error"] = "配对码必须是 6 位数字" });
        }

        JsonNode? node;
        try
        {
            node = JsonNode.Parse(request.Body);
        }
        catch
        {
            return Json(400, new JsonObject { ["error"] = "请求体不是合法 JSON" });
        }

        if (node is not JsonObject obj)
        {
            return Json(400, new JsonObject { ["error"] = "请求体必须是 JSON 对象" });
        }

        var type = obj["type"]?.GetValue<string>();
        var sdp = obj["sdp"]?.GetValue<string>();

        if (type is not ("offer" or "answer"))
        {
            return Json(400, new JsonObject { ["error"] = "type 必须是 \"offer\" 或 \"answer\"" });
        }
        if (string.IsNullOrEmpty(sdp))
        {
            return Json(400, new JsonObject { ["error"] = "sdp 必须是字符串" });
        }
        if (sdp.Length > SdpMaxLength)
        {
            return Json(400, new JsonObject { ["error"] = "sdp 体积超出限制(200KB)" });
        }

        var problem = ValidateSdp(type, sdp);
        if (problem is not null)
        {
            return Json(400, new JsonObject { ["error"] = problem });
        }

        if (!_store.UpdateSignal(code, type, sdp))
        {
            return Json(404, new JsonObject { ["error"] = "会话不存在或已过期" });
        }

        return Json(200, new JsonObject { ["ok"] = true, ["code"] = code, ["type"] = type });
    }

    /// <summary>
    /// 校验 SDP。客户端提交的是 JSON.stringify({type, sdp}) 这种"编码后的字符串",
    /// 服务器原样存取,这里解回会话描述只做合法性检查,同时容忍直接提交裸 SDP。
    /// </summary>
    private static string? ValidateSdp(string type, string sdp)
    {
        var description = sdp;
        string? innerType = null;

        try
        {
            if (JsonNode.Parse(sdp) is JsonObject inner &&
                inner["sdp"]?.GetValue<string>() is { } innerSdp)
            {
                description = innerSdp;
                innerType = inner["type"]?.GetValue<string>();
            }
        }
        catch
        {
            // 裸 SDP,保持原样
        }

        if (innerType is not null && innerType != type)
        {
            return "sdp 内部的 type 与请求体的 type 不一致";
        }
        if (!description.TrimStart().StartsWith("v=", StringComparison.Ordinal))
        {
            return "sdp 不是合法的会话描述(应以 v= 开头)";
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(description, @"(^|\r?\n)m="))
        {
            return "sdp 缺少 m= 媒体行";
        }
        if (type == "answer" &&
            !System.Text.RegularExpressions.Regex.IsMatch(description, @"(^|\r?\n)a=setup:"))
        {
            return "sdp 不是合法的应答(缺少 a=setup:)";
        }

        return null;
    }

    private static HttpResponse Json(int status, JsonNode payload) =>
        new(status, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(payload.ToJsonString()));

    // ------------------------------------------------------------ 静态资源

    private HttpResponse HandleStatic(string path)
    {
        var assetPath = path switch
        {
            "/" => "index.html",
            _ => path.TrimStart('/'),
        };

        // 目录形式(/host/)或带斜杠的地址都补上 index.html
        if (!_assets.Contains(assetPath) && _assets.Contains(assetPath + "/index.html"))
        {
            assetPath += "/index.html";
        }

        if (!_assets.Contains(assetPath))
        {
            Log.Warn($"静态资源不存在:{assetPath}");
            return new HttpResponse(404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("404 页面不存在"));
        }

        var bytes = _assets.Read(assetPath);
        var contentType = ContentTypeFor(assetPath);
        var isHtml = contentType.StartsWith("text/html", StringComparison.Ordinal);

        if (isHtml)
        {
            // 注入接口地址:静态页面不知道宿主挂在哪个端口上
            bytes = Encoding.UTF8.GetBytes(InjectRuntimeConfig(Encoding.UTF8.GetString(bytes)));
        }

        // HTML 不能长缓存,否则改了页面用户看不到
        return new HttpResponse(200, contentType, bytes, NoCache: isHtml);
    }

    /// <summary>
    /// 把宿主信息注入 HTML,让页面知道接口在哪个地址。
    /// 放在 &lt;head&gt; 最前面:主 bundle 是 defer 加载的,一定在它之前执行。
    /// </summary>
    private string InjectRuntimeConfig(string html)
    {
        var script =
            "<script>(function(){" +
            // 用 document.baseURI 取当前源 —— trailingSlash 下页面地址可能带 /host/ 这种尾斜杠
            "var u=new URL(document.baseURI);" +
            $"window.{ApiBaseFlag}=u.origin;" +
            $"window.{HostFlag}='desktop';" +
            "})();</script>";

        var headIndex = html.IndexOf("<head>", StringComparison.OrdinalIgnoreCase);
        if (headIndex >= 0)
        {
            return html.Insert(headIndex + "<head>".Length, script);
        }

        // 没有 head 就放在最前面,效果相同
        return script + html;
    }

    private static string ContentTypeFor(string path)    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        return ext switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".mjs" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".ico" => "image/x-icon",
            ".woff2" => "font/woff2",
            ".woff" => "font/woff",
            ".txt" => "text/plain; charset=utf-8",
            _ => "application/octet-stream",
        };
    }

    public void Dispose()
    {
        try
        {
            _shutdown.Cancel();
        }
        catch
        {
            // 忽略
        }

        foreach (var listener in _listeners)
        {
            try
            {
                listener.Stop();
            }
            catch
            {
                // 忽略
            }
        }
        _listeners.Clear();
        _shutdown.Dispose();
    }
}
