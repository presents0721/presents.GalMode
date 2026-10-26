/**
 * 演示前端：只负责把引擎交出来的"帧"画成 Galgame 画面。
 * 所有剧情逻辑（分支、变量、结局）都在 src/ 里，这里不重复实现。
 */

import { StoryEngine } from '../src/index.mjs';
import { Typewriter, setTypingSound, setTypingVolume } from './lib/typewriter.mjs';
import { applySettings, effectiveReduceMotion, getSettings, loadSettings, saveSettings } from './lib/settings.mjs';
import { bindShortcuts, shortcutRows } from './lib/shortcuts.mjs';
import {
  backgroundVariations,
  characterVariations,
  clearAssets,
  entriesFromDataTransfer,
  entriesFromFileList,
  hasAssets,
  importEntries,
  library,
  loadLibrary,
  musicList,
  pickBackgroundUrl,
  pickCharacterUrl,
  pickMusicUrl,
  roleAliases,
  roleList,
  setPresetBackgrounds,
  setRoleAlias,
  stats,
} from './lib/assets.mjs';
import { configureTts, prefetch as prefetchSpeech, speak, stopSpeech, ttsReady, ttsState } from './lib/tts.mjs';

const $ = (id) => document.getElementById(id);

const SAVE_PREFIX = 'gal-script:save:';
const HOME_BG_KEY = 'gal-script:home-bg';
/** 手动存档位 */
const SLOTS = ['1', '2', '3'];
/** 自动存档 3 槽轮换：每章覆盖最旧的一格，坏档时还有前两章可退 */
const AUTO_SLOTS = ['auto1', 'auto2', 'auto3'];
const AUTO_RING_LIMIT = AUTO_SLOTS.length;

const EMOJI = {
  normal: '🙂',
  calm: '😌',
  smile: '😊',
  shy: '😳',
  pout: '😤',
  sad: '😢',
  angry: '😠',
  surprise: '😮',
  think: '🤔',
};

// 剧本里的场景名 → 插件素材目录里的图；找不到图时下面还有渐变兜底
const BACKGROUNDS = {
  '天台·黄昏': "url('../assets/scenes/天台_傍晚.jpg')",
  '天台·夜': "url('../assets/scenes/天台_夜晚.jpg')",
  '深海·夜': "url('../assets/scenes/神社_夜晚.jpg')",
  '楼道·夜': "url('../assets/scenes/后巷_夜晚.jpg')",
};

const els = {
  stage: $('stage'),
  bg: $('bg'),
  bgNext: $('bgNext'),
  weather: $('weather'),
  cast: $('cast'),
  cgLayer: $('cgLayer'),
  cgTitle: $('cgTitle'),
  chapter: $('chapter'),
  affection: $('affection'),
  affFill: $('affFill'),
  affNum: $('affNum'),
  dialogue: $('dialogue'),
  speaker: $('speaker'),
  speakerSub: $('speakerSub'),
  text: $('text'),
  nextDot: $('nextDot'),
  choices: $('choices'),
  inputbar: $('inputbar'),
  inputBox: $('inputBox'),
  freebar: $('freebar'),
  liveInput: $('liveInput'),
  liveText: $('liveText'),
  overlay: $('overlay'),
  panelTitle: $('panelTitle'),
  panelBody: $('panelBody'),
  embed: $('embed'),
  embedTitle: $('embedTitle'),
  embedFrame: $('embedFrame'),
  toast: $('toast'),
};

let story = null;
let report = null;
let engine = null;
let liveMode = false;
let liveLast = '';
let liveHistory = [];
/** 宿主历史版本号：轮询带上它，没变化时宿主直接回 204 */
let liveHistoryRev = 0;
/** 当前这条回复切出来的分句队列 / 说话人 / 尾部的选项 */
let liveQueue = [];
let liveRole = '她';
let liveOptions = [];
/** 已经消费过选项的那条 AI 消息（key），避免发完又补拉历史时重复弹出 */
let consumedKey = '';
/** 当前这条 AI 消息的选项是否已经被玩家点过（点过就再也不渲染） */
let optionsUsed = false;
/** 刚发完消息、正等回复：这段时间用最快频率轮询 */
let awaitingReply = false;
let awaitingAt = 0;
/** 回看里点了「重播」：这次演出不触发选项生成 */
let replaying = false;
/** 剧情状态：章节 / 轮次，跨窗口保留。live 模式的状态机雏形。 */
let liveState = { chapter: 1, turns: 0 };
/** 宿主是否支持记忆隔离（/api/chat）；不支持时设置里的开关灰掉 */
let liveCanIsolate = false;

/** 隔离模式的本地剧情记忆：不写主聊天，但重开窗口还能接上 */
const ISOLATE_KEY = 'gal-script:isolated-history';
const ISOLATE_LIMIT = 200;

function readIsolatedHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(ISOLATE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((item) => item && String(item.text ?? '').trim()) : [];
  } catch {
    return [];
  }
}

function saveIsolatedHistory(list) {
  try {
    localStorage.setItem(ISOLATE_KEY, JSON.stringify(list.slice(-ISOLATE_LIMIT)));
  } catch {
    // 存储满/被禁用时不影响本轮对话
  }
}

/** 隔离剧情全文：只有隔离模式自己的记录，不混入主聊天 */
function buildIsolatedTranscript() {
  const items = readIsolatedHistory();
  const now = new Date().toLocaleString('zh-CN');
  const body = [
    '《隔离剧情》',
    `角色：${liveRole || '她'}`,
    `导出时间：${now}`,
    '说明：这段对话只在剧情窗口留存，没有写入 Alife 主聊天与记忆。',
    '',
    '────────────',
    '',
  ];

  for (const item of items) {
    const text = String(item?.text ?? '').trim();
    if (!text) continue;

    body.push(`${item.name ?? (item.role === 'user' ? '你' : '她')}：${text}`, '');
  }

  return { title: liveScript?.name ?? '隔离剧情', text: body.join('\n').trim() + '\n' };
}

function loadLiveState() {
  try {
    const raw = JSON.parse(localStorage.getItem('gal:live-state') ?? 'null');
    if (raw && typeof raw.chapter === 'number') liveState = { chapter: raw.chapter, turns: Number(raw.turns) || 0 };
  } catch { }
}

function saveLiveState() {
  try { localStorage.setItem('gal:live-state', JSON.stringify(liveState)); } catch { }
}
/** 每 6 轮推进一章：没有剧本时的兜底骨架；有剧本就交给 chapter_end / 选项驱动 */
function bumpLiveState() {
  liveState.turns += 1;

  if (!liveScript && liveState.turns > 0 && liveState.turns % 6 === 0) {
    liveState.chapter += 1;
    showChapterBanner('第 ' + liveState.chapter + ' 章');
  }

  saveLiveState();
  updateStateLabel();
}

function updateStateLabel() {
  let node = document.getElementById('stateLabel');

  if (!node) {
    node = document.createElement('div');
    node.id = 'stateLabel';
    node.className = 'state-label';
    document.body.appendChild(node);
  }

  node.textContent = '第 ' + liveState.chapter + ' 章 · ' + liveState.turns + ' 轮';
}

loadLiveState();
/** 分段计数：多句时才显示 1/3 角标 */
let liveTotal = 0;
let liveShown = 0;
let livePendingKey = '';
/** 回传防抖：防止连点/双击把同一句发送多次 */
let lastSendAt = 0;
let lastSentText = '';
/** duration 协议的自动推进定时器：玩家抢先点击时要清掉，否则会连跳两句 */
let autoAdvanceTimer = null;

let autoOn = false;
let autoTimer = null;
let lastChapter = null;

let writer = null;
let typedSeq = 0;
let fast = false;
let uiHidden = false;

/** 推进前存一份引擎快照，回看里「回到这句」靠它回滚 */
let rollbacks = [];
let pendingSnapshot = null;

/** BGM 播放器状态：声明必须在 boot() 之前，否则启动早期会撞 TDZ */
let bgmAudio = null;
let bgmTrack = '';
let bgmUrl = '';
/** 换曲序列号：淡出途中又有新请求时，旧流程自动作废 */
let bgmSwitchId = 0;
/** 当前淡入淡出的动画号：新动画一开，旧动画立刻停 */
let bgmFadeId = 0;
let bgmResumeArmed = false;
/** 素材页试听的自动收尾计时器：试听别一直循环下去 */
let previewTimer = null;

// ------------------------------------------------------------------ 启动

/** 铭牌和副标题一起设：换句时不会残留上一句的副标题 */
function setSpeaker(name, subtitle = '') {
  els.speaker.textContent = name;

  const sub = String(subtitle ?? '').trim();
  els.speakerSub.textContent = sub;
  els.speakerSub.hidden = !sub;
}

boot().catch((error) => {
  els.dialogue.hidden = false;
  setSpeaker('加载失败');
  els.text.textContent = String(error?.message ?? error);
});

async function boot() {
  // 插件里打开时是 live 模式：不读剧本，直接演当前会话
  liveMode = new URLSearchParams(location.search).get('live') === '1';

  loadSettings();
  applySettings();
  mountTyping();
  bindUI();

  // 上次导入的自定义素材（Blob 存在 IndexedDB 里），先恢复再决定画什么
  await loadLibrary();
  await loadPresetBackgrounds();

  if (liveMode) {
    startLive();
    return;
  }

  const data = await loadStory();

  story = data.story;
  report = data.report ?? { ok: true, errorCount: 0, warnCount: 0, infoCount: 0, errors: [] };

  if (!report.ok) {
    console.warn('剧本校验未通过', report.errors);
    toast(`剧本有 ${report.errorCount} 个错误`);
  }

  newGame();
}

/**
 * 读取宿主 assets/scenes 下真实存在的预设背景文件名。
 * 剧本写「天台·夜」，文件叫「天台_夜晚.jpg」——没有清单就只能拼出一个 404 的地址。
 */
async function loadPresetBackgrounds() {
  try {
    const res = await fetch('/api/scenes', { cache: 'no-store' });
    if (!res.ok) return;

    const names = await res.json();
    setPresetBackgrounds(names);
  } catch {
    // 旧宿主没有这个接口时，退回原来的固定文件名
  }
}

// ------------------------------------------------------------------ 直播模式
// 主窗口把聊天记录塞进 /api/history，这里只负责「把最后一条演出来」。

/** 选项个数来自模块配置（2–4），不要写死 */
let liveChoiceCount = 3;
/** 最后一句台词：生成选项时作为上下文 */
let lastSpokenText = '';
/** 正在生成选项：防止连续点击触发多次模型调用 */
let choicesPending = false;
/** 段落序号：老段的看门狗要能被新段作废 */
let liveSegmentSeq = 0;
/** 已演过的句子：配合「跳过已读」直接整句显示 */
const seenLines = new Set();
const SEEN_KEY = 'gal:seen';
const SEEN_LIMIT = 2000;

// 已读要跨窗口保留：每次重开剧情窗口都从头再演一遍很烦
try {
  const saved = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');

  if (Array.isArray(saved)) saved.forEach((line) => { if (typeof line === 'string' && line) seenLines.add(line); });
} catch { }

function rememberSeen(text) {
  seenLines.add(text);

  // 只留最近的若干条，别让 localStorage 无限膨胀
  if (seenLines.size > SEEN_LIMIT) {
    const keep = [...seenLines].slice(-Math.floor(SEEN_LIMIT * 0.75));

    seenLines.clear();
    keep.forEach((line) => seenLines.add(line));
  }

  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seenLines])); } catch { }
}

async function fetchSettings() {
  try {
    const data = await fetch('/api/settings').then((response) => response.json());
    const count = Number(data?.choiceCount);
    if (count >= 2 && count <= 4) liveChoiceCount = count;

    // 宿主把「语音模型是否可用」一起带回来；没有就静默关掉逐句朗读
    configureTts({ available: data?.tts === true, volume: getSettings().voiceVolume / 100 });

    liveCanIsolate = data?.isolate === true;

    // 用户明确开了隔离、但当前版本没有 /api/chat：不能悄悄走回主聊天污染记忆
    if (getSettings().isolation && !liveCanIsolate) {
      saveSettings({ isolation: false });
      toast('当前版本不支持记忆隔离，已切回正常模式');
    }
  } catch {
    // 静态服务下没有这个接口，用默认 3，语音保持关闭
    configureTts({ available: false });
    liveCanIsolate = false;
  }
}

function startLive() {
  // 图鉴在 live 模式也能开：它按当前剧本统计，存档读档才真的用不上
  ['save', 'load'].forEach((act) => {
    const button = document.querySelector(`[data-act="${act}"]`);
    if (button) button.hidden = true;
  });

  // 直播模式没有固定角色名，名字牌只会悬在画面底部，藏掉
  document.body.classList.add('gal-live');

  document.title = '对话回放';

  // 模型这轮没写场景标签时，至少别留一片空渐变
  applyDefaultBackground();

  els.chapter.textContent = '此刻';
  els.affection.hidden = true;
  els.liveInput.hidden = false;

  const hotbar = document.getElementById('dlgHotbar');
  if (hotbar) hotbar.hidden = false;

  // 隔离模式读自己的本地剧情记忆；正常模式读主会话历史
  const kept = getSettings().isolation ? readIsolatedHistory() : [];

  if (kept.length) {
    liveHistory = kept;
    els.dialogue.hidden = false;
    setSpeaker('她');
    typeText('上次的隔离剧情还留着，直接说话就接上；点「回看」能看全文。');
  } else {
    // 历史为空时也要有对话框，否则窗口只剩一张背景图
    els.dialogue.hidden = false;
    setSpeaker('她');
    typeText(getSettings().isolation
      ? '隔离模式：这里的对话不会写进主聊天和 AI 记忆，直接开口就行。'
      : '还没有对话，先在主界面聊两句吧。');
  }

  renderLiveCast();

  fetchSettings();
  updateStateLabel();
  // 纯聊天模式不加载预设剧本：只演聊天内容，方便单独测语音
  if (!getSettings().chatOnly) loadLiveScript();

  pollLive();
  // pollLive 自己在 finally 里排下一次（自适应退避），不能再套 setInterval
}

/** live 模式：模型没写 [表情:x] 时按这句话的情绪挑差分，并延续上一次的表情 */
let liveEmotion = '';

// 一条一条往下排，先命中先用；词表只用素材里认得的规范名
const EMOTION_CUES = [
  ['害羞', /害羞|脸红|红透|耳根|别、?别看|才没有|笨蛋|baka|照れ|blush|embarrass/i],
  ['生气', /生气|恼火|愤怒|滚开|烦死|讨厌|可恶|angry|怒り|むか/i],
  ['难过', /难过|悲伤|泪|哭|对不起|寂寞|遗憾|sad|cry|悲しい|寂し/i],
  ['惊讶', /惊讶|吃惊|不会吧|竟然|居然|咦|诶\?|驚|えっ|surprise/i],
  ['噘嘴', /噘嘴|撅嘴|哼[。！!]|pout|むくれ/i],
  ['微笑', /微笑|笑|开心|高兴|太好了|喜欢|谢谢|哈哈|smile|happy|嬉し/i],
];

function guessLiveEmotion(text, narration) {
  const body = String(text ?? '');

  // 舞台指示（（她把伞收拢））不决定表情，沿用上一次
  if (narration) return liveEmotion || '普通';

  for (const [emotion, cue] of EMOTION_CUES) {
    if (cue.test(body)) {
      liveEmotion = emotion;
      return emotion;
    }
  }

  return liveEmotion || '普通';
}

const EMOTION_EMOJI = {
  普通: '🙂',
  平静: '😌',
  微笑: '😊',
  害羞: '😳',
  噘嘴: '😤',
  难过: '😢',
  生气: '😠',
  惊讶: '😮',
  思考: '🤔',
  皱眉: '😠',
  闭眼: '😌',
  张嘴: '😮',
};

function renderLiveCast(role = '她', emotion = '', clothes = '') {
  els.cast.innerHTML = '';

  const node = document.createElement('div');
  node.className = 'character';
  node.style.left = '80%';

  const figure = document.createElement('div');
  figure.className = 'figure';

  const art = pickCharacterUrl(role, [emotion].filter(Boolean), clothes);

  // 清空素材后要能退回内置立绘：留空串才会回到 CSS 里的 char.png
  figure.style.backgroundImage = art ? `url("${art}")` : '';
  if (!art) figure.textContent = EMOTION_EMOJI[emotion] ?? EMOJI[emotion] ?? EMOJI.normal;

  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.textContent = role;

  node.append(figure, tag);
  els.cast.appendChild(node);
}

/** 轮询间隔：有新消息时回到 1.5s，空闲时逐步退到 8s，减少无谓的整包传输 */
let pollDelay = 1500;
let pollTimer = null;
let pollBusy = false;

function schedulePoll(delay) {
  if (pollTimer) clearTimeout(pollTimer);
  pollDelay = delay;
  pollTimer = setTimeout(pollLive, delay);
}

/** 剧情窗口里也加载一份剧本：live 模式每轮先演剧本当前句，再接模型回复 */
let liveScript = null;
let liveEngine = null;
/** 玩家在主窗口聊天框里回的话也算剧本 input 的答复：记下已处理到哪一条 */
let liveUserKey = '';
let liveUserPrimed = false;

async function loadLiveScript() {
  try {
    const response = await fetch('../story.json');
    if (!response.ok) return;

    const data = await response.json();
    if (!data?.story) return;

    liveScript = data.story;
    liveEngine = new StoryEngine(liveScript);

    // 换剧本等于重开：把上一份剧本的演出进度全部清掉
    scriptChoiceKey = '';
    scriptInputKey = '';
    scriptFree = null;
    scriptFreeKey = '';
    scriptFreeHint = '';
    scriptAiHint = '';
    scriptEnded = false;
    liveUserPrimed = false;

    liveEngine.start();
    syncLiveChapter(null, { banner: false });

    // 剧本的开场舞台（背景/立绘/CG）先落一次，否则要等第一句台词才生效
    liveGallerySig = '';
    applyLiveStage();
  } catch {
    // 没有剧本也能正常聊天
  }
}

/** 切「纯聊天」：开着就把剧本演出全部卸掉，关掉再重新挂载 */
function applyChatOnly(on) {
  if (!liveMode) return;

  if (!on) {
    loadLiveScript();
    return;
  }

  liveScript = null;
  liveEngine = null;
  liveGallerySig = '';
  scriptChoiceKey = '';
  scriptInputKey = '';
  scriptFree = null;
  scriptFreeKey = '';
  scriptFreeHint = '';
  scriptAiHint = '';
  scriptEnded = false;

  // 剧本舞台的 BGM 也一起停，别留在后台响
  stopBgm();
  els.chapter.textContent = '此刻';
  updateStateLabel();
}

/** 剧本停在选项上时返回那一帧（不推进，等玩家点） */
function scriptChoiceFrame() {
  if (!liveEngine) return null;

  const frame = liveEngine.currentFrame?.() ?? null;

  if (!frame || frame.type !== 'choice' || !Array.isArray(frame.options)) return null;

  return frame;
}

