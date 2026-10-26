using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace presents.GalMode;

/// <summary>
/// 极小的只读静态服务，把 Resources/gal/web 下的剧情页面喂给独立的 BrowserWindow。
/// 用 TcpListener 手写 HTTP/1.1，避开 HttpListener 的 URL ACL 与端口占用问题。
/// </summary>
internal sealed class StoryServer : IDisposable
{
    static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".mjs"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp",
        [".gif"] = "image/gif",
        [".svg"] = "image/svg+xml",
        [".mp3"] = "audio/mpeg",
        [".ogg"] = "audio/ogg",
        [".wav"] = "audio/wav",
        [".woff2"] = "font/woff2",
    };

    readonly TcpListener listener;
    readonly CancellationTokenSource cts = new();
    readonly string root;

    public int Port { get; }

    public string BaseUrl => "http://127.0.0.1:" + Port + "/";

    /// <summary>剧情窗口轮询这个拿当前会话（由主窗口抓 DOM 后转存）。</summary>
    public Func<string>? HistoryProvider { get; set; }

    /// <summary>会话历史版本号：带上 ?rev= 且没变化时直接回 204，省掉整包 JSON。</summary>
    public Func<int>? HistoryRevProvider { get; set; }

    /// <summary>剧本生成：编辑器 POST 一句需求，插件用 Alife 已配置的模型回一份 JSON。</summary>
    public Func<string, string>? GenerateHandler { get; set; }

    /// <summary>现场生成玩家选项（输入最后一句台词，返回 JSON 数组）。</summary>
    public Func<string, string>? ChoiceHandler { get; set; }

    /// <summary>窗口要用的模块配置（目前只有选项个数），避免前端写死。</summary>
    public Func<string>? SettingsProvider { get; set; }

    /// <summary>剧情窗口往这里发一句话，由插件塞回主窗口的聊天框。</summary>
    public Action<string>? SendHandler { get; set; }

    /// <summary>隔离模式：输入一段 JSON（角色 / 状态 / 最近对话 / 玩家这句），直接调模型演下一句。</summary>
    public Func<string, string>? ChatHandler { get; set; }

    /// <summary>逐句语音合成：输入一小段文字，返回音频字节与 MIME；没有语音模型时返回 null。</summary>
    public Func<string, (byte[] Data, string Mime)?>? TtsHandler { get; set; }

    /// <summary>剧情窗口标题栏「—」：隐藏到系统托盘（页面保留，点托盘图标恢复）。</summary>
    public Action? WindowHideHandler { get; set; }

    /// <summary>剧情窗口标题栏「✕」：释放窗口（下次点「剧情」重建）。</summary>
    public Action? WindowCloseHandler { get; set; }

    public StoryServer(string webRoot)
    {
        root = Path.GetFullPath(webRoot);

        listener = StartListener();

        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        _ = Task.Run(AcceptLoop);
    }

    /// <summary>
    /// 固定端口：浏览器按 origin（含端口）隔离 localStorage / IndexedDB，
    /// 每次启动换端口会把设置、素材、存档全部清空。固定端口是数据能跨重启保留的前提。
    /// </summary>
    static TcpListener StartListener()
    {
        const int PreferredPort = 45700;
        const int Tries = 10;

        var candidates = new List<int>();

        // 上次成功用过的端口优先：快速重启时端口可能还在 TIME_WAIT，
        // 被挤到相邻端口后若下次又回到 45700，origin 就变了，本地数据会读不到
        try
        {
            string saved = File.Exists(PortFile) ? File.ReadAllText(PortFile).Trim() : "";
            int port = int.Parse(saved);

            if (port > 0) candidates.Add(port);
        }
        catch
        {
            // 端口文件丢了/内容坏了，直接按默认端口顺序试
        }

        for (int port = PreferredPort; port < PreferredPort + Tries; port++)
        {
            if (!candidates.Contains(port)) candidates.Add(port);
        }

        foreach (int port in candidates)
        {
            try
            {
                var probe = new TcpListener(IPAddress.Loopback, port);
                probe.Start();
                SavePort(port);
                return probe;
            }
            catch (SocketException)
            {
                // 被占用就试下一个
            }
        }

        // 全占用才退回随机端口：本次可用，但重启后本地数据会换 origin
        var fallback = new TcpListener(IPAddress.Loopback, 0);
        fallback.Start();
        return fallback;
    }

    static string PortFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Alife",
        "GalMode",
        "port.txt");

    static void SavePort(int port)
    {
        try
        {
            string file = PortFile;
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, port.ToString());
        }
        catch
        {
            // 写不了也不影响本次运行，只是下次可能换端口
        }
    }

    async Task AcceptLoop()
    {
        while (!cts.IsCancellationRequested)
        {
            TcpClient client;

            try
            {
                client = await listener.AcceptTcpClientAsync(cts.Token);
            }
            catch
            {
                break;
            }

            _ = Task.Run(() => Handle(client));
        }
    }

    async Task Handle(TcpClient client)
    {
        try
        {
            using (client)
            using (NetworkStream stream = client.GetStream())
            {
                client.ReceiveTimeout = 10000;
                client.SendTimeout = 60000;

                string? head = ReadHead(stream);
                if (head == null) return;

                string[] lines = head.Split("\r\n");
                string[] first = lines[0].Split(' ');
                if (first.Length < 2) return;

                string method = first[0].ToUpperInvariant();
                string target = first[1];
                string query = "";

                int queryIndex = target.IndexOf('?');
                if (queryIndex >= 0)
                {
                    query = target.Substring(queryIndex + 1);
                    target = target.Substring(0, queryIndex);
                }

                try { target = Uri.UnescapeDataString(target); } catch { }

                if (target == "/api/history")
                {
                    int rev = HistoryRevProvider?.Invoke() ?? 0;
                    int since = ParseQueryInt(query, "rev");

                    // 客户端已经拿到这一版了：回 204，别再把整包 JSON 传一遍
                    if (rev > 0 && since > 0 && since == rev)
                    {
                        WriteNoContent(stream, rev);
                        return;
                    }

                    WriteJson(stream, HistoryProvider?.Invoke() ?? "[]", rev);
                    return;
                }

                if (target == "/api/choices")
                {
                    string scene = ReadBody(stream, lines).Trim();

                    try
                    {
                        WriteJson(stream, ChoiceHandler?.Invoke(scene) ?? "[]");
                    }
                    catch (Exception ex)
                    {
                        WriteJson(stream, System.Text.Json.JsonSerializer.Serialize(new { error = ex.Message }));
                    }

                    return;
                }
                // 导出全文 TXT：内容由页面拼好，这里只负责落盘到「文档/Alife/剧情导出」
                if (target == "/api/export")
                {
                    // 全文可能很长，单独放宽到 4MB；其他接口仍按 200KB 限
                    string content = ReadBody(stream, lines, 4_000_000);
                    string name = ParseQueryString(query, "name") ?? "剧情记录";

                    try
                    {
                        string path = ExportText(name, content);
                        WriteJson(stream, System.Text.Json.JsonSerializer.Serialize(new { path }));
                    }
                    catch (Exception ex)
                    {
                        WriteJson(stream, System.Text.Json.JsonSerializer.Serialize(new { error = ex.Message }));
                    }

                    return;
                }

                // 模块配置（选项个数等）：剧情窗口读一次，别再把 3 条写死
                if (target == "/api/settings")
                {
                    WriteJson(stream, SettingsProvider?.Invoke() ?? "{}");
                    return;
                }

                // 预设背景清单：剧本写「天台·夜」，文件叫「天台_夜晚.jpg」，前端要靠真实文件名做匹配
                if (target == "/api/scenes")
                {
                    string[] names = Array.Empty<string>();
                    string sceneDir = Path.Combine(root, "assets", "scenes");

                    if (Directory.Exists(sceneDir))
                    {
                        string[] files = Directory.GetFiles(sceneDir);
                        var list = new List<string>();

                        foreach (string sceneFile in files)
                        {
                            string ext = Path.GetExtension(sceneFile);

                            if (ext.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
                                || ext.Equals(".jpeg", StringComparison.OrdinalIgnoreCase)
                                || ext.Equals(".png", StringComparison.OrdinalIgnoreCase)
                                || ext.Equals(".webp", StringComparison.OrdinalIgnoreCase))
                            {
                                list.Add(Path.GetFileName(sceneFile));
                            }
                        }

                        list.Sort(StringComparer.Ordinal);
                        names = list.ToArray();
                    }

                    WriteJson(stream, System.Text.Json.JsonSerializer.Serialize(names));
                    return;
                }

                // 编辑器点「AI 生成剧情」走这里：不需要用户再填一份 Key
                if (target == "/api/generate")
                {
                    string idea = ReadBody(stream, lines).Trim();

                    if (GenerateHandler == null)
                    {
                        WriteJson(stream, "{\"error\":\"当前环境没有可用的模型\"}");
                        return;
                    }

                    try
                    {
                        string json = GenerateHandler(idea);
                        WriteJson(stream, string.IsNullOrWhiteSpace(json) ? "{\"error\":\"模型没有返回内容\"}" : json);
                    }
                    catch (Exception ex)
                    {
                        WriteJson(stream, System.Text.Json.JsonSerializer.Serialize(new { error = ex.Message }));
                    }

                    return;
                }

                // 逐句朗读：只接一小段文字，返回音频字节；前端按当前显示的小段来要
                if (target == "/api/tts")
                {
                    string text = ReadBody(stream, lines).Trim();

                    if (text.Length == 0)
                    {
                        WriteJson(stream, "{\"error\":\"空文本\"}");
                        return;
                    }

                    (byte[] Data, string Mime)? clip = null;

                    try
                    {
                        clip = TtsHandler?.Invoke(text);
                    }
                    catch (Exception ex)
                    {
                        WriteJson(stream, System.Text.Json.JsonSerializer.Serialize(new { error = ex.Message }));
                        return;
                    }

                    if (clip == null)
                    {
                        WriteJson(stream, "{\"error\":\"没有可用的语音模型\"}");
                        return;
                    }

                    WriteBytes(stream, clip.Value.Data, clip.Value.Mime);
                    return;
                }

                // 窗口右上角的「—」/「✕」：Alife 5 没有系统标题栏，只能由页面自绘按钮发请求
                if (target == "/api/window-hide")
                {
                    WindowHideHandler?.Invoke();
                    WriteJson(stream, "{\"ok\":true}");
                    return;
                }

                if (target == "/api/window-close")
                {
                    WindowCloseHandler?.Invoke();
                    WriteJson(stream, "{\"ok\":true}");
                    return;
                }

                if (target == "/api/send")
                {
                    string text = ReadBody(stream, lines);

                    if (!string.IsNullOrWhiteSpace(text)) SendHandler?.Invoke(text.Trim());

                    WriteJson(stream, "{\"ok\":true}");
                    return;
                }

                // 隔离模式：不经主聊天，直接让模型在剧情窗口里接着演
                if (target == "/api/chat")
                {
                    string payload = ReadBody(stream, lines);

                    try
                    {
                        WriteJson(stream, ChatHandler?.Invoke(payload) ?? "{\"error\":\"隔离模式不可用\"}");
                    }
                    catch (Exception ex)
                    {
                        WriteJson(stream, System.Text.Json.JsonSerializer.Serialize(new { error = ex.Message }));
                    }

                    return;
                }

                if (target == "/" || target.Length == 0) target = "/demo/";
                if (target.EndsWith("/", StringComparison.Ordinal)) target += "index.html";

                string? file = SafeJoin(target.TrimStart('/'));

                if (file == null)
                {
                    WriteText(stream, "404 Not Found", "no such file: " + target);
                    return;
                }

                byte[] body = await File.ReadAllBytesAsync(file);

                string mime = Mime.TryGetValue(Path.GetExtension(file), out string? known)
                    ? known
                    : "application/octet-stream";

                string header =
                    "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: " + mime + "\r\n" +
                    "Content-Length: " + body.Length + "\r\n" +
                    "Cache-Control: no-store\r\n" +
                    "Connection: close\r\n\r\n";

                byte[] headerBytes = Encoding.ASCII.GetBytes(header);

                stream.Write(headerBytes, 0, headerBytes.Length);

                if (method != "HEAD") stream.Write(body, 0, body.Length);

                stream.Flush();
            }
        }
        catch
        {
            // 页面关闭、连接中断都属正常
        }
    }

    string? SafeJoin(string relative)
    {
        relative = relative.Replace('/', Path.DirectorySeparatorChar);

        string full;

        try
        {
            full = Path.GetFullPath(Path.Combine(root, relative));
        }
        catch
        {
            return null;
        }

        string prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;

        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;

        return File.Exists(full) ? full : null;
    }

    static string? ReadHead(NetworkStream stream)
    {
        MemoryStream buffer = new();
        byte[] one = new byte[1];

        while (buffer.Length < 65536)
        {
            int read;

            try { read = stream.Read(one, 0, 1); }
            catch { return null; }

            if (read <= 0) return null;

            buffer.WriteByte(one[0]);

            if (buffer.Length >= 4)
            {
                byte[] data = buffer.GetBuffer();
                int length = (int)buffer.Length;

                if (data[length - 4] == 13 && data[length - 3] == 10 &&
                    data[length - 2] == 13 && data[length - 1] == 10)
                    return Encoding.UTF8.GetString(data, 0, length);
            }
        }

        return null;
    }

    static string ReadBody(NetworkStream stream, string[] headLines, int max = 200000)
    {
        int length = 0;

        foreach (string line in headLines)
        {
            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
            {
                int.TryParse(line.Substring(15).Trim(), out length);
                break;
            }
        }

        if (length <= 0 || length > max) return "";

        byte[] buffer = new byte[length];
        int offset = 0;

        while (offset < length)
        {
            int read = stream.Read(buffer, offset, length - offset);
            if (read <= 0) break;
            offset += read;
        }

        return Encoding.UTF8.GetString(buffer, 0, offset);
    }

    static void WriteJson(NetworkStream stream, string json, int rev = 0)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json);

        string head =
            "HTTP/1.1 200 OK\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: " + bytes.Length + "\r\n" +
            (rev > 0 ? "X-Gal-Rev: " + rev + "\r\n" : "") +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n";

        byte[] header = Encoding.ASCII.GetBytes(head);

        stream.Write(header, 0, header.Length);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    /// <summary>音频等二进制响应：内容类型由合成侧给，页面直接拿去塞 blob。</summary>
    static void WriteBytes(NetworkStream stream, byte[] bytes, string mime)
    {
        string head =
            "HTTP/1.1 200 OK\r\n" +
            "Content-Type: " + mime + "\r\n" +
            "Content-Length: " + bytes.Length + "\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n";

        byte[] header = Encoding.ASCII.GetBytes(head);

        stream.Write(header, 0, header.Length);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    /// <summary>内容没变：204 无正文，只回版本号让前端知道它手上的是最新一版。</summary>
    static void WriteNoContent(NetworkStream stream, int rev)
    {
        string head =
            "HTTP/1.1 204 No Content\r\n" +
            "X-Gal-Rev: " + rev + "\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n";

        byte[] header = Encoding.ASCII.GetBytes(head);

        stream.Write(header, 0, header.Length);
        stream.Flush();
    }

    /// <summary>导出剧情 TXT：放「我的文档/Alife/剧情导出」，UTF-8 带 BOM，记事本直接能看。</summary>
    static string ExportText(string name, string body)
    {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Alife", "剧情导出");
        Directory.CreateDirectory(dir);

        string safe = (name ?? "").Trim();

        foreach (char bad in Path.GetInvalidFileNameChars()) safe = safe.Replace(bad, '_');
        if (safe.Length == 0) safe = "剧情记录";
        if (safe.Length > 48) safe = safe.Substring(0, 48);

        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        string path = Path.Combine(dir, $"{safe}_剧情记录_{stamp}.txt");

        for (int i = 2; File.Exists(path); i++)
            path = Path.Combine(dir, $"{safe}_剧情记录_{stamp}_{i}.txt");

        File.WriteAllText(path, body, new UTF8Encoding(true));
        return path;
    }

    /// <summary>从 ?name=xxx 取一个字符串，取不到返回 null。</summary>
    static string? ParseQueryString(string query, string key)
    {
        foreach (string part in query.Split('&'))
        {
            int eq = part.IndexOf('=');
            if (eq <= 0) continue;
            if (!part.Substring(0, eq).Equals(key, StringComparison.OrdinalIgnoreCase)) continue;

            string raw = part.Substring(eq + 1);

            try { return Uri.UnescapeDataString(raw.Replace('+', ' ')); }
            catch { return raw; }
        }

        return null;
    }

    /// <summary>从 ?a=1&amp;b=2 里取一个整数，取不到返回 0。</summary>
    static int ParseQueryInt(string query, string key)
    {
        foreach (string part in query.Split('&'))
        {
            int eq = part.IndexOf('=');
            if (eq <= 0) continue;
            if (!part.Substring(0, eq).Equals(key, StringComparison.OrdinalIgnoreCase)) continue;

            return int.TryParse(part.Substring(eq + 1), out int value) ? value : 0;
        }

        return 0;
    }

    static void WriteText(NetworkStream stream, string status, string body)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(body);

        string head =
            "HTTP/1.1 " + status + "\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: " + bytes.Length + "\r\n" +
            "Connection: close\r\n\r\n";

        byte[] header = Encoding.ASCII.GetBytes(head);

        stream.Write(header, 0, header.Length);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    public void Dispose()
    {
        try { cts.Cancel(); } catch { }
        try { listener.Stop(); } catch { }
        try { cts.Dispose(); } catch { }
    }
}
