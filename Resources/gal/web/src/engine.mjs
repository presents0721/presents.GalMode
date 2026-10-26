/**
 * 剧本事件流引擎。
 *
 * 兼容 LingChat 的剧本形态（story_config + Chapters + 17 类事件），并在几处做了补齐：
 * - 条件支持比较 / 逻辑 / 括号（见 conditions.mjs）；
 * - 选项可以直接跳章，不必绕"改变量 → 章节末尾分支"；
 * - 立绘带站位，CG 会记录解锁，结局可收集；
 * - 状态可序列化成存档，多个槽位互不干扰。
 *
 * 引擎不管渲染，只负责"下一步该显示什么"，方便接任意前端。
 */

import { runAssignment, testCondition, assignmentTarget, referencedVariables, ExprError } from './conditions.mjs';

export const SAVE_VERSION = 2;

const BACKLOG_LIMIT = 300;

export class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

export class StoryEngine {
  constructor(story, options = {}) {
    if (!story || !story.chapters) throw new EngineError('剧本缺少 chapters');

    this.story = story;
    this.rng = options.rng ?? Math.random;

    this.vars = {};
    this.stage = createStage();
    this.backlog = [];
    this.unlockedCG = new Set();
    this.achievements = new Set();
    this.endings = new Set();

    this.chapterId = null;
    this.index = 0;
    this.pending = null;
    this.finished = false;
    this.ending = null;
    this.log = [];

    for (const [name, value] of Object.entries(story.variables ?? {})) {
      this.vars[name] = value;
    }
  }

  get cast() {
    return this.stage.cast;
  }

  get affection() {
    const value = this.vars.affection;
    return typeof value === 'number' ? value : 0;
  }

  /** 当前章节的事件数组。 */
  get events() {
    return this.story.chapters[this.chapterId] ?? [];
  }

  start(chapterId = null) {
    const target = chapterId ?? this.story.intro ?? Object.keys(this.story.chapters)[0];

    if (!this.story.chapters[target]) {
      throw new EngineError(`章节 ${target} 不存在`);
    }

    this.chapterId = target;
    this.index = 0;
    this.pending = null;
    this.finished = false;
    this.ending = null;

    return this.runUntilPause();
  }

  /** 从当前指针一路执行到下一个需要玩家介入的帧。 */
  runUntilPause() {
    let guard = 0;

    while (!this.finished) {
      if (++guard > 20000) {
        throw new EngineError('执行超过 20000 步，剧本可能有死循环');
      }

      const event = this.events[this.index];

      if (!event) {
        // 章节写完了却没有 chapter_end：当成隐性结局，别让玩家卡死
        this.warn(`章节 ${this.chapterId} 缺少 chapter_end，按结局处理`);
        this.finish({ id: 'implicit-end', title: '剧终', description: '' });
        break;
      }

      const frame = this.exec(event, this.index);

      if (frame) return frame;
    }

    return this.currentFrame();
  }

  /** 播放器点"继续"时调用。 */
  next() {
    if (this.finished) return this.currentFrame();

    // 台词帧看完就作废，否则 idle 时会把上一句又交出去
    this.pending = null;
    return this.runUntilPause();
  }

  choose(optionIndex) {
    const pending = this.pending;

    if (!pending || pending.type !== 'choice') {
      throw new EngineError('当前没有等待中的选项');
    }

    const option = pending.options[optionIndex];

    if (!option) throw new EngineError(`选项 ${optionIndex} 不存在`);
    if (option.locked) throw new EngineError(`选项「${option.text}」当前不可选`);

    this.pending = null;
    this.pushBacklog({ kind: 'choice', speaker: null, text: option.text });

    for (const action of option.actions ?? []) {
      this.applyAction(action);
    }

    // 选项直接跳章：粒度从「章末 chapter_end」细化到「句中任意一条分支」。
    // start() 只换章节与事件指针，变量沿用当前值 —— 不然选项里刚加的好感度会被重置。
    if (option.next) return this.start(String(option.next));

    return this.runUntilPause();
  }

