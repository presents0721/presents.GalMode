/**
 * 剧本编辑器：改 YAML → 校验 → 存草稿 → 剧情窗口试玩。
 * 一条链路都不经过后端：解析/校验用的是同一个引擎（src/index.mjs），
 * 试玩靠 localStorage 把构建好的 story 交给 demo。
 */
import { loadAndValidate, parseYaml, normalizeChapterId } from '../src/index.mjs';

const $ = (id) => document.getElementById(id);
const LS_DRAFT = 'gal:draft';
const LS_LLM = 'gal:editor:llm';
const LS_SNAPSHOT = 'gal:editor:snapshot';

let lastErrors = [];

const state = {
  config: '',
  chapters: {},
  current: '',
};

// ---------------------------------------------------------------- 载入

async function loadCurrent() {
  const manifest = await fetch('../story/manifest.json').then((r) => r.json());
  const config = await fetch('../story/story_config.yaml').then((r) => r.text());

  const chapters = {};

  for (const [id, path] of Object.entries(manifest.chapters)) {
    chapters[id] = await fetch(`../story/${path}`).then((r) => r.text());
  }

  state.config = config;
  state.chapters = chapters;
  state.current = Object.keys(chapters)[0] ?? '';

  snapshot();
  renderList();
  showCurrent();
  report('ok', `已载入《${nameOf(config)}》，${Object.keys(chapters).length} 个章节。`);
}

const nameOf = (yaml) => (yaml.match(/script_name:\s*(.+)/)?.[1] ?? '').trim();

/** 改动都存一份，刷新页面不丢 */
function snapshot() {
  try {
    localStorage.setItem(LS_SNAPSHOT, JSON.stringify({ config: state.config, chapters: state.chapters }));
  } catch { /* 隐私模式 */ }
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SNAPSHOT) ?? 'null');
    if (!raw?.config) return false;

    state.config = raw.config;
    state.chapters = raw.chapters ?? {};
    state.current = Object.keys(state.chapters)[0] ?? '';
    renderList();
    showCurrent();
    report('warn', '已恢复上次未导出的编辑内容。点「载入当前剧本」可重新读磁盘上的版本。');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 列表

function renderList() {
  const list = $('list');
  list.innerHTML = '';

  for (const id of Object.keys(state.chapters)) {
    const item = document.createElement('div');
    item.className = `item${id === state.current ? ' on' : ''}`;

    const title = titleOf(id);
    item.innerHTML = `${title}<small>${id}</small>`;
    item.addEventListener('click', () => {
      commit();
      state.current = id;
      renderList();
      showCurrent();
    });

    list.appendChild(item);
  }
}

function titleOf(id) {
  const line = state.config.split('\n').find((l) => l.trim().startsWith(`${id}:`));
  return line ? line.split(':').slice(1).join(':').trim() : id;
}

let outlineTimer = 0;

let dirty = false;

function commit() {
  if (!dirty || !state.current) return;

  state.chapters[state.current] = $('editor').value;
  dirty = false;
  snapshot();
}

function showCurrent() {
  const el = $('editor');
  el.value = state.current ? (state.chapters[state.current] ?? '') : state.config;
  el.dataset.mode = state.current ? 'chapter' : 'config';
  dirty = false;
  $('scriptName').textContent = nameOf(state.config) || '';

  selectedIndex = -1;
  renderOutline();
  renderVars();
}

// ---------------------------------------------------------------- 校验 / 试玩

function build() {
  commit();
  return loadAndValidate(state.config, state.chapters);
}

function validate(quiet = false) {
  try {
    const { story, report: res } = build();
    const errors = res?.errors ?? [];

    lastErrors = errors;
    const warnings = res?.warnings ?? [];

    if (errors.length) {
      report('err', ['校验未通过：', ...errors.map((e) => `· ${e}`)].join('\n'));
      return null;
    }

    if (!quiet) {
      report(
        'ok',
        [`校验通过：${Object.keys(story.chapters ?? {}).length} 章 / ${story.characters ? Object.keys(story.characters).length : 0} 个角色`, ...warnings.map((w) => `⚠ ${w}`)].join('\n'),
      );
    }

    return story;
  } catch (error) {
    report('err', `解析失败：${error.message}`);
    return null;
  }
}

function play() {
  const story = validate(true);
  if (!story) return;

  try {
    localStorage.setItem(LS_DRAFT, JSON.stringify(story));
  } catch (error) {
    report('err', `草稿太大，存不进 localStorage：${error.message}`);
    return;
  }

  report('ok', '草稿已写入 localStorage，正在窗口内试玩（?draft=1）。');
  openTrial();
}

/** 试玩：在编辑器上叠一层 iframe。不要 window.open，独立窗口一关宿主会问是否退出 Alife */
function openTrial() {
  let host = $('trial');

  if (!host) {
    host = document.createElement('div');
    host.id = 'trial';
    host.innerHTML =
      '<div class="trial-bar"><b>草稿试玩</b><span>这一层跑的是刚写的草稿，不影响线上剧情</span><span class="grow"></span><button type="button" id="trialClose">关闭试玩</button></div>' +
      '<iframe id="trialFrame" title="草稿试玩"></iframe>';
    document.body.appendChild(host);
    host.querySelector('#trialClose').addEventListener('click', closeTrial);
  }

  // 每次重设地址，保证读到刚写进 localStorage 的草稿
  $('trialFrame').src = '../demo/?draft=1&t=' + Date.now();
  host.hidden = false;
}

function closeTrial() {
  const host = $('trial');
  if (!host) return;

  // 卸掉 iframe，试玩里的 BGM / 定时器随之停下
  $('trialFrame').src = 'about:blank';
  host.hidden = true;
}

// 父页面收起编辑器层时顺手关掉试玩（否则叠层里的 BGM 会在后台继续响）
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  if (event.data?.type === 'gal-embed-close') closeTrial();
});

