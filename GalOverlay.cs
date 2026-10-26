using System;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Alife.Client;
using Alife.Framework;
using Microsoft.Extensions.Logging;

namespace presents.GalMode;

/// <summary>
/// 把 GAL 挂件与皮肤注入 Alife 主窗口（幂等）。
/// Alife 5 没有「拿主窗口句柄 / 遍历窗口 / 在主窗口执行脚本」的 API，
/// 主窗口侧的脚本改走官方 GlobalUI 通道：<see cref="GalModeGlobalUI"/> 由客户端
/// GlobalUIOverlay 挂载到主页面，带着 IJSRuntime，用它 eval 就是以前的 ExecuteJavaScript。
/// </summary>
sealed class GalOverlay(IAlifeApplication alifeApplication, string pluginDirectory, ILogger logger) : IAsyncDisposable
{
    const string Ver = "1.3.25";

    /// <summary>单次注入的最长等待：页面没 ready 时 eval 会一直排队。</summary>
    const int InjectTimeoutMs = 5000;

    // 页面没 ready 时注入必然失败，重试别太密：原来 60 次 × 1s 会在启动阶段反复往
    // 渲染线程塞整份样式，Blazor 的 SignalR 心跳一断就卡在「Rejoining the server」。
    const int AttachAttempts = 12;
    const int AttachDelayMs = 1500;
    const int KeepAliveSeconds = 30;

    /// <summary>主窗口页面执行器（GlobalUI 组件注入）。null = 组件还没挂载。</summary>
    static Func<string, Task<string?>>? jsSink;

    /// <summary>GlobalUI 组件挂载完成（可以开始注入了）。挂载通常晚于模块 Awake。</summary>
    public static event Action? SinkReady;

    public static bool HasSink => jsSink != null;

    public static void SetSink(Func<string, Task<string?>> sink)
    {
        jsSink = sink;
        SinkReady?.Invoke();
    }

    public static void ClearSink(Func<string, Task<string?>> sink)
    {
        if (ReferenceEquals(jsSink, sink)) jsSink = null;
    }

    string css = "";
    string js = "";
    bool resourcesLoaded;

    GalModeConfig? config;
    bool attached;
    bool reattaching;
    bool disposed;

    public bool IsAttached => attached;

    /// <summary>在后台反复尝试注入，直到成功或超时。调用方不要 await 在模块加载路径上。</summary>
    public async Task AttachAsync(GalModeConfig config, CancellationToken ct = default)
    {
        this.config = config;

        for (int attempt = 0; attempt < AttachAttempts && !ct.IsCancellationRequested && !disposed; attempt++)
        {
            string result = await InjectAsync(config);

            if (result.StartsWith("ok", StringComparison.Ordinal))
            {
                attached = true;
                logger.LogInformation("[GalMode] 挂件已注入（第 {Attempt} 次尝试）", attempt + 1);
                Diag($"attached ver={Ver} attempt={attempt + 1} -> {result}");
                return;
            }

            Diag($"attempt {attempt + 1}/{AttachAttempts} failed: {result}");

            try
            {
                await Task.Delay(AttachDelayMs, ct);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>插件停用/重载时把自己加的东西全部撤掉，别在页面上留残迹。</summary>
    public async Task DetachAsync()
    {
        disposed = true;
        bool wasAttached = attached;
        attached = false;

        if (wasAttached)
        {
            try
            {
                await EvalAsync(
                    "(function () {"
                    + " var n = document.querySelectorAll('[data-alife-gal]');"
                    + " for (var i = 0; i < n.length; i++) n[i].remove();"
                    + " document.body.classList.remove('gal-skin');"
                    + " document.body.classList.remove('gal-chat');"
                    + " var m = document.querySelectorAll('.gal-chat-root,.gal-chat-head,.gal-main,.gal-app');"
                    + " for (var i = 0; i < m.length; i++) {"
                    + "   m[i].classList.remove('gal-chat-root', 'gal-chat-head', 'gal-main', 'gal-app');"
                    + " }"
                    + " if (window.__alifeGalTick) { clearInterval(window.__alifeGalTick); window.__alifeGalTick = null; }"
                    + " window.__alifeGalReady = false;"
                    + " return 'removed';"
                    + " })()",
                    3000);
            }
            catch (Exception e)
            {
                logger.LogDebug(e, "[GalMode] 清理页面残留失败");
            }
        }

        // 剧情窗口与本地素材服务是插件独占的，停用/重载时一并收掉
        await DisposeStoryAsync();
    }

    async Task DisposeStoryAsync()
    {
        await CloseStoryWindowAsync();

        StoryServer? server = storyServer;
        storyServer = null;
        if (server == null) return;

        try { server.Dispose(); } catch { }
    }

    public async ValueTask DisposeAsync()
    {
        await DetachAsync();
    }

    /// <summary>页面重载 / SPA 重渲染会把挂件节点清掉，定期确认一次并自愈。</summary>
    public async Task KeepAliveAsync(CancellationToken ct = default)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(KeepAliveSeconds), ct);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (config == null) continue;

            if (!attached)
            {
                await AttachAsync(config, ct);
                continue;
            }

            // 顺便再 apply 一次：聊天窗是路由切换后才出现的，这里是 tagChatRoot 的兜底
            string alive = await EvalAsync(
                "(function () {"
                + " if (window.__alifeGalApply && window.__alifeGalConfig) window.__alifeGalApply(window.__alifeGalConfig);"
                + " return document.getElementById('alife-gal-widget') ? 'y' : 'n';"
                + " })()",
                3000);

            if (alive == "y") continue;

            attached = false;
            logger.LogInformation("[GalMode] 挂件已不在页面上，重新注入");
        }
    }