  chooseBranch(name) {
    const pending = this.pending;

    if (!pending || pending.type !== 'branch') {
      throw new EngineError('当前没有等待判定的分支');
    }

    const options = pending.options ?? [];
    const chosen = options.find((option) => option.name === name)
      ?? options.find((option) => option.default === true)
      ?? options[0];

    this.pending = null;

    if (!chosen) {
      this.warn('章节分支没有命中任何目标，按结局处理');
      this.finish({ id: 'implicit-end', title: '剧终', description: '' });
      return this.currentFrame();
    }

    this.gotoChapter(chosen.next ?? 'end', pending.event ?? {});
    return this.runUntilPause();
  }

  submitInput(text) {
    if (!this.pending || this.pending.type !== 'input') {
      throw new EngineError('当前没有等待输入的事件');
    }

    this.pending = null;
    this.pushBacklog({ kind: 'line', speaker: this.playerSpeaker(), text });
    this.vars.lastInput = text;

    return this.runUntilPause();
  }

  /** 选项允许自由输入时，玩家说的这句话直接当成本轮回答（不触发选项动作）。 */
  chooseFree(text) {
    const pending = this.pending;

    if (!pending || pending.type !== 'choice') {
      throw new EngineError('当前没有等待中的选项');
    }

    if (!pending.allowFree) throw new EngineError('这个选项不允许自由输入');

    const value = String(text ?? '').trim();
    if (!value) throw new EngineError('自由输入不能为空');

    this.pending = null;
    this.pushBacklog({ kind: 'line', speaker: this.playerSpeaker(), text: value });
    this.vars.lastInput = value;

    return this.runUntilPause();
  }

  /** 自由对话结束（前端接完 LLM 后调用）。 */
  endFreeDialogue() {
    if (this.pending?.type === 'free') this.pending = null;
    return this.runUntilPause();
  }

  currentFrame() {
    if (this.ending) {
      return { type: 'end', ending: this.ending, stage: this.snapshotStage() };
    }

    if (this.pending) return this.pending;

    return { type: 'idle', stage: this.snapshotStage() };
  }

  // ------------------------------------------------------------ 事件分发

  exec(event, index) {
    const type = normalizeType(event.type);
    const base = { chapter: this.chapterId, index };

    // 事件级条件：不满足就当成没有这条事件，指针先前进，避免原地打转。
    // 这样"好感度够才多说一句"不用拆章节。
    if (typeof event.condition === 'string' && event.condition.trim()) {
      let pass = true;

      try {
        pass = testCondition(event.condition, this.vars, this.rng);
      } catch (error) {
        pass = false;
        this.warn(`事件条件求值失败，已跳过：${error.message}`);
      }

      if (!pass) {
        this.index = index + 1;
        return null;
      }
    }

    switch (type) {
      case 'dialogue':
        return this.onDialogue(event, base);

      case 'narration':
        return this.onNarration(event, base);

      case 'player':
        return this.onPlayer(event, base);

      case 'ai_dialogue':
        return this.onAiDialogue(event, base);

      case 'free_dialogue':
        return this.onFreeDialogue(event, base);

      case 'input':
        this.index = index + 1;
        return this.pause({
          type: 'input',
          prompt: event.prompt ?? '……',
          hint: String(event.hint ?? event.placeholder ?? ''),
          ...base,
        });

      case 'choices':
      case 'choice':
        return this.onChoices(event, base);

      case 'set_variable':
      case 'set_var':
        this.onSetVariable(event);
        this.index = index + 1;
        return null;

      case 'show_character':
        this.onShowCharacter(event);
        this.index = index + 1;
        return null;

      case 'hide_character':
        this.onHideCharacter(event);
        this.index = index + 1;
        return null;

      case 'modify_character':
        this.onModifyCharacter(event);
        this.index = index + 1;
        return null;

      case 'present_pic':
        this.onPresentPic(event);
        this.index = index + 1;
        return null;

      case 'music':
        this.stage.music = event.path ?? event.name ?? null;
        this.stage.musicSpeed = clampSpeed(event.speed);
        this.stage.musicTransition = readTransition(event.transition);
        this.index = index + 1;
        return null;

      case 'stop_music':
        this.stage.music = null;
        this.stage.musicTransition = readTransition(event.transition);
        this.index = index + 1;
        return null;

      case 'ambient':
        this.onAmbient(event);
        this.index = index + 1;
        return null;

      case 'sound':
        this.stage.sound = { path: event.path ?? event.name ?? null, at: Date.now() };
        this.index = index + 1;
        return null;

      case 'effect':
        this.stage.effect = event.name ?? event.effect ?? null;
        this.index = index + 1;
        return null;

      case 'background':
        this.stage.background = event.path ?? event.name ?? null;
        this.stage.backgroundTransition = readTransition(event.transition);
        this.index = index + 1;
        return null;

      case 'achievement':
        this.onAchievement(event);
        this.index = index + 1;
        return null;

      case 'chapter_end':
        return this.onChapterEnd(event, base);

      default:
        this.warn(`未知事件类型 ${event.type}，已跳过`);
        this.index = index + 1;
        return null;
    }
  }