function exportYaml() {
  commit();

  const parts = [`# ===== config =====\n${state.config.trim()}`];

  for (const [id, yaml] of Object.entries(state.chapters)) {
    parts.push(`# ===== chapter: ${id} =====\n${yaml.trim()}`);
  }

  const blob = new Blob([parts.join('\n\n')], { type: 'text/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = `${nameOf(state.config) || 'story'}.yaml`;
  a.click();

  URL.revokeObjectURL(url);
}

function report(kind, text) {
  const el = $('report');
  el.className = kind;
  el.textContent = text;
}

// ---------------------------------------------------------------- 事件大纲 / 表单
//
// YAML 仍是唯一真源：这里只做「按块解析 → 出表单 → 回写块」，解析和校验都走同一个引擎。

const EVENT_TYPES = [
  'narration', 'player', 'dialogue', 'ai_dialogue', 'free_dialogue', 'input', 'choices',
  'set_variable', 'show_character', 'hide_character', 'modify_character', 'present_pic',
  'background', 'music', 'stop_music', 'ambient', 'sound', 'effect', 'achievement', 'chapter_end',
];

const TYPE_DEFAULT = {
  narration: { type: 'narration', text: '' },
  player: { type: 'player', text: '', displayName: '' },
  dialogue: { type: 'dialogue', character: '', emotion: '', text: '' },
  ai_dialogue: { type: 'ai_dialogue', character: '', prompt: '' },
  free_dialogue: {
    type: 'free_dialogue', max_rounds: 2, end_line: '',
    prompt: '', end_prompt: '', hint: '',
  },
  input: { type: 'input', prompt: '' },
  choices: { type: 'choices', prompt: '', allow_free: false, options: [{ text: '', actions: [] }] },
  set_variable: { type: 'set_variable', name: '', op: '=', value: 0 },
  show_character: { type: 'show_character', character: '', position: 'center', emotion: '' },
  hide_character: { type: 'hide_character', character: '' },
  modify_character: { type: 'modify_character', character: '', emotion: '' },
  present_pic: { type: 'present_pic', path: '' },
  background: { type: 'background', path: '' },
  music: { type: 'music', path: '', speed: 1 },
  stop_music: { type: 'stop_music' },
  ambient: { type: 'ambient', path: '', volume: 0.6 },
  sound: { type: 'sound', path: '' },
  effect: { type: 'effect', name: 'rain' },
  achievement: { type: 'achievement', id: '', name: '' },
  chapter_end: { type: 'chapter_end', mode: 'linear', next: '' },
};

let blockRanges = [];
let selectedIndex = -1;
let editingIndex = -1;
let insertAfter = -1;
let formObj = null;

const indentOf = (line) => line.match(/^ */)[0].length;

function parseEvents(text) {
  const lines = String(text ?? '').split('\n');
  const eventsLine = lines.findIndex((line) => line.trim() === 'events:');

  if (eventsLine < 0) return { items: [] };

  const items = [];
  let i = eventsLine + 1;

  while (i < lines.length) {
    if (!/^\s*-\s/.test(lines[i])) { i += 1; continue; }

    const indent = indentOf(lines[i]);
    const start = i;
    i += 1;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }

      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind === indent && /^\s*-\s/.test(line)) break;

      i += 1;
    }

    let end = i;
    while (end > start + 1 && !lines[end - 1].trim()) end -= 1;

    let obj = null;
    try {
      obj = parseYaml(lines.slice(start, end).join('\n'))?.[0] ?? null;
    } catch {
      obj = null;
    }

    items.push({ start, end, indent, obj });
  }

  return { items };
}

function summaryOf(event) {
  if (!event || typeof event !== 'object') return '（无法解析，请在左边改 YAML）';

  const cut = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 42);

  switch (event.type) {
    case 'narration': return cut(event.text);
    case 'player': return `你：${cut(event.text)}`;
    case 'dialogue': return `${cut(event.character)}：${cut(event.text)}`;
    case 'ai_dialogue': return `${cut(event.character ?? 'AI')}（${cut(event.prompt) || '自由发挥'}）`;
    case 'free_dialogue': return `${event.max_rounds ?? '?'} 轮后收尾${event.prompt ? ` · ${cut(event.prompt)}` : ''}`;
    case 'input': return cut(event.prompt);
    case 'choices': return `${cut(event.prompt)}（${(event.options ?? []).length} 项）`;
    case 'background': return cut(event.path ?? event.name);
    case 'show_character':
    case 'modify_character': return `${cut(event.character)}${event.emotion ? ' · ' + cut(event.emotion) : ''}`;
    case 'hide_character': return cut(event.character);
    case 'set_variable': return `${cut(event.name)} ${event.op ?? '='} ${cut(event.value)}`;
    case 'chapter_end': return `${event.mode ?? 'linear'}${event.next ? ' → ' + event.next : ''}`;
    default: return cut(Object.entries(event).filter(([key]) => key !== 'type').map(([, value]) => value).join(' '));
  }
}

function dumpBlock(event, indent = 2) {
  const body = dumpYaml(event, indent + 2).split('\n');
  body[0] = `${' '.repeat(indent)}- ${body[0].slice(indent + 2)}`;
  return body.join('\n');
}

const isPrimitive = (value) => value === null || typeof value !== 'object';

function scalarOf(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const text = String(value);
  if (!text) return '""';

  const needsQuote = /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text)
    || /[:#]\s/.test(text)
    || /:$/.test(text)
    || /\s$/.test(text)
    || /\n/.test(text)
    || /^(?:true|false|null|yes|no|on|off)$/i.test(text)
    || /^[+-]?\d+(?:\.\d+)?$/.test(text);

  return needsQuote ? JSON.stringify(text) : text;
}

function dumpYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) return '[]';

    return value.map((item) => {
      if (isPrimitive(item)) return `${pad}- ${scalarOf(item)}`;
      return `${pad}- ${dumpYaml(item, indent + 2).slice(indent + 2)}`;
    }).join('\n');
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return '{}';

    return entries.map(([key, item]) => {
      if (isPrimitive(item)) return `${pad}${key}: ${scalarOf(item)}`;
      if (Array.isArray(item) && !item.length) return `${pad}${key}: []`;
      if (!Array.isArray(item) && !Object.keys(item).length) return `${pad}${key}: {}`;
      return `${pad}${key}:\n${dumpYaml(item, indent + 2)}`;
    }).join('\n');
  }

  return `${pad}${scalarOf(value)}`;
}

