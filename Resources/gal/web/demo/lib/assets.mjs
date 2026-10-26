/**
 * 自定义素材库：把用户自己选的文件夹扫成「背景表 + 角色差分表」。
 *
 * 两种放法都认：
 *   1. 结构化（和 gv-app 一致）
 *      assets/
 *        背景/               每张图一个场景，文件名就是场景名
 *          卧室_夜晚.png
 *        角色/
 *          诺艾尔/           一个子目录一个角色
 *            基础.png        兜底
 *            女仆装_害羞.png 文件名用 _ 分词，每个词都是标签
 *            泳装/           再套一层目录 = 服装
 *              基础.png
 *   2. 分享包的英文组合命名（不需要 背景/、角色/ 目录）
 *      Miki_Cat_Seifuku_Smile_Blush.png
 *      = 角色_变体_服装_表情_修饰，直接选整个包目录就能导入。
 *   3. BGM（音乐/、bgm/、音楽/ 都认）
 *      音乐/雨后.mp3           文件名就是曲名
 *      音乐/雨后/track01.ogg   子目录名当曲名，曲名随意
 *
 * 名字里中文、英文、日文写法等价：微笑 = smile = 笑顔，害羞 = blush = 照れ。
 * 曲名同理：雨后 = after_rain = 雨上がり，日常_轻松 = daily_light。
 * 浏览器和 WebView2 都拿不到"长期目录句柄"，所以图片以 Blob 存进 IndexedDB，
 * 下次打开自动恢复；只在真正要显示时才 createObjectURL，避免一次生成几十个 URL。
 */

const DB_NAME = 'gal-assets';
const STORE = 'files';
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;
const AUDIO_RE = /\.(mp3|ogg|oga|m4a|aac|wav|flac|webm|opus)$/i;
const BASE_NAMES = new Set(['基础', 'base', 'default', '普通', 'normal', 'stand', '正常']);

// ------------------------------------------------------------------ 命名词表

/** 角色名前面的无义词：`char_xxx_smile` / `立ち絵_ミキ_笑顔` 里的 char、立ち絵 不算角色名 */
const GENERIC_ROOTS = new Set([
  'char', 'chars', 'character', 'characters', 'sprite', 'sprites', 'img', 'image', 'pic',
  '角色', '人物', '立绘', '立ち絵', 'スチル',
]);

/** 表情：中文规范名 → 三种语言的写法 */
const EXPRESSION_ALIASES = {
  普通: ['normal', 'base', 'default', '普通', '基础', '正常', 'ノーマル'],
  平静: ['calm', '平静', '冷静', '落ち着き'],
  微笑: ['smile', '微笑', '笑颜', '笑顔', 'スマイル'],
  害羞: ['shy', 'blush', '害羞', '羞涩', '脸红', '照れ', '赤面'],
  噘嘴: ['pout', '噘嘴', '撅嘴', 'むくれ'],
  难过: ['sad', 'cry', '难过', '悲伤', '泣き', '悲しい'],
  生气: ['angry', '生气', '愤怒', '怒り'],
  惊讶: ['surprise', 'surprised', '惊讶', '吃惊', '驚き'],
  思考: ['think', '思考', '考え'],
  皱眉: ['frown', '皱眉', '不悦', 'しかめ'],
  闭眼: ['closedeyes', 'eyesclosed', '闭眼', '目閉じ', '目を閉じる'],
  张嘴: ['open', '张嘴', '张口', '口開け'],
};

/** 服装：中文规范名 → 三种语言的写法 */
const OUTFIT_ALIASES = {
  制服: ['seifuku', 'uniform', 'blazer', 'school', '制服', 'セーラー服'],
  便服: ['casual', 'private', '便服', '私服', '常服', 'カジュアル'],
  体操服: ['gym', 'jersey', '体操服', '运动服', 'ジャージ'],
  巫女: ['miko', '巫女', '巫女服', 'みこ'],
  泳装: ['swimsuit', 'bikini', '泳装', '泳衣', '水着'],
  女仆装: ['maid', '女仆装', 'メイド'],
  和服: ['kimono', 'yukata', '和服', '浴衣', '着物'],
  睡衣: ['pajama', 'pyjama', '睡衣', 'パジャマ'],
};