/** 记录当前展示中的剧本选项，避免同一处反复渲染 */
let scriptChoiceKey = '';
/** input 事件只提示一次，避免每轮重复演同一句 */
let scriptInputKey = '';
/** free_dialogue：{ key, maxRounds, endLine, prompt, endPrompt, hint, turnsAt }，同一处只开一次 */
let scriptFree = null;
let scriptFreeKey = '';
/** free_dialogue 进行中的剧情提示：每轮都带给模型 */
let scriptFreeHint = '';
/** 一次性提示：ai_dialogue 的 prompt、free_dialogue 的 end_prompt，下一次生成用完就清 */
let scriptAiHint = '';
/** 剧本已走到结局：别再反复 next()，交给自由聊天 */
let scriptEnded = false;

/**
 * 剧本推进后章节可能已经换了（chapter_end.linear / 选项跳章）：
 * 把胶囊、横幅、localStorage 一起同步过来。
 */
function syncLiveChapter(before, opts = {}) {
  if (!liveEngine || liveEngine.chapterId === before) return;

  // chapters 的对象顺序取决于打包顺序，章节序号要以 chapterTitles 的书写顺序为准
  const titles = liveScript?.chapterTitles ?? null;
  const ids = Object.keys(titles && Object.keys(titles).length ? titles : (liveScript?.chapters ?? {}));
  const order = ids.indexOf(liveEngine.chapterId) + 1;
  const known = order > 0;
  const title = titles?.[liveEngine.chapterId] ?? '';

  if (known) liveState.chapter = order;

  // live 模式没有 render() 里的那套记录，图鉴路线图靠这里补
  markVisited(liveEngine.chapterId);

  saveLiveState();
  updateStateLabel();

  // 开窗时只是把位置对齐，别每次都弹一章横幅
  if (opts.banner !== false) {
    showChapterBanner(title || (known ? '第 ' + order + ' 章' : (els.chapter.textContent || '')));
  }
}

/** live 模式走到的结局也要进图鉴：live 模式没有剧本引擎，直接读写图鉴存档 */
function recordLiveEnding() {
  syncLiveGallery();
}

/** 上一次写盘的图鉴签名：内容没变就别反复写 localStorage */
let liveGallerySig = '';

/** 把剧本引擎在 live 模式解锁的 CG / 结局 / 成就合并进图鉴存档 */
function syncLiveGallery() {
  if (!liveEngine) return;

  const key = galleryKey(liveScript?.id ?? story?.id ?? 'story');
  const cg = [...(liveEngine.unlockedCG ?? [])];
  const endings = [...(liveEngine.endings ?? [])];
  const achievements = [...(liveEngine.achievements ?? [])];
  const sig = [key, cg.join(','), endings.join(','), achievements.join(',')].join('|');

  if (sig === liveGallerySig) return;

  liveGallerySig = sig;

  let saved = {};

  try { saved = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch { }

  // 和已有存档取并集：跨周目的收集不能被覆盖掉
  const next = {
    cg: [...new Set([...(Array.isArray(saved.cg) ? saved.cg : []), ...cg])],
    endings: [...new Set([...(Array.isArray(saved.endings) ? saved.endings : []), ...endings])],
    achievements: [...new Set([...(Array.isArray(saved.achievements) ? saved.achievements : []), ...achievements])],
  };

  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // 隐私模式下写不进去，不影响播放
  }
}

/** live 模式的剧本舞台：背景 / 天气 / CG / 台上角色 */
function applyLiveStage(opts = {}) {
  if (!liveMode || !liveEngine) return;

  // 可以传一份舞台快照：引擎 next() 会把后面的事件一起跑完，
  // 想按「当前这句台词」的舞台演，就得用取句之前的快照
  const stage = opts.stage ?? liveEngine.stage ?? {};

  applyStageBgm(stage);

  const cast = Array.isArray(stage.cast) ? stage.cast : [];

  // 模型这一句带了 [场景:xxx] 时，剧本没写背景才让模型说了算
  if (stage.background) applyLiveScene(stage.background, stage.backgroundTransition);

  els.weather.className = `weather${stage.effect === 'rain' ? ' on rain' : ''}`;

  if (stage.cg) {
    els.cgTitle.textContent = stage.cgTitle ?? stage.cg;
    els.cgLayer.classList.add('show');
  } else {
    els.cgLayer.classList.remove('show');
  }

  els.cast.classList.toggle('cg-on', Boolean(stage.cg));

  // 剧本写了台上角色就按剧本摆；没写时回退到模型驱动的单角色
  if (cast.length) renderLiveScriptCast(cast);
  else if (opts.role) renderLiveCast(opts.role, opts.emotion ?? '', opts.clothes ?? '');

  // CG / 成就是即时入库的，演到的这一刻就该能进图鉴
  syncLiveGallery();
}

/** 按剧本 stage.cast 摆多角色：位置、表情、服装都听剧本的 */
function renderLiveScriptCast(list) {
  els.cast.innerHTML = '';

  list.forEach((item, index) => {
    const character = liveScript?.characters?.[item.id] ?? {};
    const node = document.createElement('div');
    node.className = 'character';
    node.style.left = positionLeft(item.position, index, list.length);

    const figure = document.createElement('div');
    figure.className = 'figure';

    const art = pickCharacterUrl(
      character.name ?? item.id,
      [item.emotion].filter(Boolean),
      item.clothing ?? item.clothes ?? '',
    );

    figure.style.backgroundImage = art ? `url("${art}")` : '';
    if (!art) figure.textContent = EMOJI[item.emotion] ?? EMOJI.normal;

    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = character.name ?? item.id;

    node.append(figure, tag);
    els.cast.appendChild(node);
  });
}

/** 把玩家的一句话交给剧本的 input / allow_free 选项，让剧情继续往下走 */
function submitScriptInput(text) {
  if (!liveEngine || scriptEnded) return;

  const frame = liveEngine.currentFrame?.() ?? null;
  const canInput = frame?.type === 'input';
  const canFree = frame?.type === 'choice' && frame.allowFree === true;

  if (!canInput && !canFree) return;

  const before = liveEngine.chapterId;

  try {
    if (canInput) {
      liveEngine.submitInput(String(text ?? ''));
      scriptInputKey = '';
    } else {
      liveEngine.chooseFree(String(text ?? ''));
      scriptChoiceKey = '';
    }
  } catch (error) {
    console.warn('[gal] 剧本输入推进失败', error);
    return;
  }

  syncLiveChapter(before);
  applyLiveStage();
  if (els.liveText) els.liveText.placeholder = '说点什么…';
  armScriptFallback();
}

/** 点了剧本选项：推进剧本引擎 + 把这句话发给模型，让聊天跟着走 */
function pickScriptOption(index, text) {
  scriptChoiceKey = '';

  if (!liveEngine) {
    sendToHost(text);
    return;
  }

  const before = liveEngine.chapterId;

  try {
    liveEngine.choose(index);
  } catch (error) {
    console.warn('[gal] 剧本选项推进失败', error);
  }

  // 章节真的变了才更新状态与横幅（剧本的章节号按 chapters 里的顺序算）
  syncLiveChapter(before);
  applyLiveStage();
  armScriptFallback();

  sendToHost(text);
}

/** 当前这句剧本台词对应的舞台快照：引擎 next() 会跑完后续事件，不能直接读实时 stage */
let liveLineStage = null;
/** 这一句的显示名 / 副标题：在台词取出时一起留下，拼段时再贴回第一段 */
let liveLineMeta = null;

/** 取剧本当前可演的一句；遇到选项/章节尾就停住，交给外部 */
function takeScriptLine() {
  if (!liveEngine || scriptEnded) return null;

  liveLineStage = null;
  liveLineMeta = null;

  for (let guard = 0; guard < 40; guard += 1) {
    const frame = liveEngine.currentFrame?.() ?? null;

    if (!frame) return null;

    // 每轮先把舞台事件落一次：show_character / present_pic / background 这类
    // 不是台词的事件，正好在这一步生效，等下一句演出来时舞台已经对了
    applyLiveStage();

    if (frame.type === 'choice') return null;

    // ai_judged 章节尾：停一帧让模型判定，判定完再回来取下一句
    if (frame.type === 'branch') {
      resolveScriptBranch(frame);
      return null;
    }

    // 结局只演一次：把结局收进图鉴、亮出结局卡，之后停在原地让模型继续陪聊
    if (frame.type === 'end' || frame.type === 'ending') {
      scriptEnded = true;

      const ending = frame.ending ?? { title: '剧终' };

      recordLiveEnding();
      showEnding({ ...frame, ending }, { live: true });

      return null;
    }

    // free_dialogue：给一轮左右的自由聊天，聊够 max_rounds 再收尾。
    // 没写 max_rounds（0）时按「这一句自由发挥完就继续」处理，免得剧情卡死。
    if (frame.type === 'free') {
      const key = liveEngine.chapterId + ':' + liveEngine.index;

      if (key !== scriptFreeKey) {
        scriptFreeKey = key;
        scriptFree = {
          key,
          maxRounds: Number(frame.maxRounds) || 0,
          endLine: String(frame.endLine ?? '').trim(),
          prompt: String(frame.prompt ?? '').trim(),
          endPrompt: String(frame.endPrompt ?? '').trim(),
          turnsAt: liveState.turns,
        };
        // prompt 是整段自由对话都生效的剧情提示，每轮生成都带上
        scriptFreeHint = scriptFree.prompt;

        if (scriptFree.maxRounds > 0) toast(`自由对话：聊 ${scriptFree.maxRounds} 轮后继续`);
      }

      const limit = scriptFree?.maxRounds ?? 0;
      const spent = liveState.turns - (scriptFree?.turnsAt ?? liveState.turns);

      // 还没聊够：这一轮不加剧本台词，让模型自由发挥
      if (limit > 0 && spent < limit) return null;

      const endLine = scriptFree?.endLine ?? '';
      const endPrompt = scriptFree?.endPrompt ?? '';

      scriptFree = null;
      scriptFreeKey = '';
      scriptFreeHint = '';
      // 收尾提示只给下一句用一次
      if (endPrompt) scriptAiHint = endPrompt;
      liveEngine.endFreeDialogue();

      // end_line 是这段自由对话的收尾，演完再去取下一句
      if (endLine) return endLine;

      continue;
    }

    // ai_dialogue：这句该由模型说，占位旁白不能演出来；提示留给下一次生成
    if (frame.type === 'line' && frame.ai && frame.aiPlaceholder) {
      const prompt = String(frame.prompt ?? '').trim();
      const before = liveEngine.chapterId;

      if (prompt) scriptAiHint = prompt;

      liveEngine.next();
      syncLiveChapter(before);
      continue;
    }

    // 剧本要求玩家输入：把提示当一句旁白演一次，不推进
    if (frame.type === 'input') {
      const key = liveEngine.chapterId + ':' + liveEngine.index;

      if (key === scriptInputKey) return null;

      scriptInputKey = key;

      // input.hint 是给玩家的占位提示；没有就退回默认文案
      const hint = String(frame.hint ?? '').trim();
      if (els.liveText) els.liveText.placeholder = hint || '说点什么…';

      return String(frame.prompt ?? '').trim() || null;
    }

    if (frame.type === 'line' || frame.type === 'narration') {
      const text = String(frame.text ?? '').trim();
      const before = liveEngine.chapterId;
      // 先留住「这一句」的舞台：next() 会连带把后面的事件跑完
      const stage = {
        ...liveEngine.stage,
        cast: liveEngine.stage.cast.map((item) => ({ ...item })),
      };

      liveEngine.next();
      // chapter_end.linear 会在 next() 内部直接跳到下一章，这里必须同步
      syncLiveChapter(before);

      if (text) {
        liveLineStage = stage;
        liveLineMeta = {
          name: String(frame.speakerName ?? '').trim(),
          subtitle: String(frame.subtitle ?? '').trim(),
        };
        return text;
      }

      applyLiveStage();
      continue;
    }

    // 其余事件（立绘、背景）直接跳过
    const before = liveEngine.chapterId;

    liveEngine.next();
    syncLiveChapter(before);
  }

  return null;
}
/** 把剧本这一句的显示名/副标题贴到它的分段上；模型接话的段不受影响 */
function applyLineMeta(segments, meta, count = segments.length) {
  if (!meta) return;

  const name = String(meta.name ?? '').trim();
  const subtitle = String(meta.subtitle ?? '').trim();

  if (!name && !subtitle) return;

  const end = Math.min(count, segments.length);

  for (let i = 0; i < end; i += 1) {
    if (name) segments[i].name = name;
    if (subtitle) segments[i].subtitle = subtitle;
  }
}

/** ai_judged 分支：让模型只回一个候选名，再推进引擎 */
let scriptBranchKey = '';

async function resolveScriptBranch(frame) {
  if (!liveEngine) return;

  const key = `${liveEngine.chapterId}:${liveEngine.index}`;

  if (key === scriptBranchKey) return;
  scriptBranchKey = key;

  const options = Array.isArray(frame?.options) ? frame.options : [];
  const names = options.map((item) => String(item.name ?? '').trim()).filter(Boolean);
  const before = liveEngine.chapterId;

  if (!names.length) {
    try { liveEngine.chooseBranch(''); } catch (error) { console.warn('[gal] 分支推进失败', error); return; }

    syncLiveChapter(before);
    applyLiveStage();
    armScriptFallback(SCRIPT_BRANCH_GAP_MS);
    return;
  }

  const judge = String(frame?.prompt ?? '').trim();
  const question = [
    judge || '根据当前剧情判断该进入哪个分支。',
    `候选分支：${names.join(' / ')}`,
    '只回复其中一个分支名，不要解释。',
  ].join('\n');

  let picked = '';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        character: '剧情判定',
        state: liveStateSummary(),
        history: [],
        text: question,
        branch_mode: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const data = await response.json();
    const reply = String(data?.text ?? '').trim();

    picked = names.find((name) => reply.includes(name)) ?? '';
  } catch (error) {
    // 判定失败就按默认分支走，别把剧情卡死
    console.warn('[gal] 分支判定失败，按默认分支处理', error);
  }

  try {
    liveEngine.chooseBranch(picked);
  } catch (error) {
    console.warn('[gal] 分支推进失败', error);
    return;
  }

  syncLiveChapter(before);
  applyLiveStage();
  armScriptFallback(SCRIPT_BRANCH_GAP_MS);
}

async function pollLive() {
  if (pollBusy) return;

  // 隔离模式：不读主会话，避免把主聊天的回复混进剧情；本地历史由 sendIsolated 维护
  if (getSettings().isolation) {
    schedulePoll(1500);
    return;
  }

  pollBusy = true;
  let changed = false;

  try {
    const response = await fetch('/api/history' + (liveHistoryRev ? `?rev=${liveHistoryRev}` : ''));
    let list;

    if (response.status === 204) {
      // 宿主说「你手上这版还是最新的」：不能直接 return，
      // 否则上一轮标记为「等稳定」的新消息永远等不到第二次确认，剧情就停住了
      list = liveHistory;
    } else {
      list = await response.json();

      const rev = Number(response.headers.get('X-Gal-Rev') || 0);

      if (rev > 0) liveHistoryRev = rev;
    }

    if (!Array.isArray(list) || !list.length) return;

    liveHistory = list;

    // 玩家可能直接在主窗口聊天框里回话：轮询到新消息就当作剧本 input 的答复。
    // 必须放在找 AI 消息之前，否则玩家刚发完、模型还没回复时会被提前 return 掉。
    const tail = list[list.length - 1];

    if (!liveUserPrimed) {
      // 第一次轮询只记基线，别把历史上已经聊过的旧消息再喂给剧本
      liveUserPrimed = true;
      liveUserKey = tail?.role === 'user' ? String(tail.text ?? '') : '';
    } else if (tail?.role === 'user') {
      const body = String(tail.text ?? '');

      // 同一条消息每轮都会读到，靠这个键去重；AI 一回复就清键，
      // 这样玩家连发两句一模一样的「嗯」也能分别推进剧本
      if (body !== liveUserKey) {
        liveUserKey = body;
        submitScriptInput(body);
      }
    } else {
      liveUserKey = '';
    }

    // 只看最后一条 AI 消息：用户自己发的不用在窗口里重播
    const last = [...list].reverse().find((item) => item.role !== 'user');
    if (!last) return;

    const key = last.name + '|' + last.text.length + '|' + last.text.slice(-40);
    if (key === liveLast) return;

    // 流式输出时同一句会一轮轮变长：等它稳定一轮再开始演，否则每 1.5 秒从头重播
    if (key !== livePendingKey) {
      livePendingKey = key;
      return;
    }

    livePendingKey = '';
    liveLast = key;
    replaying = false;
    awaitingReply = false;
    consumedKey = '';
    optionsUsed = false;
    playLiveMessage(last);
    bumpLiveState();
    changed = true;
  } catch (error) {
    // 主窗口没开时接口是空的，忽略
  } finally {
    // 不管从哪条 return 出去都要排下一次，否则一次空结果就把轮询掐死了
    pollBusy = false;
    // 上限 5 秒：再长就会出现「发完消息干等」的观感
    if (awaitingReply && Date.now() - awaitingAt > 60000) awaitingReply = false;

    const fast = changed || awaitingReply;

    schedulePoll(fast ? 700 : Math.min(3000, Math.round(pollDelay * 1.5)));
  }
}

/**
 * 把模型一大段回复切成一句一段，标签跟着「它管的那一句」走。
 * 这样窗口才能一句一句点，而不是把几百字糊成一屏。
 */
const LIVE_TAG_RE = /\[\s*(场景|表情|情绪|位置|CG|服装)\s*[:：]\s*([^\]]*)\]/g;
const LIVE_SENTENCE_END = '。！？!?…；';
const LIVE_TRAILING = '。！？!?…."」』）)~～';
/** 单段太长就再切一刀：一次让 TTS 念几十秒，听起来就是「整段读」 */
const LIVE_SEGMENT_MAX = 90;

