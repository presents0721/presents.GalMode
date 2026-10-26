(function () {
  var WIDGET_ID = 'alife-gal-widget';
  var ver = window.__alifeGalVer || '';
  var existing = document.getElementById(WIDGET_ID);

  // 版本换了就先拆掉旧挂件：折叠按钮这类结构改动没办法靠 apply 局部生效，
  // 旧 DOM 留着会一直是老样子
  if (existing && existing.getAttribute('data-ver') !== ver) {
    existing.remove();
    existing = null;
  }

  // 节点被外部清理过（插件重载）时要重建，不能只看标记
  if (window.__alifeGalReady && existing) return;

  function fmt(value) {
    var n = Number(value || 0);
    return n.toLocaleString('zh-CN');
  }

  function skinOn() {
    return document.body.classList.contains('gal-skin');
  }

  function updateSkinButton() {
    var button = document.querySelector('#' + WIDGET_ID + ' [data-gal-skin]');
    if (!button) return;
    var on = skinOn();
    button.textContent = on ? '皮肤 ON' : '皮肤 OFF';
    button.classList.toggle('on', on);
  }

  function stageOn() {
    return document.body.classList.contains('gal-stage-on');
  }

  function updateStageButton() {
    var button = document.querySelector('#' + WIDGET_ID + ' [data-gal-stage]');
    if (!button) return;
    var on = stageOn();
    button.textContent = on ? '舞台 ON' : '舞台 OFF';
    button.classList.toggle('on', on);
  }

  // 临时诊断：把断点标在版本号上，截图即可定位（舞台稳定后删掉）
  function updateDiag() {
    var verBox = document.querySelector('#' + WIDGET_ID + ' .gal-w-ver');
    if (!verBox) return;

    var tag = verBox.querySelector('.gal-w-vtag');
    var diag = verBox.querySelector('.gal-w-diag');

    var marks = '';
    if (!document.querySelector('.chat-input-container')) marks += ' no-input';
    if (!document.querySelector('.chat-bubble-ai, .chat-bubble-user')) marks += ' no-bubble';
    if (!document.querySelector('.gal-stage')) marks += ' no-stage';

    // 导航节点是否存在：不存在就不是「被舞台盖住」，而是宿主自己折叠了
    var nav = document.querySelector('aside, nav, [class*="sidebar"], [class*="sider"], [class*="side-nav"]');
    if (!nav) marks += ' no-nav';

    var art = '';
    try {
      art = getComputedStyle(document.documentElement).getPropertyValue('--gal-stage-bg') || '';
    } catch (e) { }

    if (art.length < 20) marks += ' no-bg';

    // 解析结果里有几条选项：0 说明没认出来（类名或格式不对），
    // 大于 0 却没按钮，才是渲染/层级问题
    var optCount = 0;
    var bubbleCount = 0;

    try {
      var bubbles = document.querySelectorAll('.chat-bubble-ai');
      var lastBubble = bubbles[bubbles.length - 1];
      bubbleCount = bubbles.length;

      if (lastBubble) {
        var rawText = lastBubble.textContent || '';
        var at = rawText.lastIndexOf(OPTION_TAG);
        var parsed = at >= 0
          ? collectAfter(rawText, at + OPTION_TAG.length)
          : collectTail(rawText);

        optCount = parsed ? parsed.length : 0;
      }
    } catch (e) { }

    marks += ' b=' + bubbleCount + ' opt=' + optCount;

    if (tag) tag.textContent = 'v' + (window.__alifeGalVer || '?');
    if (diag) diag.textContent = marks;
  }

  function setStats(stats) {
    window.__alifeGalStats = stats;

    var box = document.querySelector('#' + WIDGET_ID + ' .gal-w-stats');
    if (!box) return;

    box.innerHTML = '<span>本轮 ' + fmt(stats.last) + '</span><span>累计 ' + fmt(stats.total) + '</span>';
  }

  // 聊天窗是路由切换后才出现的，给它的根容器补一个类，皮肤才能只作用在那一块
  var chatWatch = null;

  // 聊天面板：同时包住「消息气泡」和「输入框」的最小祖先。
  // 不依赖 #messageArea 之类的 ID —— 宿主版本一变，那些名字就全对不上。
  function chatRoots() {
    var input = inputHost();
    var bubble = document.querySelector('.chat-bubble-ai, .chat-bubble-user');

    var node = bubble;
    var root = null;

    while (node && node !== document.body) {
      if (input && node.contains(input)) {
        root = node;
        break;
      }
      node = node.parentElement;
    }

    // 只有「气泡和输入框确实在同一子树」时，才把中间的白底放行；
    // 否则乱标会把整页背景都抠掉。
    if (root && bubble) {
      var layer = bubble;
      var guard = 0;

      while (layer && layer !== root && layer !== document.body && guard++ < 8) {
        layer.classList.add('gal-msg-layer');
        layer = layer.parentElement;
      }
    }

    if (!root) root = input && input.parentElement;
    if (!root) return [];

    return [{ root: root, area: document.querySelector('#messageArea') }];
  }

  // 舞台挂 body 最前面：只负责铺背景，位置由 CSS fixed 决定。
  // 放进聊天面板里会被它的高度 / overflow 锁死，只能铺到消息区底部。
  // 舞台挂在聊天容器内部：宿主的白底在这一层，舞台压在上面才看得见。
  // 放到 body 最前面会被应用根容器的背景整块盖住（白屏）。
  function ensureStage(host) {
    var stage = document.getElementById('alife-gal-stage');
    var parent = host || document.body;

    if (!stage) {
      stage = document.createElement('div');
      stage.id = 'alife-gal-stage';
      stage.className = 'gal-stage';
      stage.setAttribute('data-alife-gal', '1');
    }

    // 追加到末尾：壁纸层的 z-index 也是 0，排在它后面才能盖住壁纸
    if (stage.parentElement !== parent) parent.appendChild(stage);

    return stage;
  }

  // 舞台只铺聊天区：左侧导航是宿主自己的 UI，铺上去虽然点得到但看不清。
  // 左边界取输入区的左边，窗口变化时跟着走。
  // 真正的聊天输入区：顶部的「消息前缀」输入框也带同名类，
  // querySelector 取第一个会把选项面板插到工具栏里去。
  function inputHost() {
    var list = document.querySelectorAll('.chat-input-container');
    if (!list.length) return null;

    for (var i = 0; i < list.length; i++) {
      if (list[i].querySelector('textarea')) return list[i];
    }

    return list[list.length - 1];
  }

  // 聊天区左边界：优先用输入区容器，其次用它里面的输入框
  function chatLeft() {
    var host = inputHost();
    if (!host) return 0;

    var rect = host.getBoundingClientRect();
    if (rect.left > 10) return Math.round(rect.left);

    var inner = host.querySelector('textarea, input');
    if (inner) {
      var innerRect = inner.getBoundingClientRect();
      if (innerRect.left > 10) return Math.round(innerRect.left);
    }

    return 0;
  }

  function layoutStage() {
    var stage = document.getElementById('alife-gal-stage');
    if (!stage) return null;

    // 全屏会把左边那列菜单面板一起盖掉，按输入区的左边界裁一刀
    var left = chatLeft();

    stage.style.left = left > 0 ? left + 'px' : '0px';
    stage.style.width = left > 0
      ? Math.max(0, window.innerWidth - left) + 'px'
      : '100%';

    return stage;
  }

  function tagChatRoot() {
    var roots = chatRoots();

    // 只有聊天页才挂舞台：角色设定、完整背景、功能校验这些页面不该被铺上背景
    var stage = ensureStage(roots.length ? roots[0].root : document.body);
    if (stage) stage.style.display = roots.length ? '' : 'none';

    if (!roots.length) return;

    layoutStage();

    // body 上挂个开关：聊天页才铺白底，切走以后壁纸要能回来
    document.body.classList.toggle('gal-chat', roots.length > 0);

    for (var i = 0; i < roots.length; i++) {
      var root = roots[i].root;
      var area = roots[i].area;

      root.classList.add('gal-chat-root');
      root.style.position = 'relative';

      // 工具栏是消息区的兄弟节点，它自己带一层 rgba(0,0,0,0.02) 的半透明内联底，
      // 单靠父容器变白仍会发灰，这里单独标记出来提亮。
      var head = root.firstElementChild;
      if (head && head !== area && !head.classList.contains('gal-stage')) {
        head.classList.add('gal-chat-head');
      }

      // 结构中间可能还有一层包裹，再往上兜一个
      if (root.parentElement) root.parentElement.classList.add('gal-chat-root');
    }
  }

  // 这两个标记只加一次，铺不铺白由 body.gal-chat 决定
  function tagShell() {
    var main = document.querySelector('.main-content');
    if (main) main.classList.add('gal-main');

    var app = document.querySelector('.app-container');
    if (app) app.classList.add('gal-app');
  }

  function watchChatRoot() {
    if (!window.MutationObserver || !document.body) return;

    // 每次注入都是新的闭包，旧的标记不能用（会挡住新 observer），直接换掉
    if (chatWatch) chatWatch.disconnect();

    chatWatch = new MutationObserver(tagChatRoot);
    chatWatch.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- GAL 选项：解析角色回复末尾的「【选项】」，渲染成可点的分支按钮 ----------
  var OPTION_TAG = '【选项】';
  var consumedUntil = 0;

  // 点过选项的那条回复要记住：3 秒防抖窗口过去后，若 AI 还没吐出新气泡，
  // 旧的「【选项】」会被再解析一遍，选项就自己长回来了。
  var consumedText = '';

  var OPTION_LINE = /^\s*(?:\d+|[A-Da-d])\s*[.、)]\s*(.+?)\s*$/;

  // 气泡指纹：只比对末尾 160 字会把「选项文字差不多的两条回复」误认成同一条，
  // 于是新回复永远被当成「已经点过了」，选项再也不出现。
  function bubbleKey(el) {
    var text = el.textContent || '';
    return text.length + '|' + text.slice(0, 120) + '|' + text.slice(-80);
  }

  function collectAfter(raw, from) {
    var list = [];

    raw.substring(from).split('\n').forEach(function (line) {
      var matched = line.match(OPTION_LINE);
      if (matched && matched[1]) list.push(matched[1]);
    });

    return list;
  }

  // 没写标记时的兜底：正文末尾连续的编号行。
  // 必须跳过结尾的 `<!---->` —— 消息过滤插件要求每轮显式表示「不调用函数」，
  // 它排在选项后面，从后往前第一行就撞上它，直接 break，选项永远解析不出来。
  /** 主界面选项条的文本（去掉行首序号） */
  function collectChoiceButtons() {
    var panel = document.getElementById('alife-gal-choices');
    if (!panel) return [];

    var out = [];
    var nodes = panel.querySelectorAll('button');

    for (var i = 0; i < nodes.length; i++) {
      var text = (nodes[i].textContent || '').replace(/^\s*\d+\s*[.、)]?\s*/, '').trim();
      if (text) out.push(text);
    }

    return out.slice(0, 6);
  }

  function collectTail(raw) {
    var lines = raw.split('\n');
    var tail = [];

    for (var i = lines.length - 1; i >= 0 && tail.length <= 6; i--) {
      var line = lines[i].trim();

      if (!line) {
        if (tail.length) break;
        continue;
      }

      // 占位标记 / 残留的纯 XML 标签行（<Speak>…</Speak> 这种整行标签）
      if (line === '<!---->' || /^<[^>]+>$/.test(line)) continue;

      var matched = line.match(OPTION_LINE);
      if (matched && matched[1]) {
        tail.unshift(matched[1]);
        continue;
      }

      break;
    }

    return tail;
  }

  // 配置里的「选项个数」原来没生效，页面上永远按 4 条裁
  function choiceLimit() {
    var n = Number((window.__alifeGalConfig || {}).choiceCount);
    return n >= 2 && n <= 6 ? Math.floor(n) : 4;
  }

  // 气泡里除了台词，还有「思考过程」折叠块、<!----> 占位标记和末尾的选项行，
  // 直播窗口只要正文，否则会把整段推理当成台词念出来。
  function bubbleText(el) {
    var clone = el.cloneNode(true);
    var noise = clone.querySelectorAll('[class*="reason"], [class*="think"], [class*="thought"]');

    for (var i = 0; i < noise.length; i++) {
      if (noise[i].parentNode) noise[i].parentNode.removeChild(noise[i]);
    }

    var raw = clone.innerText || clone.textContent || '';
    var lines = raw.split('\n');
    var kept = [];

    for (var j = 0; j < lines.length; j++) {
      var line = lines[j].replace(/<!---->/g, '').trim();

      if (!line) continue;

      // 遇到第一行选项就停，后面都是给玩家点的
      if (/^(?:\d+|[A-Da-d])[.、)]\s/.test(line)) break;

      kept.push(line);
    }

    return kept.join(' ').replace(/\s+/g, ' ').trim();
  }

  // 把最近的气泡收成 JSON，供剧情窗口（C# 每 1.5s 拉一次）
  function collectHistory() {
    var nodes = document.querySelectorAll('.chat-bubble-ai, .chat-bubble-user');
    var list = [];
    var start = Math.max(0, nodes.length - 24);

    // 对话框名牌用配置里的角色名，没配就退回「她」
    var cfg = window.__alifeGalConfig || {};
    var roleName = (cfg.character || '').trim() || '她';

    for (var i = start; i < nodes.length; i++) {
      var el = nodes[i];
      var isUser = el.classList.contains('chat-bubble-user');
      var text = bubbleText(el);

      // 最后一条的标签已经被抹掉了，用 strip 之前抓的干净原文兜底
      if (!isUser && i === nodes.length - 1 && window.__alifeGalLastRaw) {
        text = String(window.__alifeGalLastRaw).replace(/\s+/g, ' ').trim();
      }

      if (!text) continue;

      // 流式输出的占位气泡、系统杂项提示（没有 <Speak/> 之类的报错）都不该进剧情历史，
      // 否则窗口里会冒出一句「输入中」并且还卡在那儿不回退。
      // 占位气泡可能带前缀（角色名/换行）或结尾省略号，按包含判断更稳
      if (/输入中|正在输入|思考中|生成中/.test(text)) continue;
      if (text.indexOf('来自系统的杂项') >= 0) continue;
      if (/^\[来自系统/.test(text)) continue;

      // 选项单独带过去，窗口要拿它渲染按钮
      // 选项优先从主界面已经渲染好的选项条里抓：
      // 模型给的往往是结构化标签，气泡正文里根本没有「1. xxx」，光解析文本永远抓不到
      var options = isUser ? [] : collectChoiceButtons();
      if (!options.length) options = collectTail(String(el.innerText || ''));

      list.push({
        role: isUser ? 'user' : 'ai',
        name: isUser ? '你' : roleName,
        text: text.slice(0, 600),
        // 和主窗口用同一个上限，改「选项个数」时两边一起变
        options: options.slice(0, choiceLimit()),
      });
    }

    return JSON.stringify(list);
  }

  // 增量拉取：内容没变就别重算 JSON，并给宿主一个 rev 做比对
  var historyJsonCache = '[]';
  var historySigCache = '';
  var historyRevValue = 0;

  /** 便宜的变化指纹：气泡数量 + 最后一条的正文 + 已渲染的选项条 */
  function historySignature() {
    var nodes = document.querySelectorAll('.chat-bubble-ai, .chat-bubble-user');
    if (!nodes.length) return '0';

    var last = nodes[nodes.length - 1];
    var text = last.innerText || last.textContent || '';
    var panel = document.getElementById('alife-gal-choices');

    return nodes.length + '|' + text.length + '|' + text.slice(0, 60) + '|' + (panel ? panel.innerText : '');
  }

  function refreshHistory() {
    var sig = historySignature();

    if (sig === historySigCache && window.__alifeGalHistory) return;

    historySigCache = sig;

    var next = collectHistory();

    // 气泡 DOM 动了但抓出来的内容一样（比如只是行高变化）：rev 不涨
    if (next === historyJsonCache && window.__alifeGalHistory) return;

    historyJsonCache = next;
    historyRevValue = (Number(window.__alifeGalHistoryRev) || 0) + 1;
    window.__alifeGalHistory = next;
    window.__alifeGalHistoryRev = historyRevValue;
  }

  // ---------- 标签驱动舞台：[场景:卧室] 这种标记，模型写、前端换画面 ----------
  var TAG_RE = /\[\s*(场景|表情|位置|CG)\s*[:：]\s*([^\]]+?)\s*\]/g;

  // 没有对应图片时的色调兜底，保证「换场景」至少能看出来
  var SCENE_FILTERS = {
    '卧室': 'none',
    '室内': 'none',
    '黄昏': 'sepia(0.22) saturate(1.15) brightness(1.04)',
    '傍晚': 'sepia(0.22) saturate(1.15) brightness(1.04)',
    '夜晚': 'brightness(0.62) saturate(0.85)',
    '深夜': 'brightness(0.55) saturate(0.8)',
    '深海': 'hue-rotate(-28deg) brightness(0.72) saturate(1.15)',
    '海边': 'hue-rotate(-18deg) brightness(0.95) saturate(1.1)'
  };

  // 没有表情图时的色调兜底
  var EMOTION_FILTERS = {
    '开心': 'brightness(1.06) saturate(1.12)',
    '微笑': 'brightness(1.05) saturate(1.1)',
    '害羞': 'saturate(1.15) hue-rotate(-6deg) brightness(1.04)',
    '生气': 'saturate(1.35) hue-rotate(-14deg) brightness(1.02)',
    '难过': 'saturate(0.65) brightness(0.9)',
    '惊讶': 'brightness(1.12) contrast(1.05)',
    '平静': ''
  };

  // filter 里不能混 none，底色只用阴影，色调再拼上去
  var CHAR_SHADOW = 'drop-shadow(0 16px 36px rgba(31, 56, 90, 0.28))';

  // 立绘站位：用 right 推位置，宽度固定 38%
  var CHAR_POSITIONS = { '左': '59%', '中': '31%', '右': '3%' };

  var stageOverride = { scene: null, emotion: null, position: null, cg: null };
  var sceneProbe = {};
  var charProbe = {};

  function readStageTags(raw) {
    var tags = [];
    var match;

    TAG_RE.lastIndex = 0;

    while ((match = TAG_RE.exec(raw))) {
      tags.push({ kind: match[1], name: match[2] });
    }

    return tags;
  }

  function paintScene(name, ok) {
    var stage = document.getElementById('alife-gal-stage');
    if (!stage) return;

    var base = window.__alifeGalAssets || '';
    var url = base ? base + 'scenes/' + encodeURIComponent(name) + '.jpg' : '';

    if (ok && url) {
      stage.style.setProperty('--gal-scene-image', 'url("' + url + '")');
      stage.style.setProperty('--gal-scene-filter', 'none');
    } else {
      stage.style.setProperty('--gal-scene-image', 'none');
      stage.style.setProperty('--gal-scene-filter', SCENE_FILTERS[name] || 'none');
    }
  }

  function applyScene(name) {
    var base = window.__alifeGalAssets || '';
    var url = base ? base + 'scenes/' + encodeURIComponent(name) + '.jpg' : '';

    if (!url) {
      paintScene(name, false);
      return;
    }

    if (sceneProbe[url] !== undefined) {
      paintScene(name, sceneProbe[url]);
      return;
    }

    var img = new Image();

    img.onload = function () {
      sceneProbe[url] = true;
      paintScene(name, true);
    };

    img.onerror = function () {
      sceneProbe[url] = false;
      paintScene(name, false);
    };

    img.src = url;
  }

  function paintEmotion(name, ok) {
    var stage = document.getElementById('alife-gal-stage');
    if (!stage) return;

    var base = window.__alifeGalAssets || '';
    var url = base ? base + 'chars/' + encodeURIComponent(name) + '.png' : '';

    if (ok && url) {
      stage.style.setProperty('--gal-char-image', 'url("' + url + '")');
      stage.style.setProperty('--gal-char-filter', CHAR_SHADOW);
    } else {
      // 没有对应表情图时退回默认立绘 + 色调
      var tint = EMOTION_FILTERS[name] || '';

      stage.style.setProperty('--gal-char-image', 'var(--gal-stage-char)');
      stage.style.setProperty('--gal-char-filter', tint ? tint + ' ' + CHAR_SHADOW : CHAR_SHADOW);
    }
  }

  function applyEmotion(name) {
    if (!name) return;

    var base = window.__alifeGalAssets || '';
    var url = base ? base + 'chars/' + encodeURIComponent(name) + '.png' : '';

    if (!url) {
      paintEmotion(name, false);
      return;
    }

    if (charProbe[url] !== undefined) {
      paintEmotion(name, charProbe[url]);
      return;
    }

    var img = new Image();

    img.onload = function () {
      charProbe[url] = true;
      paintEmotion(name, true);
    };

    img.onerror = function () {
      charProbe[url] = false;
      paintEmotion(name, false);
    };

    img.src = url;
  }

  function applyPosition(name) {
    var stage = document.getElementById('alife-gal-stage');
    if (!stage) return;

    stage.style.setProperty('--gal-char-right', CHAR_POSITIONS[name] || '3%');
  }

  function applyCg(name) {
    var stage = document.getElementById('alife-gal-stage');
    if (!stage) return;

    var layer = stage.querySelector('.gal-cg');

    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'gal-cg';
      stage.appendChild(layer);
    }

    if (!name || name === '关闭' || name === '无') {
      layer.classList.remove('show');
      return;
    }

    var base = window.__alifeGalAssets || '';
    var url = base ? base + 'cg/' + encodeURIComponent(name) + '.jpg' : '';

    if (!url) return;

    layer.style.backgroundImage = 'url("' + url + '")';
    layer.classList.add('show');
  }

  // 标签是给前端看的，不该留在气泡里给用户读
  function stripStageTags(root) {
    if (!root || !document.createTreeWalker) return;

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var node;

    while ((node = walker.nextNode())) nodes.push(node);

    for (var i = 0; i < nodes.length; i++) {
      var text = nodes[i].nodeValue;
      if (!text || text.indexOf('[') < 0) continue;

      var next = text.replace(TAG_RE, '').replace(/\n{3,}/g, '\n\n');

      if (next !== text) nodes[i].nodeValue = next;
    }
  }

  function syncStageTags() {
    var bubbles = document.querySelectorAll('.chat-bubble-ai');
    var last = bubbles[bubbles.length - 1];
    if (!last) return;

    // 标签马上就会被抹掉，先把「去掉思考过程、保留标签」的干净原文留一份
    window.__alifeGalLastRaw = bubbleText(last);

    var tags = readStageTags(last.textContent || '');
    if (!tags.length) return;

    stripStageTags(last);

    var scene = null;
    var emotion = null;
    var position = null;
    var cg = null;

    tags.forEach(function (tag) {
      if (tag.kind === '场景') scene = tag.name;
      else if (tag.kind === '表情') emotion = tag.name;
      else if (tag.kind === '位置') position = tag.name;
      else if (tag.kind === 'CG') cg = tag.name;
    });

    if (scene && scene !== stageOverride.scene) {
      stageOverride.scene = scene;
      applyScene(scene);
    }

    if (emotion && emotion !== stageOverride.emotion) {
      stageOverride.emotion = emotion;
      applyEmotion(emotion);
    }

    if (position && position !== stageOverride.position) {
      stageOverride.position = position;
      applyPosition(position);
    }

    if (cg !== null && cg !== stageOverride.cg) {
      stageOverride.cg = cg;
      applyCg(cg);
    }
  }

  function readChoices() {
    var bubbles = document.querySelectorAll('.chat-bubble-ai');
    if (!bubbles.length) return null;

    var last = bubbles[bubbles.length - 1];
    if ((last.textContent || '').indexOf('输入中') >= 0) return null; // 还在流式输出

    // 正文容器不一定还叫 .chat-message-content，取不到就退回整条气泡
    var body = last.querySelector('.chat-message-content') || last;
    var raw = body.textContent || '';

    // 这条回复已经被点过了，等新气泡再说
    if (consumedText && bubbleKey(last) === consumedText) return null;

    // 优先认标记；正文里可能出现同名字样，取最后一个
    var at = raw.lastIndexOf(OPTION_TAG);
    if (at >= 0) {
      var marked = collectAfter(raw, at + OPTION_TAG.length);
      if (marked.length >= 2) return marked.slice(0, choiceLimit());
    }

    // 模型没写标记也认：只要正文末尾是连续编号行
    var tail = collectTail(raw);
    return tail.length >= 2 ? tail.slice(0, choiceLimit()) : null;
  }

  function pickChoice(text) {
    var input = document.getElementById('chatInput');
    if (!input) return;

    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // 等 Blazor 把绑定值同步过去，再点发送
    consumedUntil = Date.now() + 3000;

    var bubbles = document.querySelectorAll('.chat-bubble-ai');
    consumedText = bubbles.length ? bubbleKey(bubbles[bubbles.length - 1]) : '';

    setTimeout(function () {
      var send = document.querySelector('.chat-input-container .ant-btn-primary');
      if (send) send.click();

      var panel = document.getElementById('alife-gal-choices');
      if (panel) panel.remove();
      releaseSpace();
    }, 80);
  }

  // 选项浮在输入区上方，会压住最后一条回复。给消息区垫一段等高的空白再滚到底，
  // 选项消失时把空白还原，别把聊天记录永久顶上去。
  var spacer = null;

  function releaseSpace() {
    if (!spacer) return;
    spacer.node.style.paddingBottom = spacer.prev;
    spacer = null;
  }

  // 真正的滚动容器：从气泡往上第一个「内容比可视高」的元素
  function scrollHost() {
    var bubble = document.querySelector('.chat-bubble-ai, .chat-bubble-user');
    var node = bubble;

    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }

    return document.querySelector('#messageArea');
  }

  function reserveSpace(height) {
    var node = scrollHost();
    if (!node) return;

    if (!spacer || spacer.node !== node) {
      releaseSpace();
      spacer = { node: node, prev: node.style.paddingBottom || '' };
    }

    node.style.paddingBottom = (height + 18) + 'px';
    node.scrollTop = node.scrollHeight;
  }

  // 面板改成参与布局（普通块），不再按视口定位。留空实现是给旧调用点兜底。
  function placePanel() { }

  function renderChoices() {
    var host = inputHost();
    if (!host) return;

    var panel = document.getElementById('alife-gal-choices');

    // 配置里关掉选项后就不再解析
    var cfg = window.__alifeGalConfig;
    if (cfg && cfg.choices === false) {
      if (panel) panel.remove();
      releaseSpace();
      return;
    }

    // 刚点过选项，等新回复出来再重新解析
    if (Date.now() < consumedUntil) return;

    var list = readChoices();

    if (!list) {
      if (panel) panel.remove();
      releaseSpace();
      return;
    }

    var sig = list.join('|');
    if (panel && panel.getAttribute('data-sig') === sig) return;
    if (panel) panel.remove();
    releaseSpace();

    panel = document.createElement('div');
    panel.id = 'alife-gal-choices';
    panel.setAttribute('data-alife-gal', '1');
    panel.setAttribute('data-sig', sig);

    list.forEach(function (text, index) {
      var btn = document.createElement('button');
      btn.type = 'button';

      var idx = document.createElement('span');
      idx.className = 'gal-c-idx';
      idx.textContent = String(index + 1);

      var label = document.createElement('span');
      label.className = 'gal-c-text';
      label.textContent = text;

      btn.appendChild(idx);
      btn.appendChild(label);
      btn.addEventListener('click', function () { pickChoice(text); });

      panel.appendChild(btn);
    });

    // 插到输入区前面（兄弟节点）：面板自己占高度，不覆盖任何内容
    var holder = host.parentElement || host;

    if (holder === host) host.insertBefore(panel, host.firstChild);
    else holder.insertBefore(panel, host);
  }

  function build(config) {
    var widget = document.createElement('div');
    widget.id = WIDGET_ID;
    widget.setAttribute('data-alife-gal', '1');
    widget.setAttribute('data-ver', window.__alifeGalVer || '');
    widget.innerHTML =
      '<div class="gal-w-head" title="点击展开 / 收起">' +
      '<span class="gal-w-dot"></span><span>GAL MODE</span>' +
      '<span class="gal-w-ver"><span class="gal-w-vtag">v' + (window.__alifeGalVer || '?') + '</span></span>' +
      '<button type="button" class="gal-w-fold" data-gal-fold title="展开 / 收起">—</button>' +
      '</div>' +
      '<div class="gal-w-stats"><span>本轮 0</span><span>累计 0</span></div>' +
      '<div class="gal-w-actions">' +
      '<button type="button" data-gal-story>剧情</button>' +
      '<button type="button" data-gal-skin>皮肤 OFF</button>' +
      '<button type="button" data-gal-stage>舞台 OFF</button>' +
      '</div>';

    document.body.appendChild(widget);

    widget.querySelector('[data-gal-skin]').addEventListener('click', function (event) {
      event.stopPropagation();
      var on = !skinOn();
      document.body.classList.toggle('gal-skin', on);
      try { localStorage.setItem('alifeGalSkin', on ? '1' : '0'); } catch (e) { }
      updateSkinButton();
    });

    // 折叠状态跟着用户走，插件重载后保持
    var foldButton = widget.querySelector('[data-gal-fold]');

    function setFolded(next) {
      widget.classList.toggle('folded', next);
      if (foldButton) foldButton.textContent = next ? '+' : '—';
      try { localStorage.setItem('alifeGalFold', next ? '1' : '0'); } catch (e) { }
    }

    var folded = false;
    try { folded = localStorage.getItem('alifeGalFold') === '1'; } catch (e) { }
    setFolded(folded);

    // 标题栏整行都能点：折叠时只剩这一行，没有它就没法展开了
    widget.querySelector('.gal-w-head').addEventListener('click', function (event) {
      event.stopPropagation();
      setFolded(!widget.classList.contains('folded'));
    });

    // 折叠时整块都能点开（标题栏之外的留白也算）
    widget.addEventListener('click', function () {
      if (widget.classList.contains('folded')) setFolded(false);
    });

    // 打不开 Electron 窗口，只能留个时间戳让 C# 侧轮询到
    var storyButton = widget.querySelector('[data-gal-story]');

    if (storyButton) {
      storyButton.addEventListener('click', function (event) {
        event.stopPropagation();
        window.__alifeGalStoryTick = Date.now();
      });
    }

    widget.querySelector('[data-gal-stage]').addEventListener('click', function (event) {
      event.stopPropagation();
      var on = !stageOn();
      document.body.classList.toggle('gal-stage-on', on);
      try { localStorage.setItem('alifeGalStage', on ? '1' : '0'); } catch (e) { }
      updateStageButton();
    });

    if (window.__alifeGalStats) setStats(window.__alifeGalStats);
  }

  window.__alifeGalApply = function (config) {
    config = config || {};

    // 版本变了就把手动开关重置回配置默认值，否则旧的 OFF 会一直盖住新默认
    var ver = window.__alifeGalVer || '';
    if (ver) {
      try {
        if (localStorage.getItem('alifeGalVer') !== ver) {
          localStorage.removeItem('alifeGalSkin');
          localStorage.setItem('alifeGalVer', ver);
        }
      } catch (e) { }
    }

    if (config.accent) {
      document.documentElement.style.setProperty('--gal-accent', config.accent);
    }

    // 素材基地址：换场景 / CG 从这里取图
    window.__alifeGalAssets = config.assets || '';

    tagShell();
    tagChatRoot();
    watchChatRoot();
    renderChoices();

    // 聊天窗随路由来回切换，轮询常驻（只做几次 getElementById，开销可忽略）。
    // 全局只留一个，重新注入时把旧的换掉，否则旧闭包会一直跑。
    if (window.__alifeGalTick) clearInterval(window.__alifeGalTick);
    window.__alifeGalTick = setInterval(function () {
      tagChatRoot();
      syncStageTags();
      renderChoices();
      updateDiag();

      try { refreshHistory(); } catch (e) { }

      var panel = document.getElementById('alife-gal-choices');
      var host = inputHost();
      if (panel && host) placePanel(panel, host);
    }, 450);

    if (!window.__alifeGalOnResize) {
      window.__alifeGalOnResize = function () {
        layoutStage();

        var panel = document.getElementById('alife-gal-choices');
        var host = inputHost();
        if (panel && host) placePanel(panel, host);
      };

      window.addEventListener('resize', window.__alifeGalOnResize);
    }

    var widget = document.getElementById(WIDGET_ID);
    if (!widget) build(config);

    widget = document.getElementById(WIDGET_ID);
    if (widget) {
      widget.style.display = config.widget === false ? 'none' : '';
    }

    // 皮肤优先级：用户的手动开关 > 配置里的默认值
    var saved = null;
    try { saved = localStorage.getItem('alifeGalSkin'); } catch (e) { }
    var on = saved === null ? !!config.skin : saved === '1';
    document.body.classList.toggle('gal-skin', on);
    updateSkinButton();

    // 舞台默认关：它会把聊天区铺满背景图，得让用户自己决定
    var stageSaved = null;
    try { stageSaved = localStorage.getItem('alifeGalStage'); } catch (e) { }
    document.body.classList.toggle('gal-stage-on', stageSaved === '1');
    updateStageButton();

    // 给剧情窗口用的回传入口：把一句话塞进聊天框并点发送
    // 从剧情窗口回传一句话。返回值必须如实反映"到底点了没有"：
    //   'true'    → 已经点了发送（C# 侧不再重试，避免重复发送）
    //   其它      → 还没点，C# 侧可以安全重试
    // 找一个真正在用的输入框：页面上有多个 textarea（消息前缀、聊天框），取最靠下的那个
    // 主窗口不在聊天页时，先把页面切过去（左侧「对话看板」）
    function goChatPage() {
      var nodes = [].slice.call(document.querySelectorAll('a,button,li,div[role="menuitem"]'));

      for (var i = 0; i < nodes.length; i++) {
        var text = String(nodes[i].textContent || '').trim();

        // 精确优先，其次包含「对话/看板/聊天」，但排除「清空对话」「删除对话」这类操作按钮
        var hit = text === '对话看板'
          || text === '聊天'
          || (/对话|看板|聊天/.test(text) && !/清空|删除|停止|管理|设定/.test(text) && text.length <= 8);

        if (hit) {
          try { nodes[i].click(); } catch (e) { }
          return true;
        }
      }

      return false;
    }

    function pickChatInput() {
      // 优先认 placeholder：截图里聊天框写的是「输入消息...」
      var preferred = document.querySelector('textarea[placeholder*="输入消息"]')
        || document.querySelector('textarea[placeholder*="输入"]');

      // 只认 placeholder 命中的那个；其它 textarea（消息前缀、最大条数等）不是聊天框
      if (!preferred) return null;

      var list = [preferred];

      list.sort(function (a, b) {
        return b.getBoundingClientRect().top - a.getBoundingClientRect().top;
      });

      return list[0];
    }

    // 只认文字是「发送」的按钮。之前按 .ant-btn-primary 抓，
    // 结果抓到了「群发」——它是个功能按钮，点了什么都不发生。
    function pickSendButton(input) {
      var scope = input.closest('form')
        || input.closest('.chat-input-container')
        || input.parentElement
        || document;

      var buttons = [].slice.call(scope.querySelectorAll('button')).filter(function (node) {
        return !node.disabled;
      });

      var exact = buttons.filter(function (node) {
        var text = String(node.textContent || '').trim();
        return text === '发送' || text === '发送消息';
      })[0];

      if (exact) return exact;

      var fuzzy = buttons.filter(function (node) {
        var text = String(node.textContent || '').trim();
        return /^发送/.test(text) && !/群发/.test(text);
      })[0];

      if (fuzzy) return fuzzy;

      // 输入框附近没有：整页找一个「发送」，排除群发/上传这类干扰项
      return [].slice.call(document.querySelectorAll('button')).filter(function (node) {
        var text = String(node.textContent || '').trim();
        return !node.disabled && text === '发送';
      })[0] || null;
    }

    // 从剧情窗口回传一句话。返回值如实反映有没有真的发出去：
    //   'true' → 已经触发发送（C# 不再重试）
    //   其它   → 还没发，C# 可以安全重试
    window.__alifeGalSend = function (text) {
      var value = String(text || '');
      if (!value) return 'empty';

      var input = document.getElementById('chatInput') || pickChatInput();

      if (!input) {
        // 不在聊天页：点一下「对话看板」再让 C# 重试
        goChatPage();
        return 'nofield';
      }

      input.focus();
      input.select && input.select();

      // 直接赋 value 对 Vue 的 v-model 不一定生效（框架内部状态仍是空的，
      // 按钮就是 disabled、回车也发不出去）。先用原生插入让框架拿到真实输入事件。
      var inserted = false;

      try {
        inserted = document.execCommand('insertText', false, value);
      } catch (error) {
        inserted = false;
      }

      if (!inserted || String(input.value || '').trim() !== value) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

        if (setter) setter.call(input, value);
        else input.value = value;

        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Blazor 的 @bind 在 change/blur 时才提交：先失焦再聚焦，确保框架吃到值
      try { input.blur(); input.dispatchEvent(new Event('change', { bubbles: true })); input.focus(); } catch (e) { }

      var send = pickSendButton(input);

      // 整页都没有「发送」按钮，说明当前不是聊天页（可能是角色管理页）：
      // 切回聊天页再让 C# 重试，别在错误的页面上瞎按回车
      if (!send) {
        var hasSend = [].slice.call(document.querySelectorAll('button')).some(function (node) {
          return String(node.textContent || '').trim() === '发送';
        });

        if (!hasSend) {
          goChatPage();
          return 'nofield';
        }
      }

      // 诊断用：窗口标题、命中元素、整页按钮文字都带上，看看到底有哪些按钮
      var allButtons = [].slice.call(document.querySelectorAll('button'))
        .map(function (node) { return String(node.textContent || '').trim().slice(0, 4); })
        .filter(function (text) { return text; })
        .slice(0, 12)
        .join('/');

      var tag = (input.placeholder || input.id || 'textarea').slice(0, 14)
        + '|title=' + String(document.title || '').slice(0, 8)
        + '|areas=' + document.querySelectorAll('textarea').length
        + '|v=' + (String(input.value || '').trim() === value ? 1 : 0);

      if (send && String(send.textContent || '').trim().startsWith('发送')) {
        send.click();

        // 不再补回车：万一第一次点击其实已经发出，回车会再发一次（之前就这样刷过屏）。
        var left = String(input.value || '').trim() === value ? 1 : 0;

        return 'true:' + tag + '|btn=' + String(send.textContent || '').trim().slice(0, 4) + '|left=' + left + '|btns=' + allButtons;
      }

      // 没有按钮就走回车：Alife 的发送键是 Enter
      var enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      input.dispatchEvent(new KeyboardEvent('keydown', enter));
      input.dispatchEvent(new KeyboardEvent('keypress', enter));
      input.dispatchEvent(new KeyboardEvent('keyup', enter));

      return 'enter:' + tag + '|btns=' + allButtons;
    };
    updateDiag();

    return 'ok';
  };

  window.__alifeGalSetStats = setStats;
  window.__alifeGalReady = true;

  // 自己应用一次：不依赖注入串末尾的调用，脚本被单独执行时也能把挂件建出来
  if (window.__alifeGalConfig) window.__alifeGalApply(window.__alifeGalConfig);
})();