/** 场景地点：支持 `rooftop_dusk`、`屋上_夕暮れ` 这种写法 */
const SCENE_LOCATIONS = {
  天台: ['天台', 'rooftop', 'roof', '屋上'],
  城市: ['城市', 'city', '街景', 'シティ'],
  街道: ['街道', 'street', '通り'],
  后巷: ['后巷', 'alley', '路地'],
  学校走廊: ['走廊', 'hallway', 'corridor', '廊下'],
  卧室: ['卧室', 'bedroom', '寝室'],
  厨房: ['厨房', 'kitchen', '台所'],
  客厅: ['客厅', 'livingroom', 'living', '居間', 'リビング'],
  起居室: ['起居室', 'sittingroom', '茶之间'],
  浴室: ['浴室', 'bathroom', '风吕', '風呂'],
  食堂: ['食堂', 'cafeteria', '学食'],
  餐厅: ['餐厅', 'restaurant', 'レストラン'],
  餐厅卡座: ['卡座', 'booth', '卡位'],
  咖啡厅: ['咖啡厅', 'cafe', '喫茶店'],
  神社: ['神社', 'shrine', 'お社'],
  寺庙: ['寺庙', 'temple', 'お寺'],
  木桥: ['木桥', 'bridge', '橋'],
  海边电车: ['海边', 'seaside', '海辺'],
  电车: ['电车', 'tram', 'train', '電車'],
  温泉旅馆: ['温泉', 'onsen', 'ryokan', '旅館'],
  公交站: ['公交站', 'busstop', 'bus', 'バス停'],
  和室: ['和室', 'washitsu', 'tatami', '畳'],
};

/** 时间 / 天气 */
const SCENE_TIMES = {
  清晨: ['清晨', 'morning', '朝', 'dawn'],
  白天: ['白天', 'day', 'noon', '昼'],
  午后: ['午后', 'afternoon', '昼下がり'],
  傍晚: ['傍晚', '黄昏', 'dusk', 'sunset', 'evening', '夕方', '夕暮れ'],
  夜晚: ['夜晚', '夜', 'night', 'よる'],
  雨: ['雨', 'rain', '雨天', 'あめ'],
};

const normalizeKey = (value) => String(value ?? '').trim().toLowerCase();
const normalizeScene = (value) => normalizeKey(value).replace(/[_\-\s·・]+/g, '');

/** 音乐目录：`音乐/`、`bgm/`、`音楽/` 都认；没有目录时按扩展名收 */
const MUSIC_DIR = /^(音乐|背景音乐|bgm|music|ost|soundtrack|音楽)$/i;

/** 曲名：剧本 music.path 的几种写法，中英日等价 */
const MUSIC_TITLES = {
  雨后: ['afterrain', 'rain_after', '雨上がり', '雨後'],
  天台上的海: ['seaontherooftop', 'rooftop_sea', '屋上に海'],
  湿掉的鞋: ['wetshoes', 'wet_shoes', '濡れた靴', 'wet_shoe'],
};

/** 氛围词：`bgm_日常_轻松` / `daily_light` / `日常_軽やか` 都能对上 */
const MUSIC_MOODS = {
  日常: ['日常', 'daily', 'everyday', 'にちじょう'],
  轻松: ['轻松', 'light', 'relaxed', '軽やか', 'のんびり'],
  温柔: ['温柔', 'gentle', 'soft', '優しい'],
  紧张: ['紧张', 'tense', 'suspense', '緊張'],
  悲伤: ['悲伤', 'sad', 'sorrow', '悲しい'],
  神秘: ['神秘', 'mystery', 'mysterious', 'ミステリアス'],
  战斗: ['战斗', 'battle', 'fight', '戦闘'],
  回忆: ['回忆', 'memory', 'memories', '思い出'],
  告白: ['告白', 'confession', 'kokuhaku'],
  离别: ['离别', 'farewell', 'parting', '別れ'],
  雨: ['雨', 'rain', 'rainy', 'あめ'],
  夜: ['夜', 'night', 'よる'],
  海: ['海', 'sea', 'ocean', '海辺'],
  天台: ['天台', 'rooftop', 'roof', '屋上'],
};