    public async Task PushStatsAsync(long total, long input, long output, int turns, long last)
    {
        // 还没注入成功时直接丢掉：否则每来一次 Token 用量都要找一遍窗口，任务会堆积
        if (!attached) return;

        string json = JsonSerializer.Serialize(new { total, input, output, turns, last });

        // 以字符串结尾，避免完成值为 undefined 时泛型转换失败刷警告
        string result = await EvalAsync(
            $"if (window.__alifeGalSetStats) {{ window.__alifeGalSetStats({json}); 'ok'; }} else 'skip';",
            3000);

        if (!string.IsNullOrEmpty(result)) return;

        // 执行失败一般是页面重载把句柄/上下文换了：标记失效并立刻补一次
        attached = false;
        Reattach();
    }

    IAlifeWindow? storyWindow;
    StoryServer? storyServer;

    /// <summary>剧情窗口隐藏后留在系统托盘的入口；窗口可见时为 null。</summary>
    TrayIconHost? storyTray;

    /// <summary>
    /// 当前角色名。配置里「角色显示名」留空时用它，
    /// 这样换角色、改名之后对话框名牌会跟着变，而不是一直「她」。
    /// </summary>
    public Func<string>? RoleNameProvider { get; set; }

    /// <summary>选项生成回调（模块注入，走 ILanguageModel，不写聊天记录）。</summary>
    public Func<string, string>? ChoiceGenerator { get; set; }

    /// <summary>剧本生成回调（由模块注入，内部用 Alife 已配置的模型）。</summary>
    public Func<string, string>? StoryGenerator { get; set; }

    /// <summary>逐句语音合成：输入一小段文字，返回音频字节 + MIME；没有语音模型时返回 null。</summary>
    public Func<string, (byte[] Data, string Mime)?>? SpeechSynthesizer { get; set; }

    /// <summary>语音模型是否可用，给 /api/settings 用。</summary>
    public Func<bool>? SpeechAvailable { get; set; }

    /// <summary>隔离模式：直接调模型演一句，不经过主聊天，也不写 Alife 记忆。</summary>
    public Func<string, string>? IsolatedChat { get; set; }

    /// <summary>隔离模式是否可用（模型接口与 SK 组件齐全），给设置面板灰按钮用。</summary>
    public Func<bool>? IsolateAvailable { get; set; }

    /// <summary>名牌上显示的名字：配置优先，其次当前角色名，最后交给前端退回「她」。</summary>
    string ResolveRoleName(GalModeConfig config)
    {
        if (!string.IsNullOrWhiteSpace(config.CharacterName)) return config.CharacterName.Trim();

        return (RoleNameProvider?.Invoke() ?? string.Empty).Trim();
    }