function renderOutline() {
  const pane = $('paneOutline');
  pane.textContent = '';
  blockRanges = [];

  if (!state.current) {
    pane.innerHTML = '<div class="empty">当前在编辑 story_config，选中一个章节后才能看事件。</div>';
    return;
  }

  const { items } = parseEvents($('editor').value);
  blockRanges = items;

  if (!items.length) {
    pane.innerHTML = '<div class="empty">这一章还没有事件，点下面的「＋ 新事件」。</div>';
    return;
  }

  if (selectedIndex >= items.length) selectedIndex = items.length - 1;

  items.forEach((item, index) => {
    const node = document.createElement('div');
    node.className = `node${index === selectedIndex ? ' on' : ''}`;

    const no = document.createElement('span');
    no.className = 'idx';
    no.textContent = String(index + 1).padStart(2, '0');

    const type = document.createElement('span');
    type.className = 'ty';
    type.textContent = item.obj?.type ?? '未解析';

    const text = document.createElement('span');
    text.className = 'sm';
    text.textContent = summaryOf(item.obj);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'mini';
    edit.textContent = '编辑';
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openNode(index);
    });

    node.addEventListener('click', () => {
      selectedIndex = index;
      jumpTo(index);
      renderOutline();
    });

    node.append(no, type, text, edit);
    pane.appendChild(node);
  });
}

function jumpTo(index) {
  const item = blockRanges[index];
  if (!item) return;

  const el = $('editor');
  const text = el.value;
  const starts = [0];

  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);

  el.focus();
  el.setSelectionRange(starts[item.start] ?? 0, starts[item.end] ?? text.length);

  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
  el.scrollTop = Math.max(0, (item.start - 3) * lineHeight);
}

function openNode(index) {
  const { items } = parseEvents($('editor').value);
  blockRanges = items;

  const item = blockRanges[index];

  if (!item?.obj) {
    report('err', `第 ${index + 1} 个事件解析失败，先在左边直接改 YAML。`);
    return;
  }

  editingIndex = index;
  insertAfter = index;
  formObj = JSON.parse(JSON.stringify(item.obj));

  $('nodeTitle').textContent = `编辑事件 #${index + 1}`;
  $('nodeDel').hidden = false;
  renderFields();
  $('nodeDialog').showModal();
}

function openNewNode() {
  const { items } = parseEvents($('editor').value);

  blockRanges = items;
  editingIndex = -1;
  insertAfter = selectedIndex >= 0 && selectedIndex < items.length ? selectedIndex : items.length - 1;
  formObj = JSON.parse(JSON.stringify(TYPE_DEFAULT.narration));

  $('nodeTitle').textContent = insertAfter >= 0 ? `新增事件（插到 #${insertAfter + 2}）` : '新增事件';
  $('nodeDel').hidden = true;
  renderFields();
  $('nodeDialog').showModal();
}

function renderFields() {
  const box = $('nodeFields');
  box.textContent = '';

  const typeField = document.createElement('div');
  typeField.className = 'nd-field';

  const typeLabel = document.createElement('label');
  typeLabel.textContent = '类型 type';

  const typeSelect = document.createElement('select');
  for (const type of EVENT_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type;
    typeSelect.appendChild(option);
  }

  typeSelect.value = formObj.type ?? 'narration';
  formObj.type = typeSelect.value;

  // 老剧本的 choices 没有 allow_free：补一个显式开关，表单里才看得见
  if (formObj.type === 'choices' && !('allow_free' in formObj)) formObj.allow_free = false;

  typeSelect.addEventListener('change', () => {
    formObj = JSON.parse(JSON.stringify(TYPE_DEFAULT[typeSelect.value] ?? { type: typeSelect.value }));
    renderFields();
  });

  typeField.append(typeLabel, typeSelect);
  box.appendChild(typeField);

  // 事件级条件：所有类型都能写，留空就不落进 YAML
  box.appendChild(fieldEl('condition', formObj.condition ?? ''));

  for (const [key, value] of Object.entries(formObj)) {
    if (key === 'type' || key === 'condition') continue;
    box.appendChild(fieldEl(key, value));
  }
}

function fieldEl(key, value) {
  const wrap = document.createElement('div');
  wrap.className = 'nd-field';

  const label = document.createElement('label');
  const nested = value !== null && typeof value === 'object';
  label.textContent = nested ? `${key}（YAML 子结构）` : key;

  let input;

  if (nested) {
    input = document.createElement('textarea');
    input.value = dumpYaml(value, 0);
    input.dataset.kind = 'yaml';
    input.spellcheck = false;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = value === null || value === undefined ? '' : String(value);
    input.dataset.kind = 'scalar';
  }

  input.dataset.key = key;
  wrap.append(label, input);
  return wrap;
}

function collectFields() {
  const out = { type: formObj.type };

  for (const input of $('nodeFields').querySelectorAll('[data-key]')) {
    const key = input.dataset.key;

    if (input.dataset.kind === 'yaml') {
      let parsed;
      try {
        parsed = parseYaml(input.value);
      } catch (error) {
        throw new Error(`${key} 不是合法 YAML：${error.message}`);
      }

      if (parsed !== null && parsed !== undefined) out[key] = parsed;
      continue;
    }

    const raw = input.value.trim();
    const original = formObj[key];

    // 事件级条件是可选字段：留空就不要写 condition: ""
    if (key === 'condition') {
      if (raw) out[key] = raw;
      continue;
    }

    if (typeof original === 'number' && raw !== '' && Number.isFinite(Number(raw))) out[key] = Number(raw);
    else if (typeof original === 'boolean') out[key] = raw === 'true';
    else if (key === 'allow_free' || key === 'allowFree') out[key] = raw === 'true';
    else out[key] = raw;
  }

  return out;
}

function applyNode() {
  let next;

  try {
    next = collectFields();
  } catch (error) {
    report('err', error.message);
    return;
  }

  const el = $('editor');
  const lines = el.value.split('\n');
  const { items } = parseEvents(el.value);
  const target = editingIndex >= 0 ? items[editingIndex] : null;

  if (target) {
    lines.splice(target.start, target.end - target.start, ...dumpBlock(next, target.indent).split('\n'));
    selectedIndex = editingIndex;
  } else {
    const anchor = insertAfter >= 0 && items[insertAfter] ? items[insertAfter].end : endOfEvents(lines);
    lines.splice(anchor, 0, ...dumpBlock(next, 2).split('\n'));
    selectedIndex = insertAfter >= 0 ? insertAfter + 1 : 0;
  }

  el.value = lines.join('\n');
  dirty = true;
  commit();

  renderOutline();
  renderVars();
  validate(true);
  report('ok', `已写入事件 #${selectedIndex + 1}，YAML 同步完成。`);
  $('nodeDialog').close();
}

