using System;
using System.Threading.Tasks;
using Alife.Framework;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;
using Microsoft.JSInterop;

namespace presents.GalMode;

/// <summary>
/// 挂件宿主组件（Alife 5 官方 GlobalUI 通道）。
///
/// Alife 5 去掉了 Electron.NET，也不再提供「主窗口句柄 / 遍历窗口 / 在主窗口执行脚本」的 API，
/// 旧版 GalOverlay 的 FindWindowAsync + ExecuteJavaScript 无路可走。
/// 官方替代是 <see cref="ModuleAttribute.GlobalUI"/>：客户端 GlobalUIOverlay 按模块类型
/// 自动挂载/卸载本组件，组件里注入的 IJSRuntime 就是主页面的 JS 执行入口。
///
/// 组件自身不输出任何 DOM（BuildRenderTree 为空），只负责把 eval 能力交给
/// <see cref="GalOverlay"/>，视觉部分仍旧由 gal.css / gal.js 在页面里完成。
/// </summary>
public sealed class GalModeGlobalUI : ComponentBase, IDisposable
{
    [Inject] IJSRuntime JS { get; set; } = null!;

    /// <summary>缓存同一个委托：卸载时按引用注销，避免把别的实例的通道清掉。</summary>
    readonly Func<string, Task<string?>> sink;

    public GalModeGlobalUI() => sink = RunJsAsync;

    protected override void BuildRenderTree(RenderTreeBuilder b) { }

    protected override Task OnAfterRenderAsync(bool firstRender)
    {
        // 每次渲染后都登记一次：覆盖「组件先挂载、模块后 Awake」的时序，重复登记无害。
        // SetSink 会触发 SinkReady，让已 Awake 的模块立刻补一次注入。
        GalOverlay.SetSink(sink);
        return Task.CompletedTask;
    }

    /// <summary>主页面 eval。脚本末尾都补了字符串表达式，返回值不会是 undefined。</summary>
    async Task<string?> RunJsAsync(string script) => await JS.InvokeAsync<string>("eval", script);

    public void Dispose() => GalOverlay.ClearSink(sink);
}