  onDialogue(event, base) {
    const speaker = this.resolveSpeaker(event.character);
    const displayName = String(event.displayName ?? event.display_name ?? '').trim();
    const subtitle = String(event.displaySubtitle ?? event.display_subtitle ?? '').trim();

    if (event.emotion && event.character) {
      this.setEmotion(event.character, event.emotion);
    }

    const text = this.interpolate(event.text ?? '');
    // displayName 只改铭牌上的显示名，角色 id 与差分仍然按 character 走
    const shown = displayName && speaker ? { ...speaker, name: displayName } : speaker;

    this.pushBacklog({ kind: 'line', speaker: shown, text });
    this.index = base.index + 1;

    return this.pause({
      type: 'line',
      speaker: shown,
      speakerName: displayName || null,
      subtitle: subtitle || null,
      text,
      emotion: event.emotion ?? null,
      action: event.action ?? null,
      ...base,
    });
  }

  onNarration(event, base) {
    const text = this.interpolate(event.text ?? '');
    const displayName = String(event.displayName ?? event.display_name ?? '').trim();
    const subtitle = String(event.displaySubtitle ?? event.display_subtitle ?? '').trim();

    this.pushBacklog({ kind: 'narration', speaker: null, text });
    this.index = base.index + 1;

    // style: inner 内心独白 / scene 场景描写 / flash 回忆，前端按类型排版
    return this.pause({
      type: 'narration',
      text,
      style: event.style ?? '',
      speakerName: displayName || null,
      subtitle: subtitle || null,
      ...base,
    });
  }

  /** 玩家固定台词：主角自己说的既定一句，不经过输入框。 */
  onPlayer(event, base) {
    const text = this.interpolate(event.text ?? '');
    const speaker = this.playerSpeaker(event.displayName ?? event.display_name);

    this.pushBacklog({ kind: 'line', speaker, text });
    this.index = base.index + 1;

    return this.pause({
      type: 'line',
      speaker,
      text,
      action: event.action ?? null,
      ...base,
    });
  }

  onAiDialogue(event, base) {
    // 没有接大模型时降级成一段旁白，保证剧情还能往下走
    const prompt = typeof event.prompt === 'string' ? event.prompt : '';
    const speaker = this.resolveSpeaker(event.character);
    const displayName = String(event.displayName ?? event.display_name ?? '').trim();
    const subtitle = String(event.displaySubtitle ?? event.display_subtitle ?? '').trim();
    const text = this.interpolate(event.text ?? prompt);
    // 作者写了 text 就是固定台词；只有 prompt 时才是「等模型说」，前端据此决定是否演占位旁白
    const placeholder = !String(event.text ?? '').trim();
    const hinted = placeholder ? `（此处由 AI 即兴：${text || '……'}）` : text;
    const shown = displayName && speaker ? { ...speaker, name: displayName } : speaker;

    this.pushBacklog({ kind: 'line', speaker: shown, text: hinted });
    this.index = base.index + 1;

    return this.pause({
      type: 'line',
      speaker: shown,
      speakerName: displayName || null,
      subtitle: subtitle || null,
      text: hinted,
      ai: true,
      aiPlaceholder: placeholder,
      prompt,
      character: event.character ?? null,
      ...base,
    });
  }

  onFreeDialogue(event, base) {
    const rounds = Number(event.max_rounds ?? event.maxRounds ?? 0);
    this.index = base.index + 1;

    // prompt / end_prompt 是给模型看的剧情提示，不是台词；hint 是给玩家的提示
    return this.pause({
      type: 'free',
      maxRounds: Number.isFinite(rounds) ? rounds : 0,
      endLine: event.end_line ?? event.endLine ?? '',
      prompt: String(event.prompt ?? ''),
      endPrompt: String(event.end_prompt ?? event.endPrompt ?? ''),
      hint: String(event.hint ?? ''),
      character: event.character ?? null,
      ...base,
    });
  }