function splitLiveSegments(raw) {
  const text = String(raw ?? '')
    .replace(/\u0000/g, '')
    // 模型爱吐 Live2D 标签：<Speak>、<Expression option="开心"/>、<Motion option="摆手"/>，
    // 这些是给别的主机用的，窗口里必须清掉，否则整行 <...> 会直接显示出来
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/当前时间\s*[:：]?\s*\[[^\]]*\]/g, ' ')
    .replace(/\[\s*\d{4}-\d{2}-\d{2}[^\]]*\]/g, ' ')
    .replace(/\r\n?/g, '\n')
    // 只压空格，保留换行：模型经常用空行分段却不写句号
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const segments = [];
  const tags = {};
  let buffer = '';

  const flush = () => {
    const body = buffer.trim();

    // （她把伞收拢）这种舞台指示：不带说话人，按场景旁白演，并且自动过
    if (body) segments.push({ text: body, tags: { ...tags }, narration: /^[（(]/.test(body) });

    buffer = '';
  };

  let i = 0;

  while (i < text.length) {
    LIVE_TAG_RE.lastIndex = i;
    const match = LIVE_TAG_RE.exec(text);

    if (match && match.index === i) {
      // 标签只管后面那句话，所以先收掉前面已经完整的句子
      flush();
      tags[match[1]] = match[2].trim();
      i = LIVE_TAG_RE.lastIndex;
      continue;
    }

    const ch = text[i];

    // 换行也当断句：模型常用空行分段但不写句号
    if (ch === '\n') {
      flush();
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;

    // 英文句点也算断句，但别把 3.5 这种小数切开
    const asciiDot = ch === '.' && !(/\d/.test(text[i - 2] ?? '') && /\d/.test(text[i] ?? ''));

    if (LIVE_SENTENCE_END.includes(ch) || asciiDot) {
      // 连着的标点（「……」「？！」）算同一句
      while (i < text.length && LIVE_TRAILING.includes(text[i])) {
        buffer += text[i];
        i += 1;
      }

      flush();
    }
  }

  flush();

  // 纯标点的段（「……」「？！」）并进下一句，别让玩家单独点一屏省略号
  const merged = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (/^[…。！？!?；~～—\s]+$/.test(segment.text)) {
      if (i + 1 < segments.length) {
        segments[i + 1].text = segment.text + segments[i + 1].text;
        continue;
      }

      if (!merged.length) continue;
    }

    merged.push(segment);
  }

  // 没有标点的超长段再按逗号切：单段太长，TTS 会一口气念到底
  return merged.flatMap(splitLongSegment);
}

// ---------------------------------------------------------------- 模型三段协议

/** 情绪别名：模型常写口语词，先归一到素材认得的规范名 */
const PROTOCOL_EMOTION_ALIAS = {
  开心: '微笑', 高兴: '微笑', 愉快: '微笑', 笑: '微笑', 喜悦: '微笑',
  脸红: '害羞', 羞涩: '害羞', 不好意思: '害羞',
  伤心: '难过', 悲伤: '难过', 哭: '难过', 委屈: '难过',
  愤怒: '生气', 恼火: '生气', 不爽: '生气',
  吃惊: '惊讶', 震惊: '惊讶', 意外: '惊讶',
  嘟嘴: '噘嘴', 撅嘴: '噘嘴',
  平静: '普通', 中性: '普通',
};

/** 动作词 → 立绘上的小动画，没有对应动画就忽略（不念出来） */
const ACTION_ANIMATIONS = [
  ['act-nod', /点头|颔首|鞠躬|低头|摇头|叹气/],
  ['act-wave', /挥手|摆手|招手|伸手|举手/],
  ['act-hop', /跳|蹦|扑|弹起|弹了/],
  ['act-shake', /发抖|颤抖|哆嗦|打颤|颤|抖/],
  ['act-step', /后退|退后|转身|走开|靠近|上前|侧身/],
];
const ACTION_RE = /点头|颔首|鞠躬|低头|摇头|叹气|挥手|摆手|招手|伸手|举手|跳|蹦|扑|弹|发抖|颤抖|哆嗦|打颤|颤|抖|后退|退后|转身|走开|靠近|上前|侧身/;

/**
 * 解析模型的三段协议：【情绪】正文<TTS>朗读文本</TTS>（动作）
 * - 情绪 → 立绘差分
 * - <TTS> → 真正念出来的句子（正文照常显示）
 * - （动作）→ 立绘小动画（不念、不占屏）
 * 普通文本原样返回，不影响旧剧本。
 */
function parseAiProtocol(raw) {
  let rest = String(raw ?? '');
  let emotion = '';
  let tts = '';
  let action = '';

  // 【情绪】只认开头那一个，正文里的【】别误吃
  const emo = /^\s*【([^】]{1,10})】\s*/.exec(rest);

  if (emo) {
    const word = emo[1].trim();
    emotion = PROTOCOL_EMOTION_ALIAS[word] ?? word;
    rest = rest.slice(emo[0].length);
  }

  // <TTS> 里是朗读文本；正文仍按原样显示
  const ttsMatch = /<\s*TTS\s*>([\s\S]*?)<\s*\/\s*TTS\s*>/i.exec(rest);

  if (ttsMatch) {
    tts = ttsMatch[1].trim();
    rest = rest.replace(ttsMatch[0], ' ');
  }

  // 只收「动作类」的括号段，普通舞台指示（她把伞收拢）仍按旁白显示
  rest = rest.replace(/[（(]([^（）()]{1,24})[）)]/g, (all, inner) => {
    const body = inner.trim();

    if (!ACTION_RE.test(body)) return all;

    if (!action) action = body;
    return ' ';
  });

  return { text: rest.trim(), tts, emotion, action };
}

/** 把动作词落到立绘上：同一个动画重放时先摘掉再挂，避免不触发 */
function playLiveAction(action) {
  if (!action || getSettings().reduceMotion) return;

  const figure = els.cast?.querySelector('.character .figure');
  if (!figure) return;

  for (const [cls, re] of ACTION_ANIMATIONS) {
    if (!re.test(action)) continue;

    figure.classList.remove(...ACTION_ANIMATIONS.map(([name]) => name));
    void figure.offsetWidth;
    figure.classList.add(cls);

    setTimeout(() => figure.classList.remove(cls), 900);
    return;
  }
}

function splitLongSegment(segment) {
  if (segment.text.length <= LIVE_SEGMENT_MAX) return [segment];

  const parts = [];
  let rest = segment.text;

  while (rest.length > LIVE_SEGMENT_MAX) {
    let cut = -1;

    for (let i = 40; i < LIVE_SEGMENT_MAX; i += 1) {
      if ('，、；;,'.includes(rest[i])) cut = i;
    }

    if (cut < 0) cut = LIVE_SEGMENT_MAX - 1;

    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }

  if (rest) parts.push(rest);

  return parts.map((part) => ({ ...segment, text: part }));
}

const OPTION_LINE_RE = /^\s*(?:\d+|[A-Da-d])\s*[.、)]\s*(.+?)\s*$/;

/** 从整段文本尾部摘出「1. 选项」行；摘不到就原样返回 */
function extractTrailingOptions(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { text: '', options: [] };

  // 选项可能长这样：换行分隔、空格分隔，甚至和正文挤在一行。
  // 统一从尾部往前扫：只要末尾片段是「数字. 短句」就当选项切出来。
  const parts = text.split(/\s+(?=\d{1,2}\s*[.、)]\s*)/);
  const numbers = [];
  const options = [];

  while (parts.length > 1) {
    const match = parts[parts.length - 1].match(/^(\d{1,2})\s*[.、)]\s*([^\n]{1,30})$/);

    if (!match || !match[2]) break;

    numbers.unshift(Number(match[1]));
    options.unshift(match[2].trim());
    parts.pop();
  }

  // 只有「从 1 开始、连续编号、至少两条」才算选项：
  // 台词里随口一句「1. 先吃饭」不能被当成玩家的分支
  if (options.length < 2 || numbers.some((value, index) => value !== index + 1)) {
    return { text, options: [] };
  }

  return { text: parts.join(' ').trim(), options };
}

/** 模型把剧本那句原样复读时只留一份，避免同一句演两遍 */
function dropScriptEcho(reply, scriptLine) {
  const body = String(reply ?? '').trim();
  const script = String(scriptLine ?? '').trim();

  if (!body || !script) return body;
  if (body === script) return '';
  if (body.startsWith(script)) return body.slice(script.length).replace(/^[\s，。,.、!！?？~～]+/, '');

  return body;
}

/** 玩家答完剧本后，模型迟迟不回时别让剧情一起卡住：等这么久就先把剧本下一句演了 */
const SCRIPT_FALLBACK_MS = 15000;
/** 分支已经判定完：没有「等模型回复」这回事了，短等一下就接下一章 */
const SCRIPT_BRANCH_GAP_MS = 2500;
let scriptFallbackTimer = 0;

function clearScriptFallback() {
  if (!scriptFallbackTimer) return;

  clearTimeout(scriptFallbackTimer);
  scriptFallbackTimer = 0;
}

function armScriptFallback(delay = SCRIPT_FALLBACK_MS) {
  clearScriptFallback();

  if (!liveEngine || scriptEnded) return;

  scriptFallbackTimer = setTimeout(() => {
    scriptFallbackTimer = 0;

    // 玩家手上还有没读完的内容，就不插队；等这段演完再看一眼
    if (!liveEngine || scriptEnded) return;

    if (liveQueue.length) {
      armScriptFallback(delay);
      return;
    }

    const line = takeScriptLine();
    if (!line) return;

    liveOptions = [];
    liveQueue = splitLiveSegments(line);
    applyLineMeta(liveQueue, liveLineMeta);
    liveTotal = liveQueue.length;
    liveShown = 0;
    els.dialogue.hidden = false;
    els.choices.hidden = true;
    els.inputbar.hidden = true;
    els.freebar.hidden = true;
    els.speaker.classList.remove('narration-label');

    showLiveSegment();
  }, SCRIPT_FALLBACK_MS);
}

function playLiveMessage(message) {
  const raw = String(message.text ?? '');

  // 兜一层：占位气泡（输入中 / 思考中）不该被演出来
  if (/输入中|正在输入|思考中|生成中/.test(raw)) return;
  // 尾部如果是「1. xxx」这种选项行，先摘出去：
  // 主窗口那边的解析偶尔会因为格式差异拿不到，这里兜一层，保证选项不会凭空消失
  const parsed = extractTrailingOptions(raw);

  // 真回复来了，超时兜底就不必再补演
  clearScriptFallback();

  liveRole = message.name || (message.role === 'user' ? '你' : '她');

  // 剧本正停在选项/输入上时，模型自己编的选项一律不采用，剧本分支优先
  const scriptWaiting = Boolean(scriptChoiceFrame()) || (!scriptEnded && liveEngine?.currentFrame?.()?.type === 'input');

  liveOptions = scriptWaiting
    ? []
    : (Array.isArray(message.options) && message.options.filter(Boolean).length
      ? message.options.filter(Boolean)
      : parsed.options);

  // 模型回复可能带三段协议：【情绪】正文<TTS>朗读</TTS>（动作）
  // 显示用正文，朗读优先用 <TTS>，动作交给立绘
  const protocol = parseAiProtocol(parsed.text);
  const replyText = (protocol.text || protocol.tts || '').trim();

  // 剧本当前句 + 模型回复，一起进分段队列；模型复读剧本那句时只留一份
  const scriptLine = takeScriptLine();
  const scriptCount = scriptLine ? splitLiveSegments(scriptLine).length : 0;
  const replyLine = dropScriptEcho(replyText, scriptLine);
  liveQueue = splitLiveSegments((scriptLine ? scriptLine + ' ' : '') + replyLine);
  applyLineMeta(liveQueue, scriptLine ? liveLineMeta : null, scriptCount);

  // 情绪 / 朗读文本只落在模型回复的第一段上：剧本那句仍按剧本演出
  if (replyLine && (protocol.emotion || protocol.tts)) {
    const target = liveQueue[Math.min(scriptCount, liveQueue.length - 1)];

    if (target) {
      if (protocol.emotion) target.tags = { ...target.tags, 表情: protocol.emotion };
      if (protocol.tts) target.tts = protocol.tts;
    }
  }

  liveTotal = liveQueue.length;
  liveShown = 0;

  els.dialogue.hidden = false;
  els.choices.hidden = true;
  els.inputbar.hidden = true;
  els.freebar.hidden = true;

  els.speaker.classList.toggle('narration-label', message.role === 'user');
  els.text.style.color = '';
  els.text.style.fontStyle = 'normal';

  // 没有可用分段（只有标签 / 只有标点）时给个占位，别留空白框
  if (!liveQueue.length) liveQueue = [{ text: scriptLine || parsed.text || '……', tags: {} }];

  showLiveSegment();

  // 动作要在立绘渲染之后挂：applyLiveStage 可能会重建 cast，
  // 先挂到旧节点上等于白做
  playLiveAction(protocol.action);
}

/** 演下一句；队列空了才把选项放出来 */
/** 右下角「2/3」角标：单句不显示，多句时告诉玩家还有几句 */
function updateSegInfo() {
  let node = document.getElementById('segInfo');

  if (!node) {
    node = document.createElement('div');
    node.id = 'segInfo';
    node.className = 'seg-info';
    els.dialogue.appendChild(node);
  }

  const show = liveTotal > 1;
  node.hidden = !show;
  node.textContent = show ? `${liveShown}/${liveTotal}` : '';
}
function showLiveSegment() {
  const segment = liveQueue.shift();

  if (!segment) {
    finishLive();
    return;
  }

  applyLiveScene(segment.tags['场景']);
  const emotion = segment.tags['表情'] ?? segment.tags['情绪'] ?? guessLiveEmotion(segment.text, segment.narration);

  // 剧本有舞台就按剧本摆，没有才用模型给的表情/服装画单角色。
  // 用台词快照而不是实时 stage：引擎已经替我们把后面的演出事件跑完了
  applyLiveStage({ stage: liveLineStage ?? undefined, role: liveRole, emotion, clothes: segment.tags['服装'] ?? '' });
  setSpeaker(segment.name ?? (segment.narration ? '' : liveRole), segment.subtitle);
  els.speaker.classList.toggle('narration-label', Boolean(segment.narration));
  els.text.className = `text${segment.narration ? ' narr-scene' : ''}`;
  els.choices.hidden = true;

  liveShown += 1;
  updateSegInfo();

  typeOrSkip(segment.text);
  // 逐句朗读：这一小段先播，下一小段提前合成。
  // 模型给了 <TTS> 时念那份文本，但屏幕上仍显示正文
  const spoken = segment.tts || segment.text;
  narrateSegment(spoken, Boolean(segment.narration));
  prefetchSegment(liveQueue[0], Boolean(liveQueue[0]?.narration));

  if (!segment.narration) lastSpokenText = spoken;

  // 看门狗：这一句打完之后，如果后面没词了就进选项环节。
  // 不依赖 onTyped —— 自然打完时它不一定会回调。
  const seq = ++liveSegmentSeq;
  const began = Date.now();

  (function watchTyping() {
    if (seq !== liveSegmentSeq) return;

    // 用已显示的字数判断打完没有：writer.done 在自然打完时不一定会翻
    const shown = (els.text.textContent || '').length;

    if (shown < segment.text.length && Date.now() - began < 15000) {
      setTimeout(watchTyping, 150);
      return;
    }

    if (!liveQueue.length && els.choices.hidden && !choicesPending) {
      finishLive();
      return;
    }

    // 自动播放：还有下一句就按停留时间自己走，但等这一小段语音念完
    const cfg = getSettings();

    if (cfg.autoPlay && liveQueue.length) {
      const tick = () => {
        if (seq !== liveSegmentSeq || !getSettings().autoPlay || !liveQueue.length) return;

        const wait = voiceRemainingMs();

        if (wait > 0) {
          setTimeout(tick, Math.min(600, wait));
          return;
        }

        advance();
      };

      setTimeout(tick, Math.max(300, cfg.autoDelay));
    }
  })();

  // 舞台指示不需要玩家确认：演完停 1.2 秒自己往下走（同样等语音）
  if (segment.narration) {
    const tick = () => {
      if (seq !== liveSegmentSeq) return;

      const wait = voiceRemainingMs();

      if (wait > 0) {
        setTimeout(tick, Math.min(600, wait));
        return;
      }

      advance();
    };

    setTimeout(tick, 1200 + segment.text.length * 40);
  }
}

function renderLiveChoices(options, opts = {}) {
  els.choices.innerHTML = '';
  els.choices.hidden = !options.length;

  if (!options.length) return;

  // 选项出来就收声：别让上一句的朗读压住玩家做决定
  stopSpeech();

  const onPick = typeof opts.onPick === 'function' ? opts.onPick : null;

  options.forEach((text, index) => {
    const button = document.createElement('button');
    button.type = 'button';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(index + 1);

    const label = document.createElement('span');
    label.textContent = text;

    button.append(idx, label);
    button.addEventListener('click', () => {
      // 点完立刻收掉，等模型回复期间不允许再点
      els.choices.hidden = true;
      els.choices.querySelectorAll('button').forEach((node) => {
        node.disabled = true;
      });

      if (onPick) onPick(index, text);
      else sendToHost(text);
    });

    els.choices.appendChild(button);
  });

  // 剧本给出的选项是分支，不能自由发挥；模型选项才允许「自己写」
  if (opts.other === false) return;

  // 最后一格永远是「自己写」：模型给的选项不一定合用
  const other = document.createElement('button');
  other.type = 'button';
  other.className = 'other';

  const mark = document.createElement('span');
  mark.className = 'idx';
  mark.textContent = '✎';

  const tip = document.createElement('span');
  tip.textContent = '其他…（自己写）';

  other.append(mark, tip);
  other.addEventListener('click', () => {
    els.choices.hidden = true;
    els.liveText?.focus?.();
  });

  els.choices.appendChild(other);
}

async function finishLive() {
  // 剧本优先：引擎正停在选项上，就用剧本的分支，而不是让模型另起一套
  const frame = scriptChoiceFrame();

  if (frame) {
    const key = `${liveEngine.chapterId}:${liveEngine.index}`;

    if (key !== scriptChoiceKey || els.choices.hidden) {
      scriptChoiceKey = key;
      renderLiveChoices(
        frame.options.map((option) => option.text ?? '……'),
        { onPick: pickScriptOption, other: frame.allowFree === true },
      );
    }

    return;
  }

  // 剧本停在 input 上：这句必须玩家自己说，模型选项不能替玩家做决定
  if (!scriptEnded && liveEngine?.currentFrame?.()?.type === 'input') return;

  // 章节尾等模型判定分支：判定完会自己接下一句，这里别去生成选项
  if (!scriptEnded && liveEngine?.currentFrame?.()?.type === 'branch') {
    resolveScriptBranch(liveEngine.currentFrame());
    return;
  }

  // 剧本已经走到结局：把结局卡亮出来（takeScriptLine 内部只亮一次）
  if (!scriptEnded && liveEngine?.currentFrame?.()?.type === 'end') {
    takeScriptLine();
    return;
  }

  if (liveOptions.length) {
    renderLiveChoices(liveOptions);
    return;
  }

  if (choicesPending) return;

  // 这道守卫有两层：只要当前这条消息的选项已经被点过，就不许再补拉/渲染。
  // 用 === 比较 liveLast 之外，再加一个布尔闸，防止 key 因名字变化而错配。
  if (optionsUsed) return;
  if (consumedKey && consumedKey === liveLast) return;

  const scene = (lastSpokenText || '').trim();
  if (!scene) return;

  // 选项可能在开始演之后才渲染出来：演完先补拉一次历史
  if (!liveOptions.length) {
    try {
      const list = await fetch('/api/history').then((response) => response.json());
      const latest = Array.isArray(list) ? [...list].reverse().find((item) => item.role !== 'user') : null;
      const fresh = Array.isArray(latest?.options) ? latest.options.filter(Boolean) : [];

      if (fresh.length) {
        liveOptions = fresh;
        renderLiveChoices(fresh.slice(0, liveChoiceCount));
        return;
      }
    } catch {
      // 接口不可用时继续往下走生成
    }
  }

  choicesPending = true;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const context = '【当前第' + liveState.chapter + '章，已进行' + liveState.turns + '轮】\n' + scene;

    const response = await fetch('/api/choices', { method: 'POST', body: context, signal: controller.signal });

    clearTimeout(timer);
    const list = await response.json();

    if (Array.isArray(list) && list.length) {
      renderLiveChoices(list.slice(0, liveChoiceCount));
      return;
    }
  } catch {
    // 没有插件接口（静态打开）或模型失败
  } finally {
    choicesPending = false;
  }

  toast('这次没生成出选项，直接在下面输入也可以');
}