const splitTokens = (name) =>
  stripExt(name)
    .split(/[_\-—\s·・]+/)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * 在词表里找一个 token：先精确匹配；`OpenSmile` / `ClosedEyes` 这种拼在一起的，
 * 再按英文包含关系拆一次（只对 3 个字母以上的英文词做），避免误伤短词。
 * 返回所有命中的规范词：`OpenSmile` → [微笑, 张嘴]。
 */
function findAliases(token, dict) {
  const key = normalizeKey(token);
  const found = [];
  if (!key) return found;

  for (const [canon, aliases] of Object.entries(dict)) {
    if (aliases.some((alias) => normalizeKey(alias) === key)) found.push(canon);
  }

  if (found.length || !/^[a-z]+$/.test(key)) return found;

  for (const [canon, aliases] of Object.entries(dict)) {
    if (aliases.some((alias) => /^[a-z]+$/.test(alias) && alias.length >= 3 && key.includes(alias))) {
      found.push(canon);
    }
  }

  return found;
}

const findAlias = (token, dict) => findAliases(token, dict)[0] ?? '';

function matchOutfit(value) {
  for (const part of splitTokens(value)) {
    const found = findAlias(part, OUTFIT_ALIASES);
    if (found) return found;
  }

  return '';
}

/** 目录名里找服装：`Blazer Uni`、`Miki Gym Pack`、`Miko` 都能认 */
function clothesFromDirs(dirs) {
  for (let index = dirs.length - 1; index >= 0; index -= 1) {
    const outfit = matchOutfit(dirs[index]);
    if (outfit) return outfit;
  }

  return '';
}

/**
 * 拆一个立绘文件名 → 角色 / 服装 / 标签 / 是否基础图。
 * `Miki_Cat_Seifuku_Smile_Blush` → 角色 Miki、服装 制服、标签 [微笑, 害羞, Cat]
 */
function parseSpriteName(filename) {
  const tokens = splitTokens(filename);
  const tags = [];
  const aliases = [];
  let role = '';
  let clothes = '';
  let hasExpression = false;
  let explicitBase = false;

  for (const token of tokens) {
    aliases.push(normalizeKey(token));

    const expressions = findAliases(token, EXPRESSION_ALIASES);
    if (expressions.length) {
      hasExpression = true;
      if (expressions.includes('普通')) explicitBase = true;

      for (const expression of expressions) {
        if (!tags.includes(expression)) tags.push(expression);
      }
      continue;
    }

    const outfits = findAliases(token, OUTFIT_ALIASES);
    if (outfits.length) {
      if (!clothes) clothes = outfits[0];

      for (const outfit of outfits) {
        if (!tags.includes(outfit)) tags.push(outfit);
      }
      continue;
    }

    if (GENERIC_ROOTS.has(normalizeKey(token)) || BASE_NAMES.has(normalizeKey(token))) continue;

    // 第一个认不出的词当角色名，后面的都是变体（Cat、Mikicat 之类）
    if (!role) role = token;
    else if (!tags.includes(token)) tags.push(token);
  }

  return {
    role,
    clothes,
    tags,
    aliases,
    base: explicitBase || !hasExpression,
    character: hasExpression || Boolean(clothes),
  };
}

/** 包里没有「基础」图时，挑一张最中性的当兜底（微笑、无 Blush / 闭眼优先） */
function ensureBase(list) {
  if (!list.length || list.some((item) => item.base)) return;

  const plain = (item) => !item.tags.some((tag) => tag === '害羞' || tag === '闭眼' || tag === '张嘴');

  const pick =
    list.find((item) => item.tags.includes('微笑') && plain(item)) ??
    list.find((item) => item.tags.includes('平静') && plain(item)) ??
    list.find(plain) ??
    list[0];

  pick.base = true;
}


