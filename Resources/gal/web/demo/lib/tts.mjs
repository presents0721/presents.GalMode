// 剧情逐句朗读：一次只合成/播放一小段，下一段提前取好。
// 语音模型由 C# 侧的 /api/tts 代理（Alife.Function.Speech 的 ISpeechModel），
// 没装语音插件时 /api/settings 会回 tts:false，这里就保持静默。

const CACHE_LIMIT = 48;

let available = false;
let volume = 1;
/** 朗读倍速：0.5 慢一倍，1 原速；Chromium 变速默认不变调 */
let rate = 1;
let audio = null;
let token = 0;
/** 正在等 /api/tts 的那几段（按 token 记，停口播时整体清掉） */
const inflight = new Set();
let resumeArmed = false;
let resumeHandler = null;

/** 文本 → 已合成好的 blob URL（LRU） */
const cache = new Map();
/** 文本 → 正在取音频的 Promise，避免同一段被并发请求两次 */
const pending = new Map();

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function clampRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.5, Math.min(2, n));
}

function ensureAudio() {
  if (audio) return audio;

  audio = new Audio();
  audio.preload = 'auto';
  audio.volume = volume;
  audio.playbackRate = rate;
  // 变速不变调，慢放不会变成低沉怪声
  audio.preservesPitch = true;
  audio.hidden = true;
  audio.dataset.galTts = '';
  document.body.appendChild(audio);

  return audio;
}

/** 设置里改音量/语速、或 /api/settings 回来时调用 */
export function configureTts(options = {}) {
  if (typeof options.available === 'boolean') available = options.available;
  if (options.volume != null) volume = clampVolume(options.volume);
  if (options.rate != null) rate = clampRate(options.rate);

  if (audio) {
    audio.volume = volume;
    audio.playbackRate = rate;
  }

  if (!available) stopSpeech();
}

export function ttsReady() {
  return available;
}

async function fetchClip(text) {
  if (!available) return null;

  const key = String(text ?? '').trim();
  if (!key) return null;

  if (cache.has(key)) {
    const url = cache.get(key);
    // 命中就挪到队尾，淘汰时先扔最久没用的
    cache.delete(key);
    cache.set(key, url);
    return url;
  }

  if (pending.has(key)) return pending.get(key);

  const task = (async () => {
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        body: key,
      });

      const type = response.headers.get('Content-Type') ?? '';

      // 没有语音模型 / 合成失败：静默关掉，别每段都弹错
      if (!response.ok || type.includes('application/json')) {
        available = false;
        return null;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      cache.set(key, url);

      if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        URL.revokeObjectURL(cache.get(oldest));
        cache.delete(oldest);
      }

      return url;
    } catch {
      return null;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, task);
  return task;
}

/** 浏览器拦自动播放：等玩家第一次点画面 / 按键时补播当前这一小段 */
function armPlayResume() {
  if (resumeArmed) return;

  resumeArmed = true;

  resumeHandler = () => {
    disarmResume();

    if (audio?.src && audio.paused) audio.play().catch(() => { });
  };

  document.addEventListener('pointerdown', resumeHandler, true);
  document.addEventListener('keydown', resumeHandler, true);
}

function disarmResume() {
  resumeArmed = false;

  if (!resumeHandler) return;

  document.removeEventListener('pointerdown', resumeHandler, true);
  document.removeEventListener('keydown', resumeHandler, true);
  resumeHandler = null;
}

/** 当前这一小段：停掉上一段，取到音频后立刻播 */
export function speak(text) {
  if (!available) return Promise.resolve();

  const key = String(text ?? '').trim();
  if (!key) return Promise.resolve();

  const mine = ++token;

  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }

  inflight.add(mine);

  return fetchClip(key)
    .then((url) => {
      inflight.delete(mine);

      if (!url || mine !== token) return;

      const node = ensureAudio();
      node.src = url;
      node.volume = volume;
      node.playbackRate = rate;
      node.currentTime = 0;
      node.play().catch(() => armPlayResume());
    })
    .catch(() => {
      inflight.delete(mine);
    });
}

/** 下一段提前合成：只进缓存，不影响当前播放 */
export function prefetch(text) {
  if (!available) return;

  const key = String(text ?? '').trim();
  if (key) void fetchClip(key);
}

export function stopSpeech() {
  token += 1;
  inflight.clear();
  disarmResume();

  if (!audio) return;

  audio.pause();
  audio.currentTime = 0;
  audio.removeAttribute('src');
  audio.load();
}

/** 自动播放用：还在播就等它播完 */
export function ttsState() {
  const playing = Boolean(audio && !audio.paused && !audio.ended);

  let remainingMs = 0;

  if (playing && Number.isFinite(audio.duration)) {
    // 倍速播放时实际等待时间要按倍速折算，否则自动推进算错
    remainingMs = Math.max(0, ((audio.duration - audio.currentTime) * 1000) / (rate || 1));
  }

  return { playing, pending: inflight.size > 0, remainingMs };
}