// 窗口里发的消息：默认塞回主窗口聊天框；隔离模式下直接让插件演下一句
async function sendToHost(text) {
  const now = Date.now();

  if (now - lastSendAt < 1500 || (text === lastSentText && now - lastSendAt < 5000)) {
    toast('刚刚发过了，稍等一下');
    return;
  }

  lastSendAt = now;
  lastSentText = text;

  // 剧本停在 input 事件上时，把玩家这句话也喂回引擎，否则剧情永远卡在那一步
  submitScriptInput(text);

  els.choices.hidden = true;
  if (els.liveText) els.liveText.value = '';

  // 先把玩家这句演出来，同时清掉旧选项，免得被重复点
  liveOptions = [];
  optionsUsed = true;
  consumedKey = liveLast;
  setSpeaker('你');
  els.speaker.classList.add('narration-label');
  els.text.className = 'text';
  typeText(text);

  if (getSettings().isolation) {
    await sendIsolated(text);
    return;
  }

  // 刚发完消息，把轮询拉回最快一档，别让退避拖住回复
  awaitingReply = true;
  awaitingAt = Date.now();
  schedulePoll(700);

  try {
    await fetch('/api/send', { method: 'POST', body: text });
  } catch (error) {
    toast('发送失败');
  }
}

/** 给隔离模式的状态摘要：让模型知道好感度、章节和场景，但不读主会话记忆 */
function liveStateSummary() {
  const bits = [`第 ${liveState.chapter} 章`, `已进行 ${liveState.turns} 轮`];
  const vars = liveEngine?.vars ?? {};

  if (typeof vars.affection === 'number') bits.push(`好感度 ${vars.affection}`);

  if (liveEngine?.chapterId) {
    const title = liveScript?.chapterTitles?.[liveEngine.chapterId] ?? liveEngine.chapterId;
    bits.push(`章节 ${title}`);
  }

  const scene = liveLineStage?.background ?? liveEngine?.stage?.background;
  if (scene) bits.push(`场景 ${scene}`);

  // 剧本里的 prompt 就是给模型看的下一句提示，不显示成台词
  if (scriptFreeHint) bits.push(`剧情提示：${scriptFreeHint}`);
  if (scriptAiHint) bits.push(`接下来：${scriptAiHint}`);

  return bits.join('；');
}

/**
 * 当前说话人的角色卡：角色卡是 story_config 的 characters，
 * 隔离模式要把人设、示例对话和声线一起带给宿主。
 */
function liveCharacterCard() {
  const book = liveScript?.characters ?? {};
  const entries = Object.entries(book);

  if (!entries.length) return null;

  const role = String(liveRole ?? '').trim();
  const player = String(liveScript?.playerName ?? '你');

  const hit = entries.find(([id, card]) => (card?.name ?? id) === role)
    ?? entries.find(([id]) => id === role);

  if (hit) return { id: hit[0], ...hit[1] };

  // 名字对不上时取第一个非玩家角色：live 模式下台上通常只有一个 NPC
  const npc = entries.find(([id, card]) => (card?.name ?? id) !== player);

  return npc ? { id: npc[0], ...npc[1] } : null;
}

/**
 * 角色卡示例对话统一成 [{role, text}]：
 * - 纯字符串数组按「玩家 / 角色」交替
 * - 对象接受 { role, text } 或 { role, content }
 */
function normalizeExamples(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];

  for (const item of list) {
    if (typeof item === 'string') {
      const text = item.trim();

      if (text) out.push({ role: out.length % 2 === 0 ? 'user' : 'assistant', text });
      continue;
    }

    if (!item || typeof item !== 'object') continue;

    const text = String(item.text ?? item.content ?? '').trim();
    if (!text) continue;

    const role = String(item.role ?? '').trim().toLowerCase() === 'user' ? 'user' : 'assistant';
    out.push({ role, text });
  }

  // few-shot 太多会把隔离窗口挤满，最多带 6 条
  return out.slice(0, 6);
}

/** 隔离模式：请求插件直接生成下一句，不写主聊天，也不进 Alife 的记忆归档 */
async function sendIsolated(text) {
  liveHistory = [...liveHistory, { role: 'user', name: '你', text }];
  saveIsolatedHistory(liveHistory);

  const card = liveCharacterCard();
  const body = {
    character: String(card?.name ?? liveRole ?? '') || '她',
    state: liveStateSummary(),
    // 当前这句单独发，历史里不重复带它
    history: liveHistory.slice(-15, -1).map((item) => ({
      role: item.role === 'user' ? 'user' : 'assistant',
      text: String(item.text ?? ''),
    })),
    text,
  };

  // 角色卡字段按需带：没写就不占请求体
  if (card) {
    const systemPrompt = String(card.system_prompt ?? card.systemPrompt ?? '').trim();
    const examples = normalizeExamples(card.examples ?? card.example_dialogue ?? card.exampleDialogue);
    const voiceModel = String(card.voice_model ?? card.voiceModel ?? '').trim();

    if (systemPrompt) body.system_prompt = systemPrompt;
    if (examples.length) body.examples = examples;
    if (voiceModel) body.voice_model = voiceModel;
  }

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    const reply = String(data?.text ?? '').trim();

    if (!reply) throw new Error(data?.error || '模型没有回复');

    // 一次性提示已经用掉了，下轮别重复塞给模型
    scriptAiHint = '';

    const item = { role: 'assistant', name: liveRole || '她', text: reply };
    liveHistory = [...liveHistory, item];
    saveIsolatedHistory(liveHistory);

    awaitingReply = false;
    liveLast = '';
    livePendingKey = '';
    consumedKey = '';
    optionsUsed = false;
    playLiveMessage(item);
    bumpLiveState();
  } catch (error) {
    toast('隔离模式生成失败：' + (error?.message || '接口不可用'));
  }
}

/** 切回正常模式时，把轮询基线对齐到主会话最后一条，避免旧话又被演一遍 */
async function resetLiveBaseline() {
  try {
    const list = await fetch('/api/history').then((response) => response.json());
    const last = Array.isArray(list) ? [...list].reverse().find((item) => item.role !== 'user') : null;

    liveLast = last ? last.name + '|' + last.text.length + '|' + last.text.slice(-40) : '';
    livePendingKey = '';
  } catch {
    liveLast = '';
    livePendingKey = '';
  }
}

// 花边框底部那排按钮：图是死的，功能靠这层热区接
function handleHot(action) {
  if (action === 'skip') {
    finishTyping();
    return;
  }

  if (action === 'hide') {
    toggleUiHidden();
    return;
  }

  if (action === 'sound') {
    toggleSound();
    return;
  }

  if (action === 'auto') {
    if (liveMode) {
      toast('窗口会自动跟随最新一条');
      return;
    }

    toggleAuto(null);
    return;
  }

  if (action === 'help') {
    openPanel('help');
    return;
  }

  if (action === 'settings' || action === 'config') {
    openPanel('settings');
    return;
  }

  if (action === 'assets') {
    openPanel('assets');
    return;
  }

  if (action === 'editor') {
    // 试玩层（iframe 里的剧情页）不再往下套编辑器
    if (window.self !== window.top) {
      toast('试玩窗口里先点「← 返回剧情」再改稿');
      return;
    }

    // 编辑器就铺在剧情窗口里：window.open 弹出的独立窗口一关，宿主会以为主窗口被关
    openEmbed('../editor/?v=' + encodeURIComponent(window.__alifeGalVer || Date.now()));
    return;
  }

  if (liveMode) {
    if (action === 'log') showLiveLog();
    else toast('存档 / 读档 / 图鉴请在主界面操作');
    return;
  }

  if (action === 'log') {
    openPanel('log');
    return;
  }

  if (action === 'save') {
    openPanel('save');
    return;
  }

  if (action === 'load') {
    openPanel('load');
    return;
  }

  if (action === 'gallery') {
    openPanel('gallery');
    return;
  }

  if (action === 'vars') {
    openPanel('vars');
  }
}

function toggleSound() {
  const s = getSettings();
  const on = !s.typingSound;

  saveSettings({ typingSound: on });
  applyTypingSettings();
  toast(on ? '打字音效：开' : '打字音效：关');
}

function toggleUiHidden(force) {
  uiHidden = typeof force === 'boolean' ? force : !uiHidden;

  document.body.classList.toggle('ui-hidden', uiHidden);
  document.getElementById('uxBar')?.classList.toggle('dim', uiHidden);

  if (uiHidden) toast('点一下画面 / 右键 / H 恢复');
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    return;
  }

  document.documentElement.requestFullscreen?.().catch(() => toast('当前环境不允许全屏'));
}

/** 回看面板里要抹掉的东西：时间戳、插件注入的括号提示、模型吐的 XML 标签 */
function cleanHistoryText(raw) {
  return String(raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/当前时间\s*[:：]?\s*\[[^\]]*\]/g, ' ')
    .replace(/\[\s*\d{4}-\d{2}-\d{2}[^\]]*\]/g, ' ')
    .replace(/\[当前时间[:：]?[^\]]*\]/g, ' ')
    .replace(/[（(][^）)]*(选项|禁用旁白|对话输出|emoji|表情|规范)[^）)]*[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function showLiveLog() {
  els.panelTitle.textContent = '回看';
  els.panelBody.innerHTML = '';

  if (!liveHistory.length) {
    els.panelBody.textContent = '还没有对话。';
    els.overlay.hidden = false;
    return;
  }

  // 流式输出会在历史里留下「同一句的更短版本」：只保留最长的那个，否则回看里全是重复
  const merged = [];

  for (const message of liveHistory) {
    const prev = merged[merged.length - 1];

    if (prev && message.role !== 'user' && prev.role !== 'user' && String(message.text || '').startsWith(String(prev.text || '').slice(0, 12))) {
      if (String(message.text || '').length > String(prev.text || '').length) merged[merged.length - 1] = message;
      continue;
    }

    merged.push(message);
  }

  merged.slice(-40).forEach((message) => {
    const row = document.createElement('div');
    row.className = 'log-item';

    const name = document.createElement('b');
    const rawName = (message.name || '').trim();
    name.textContent = message.role === 'user' ? '你' : (rawName && rawName !== '无限制' ? rawName : (liveRole || '她'));

    row.appendChild(name);
    // 和对话框一致：AI 的话按句拆行，玩家的话保持一条
    const segments = message.role === 'user'
      ? [cleanHistoryText(message.text)]
      : splitLiveSegments(message.text).map((part) => part.text);

    if (!segments.length) segments.push(cleanHistoryText(message.text));

    for (const segment of segments) {
      if (!segment) continue;

      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = segment;
      row.appendChild(line);
    }

    // 回看里每条 AI 台词都能单独重播一次（只影响窗口，不动主会话）
    if (message.role !== 'user') {
      const replay = document.createElement('button');
      replay.type = 'button';
      replay.className = 'replay-btn';
      replay.textContent = '重播';
      replay.addEventListener('click', () => {
        replaying = true;
        closePanel();
        playLiveMessage(message);
      });
      row.appendChild(replay);
    }
    els.panelBody.appendChild(row);
  });

  els.overlay.hidden = false;
}

function readLiveTags(raw) {
  const tags = {};
  const re = /\[\s*(场景|表情|情绪|位置|CG|服装)\s*[:：]\s*([^\]]+?)\s*\]/g;
  let match;

  while ((match = re.exec(raw))) tags[match[1]] = match[2];

  return tags;
}

/** 常驻背景：live 开场 / 剧本没写场景 / 模型没给场景时用它；导入了同名背景就换成自己的 */
function readHomeBg() {
  try { return localStorage.getItem(HOME_BG_KEY) ?? ''; } catch { return ''; }
}

function setHomeBg(name) {
  try {
    if (name) localStorage.setItem(HOME_BG_KEY, name);
    else localStorage.removeItem(HOME_BG_KEY);
  } catch { }
}

function applyDefaultBackground() {
  const home = readHomeBg();
  const custom = home ? pickBackgroundUrl(home) : '';

  // 手改过背景就不再算「某个场景」，下次进剧情要正常换过去
  delete els.bg.dataset.scene;

  // 选过常驻背景且这张图还在库里：直接铺它
  if (custom) {
    els.bg.style.backgroundImage = `url("${custom}")`;
    return;
  }

  const preset = pickBackgroundUrl('卧室_夜晚');

  els.bg.style.backgroundImage = preset
    ? `url("${preset}")`
    : "url('../assets/scenes/卧室_夜晚.jpg')";
}

/** 换背景；transition 是毫秒，0 表示直接切 */
let sceneFadeTimer = 0;

function applyLiveScene(name, transition = 0) {
  if (!name) return;

  const url = pickBackgroundUrl(name);

  // 预设和导入素材都没匹配上时保留当前画面，别把背景换成一个 404 的破链接
  if (!url) return;

  // 同一张背景反复调用（每小段都会走一遍）时不要重播转场
  if (els.bg.dataset.scene === name) return;

  const ms = Math.max(0, Number(transition) || 0);
  const fade = els.bgNext;

  els.bg.dataset.scene = name;

  if (!ms || getSettings().reduceMotion || !fade) {
    els.bg.style.backgroundImage = `url("${url}")`;
    return;
  }

  // 交叉淡化：旧图先铺到上层，新图放到底层，上层淡出
  const previous = els.bg.style.backgroundImage;

  clearTimeout(sceneFadeTimer);

  if (!previous) {
    els.bg.style.backgroundImage = `url("${url}")`;
    return;
  }

  fade.style.transition = 'none';
  fade.style.backgroundImage = previous;
  fade.style.opacity = '1';

  els.bg.style.backgroundImage = `url("${url}")`;

  void fade.offsetWidth;

  fade.style.transition = `opacity ${ms}ms ease`;
  fade.style.opacity = '0';

  sceneFadeTimer = setTimeout(() => {
    fade.style.backgroundImage = '';
    fade.style.transition = 'none';
    sceneFadeTimer = 0;
  }, ms + 60);
}

// ------------------------------------------------------------------ 背景音乐

function bgmVolumeLevel() {
  if (getSettings().masterMute) return 0;
  return Math.max(0, Math.min(1, (Number(getSettings().bgmVolume) || 0) / 100));
}

function bgmElement() {
  if (bgmAudio) return bgmAudio;

  bgmAudio = new Audio();
  bgmAudio.loop = true;
  bgmAudio.preload = 'auto';
  bgmAudio.volume = bgmVolumeLevel();
  bgmAudio.hidden = true;
  bgmAudio.dataset.galBgm = '';

  // 挂进 DOM：部分 WebView 对游离的 Audio 更爱拦自动播放，也方便排查
  document.body.appendChild(bgmAudio);
  return bgmAudio;
}

/** 设置里拖音量：当前曲目立刻跟着变，不用重播 */
function applyBgmVolume() {
  if (bgmAudio) bgmAudio.volume = bgmVolumeLevel();
}

/** 语音音量：念到一半也立刻跟着变 */
function applyVoiceVolume() {
  const s = getSettings();
  configureTts({ volume: s.masterMute ? 0 : s.voiceVolume / 100, rate: s.voiceRate });
}

/** 当前这一小段要不要读：关了朗读 / 没语音模型 / 旁白不读都直接停 */
function narrateSegment(text, narration = false) {
  const s = getSettings();

  if (!s.voiceOn || !ttsReady()) return stopSpeech();
  if (narration && !s.voiceNarr) return stopSpeech();

  speak(text);
}

/** 下一小段提前合成，不打断当前朗读 */
function prefetchSegment(segment, narration = false) {
  const s = getSettings();

  if (!s.voiceOn || !ttsReady()) return;
  if (!segment) return;

  // 模型给了 <TTS> 时合成那份文本，和真正播的保持一致
  const text = String(segment.tts || segment.text || '');

  if (!text) return;
  if (narration && !s.voiceNarr) return;

  prefetchSpeech(text);
}

/** 自动推进还要等多久：正在合成先等一拍，正在播就等播完 */
function voiceRemainingMs() {
  const s = getSettings();

  if (!s.voiceOn || !ttsReady()) return 0;

  const state = ttsState();

  if (state.playing) return state.remainingMs + 120;
  if (state.pending) return 500;

  return 0;
}

/** 浏览器拦自动播放：等玩家第一次点画面 / 按键时再补播 */
function armBgmResume() {
  if (bgmResumeArmed) return;

  bgmResumeArmed = true;

  const retry = () => {
    bgmResumeArmed = false;
    document.removeEventListener('pointerdown', retry, true);
    document.removeEventListener('keydown', retry, true);
    if (bgmTrack) startBgm(bgmTrack);
  };

  document.addEventListener('pointerdown', retry, true);
  document.addEventListener('keydown', retry, true);
}

/** 把 BGM 音量线性推到 target；被新的淡变打断时返回 false */
function fadeBgmVolume(target, ms) {
  const audio = bgmElement();
  const id = ++bgmFadeId;
  const from = audio.volume;
  const to = Math.max(0, Math.min(1, Number(target) || 0));
  const began = Date.now();

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (id !== bgmFadeId) {
        clearInterval(timer);
        resolve(false);
        return;
      }

      const k = ms <= 0 ? 1 : Math.min(1, (Date.now() - began) / ms);
      audio.volume = from + (to - from) * k;

      if (k >= 1) {
        clearInterval(timer);
        resolve(true);
      }
    }, 40);
  });
}

/** 换曲 / 续播：同一首已经在放就什么都不做 */
async function startBgm(track, fade = false) {
  const wanted = String(track ?? '').trim();
  const url = pickMusicUrl(wanted);

  // 没有对应素材就保持安静，别拿内置文件冒充
  if (!url) {
    stopBgm(fade);
    return;
  }

  const audio = bgmElement();

  if (bgmTrack === wanted && bgmUrl === url) {
    if (audio.paused) audio.play().catch(() => armBgmResume());
    return;
  }

  // 淡出期间又来了新请求：以最后一次为准
  const id = ++bgmSwitchId;

  if (fade && !audio.paused) {
    await fadeBgmVolume(0, 400);
    if (id !== bgmSwitchId) return;
  }

  bgmTrack = wanted;
  bgmUrl = url;
  audio.dataset.galBgm = wanted;
  audio.src = url;
  audio.currentTime = 0;
  audio.volume = fade ? 0 : bgmVolumeLevel();
  audio.play().catch(() => armBgmResume());

  if (fade) fadeBgmVolume(bgmVolumeLevel(), 600);
}