function deleteNode() {
  if (editingIndex < 0) return;

  const { items } = parseEvents($('editor').value);
  const target = items[editingIndex];
  if (!target) return;

  const lines = $('editor').value.split('\n');
  lines.splice(target.start, target.end - target.start);
  $('editor').value = lines.join('\n');

  selectedIndex = Math.max(0, Math.min(editingIndex, items.length - 2));
  dirty = true;
  commit();

  renderOutline();
  renderVars();
  validate(true);
  report('ok', `已删除事件 #${editingIndex + 1}。`);
  $('nodeDialog').close();
}

function endOfEvents(lines) {
  const start = lines.findIndex((line) => line.trim() === 'events:');
  if (start < 0) return lines.length;

  let end = start + 1;
  for (let i = start + 1; i < lines.length; i += 1) if (lines[i].trim()) end = i + 1;
  return end;
}

// ---------------------------------------------------------------- 变量 / 条件

function chapterText(id) {
  return id === state.current ? $('editor').value : (state.chapters[id] ?? '');
}

function goTo(id, index) {
  if (id !== state.current) {
    commit();
    state.current = id;
    renderList();
    showCurrent();
  }

  selectedIndex = index;
  renderOutline();
  jumpTo(index);
}

function renderVars() {
  const pane = $('paneVars');
  pane.textContent = '';

  let config = {};
  try {
    config = parseYaml(state.config) ?? {};
  } catch {
    config = {};
  }

  const declared = config.variables && typeof config.variables === 'object' ? config.variables : {};
  const vars = new Map();
  const conds = [];

  const ensure = (name) => {
    if (!vars.has(name)) vars.set(name, { init: declared[name], sets: [], conds: [] });
    return vars.get(name);
  };

  for (const name of Object.keys(declared)) ensure(name);

  for (const id of Object.keys(state.chapters)) {
    let items = [];
    try {
      items = parseEvents(chapterText(id)).items;
    } catch {
      items = [];
    }

    const addCond = (expr, index) => {
      conds.push({ id, index, expr });

      for (const name of String(expr).match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? []) {
        if (/^(?:true|false|null|and|or|not)$/i.test(name)) continue;
        ensure(name).conds.push({ id, index, expr });
      }
    };

    const assign = (statement, index) => {
      const match = String(statement).match(/^\s*([\p{L}_][\p{L}\p{N}_]*)/u);
      if (match) ensure(match[1]).sets.push({ id, index });
    };

    items.forEach((item, index) => {
      const event = item.obj;
      if (!event) return;

      if (typeof event.set_var === 'string') assign(event.set_var, index);

      if ((event.type === 'set_variable' || event.type === 'set_var') && event.name) {
        ensure(event.name).sets.push({ id, index });
      }

      for (const action of event.actions ?? []) {
        if (typeof action.set_var === 'string') assign(action.set_var, index);
      }

      for (const option of event.options ?? []) {
        if (typeof option.condition === 'string') addCond(option.condition, index);

        for (const action of option.actions ?? []) {
          if (typeof action.set_var === 'string') assign(action.set_var, index);
        }
      }

      if (typeof event.condition === 'string') addCond(event.condition, index);
    });
  }

  const sum = document.createElement('div');
  sum.className = 'sec';
  sum.textContent = `变量 ${vars.size} 个 · 条件 ${conds.length} 处`;
  pane.appendChild(sum);

  if (!vars.size) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '剧本里还没有变量。在 story_config 的 variables 里声明，或在事件里用 set_variable。';
    pane.appendChild(empty);
  }

  for (const [name, info] of vars) {
    const row = document.createElement('div');
    row.className = 'var-row';

    const key = document.createElement('b');
    key.textContent = name;

    const meta = document.createElement('span');
    meta.textContent = `${info.init === undefined ? '未声明' : `初值 ${String(info.init)}`} · 赋值 ${info.sets.length} · 条件 ${info.conds.length}`;

    row.append(key, meta);
    pane.appendChild(row);

    for (const use of info.sets.slice(0, 4)) {
      const line = document.createElement('div');
      line.className = 'var-use';
      line.textContent = `赋值 · ${use.id} #${use.index + 1}`;
      line.addEventListener('click', () => goTo(use.id, use.index));
      pane.appendChild(line);
    }
  }

  if (conds.length) {
    const title = document.createElement('div');
    title.className = 'sec';
    title.textContent = '条件';
    pane.appendChild(title);

    for (const item of conds) {
      const row = document.createElement('div');
      row.className = 'cond-row';

      const code = document.createElement('code');
      code.textContent = item.expr;

      row.append(code, document.createTextNode(` · ${item.id} #${item.index + 1}`));
      row.addEventListener('click', () => goTo(item.id, item.index));
      pane.appendChild(row);
    }
  }
}

function setTab(name) {
  $('tabOutline').classList.toggle('on', name === 'outline');
  $('tabVars').classList.toggle('on', name === 'vars');
  $('paneOutline').hidden = name !== 'outline';
  $('paneVars').hidden = name !== 'vars';
}

// ---------------------------------------------------------------- 路线图
//
// 只看 chapter_end：linear 取 next，branching / ai_judged 逐条 options。
// 节点位置按「从 intro 出发的层数」排；指不到的章节单独放到最后一列并标红。

const NODE_W = 140;
const NODE_H = 46;
const GAP_X = 70;
const GAP_Y = 18;

function endModeOf(event) {
  return event.mode ?? event.end_type
    ?? (event.next_chapter || event.next ? 'linear' : event.options?.some((option) => option.condition !== undefined) ? 'branching' : 'ai_judged');
}

/** 一章里所有 chapter_end 的原始信息（路线图与局部重写共用） */
function endTargetsOf(id) {
  return parseEvents(chapterText(id)).items
    .filter((item) => item.obj?.type === 'chapter_end')
    .map((item) => ({ event: item.obj, mode: endModeOf(item.obj), options: item.obj.options ?? [] }));
}

/** 剧情推进边（只保留真实存在的目标章节，不含 end / 结局节点） */
function storyEdges() {
  const edges = [];

  for (const id of Object.keys(state.chapters)) {
    for (const { event, mode, options } of endTargetsOf(id)) {
      const targets = mode === 'linear'
        ? [event.next ?? event.next_chapter]
        : options.map((option) => option.next ?? option.next_chapter);

      for (const raw of targets) {
        const to = normalizeChapterId(raw ?? '');
        if (to && to !== 'end' && state.chapters[to] !== undefined) edges.push({ from: id, to });
      }
    }
  }

  return edges;
}