  onChoices(event, base) {
    const options = (event.options ?? []).map((raw, i) => {
      const condition = raw.condition;
      let locked = false;
      let reason = '';

      if (condition !== undefined && condition !== null && condition !== '') {
        try {
          locked = !testCondition(condition, this.vars, this.rng);
        } catch (error) {
          locked = true;
          reason = error.message;
        }
      }

      return {
        index: i,
        text: this.interpolate(raw.text ?? ''),
        locked,
        hint: raw.lock_hint ?? raw.lockHint ?? (locked ? reason || '条件不满足' : ''),
        actions: raw.actions ?? [],
        // 选项级跳章：LingChat 有这个字段但实现是坏的（validate 里直接忽略），我们做对
        next: raw.next ?? null,
      };
    });

    const allowFree = event.allow_free === true || event.allowFree === true;
    const usable = options.filter((option) => !option.locked);

    // 允许自由输入时，即使选项全被锁住也停下来，玩家还能自己说
    if (!usable.length && !allowFree) {
      this.warn('所有选项都被条件锁住了，自动跳过');
      this.index = base.index + 1;
      return null;
    }

    this.index = base.index + 1;

    return this.pause({
      type: 'choice',
      prompt: this.interpolate(event.prompt ?? event.text ?? ''),
      options,
      allowFree,
      ...base,
    });
  }

  onSetVariable(event) {
    // 两种写法都认：顶层 name/value/op，或者 options[].actions[]
    if (event.options?.length) {
      for (const option of event.options) {
        for (const action of option.actions ?? []) this.applyAction(action);
      }
      return;
    }

    if (event.name) {
      this.applyAction({ set_var: buildAssignment(event) });
      return;
    }

    if (event.actions?.length) {
      for (const action of event.actions) this.applyAction(action);
    }
  }

  onShowCharacter(event) {
    const id = event.character ?? event.id ?? event.name;

    if (!id) return;

    const existing = this.stage.cast.find((item) => item.id === id);
    const position = event.position ?? event.side ?? 'center';
    const emotion = event.emotion ?? existing?.emotion ?? 'normal';

    if (existing) {
      existing.emotion = emotion;
      existing.position = position;
      if (event.clothing) existing.clothing = event.clothing;
      return;
    }

    this.stage.cast.push({ id, emotion, position, clothing: event.clothing ?? null });
  }

  onHideCharacter(event) {
    const id = event.character ?? event.id ?? event.name;
    if (!id) return;
    if (id === 'all') this.stage.cast = [];
    else this.stage.cast = this.stage.cast.filter((item) => item.id !== id);
  }

  onModifyCharacter(event) {
    const id = event.character ?? event.id ?? event.name;
    if (!id) return;
    this.setEmotion(id, event.emotion ?? 'normal');

    // 只换衣服不换表情：modify_character 也认 clothing
    if (event.clothing) {
      const target = this.stage.cast.find((item) => item.id === id);
      if (target) target.clothing = event.clothing;
    }
  }

  setEmotion(id, emotion) {
    const target = this.stage.cast.find((item) => item.id === id);

    if (target) {
      target.emotion = emotion;
      return;
    }

    this.stage.cast.push({ id, emotion, position: 'center', clothing: null });
  }

  onPresentPic(event) {
    const path = event.path ?? event.name ?? '';

    // 章节末尾用空串收掉图片，这是原引擎的约定
    this.stage.cg = path || null;

    if (path) {
      this.unlockedCG.add(path);
      this.stage.cgTitle = event.title ?? null;
    }
  }

  onAmbient(event) {
    const path = event.path ?? event.ambientPath ?? event.name ?? null;

    if (!path || event.stop === true) {
      const track = event.track ?? 'main';
      this.stage.ambient = this.stage.ambient.filter((item) => item.track !== track);
      return;
    }

    const track = event.track ?? 'main';
    this.stage.ambient = this.stage.ambient.filter((item) => item.track !== track);
    this.stage.ambient.push({ track, path });
  }