function stopBgm(fade = false) {
  const audio = bgmAudio;

  bgmTrack = '';
  bgmUrl = '';
  bgmSwitchId += 1;

  if (!audio) return;

  if (!fade || audio.paused) {
    audio.pause();
    audio.removeAttribute('src');
    audio.dataset.galBgm = '';
    audio.load();
    return;
  }

  // 淡出期间如果又起了新曲，fadeBgmVolume 会返回 false，这里就别停
  fadeBgmVolume(0, 400).then((done) => {
    if (!done) return;

    audio.pause();
    audio.removeAttribute('src');
    audio.dataset.galBgm = '';
    audio.load();
  });
}

/** 剧本舞台 → 播放器；停曲用 stop_music 事件（stage.music 为空） */
function applyStageBgm(stage) {
  const track = String(stage?.music ?? '').trim();
  const fade = (Number(stage?.musicTransition) || 0) > 0;

  if (!track) {
    stopBgm(fade);
    return;
  }

  startBgm(track, fade);

  if (bgmAudio) {
    bgmAudio.playbackRate = Math.max(0.5, Math.min(2, Number(stage.musicSpeed) || 1));
  }
}

/** 素材页试听：放一首用户导入的曲子，20 秒后自动收回 */
function previewBgm(track) {
  startBgm(track);

  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    restoreStageBgm();
    toast('试听结束，已回到剧情 BGM');
  }, 20000);
}

/** 试听结束回到当前舞台该放的那首 */
function restoreStageBgm() {
  clearTimeout(previewTimer);
  previewTimer = null;
  applyStageBgm((liveMode ? liveEngine?.stage : engine?.stage) ?? {});
}

/** 开发用的服务有 /api/story；插件内嵌的静态页面读预编译的 story.json。 */
async function loadStory() {
  // 编辑器「保存并试玩」：稿件已经在 localStorage 里，直接用，别再打接口
  if (new URLSearchParams(location.search).has('draft')) {
    try {
      const raw = localStorage.getItem('gal:draft');
      // 和 /api/story 一样包一层 story：后面统一走 data.story
      if (raw) return { story: JSON.parse(raw) };
    } catch {
      // 解析失败就落回正常流程
    }
  }

  try {
    const response = await fetch('/api/story');
    if (response.ok) return await response.json();
  } catch (error) {
    // 静态服务下这里会 404，落到下面的回退
  }

  const response = await fetch('../story.json');
  return response.json();
}

function newGame() {
  clearAuto();
  engine = new StoryEngine(story);
  mergeGallery(engine);
  lastChapter = null;
  render(engine.start());
}

// ------------------------------------------------------------------ 渲染

function render(frame) {
  renderStage(engine.stage);
  renderChapter();
  renderAffection();

  // 换到选项 / 输入 / 结局时，上一句没演完的小段直接作废
  if (frame.type !== 'line' && frame.type !== 'narration') clearScriptSegments();

  // 选项浮在立绘前面会打架，出选项时把立绘压暗淡出一点
  els.cast.classList.toggle('choosing', frame.type === 'choice');

  // 事件的 duration：0 = 立刻继续，>0 = N 秒后自动推进（等待点击的事件没有这个字段）
  if (typeof frame.auto === 'number' && frame.type !== 'choice') {
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = setTimeout(() => {
      autoAdvanceTimer = null;
      advance();
    }, Math.min(15000, Math.max(0, frame.auto)));
  }

  if (engine.chapterId !== lastChapter) {
    lastChapter = engine.chapterId;
    markVisited(engine.chapterId);
    showChapterBanner(els.chapter.textContent);
    saveTo('auto', true);
  }

  hideTransient();

  switch (frame.type) {
    case 'line':
    case 'narration':
      showLine(frame);
      break;

    case 'choice':
      showChoices(frame);
      break;

    case 'input':
      showInput(frame);
      break;

    case 'free':
      showFree(frame);
      break;

    case 'end':
      showEnding(frame);
      break;

    default:
      showLine({ speaker: null, text: '' });
  }

  // CG / 结局 / 成就是跨周目累积的，随时落盘
  syncGallery(engine);
}

function renderStage(stage) {
  applyStageBgm(stage);

  // 剧本模式自己铺渐变，别让 live 的场景缓存误判成「没换背景」
  delete els.bg.dataset.scene;

  const sceneName = stage.background || readHomeBg() || '天台·黄昏';
  const custom = pickBackgroundUrl(sceneName);
  const art = BACKGROUNDS[sceneName];

  // 自己导入的素材优先，其次剧本内置映射，最后渐变兜底
  els.bg.style.backgroundImage = custom
    ? `url("${custom}"), ${hashGradient(sceneName)}`
    : art
      ? art + ', ' + hashGradient(sceneName)
      : hashGradient(sceneName);

  const rain = stage.effect === 'rain';
  els.weather.className = `weather${rain ? ' on rain' : ''}`;

  renderCast(stage.cast);
  els.cast.classList.toggle('cg-on', Boolean(stage.cg));

  if (stage.cg) {
    els.cgTitle.textContent = stage.cgTitle ?? stage.cg;
    els.cgLayer.classList.add('show');
  } else {
    els.cgLayer.classList.remove('show');
  }
}

function renderCast(list) {
  els.cast.innerHTML = '';

  list.forEach((item, index) => {
    const character = story.characters?.[item.id] ?? {};
    const node = document.createElement('div');
    node.className = 'character';
    node.style.left = positionLeft(item.position, index, list.length);

    const figure = document.createElement('div');
    figure.className = 'figure';

    // 导入了同角色差分就按表情换图；没有就用内置那张 char.png，别覆盖成空白
    const art = pickCharacterUrl(
      character.name ?? item.id,
      [item.emotion].filter(Boolean),
      item.clothing ?? item.clothes ?? '',
    );

    figure.style.backgroundImage = art ? `url("${art}")` : '';
    if (!art) figure.textContent = EMOJI[item.emotion] ?? EMOJI.normal;

    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = character.name ?? item.id;

    node.append(figure, tag);
    els.cast.appendChild(node);
  });
}

function positionLeft(position, index, total) {
  if (total > 1 && position === 'center') {
    const spread = 26;
    const offset = (index - (total - 1) / 2) * spread;
    return `${50 + offset}%`;
  }

  if (position === 'left') return '26%';
  if (position === 'right') return '74%';
  return '50%';
}

/** 章节切换的过场横幅：LingChat 那套「先出后进」的仪式感，纯前端两行就够 */
function showChapterBanner(title) {
  if (!title) return;

  document.querySelector('.chapter-banner')?.remove();

  const node = document.createElement('div');
  node.className = 'chapter-banner';
  node.innerHTML = `<span>${title}</span>`;
  document.body.appendChild(node);

  requestAnimationFrame(() => node.classList.add('show'));

  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 600);
  }, 1600);
}

function renderChapter() {
  const id = engine.chapterId ?? '';
  els.chapter.textContent = story.chapterTitles?.[id] ?? id;
}

function renderAffection() {
  const value = engine.affection;
  const has = 'affection' in engine.vars;

  els.affection.hidden = !has;
  els.affFill.style.width = `${Math.max(0, Math.min(100, value * 8))}%`;
  els.affNum.textContent = String(value);
}

function hideTransient() {
  els.choices.hidden = true;
  els.choices.innerHTML = '';
  els.inputbar.hidden = true;
  els.freebar.hidden = true;
  els.dialogue.hidden = false;
  els.stage.querySelector('.ending')?.remove();
}

// ------------------------------------------------------------------ 台词

// 一句台词里写 [表情:害羞] / [服装:私服] / [场景:天台_傍晚] 时，拆成几小段，
// 每段一次点击（自动播放时按段停顿），段与段之间换差分。
let scriptQueue = [];
let scriptFrame = null;
let scriptShown = 0;
let scriptTotal = 0;

const INLINE_TAG_RE = /\[\s*(场景|表情|情绪|位置|CG|服装)\s*[:：]/;

function scriptSegments(frame) {
  const raw = String(frame.text ?? '');
  const hasTag = INLINE_TAG_RE.test(raw);

  // 带舞台标签时按标签 + 标点拆，和以前一样
  if (hasTag) return splitLiveSegments(raw);

  // 多行台词：一行一小段，点一次换一行，语音也只念当前这一行
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (lines.length <= 1) return [];

  return lines.map((text) => ({ text, tags: {} }));
}

/** 把这一段带的标签落到舞台：表情 / 服装 / 位置 / 场景。返回是否真的变了 */
function applySegmentTags(tags, frame) {
  if (!tags) return false;

  let changed = false;

  if (tags['场景'] && engine?.stage && engine.stage.background !== tags['场景']) {
    engine.stage.background = tags['场景'];
    changed = true;
  }

  const speaker = frame?.speaker;
  if (!speaker) return changed;

  const item = engine?.stage?.cast?.find((entry) => entry.id === speaker.id);
  const emotion = tags['表情'] ?? tags['情绪'];

  if (emotion && item && item.emotion !== emotion) {
    item.emotion = emotion;
    changed = true;
  }

  if (tags['服装'] && item && item.clothing !== tags['服装']) {
    item.clothing = tags['服装'];
    changed = true;
  }

  if (tags['位置'] && item && item.position !== tags['位置']) {
    item.position = tags['位置'];
    changed = true;
  }

  if (tags['CG'] && engine?.stage && engine.stage.cg !== tags['CG']) {
    engine.stage.cg = tags['CG'];
    changed = true;
  }

  return changed;
}

function updateScriptSegInfo() {
  let node = document.getElementById('segInfo');

  if (!node) {
    node = document.createElement('div');
    node.id = 'segInfo';
    node.className = 'seg-info';
    els.dialogue.appendChild(node);
  }

  node.hidden = scriptTotal <= 1;
  node.textContent = scriptTotal > 1 ? `${scriptShown}/${scriptTotal}` : '';
}

function clearScriptSegments() {
  scriptQueue = [];
  scriptTotal = 0;
  scriptShown = 0;

  const node = document.getElementById('segInfo');
  if (node) node.hidden = true;
}

function paintScriptSegment(segment, frame, first) {
  const isNarration = !frame.speaker;
  const name = frame.speakerName || (isNarration ? '' : frame.speaker.name);

  setSpeaker(name, frame.subtitle);
  els.speaker.classList.toggle('narration-label', isNarration && !frame.speakerName);
  // 旁白分三类：inner 内心独白 / scene 场景描写 / flash 回忆，其余按普通场景描写走
  const narrationStyle = isNarration ? (frame.style || 'scene') : '';
  els.text.className = `text${narrationStyle ? ` narr-${narrationStyle}` : ''}`;
  els.text.style.fontStyle = '';
  els.text.style.color = '';

  if (applySegmentTags(segment.tags, frame)) renderStage(engine.stage);

  typeOrSkip(segment.text);
  // 只念当前显示的这一小段；下一段在后台先合成好，点过去就能直接播
  narrateSegment(segment.text, isNarration);
  prefetchSegment(scriptQueue[0], isNarration);
  if (first) rememberRollback();

  updateScriptSegInfo();
}

function showLine(frame) {
  scriptFrame = frame;

  const segments = scriptSegments(frame);

  if (segments.length) {
    scriptQueue = segments.slice(1);
    scriptTotal = segments.length;
    scriptShown = 1;
    paintScriptSegment(segments[0], frame, true);
    return;
  }

  clearScriptSegments();
  paintScriptSegment({ text: frame.text ?? '', tags: {} }, frame, true);
}

/** 把推进前那份快照挂到这一句上，回看里才能「回到这句」 */
function rememberRollback() {
  if (!pendingSnapshot || !engine) return;

  const index = engine.backlog.length - 1;
  if (index >= 0) rollbacks[index] = pendingSnapshot;

  pendingSnapshot = null;
}

function rollbackTo(index) {
  const payload = rollbacks[index];

  if (!payload) {
    toast('这一句没有回滚点');
    return;
  }

  try {
    engine = StoryEngine.restore(payload, story);
    mergeGallery(engine);

    rollbacks = rollbacks.slice(0, index);
    lastChapter = engine.chapterId;

    closePanel();

    // 恢复到"这句之前"，再走一步就重新把这一句演出来
    pendingSnapshot = payload;
    render(engine.next());
    toast('已回到这句');
  } catch (error) {
    toast(`回滚失败：${error.message}`);
  }
}

function mountTyping() {
  writer = new Typewriter(els.text, {
    reducedMotion: effectiveReduceMotion,
    onChar: () => {},
  });

  applyTypingSettings();
}

function applyTypingSettings() {
  const s = getSettings();
  writer?.setSpeed(s.speed);
  setTypingSound(s.typingSound && !s.masterMute);
  setTypingVolume(s.soundVolume);
  applyBgmVolume();
  applyVoiceVolume();
}

/** 一键静音：三个声源一起关；用来判断底噪到底是不是本插件发出来的 */
function applyMasterMute(on) {
  saveSettings({ masterMute: on });

  if (on) {
    stopBgm();
    stopSpeech();
  }

  applyTypingSettings();

  if (!on) {
    applyStageBgm((liveMode ? liveEngine?.stage : engine?.stage) ?? {});
  }
}

/** 打字或直接显示：开了「跳过已读」且这句演过，就不再逐字 */
function typeOrSkip(text) {
  const value = String(text ?? '');
  const s = getSettings();

  if (s.skipRead && seenLines.has(value)) {
    els.text.textContent = value;
    onTyped();
    return;
  }

  rememberSeen(value);
  typeText(value);
}
function typeText(full) {
  els.nextDot.classList.remove('show');

  // generation 计数器：后一句把前一句的 then 作废，避免旧回调把圆点又点亮
  const seq = ++typedSeq;

  writer.play(full).then(() => {
    if (seq !== typedSeq) return;
    onTyped();
  });
}

function onTyped() {
  els.nextDot.classList.add('show');

  if (autoOn && engine && !engine.finished) scheduleAutoAdvance(autoDelayMs());

  // live 模式：最后一句打完就直接进选项环节，别让玩家再点一次
  if (liveMode && !liveQueue.length && els.choices.hidden && !choicesPending) finishLive();
}

/** 句尾停留按字数浮动：短句别干等，长句得留出读的时间 */
function autoDelayMs() {
  const base = getSettings().autoDelay;
  const length = (els.text.textContent ?? '').length;
  return base + Math.min(2400, length * 35);
}

function finishTyping() {
  writer?.finish();
}

function stopTyping() {
  writer?.stop();
  els.nextDot.classList.remove('show');
}

function advance() {
  // 玩家手动推进时，先撤掉 duration 的自动定时器，避免刚点完又被计时推一下
  if (autoAdvanceTimer) {
    clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = null;
  }

  // 直播模式（剧情窗口）：一句一句点，点完最后一句才出选项
  if (liveMode) {
    if (writer && !writer.done) {
      finishTyping();
      return;
    }

    if (liveQueue.length) {
      showLiveSegment();
      return;
    }

    // 剧本正停在选项/输入上：剧本优先，模型自己编的选项不能顶掉剧本分支
    if (scriptChoiceFrame()) {
      if (els.choices.hidden) finishLive();
      return;
    }

    if (!scriptEnded && liveEngine?.currentFrame?.()?.type === 'input') return;

    if (liveOptions.length && els.choices.hidden) {
      renderLiveChoices(liveOptions);
      return;
    }

    // 队列演完了、也没有模型给的选项：现场生成一组
    if (els.choices.hidden) finishLive();

    return;
  }

  if (!engine || engine.finished) return;
  if (!els.choices.hidden || !els.inputbar.hidden || !els.freebar.hidden) return;

  if (writer && !writer.done) {
    finishTyping();
    return;
  }

  // 这一句还有没演完的小段：先演下一段（表情/服装跟着换），别急着走事件
  if (scriptQueue.length) {
    clearAuto();
    scriptShown += 1;
    paintScriptSegment(scriptQueue.shift(), scriptFrame, false);
    return;
  }

  clearAuto();
  pendingSnapshot = safeSnapshot();
  render(engine.next());
}

/** 回滚快照：引擎没实现回滚，就靠每步之前存一份完整状态 */
function safeSnapshot() {
  try {
    return engine?.save('回滚点') ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 选项

function showChoices(frame) {
  stopTyping();
  // 选项出来就收声：别让上一句的朗读压住玩家做决定
  stopSpeech();

  // 保留对话框：最后一句台词是玩家做选择时的语境，别把它抽掉
  els.dialogue.hidden = false;
  els.choices.hidden = false;
  els.choices.innerHTML = '';

  frame.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = option.locked;

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(index + 1);

    const label = document.createElement('span');
    label.textContent = option.text;

    button.append(idx, label);

    if (option.locked && option.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = option.hint;
      button.appendChild(hint);
    }

    button.addEventListener('click', () => {
      if (option.locked) return;
      clearAuto();
      render(engine.choose(index));
    });

    els.choices.appendChild(button);
  });

  // allow_free：最后一格是「自己说」，提交后按自由输入推进，不触发任何选项动作
  if (frame.allowFree) {
    const form = document.createElement('form');
    form.className = 'choice-free';

    const mark = document.createElement('span');
    mark.className = 'idx';
    mark.textContent = '✎';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '用自己的话说…';
    input.autocomplete = 'off';

    const send = document.createElement('button');
    send.type = 'submit';
    send.textContent = '说';

    form.append(mark, input, send);
    form.addEventListener('submit', (event) => {
      event.preventDefault();

      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }

      clearAuto();
      pendingSnapshot = safeSnapshot();
      render(engine.chooseFree(text));
    });

    els.choices.appendChild(form);
    input.focus();
  }
}

// ------------------------------------------------------------------ 输入 / 自由对话

function showInput(frame) {
  stopTyping();
  els.dialogue.hidden = true;
  els.inputbar.hidden = false;
  els.inputBox.value = '';
  // hint 是给玩家的占位提示，prompt 是剧情里那句提示台词
  els.inputBox.placeholder = frame.hint || frame.prompt || '说点什么…';
  els.inputBox.focus();
}

function showFree(frame) {
  stopTyping();
  els.freebar.hidden = false;

  const label = els.freebar.querySelector('span');
  const rounds = frame.maxRounds ? `（最多 ${frame.maxRounds} 轮）` : '';
  const hint = String(frame.hint ?? '').trim();

  const base = frame.endLine
    ? `自由对话${rounds} —— ${frame.endLine}，点右侧继续`
    : `自由对话${rounds} —— 点右侧继续`;

  // hint 是给玩家的提示，不是台词
  label.textContent = hint ? `${base}（${hint}）` : base;
}

// ------------------------------------------------------------------ 结局