/** 从 start 出发按 chapter_end 能走到的章节（含 start，BFS 顺序） */
function reachableFrom(start) {
  const edges = storyEdges();
  const order = [start];

  for (let i = 0; i < order.length; i++) {
    for (const edge of edges) {
      if (edge.from === order[i] && !order.includes(edge.to)) order.push(edge.to);
    }
  }

  return order;
}

function openRoute() {
  commit();

  const nodes = new Map();
  const edges = [];
  const issues = [];

  let config = {};
  try { config = parseYaml(state.config) ?? {}; } catch { config = {}; }

  const titles = config.chapter_titles ?? {};
  const chapters = Object.keys(state.chapters);
  const intro = normalizeChapterId(config.intro_chapter ?? config.introChapter ?? '') || chapters[0] || '';

  const nodeOf = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: typeof titles[id] === 'string' ? titles[id] : id, real: true, level: -1 });
    return nodes.get(id);
  };

  const endingNode = (event, option) => {
    const title = option?.ending_title ?? option?.endingTitle ?? event?.ending_title ?? event?.endingTitle ?? '剧终';
    const key = `__end__:${title}`;
    if (!nodes.has(key)) nodes.set(key, { id: key, label: title, real: false, level: -1, ending: true });
    return key;
  };

  for (const id of chapters) nodeOf(id);

  const link = (from, to, label) => edges.push({ from, to, label });
  const isEnd = (target) => target === 'end' || target === '';

  for (const id of chapters) {
    const ends = endTargetsOf(id);

    if (!ends.length) {
      issues.push({ kind: 'warn', text: `${id}：没有 chapter_end，播完会直接结束（隐性结局）` });
    }

    for (const { event, mode, options } of ends) {
      if (mode === 'linear') {
        const target = String(event.next ?? event.next_chapter ?? '');
        link(id, isEnd(target) ? endingNode(event) : target, '');
        continue;
      }

      if (!options.length) {
        issues.push({ kind: 'err', text: `${id}：${mode} 没有 options` });
        continue;
      }

      if (mode === 'branching' && !options.some((option) => option.default === true)) {
        issues.push({ kind: 'warn', text: `${id}：branching 没有 default，条件都不满足时会直接剧终` });
      }

      for (const option of options) {
        const target = String(option.next ?? option.next_chapter ?? '');
        const label = option.condition ?? (option.default ? 'default' : option.name ?? '');
        link(id, isEnd(target) ? endingNode(event, option) : target, label);
      }
    }
  }

  // 目标不存在 → 红色 ghost 节点
  for (const edge of [...edges]) {
    if (edge.to.startsWith('__end__:')) continue;

    const target = normalizeChapterId(edge.to);

    if (chapters.includes(target)) {
      edge.to = target;
    } else {
      edge.missing = target;
      issues.push({ kind: 'err', text: `${edge.from} → ${edge.to}：目标章节不存在` });
      if (!nodes.has(target)) nodes.set(target, { id: target, label: target, real: false, level: -1, missing: true });
      edge.to = target;
    }
  }

  // 从 intro 做 BFS 分层
  const levels = new Map();

  if (intro && nodes.has(intro)) {
    levels.set(intro, 0);
    const queue = [intro];

    while (queue.length) {
      const id = queue.shift();

      for (const edge of edges) {
        if (edge.from !== id || levels.has(edge.to)) continue;
        if (!nodes.has(edge.to)) continue;

        levels.set(edge.to, (levels.get(id) ?? 0) + 1);
        queue.push(edge.to);
      }
    }
  } else {
    issues.push({ kind: 'err', text: `找不到开篇章节 intro_chapter（当前：${intro || '空'}）` });
  }

  const maxLevel = Math.max(0, ...levels.values());

  for (const [id, node] of nodes) {
    if (levels.has(id)) {
      node.level = levels.get(id);
    } else {
      node.level = maxLevel + 1;
      if (node.real) issues.push({ kind: 'warn', text: `${id}：从开篇走不到这个章节` });
    }
  }

  const columns = new Map();
  for (const node of nodes.values()) {
    if (!columns.has(node.level)) columns.set(node.level, []);
    columns.get(node.level).push(node);
  }

  const widest = Math.max(1, ...[...columns.values()].map((list) => list.length));
  const width = (maxLevel + 2) * (NODE_W + GAP_X);
  const height = Math.max(1, widest) * (NODE_H + GAP_Y) + 24;

  const position = new Map();
  for (const node of nodes.values()) {
    const list = columns.get(node.level);
    const index = list.indexOf(node);
    node.x = node.level * (NODE_W + GAP_X) + 12;
    node.y = index * (NODE_H + GAP_Y) + 12;
    position.set(node.id, node);
  }

  renderRouteSvg(position, edges, width, height);
  renderRouteIssues(issues, nodes, intro);
  $('routeDialog').showModal();
}

function renderRouteSvg(position, edges, width, height) {
  const wrap = $('routeWrap');
  wrap.textContent = '';

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.classList.add('rt-svg');

  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = '<marker id="rtArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(143,154,176,.85)"/></marker>';
  svg.appendChild(defs);

  for (const edge of edges) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);

    if (!from || !to) continue;

    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', `rt-edge${edge.missing ? ' missing' : ''}`);
    path.setAttribute('marker-end', 'url(#rtArrow)');
    svg.appendChild(path);

    if (edge.label) {
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(mid));
      label.setAttribute('y', String((y1 + y2) / 2 - 5));
      label.setAttribute('class', 'rt-edge-label');
      label.textContent = edge.label.length > 26 ? edge.label.slice(0, 25) + '…' : edge.label;

      const hint = document.createElementNS(NS, 'title');
      hint.textContent = edge.label;
      label.appendChild(hint);

      svg.appendChild(label);
    }
  }

  for (const node of position.values()) {
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', `rt-node${node.ending ? ' ending' : ''}${node.missing ? ' missing' : ''}`);
    group.setAttribute('transform', `translate(${node.x}, ${node.y})`);

    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('width', String(NODE_W));
    rect.setAttribute('height', String(NODE_H));
    rect.setAttribute('rx', '9');
    group.appendChild(rect);

    const title = document.createElementNS(NS, 'text');
    title.setAttribute('x', '12');
    title.setAttribute('y', '19');
    title.setAttribute('class', 'rt-title');
    title.textContent = node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label;
    group.appendChild(title);

    const sub = document.createElementNS(NS, 'text');
    sub.setAttribute('x', '12');
    sub.setAttribute('y', '35');
    sub.setAttribute('class', 'rt-sub');
    sub.textContent = node.ending ? '结局' : node.missing ? '不存在' : node.id;
    group.appendChild(sub);

    const hint = document.createElementNS(NS, 'title');
    hint.textContent = `${node.label}（${node.id}）`;
    group.appendChild(hint);

    if (node.real) {
      group.style.cursor = 'pointer';
      group.addEventListener('click', () => selectChapter(node.id));
    }

    svg.appendChild(group);
  }

  wrap.appendChild(svg);
}

