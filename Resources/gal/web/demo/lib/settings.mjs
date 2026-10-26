/**
 * 演出设置：一份扁平对象 + localStorage + 落到 CSS 变量。
 * 面板只改数字，apply() 统一写进 :root，样式自动跟着变。
 */

const KEY = 'gal-script:ux';

export const DEFAULTS = {
  /** 打字速度 1-100，越大越快 */
  speed: 62,
  /** 自动播放句尾停留（毫秒），长句会再多停一点 */
  autoDelay: 1200,
  /** 逐字音效 */
  typingSound: true,
  /** 逐字音量 0-100 */
  soundVolume: 45,
  /** 一键静音：BGM、语音、逐字音效全关，用来排查「一直有底噪」 */
  masterMute: false,
  /** 背景音乐音量 0-100，0 = 静音（不停止播放，重新拉回就响） */
  bgmVolume: 55,
  /** 逐句语音：只读当前显示的小段；没有语音模型时自动失效 */
  voiceOn: true,
  /** 旁白也读？默认连旁白一起读，嫌吵可以关掉只读对白 */
  voiceNarr: true,
  /** 语音音量 0-100 */
  voiceVolume: 100,
  /** 朗读语速：0.5 慢一倍，1 原速，1.5 偏快；变速不变调 */
  voiceRate: 1,
  /** 正文字号 px */
  fontSize: 18,
  /// 旁白单独的字号，0 = 跟正文一致
  narrSize: 0,
  /** 旁白透明度 30-100 */
  narrOpacity: 88,
  /** 对话框（花边框）不透明度 30-100，只影响框，不影响台词文字 */
  dialogueOpacity: 100,
  /** 自动播放：每句打完自动往下走 */
  autoPlay: false,
  /** 跳过已读：同一句第二次出现时直接显示，不再逐字 */
  skipRead: true,
  /** 强制关闭动画 */
  reduceMotion: false,
  /** 看到结局时自动把全文 TXT 存到本地，关掉 Alife 也还在 */
  autoExport: true,
  /** live 模式纯聊天：默认只演聊天内容，不插预设剧本；想跑剧本在设置里关掉 */
  chatOnly: true,
  /** 记忆隔离：live 对话不写进主聊天与 Alife 记忆，只在剧情窗口里留存 */
  isolation: false,
};

let settings = { ...DEFAULTS };

export function getSettings() {
  return settings;
}

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    settings = { ...DEFAULTS };

    for (const [name, fallback] of Object.entries(DEFAULTS)) {
      const value = saved[name];
      if (typeof value === typeof fallback && value !== null) settings[name] = value;
    }
  } catch {
    settings = { ...DEFAULTS };
  }

  return settings;
}

export function saveSettings(next = settings) {
  settings = { ...settings, ...next };
  localStorage.setItem(KEY, JSON.stringify(settings));
  applySettings();
  return settings;
}

export function applySettings() {
  const root = document.documentElement;
  const s = settings;

  root.style.setProperty('--gs-text-size', `${s.fontSize}px`);
  // 0 = 跟正文一致：直接取正文字号。写 inherit 会退到 body 的 16px，
  // 结果短句（对白）18px、长段（旁白）16px，看着就是「字多反而字小」。
  root.style.setProperty('--narr-size', `${s.narrSize > 0 ? s.narrSize : s.fontSize}px`);
  root.style.setProperty('--narr-opacity', String(Math.max(0.3, Math.min(1, s.narrOpacity / 100))));
  // 只淡花边框，台词文字不受影响
  root.style.setProperty('--dialogue-opacity', String(Math.max(0.3, Math.min(1, s.dialogueOpacity / 100))));
  document.body.classList.toggle('reduce-motion', Boolean(s.reduceMotion));
}

/** 浏览器层面的"减少动画"偏好也算进来 */
export function effectiveReduceMotion() {
  if (settings.reduceMotion) return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
