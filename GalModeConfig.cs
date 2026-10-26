using System.ComponentModel;

namespace presents.GalMode;

/// <summary>GAL 模式的显示配置。</summary>
public sealed class GalModeConfig
{
    [DisplayName("显示小鲸鱼挂件")]
    [Description("左下角的悬浮挂件：显示本轮 / 累计 Token 消耗，并提供「GAL 皮肤」开关。关闭后界面完全恢复原样。")]
    public bool ShowWidget { get; set; } = true;

    [DisplayName("默认启用 GAL 皮肤")]
    [Description("套用 GAL 风格：衬线台词、对话气泡与输入框描边、消息区渐变底。可在挂件里随时一键关掉。")]
    public bool EnableSkinByDefault { get; set; } = true;

    [DisplayName("强调色")]
    [Description("GAL 皮肤的强调色，十六进制，例如 #7bd1ff。")]
    public string AccentColor { get; set; } = "#7bd1ff";

    [DisplayName("启用 GAL 选项")]
    [Description("每轮对话后让角色在末尾给出 2-3 个可选回应，以对话框下方的选项按钮呈现，点一下就能发送。关闭后按普通聊天进行。")]
    public bool EnableChoices { get; set; } = true;

    [DisplayName("选项个数")]
    [Description("每轮给出的可选回应数量，2-4 个。")]
    public int ChoiceCount { get; set; } = 3;

    [DisplayName("角色显示名")]
    [Description("剧情窗口对话框名牌上的名字。留空则自动使用当前角色名（换角色会跟着变）；只有取不到角色名时才退回「她」。")]
    public string CharacterName { get; set; } = "";

    [DisplayName("把选项要求写进每条消息")]
    [Description("默认关闭。关闭时通过常驻提示注入一次，不占聊天记录；打开后会把格式要求附在每次发送的消息末尾，"
        + "聊天记录里每条都会重复这段说明，既费 Token 也会干扰记忆归档与上下文压缩。仅当模型无视常驻提示时才需要打开。")]
    public bool AppendChoiceHintToEveryMessage { get; set; } = false;
}