function renderRouteIssues(issues, nodes, intro) {
  const box = $('routeIssues');
  box.textContent = '';

  const endings = [...nodes.values()].filter((node) => node.ending).length;
  const real = [...nodes.values()].filter((node) => node.real).length;

  const head = document.createElement('div');
  head.className = 'rt-head';
  head.textContent = `${real} 个章节 · ${endings} 个结局 · 开篇 ${intro || '未设置'}`;
  box.appendChild(head);

  if (!issues.length) {
    const ok = document.createElement('div');
    ok.className = 'rt-issue ok';
    ok.textContent = '路线没问题：每个章节都能从开篇走到，跳转目标都存在。';
    box.appendChild(ok);
    return;
  }

  for (const issue of issues) {
    const line = document.createElement('div');
    line.className = `rt-issue ${issue.kind}`;
    line.textContent = `${issue.kind === 'err' ? '✕' : '⚠'} ${issue.text}`;
    box.appendChild(line);
  }
}

function selectChapter(id) {
  commit();
  state.current = id;
  renderList();
  showCurrent();
  $('routeDialog').close();
  report('ok', `已切到章节 ${id}。`);
}

// ---------------------------------------------------------------- AI 生成

const SCHEMA = `输出必须是 JSON（不要 markdown 代码块），结构：
{
  "config": "story_config.yaml 全文（字符串）",
  "chapters": { "章节id": "该章节 yaml 全文（字符串）" }
}

story_config.yaml 必须包含：
script_name, version: 1, author, description, player_name, intro_chapter,
variables: { 变量名: 初始值 },
chapter_titles: { 章节id: 标题 },
characters: { 角色id: { name: 中文名, color: '#7bd1ff',
  system_prompt: '人设（可选，隔离模式会带给模型）',
  examples: ['玩家台词', '角色台词'],  // 示例对话，可选
  voice_model: '声线名（可选，预留）' } }

每个章节 yaml 顶层只有 events: 数组，元素形如：
- type: background   # path: 场景名, transition: 0.8（秒，可选；写了才淡入淡出）
- type: effect       # name: rain
- type: music        # path, speed, transition: 0.8（秒，可选）
- type: show_character  # character, position(center/left/right), emotion, clothing
- type: narration    # text, displayName（可选，默认不显示名字）
- type: player       # text, displayName（玩家自己说的既定台词）
- type: ai_dialogue  # character, prompt（这句交给模型说；没写 text 时只显示占位旁白）
- type: dialogue     # character, emotion, clothing, text, displayName, displaySubtitle（后两个可选）
- type: choices      # prompt, allow_free, options: [{ text, actions: [{ set_var: "affection += 3" }, { add_line: "玩家说的这句" }] }]
- type: input        # prompt, hint（输入框占位提示，可选）
- type: set_variable # name, value
- type: modify_character # character, emotion, clothing
- type: free_dialogue # max_rounds, end_line, prompt（给模型）, end_prompt（收尾提示）, hint（给玩家）
- type: chapter_end  # mode: branching, options: [{ condition: "route == A", next: "章节id" }, { default: true, next: "章节id" }]
                     # mode: ai_judged 时 options 写 [{ name: "好结局", next: "章节id" }, { name: "坏结局", next: "章节id", default: true }]，由模型从 name 里选

要求：对白短句（20-40 字）、一次一句；每章 12-25 个事件；选项 2-3 个且影响变量；
chapter_end 的 next 必须是上面 chapters 里存在的 id；条件只用 == != 和 && 。
任意事件都可以加 condition（如 condition: "affection >= 10"），不满足就跳过，不用为此拆章节。
dialogue / narration 的 text 里换行就自动一行一页，不用拆成多条事件。
一句台词里要换表情/服装/场景时，在 text 中内联 [表情:害羞]、[服装:私服]、[场景:天台_傍晚]，
标签只管它后面那一句；剧本会按标点拆成几小段，一段一次点击。表情/服装/场景名用素材里的中文名。
选项 actions 里 set_var 改数值，add_line 记录玩家说过的台词（写台词，不是加数值）。
隔离模式会读角色卡的 system_prompt / examples；模型回复里的【情绪】、<TTS>、（）动作会被窗口解析。
背景 / BGM 写 transition: 秒数 才会淡入淡出，不写就直切。
dialogue 的 displayName / displaySubtitle 只改铭牌与副标题，不影响立绘差分。
input 的 hint 是输入框占位提示，prompt 仍会作为剧情里那句提示演出来。
ai_judged 的 name 要短而明确（如「好结局」「坏结局」），模型只回其中一个。`;

/**
 * 优先问插件：剧情窗口的本地服务会把需求转给 Alife 里已经配好的模型，
 * 用户在插件里一个字都不用填。打不通（比如直接用 demo/serve.mjs 打开）才回落到手填配置。
 */
async function generateViaHost(idea) {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: idea,
  });

  if (!response.ok) throw new Error(`host ${response.status}`);

  const data = await response.json();
  if (data?.error) throw new Error(data.error);
  if (!data?.chapters) throw new Error('没有 chapters');

  return data;
}

/** 让模型返回一份 JSON：插件内有模型就直接用，没有才回落到手填接口 */
async function requestJSON(prompt) {
  try {
    return await generateViaHost(prompt);
  } catch (hostError) {
    console.info('[editor] 插件接口不可用，回落到手填配置：', hostError.message);
  }

  const cfg = JSON.parse(localStorage.getItem(LS_LLM) ?? '{}');
  if (!cfg.baseUrl || !cfg.key || !cfg.model) throw new Error('没有可用的模型：在 Alife 里打开时直接用插件模型；否则先点「AI 生成剧情」填一次接口地址 / Key / 模型。');

  const base = cfg.baseUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.9,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: `你是 galgame 剧本作者，按给定 schema 产出可被引擎直接运行的剧本。${SCHEMA}` },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) throw new Error(`接口 ${response.status}：${(await response.text()).slice(0, 160)}`);

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? '';

  return JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
}

