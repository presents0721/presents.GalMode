/**
 * 对外入口：把"一堆 YAML 文件"变成引擎能吃的剧本对象。
 */

import { parseYaml } from './yaml.mjs';
import { StoryEngine } from './engine.mjs';
import { validateStory } from './validator.mjs';

export { StoryEngine, EngineError, collectVariables } from './engine.mjs';
export { validateStory } from './validator.mjs';
export { parseYaml } from './yaml.mjs';
export { evaluateExpression, testCondition, runAssignment } from './conditions.mjs';

/** `Chapters/Intro/intro.yaml` → `Intro/intro` */
export function normalizeChapterId(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^Chapters\//i, '')
    .replace(/\.ya?ml$/i, '')
    .trim();
}

/**
 * @param {object} config  story_config.yaml 解析后的对象
 * @param {Record<string, any[]|{events:any[]}>} chapterMap 章节 id → 事件数组
 */
export function createStory(config = {}, chapterMap = {}) {
  const chapters = {};

  for (const [rawId, value] of Object.entries(chapterMap)) {
    const id = normalizeChapterId(rawId);
    const events = Array.isArray(value) ? value : value?.events;

    if (!Array.isArray(events)) {
      throw new Error(`章节 ${rawId} 缺少 events 数组`);
    }

    chapters[id] = events.filter((event) => event && typeof event === 'object');
  }

  const intro = normalizeChapterId(config.intro_chapter ?? config.introChapter ?? '') || Object.keys(chapters)[0];

  return {
    id: config.script_name ?? config.id ?? config.name ?? 'untitled',
    name: config.script_name ?? config.name ?? '未命名剧本',
    version: config.version ?? 1,
    author: config.author ?? '',
    description: config.description ?? '',
    playerName: config.player_name ?? config.playerName ?? '你',
    intro,
    variables: config.variables ?? {},
    chapterTitles: config.chapter_titles ?? config.chapterTitles ?? {},
    characters: normalizeCharacters(config.characters),
    chapters,
  };
}

/** 直接用两份源码文本构造剧本。 */
export function loadStoryFromSource(configYaml, chapterSources = {}) {
  const config = parseYaml(asText(configYaml)) ?? {};
  const chapterMap = {};

  for (const [id, source] of Object.entries(chapterSources)) {
    // 目录加载时章节已经是解析好的对象，这里不能再走一遍 YAML
    chapterMap[id] = typeof source === 'string' ? parseYaml(source) : source;
  }

  return createStory(config, chapterMap);
}

/**
 * 从目录读取剧本（Node 环境）。目录里应有 story_config.yaml 与 Chapters/。
 * 浏览器端不要用这个，直接用 createStory。
 */
export async function loadStoryFromDirectory(directory) {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join, relative, sep } = await import('node:path');

  const root = String(directory);
  const configPath = join(root, 'story_config.yaml');

  let configSource;

  try {
    configSource = await readFile(configPath, 'utf8');
  } catch {
    throw new Error(`找不到 ${configPath}`);
  }

  const chaptersDir = join(root, 'Chapters');
  const chapterMap = {};

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      if (!/\.ya?ml$/i.test(entry.name)) continue;

      const id = relative(chaptersDir, full).split(sep).join('/').replace(/\.ya?ml$/i, '');
      chapterMap[id] = parseYaml(await readFile(full, 'utf8'));
    }
  }

  await walk(chaptersDir);

  return loadStoryFromSource(configSource, chapterMap);
}

/** 剧本 + 校验结果，方便编辑器一次性拿到。 */
export function loadAndValidate(configYaml, chapterSources) {
  const story = loadStoryFromSource(configYaml, chapterSources);
  return { story, report: validateStory(story) };
}

function normalizeCharacters(raw) {
  if (!raw || typeof raw !== 'object') return {};

  const out = {};

  for (const [id, value] of Object.entries(raw)) {
    out[id] = typeof value === 'string' ? { name: value } : { ...value, name: value.name ?? id };
  }

  return out;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

/** 浏览器里一键盘：从 <script type="application/yaml"> 之类的地方取文本。 */
export { StoryEngine as Engine };