    /// <summary>剧情页面与素材的本地静态服务（幂等）。没有 web 目录时返回 null。</summary>
    string? EnsureStoryServer()
    {
        if (storyServer != null) return storyServer.BaseUrl;

        string webRoot = Path.Combine(pluginDirectory, "Resources", "gal", "web");

        if (!Directory.Exists(webRoot)) return null;

        storyServer = new StoryServer(webRoot);
        storyServer.HistoryProvider = () => historyJson;
        storyServer.HistoryRevProvider = () => HistoryRev;
        storyServer.GenerateHandler = StoryGenerator;
        storyServer.ChoiceHandler = ChoiceGenerator;
        storyServer.TtsHandler = SpeechSynthesizer;
        storyServer.ChatHandler = IsolatedChat;
        storyServer.SettingsProvider = () => JsonSerializer.Serialize(new
        {
            choiceCount = lastConfig?.ChoiceCount ?? 3,
            tts = SpeechAvailable?.Invoke() == true,
            isolate = IsolateAvailable?.Invoke() == true,
        });

        // 剧情窗口自绘的「—」/「✕」：Alife 5 没有系统标题栏，隐藏与关闭只能走页面请求
        storyServer.WindowHideHandler = () => _ = HideStoryAsync();
        storyServer.WindowCloseHandler = () => _ = CloseStoryFromTrayAsync();

        // 窗口里打的字，塞回主窗口的聊天框并触发发送
        storyServer.SendHandler = (text) =>
        {
            string quoted = JsonSerializer.Serialize(text);

            // 主窗口可能还没就绪（剧情窗口刚打开、页面正在重建）：原来是 fire-and-forget，
            // 抛错/返回 false 都被静默吞掉，表现就是「第一次输入像没生效」。这里重试到真的送进去。
            // 只发一次。之前这里有个 24 次的重试循环，和前端自己的重试叠在一起，
            // 结果同一条消息被反复塞进输入框 —— 表现就是"点一次选项，疯狂重复同一句"。
            // 等待页面就绪的活儿交给前端（gal.js 里最多等 1.5 秒），C# 侧不再重复调用。
            // 第一次回传时主窗口可能还没就绪（页面正在挂载），直接丢掉就表现成"第一次输入无效"。
            // __alifeGalSend 只在真的点下发送后返回 'true'，所以重试是安全的，不会重复发送。
            _ = Task.Run(async () =>
            {
                for (int attempt = 0; attempt < 20; attempt++)
                {
                    try
                    {
                        string result = await EvalPublicAsync(
                            "window.__alifeGalSend && window.__alifeGalSend(" + quoted + ")");

                        logger.LogInformation("[GalMode] 回传第 {Attempt} 次：{Result}", attempt + 1, result ?? "(null)");

                        // true = 点了发送按钮；enter = 走了回车兜底。两者都算已发出，不能再重试
                        if (!string.IsNullOrWhiteSpace(result)
                            && (result.Trim().StartsWith("true", StringComparison.OrdinalIgnoreCase)
                                || result.Trim().StartsWith("enter", StringComparison.OrdinalIgnoreCase)))
                            return;
                    }
                    catch (Exception ex)
                    {
                        logger.LogInformation("[GalMode] 回传第 {Attempt} 次异常：{Message}", attempt + 1, ex.Message);
                    }

                    await Task.Delay(400);
                }

                logger.LogWarning("[GalMode] 回传失败：主窗口一直没有可用的输入框");
            });        };

        return storyServer.BaseUrl;
    }

    /// <summary>主窗口抓来的会话历史（JSON 数组），剧情窗口轮询它。</summary>
    volatile string historyJson = "[]";

    /// <summary>历史版本号：主窗口内容变了才涨，剧情窗口拿它跳过重复拉取。</summary>
    volatile int historyRev;

    public int HistoryRev => historyRev;

    /// <summary>最近一次应用的模块配置，给 /api/settings 用。</summary>
    GalModeConfig? lastConfig;