async function generate(idea, depth = 0) {
  applyStory(await requestJSON(`写一个短篇：${idea}`));

  // 校验不过就把错误回喂一次，让模型自己修（只重试一轮，避免无限循环）
  if (lastErrors.length && depth < 1) {
    const hint = '\n\n上一次生成的剧本校验失败，错误如下，请修正后重新输出完整 JSON：\n'
      + lastErrors.slice(0, 6).map((line) => '· ' + line).join('\n');

    report('warn', '校验未通过，正在把错误回传给模型重试……');
    return generate(idea + hint, depth + 1);
  }

  return json;
}

/** 把模型（或插件）返回的 config / chapters 灌进编辑器并立刻校验 */
function applyStory(json) {
  if (!json.config || !json.chapters) throw new Error('模型没有返回 config / chapters');

  state.config = json.config;
  state.chapters = json.chapters;
  state.current = Object.keys(json.chapters)[0] ?? '';

  snapshot();
  renderList();
  showCurrent();
  validate();

  return json;
}

// ---------------------------------------------------------------- 局部重写
//
// 从当前章节开始，沿 chapter_end 取「能走到」的章节集合，只让模型重写这一块；
// 集合外的章节、config、章节 id 全部锁定。改完先整本校验，通过才落盘。

let rewriteStart = '';
let rewriteScope = [];

/** 当前章节 + 它的下游（BFS 顺序） */
function rewritePlan(start, mode) {
  if (mode === 'only') return [start];
  return reachableFrom(start);
}

/** 从 start 到结局的所有不重复路径（每条路径就是一个分支） */
function branchPaths(start) {
  const edges = storyEdges();
  const paths = [];

  const walk = (id, ids) => {
    const next = [...new Set(edges.filter((edge) => edge.from === id).map((edge) => edge.to))];

    if (!next.length) {
      paths.push(ids);
      return;
    }

    for (const to of next) {
      if (ids.includes(to)) {
        paths.push(ids);
        continue;
      }

      walk(to, [...ids, to]);
    }
  };

  walk(start, [start]);

  // 同一串章节只留一条（前缀不同的写法会得到相同后缀时去重）
  const seen = new Set();
  return paths.filter((ids) => {
    const key = ids.join('>');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function titleMap() {
  try {
    return parseYaml(state.config)?.chapter_titles ?? {};
  } catch {
    return {};
  }
}

function excerpt(text, limit) {
  const clean = String(text ?? '').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}\n…` : clean;
}

function buildRewritePrompt(start, scopeIds, bad, want) {
  const titles = titleMap();
  const kept = Object.keys(state.chapters).filter((id) => !scopeIds.includes(id));
  const parts = [];

  parts.push('【局部重写】这是一次局部重写，不是新剧本。只重写下面「需要重写的章节」，其余章节与 story_config 保持不变。');
  parts.push(`【作品设定】\n${state.config.trim()}`);

  if (kept.length) {
    parts.push(`【保持不变的其他章节】\n${kept.map((id) => `${id}（${titles[id] ?? id}）`).join('、')}`);
  }

  const siblings = reachableFrom(start).filter((id) => !scopeIds.includes(id));

  if (siblings.length) {
    parts.push(`【同一起点下的其他分支（这次绝对不要改）】\n${siblings.map((id) => `${id}（${titles[id] ?? id}）`).join('、')}`);
  }

  const before = [...new Set(storyEdges().filter((edge) => edge.to === start && !scopeIds.includes(edge.from)).map((edge) => edge.from))];

  if (before.length) {
    const block = before.slice(0, 2).map((id) => `### ${id}（${titles[id] ?? id}）\n${excerpt(state.chapters[id], 3000)}`).join('\n\n');
    parts.push(`【前情提要（不会改，只作上下文）】\n${block}`);
  }

  const blocks = scopeIds.map((id) => `### ${id}（${titles[id] ?? id}）\n${String(state.chapters[id] ?? '').trim()}`);
  parts.push(`【需要重写的章节】（顺序即剧情推进顺序）\n${blocks.join('\n\n')}`);

  parts.push([
    '【必须遵守】',
    '1. chapters 的键必须与上面「需要重写的章节」完全一致，不得增删、不得改名。',
    `2. chapter_end 的 next 只能是：${scopeIds.join('、')}${kept.length ? `、${kept.join('、')}` : ''}，或 end。`,
    '3. config 原样抄回，不要改变量、角色、章节标题。',
    '4. 每章 12-25 个事件；对白一次一句；选项 2-3 个且影响变量。',
    '5. 条件只支持 == != 与 &&。',
  ].join('\n'));

  parts.push(`【用户要求】\n哪里不满意：${bad}\n希望改成：${want || '（没写，按不满意的地方自行处理）'}`);

  return parts.join('\n\n');
}

/** 只接受 scope 内、能被 YAML 解析成 events 数组的章节 */
function mergeRewrite(base, json, scopeIds) {
  const merged = { ...base };
  const replaced = [];
  const invalid = [];

  for (const [rawId, text] of Object.entries(json?.chapters ?? {})) {
    const id = normalizeChapterId(rawId);

    if (!scopeIds.includes(id) || typeof text !== 'string' || !text.trim()) continue;

    try {
      const clean = text.replace(/^\s*```(?:ya?ml)?\s*/i, '').replace(/\s*```\s*$/, '');
      const parsed = parseYaml(clean);
      if (!Array.isArray(parsed?.events)) throw new Error('缺少 events 数组');
      merged[id] = clean;
      replaced.push(id);
    } catch {
      invalid.push(id);
    }
  }

  return { merged, replaced, invalid, missing: scopeIds.filter((id) => !replaced.includes(id)) };
}

async function rewriteStory(start, scopeIds, bad, want) {
  commit();

  const prompt = buildRewritePrompt(start, scopeIds, bad, want);
  const base = { ...state.chapters };

  for (let attempt = 0; attempt < 2; attempt++) {
    const ask = attempt === 0
      ? prompt
      : `${prompt}\n\n【上一次的稿子校验失败，请修正后重新输出完整 JSON】\n${lastErrors.slice(0, 8).map((line) => '· ' + line).join('\n')}`;

    const json = await requestJSON(ask);
    const { merged, replaced, invalid, missing } = mergeRewrite(base, json, scopeIds);

    if (!replaced.length) {
      if (attempt === 0) {
        lastErrors = [`返回的章节 YAML 都解析不了（${[...invalid, ...missing].join('、') || '没有返回章节'}），请按 events 数组格式重写。`];
        report('warn', '模型返回的内容解析不了，正在让它重写一次……');
        continue;
      }

      throw new Error('模型两次都没有返回可用的章节内容，原稿未改动。');
    }

    const { report: res } = loadAndValidate(state.config, merged);
    const errors = res?.errors ?? [];

    if (!errors.length) {
      state.chapters = merged;
      state.current = start;
      dirty = false;
      snapshot();
      renderList();
      showCurrent();
      validate();

      const notes = [`已重写 ${replaced.length} 章：${replaced.join('、')}`];
      if (missing.length) notes.push(`模型漏了 ${missing.join('、')}，保留原文`);
      if (invalid.length) notes.push(`${invalid.join('、')} 的 YAML 解析失败，保留原文`);
      report('ok', notes.join('\n'));
      return replaced;
    }

    lastErrors = errors;

    if (attempt === 0) {
      report('warn', '重写后的剧本校验没过，正在把错误回给模型再改一次……');
      continue;
    }

    throw new Error(`重写后校验仍不通过，原稿未改动：\n${errors.slice(0, 8).map((line) => '· ' + line).join('\n')}`);
  }

  return [];
}

function openRewrite() {
  commit();

  if (!state.current) {
    report('err', '先选一个章节，再从它开始重写。');
    return;
  }

  rewriteStart = state.current;
  const titles = titleMap();
  $('rwStart').textContent = `${titles[rewriteStart] ?? rewriteStart}（${rewriteStart}）`;

  $('rwScope').value = 'from';
  $('rwPath').dataset.start = '';
  $('rwBad').value = '';
  $('rwWant').value = '';

  renderRewriteScope();
  $('rwDialog').showModal();
}

let rewritePaths = [];

function renderRewriteScope() {
  const mode = $('rwScope').value;
  const titles = titleMap();
  const pathRow = $('rwPathRow');
  const select = $('rwPath');

  pathRow.hidden = mode !== 'branch';

  if (mode === 'branch') {
    if (select.dataset.start !== rewriteStart) {
      rewritePaths = branchPaths(rewriteStart);
      select.textContent = '';

      rewritePaths.forEach((ids, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = ids.map((id) => titles[id] ?? id).join(' → ');
        select.appendChild(option);
      });

      select.dataset.start = rewriteStart;
    }

    const chosen = Math.min(Number(select.value) || 0, Math.max(0, rewritePaths.length - 1));
    rewriteScope = rewritePaths[chosen] ?? [rewriteStart];
  } else {
    rewriteScope = rewritePlan(rewriteStart, mode);
  }

  $('rwChapters').textContent = rewriteScope
    .map((id) => `· ${id}（${titles[id] ?? id}）`)
    .join('\n');

  $('rwGo').textContent = `重写这 ${rewriteScope.length} 章`;
}

// ---------------------------------------------------------------- 绑定

$('editor').addEventListener('input', () => {
  dirty = true;
  if ($('editor').dataset.mode === 'config') state.config = $('editor').value;

  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    renderOutline();
    renderVars();
  }, 350);
});