export const library = {
  backgrounds: [],
  characters: new Map(),
  /** BGM：{ name, path, blob }，name 就是剧本 music.path 里的曲名 */
  music: [],
  updatedAt: 0,
};

let objectUrls = new Map();

// ------------------------------------------------------------------ 角色映射

/**
 * 剧本里的角色名 → 素材包里的角色名。
 * 比如剧本叫「汐」、分享包叫 `Miki`，就在这里配一条 `汐 → Miki`。
 * 存在 localStorage，跟着素材走，换剧本也不丢。
 */
const ROLE_MAP_KEY = 'gal:role-map';

// WebView2 里有 localStorage，Node 冒烟测试里没有：给个内存兜底
const memoryStore = new Map();
const store = typeof localStorage === 'undefined' ? null : localStorage;

function readStore(key) {
  try {
    return store ? store.getItem(key) : (memoryStore.get(key) ?? null);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (store) store.setItem(key, value);
    else memoryStore.set(key, value);
  } catch {
    // 隐私模式写不进去，内存里这份也够当前这一次用
  }
}

export function roleAliases() {
  try {
    const saved = JSON.parse(readStore(ROLE_MAP_KEY) ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/** role 传空串 = 删掉这条映射，回到按名字自动匹配 */
export function setRoleAlias(name, role) {
  const key = String(name ?? '').trim();
  if (!key) return roleAliases();

  const map = { ...roleAliases() };
  const value = String(role ?? '').trim();

  if (value) map[key] = value;
  else delete map[key];

  writeStore(ROLE_MAP_KEY, JSON.stringify(map));
  return map;
}

/** 剧本角色名 → 素材角色名：精确 → 手动映射 → 忽略大小写/包含 → 第一个角色 */
export function resolveRole(name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) return roleList()[0] ?? '';

  if (library.characters.has(wanted)) return wanted;

  const mapped = roleAliases()[wanted];
  if (mapped && library.characters.has(mapped)) return mapped;

  const lower = wanted.toLowerCase();
  const hit =
    roleList().find((role) => role.toLowerCase() === lower) ??
    roleList().find((role) => role.toLowerCase().includes(lower) || lower.includes(role.toLowerCase()));

  return hit ?? roleList()[0] ?? '';
}

// ------------------------------------------------------------------ IndexedDB

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        const result = run(store);

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

async function putAll(items) {
  if (!items.length) return;

  await tx('readwrite', (store) => {
    for (const item of items) store.put(item.blob, item.path);
  });
}

async function readAll() {
  try {
    const db = await openDb();

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly');
      const store = transaction.objectStore(STORE);

      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();

      transaction.oncomplete = () => {
        const keys = keysRequest.result ?? [];
        const values = valuesRequest.result ?? [];
        resolve(keys.map((key, index) => ({ path: String(key), blob: values[index] })));
      };

      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    return [];
  }
}

export async function clearAssets() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls = new Map();

  library.backgrounds = [];
  library.characters = new Map();
  library.music = [];
  library.updatedAt = 0;

  try {
    await tx('readwrite', (store) => store.clear());
  } catch {
    // 隐私模式写不进去，清内存就够了
  }
}

// ------------------------------------------------------------------ 扫描

const stripExt = (name) => name.replace(IMAGE_RE, '').trim();

/** 音频曲名：优先用 音乐/ 下的子目录名；否则用文件名，并去掉 bgm_ / ost_ 这类前缀 */
function musicTrackName(parts) {
  const filename = parts.at(-1) ?? '';
  const musicIndex = parts.findIndex((part) => MUSIC_DIR.test(part));

  if (musicIndex >= 0 && parts.length - musicIndex >= 3) {
    return parts[musicIndex + 1];
  }

  const base = filename.replace(AUDIO_RE, '').trim();
  return base.replace(/^(bgm|ost|music|theme)[_\-\s]+/i, '').trim() || base;
}

const BG_DIR = /^(背景|场景|远景|bg|background|backgrounds|scene|scenes)$/i;
const CHAR_DIR = /^(角色|人物|立绘|char|chars|characters|character|sprite|sprites|立ち絵)$/i;

function pushCharacter(role, item) {
  const list = library.characters.get(role) ?? [];
  list.push(item);
  library.characters.set(role, list);
}

/**
 * 从「相对路径 + Blob」列表重建素材库。
 * path 形如 `assets/角色/诺艾尔/害羞.png`，前面几段是用户选的根目录，跳过就行。
 * 没有 背景/、角色/ 的分享包会按文件名自动认角色（见 parseSpriteName）。
 */
export function buildLibrary(entries) {
  library.backgrounds = [];
  library.characters = new Map();
  library.music = [];
  library.updatedAt = Date.now();

  const flat = [];

  for (const [path, blob] of entries) {
    if (!IMAGE_RE.test(path) && !AUDIO_RE.test(path)) continue;

    const parts = path.split('/').filter(Boolean);
    const filename = parts.at(-1);

    // 音频统一进 BGM 库：子目录名优先当曲名（`音乐/雨后/track01.mp3` → 雨后）
    if (AUDIO_RE.test(path)) {
      library.music.push({ name: musicTrackName(parts), path, blob });
      continue;
    }

    const bgIndex = parts.findIndex((part) => BG_DIR.test(part));
    if (bgIndex >= 0 && bgIndex < parts.length - 1) {
      library.backgrounds.push({ name: stripExt(filename), path, blob });
      continue;
    }

    const charIndex = parts.findIndex((part) => CHAR_DIR.test(part));
    if (charIndex >= 0 && charIndex < parts.length - 1) {
      const parsed = parseSpriteName(filename);
      // 文件名自己带角色名时优先（`sprites/Miki..._Smile.png` 这种包目录也能直接选）；
      // 直接躺在 角色/ 下面的图没有角色目录，给个兜底名
      const folder = parts[charIndex + 1];
      const role = parsed.role || (folder !== filename ? folder : '默认角色');

      const clothes = parsed.clothes || clothesFromDirs(parts.slice(charIndex + 2, -1));

      pushCharacter(role, {
        path,
        blob,
        clothes,
        tags: parsed.tags,
        aliases: parsed.aliases,
        base: parsed.base,
      });
      continue;
    }

    flat.push({ path, blob, parts, filename });
  }

  // 没有目录约定的分享包：文件名自带角色/服装/表情就按立绘收，
  // 认不出来的（`bus_stop_rain.jpg`）才当背景
  for (const item of flat) {
    const parsed = parseSpriteName(item.filename);

    if (!parsed.character) {
      library.backgrounds.push({ name: stripExt(item.filename), path: item.path, blob: item.blob });
      continue;
    }

    pushCharacter(parsed.role || '默认角色', {
      path: item.path,
      blob: item.blob,
      clothes: parsed.clothes || clothesFromDirs(item.parts.slice(0, -1)),
      tags: parsed.tags,
      aliases: parsed.aliases,
      base: parsed.base,
    });
  }

  for (const list of library.characters.values()) ensureBase(list);

  library.backgrounds.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  library.music.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  return library;
}

/**
 * 文件选择框 / 拖拽进来之后统一走这里：扫描 → 落库（追加）→ 重建内存。
 * kind：'background' / 'character' / 'music' 时给路径套一层约定目录，保证只按这一类收；
 * 留空则按目录结构和文件名自动判断。
 */
export async function importEntries(entries, kind = '') {
  const incoming = [];

  for (const item of entries) {
    const ok = kind === 'music'
      ? AUDIO_RE.test(item.path)
      : kind
        ? IMAGE_RE.test(item.path)
        : IMAGE_RE.test(item.path) || AUDIO_RE.test(item.path);

    if (ok) incoming.push(item);
  }

  if (!incoming.length) return { imported: 0, added: 0, replaced: 0, library };

  // 追加导入：库里已有的图全部保留，先背景、再立绘、再补服装差分可以分批来
  const stored = await readAll();
  const known = new Map(stored.map((item) => [item.path, item.blob]));

  let replaced = 0;
  let seq = 1;
  const items = [];

  for (const item of incoming) {
    let path = item.path;

    if (kind === 'music') {
      path = `音乐/${path}`;
    } else if (kind === 'background') {
      path = `背景/${path}`;
    } else if (kind === 'character') {
      // 文件名认不出角色时垫一层默认角色，别让它掉回背景
      path = parseSpriteName(item.path.split('/').filter(Boolean).at(-1)).role
        ? `角色/${path}`
        : `角色/默认角色/${path}`;
    }

    const old = known.get(path);

    if (old && old.size !== item.blob.size) {
      // 同一个相对路径来自另一套素材（不同分享包根目录同名）：加一层目录，别覆盖旧的。
      // 多出来的目录名不认识，会被当成无义目录跳过，不影响角色/表情解析
      while (known.has(`追加${seq}/${path}`)) seq += 1;
      path = `追加${seq}/${path}`;
      seq += 1;
    } else if (old) {
      replaced += 1;
    }

    items.push({ path, blob: item.blob });
  }

  // URL 缓存整批重建，避免留下旧图的 blob URL
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls = new Map();

  await putAll(items);

  const all = await readAll();
  buildLibrary(all.map((item) => [item.path, item.blob]));

  return { imported: items.length, added: items.length - replaced, replaced, library };
}

export async function loadLibrary() {
  const stored = await readAll();
  if (!stored.length) return library;

  buildLibrary(stored.map((item) => [item.path, item.blob]));
  return library;
}

/** 从 <input webkitdirectory> 的 FileList 变成 [{path, blob}] */
export function entriesFromFileList(fileList) {
  const out = [];

  for (const file of fileList ?? []) {
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    out.push({ path, blob: file });
  }

  return out;
}

/** 拖进来的目录：递归读出全部图片 */
export async function entriesFromDataTransfer(dataTransfer) {
  const roots = [];

  for (const item of dataTransfer.items ?? []) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }

  if (!roots.length) return entriesFromFileList(dataTransfer.files);

  const out = [];

  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ path: prefix + entry.name, blob: file });
      return;
    }

    const reader = entry.createReader();
    const children = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));

    for (const child of children) await walk(child, `${prefix}${entry.name}/`);
  }

  for (const root of roots) await walk(root, '');

  return out;
}