    public void UpdateHistory(string json, int rev = 0)
    {
        if (string.IsNullOrWhiteSpace(json) || json.Length <= 2) return;

        historyJson = json;
        if (rev > 0) historyRev = rev;
    }

    /// <summary>
    /// 剧情窗口的 WebView2 只能在自己的 UI 线程操作。打开来自轮询线程，隐藏/关闭来自
    /// 本地 HTTP 线程和托盘，直接调 IAlifeWindow 会抛
    /// 「CoreWebView2Controller members can only be accessed from the UI thread」，
    /// 所以统一挪回 WinForms 主线程再执行。
    /// </summary>
    static Task RunOnUiAsync(Func<Task> action)
    {
        Control? form = null;

        try
        {
            if (Application.OpenForms.Count > 0) form = Application.OpenForms[0];
        }
        catch
        {
            // 拿不到窗体就按原线程跑
        }

        if (form == null || !form.InvokeRequired) return action();

        TaskCompletionSource done = new(TaskCreationOptions.RunContinuationsAsynchronously);

        try
        {
            form.BeginInvoke(new Action(async () => {
                try
                {
                    await action();
                    done.TrySetResult();
                }
                catch (Exception e)
                {
                    done.TrySetException(e);
                }
            }));
        }
        catch
        {
            return action();
        }

        return done.Task;
    }

    /// <summary>
    /// 打开剧情窗口：网页版引擎跑在独立宿主窗口里（Alife 5：IAlifeWindow / WebView2），
    /// 页面由 StoryServer 提供（file:// 下 ES module 会被 CORS 拦，必须走 http）。
    /// </summary>
    public Task OpenStoryWindowAsync() => RunOnUiAsync(OpenStoryCoreAsync);

    async Task OpenStoryCoreAsync()
    {
        try
        {
            // 宿主没有「窗口关闭」事件：用户关掉窗口后再点剧情，ShowAsync 会失败，
            // 这时丢掉旧句柄重建一个即可。
            if (storyWindow != null)
            {
                try
                {
                    await storyWindow.ShowAsync();
                    HideStoryTray();   // 窗口回到屏幕，撤掉隐藏时的托盘入口
                    return;
                }
                catch
                {
                    await CloseStoryWindowAsync();
                }
            }

            string? baseUrl = EnsureStoryServer();

            if (baseUrl == null)
            {
                logger.LogWarning("[GalMode] 缺少剧情页面");
                return;
            }

            storyWindow = await alifeApplication.CreateWindowAsync(new AlifeWindowOptions {
                Title = "GAL 剧情",
                Bounds = GetStoryBounds(),
                Resizable = true,
                Url = baseUrl + "demo/?live=1&v=" + Uri.EscapeDataString(Ver),
            });

            // 唤醒并等待页面开始跑（窗口不给「加载完成」事件，前端自己轮询 /api/*）
            await storyWindow.Launch();

            // 窗口没有 Closed 事件，也就不在这里关掉 StoryServer：素材与 /api 要一直可用，
            // 真正停止在插件停用（DetachAsync / DisposeAsync）时统一做。
            logger.LogInformation("[GalMode] 剧情窗口已打开：{Url}", baseUrl + "demo/");
            Diag("story window opened -> " + baseUrl + "demo/");
            HideStoryTray();
        }
        catch (Exception e)
        {
            logger.LogError(e, "[GalMode] 打开剧情窗口失败");
        }
    }

    /// <summary>剧情窗口位置：宿主只收 Bounds（逻辑像素），这里按屏幕居中并留边。</summary>
    Rectangle GetStoryBounds()
    {
        const int WantWidth = 1280;
        const int WantHeight = 820;

        try
        {
            Size physical = alifeApplication.GetScreenSize();
            double dpi = Math.Max(0.1, alifeApplication.GetDpiScale());
            int screenWidth = Math.Max(640, (int)Math.Round(physical.Width / dpi));
            int screenHeight = Math.Max(480, (int)Math.Round(physical.Height / dpi));
            int width = Math.Min(WantWidth, (int)(screenWidth * 0.92));
            int height = Math.Min(WantHeight, (int)(screenHeight * 0.88));

            return new Rectangle((screenWidth - width) / 2, (screenHeight - height) / 2, width, height);
        }
        catch
        {
            return new Rectangle(120, 80, WantWidth, WantHeight);
        }
    }