$('btnLoad').addEventListener('click', () => loadCurrent().catch((e) => report('err', `载入失败：${e.message}`)));
$('btnCheck').addEventListener('click', () => validate());
$('btnRoute').addEventListener('click', openRoute);
$('routeClose').addEventListener('click', () => $('routeDialog').close());
$('btnPlay').addEventListener('click', play);
$('btnExport').addEventListener('click', exportYaml);
$('btnRewrite').addEventListener('click', openRewrite);
$('rwClose').addEventListener('click', () => $('rwDialog').close());
$('rwScope').addEventListener('change', renderRewriteScope);
$('rwPath').addEventListener('change', renderRewriteScope);

$('rwGo').addEventListener('click', async (event) => {
  event.preventDefault();

  const bad = $('rwBad').value.trim();
  if (!bad) {
    report('err', '先写一句「哪里不满意」，否则模型不知道往哪改。');
    $('rwBad').focus();
    return;
  }

  const scopeIds = rewriteScope.slice();

  $('rwGo').disabled = true;
  report('warn', `正在重写 ${scopeIds.length} 章，可能需要几十秒……`);

  try {
    await rewriteStory(rewriteStart, scopeIds, bad, $('rwWant').value.trim());
    $('rwDialog').close();
  } catch (error) {
    report('err', `重写失败：${error.message}`);
  } finally {
    $('rwGo').disabled = false;
  }
});

$('btnAddEvent').addEventListener('click', openNewNode);
$('nodeClose').addEventListener('click', () => $('nodeDialog').close());
$('nodeApply').addEventListener('click', applyNode);
$('nodeDel').addEventListener('click', deleteNode);

$('tabOutline').addEventListener('click', () => setTab('outline'));
$('tabVars').addEventListener('click', () => setTab('vars'));

$('btnAdd').addEventListener('click', () => {
  commit();

  const id = prompt('新章节 id（如 route/c）：', 'route/c');
  if (!id) return;

  state.chapters[id] = 'events:\n  - type: narration\n    text: 新的段落。\n';
  state.current = id;
  snapshot();
  renderList();
  showCurrent();
});

const dialog = $('genDialog');
const saved = JSON.parse(localStorage.getItem(LS_LLM) ?? '{}');
$('genUrl').value = saved.baseUrl ?? 'https://api.deepseek.com/v1';
$('genKey').value = saved.key ?? '';
$('genModel').value = saved.model ?? 'deepseek-chat';

$('btnGen').addEventListener('click', () => dialog.showModal());

$('genGo').addEventListener('click', async (event) => {
  event.preventDefault();

  const idea = $('genIdea').value.trim();
  if (!idea) return;

  localStorage.setItem(
    LS_LLM,
    JSON.stringify({ baseUrl: $('genUrl').value.trim(), key: $('genKey').value.trim(), model: $('genModel').value.trim() }),
  );

  $('genGo').disabled = true;
  report('warn', '正在生成，可能需要十几秒……');

  try {
    await generate(idea);
    dialog.close();
  } catch (error) {
    report('err', `生成失败：${error.message}`);
  } finally {
    $('genGo').disabled = false;
  }
});

// 首屏：优先恢复草稿，否则空着等用户点载入
if (!restore()) {
  report('ok', '先点右上角「载入当前剧本」读入 story/ 下的内容，或直接「AI 生成剧情」。');
}
