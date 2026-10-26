using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Alife.Foundation;
using Alife.Framework;
using Microsoft.Extensions.Logging;

namespace presents.GalMode;

/// <summary>
/// GAL 模式（视觉层）：左下角小鲸鱼挂件显示 Token 消耗，并提供一个可随时开关的 GAL 皮肤。
/// 纯附加式改动，不隐藏、不改写任何现有界面元素。
/// </summary>
[Module("GAL 模式",
    "左下角小鲸鱼挂件 + 可开关的 GAL 风格皮肤：显示本轮 / 累计 Token 消耗，套用衬线台词与圆角气泡。默认不改变原有界面。",
    defaultCategory: "presents/窗口美化",
    globalUI: typeof(GalModeGlobalUI))]
public sealed class GalModeModule(
    PluginSystem pluginSystem,
    Interactor<GalModeModule> interactor,
    ILanguageModel languageModel,
    IAlifeApplication alifeApplication,
    ILogger<GalModeModule> logger,
    IServiceProvider? serviceProvider = null) : ChatBehaviour, IConfigurable<GalModeConfig>
{
    public GalModeConfig Configuration { get; set; } = null!;

    readonly CancellationTokenSource cts = new();

    GalOverlay? overlay;
    long totalInput;
    long totalOutput;
    long lastTotal;
    int turns;

    /// <summary>
    /// 编辑器「AI 生成剧情」的后端：用 Alife 里已经配好的模型生成，
    /// 用户不用在编辑器里再填一份 Key。同步等待是因为 StoryServer 的 handler 是同步签名。
    /// </summary>
    string GenerateStory(string idea)
    {
        if (string.IsNullOrWhiteSpace(idea)) return "{\"error\":\"需求是空的\"}";

        const string schema = """
            只输出 JSON，不要代码块：
            {"config":"story_config.yaml 全文","chapters":{"章节id":"该章 yaml 全文"}}

            config 必含：script_name、version: 1、author、description、player_name、intro_chapter、
            variables、chapter_titles、characters（{ name, color }）。

            每章顶层只有 events: 数组，元素 type 取：
            background(path) / effect(name) / music(path,speed) / show_character(character,position,emotion,clothing) /
            narration(text) / dialogue(character,emotion,clothing,text) / choices(prompt, options[{text, actions[{set_var}]}]) /
            input(prompt) / set_variable(name,value) / modify_character(character,emotion,clothing) /
            free_dialogue(max_rounds,end_line) / chapter_end(mode: branching, options[{condition,next}|{default,next}])

            要求：对白一次一句（20-40 字）；每章 10-20 个事件；2-3 个选项且影响变量；
            next 必须是 chapters 里存在的 id；条件只支持 == != 与 &&。
            一句台词里要换表情/服装/场景时，在 text 中内联 [表情:害羞]、[服装:私服]、[场景:天台_傍晚]；
            标签只管它后面那一句，播放时会按标点拆成几小段，一段一次点击。
            """;

        try
        {
            ChatResult result = interactor.ChatAsync(schema + "\n\n需求：" + idea).GetAwaiter().GetResult();

            if (result.Exception != null)
                return System.Text.Json.JsonSerializer.Serialize(new { error = result.Exception.Message });

            string text = (result.AIMessage ?? "").Trim();

            // 模型爱包 ```json：截出最外层的大括号
            int start = text.IndexOf('{');
            int end = text.LastIndexOf('}');

            if (start >= 0 && end > start) text = text.Substring(start, end - start + 1);

            return string.IsNullOrWhiteSpace(text) ? "{\"error\":\"模型没有返回内容\"}" : text;
        }
        catch (Exception ex)
        {
            return System.Text.Json.JsonSerializer.Serialize(new { error = ex.Message });
        }
    }

    /// <summary>
    /// 用底层模型接口现场生成玩家选项：不经过 ChatBot，所以不会写进聊天记录。
    /// 失败就返回空数组，由前端决定怎么兜底。
    /// </summary>
    string GenerateChoices(string scene)
    {
        if (string.IsNullOrWhiteSpace(scene)) return "[]";

        try
        {
            // 不能用 Microsoft.SemanticKernel.ChatHistory 等类型直接写：插件编译时的引用集里没有这些程序集。
            // 全部走反射，拿不到就当没有能力，返回空数组。
            var (threadType, historyType) = ResolveChatTypes();

            if (threadType == null || historyType == null)
            {
                logger.LogWarning("[GalMode] 选项生成不可用：找不到 SemanticKernel 类型（thread={T} history={H}）", threadType != null, historyType != null);
                return "[]";
            }

            int count = Math.Clamp(Configuration?.ChoiceCount ?? 3, 2, 4);

            // 真实线程类型只有 (ChatHistory, id) 构造，id 可空；用无参线程再取 ChatHistory 最稳
            object? thread = Activator.CreateInstance(threadType);
            object? history = thread == null ? null : threadType.GetProperty("ChatHistory")?.GetValue(thread);

            if (history == null) return "[]";

            historyType.GetMethod("AddSystemMessage", new[] { typeof(string) })
                ?.Invoke(history, new object[] { "你在为 galgame 生成玩家可点的回应选项。只输出 JSON 数组，不要代码块、不要解释。" });

            historyType.GetMethod("AddUserMessage", new[] { typeof(string) })
                ?.Invoke(history, new object[]
                {
                    "角色名：" + (Character?.Name ?? "她") + "\n"
                    + "她刚才说：" + scene + "\n"
                    + "请给出 " + count + " 个玩家可以点的回应，用玩家口吻、每条不超过 12 个字，"
                    + "贴合这句话的情绪，不要复述她的话。输出格式：[\"…\",\"…\"]",
                });

            var buffer = new System.Text.StringBuilder();
            Action<string> onText = chunk => buffer.Append(chunk);

            var method = languageModel.GetType().GetMethod("ChatStreamingAsync");
            if (method == null) return "[]";

            var task = (Task<string>)method.Invoke(languageModel, new object?[]
            {
                thread, onText, null, null, null, CancellationToken.None,
            })!;

            string text = (task.GetAwaiter().GetResult() ?? "").Trim();
            if (text.Length == 0) text = buffer.ToString().Trim();
            int open = text.IndexOf('[');
            int close = text.LastIndexOf(']');

            if (open < 0 || close <= open)
            {
                logger.LogInformation("[GalMode] 选项生成：模型返回不是 JSON 数组，前 80 字：{Text}", text.Length > 80 ? text.Substring(0, 80) : text);
                return "[]";
            }

            return text.Substring(open, close - open + 1);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>SemanticKernel 的线程 / 历史类型只能反射取：编译期引用集里没有这些程序集。</summary>
    static (Type? Thread, Type? History) ResolveChatTypes()
    {
        Type? threadType = Type.GetType("Microsoft.SemanticKernel.Agents.ChatHistoryAgentThread, Microsoft.SemanticKernel.Agents.Core");

        // 当前 SK 把 ChatHistory 放在 ChatCompletion 命名空间；保留旧命名空间做版本兜底
        Type? historyType = Type.GetType("Microsoft.SemanticKernel.ChatCompletion.ChatHistory, Microsoft.SemanticKernel.Abstractions")
            ?? Type.GetType("Microsoft.SemanticKernel.ChatHistory, Microsoft.SemanticKernel.Abstractions");

        if (threadType == null || historyType == null)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                threadType ??= assembly.GetType("Microsoft.SemanticKernel.Agents.ChatHistoryAgentThread");
                historyType ??= assembly.GetType("Microsoft.SemanticKernel.ChatCompletion.ChatHistory")
                    ?? assembly.GetType("Microsoft.SemanticKernel.ChatHistory");
            }
        }

        return (threadType, historyType);
    }

    static string Json(object value) => System.Text.Json.JsonSerializer.Serialize(value);

    /// <summary>隔离模式是否可用：模型接口与 SK 组件都在才行。</summary>
    bool CanIsolate()
    {
        try
        {
            if (languageModel.GetType().GetMethod("ChatStreamingAsync") == null) return false;

            var (threadType, historyType) = ResolveChatTypes();
            return threadType != null && historyType != null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 隔离模式：直接走底层模型演下一句，不经过 ChatBot。
    /// 因此这段话不会进入主聊天记录，也不会被记忆归档 / 上下文压缩带走。
    /// 角色人设只能靠当前窗口的剧情历史维持，拿不到主会话的长期记忆。
    /// </summary>
    string GenerateIsolatedReply(string payload)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(payload);
            var root = doc.RootElement;

            string character = root.TryGetProperty("character", out var ce) ? (ce.GetString() ?? "").Trim() : "";
            string state = root.TryGetProperty("state", out var se) ? (se.GetString() ?? "").Trim() : "";
            string text = root.TryGetProperty("text", out var te) ? (te.GetString() ?? "").Trim() : "";

            // 角色卡人设：来自 story_config 的 characters.<id>.system_prompt
            string persona = root.TryGetProperty("system_prompt", out var pe) ? (pe.GetString() ?? "").Trim() : "";

            // ai_judged 章节分支：不要角色扮演，只要模型从候选名里挑一个
            bool branchMode = root.TryGetProperty("branch_mode", out var bm)
                && bm.ValueKind == System.Text.Json.JsonValueKind.True;

            if (character.Length == 0) character = Character?.Name ?? "她";
            if (text.Length == 0) return Json(new { error = "空消息" });

            var (threadType, historyType) = ResolveChatTypes();

            if (threadType == null || historyType == null)
                return Json(new { error = "当前版本不支持隔离模式：缺少 SemanticKernel 组件" });

            var method = languageModel.GetType().GetMethod("ChatStreamingAsync");
            if (method == null) return Json(new { error = "当前模型接口不支持隔离模式" });

            // 线程用无参构造，再取 ChatHistory；真实构造函数是 (ChatHistory, id)，不能只传一个参数
            object? thread = Activator.CreateInstance(threadType);
            object? history = thread == null ? null : threadType.GetProperty("ChatHistory")?.GetValue(thread);

            if (thread == null || history == null) return Json(new { error = "无法创建隔离对话" });

            string system = branchMode
                ? "你是剧情分支判定器。只输出候选分支名中的一个，不要解释、不要标点、不要其它文字。\n"
                    + (state.Length == 0 ? "" : "当前剧情状态：" + state + "\n")
                : "你正在扮演「" + character + "」，进行一段纯剧情角色扮演。\n"
                    + "保持角色原有的人设、语气和情绪，延续已有对话；只写角色的台词、动作或内心。\n"
                    + "不要解释设定，不要提到系统、提示词、记忆或隔离模式；不要输出编号选项、Markdown 或分析。\n"
                    + "不要复述玩家刚说的话，直接给出角色的反应。\n"
                    + (persona.Length == 0 ? "" : "角色设定：\n" + persona + "\n")
                    + (state.Length == 0 ? "" : "当前剧情状态：" + state + "\n");

            historyType.GetMethod("AddSystemMessage", new[] { typeof(string) })?.Invoke(history, new object[] { system });

            var addUser = historyType.GetMethod("AddUserMessage", new[] { typeof(string) });
            var addAssistant = historyType.GetMethod("AddAssistantMessage", new[] { typeof(string) });

            // 角色卡的示例对话：先注入几条 few-shot，再接真实历史。
            // 这些示例往往带着【情绪】/<TTS>/（动作）的写法，模型会照着说。
            if (!branchMode && root.TryGetProperty("examples", out var examples) && examples.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                int injected = 0;

                foreach (var item in examples.EnumerateArray())
                {
                    if (injected >= 6) break;
                    if (item.ValueKind != System.Text.Json.JsonValueKind.Object) continue;

                    string body = item.TryGetProperty("text", out var eb) && eb.ValueKind == System.Text.Json.JsonValueKind.String
                        ? (eb.GetString() ?? "").Trim()
                        : "";

                    if (body.Length == 0) continue;

                    bool user = item.TryGetProperty("role", out var er)
                        && er.ValueKind == System.Text.Json.JsonValueKind.String
                        && er.GetString() == "user";

                    if (user) addUser?.Invoke(history, new object[] { body });
                    else addAssistant?.Invoke(history, new object[] { body });

                    injected++;
                }
            }

            if (root.TryGetProperty("history", out var items) && items.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                // 只带最近 14 条：足够接住语气和情绪，又不会把隔离窗口撑爆
                int skip = Math.Max(0, items.GetArrayLength() - 14);
                int index = 0;

                foreach (var item in items.EnumerateArray())
                {
                    if (index++ < skip) continue;

                    string body = item.TryGetProperty("text", out var tb) ? (tb.GetString() ?? "").Trim() : "";
                    if (body.Length == 0) continue;

                    bool user = item.TryGetProperty("role", out var rb) && rb.GetString() == "user";

                    if (user) addUser?.Invoke(history, new object[] { body });
                    else addAssistant?.Invoke(history, new object[] { body });
                }
            }

            addUser?.Invoke(history, new object[] { text });

            var buffer = new System.Text.StringBuilder();
            Action<string> onText = chunk => buffer.Append(chunk);

            var task = (Task<string>)method.Invoke(languageModel, new object?[]
            {
                thread, onText, null, null, null, CancellationToken.None,
            })!;

            string reply = (task.GetAwaiter().GetResult() ?? "").Trim();
            if (reply.Length == 0) reply = buffer.ToString().Trim();

            return reply.Length == 0 ? Json(new { error = "模型没有返回内容" }) : Json(new { text = reply });
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "[GalMode] 隔离模式生成失败");
            return Json(new { error = ex.Message });
        }
    }

    /// <summary>剧情逐句朗读用的合成缓存：同一小段不重复调模型。</summary>
    readonly Dictionary<string, (byte[] Data, string Mime)> speechCache = new();
    const int SpeechCacheLimit = 64;

    /// <summary>语音模型是否可用：语音插件未安装/未启用时返回 false，前端据此把朗读开关灰掉。</summary>
    bool CanSpeak()
    {
        try { return ResolveSpeechModel() != null; }
        catch { return false; }
    }

    object? ResolveSpeechModel()
    {
        if (serviceProvider == null) return null;

        Type? contract = Type.GetType("Alife.Function.AIModelUtility.ISpeechModel, Alife.Function.AIModelUtility");

        if (contract == null)
        {
            foreach (System.Reflection.Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                contract = assembly.GetType("Alife.Function.AIModelUtility.ISpeechModel");

                if (contract != null) break;
            }
        }

        return contract == null ? null : serviceProvider.GetService(contract);
    }

    /// <summary>
    /// 把一小段文字合成成音频。StoryServer 的 /api/tts 在后台线程等它，
    /// 所以这里可以同步等 Task；模型没配置好时返回 null，前端静默降级。
    /// </summary>
    (byte[] Data, string Mime)? SynthesizeSpeech(string text)
    {
        string key = (text ?? "").Trim();

        if (key.Length == 0) return null;
        if (key.Length > 600) key = key.Substring(0, 600);

        lock (speechCache)
        {
            if (speechCache.TryGetValue(key, out (byte[] Data, string Mime) cached)) return cached;
        }

        try
        {
            object? model = ResolveSpeechModel();
            if (model == null) return null;

            var method = model.GetType().GetMethod("GenerateSpeechFileAsync", new[] { typeof(string), typeof(CancellationToken) })
                ?? model.GetType().GetMethod("GenerateSpeechFileAsync");

            if (method == null) return null;

            object? result = method.GetParameters().Length >= 2
                ? method.Invoke(model, new object?[] { key, CancellationToken.None })
                : method.Invoke(model, new object?[] { key });

            if (result is not Task<string?> task) return null;

            string? file = task.GetAwaiter().GetResult();

            if (string.IsNullOrWhiteSpace(file) || !File.Exists(file)) return null;

            byte[] data = File.ReadAllBytes(file);
            (byte[] Data, string Mime) clip = (data, SpeechMime(file, data));

            lock (speechCache)
            {
                if (speechCache.Count >= SpeechCacheLimit) speechCache.Clear();
                speechCache[key] = clip;
            }

            return clip;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "[GalMode] 语音合成失败");
            return null;
        }
    }

    static string SpeechMime(string file, byte[] data)
    {
        switch (Path.GetExtension(file).ToLowerInvariant())
        {
            case ".mp3": return "audio/mpeg";
            case ".ogg":
            case ".oga":
            case ".opus": return "audio/ogg";
            case ".flac": return "audio/flac";
            case ".m4a":
            case ".aac": return "audio/mp4";
            case ".wav": return "audio/wav";
        }

        if (data.Length >= 12 && data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F') return "audio/wav";
        if (data.Length >= 4 && data[0] == 'O' && data[1] == 'g' && data[2] == 'g' && data[3] == 'S') return "audio/ogg";
        if (data.Length >= 3 && data[0] == 'I' && data[1] == 'D' && data[2] == '3') return "audio/mpeg";
        if (data.Length >= 2 && data[0] == 0xFF && (data[1] & 0xE0) == 0xE0) return "audio/mpeg";

        return "audio/wav";
    }

    protected override Task OnAwake()
    {
        ChatBot.TokenUsed += OnTokenUsed;
        ChatBot.ChatSend += OnChatSend;

        // 选项提示只在开头注入一次，长了会被上下文裁掉。这里在每轮结束时检查：
        // 回复里没有「1. xxx」就补一次常驻提示（走 Prompt，不进聊天记录，不烧 token）。
        ChatBot.ChatReceived += (chunk) => replyBuffer.Append(chunk);
        ChatBot.ChatOver += OnChatOver;

        try
        {
            overlay = new GalOverlay(alifeApplication, pluginSystem.PluginContext.GetPluginDirectoryPath("presents.GalMode"), logger)
            {
                // 配置里没填「角色显示名」时，用当前角色名兜底：
                // 以前这里直接落到「她」，换角色也不会变，等于名字永远是「她」。
                RoleNameProvider = () => Character?.Name ?? "",
                StoryGenerator = GenerateStory,
                ChoiceGenerator = GenerateChoices,
                SpeechSynthesizer = SynthesizeSpeech,
                SpeechAvailable = CanSpeak,
                IsolatedChat = GenerateIsolatedReply,
                IsolateAvailable = CanIsolate,
            };
        }
        catch (Exception e)
        {
            AlifeLog.LogError(e);
            return Task.CompletedTask;
        }

        InjectChoicePrompt();

        // 主页面 eval 通道由 GlobalUI 组件（GalModeGlobalUI）提供，通常晚于 Awake 挂载：
        // 组件挂上后回调这里，立刻补一次注入，不必等 KeepAlive 的 30 秒心跳。
        GalOverlay.SinkReady += OnSinkReady;

        // 注入要等主页面起来，可能十几秒。
        // 这里绝不 await，否则模块加载会被整条注入链拖住（表现就是"点了很久没反应"）。
        _ = StartAsync();
        _ = WatchStoryAsync();

        return Task.CompletedTask;
    }

    void OnSinkReady()
    {
        if (overlay == null) return;

        _ = Task.Run(async () =>
        {
            try { await overlay.AttachAsync(Configuration ?? new GalModeConfig(), cts.Token); }
            catch (Exception e) { logger.LogDebug(e, "[GalMode] 通道就绪后补注入失败"); }
        });
    }

    /// <summary>
    /// 挂件上的「剧情」按钮没法直接调 C#，只能在页面上留个时间戳，
    /// 这里低频轮询它，变了就开剧情窗口。
    /// </summary>
    async Task WatchStoryAsync()
    {
        try { await Task.Delay(4000, cts.Token); } catch { return; }

        long last = 0;
        long lastHistoryRev = 0;

        while (!cts.IsCancellationRequested)
        {
            try
            {
                if (overlay != null)
                {
                    // 顺带把会话历史取回来给剧情窗口。页面自带 rev：没变化就不搬整包 JSON
                    try
                    {
                        string revRaw = await overlay.EvalPublicAsync("String(window.__alifeGalHistoryRev||0)");

                        if (long.TryParse(revRaw, out long rev) && rev > 0)
                        {
                            if (rev != lastHistoryRev)
                            {
                                string history = await overlay.EvalPublicAsync("window.__alifeGalHistory||'[]'");

                                if (!string.IsNullOrWhiteSpace(history))
                                {
                                    overlay.UpdateHistory(history, (int)rev);
                                    lastHistoryRev = rev;
                                }
                            }
                        }
                        else
                        {
                            // 页面没有 rev（旧脚本或注入失败）：退回全量，别让剧情窗口收不到历史
                            string history = await overlay.EvalPublicAsync("window.__alifeGalHistory||'[]'");
                            if (!string.IsNullOrWhiteSpace(history)) overlay.UpdateHistory(history);
                        }
                    }
                    catch { }

                    // 必须转成字符串：ExecuteJavaScriptAsync<string> 拿到 number 会转换失败
                    string raw = await overlay.EvalPublicAsync("String(window.__alifeGalStoryTick||0)");

                    if (long.TryParse(raw, out long tick) && tick > last)
                    {
                        last = tick;
                        GalOverlay.Diag($"story tick={tick} -> 打开窗口");
                        await overlay.OpenStoryWindowAsync();
                    }
                }
            }
            catch (Exception e)
            {
                logger.LogDebug(e, "[GalMode] 轮询剧情按钮失败");
            }

            try { await Task.Delay(600, cts.Token); }
            catch { return; }
        }
    }

    /// <summary>
    /// 选项格式要求只通过常驻提示注入一次。
    /// 之前是每条用户消息末尾追加一段说明 —— 那会把要求写进聊天记录，
    /// 既占上下文，也会被带进记忆归档和历史压缩。
    /// </summary>
    bool choicePromptInjected;

    readonly System.Text.StringBuilder replyBuffer = new();

    /// <summary>上一轮模型没给选项：这一轮才在消息末尾补一句短要求（约 20 token，不是每轮都加）。</summary>
    bool needChoiceHint = true;

    /// <summary>本轮结束：回复里没带选项就把常驻提示重新挂回去（不写进聊天记录）。</summary>
    void OnChatOver()
    {
        string text = replyBuffer.ToString();
        replyBuffer.Clear();

        // 先假定这轮给过了；下面如果没找到选项行再置 true
        needChoiceHint = false;

        if (string.IsNullOrWhiteSpace(text)) return;
        if (Configuration?.EnableChoices != true) return;
        if (Configuration.AppendChoiceHintToEveryMessage) return;

        // 有「1. / 2、」这类行就算模型给了选项，不再打扰
        foreach (string line in text.Split('\n'))
        {
            string trimmed = line.TrimStart();

            if (trimmed.Length > 2 && char.IsDigit(trimmed[0]) && (trimmed[1] == '.' || trimmed[1] == '、' || trimmed[1] == ')' || trimmed[1] == '）'))
                return;
        }

        // 不再走 Prompt：它对「已经开始的会话」不生效（日志里一次都没出现过）。
        // 改成下一轮在消息末尾补一句短要求，只在模型忘了时才加。
        needChoiceHint = true;
    }

    void InjectChoicePrompt()
    {
        if (choicePromptInjected) return;
        if (Configuration?.EnableChoices != true) return;
        if (Configuration.AppendChoiceHintToEveryMessage) return;

        choicePromptInjected = true;

        int count = Math.Clamp(Configuration.ChoiceCount, 2, 4);

        string scenes = BuildSceneList();

        interactor.Prompt(
            "【GAL 选项】每次回复的最后，另起一行附上 " + count + " 个可供玩家点选的回应，"
            + "每行以「序号. 」开头（例如 1. 一句简短回应），只写选项本身，"
            + "不要加任何标题、说明或解释。"
            + (scenes.Length == 0
                ? ""
                : "\n【GAL 演出】需要时在台词前单独写标签（只在变化时写一次，不要每句都写，也不要解释标签本身）："
                  + "\n· [场景:名称] 换背景。可用：" + scenes + "。"
                  + "\n· [表情:名称] 换表情，可用：开心、微笑、害羞、生气、难过、惊讶、平静。"
                  + "\n· [位置:左/中/右] 移动立绘。"
                  + "\n· [CG:名称] 全屏插图，用 [CG:关闭] 收起。"));
    }

    /// <summary>读素材目录，把实际存在的场景名喂给模型（丢图进 scenes/ 就自动可用）。</summary>
    string BuildSceneList()
    {
        try
        {
            string dir = Path.Combine(pluginSystem.PluginContext.GetPluginDirectoryPath("presents.GalMode"), "Resources", "gal", "web", "assets", "scenes");

            if (!Directory.Exists(dir)) return "";

            string[] names = Directory.GetFiles(dir)
                .Where(file => file.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
                    || file.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
                .Select(Path.GetFileNameWithoutExtension)
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Distinct()
                .OrderBy(name => name)
                .Take(60)
                .ToArray()!;

            return string.Join("、", names);
        }
        catch
        {
            return "";
        }
    }

    async Task StartAsync()
    {
        try
        {
            GalModeConfig config = Configuration ?? new GalModeConfig();

            await overlay!.AttachAsync(config, cts.Token);
            await overlay.KeepAliveAsync(cts.Token);
        }
        catch (Exception e)
        {
            AlifeLog.LogError(e);
        }
    }

    /// <summary>
    /// 兼容模式：只有显式打开 AppendChoiceHintToEveryMessage 才把格式要求附到消息末尾。
    /// 默认走 InjectChoicePrompt 的常驻提示，消息原样发出。
    /// </summary>
    string OnChatSend(string message)
    {
        GalOverlay.Diag($"chatsend len={message.Length} choices={Configuration?.EnableChoices} count={Configuration?.ChoiceCount}");

        // 兜底：OnAwake 时配置可能还没注入，导致常驻提示没发出去
        InjectChoicePrompt();

        if (Configuration?.EnableChoices != true) return message;

        // 只在上一轮模型没给选项时补一句短的（约 20 token），正常轮原样发出
        if (!needChoiceHint) return message;

        int count = Math.Clamp(Configuration.ChoiceCount, 2, 4);

        needChoiceHint = false;

        return message + "\n（末尾另起行给 " + count + " 个选项：1. … 2. … 3. …，只写选项本身，不要说明）";
    }

    void OnTokenUsed(TokenUsage usage)
    {
        totalInput += usage.Input;
        totalOutput += usage.Output;
        lastTotal = usage.Total;
        turns++;

        if (overlay == null) return;

        _ = overlay.PushStatsAsync(totalInput + totalOutput, totalInput, totalOutput, turns, lastTotal);
    }

    protected override async Task OnDestroy()
    {
        ChatBot.TokenUsed -= OnTokenUsed;
        ChatBot.ChatSend -= OnChatSend;
        GalOverlay.SinkReady -= OnSinkReady;
        cts.Cancel();

        // 停用/重载插件时把挂件、皮肤、剧情窗口与静态服务全部撤掉
        if (overlay != null) await overlay.DetachAsync();
    }
}