function showEnding(frame, { live = false } = {}) {
  stopTyping();
  clearAuto();
  stopSpeech();

  els.dialogue.hidden = true;
  // 上一张结局卡还没关掉时先收走，避免叠两层
  els.stage.querySelector('.ending')?.remove();

  const ending = frame.ending ?? { title: '剧终', description: '' };
  const node = document.createElement('div');
  node.className = 'ending';

  const inner = document.createElement('div');
  inner.className = 'inner';

  const kicker = document.createElement('div');
  kicker.className = 'kicker';
  kicker.textContent = 'ENDING';

  const title = document.createElement('h1');
  title.textContent = ending.title ?? '剧终';

  const desc = document.createElement('p');
  desc.textContent = ending.description ?? '';

  const buttons = document.createElement('div');
  buttons.className = 'buttons';

  if (live) {
    // live 模式没有「周目」概念：关掉结局卡，接着陪聊就行
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = '继续聊天';
    keep.addEventListener('click', () => {
      node.remove();
      els.dialogue.hidden = false;
    });

    buttons.append(keep);
  } else {
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = '再玩一次';
    again.addEventListener('click', () => newGame());

    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '回到存档';
    back.addEventListener('click', () => openPanel('load'));

    buttons.append(again, back);
  }

  inner.append(kicker, title, desc, buttons);
  node.appendChild(inner);
  els.stage.appendChild(node);

  // 走到结局顺手把全文落一份到本地；live 没有真结局，不自动导出
  if (!live && getSettings().autoExport) void exportTranscript(buildTranscript(), true);

  toast(`结局已收录：${ending.title ?? '剧终'}`);
}

// ------------------------------------------------------------------ 内嵌编辑器

/** 把编辑器铺满剧情窗口；不用 window.open，避免宿主把弹窗关闭当成退出应用 */
function openEmbed(url) {
  if (!els.embed) return;

  els.embedFrame.src = url;
  els.embed.hidden = false;
}

function closeEmbed() {
  if (!els.embed) return;

  // 先让编辑器把叠在上面的试玩层关掉，不然试玩里的 BGM 会在后台继续响
  try {
    els.embedFrame.contentWindow?.postMessage({ type: 'gal-embed-close' }, location.origin);
  } catch { }

  // iframe 文档留着，编辑器里没保存的稿子下次打开还在
  els.embed.hidden = true;
}

// ------------------------------------------------------------------ 面板

function bindUI() {
  $('panelClose').addEventListener('click', closePanel);
  els.overlay.addEventListener('click', (event) => {
    if (event.target === els.overlay) closePanel();
  });

  $('embedBack').addEventListener('click', closeEmbed);

  // 窗口被隐藏 / 切到后台：别让 BGM 和语音在后台一直响
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      bgmAudio?.pause();
      stopSpeech();
      return;
    }

    if (bgmTrack) startBgm(bgmTrack);
  });

  document.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', () => {
      const act = button.dataset.act;

      if (act === 'auto') {
        toggleAuto(button);
        return;
      }

      openPanel(act);
    });
  });

  // 窗口右上角「—」/「✕」：交给 C# 侧隐藏到托盘 / 释放窗口
  const winActions = [
    ['win-hide', '/api/window-hide'],
    ['win-close', '/api/window-close'],
  ];

  for (const [id, path] of winActions) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await fetch(path, { method: 'POST' });
      } catch (error) {
        toast('窗口操作失败');
      }
    });
  }

  els.dialogue.addEventListener('click', advance);

  els.inputbar.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = els.inputBox.value.trim();
    if (!text) return;
    pendingSnapshot = safeSnapshot();
    render(engine.submitInput(text));
  });

  $('freeEnd').addEventListener('click', () => {
    pendingSnapshot = safeSnapshot();
    render(engine.endFreeDialogue());
  });

  els.liveInput.addEventListener('submit', (event) => {
    event.preventDefault();

    const text = els.liveText.value.trim();
    if (text) sendToHost(text);
  });

  const hotbar = document.getElementById('dlgHotbar');

  if (hotbar) {
    hotbar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-hot]');
      if (button) handleHot(button.dataset.hot);
    });
  }

  const uxBar = document.getElementById('uxBar');

  if (uxBar) {
    uxBar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-ux]');
      if (!button) return;
      event.stopPropagation();
      handleHot(button.dataset.ux);
    });
  }

  // 滚轮上翻打开回看：累计到阈值才触发，读长文时往回滚一格不会跳走
  let wheelAcc = 0;
  let wheelAt = 0;

  els.dialogue.addEventListener(
    'wheel',
    (event) => {
      if (!els.overlay.hidden) return;

      const now = Date.now();
      if (now - wheelAt < 900) return;

      if (event.deltaY < 0) wheelAcc += -event.deltaY;
      else wheelAcc = 0;

      if (wheelAcc < 120) return;

      wheelAcc = 0;
      wheelAt = now;
      openPanel('log');
    },
    { passive: true },
  );

  document.addEventListener('contextmenu', (event) => {
    if (!uiHidden) return;
    event.preventDefault();
    toggleUiHidden(false);
  });

  // 隐藏后画面全透明，只剩背景：点一下、按一下都应该把界面叫回来。
  // 用捕获阶段，先于对话区的推进逻辑，避免"恢复的同时又翻了一页"。
  for (const type of ['pointerdown', 'click']) {
    els.stage.addEventListener(
      type,
      (event) => {
        if (!uiHidden) return;
        event.preventDefault();
        event.stopPropagation();
        toggleUiHidden(false);
      },
      true,
    );
  }

  window.addEventListener('keydown', (event) => {
    if (!uiHidden) return;
    if (event.key === 'Escape' || event.key === 'Enter' || event.code === 'Space') {
      toggleUiHidden(false);
    }
  });

  $('assetDir').addEventListener('change', (event) => importFromInput(event.target));
  $('assetImgs').addEventListener('change', (event) => importFromInput(event.target));

  // 直接把文件夹拖进画面也能导入（WebView2 里比文件对话框顺手）
  for (const type of ['dragenter', 'dragover']) {
    els.stage.addEventListener(type, (event) => event.preventDefault());
  }

  els.stage.addEventListener('drop', async (event) => {
    event.preventDefault();
    importKind = '';
    const entries = await entriesFromDataTransfer(event.dataTransfer);
    await runImport(entries);
  });

  bindShortcuts(handleShortcut);

  // 数字键直接选选项
  document.addEventListener('keydown', (event) => {
    if (els.choices.hidden) return;
    if (event.target instanceof HTMLInputElement) return;
    if (!/^[1-9]$/.test(event.key)) return;

    const button = els.choices.children[Number(event.key) - 1];
    // 自由输入那一格是表单，不是选项按钮，数字键别去点它
    if (button instanceof HTMLButtonElement && !button.disabled) button.click();
  });
}

function handleShortcut(action) {
  if (action === 'close') {
    if (uiHidden) {
      toggleUiHidden(false);
      return;
    }

    closePanel();
    return;
  }

  if (action === 'advance') {
    if (uiHidden) {
      toggleUiHidden(false);
      return;
    }

    advance();
    return;
  }

  if (action === 'fast-start') {
    startFast();
    return;
  }

  if (action === 'fast-end') {
    stopFast();
    return;
  }

  if (action === 'auto') {
    toggleAuto(null);
    return;
  }

  handleHot(action === 'help' ? 'help' : action);
}

function openPanel(kind) {
  const builders = {
    log: buildLog,
    isolated: buildIsolated,
    save: () => buildSlots('save'),
    load: () => buildSlots('load'),
    gallery: buildGallery,
    vars: buildVars,
    assets: buildAssets,
    settings: buildSettings,
    help: buildHelp,
  };

  const builder = builders[kind];
  if (!builder) return;

  els.panelBody.innerHTML = '';
  builder(els.panelBody);
  els.overlay.hidden = false;
}

function closePanel() {
  els.overlay.hidden = true;
}

/** 导出用的全文：story 取引擎 backlog（含选项），live 取宿主完整历史 */
function buildTranscript() {
  const now = new Date().toLocaleString('zh-CN');
  const body = [];

  if (engine) {
    const book = engine.story ?? story ?? {};
    const name = book.name ?? 'Galgame';
    const chapterTitles = book.chapterTitles ?? {};
    const vars = engine.vars ?? {};

    body.push(`《${name}》 剧情记录`, `玩家：${book.playerName ?? '你'}`);

    if (engine.chapterId) body.push(`进度：${chapterTitles[engine.chapterId] ?? engine.chapterId}`);
    if (Object.keys(vars).length) {
      body.push(`变量：${Object.entries(vars).map(([key, value]) => `${key}=${value}`).join('、')}`);
    }
    if (engine.ending) body.push(`结局：${engine.ending.title ?? engine.ending.id ?? '剧终'}`);

    body.push(`导出时间：${now}`, '', '────────────', '');

    let chapter = null;

    for (const item of engine.backlog ?? []) {
      if (item.chapter && item.chapter !== chapter) {
        chapter = item.chapter;
        body.push('', `【${chapterTitles[chapter] ?? chapter}】`, '');
      }

      if (item.kind === 'choice') {
        body.push(`▸ 选择：${item.text}`, '');
        continue;
      }

      body.push(item.speaker?.name ? `${item.speaker.name}：${item.text}` : item.text, '');
    }

    return { title: name, text: body.join('\n').trim() + '\n' };
  }

  body.push('《对话回放》', `角色：${liveRole || '她'}`, `导出时间：${now}`, '', '────────────', '');

  for (const item of liveHistory) {
    const text = String(item?.text ?? '').trim();
    if (!text) continue;

    const name = item.name ?? (item.role === 'user' ? '你' : '她');
    body.push(`${name}：${text}`, '');
  }

  return { title: liveScript?.name ?? '对话回放', text: body.join('\n').trim() + '\n' };
}

/** 回看面板顶部的导出 / 复制 */
function transcriptBar(transcript) {
  const bar = document.createElement('div');
  bar.className = 'actions';

  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'primary';
  exportButton.textContent = '导出全文 TXT';
  exportButton.title = '保存到「文档 / Alife / 剧情导出」，关掉 Alife 也不会丢';
  exportButton.addEventListener('click', () => void exportTranscript(transcript));

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = '复制全文';
  copyButton.addEventListener('click', () => void copyTranscript(transcript.text));

  bar.append(exportButton, copyButton);
  return bar;
}

