/**
 * 打字机：逐字淡入 + 标点停顿 + 可变速度。
 *
 * 和 LingChat 的 TypeWriter/charReveal 同源的思路，但这里去掉了对 store 的依赖：
 *  - 只追加新增字符的 span，绝不 innerHTML +=（重建节点会让整行动画重播）
 *  - generation 计数器作废旧循环，避免快速连点时的竞态
 *  - finish() 一定会 resolve 掉挂起的 play()，点击跳过不会留下悬空 Promise
 *
 * 速度是 1-100 的档位（越大越快），延迟按 200ms → 10ms 线性映射，
 * 再叠一点随机抖动，读起来不像机器。
 */

const MAX_DELAY = 200;
const MIN_DELAY = 10;

/** 标点后额外停顿（毫秒），让断句有呼吸感 */
const PUNCT_PAUSE = {
  '，': 90,
  '、': 70,
  '；': 110,
  '：': 90,
  ',': 70,
  ';': 90,
  '。': 240,
  '！': 220,
  '？': 220,
  '…': 260,
  '.': 180,
  '!': 200,
  '?': 200,
  '—': 150,
  '「': 60,
  '」': 60,
};

// ---------------------------------------------------------------- 点击音效

let audioCtx = null;
let soundOn = true;
/** 0-1，实际增益再乘一个基数 */
let soundVolume = 0.45;

/**
 * 用 WebAudio 合成一个很轻的"嗒"，省掉音频文件。
 * 噪声 + 极短包络比正弦更像键盘/笔尖。
 */
function click() {
  if (!soundOn || soundVolume <= 0) return;

  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }

    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    const length = Math.floor(audioCtx.sampleRate * 0.02);
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 1 + (Math.random() - 0.5) * 0.06;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1600 + Math.random() * 600;
    filter.Q.value = 1.2;

    const gain = audioCtx.createGain();
    // 音量 0 就是真静音；以前这里有个 0.015 的底，拉到 0 还是会沙沙响
    gain.gain.value = 0.14 * soundVolume;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    source.start(now);
  } catch {
    // 音效是可选的，任何失败都不能打断打字
  }
}

export function setTypingSound(enabled) {
  soundOn = Boolean(enabled);

  // 关掉音效时把 AudioContext 挂起：一直 running 会让某些声卡留一层底噪
  if (!soundOn) {
    try { audioCtx?.suspend(); } catch { }
    return;
  }

  if (audioCtx?.state === 'suspended') audioCtx.resume();
  else if (!audioCtx) click();
}

export function setTypingVolume(value) {
  soundVolume = Math.min(1, Math.max(0, Number(value) / 100));
}

// ---------------------------------------------------------------- 打字机

export class Typewriter {
  constructor(element, options = {}) {
    this.el = element;
    this.options = options;
    this.speed = 60;
    this.generation = 0;
    this.timer = null;
    this.full = '';
    this.index = 0;
    this.done = true;
    this.onDone = null;
  }

  setSpeed(speed) {
    const value = Number(speed);
    if (Number.isFinite(value)) this.speed = Math.min(100, Math.max(1, value));
  }

  /** 被打断的 play() 也会 resolve，调用方不会卡在 await 上 */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation += 1;
  }

  clear() {
    this.stop();
    this.full = '';
    this.index = 0;
    this.done = true;
    if (this.el) this.el.textContent = '';
  }

  /** 立刻显示全文（点击跳过 / 恢复历史） */
  finish() {
    this.stop();
    this.done = true;

    if (this.el && this.full) {
      this.el.textContent = this.full;
    }

    this.index = this.full.length;
    const done = this.onDone;
    this.onDone = null;
    done?.();

    return this.full;
  }

  /**
   * 打字。返回的 Promise 在自然打完或被 finish() 打断时都会 resolve。
   * @returns {Promise<void>}
   */
  play(text) {
    this.stop();
    this.generation += 1;

    const generation = this.generation;
    const full = String(text ?? '');
    const instant = this.options.reducedMotion?.() ?? false;

    this.full = full;
    this.index = 0;
    this.done = false;

    if (this.el) this.el.textContent = '';

    if (!full) {
      this.done = true;
      return Promise.resolve();
    }

    if (instant) {
      this.finish();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.onDone = resolve;

      const step = () => {
        if (this.generation !== generation) {
          resolve();
          return;
        }

        if (this.index >= this.full.length) {
          this.done = true;
          this.onDone = null;
          resolve();
          return;
        }

        const char = this.full.charAt(this.index);
        this.push(char);
        this.index += 1;

        if (this.options.onChar) click();

        if (this.index >= this.full.length) {
          this.done = true;
          this.onDone = null;
          resolve();
          return;
        }

        this.timer = setTimeout(step, this.delayFor(char));
      };

      step();
    });
  }

  /** 只追加新字符的 span，旧节点原样保留，动画不会重播 */
  push(char) {
    if (!this.el) return;

    if (char === '\n') {
      this.el.appendChild(document.createElement('br'));
      return;
    }

    const span = document.createElement('span');
    span.className = 'tw-char';
    span.textContent = char;
    this.el.appendChild(span);
  }

  delayFor(char) {
    const base = MAX_DELAY - ((this.speed - 1) / 99) * (MAX_DELAY - MIN_DELAY);
    const jitter = Math.random() * this.speed * 0.2;
    const pause = PUNCT_PAUSE[char] ? PUNCT_PAUSE[char] * (1 - this.speed / 160) : 0;

    return base + jitter + pause;
  }
}

/** 浏览器是否要求减少动画（无障碍 / 低电量模式） */
export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