  onAchievement(event) {
    const id = event.id ?? event.key;

    if (!id) return;

    if (!this.achievements.has(id)) {
      this.achievements.add(id);
      this.log.push({ kind: 'achievement', id, title: event.title ?? id });
    }
  }

  onChapterEnd(event, base = { chapter: this.chapterId, index: this.index }) {
    const mode = event.mode ?? event.end_type ?? inferEndMode(event);

    if (mode === 'linear') {
      const next = event.next_chapter ?? event.next ?? 'end';
      this.gotoChapter(next, event);
      return;
    }

    const options = event.options ?? [];
    let chosen = null;

    if (mode === 'branching') {
      chosen = options.find((option) => {
        if (option.default === true) return false;
        try {
          return testCondition(option.condition, this.vars, this.rng);
        } catch (error) {
          this.warn(`分支条件求值失败：${error.message}`);
          return false;
        }
      }) ?? options.find((option) => option.default === true);
    } else if (typeof this.story.pickBranch === 'function') {
      // ai_judged：宿主给了同步判定函数就当场定；没有就停一帧交给前端问模型
      chosen = options.find((option) => option.name === this.story.pickBranch(option.name, this.vars)) ?? null;
      chosen = chosen ?? options.find((option) => option.default === true);
    } else if (options.length) {
      return this.pause({
        type: 'branch',
        prompt: event.prompt ?? event.judge_prompt ?? event.judgePrompt ?? '',
        options: options.map((option) => ({
          name: option.name,
          next: option.next ?? option.next_chapter,
          default: option.default === true,
        })),
        event,
        ...base,
      });
    }

    if (!chosen) {
      this.warn('章节分支没有命中任何目标，按结局处理');
      this.finish({ id: 'implicit-end', title: '剧终', description: '' });
      return;
    }

    this.gotoChapter(chosen.next ?? chosen.next_chapter ?? 'end', event);
  }

  gotoChapter(next, event) {
    if (!next || next === 'end') {
      this.finish({
        id: event.ending_id ?? event.endingId ?? 'end',
        title: event.ending_title ?? event.endingTitle ?? '剧终',
        description: this.interpolate(event.ending_desc ?? event.endingDesc ?? ''),
      });
      return;
    }

    const target = String(next).replace(/\.ya?ml$/i, '');
    const key = this.story.chapters[target] ? target : this.resolveChapterByPath(target);

    if (!key) {
      this.warn(`章节 ${target} 不存在，按结局处理`);
      this.finish({ id: 'missing-chapter', title: '剧终', description: '' });
      return;
    }

    this.chapterId = key;
    this.index = 0;

    if (typeof this.onEnterChapter === 'function') this.onEnterChapter(key, this);
  }

