# presents.GalMode · GAL 模式

给 Alife 对话界面套上 GAL（视觉小说）皮肤：衬线台词、对话气泡与输入框描边、消息区渐变底，强调色可自定义。每轮对话结束后角色可在末尾给出 2~4 个可选回应，以对话框下方的选项按钮呈现，点一下就能发送。

左下角悬浮挂件（小鲸鱼）显示本轮 / 累计 Token 消耗，并提供「GAL 皮肤」一键开关；关闭后界面完全恢复原样。

## 安装

解压后目录名必须与插件 id 一致（`presents.GalMode`），放到 Alife 的 `Storage/Plugins/` 下，重启后由客户端自行编译加载。

## 版本

当前版本 **1.0.29**，发布包见 [Releases](https://github.com/presents0721/presents.GalMode/releases)。

## 源码

仓库结构即插件目录结构：`manifest.json` + `*.cs` + `Resources/`。运行时产生的 `out/`、`state.json` 等不进仓库（见 `.gitignore`）。
