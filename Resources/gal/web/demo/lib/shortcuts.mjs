/**
 * 全局快捷键：一张表 + 严格修饰键匹配。
 *
 * 规矩（踩过的坑）：
 *  - 修饰键必须严格相等：绑了 Ctrl 的必须按 Ctrl，没绑的不许顺带按下。
 *  - 输入框、文本域、contenteditable 里只有 Esc 和带 Ctrl/Alt 的组合放行，
 *    否则打字时按 A 会触发自动播放。
 *  - 单键动作统一用 e.code 判断空格与回车，避免输入法/键盘布局差异。
 */

export const ACTIONS = {
  advance: { label: '推进 / 补全当前句', keys: 'Space / Enter' },
  auto: { label: '自动播放开关', keys: 'A' },
  fast: { label: '按住快进', keys: 'Ctrl（按住）' },
  hide: { label: '隐藏界面（再按恢复）', keys: 'H' },
  log: { label: '回看', keys: 'L / 滚轮上翻' },
  save: { label: '存档', keys: 'Ctrl + S' },
  load: { label: '读档', keys: 'Ctrl + O' },
  gallery: { label: '图鉴', keys: 'G' },
  vars: { label: '进度 / 变量面板', keys: 'V' },
  assets: { label: '导入素材', keys: 'Ctrl + D' },
  settings: { label: '设置', keys: 'Ctrl + ,' },
  sound: { label: '打字音效开关', keys: 'M' },
  help: { label: '快捷键说明', keys: '? / F1' },
  fullscreen: { label: '全屏', keys: 'F' },
  close: { label: '关闭面板', keys: 'Esc' },
};

const BINDINGS = [
  { action: 'advance', key: 'Space' },
  { action: 'advance', key: 'Enter' },
  { action: 'auto', key: 'a' },
  { action: 'hide', key: 'h' },
  { action: 'log', key: 'l' },
  { action: 'gallery', key: 'g' },
  { action: 'vars', key: 'v' },
  { action: 'sound', key: 'm' },
  { action: 'save', key: 's', ctrl: true },
  { action: 'load', key: 'o', ctrl: true },
  { action: 'settings', key: ',', ctrl: true },
  { action: 'assets', key: 'd', ctrl: true },
  { action: 'help', key: '?' },
  { action: 'help', key: 'F1' },
  { action: 'fullscreen', key: 'f' },
  { action: 'close', key: 'Escape' },
];

const normalize = (value) => (value.length === 1 ? value.toLowerCase() : value);

function matches(binding, event) {
  if (binding.ctrl && !(event.ctrlKey || event.metaKey)) return false;
  if (!binding.ctrl && (event.ctrlKey || event.metaKey)) return false;
  if (Boolean(binding.alt) !== event.altKey) return false;

  // '?' 本身就是 Shift + /，不能再要求 shift 状态一致
  const question = binding.key === '?' || event.key === '?';
  if (!question && Boolean(binding.shift) !== event.shiftKey) return false;

  // 空格用 code 判定：event.key 是 ' '，跨键盘布局更稳
  if (binding.key === 'Space') return event.code === 'Space';

  return normalize(event.key) === normalize(binding.key);
}

function isEditable(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * 绑定整套快捷键。
 * @param {(action: string, event: KeyboardEvent) => void} handler
 * @returns {() => void} 解绑函数
 */
export function bindShortcuts(handler) {
  const onKeyDown = (event) => {
    if (event.repeat) return;

    const binding = BINDINGS.find((item) => matches(item, event));
    if (!binding) return;

    const editable = isEditable(event.target);
    const modified = event.ctrlKey || event.metaKey || event.altKey;

    // 输入框里只放行 Esc 与带修饰键的组合
    if (editable && !modified && binding.action !== 'close') return;

    // Enter 在输入框里是"发送"，不能顺手当推进
    if (editable && binding.action === 'advance') return;

    // 焦点在按钮上时，空格/回车交给按钮自己的默认行为（选项、快捷键条）
    const active = document.activeElement;
    if (binding.action === 'advance' && active && active.tagName === 'BUTTON') return;

    event.preventDefault();
    handler(binding.action, event);
  };

  const onKeyUp = (event) => {
    if (event.key === 'Control' || event.key === 'Meta') handler('fast-end', event);
  };

  // 长按 Ctrl 快进：按下即进入快进，松开退出
  const onKeyDownFast = (event) => {
    if (event.repeat) return;
    if ((event.key === 'Control' || event.key === 'Meta') && !isEditable(event.target)) {
      handler('fast-start', event);
    }
  };

  document.addEventListener('keydown', onKeyDownFast);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  return () => {
    document.removeEventListener('keydown', onKeyDownFast);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
  };
}

/** 生成说明书用的表格数据 */
export function shortcutRows() {
  return Object.values(ACTIONS).map((item) => ({ label: item.label, keys: item.keys }));
}