// ------------------------------------------------------------------ 查询

function urlOf(item) {
  if (!item?.blob) return '';

  const key = item.path;
  if (objectUrls.has(key)) return objectUrls.get(key);

  const url = URL.createObjectURL(item.blob);
  objectUrls.set(key, url);
  return url;
}

export function hasAssets() {
  return library.backgrounds.length > 0 || library.characters.size > 0 || library.music.length > 0;
}

/** 已导入的 BGM 列表（按曲名排序，去重后给素材面板用） */
export function musicList() {
  const seen = new Set();
  const list = [];

  for (const item of library.music) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    list.push({ name: item.name, path: item.path });
  }

  return list;
}

/** 曲名的所有写法：原名 + 别名表里的中英日写法 */
function musicForms(value) {
  const norm = normalizeScene(value);
  const forms = new Set([norm]);

  for (const [canon, aliases] of Object.entries(MUSIC_TITLES)) {
    const all = [canon, ...aliases].map(normalizeScene);
    if (all.includes(norm)) all.forEach((form) => forms.add(form));
  }

  return forms;
}

/** 曲名里命中的氛围词：日常/轻松/雨天……用于 `bgm_daily_light` 这种组合名 */
function musicConcepts(value) {
  const text = normalizeScene(value);
  const set = new Set();

  for (const [canon, aliases] of Object.entries(MUSIC_MOODS)) {
    if ([canon, ...aliases].some((alias) => text.includes(normalizeScene(alias)))) set.add(canon);
  }

  return set;
}