    Task CloseStoryWindowAsync() => RunOnUiAsync(CloseStoryCoreAsync);

    async Task CloseStoryCoreAsync()
    {
        HideStoryTray();

        IAlifeWindow? window = storyWindow;
        storyWindow = null;
        if (window == null) return;
        // 先隐藏再释放：宿主 DisposeAsync 若只清理 WebView 而不销毁窗体，至少窗口会立刻消失
        try { await window.HideAsync(); } catch { }
        try { await window.DisposeAsync(); } catch { }
    }

    /// <summary>标题栏「—」：隐藏到系统托盘。窗口与页面都保留，点托盘图标或「剧情」按钮即可恢复。</summary>
    public Task HideStoryAsync() => RunOnUiAsync(HideStoryCoreAsync);

    async Task HideStoryCoreAsync()
    {
        IAlifeWindow? window = storyWindow;
        if (window == null) return;

        try
        {
            await window.HideAsync();
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "[GalMode] 隐藏剧情窗口失败");
            return;
        }

        ShowStoryTray();
        logger.LogInformation("[GalMode] 剧情窗口已隐藏到托盘（点托盘图标可恢复）");
    }

    /// <summary>托盘图标左键 / 「显示剧情窗口」。</summary>
    Task RestoreStoryFromTrayAsync() => RunOnUiAsync(RestoreStoryCoreAsync);

    async Task RestoreStoryCoreAsync()
    {
        HideStoryTray();

        if (storyWindow == null)
        {
            await OpenStoryCoreAsync();
            return;
        }

        try
        {
            await storyWindow.ShowAsync();
            logger.LogInformation("[GalMode] 剧情窗口已从托盘恢复");
        }
        catch
        {
            // 宿主没有窗口关闭事件：外部把窗口关掉后 ShowAsync 会失败，丢掉旧句柄重建
            await CloseStoryCoreAsync();
            await OpenStoryCoreAsync();
        }
    }

    /// <summary>托盘菜单「关闭剧情窗口」/ 标题栏「✕」。</summary>
    Task CloseStoryFromTrayAsync() => RunOnUiAsync(CloseStoryFromTrayCoreAsync);

    async Task CloseStoryFromTrayCoreAsync()
    {
        await CloseStoryCoreAsync();
        logger.LogInformation("[GalMode] 剧情窗口已关闭（点「剧情」按钮可重新打开）");
    }

    void ShowStoryTray()
    {
        if (storyTray != null) return;

        storyTray = new TrayIconHost(
            "GAL 剧情（点图标恢复）",
            onShow: () => _ = RestoreStoryFromTrayAsync(),
            onClose: () => _ = CloseStoryFromTrayAsync());
        storyTray.Show();
    }

    void HideStoryTray()
    {
        TrayIconHost? tray = storyTray;
        storyTray = null;
        tray?.Dispose();
    }

    /// <summary>给模块的轮询用的轻量求值。</summary>
    public Task<string> EvalPublicAsync(string script) => EvalAsync(script, 3000);

    void Reattach()
    {
        if (reattaching || config == null) return;

        reattaching = true;
        _ = Task.Run(async () =>
        {
            try
            {
                await AttachAsync(config);
            }
            catch (Exception e)
            {
                logger.LogDebug(e, "[GalMode] 重新注入失败");
            }
            finally
            {
                reattaching = false;
            }
        });
    }

    async Task<string> InjectAsync(GalModeConfig config)
    {
        lastConfig = config;
        if (!LoadResources()) return "";

        // 素材基地址：舞台换场景 / CG 都从这里取图，没有就只用内置滤镜
        string? baseUrl = EnsureStoryServer();

        string payload = JsonSerializer.Serialize(new {
            ver = Ver,
            css,
            config = new {
                widget = config.ShowWidget,
                skin = config.EnableSkinByDefault,
                accent = config.AccentColor,
                choices = config.EnableChoices,
                choiceCount = config.ChoiceCount,
                character = ResolveRoleName(config),
                assets = baseUrl == null ? "" : baseUrl + "assets/",
            },
        });

        // 直接把脚本拼进注入串，而不是 new Function / 动态 <script>：
        // ExecuteJavaScript 本身不受页面 CSP 限制，后者可能被 script-src 拦掉。
        // 分段之间必须用分号隔开：Bootstrap 以 "})()" 结尾，紧跟的 "(function..." 会被
        // 解析成连续调用（'installed'(...) → TypeError），后面的脚本全都不执行。
        // 末尾补一个表达式，保证注入的完成值是字符串（泛型回调不做 undefined 转换）。
        string script = Bootstrap.Replace("__PAYLOAD__", payload)
            + "\n;\n" + js
            + "\n;if (window.__alifeGalApply) window.__alifeGalApply(window.__alifeGalConfig);"
            + "\n(function () {"
            + " var w = document.getElementById('alife-gal-widget');"
            + " return 'ok widget=' + (!!w)"
            + " + ' skin=' + document.body.classList.contains('gal-skin')"
            + " + ' ver=' + (window.__alifeGalVer || '?');"
            + " })()";

        return await EvalAsync(script, InjectTimeoutMs);
    }

    bool LoadResources()
    {
        if (resourcesLoaded) return true;

        try
        {
            css = File.ReadAllText(Path.Combine(pluginDirectory, "Resources", "gal", "gal.css"));

            // 舞台素材是 base64 内联的，单独放一个文件；超限直接跳过 ——
            // 往渲染线程里塞几 MB 的样式会把 Blazor 的心跳堵死（表现为卡在加载进度 + Rejoining the server）。
            string assets = Path.Combine(pluginDirectory, "Resources", "gal", "assets.css");
            if (File.Exists(assets))
            {
                var info = new FileInfo(assets);

                if (info.Length <= 300 * 1024)
                    css += "\n" + File.ReadAllText(assets);
                else
                    logger.LogWarning("[GalMode] assets.css 过大（{Size} KB），已跳过舞台素材", info.Length / 1024);
            }

            js = File.ReadAllText(Path.Combine(pluginDirectory, "Resources", "gal", "gal.js"));
            resourcesLoaded = css.Length > 0 && js.Length > 0;
            return resourcesLoaded;
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "[GalMode] 读取资源失败");
            return false;
        }
    }

    async Task<string> EvalAsync(string script, int timeoutMs)
    {
        Func<string, Task<string?>>? sink = jsSink;

        // GlobalUI 组件还没挂载（页面没起来 / 客户端版本不支持）：等下一轮重试，不算错误
        if (sink == null) return "";

        try
        {
            string? result = await sink(script).WaitAsync(TimeSpan.FromMilliseconds(timeoutMs));
            return result ?? "";
        }
        catch (Exception e)
        {
            // 页面重载 / 电路断开后脚本可能执行失败，KeepAlive 会再补一次
            logger.LogDebug("[GalMode] 注入未成功：{Message}", e.Message);
            return "";
        }
    }

    /// <summary>诊断：注入与消息过滤只有运行时才知道结果，落到临时目录方便排查。</summary>
    internal static void Diag(string message)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(Path.GetTempPath(), "galmode.log"),
                $"{DateTime.Now:HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch
        {
            // 诊断写不进去不影响功能
        }
    }

    const string Bootstrap =
        """
        (function () {
            var p = __PAYLOAD__;
            window.__alifeGalConfig = p.config;

            var prev = window.__alifeGalVer || null;
            var apply = window.__alifeGalApply;

            // 样式节点被外部清理过（重载）时不能走快路径，要重新装一遍
            if (prev === p.ver && typeof apply === 'function' && document.querySelector('style[data-alife-gal]')) {
                try { apply(p.config); } catch (e) { console.error(e); }
                return 'ready';
            }

            document.querySelectorAll('[data-alife-gal]').forEach(function (node) { node.remove(); });

            var style = document.createElement('style');
            style.setAttribute('data-alife-gal', '1');
            style.textContent = p.css;
            document.head.appendChild(style);

            window.__alifeGalVer = p.ver;

            if (window.__alifeGalApply) {
                try { window.__alifeGalApply(p.config); } catch (e) { console.error(e); }
            }

            return 'installed';
        })()
        """;
}