async function exportTranscript(transcript, auto = false) {
  const url = `/api/export?name=${encodeURIComponent(transcript.title)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: transcript.text,
    });

    const type = response.headers.get('Content-Type') ?? '';

    if (response.ok && type.includes('application/json')) {
      const data = await response.json();

      if (data?.path) {
        toast(`已保存：${data.path}`);
        return true;
      }
    }
  } catch {
    // 静态服务下没有这个接口，走浏览器下载
  }

  // 自动导出只在宿主里落盘；静态页面别每次都弹下载
  if (auto) return false;

  downloadText(`${transcript.title}_剧情记录.txt`, transcript.text);
  toast('已下载 TXT，可自行保存或分享');
  return true;
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyTranscript(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('全文已复制');
  } catch {
    // 老 WebView 没有剪贴板权限时退回 textarea
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('全文已复制');
  }
}

function buildLog(host) {
  els.panelTitle.textContent = '回看';

  // 全文导出 / 复制：回看面板只显示当前这局，导出的 TXT 是完整的
  const transcript = buildTranscript();

  if (transcript.text) host.appendChild(transcriptBar(transcript));

  // live 模式没有剧本引擎，回看直接用宿主历史，别让面板整个报错
  if (!engine) {
    const lines = liveHistory.filter((item) => item && String(item.text ?? '').trim());

    if (!lines.length) {
      host.textContent = '还没有台词。';
      return;
    }

    lines.forEach((item) => {
      const node = document.createElement('div');
      node.className = 'log-item';

      if (item.name) {
        const name = document.createElement('b');
        name.textContent = item.name;
        node.appendChild(name);
      }

      node.appendChild(document.createTextNode(String(item.text ?? '')));
      host.appendChild(node);
    });

    return;
  }

  if (!engine.backlog.length) {
    host.textContent = '还没有台词。';
    return;
  }

  const total = engine.backlog.length;

  [...engine.backlog].reverse().forEach((item, offset) => {
    const index = total - 1 - offset;

    const node = document.createElement('div');
    node.className = `log-item${item.kind === 'narration' ? ' narration' : ''}`;

    if (item.speaker) {
      const name = document.createElement('b');
      name.textContent = item.speaker.name;
      node.appendChild(name);
    }

    node.appendChild(document.createTextNode(item.text));

    if (rollbacks[index]) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'rollback';
      back.textContent = '回到这句';
      back.addEventListener('click', () => rollbackTo(index));
      node.appendChild(back);
    }

    host.appendChild(node);
  });
}

/** 隔离剧情记录：只看、只导出这一段，和主聊天彻底分开 */
function buildIsolated(host) {
  els.panelTitle.textContent = '隔离剧情';

  const items = readIsolatedHistory();
  const actions = document.createElement('div');
  actions.className = 'actions';

  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'primary';
  exportButton.textContent = '导出 TXT';
  exportButton.title = '保存到「文档 / Alife / 剧情导出」，只有隔离剧情';
  exportButton.disabled = !items.length;
  exportButton.addEventListener('click', () => void exportTranscript(buildIsolatedTranscript()));

  const wipe = document.createElement('button');
  wipe.type = 'button';
  wipe.textContent = '清空';
  wipe.disabled = !items.length;
  wipe.addEventListener('click', () => {
    if (!window.confirm('清空后这段隔离剧情就找不回来了，继续？')) return;

    try { localStorage.removeItem(ISOLATE_KEY); } catch { }

    // 内存里的也一起清掉：之后的隔离对话从下一句重新开始
    liveHistory = [];
    openPanel('isolated');
    toast('已清空隔离剧情');
  });

  actions.append(exportButton, wipe);
  host.appendChild(actions);

  const note = document.createElement('p');
  note.className = 'set-note';
  note.textContent = items.length
    ? `共 ${items.length} 条，只在本地保存（最多 ${ISOLATE_LIMIT} 条），不写 Alife 记忆。`
    : '还没有隔离剧情。开启「记忆隔离」后，剧情会记在这里。';
  host.appendChild(note);

  items.forEach((item) => {
    const node = document.createElement('div');
    node.className = 'log-item';

    if (item.name) {
      const name = document.createElement('b');
      name.textContent = item.name;
      node.appendChild(name);
    }

    node.appendChild(document.createTextNode(String(item.text ?? '')));
    host.appendChild(node);
  });
}

function buildSlots(mode) {
  els.panelTitle.textContent = mode === 'save' ? '存档' : '读档';

  // 读档按「自动存档（最近的在前）→ 手动存档」排列；自动档 3 槽轮换，坏档能往回退
  const rows = mode === 'save'
    ? SLOTS.map((slot) => ({ slot, title: `存档位 ${slot}` }))
    : [
      ...AUTO_SLOTS
        .map((slot) => ({ slot, data: readSave(slot) }))
        .sort((a, b) => (b.data?.savedAt ?? 0) - (a.data?.savedAt ?? 0))
        .map((item, index) => ({ ...item, title: `自动存档 ${index + 1}${index === 0 && item.data ? '（最近）' : ''}` })),
      ...SLOTS.map((slot) => ({ slot, title: `存档位 ${slot}` })),
    ];

  for (const { slot, title } of rows) {
    const data = readSave(slot);
    const row = document.createElement('div');
    row.className = 'slot';

    const meta = document.createElement('div');
    meta.className = 'meta';

    const name = document.createElement('b');
    name.textContent = title;

    const detail = document.createElement('small');
    detail.textContent = data
      ? `${data.label} · 好感 ${data.vars?.affection ?? 0} · ${formatTime(data.savedAt)}`
      : '空';

    meta.append(name, detail);

    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = mode === 'save' ? '覆盖' : '读取';
    action.disabled = mode === 'load' && !data;

    action.addEventListener('click', () => {
      if (mode === 'save') {
        saveTo(slot);
        closePanel();
        return;
      }

      loadFrom(slot);
    });

    row.append(meta, action);
    els.panelBody.appendChild(row);
  }
}

const VISITED_KEY = 'gal-script:visited';

function loadVisited() {
  try {
    const raw = JSON.parse(localStorage.getItem(VISITED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** 记录走过的章节，图鉴里的路线图靠它渲染 */
function markVisited(id) {
  if (!id) return;

  const visited = loadVisited();
  if (visited.includes(id)) return;

  visited.push(id);
  try { localStorage.setItem(VISITED_KEY, JSON.stringify(visited.slice(-200))); } catch { }
}
function buildGallery(host) {
  els.panelTitle.textContent = '图鉴';

  // story 模式用 engine，live 模式用 liveEngine；「有哪些」永远看剧本本身
  const active = engine ?? liveEngine;
  const book = engine?.story ?? liveScript ?? story ?? {};

  if (!active) {
    host.textContent = '还没有可展示的剧本。';
    return;
  }

  const cgs = collectCGs(book);
  const endings = collectEndings(book);
  const chapterTitles = book.chapterTitles ?? {};
  const chapters = book.chapters ?? {};

  const heading = (text) => {
    const node = document.createElement('div');
    node.style.margin = '6px 0 12px';
    node.style.color = 'var(--gold)';
    node.style.letterSpacing = '0.2em';
    node.style.fontSize = '13px';
    node.textContent = text;
    return node;
  };

  // 章节路线：走过的点亮，没走过的锁着
  host.appendChild(heading('路线'));

  const visited = loadVisited();
  const route = document.createElement('div');
  route.className = 'route-list';

  const ids = Object.keys(chapters);

  if (!ids.length) {
    const empty = document.createElement('p');
    empty.className = 'set-note';
    empty.textContent = '这份剧本没有章节信息。';
    route.appendChild(empty);
  }

  for (const id of ids) {
    const row = document.createElement('div');
    const been = visited.includes(id);
    row.className = 'route-item' + (been ? ' vis' : '');
    row.textContent = been ? (chapterTitles[id] || id) : '？？？  ' + id;
    route.appendChild(row);
  }

  host.appendChild(route);

  // 成就
  host.appendChild(heading('成就'));

  const unlocked = [...(active.achievements ?? [])];
  const ach = document.createElement('p');
  ach.className = 'set-note';
  ach.textContent = unlocked.length
    ? unlocked.map((id) => achievements(book)[id] ?? id).join(' · ')
    : '还没有解锁任何成就。';
  host.appendChild(ach);

  host.appendChild(heading('CG'));

  const grid = document.createElement('div');
  grid.className = 'gallery';

  const ownedCG = active.unlockedCG ?? new Set();

  cgs.forEach((item) => {
    const owned = ownedCG.has(item.path);
    const figure = document.createElement('figure');
    figure.className = owned ? 'owned' : '';
    figure.textContent = owned ? item.title : '???';
    grid.appendChild(figure);
  });

  host.appendChild(grid);
  host.appendChild(heading('结局'));

  const list = document.createElement('div');
  const ownedEndings = active.endings ?? new Set();

  endings.forEach((item) => {
    const owned = ownedEndings.has(item.id);
    const row = document.createElement('div');
    row.className = 'log-item';
    row.textContent = owned ? `《${item.title}》 ${item.desc}` : '???';
    list.appendChild(row);
  });

  host.appendChild(list);
}

function buildVars(host) {
  els.panelTitle.textContent = '进度';

  // story 模式用 engine，live 模式用 liveEngine；两者都能看章节与好感
  const active = engine ?? liveEngine;
  const book = engine?.story ?? liveScript ?? story ?? {};

  if (!active) {
    host.textContent = '还没有可展示的进度。';
    return;
  }

  const chapterTitles = book.chapterTitles ?? {};
  const vars = active.vars ?? {};
  const affection = Number(vars.affection ?? 0);
  const visited = loadVisited();

  const heading = (text) => {
    const node = document.createElement('div');
    node.style.margin = '12px 0 8px';
    node.style.color = 'var(--gold)';
    node.style.letterSpacing = '0.2em';
    node.style.fontSize = '13px';
    node.textContent = text;
    return node;
  };

  // 概览：一屏看完当前走到哪、好感多少、收集了多少
  host.appendChild(heading('当前进度'));

  const facts = document.createElement('div');
  facts.className = 'vars';
  facts.textContent = [
    `章节：${chapterTitles[active.chapterId] ?? active.chapterId ?? '—'}`,
    liveMode ? `轮次：${liveState.turns}` : '',
    `好感：${affection}`,
    `CG：${(active.unlockedCG ?? new Set()).size} · 结局：${(active.endings ?? new Set()).size} · 成就：${(active.achievements ?? new Set()).size}`,
  ].filter(Boolean).join('\n');
  host.appendChild(facts);

  // 当前停在选项上：直接标出哪些能点、锁着的差什么
  const frame = active.currentFrame?.() ?? null;

  if (frame?.type === 'choice' && Array.isArray(frame.options)) {
    host.appendChild(heading('当前分支'));

    const prompt = document.createElement('p');
    prompt.className = 'set-note';
    prompt.textContent = frame.prompt || '你怎么选？';
    host.appendChild(prompt);

    frame.options.forEach((option) => {
      const row = document.createElement('div');
      row.className = 'log-item';
      row.textContent = `${option.locked ? '锁定' : '可选'}：${option.text}${option.locked && option.hint ? `（${option.hint}）` : ''}`;
      host.appendChild(row);
    });
  }

  // 全部带条件的选项：提前知道哪条线需要什么，不用反复试错
  const points = [];

  for (const [chapterId, events] of Object.entries(book.chapters ?? {})) {
    if (!Array.isArray(events)) continue;

    for (const event of events) {
      const type = String(event?.type ?? '').toLowerCase();
      if (type !== 'choices' && type !== 'choice') continue;
      if (!Array.isArray(event.options)) continue;

      for (const option of event.options) {
        if (typeof option?.condition !== 'string' || !option.condition.trim()) continue;

        points.push({
          where: chapterTitles[chapterId] ?? chapterId,
          text: String(option.text ?? ''),
          condition: option.condition.trim(),
          visited: visited.includes(chapterId),
        });
      }
    }
  }

  host.appendChild(heading('分支前置条件'));

  if (!points.length) {
    const empty = document.createElement('p');
    empty.className = 'set-note';
    empty.textContent = '这份剧本没有带条件的选项。';
    host.appendChild(empty);
  }

  points.forEach((point) => {
    const row = document.createElement('div');
    row.className = 'route-item' + (point.visited ? ' vis' : '');
    row.textContent = `${point.visited ? '已走到' : '未走到'} · ${point.where}：${point.text} — ${point.condition}`;
    host.appendChild(row);
  });

  // 变量明细：调试和确认分支条件都好用
  const names = Object.keys(vars);

  if (names.length) {
    host.appendChild(heading('变量'));

    const table = document.createElement('div');
    table.className = 'vars';
    table.textContent = names.map((name) => `${name} = ${vars[name]}`).join('\n');
    host.appendChild(table);
  }
}

function buildAssets(host) {
  els.panelTitle.textContent = '素材';

  // 背景和立绘分开导入：顺序无所谓，库是追加的
  const pickBg = document.createElement('button');
  pickBg.type = 'button';
  pickBg.className = 'primary';
  pickBg.textContent = '导入背景';
  pickBg.title = '选背景文件夹，只当背景收';
  pickBg.addEventListener('click', () => chooseAssets('background'));

  const pickChar = document.createElement('button');
  pickChar.type = 'button';
  pickChar.className = 'primary';
  pickChar.textContent = '导入立绘';
  pickChar.title = '选角色文件夹，只当立绘收（含各服装差分）';
  pickChar.addEventListener('click', () => chooseAssets('character'));

  const pickMusic = document.createElement('button');
  pickMusic.type = 'button';
  pickMusic.className = 'primary';
  pickMusic.textContent = '导入音乐';
  pickMusic.title = '选音乐文件夹，只当 BGM 收（mp3 / ogg / m4a / wav / flac…）';
  pickMusic.addEventListener('click', () => chooseAssets('music'));

  const pickFiles = document.createElement('button');
  pickFiles.type = 'button';
  pickFiles.textContent = '选散图…';
  pickFiles.title = '单独选几张图，按文件名自动判断是背景还是立绘';
  pickFiles.addEventListener('click', () => {
    importKind = '';
    $('assetImgs').click();
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(pickBg, pickChar, pickMusic, pickFiles);

  if (hasAssets()) {
    const wipe = document.createElement('button');
    wipe.type = 'button';
    wipe.textContent = '清空';
    wipe.addEventListener('click', async () => {
      await clearAssets();
      stopBgm();
      refreshAfterAssets();
      openPanel('assets');
      toast('已清空自定义素材');
    });

    actions.appendChild(wipe);
  }

  host.appendChild(actions);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.innerHTML =
    '「导入背景」「导入立绘」「导入音乐」分开点，先后顺序无所谓，都会追加进库里；也可以直接把文件夹拖进画面。<br>' +
    '有目录结构时按 <code>背景/</code>、<code>角色/&lt;角色名&gt;/</code> 放；分享包不用改目录，' +
    '<code>Miki_Cat_Seifuku_Smile_Blush.png</code> 会按 <code>角色_服装_表情_修饰</code> 自动认。<br>' +
    '表情/服装/场景支持中英日写法（微笑 = smile = 笑顔，害羞 = blush = 照れ，天台_傍晚 = rooftop_dusk = 屋上_夕暮れ）。<br>' +
    'BGM 放 <code>音乐/雨后.mp3</code>，文件名就是曲名；或 <code>音乐/雨后/track01.ogg</code> 用子目录名当曲名。' +
    '曲名同样认三语：雨后 = after_rain = 雨上がり，日常_轻松 = daily_light = 日常_軽やか。<br>' +
    '同一张图重复导入只会更新；整套换掉请点「清空」。';
  host.appendChild(hint);

  const now = stats();

  host.appendChild(panelHeading(`已导入 · 背景 ${now.backgrounds} / 角色 ${now.roles} / 差分 ${now.variations} / 音乐 ${now.music}`));

  if (!hasAssets()) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '还没有自定义素材，现在用的是内置那套。';
    host.appendChild(empty);
    return;
  }

  // 预览：全宽大图，背景铺底 + 立绘叠在中间，和之前一样
  const bgItems = backgroundVariations();
  const roles = roleList();

  let bgItem = null;
  let charItem = null;
  let paint = () => { };

  if (bgItems.length || roles.length) {
    host.appendChild(panelHeading('预览'));

    const stage = document.createElement('div');
    stage.className = 'asset-stage';

    const stageBg = document.createElement('div');
    stageBg.className = 'asset-stage-bg';

    const stageChar = document.createElement('div');
    stageChar.className = 'asset-stage-char';

    const stageCap = document.createElement('small');
    stageCap.className = 'asset-stage-cap';

    stage.append(stageBg, stageChar, stageCap);
    host.appendChild(stage);

    paint = () => {
      stageBg.style.backgroundImage = bgItem ? `url("${bgItem.url}")` : '';
      stageChar.style.backgroundImage = charItem ? `url("${charItem.url}")` : '';

      const parts = [];
      if (bgItem) parts.push(bgItem.name);
      if (charItem) {
        parts.push([charItem.clothes, ...charItem.tags].filter(Boolean).join(' · ') || '基础');
      }
      stageCap.textContent = parts.join(' / ') || '点下面的缩略图选背景和立绘';
    };
  }

  // 背景 / 角色各占一个标签页：一个页只显示一类，别挤在一栏里
  const tabBar = document.createElement('div');
  tabBar.className = 'asset-tabs';

  const bgPanel = document.createElement('div');
  bgPanel.className = 'asset-tab-panel';

  const charPanel = document.createElement('div');
  charPanel.className = 'asset-tab-panel';

  const musicPanel = document.createElement('div');
  musicPanel.className = 'asset-tab-panel';

  host.append(tabBar, bgPanel, charPanel, musicPanel);

  const makeTab = (label, name) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'asset-tab';
    tab.textContent = label;
    tab.addEventListener('click', () => showTab(name));
    return tab;
  };

  const tabBg = makeTab(`背景 ${bgItems.length}`, 'bg');
  const tabChar = makeTab(`角色 ${roles.length} 个 / ${now.variations} 张`, 'char');
  const tracks = musicList();
  const tabMusic = makeTab(`音乐 ${tracks.length}`, 'music');
  tabBar.append(tabBg, tabChar, tabMusic);

  function showTab(name) {
    tabBg.classList.toggle('active', name === 'bg');
    tabChar.classList.toggle('active', name === 'char');
    tabMusic.classList.toggle('active', name === 'music');
    bgPanel.classList.toggle('active', name === 'bg');
    charPanel.classList.toggle('active', name === 'char');
    musicPanel.classList.toggle('active', name === 'music');
  }

  if (!bgItems.length) {
    const bgEmpty = document.createElement('p');
    bgEmpty.className = 'hint';
    bgEmpty.textContent = '还没有背景，点上面的「导入背景」。';
    bgPanel.appendChild(bgEmpty);
  }

  if (!roles.length) {
    const charEmpty = document.createElement('p');
    charEmpty.className = 'hint';
    charEmpty.textContent = '还没有立绘，点上面的「导入立绘」。';
    charPanel.appendChild(charEmpty);
  }

  // 角色映射：剧本里的名字 → 素材包里的角色名（「你」是玩家，不用立绘）
  const castNames = Object.entries(story?.characters ?? {})
    .filter(([id, character]) => id !== 'you' && character?.name !== '你')
    .map(([id, character]) => character?.name ?? id);

  // live 模式的说话人来自主窗口的聊天角色名，不在剧本里也给它一条映射
  if (liveMode && liveRole && liveRole !== '你') castNames.push(liveRole);

  const names = [...new Set(castNames)].filter(Boolean);

  if (names.length) {
    charPanel.appendChild(panelHeading('角色映射 · 剧本 → 素材'));

    const mapHint = document.createElement('p');
    mapHint.className = 'hint';
    mapHint.textContent = '名字对不上时在这里指一下；留「自动」就按名字匹配，单角色包会自动用唯一那套。';
    charPanel.appendChild(mapHint);

    for (const name of names) {
      const row = document.createElement('label');
      row.className = 'asset-row';

      const label = document.createElement('b');
      label.textContent = name;

      const select = document.createElement('select');
      select.className = 'asset-role';

      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = '自动';
      select.appendChild(auto);

      for (const role of roleList()) {
        const option = document.createElement('option');
        option.value = role;
        option.textContent = role;
        select.appendChild(option);
      }

      select.value = roleAliases()[name] ?? '';
      select.addEventListener('change', () => {
        setRoleAlias(name, select.value);
        toast(select.value ? `${name} 改用 ${select.value} 的立绘` : `${name} 回到自动匹配`);
        refreshAfterAssets();
      });

      row.append(label, select);
      charPanel.appendChild(row);
    }
  }

  // BGM：列出来就能试听，导入后立即听得到
  if (!tracks.length) {
    const musicEmpty = document.createElement('p');
    musicEmpty.className = 'hint';
    musicEmpty.textContent = '还没有 BGM，点上面的「导入音乐」；曲名对上剧本的 music 就会自动播。';
    musicPanel.appendChild(musicEmpty);
  } else {
    const musicHint = document.createElement('p');
    musicHint.className = 'hint';
    musicHint.textContent = '试听会直接接管当前 BGM；点「回到剧本」恢复当前章节该放的那首。';
    musicPanel.appendChild(musicHint);

    const stopRow = document.createElement('div');
    stopRow.className = 'actions';

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = '回到剧本';
    restore.addEventListener('click', () => {
      restoreStageBgm();
      toast('已恢复剧本 BGM');
    });

    stopRow.appendChild(restore);
    musicPanel.appendChild(stopRow);

    for (const track of tracks) {
      const row = document.createElement('div');
      row.className = 'asset-row';

      const label = document.createElement('b');
      label.textContent = track.name;

      const path = document.createElement('small');
      path.className = 'asset-meta';
      path.textContent = track.path;

      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = '试听';
      play.addEventListener('click', () => {
        previewBgm(track.name);
        toast(`试听《${track.name}》`);
      });

      row.append(label, path, play);
      musicPanel.appendChild(row);
    }
  }

    // 背景列表
    if (bgItems.length) {
      bgPanel.appendChild(panelHeading(`背景 · ${bgItems.length}`));

      const home = readHomeBg();
      const homeHint = document.createElement('p');
      homeHint.className = 'hint';
      homeHint.textContent = home
        ? `常驻背景：${home}。鼠标移到缩略图上点右上角 ★ 可取消；剧本或模型明确写了场景时仍按剧情切换。`
        : '鼠标移到缩略图上，点右上角 ☆ 设为常驻；不设也可以，没有场景的台词就沿用上一张背景。';
      bgPanel.appendChild(homeHint);

      const bgGrid = document.createElement('div');
      bgGrid.className = 'asset-thumbs';

      const bgThumbs = [];

      for (const item of bgItems) {
        const thumb = document.createElement('figure');
        thumb.className = `asset-thumb asset-thumb-bg${home === item.name ? ' pinned' : ''}`;
        thumb.title = item.path;

        const img = document.createElement('img');
        img.src = item.url;
        img.alt = item.name;
        img.loading = 'lazy';

        const cap = document.createElement('figcaption');
        cap.textContent = home === item.name ? `${item.name} · 常驻` : item.name;

        // 常驻背景是单选：平时只在当前那张上露出实心图钉，其余 hover 才看得到空心图钉
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = `asset-pin${home === item.name ? ' on' : ''}`;
        pin.textContent = home === item.name ? '★' : '☆';
        pin.title = home === item.name ? '取消常驻背景' : '设为常驻背景';
        pin.setAttribute('aria-label', pin.title);
        pin.addEventListener('click', (event) => {
          event.stopPropagation();

          const next = home === item.name ? '' : item.name;
          setHomeBg(next);
          toast(next ? `常驻背景已设为 ${item.name}` : '已取消常驻背景');
          refreshAfterAssets();
          openPanel('assets');
        });

        thumb.append(img, cap, pin);
        thumb.addEventListener('click', () => {
          bgItem = item;
          for (const node of bgThumbs) node.classList.toggle('active', node === thumb);
          paint();
        });

        bgThumbs.push(thumb);
        bgGrid.appendChild(thumb);
      }

      bgPanel.appendChild(bgGrid);
    }

    // 角色
    if (roles.length) {
      charPanel.appendChild(panelHeading('差分列表'));

      const charGrid = document.createElement('div');
      charGrid.className = 'asset-thumbs';

      let charThumbs = [];

      const showChars = (role) => {
        lastSelectedRole = role;
        charGrid.textContent = '';
        charThumbs = [];

        for (const item of characterVariations(role)) {
          const thumb = document.createElement('figure');
          thumb.className = 'asset-thumb';
          thumb.title = item.path;

          const img = document.createElement('img');
          img.src = item.url;
          img.alt = item.tags.join(' ');
          img.loading = 'lazy';

          const cap = document.createElement('figcaption');
          cap.textContent = [item.clothes, ...item.tags].filter(Boolean).join(' · ') || '基础';

          thumb.append(img, cap);
          thumb.addEventListener('click', () => {
            charItem = item;
            for (const node of charThumbs) node.classList.toggle('active', node === thumb);
            paint();
          });

          charThumbs.push(thumb);
          charGrid.appendChild(thumb);
        }
      };

      // 一个包里拆出多个角色时，先选看哪个；重绘后接着看上次选的那个
      const initialRole = lastSelectedRole && roles.includes(lastSelectedRole) ? lastSelectedRole : roles[0];

      if (roles.length > 1) {
        const roleRow = document.createElement('label');
        roleRow.className = 'asset-row';

        const roleLabel = document.createElement('b');
        roleLabel.textContent = '素材角色';

        const roleSelect = document.createElement('select');
        roleSelect.className = 'asset-role';

        for (const role of roles) {
          const option = document.createElement('option');
          option.value = role;
          option.textContent = role;
          roleSelect.appendChild(option);
        }

        roleSelect.value = initialRole;
        roleSelect.addEventListener('change', () => {
          lastSelectedRole = roleSelect.value;
          showChars(roleSelect.value);
          charGrid.firstElementChild?.click();
        });

        roleRow.append(roleLabel, roleSelect);
        charPanel.appendChild(roleRow);
      }

      charPanel.appendChild(charGrid);
      showChars(initialRole);
    }

    // 默认页：只有一类就切那类；都有时停在刚导入的那类
    if (!bgItems.length && !roles.length && tracks.length) showTab('music');
    else if (lastImportKind === 'music' && tracks.length) showTab('music');
    else if (!roles.length) showTab('bg');
    else if (!bgItems.length) showTab('char');
    else showTab(lastImportKind === 'background' ? 'bg' : 'char');

    // 打开面板先各亮一张，直接看到组合效果
    if (bgItems.length) host.querySelector('.asset-thumb-bg')?.click();
    host.querySelector('.asset-thumb:not(.asset-thumb-bg)')?.click();
}

let importKind = '';
let lastImportKind = '';
let lastSelectedRole = '';

/** 「导入背景」「导入立绘」共用同一个文件夹选择框，靠 importKind 区分收进哪一类 */
function chooseAssets(kind) {
  importKind = kind;
  $('assetDir').click();
}

async function importFromInput(input) {
  const entries = entriesFromFileList(input.files);
  input.value = '';

  const kind = importKind;
  importKind = '';
  await runImport(entries, kind);
}

async function runImport(entries, kind = '') {
  if (!entries.length) {
    toast('没有读到文件');
    return;
  }

  const before = stats();
  const { imported, added, replaced } = await importEntries(entries, kind);
  const after = stats();

  // 重新打开面板时停在刚导入的那类，省得再切一下
  lastImportKind = kind === 'background' || kind === 'character' || kind === 'music'
    ? kind
    : (after.backgrounds > before.backgrounds ? 'background' : after.music > before.music ? 'music' : 'character');

  if (!imported) {
    toast('没识别到素材（图片 png/jpg/webp，音乐 mp3/ogg/m4a/wav/flac）');
    return;
  }

  refreshAfterAssets();
  openPanel('assets');

  if (kind === 'music') {
    toast(replaced ? `已导入 ${imported} 首（更新 ${replaced}）` : `已追加 ${imported} 首 BGM`);
    return;
  }

  toast(replaced ? `已导入 ${imported} 张（新增 ${added} / 更新 ${replaced}）` : `已追加 ${imported} 张`);
}

/** 导入/清空之后把画面重画一遍，别等下一次推进才生效 */
function refreshAfterAssets() {
  if (liveMode) {
    const last = liveHistory.at(-1);

    if (last) {
      // 清空素材后必须把背景退回内置那张，否则会留下已 revoke 的 blob URL
      if (!readLiveTags(last.text)['场景']) applyDefaultBackground();
      playLiveMessage(last);
    } else {
      applyDefaultBackground();
      renderLiveCast(els.speaker.textContent || '她');
    }

    return;
  }

  if (engine) {
    render(engine.currentFrame());
    return;
  }

  renderLiveCast(els.speaker.textContent || '她');
}



/** 设置面板：左侧分类 + 右侧表单 */
function buildSettings(host) {
  els.panelTitle.textContent = '设置';

  const s = getSettings();

  const wrap = document.createElement('div');
  wrap.className = 'set-wrap';

  const nav = document.createElement('nav');
  nav.className = 'set-nav';

  const body = document.createElement('div');
  body.className = 'set-body';

  const pages = [
    { id: 'play', label: '演出', build: renderPlay },
    { id: 'look', label: '外观', build: renderLook },
    { id: 'about', label: '关于', build: renderAbout },
  ];

  const show = (id) => {
    for (const button of nav.children) button.classList.toggle('on', button.dataset.id === id);

    body.innerHTML = '';
    pages.find((page) => page.id === id)?.build(body);
  };

  for (const page of pages) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = page.id;
    button.textContent = page.label;
    button.addEventListener('click', () => show(page.id));
    nav.appendChild(button);
  }

  wrap.append(nav, body);
  host.appendChild(wrap);
  show('play');

  function renderPlay(box) {
    box.appendChild(setSection('打字机', '文字逐字出现的节奏，改完立即生效'));

    box.appendChild(
      setRow('文字速度', '1 = 很慢，100 = 一瞬；改完下一句立即生效', setSlider({
        min: 1, max: 100, step: 1, value: s.speed,
        format: (v) => String(v),
        onInput: (v) => {
          saveSettings({ speed: v });
          applyTypingSettings();
        },
      })),
    );

    box.appendChild(
      setRow('自动播放速度', '数值越大，每句结束停得越久；有语音时会等语音念完', setSlider({
        min: 200, max: 3000, step: 100, value: s.autoDelay,
        format: (v) => `${(v / 1000).toFixed(1)}s`,
        onInput: (v) => saveSettings({ autoDelay: v }),
      })),
    );

    box.appendChild(
      setRow('自动播放', '每句打完后自动往下走，选项仍然等你点', setToggle(s.autoPlay, (on) => saveSettings({ autoPlay: on }))),
    );

    box.appendChild(
      setRow('跳过已读', '同一句第二次出现时直接整句显示，不再逐字', setToggle(s.skipRead, (on) => saveSettings({ skipRead: on }))),
    );

    if (liveMode) {
      box.appendChild(
        setRow('纯聊天模式', '只演聊天内容，不插入预设剧本的台词/选项，也不放剧本 BGM；专门测语音时打开', setToggle(s.chatOnly, (on) => {
          saveSettings({ chatOnly: on });
          applyChatOnly(on);
          toast(on ? '纯聊天模式：开' : '纯聊天模式：关，预设剧本已挂回');
        })),
      );
    }
    box.appendChild(setSection('声音', '打字音效由 WebAudio 合成；BGM 用素材页导入的音乐文件'));

    box.appendChild(
      setRow('全部静音', 'BGM / 语音 / 音效一起关。开着还听到声音，就说明来自 Alife 宿主或系统，不是本插件', setToggle(s.masterMute, (on) => {
        applyMasterMute(on);
        toast(on ? '已全部静音' : '声音已恢复');
      })),
    );

    box.appendChild(
      setRow('打字音效', '关掉后完全静音', setToggle(s.typingSound, (on) => {
        saveSettings({ typingSound: on });
        applyTypingSettings();
      })),
    );

    box.appendChild(
      setRow('音效音量', '0 就是静音', setSlider({
        min: 0, max: 100, step: 5, value: s.soundVolume,
        format: (v) => `${v}%`,
        onInput: (v) => {
          saveSettings({ soundVolume: v });
          applyTypingSettings();
        },
      })),
    );

    box.appendChild(
      setRow('背景音乐音量', 'BGM 大小，0 = 静音；当前曲目立即跟着变', setSlider({
        min: 0, max: 100, step: 5, value: s.bgmVolume,
        format: (v) => `${v}%`,
        onInput: (v) => {
          saveSettings({ bgmVolume: v });
          applyBgmVolume();
        },
      })),
    );

    box.appendChild(setSection('语音朗读', ttsReady()
      ? '只读当前显示的一小段；下一段会提前合成，点过去就能直接播'
      : '未检测到语音模型：安装并启用语音插件（VITS / CosyVoice2）后重开窗口'));

    box.appendChild(
      setRow('台词朗读', '一句一语音；点下一句会立刻停掉上一句', setToggle(s.voiceOn, (on) => {
        saveSettings({ voiceOn: on });
        if (!on) stopSpeech();
      })),
    );

    box.appendChild(
      setRow('旁白朗读', '默认连旁白一起读；关掉后只读对白', setToggle(s.voiceNarr, (on) => {
        saveSettings({ voiceNarr: on });
        if (!on) stopSpeech();
      })),
    );

    box.appendChild(
      setRow('语速', '0.5 = 慢一倍，1.0 = 原速，1.5 = 偏快；变速不变调，念到一半也会立刻生效', setSlider({
        min: 50, max: 150, step: 5, value: Math.round(s.voiceRate * 100),
        format: (v) => `${Number((v / 100).toFixed(2))}×`,
        onInput: (v) => {
          saveSettings({ voiceRate: v / 100 });
          applyVoiceVolume();
        },
      })),
    );

    box.appendChild(
      setRow('人声大小', '语音朗读的音量，只影响人声，不影响 BGM', setSlider({
        min: 0, max: 100, step: 5, value: s.voiceVolume,
        format: (v) => `${v}%`,
        onInput: (v) => {
          saveSettings({ voiceVolume: v });
          applyVoiceVolume();
        },
      })),
    );

    box.appendChild(setSection('记忆与隔离', liveMode
      ? '只影响 live 陪伴模式：开启隔离后，剧情不写进主聊天与 Alife 记忆'
      : '隔离模式在 live 陪伴窗口里生效；剧本模式本来就不写主聊天'));

    const isolateReady = !liveMode || liveCanIsolate;
    const isolateToggle = setToggle(isolateReady ? s.isolation : false, (on) => {
      if (on && liveMode && !liveCanIsolate) {
        toast('当前版本不支持记忆隔离');
        return;
      }

      saveSettings({ isolation: on });

      if (!liveMode) return;

      if (on) {
        saveIsolatedHistory(liveHistory);
        toast('已开启隔离：之后的剧情不写主聊天记忆');
      } else {
        void resetLiveBaseline();
        toast('已关闭隔离：恢复主聊天与记忆联动');
      }
    });

    if (!isolateReady) {
      isolateToggle.disabled = true;
      isolateToggle.textContent = '不可用';
      isolateToggle.classList.remove('on');
    }

    box.appendChild(setRow('记忆隔离（防注入）', '开启后剧情只在窗口里留存，不写主聊天与 Alife 记忆；关掉则恢复关系 / 人格联动', isolateToggle));

    const isolateTip = document.createElement('p');
    isolateTip.className = 'set-note';
    isolateTip.textContent = liveMode && !liveCanIsolate
      ? '当前宿主没有可用的隔离接口：需要 Alife 的模型组件支持直接对话。'
      : '隔离模式带不过 Alife 的长期记忆；想让认知 / 情绪随关系延续，就关掉它，让对话正常进入主聊天。';
    box.appendChild(isolateTip);

    if (liveMode) {
      const kept = readIsolatedHistory();
      const actions = document.createElement('div');
      actions.className = 'actions';

      const view = document.createElement('button');
      view.type = 'button';
      view.textContent = `查看隔离剧情（${kept.length}）`;
      view.disabled = !kept.length;
      view.addEventListener('click', () => openPanel('isolated'));

      const exportIsolated = document.createElement('button');
      exportIsolated.type = 'button';
      exportIsolated.textContent = '导出隔离 TXT';
      exportIsolated.disabled = !kept.length;
      exportIsolated.addEventListener('click', () => void exportTranscript(buildIsolatedTranscript()));

      actions.append(view, exportIsolated);
      box.appendChild(actions);
    }

    box.appendChild(setSection('记录与分享', '全文只写本地文件，不依赖 Alife 的聊天记忆'));

    box.appendChild(
      setRow('结局自动导出', '看到结局时把整段剧情存成 TXT，放在「文档 / Alife / 剧情导出」', setToggle(s.autoExport, (on) => saveSettings({ autoExport: on }))),
    );

    const tip = document.createElement('p');
    tip.className = 'set-note';
    tip.textContent = '随时可以在「回看」面板点「导出全文 TXT」或「复制全文」，完整对话都能带走。';
    box.appendChild(tip);
  }

  function renderLook(box) {
    box.appendChild(setSection('对话框', '字号影响台词区，文本会按宽度自动折行'));

    box.appendChild(
      setRow('正文字号', '14–28px，默认 18px', setSlider({
        min: 14, max: 28, step: 1, value: s.fontSize,
        format: (v) => `${v}px`,
        onInput: (v) => saveSettings({ fontSize: v }),
      })),
    );

    box.appendChild(
      setRow('旁白字号', '0 = 跟正文一致；长段描写可以单独调大', setSlider({
        min: 0, max: 32, step: 1, value: s.narrSize,
        format: (v) => (v === 0 ? '跟正文' : `${v}px`),
        onInput: (v) => saveSettings({ narrSize: v }),
      })),
    );

    box.appendChild(
      setRow('旁白透明度', '30–100%，只影响旁白，台词不变', setSlider({
        min: 30, max: 100, step: 2, value: s.narrOpacity,
        format: (v) => `${v}%`,
        onInput: (v) => saveSettings({ narrOpacity: v }),
      })),
    );

    box.appendChild(
      setRow('对话框不透明度', '30–100%，调低能透出更多背景；只淡花边框，文字不变', setSlider({
        min: 30, max: 100, step: 2, value: s.dialogueOpacity,
        format: (v) => `${v}%`,
        onInput: (v) => saveSettings({ dialogueOpacity: v }),
      })),
    );
    box.appendChild(setSection('动效', '弱机型或晕动症可以关掉'));

    box.appendChild(
      setRow('减少动效', '关掉逐字上浮与立绘过渡', setToggle(s.reduceMotion, (on) => saveSettings({ reduceMotion: on }))),
    );
  }

  function renderAbout(box) {
    box.appendChild(setSection('当前版本', 'GAL 剧情窗口'));

    const note = document.createElement('p');
    note.className = 'set-note';
    note.textContent = `注入脚本 ${window.__alifeGalVer ?? '—'}；设置存在 localStorage 的 gal-script:ux 下，重开窗口仍然生效。`;
    box.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '恢复默认演出';
    reset.addEventListener('click', () => {
      saveSettings({
        speed: 62, autoDelay: 1200, fontSize: 18, narrSize: 0,
        dialogueOpacity: 100,
        masterMute: false,
        typingSound: true, soundVolume: 45, bgmVolume: 55,
        voiceOn: true, voiceNarr: true, voiceVolume: 100, voiceRate: 1, reduceMotion: false,
        autoExport: true, isolation: false, chatOnly: true,
      });
      applyMasterMute(false);
      openPanel('settings');
      toast('已恢复默认');
    });

    actions.appendChild(reset);
    box.appendChild(actions);
  }
}

function setSection(title, hint) {
  const node = document.createElement('div');
  node.className = 'set-section';
  node.innerHTML = `<b>${title}</b><small>${hint}</small>`;
  return node;
}

function setRow(label, hint, control) {
  const row = document.createElement('div');
  row.className = 'set-row';

  const text = document.createElement('div');
  text.className = 'set-label';
  text.innerHTML = `<b>${label}</b><small>${hint}</small>`;

  row.append(text, control);
  return row;
}

function setSlider({ min, max, step = 1, value, format, onInput }) {
  const wrap = document.createElement('div');
  wrap.className = 'range';

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);

  const output = document.createElement('span');
  output.className = 'value';
  output.textContent = format(Number(value));

  input.addEventListener('input', () => {
    const next = Number(input.value);
    output.textContent = format(next);
    onInput(next);
  });

  wrap.append(input, output);
  return wrap;
}

function setToggle(value, onToggle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `switch${value ? ' on' : ''}`;
  button.textContent = value ? '开' : '关';

  button.addEventListener('click', () => {
    const next = !button.classList.contains('on');
    button.classList.toggle('on', next);
    button.textContent = next ? '开' : '关';
    onToggle(next);
  });

  return button;
}

function buildHelp(host) {
  els.panelTitle.textContent = '快捷键';

  const grid = document.createElement('div');
  grid.className = 'keys';

  for (const row of shortcutRows()) {
    const label = document.createElement('span');
    label.textContent = row.label;

    const keys = document.createElement('span');
    keys.textContent = row.keys;

    grid.append(label, keys);
  }

  host.appendChild(grid);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '输入框里只有 Esc 和带 Ctrl 的组合生效。选项出现后可以直接按数字键。';
  host.appendChild(hint);
}

function panelHeading(text) {
  const node = document.createElement('div');
  node.className = 'panel-heading';
  node.textContent = text;
  return node;
}

function panelField(label, control) {
  const row = document.createElement('div');
  row.className = 'field';

  const tag = document.createElement('label');
  tag.textContent = label;

  row.append(tag, control);
  return row;
}

function collectCGs(book = story) {
  const map = new Map();

  for (const events of Object.values(book?.chapters ?? {})) {
    for (const event of events) {
      if (event.type !== 'present_pic') continue;
      const path = String(event.path ?? '');
      if (path) map.set(path, { path, title: event.title ?? path });
    }
  }

  return [...map.values()];
}

function collectEndings(book = story) {
  const map = new Map();

  for (const events of Object.values(book?.chapters ?? {})) {
    for (const event of events) {
      if (event.type !== 'chapter_end') continue;
      const id = event.ending_id;
      if (id) map.set(id, { id, title: event.ending_title ?? id, desc: event.ending_desc ?? '' });
    }
  }

  return [...map.values()];
}

function achievements(book = story) {
  const map = {};

  for (const events of Object.values(book?.chapters ?? {})) {
    for (const event of events) {
      if (event.type === 'achievement' && event.id) map[event.id] = event.title ?? event.id;
    }
  }

  return map;
}

// ------------------------------------------------------------------ 存档

/** 自动存档的环形指针：依次写 auto1 → auto2 → auto3，再回到 auto1 */
function nextAutoSlot() {
  const key = `${SAVE_PREFIX}${story?.id ?? 'story'}:auto-ring`;
  let next = 1;

  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw >= 1 && raw <= AUTO_RING_LIMIT) next = raw;
  } catch {
    // 存储不可用时照常返回 auto1，写盘失败会在 saveTo 里提示
  }

  try { localStorage.setItem(key, String((next % AUTO_RING_LIMIT) + 1)); } catch { }

  return `auto${next}`;
}

function saveTo(slot, silent = false) {
  if (!engine) return;

  if (slot === 'auto' && engine.finished) return;

  const target = slot === 'auto' ? nextAutoSlot() : slot;
  const payload = engine.save(slot === 'auto' ? `自动 · ${engine.chapterId}` : `存档 · ${engine.chapterId}`);

  try {
    localStorage.setItem(keyOf(target), JSON.stringify(payload));
  } catch (error) {
    toast('存档失败：浏览器存储不可用');
    console.warn(error);
    return;
  }

  if (!silent) toast('已存档');
}

function loadFrom(slot) {
  const data = readSave(slot);

  if (!data) return;

  try {
    engine = StoryEngine.restore(data, story);
    mergeGallery(engine);
    lastChapter = engine.chapterId;
    closePanel();
    render(engine.currentFrame());
    toast('已读档');
  } catch (error) {
    toast(`读档失败：${error.message}`);
  }
}

function readSave(slot) {
  try {
    const raw = localStorage.getItem(keyOf(slot));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function keyOf(slot) {
  return `${SAVE_PREFIX}${story?.id ?? 'story'}:${slot}`;
}

/** 图鉴是跨周目资产：换个存档重开，收集也还在。 */
function galleryKey(id = story?.id ?? 'story') {
  return `gal-script:gallery:${id}`;
}

function readGallery() {
  try {
    return JSON.parse(localStorage.getItem(galleryKey()) ?? '{}');
  } catch {
    return {};
  }
}

function mergeGallery(target) {
  const saved = readGallery();

  for (const item of saved.cg ?? []) target.unlockedCG.add(item);
  for (const item of saved.endings ?? []) target.endings.add(item);
  for (const item of saved.achievements ?? []) target.achievements.add(item);
}

function syncGallery(target) {
  try {
    localStorage.setItem(
      galleryKey(),
      JSON.stringify({
        cg: [...target.unlockedCG],
        endings: [...target.endings],
        achievements: [...target.achievements],
      }),
    );
  } catch {
    // 隐私模式下写不进去，不影响游戏
  }
}

// ------------------------------------------------------------------ 杂项

function toggleAuto(button) {
  autoOn = !autoOn;
  button?.classList.toggle('active', autoOn);
  document.getElementById('uxBar')?.classList.toggle('auto-on', autoOn);
  toast(autoOn ? '自动播放：开' : '自动播放：关');

  if (!autoOn) {
    clearAuto();
    return;
  }

  if (writer && writer.done) scheduleAutoAdvance(autoDelayMs());
}

/** 自动推进：先等这一小段语音念完，再走下一句；关掉自动时立刻停 */
function scheduleAutoAdvance(delay) {
  clearAuto();

  const tick = () => {
    if (!autoOn) return;

    const wait = voiceRemainingMs();

    if (wait > 0) {
      autoTimer = setTimeout(tick, Math.min(600, wait));
      return;
    }

    advance();
  };

  autoTimer = setTimeout(tick, delay);
}

let fastTimer = null;

/** 按住 Ctrl 快进：连点推进，松开即停 */
function startFast() {
  if (fastTimer) return;

  fast = true;
  advance();

  fastTimer = setInterval(() => {
    if (!fast) return;
    advance();
  }, 260);
}

function stopFast() {
  fast = false;

  if (fastTimer) clearInterval(fastTimer);
  fastTimer = null;
}

function clearAuto() {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
}

let toastTimer = null;

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 1800);
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

/** 没有专门配色时，用名字算一个稳定的渐变，至少不同场景能区分开。 */
function hashGradient(name) {
  let hash = 0;

  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360;

  const a = hash;
  const b = (hash + 42) % 360;

  return `radial-gradient(120% 90% at 50% 0%, hsl(${a} 38% 26%) 0%, hsl(${b} 40% 14%) 55%, #05070c 100%)`;
}