/**
 * 剧本 music.path → 用户导入的 BGM。
 * 匹配顺序：同名 → 归一化同名 → 中英日别名（雨后 = after_rain = 雨上がり）
 * → 文件名包含别名（`bgm_after_rain_piano`）→ 氛围词有交集（日常_轻松 = daily_light）。
 * 都没命中就返回空串，让播放器保持安静。
 */
export function pickMusicUrl(name) {
  const wanted = String(name ?? '').trim();
  if (!wanted || !library.music.length) return '';

  const forms = musicForms(wanted);

  let hit = library.music.find((item) => item.name === wanted);
  if (!hit) hit = library.music.find((item) => forms.has(normalizeScene(item.name)));
  if (!hit) {
    hit = library.music.find((item) => {
      const own = normalizeScene(item.name);
      return [...forms].some((form) => form.length >= 3 && own.includes(form));
    });
  }
  if (hit) return urlOf(hit);

  const want = musicConcepts(wanted);

  if (want.size) {
    hit = library.music.find((item) => {
      const own = musicConcepts(item.name);

      for (const concept of want) if (own.has(concept)) return true;
      return false;
    });
  }

  return hit ? urlOf(hit) : '';
}

export function roleList() {
  return [...library.characters.keys()];
}

export function tagList(role) {
  const tags = new Set();

  for (const item of library.characters.get(role) ?? []) {
    for (const tag of item.tags) tags.add(tag);
  }

  return [...tags];
}

