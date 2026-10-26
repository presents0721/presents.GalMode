using System;
using System.Threading;
using System.Windows.Forms;
using Alife.Foundation;

namespace presents.GalMode;

/// <summary>
/// 剧情窗口「—」隐藏后留在系统托盘的入口：左键单击 / 双击 / 右键菜单都能把窗口叫回来。
/// 宿主没给插件全局 WinForms 消息泵，所以在独立 STA 线程上跑 Application.Run 驱动托盘。
/// 只负责托盘图标本身，显示 / 关闭窗口的决策交给 <see cref="GalOverlay"/>。
/// </summary>
internal sealed class TrayIconHost : IDisposable
{
    readonly string title;
    readonly Action onShow;
    readonly Action onClose;
    readonly object gate = new();

    NotifyIcon? icon;
    SynchronizationContext? sync;   // 托盘 STA 线程的同步上下文：跨线程释放托盘时派发回去
    Thread? thread;
    bool disposed;

    public TrayIconHost(string title, Action onShow, Action onClose)
    {
        this.title = title;
        this.onShow = onShow;
        this.onClose = onClose;
    }

    /// <summary>显示托盘图标（重复调用无副作用）。</summary>
    public void Show()
    {
        lock (gate)
        {
            if (disposed || thread != null) return;

            var t = new Thread(RunSta)
            {
                IsBackground = true,
                Name = "GalModeTray",
            };
            t.SetApartmentState(ApartmentState.STA);
            thread = t;
            t.Start();
        }
    }

    void RunSta()
    {
        try
        {
            // 手动装 WinForms 同步上下文，便于别的线程把「收托盘」安全地派发回本 STA 线程
            var ws = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ws);
            sync = ws;

            var tray = new NotifyIcon
            {
                Icon = System.Drawing.SystemIcons.Application,
                Text = title,
                Visible = true,
            };

            var menu = new ContextMenuStrip();
            var showItem = new ToolStripMenuItem("显示剧情窗口");
            showItem.Click += (_, _) => Fire(onShow);
            var closeItem = new ToolStripMenuItem("关闭剧情窗口");
            closeItem.Click += (_, _) => Fire(onClose);
            menu.Items.Add(showItem);
            menu.Items.Add(closeItem);
            tray.ContextMenuStrip = menu;

            // 左键单击 / 双击都恢复窗口（不同人习惯不同）
            tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) Fire(onShow); };
            tray.DoubleClick += (_, _) => Fire(onShow);

            icon = tray;
            AlifeLog.LogInformation("[GalMode] 剧情窗口已隐藏到系统托盘，点托盘图标可恢复");
            Application.Run();   // 本 STA 线程的消息泵，支撑托盘菜单与鼠标事件
        }
        catch (Exception ex)
        {
            AlifeLog.LogWarning("[GalMode] 托盘图标创建失败（不影响剧情窗口本身）: " + ex.Message);
        }
    }

    static void Fire(Action action)
    {
        try { action(); }
        catch (Exception ex) { AlifeLog.LogWarning("[GalMode] 托盘操作失败: " + ex.Message); }
    }

    public void Dispose()
    {
        NotifyIcon? tray;
        SynchronizationContext? ctx;
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            tray = icon;
            icon = null;
            ctx = sync;
        }
        if (tray == null) return;

        if (ctx != null)
        {
            // NotifyIcon 没有 BeginInvoke：用其 STA 线程的同步上下文派发释放，再结束消息泵
            ctx.Post(_ =>
            {
                try { tray.Visible = false; tray.Dispose(); } catch { /* 忽略 */ }
                try { Application.Exit(); } catch { /* 忽略 */ }
            }, null);
        }
        else
        {
            try { tray.Visible = false; tray.Dispose(); } catch { /* 忽略 */ }
        }
    }
}