  /** 允许用 `Intro/intro` 或 `Chapters/intro.yaml` 这样写路径。 */
  resolveChapterByPath(target) {
    const normalized = String(target)
      .replace(/^\.?\//, '')
      .replace(/^Chapters\//i, '')
      .replace(/\.ya?ml$/i, '');

    if (this.story.chapters[normalized]) return normalized;

    const tail = normalized.split('/').pop();
    return this.story.chapters[tail] ? tail : null;
  }

  finish(ending) {
    this.finished = true;
    this.ending = ending;
    this.endings.add(ending.id);
    this.pending = null;
    this.log.push({ kind: 'ending', id: ending.id, title: ending.title });
  }

  // ------------------------------------------------------------ 工具

  applyAction(action) {
    if (!action || typeof action !== 'object') return;

    if (typeof action.set_var === 'string') {
      runAssignment(action.set_var, this.vars, this.rng);
      return;
    }

    if (typeof action.setVar === 'string') {
      runAssignment(action.setVar, this.vars, this.rng);
      return;
    }

    // add_line 是「把玩家说的这句记进对话」，不是数值累加：
    // 以前把它当变量加会静默写出一个数字，导入 LingChat 剧本时行为完全不对。
    if (typeof action.add_line === 'string' || typeof action.addLine === 'string') {
      const text = this.interpolate(String(action.add_line ?? action.addLine)).trim();
      if (!text) return;

      const speaker = this.playerSpeaker(action.displayName ?? action.display_name);
      this.pushBacklog({ kind: 'line', speaker, text });
      this.vars.lastInput = text;
      return;
    }

    if (typeof action.goto === 'string' || typeof action.next === 'string') {
      this.gotoChapter(action.goto ?? action.next, {});
      return;
    }

    if (typeof action.unlock === 'string') {
      this.unlockedCG.add(action.unlock);
    }
  }

  /** 玩家说话时的显示信息：默认用 player_name，允许单条事件覆盖。 */
  playerSpeaker(displayName) {
    const character = this.story.characters?.player ?? {};

    return {
      id: 'player',
      name: String(displayName ?? character.name ?? this.story.playerName ?? '你'),
      color: character.color ?? null,
      avatar: character.avatar ?? null,
    };
  }

  resolveSpeaker(id) {
    if (!id) return null;

    const character = this.story.characters?.[id] ?? {};

    return {
      id,
      name: character.name ?? id,
      color: character.color ?? null,
      avatar: character.avatar ?? null,
    };
  }

  interpolate(text) {
    if (typeof text !== 'string') return '';

    return text
      .replace(/%player%/g, this.story.playerName ?? '你')
      .replace(/%main%/g, this.mainName())
      .replace(/\{(\w+)\}/g, (whole, name) => (name in this.vars ? String(this.vars[name]) : whole));
  }

  mainName() {
    const first = this.stage.cast[0]?.id ?? Object.keys(this.story.characters ?? {})[0];
    return this.resolveSpeaker(first)?.name ?? '她';
  }

  pause(frame) {
    // 事件级 duration：<0 或缺省 = 等点击，0 = 立刻继续，>0 = N 秒后自动推进。
    // 只挂个字段给前端调度，引擎自己仍然一帧一停，避免自动播放把逻辑跑飞。
    const duration = Number(this.events[this.index]?.duration);

    if (Number.isFinite(duration) && duration >= 0) {
      frame = { ...frame, auto: duration * 1000 };
    }

    this.pending = frame;
    return frame;
  }

  pushBacklog(entry) {
    this.backlog.push({ ...entry, chapter: this.chapterId, index: this.index, at: Date.now() });
    if (this.backlog.length > BACKLOG_LIMIT) this.backlog.splice(0, this.backlog.length - BACKLOG_LIMIT);
  }

  warn(message) {
    this.log.push({ kind: 'warn', message });
  }

  snapshotStage() {
    return {
      background: this.stage.background,
      backgroundTransition: this.stage.backgroundTransition,
      effect: this.stage.effect,
      music: this.stage.music,
      musicSpeed: this.stage.musicSpeed,
      musicTransition: this.stage.musicTransition,
      ambient: this.stage.ambient.map((item) => ({ ...item })),
      cast: this.stage.cast.map((item) => ({ ...item })),
      cg: this.stage.cg,
      cgTitle: this.stage.cgTitle,
    };
  }

  // ------------------------------------------------------------ 存档

  save(label = '') {
    return {
      version: SAVE_VERSION,
      storyId: this.story.id,
      storyVersion: this.story.version ?? 1,
      label: label || `${this.chapterId} #${this.index}`,
      savedAt: Date.now(),
      chapter: this.chapterId,
      index: this.index,
      vars: { ...this.vars },
      stage: this.snapshotStage(),
      backlog: this.backlog.map((item) => ({ ...item })),
      unlockedCG: [...this.unlockedCG],
      achievements: [...this.achievements],
      endings: [...this.endings],
      frame: this.pending ? structuredClone(this.pending) : null,
      finished: this.finished,
      ending: this.ending,
    };
  }

  static restore(snapshot, story, options = {}) {
    if (!snapshot) throw new EngineError('存档为空');
    if (snapshot.version !== SAVE_VERSION) throw new EngineError(`存档版本 ${snapshot.version} 不受支持`);
    if (story?.id && snapshot.storyId && snapshot.storyId !== story.id) {
      throw new EngineError('存档不属于这个剧本');
    }

    const engine = new StoryEngine(story, options);
    engine.chapterId = snapshot.chapter;
    engine.index = snapshot.index;
    engine.vars = { ...snapshot.vars };
    engine.stage = {
      ...createStage(),
      ...snapshot.stage,
      cast: (snapshot.stage?.cast ?? []).map((item) => ({ ...item })),
      ambient: (snapshot.stage?.ambient ?? []).map((item) => ({ ...item })),
    };
    engine.backlog = (snapshot.backlog ?? []).map((item) => ({ ...item }));
    engine.unlockedCG = new Set(snapshot.unlockedCG ?? []);
    engine.achievements = new Set(snapshot.achievements ?? []);
    engine.endings = new Set(snapshot.endings ?? []);
    engine.finished = snapshot.finished === true;
    engine.ending = snapshot.ending ?? null;

    // 存档时正停在某一句台词 / 某个选项上：直接把那一帧接回来，
    // 指针不动，读档后看到的画面和存档瞬间完全一致。
    engine.pending = snapshot.frame ?? null;

    return engine;
  }
}

// ---------------------------------------------------------------- 辅助

function createStage() {
  return {
    background: null,
    backgroundTransition: 0,
    effect: null,
    music: null,
    musicSpeed: 1,
    musicTransition: 0,
    ambient: [],
    cast: [],
    cg: null,
    cgTitle: null,
    sound: null,
  };
}

/** transition 兼容秒数与名字：缺省 = 不转场，true / 'fade' = 600ms */
function readTransition(value) {
  if (value === true) return 600;
  if (value === false || value === undefined || value === null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(5000, value * 1000));

  const text = String(value).trim().toLowerCase();
  if (!text || text === 'none' || text === 'cut' || text === 'false') return 0;

  return 600;
}

export function normalizeType(type) {
  const text = String(type ?? '').trim();
  if (!text) return '';

  const snake = text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const alias = {
    show: 'show_character',
    hide: 'hide_character',
    sprite: 'show_character',
    emotion: 'modify_character',
    pic: 'present_pic',
    cg: 'present_pic',
    bg: 'background',
    bgm: 'music',
    se: 'sound',
    end: 'chapter_end',
    var: 'set_variable',
  };

  return alias[snake] ?? snake;
}

function inferEndMode(event) {
  if (event.next_chapter || event.next) return 'linear';
  if (event.options?.some((option) => option.condition !== undefined)) return 'branching';
  return 'ai_judged';
}

function buildAssignment(event) {
  const name = event.name;
  const op = event.op ?? '=';
  const value = event.value;

  if (value === undefined || value === null) return `${name} ${op} null`;

  return `${name} ${op} ${typeof value === 'string' ? JSON.stringify(value) : value}`;
}

function clampSpeed(speed) {
  if (speed === undefined || speed === null) return 1;
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(0, n));
}

/**
 * 校验器用：把事件里出现的变量引用收集出来。
 * 返回 { targets:Set, reads:Set }。
 */
export function collectVariables(chapterEvents) {
  const targets = new Set();
  const reads = new Set();
  const declaredFirst = new Set();

  for (const event of chapterEvents) {
    if (!event) continue;

    for (const statement of statementsOf(event)) {
      const target = assignmentTarget(statement);
      if (target) {
        targets.add(target);
        declaredFirst.add(target);
      }
    }
  }

  for (const event of chapterEvents) {
    if (!event) continue;

    for (const condition of conditionsOf(event)) {
      try {
        for (const name of referencedVariables(condition, declaredFirst)) reads.add(name);
      } catch {
        // 语法错误由校验器单独报
      }
    }
  }

  return { targets, reads };
}

function statementsOf(event) {
  const out = [];

  if (typeof event.set_var === 'string') out.push(event.set_var);
  if (event.type === 'set_variable' || event.type === 'set_var') {
    if (typeof event.name === 'string' && event.value !== undefined) {
      out.push(`${event.name} ${event.op ?? '='} ${JSON.stringify(event.value)}`);
    }
    for (const option of event.options ?? []) {
      for (const action of option.actions ?? []) {
        if (typeof action.set_var === 'string') out.push(action.set_var);
      }
    }
    for (const action of event.actions ?? []) {
      if (typeof action.set_var === 'string') out.push(action.set_var);
    }
  }

  return out;
}

function conditionsOf(event) {
  const out = [];

  if (typeof event.condition === 'string') out.push(event.condition);

  for (const option of event.options ?? []) {
    if (typeof option.condition === 'string') out.push(option.condition);
  }

  return out;
}