/** 把场景名拆成「地点 + 时间」两组概念，中英日写法都能对上 */
function sceneConcepts(value) {
  const text = normalizeScene(value);
  const loc = new Set();
  const time = new Set();

  for (const [canon, aliases] of Object.entries(SCENE_LOCATIONS)) {
    if (aliases.some((alias) => text.includes(normalizeScene(alias)))) loc.add(canon);
  }

  for (const [canon, aliases] of Object.entries(SCENE_TIMES)) {
    if (aliases.some((alias) => text.includes(normalizeScene(alias)))) time.add(canon);
  }

  return { text, loc, time };
}

function overlap(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

/**
 * 宿主自带的预设背景（由 `/api/scenes` 列出 assets/scenes 下真实存在的文件）。
 * 剧本常写「天台·夜」，而文件名是「天台_夜晚.jpg」，靠这套词表匹配对上。
 */
let presetBackgrounds = [];

export function setPresetBackgrounds(names) {
  presetBackgrounds = (Array.isArray(names) ? names : []).map((file) => ({
    name: stripExt(file),
    url: `../assets/scenes/${encodeURIComponent(file)}`,
  }));
}

/**
 * 场景匹配：精确 → 地点词 +2 / 时间词 +1 打分 → 老的互相包含兜底。
 * `天台·黄昏` 能命中 `rooftop_dusk.jpg`、`屋上_夕暮れ.jpg`；
 * 地点对不上时不拿别的地点顶包（避免「夜晚的城市」盖掉「夜晚的街道」）。
 */
export function pickBackgroundUrl(name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) return '';

  // 用户导入的素材优先，宿主预设补位；两边都没有就返回空，交给调用方兜底
  const candidates = [
    ...library.backgrounds.map((item) => ({ name: item.name, url: urlOf(item) })),
    ...presetBackgrounds,
  ];

  if (!candidates.length) return '';

  const exact = candidates.find((item) => item.name === wanted);
  if (exact) return exact.url;

  // 分隔符不同但字面一致：`rooftop dusk` ↔ `rooftop_dusk`
  const normWanted = normalizeScene(wanted);
  const spelled = candidates.find((item) => normalizeScene(item.name) === normWanted);
  if (spelled) return spelled.url;

  const want = sceneConcepts(wanted);

  let best = null;
  let bestScore = 0;

  for (const item of candidates) {
    const own = sceneConcepts(item.name);

    if (want.loc.size && own.loc.size && !overlap(want.loc, own.loc)) continue;

    const score = overlap(want.loc, own.loc) * 2 + overlap(want.time, own.time);

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (best) return best.url;

  // 词表没覆盖到的写法：退回按分隔符归一后的包含匹配
  const norm = (value) => value.replace(/[·・_\-\s]/g, '');

  let hit = candidates.find((item) => norm(item.name) === norm(wanted));

  if (!hit) hit = candidates.find((item) => item.name.includes(wanted) || wanted.includes(item.name));

  if (!hit) hit = candidates.find((item) => norm(item.name).includes(norm(wanted)));

  return hit ? hit.url : '';
}

/** 一个标签的所有写法：原词 + 中文规范词（smile / 笑顔 / 微笑 都收进同一组） */
function tagForms(tag) {
  const forms = new Set([normalizeKey(tag)]);
  const canon = findAlias(tag, EXPRESSION_ALIASES) || findAlias(tag, OUTFIT_ALIASES);

  if (canon) forms.add(canon);

  return forms;
}

/**
 * 差分匹配：命中标签 +2、服装命中 +3、换到别的服装 -2、基础图 -1。
 * 标签和服装都先过一遍中英日词表，所以剧本写 `smile`、模型写 `微笑` 都能命中 `Smile.png`。
 * 全不中回退基础图，再不行回退该角色第一张。
 */
export function pickCharacterUrl(role, tags = [], clothes = '') {
  const list = library.characters.get(resolveRole(role)) ?? library.characters.get(roleList()[0]);
  if (!list?.length) return '';

  const wanted = tags.filter(Boolean);
  const wantClothes = clothes ? (findAlias(clothes, OUTFIT_ALIASES) || clothes) : '';

  if (!wanted.length && !wantClothes) {
    const base = list.find((item) => item.base) ?? list[0];
    return urlOf(base);
  }

  let best = null;
  let bestScore = -Infinity;

  for (const item of list) {
    let score = 0;

    for (const tag of wanted) {
      const forms = tagForms(tag);

      if (item.tags.some((own) => forms.has(normalizeKey(own)))) score += 2;
      else if (item.aliases.some((own) => forms.has(own))) score += 2;
      else if (item.tags.some((own) => own.includes(tag) || tag.includes(own))) score += 1;
    }

    // 没写服装的条目不罚分，免得整包没拆出服装时全部落到兜底
    if (wantClothes && item.clothes) score += item.clothes === wantClothes ? 3 : -2;

    // 同分时优先标签更少的：`Smile` 比 `OpenSmile_ClosedEyes_Blush` 更像「微笑」
    score -= item.tags.length * 0.01;
    if (item.tags.includes('微笑')) score += 0.005;

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (bestScore <= 0) {
    const sameClothes = wantClothes
      ? list.find((item) => item.clothes === wantClothes && item.base)
      : null;

    const base = sameClothes ?? list.find((item) => item.base) ?? list[0];
    return urlOf(base);
  }

  return urlOf(best);
}

/** 预览：全部背景，按名字排 */
export function backgroundVariations() {
  return library.backgrounds.map((item) => ({
    url: urlOf(item),
    path: item.path,
    name: item.name,
  }));
}

/** 预览：某个角色的全部差分，基础图排前面，其次按服装 / 标签排 */
export function characterVariations(role) {
  const list = library.characters.get(resolveRole(role)) ?? [];

  return [...list]
    .sort(
      (a, b) =>
        Number(b.base) - Number(a.base) ||
        a.clothes.localeCompare(b.clothes, 'zh') ||
        a.tags.join('/').localeCompare(b.tags.join('/'), 'zh'),
    )
    .map((item) => ({
      url: urlOf(item),
      path: item.path,
      clothes: item.clothes,
      tags: [...item.tags],
      base: item.base,
    }));
}

export function stats() {
  const chars = [...library.characters.values()].reduce((sum, list) => sum + list.length, 0);

  return {
    backgrounds: library.backgrounds.length,
    roles: library.characters.size,
    variations: chars,
    music: library.music.length,
    updatedAt: library.updatedAt,
  };
}
