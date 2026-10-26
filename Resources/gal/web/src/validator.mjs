/**
 * 剧本校验：把"跑起来才发现不对"的问题提前变成可读的诊断。
 * 分三级：error 挡发布，warn 该修，info 知道就行。
 */

import { normalizeType, collectVariables } from './engine.mjs';
import { testCondition } from './conditions.mjs';

const KNOWN_TYPES = new Set([
  'dialogue',
  'narration',
  'player',
  'ai_dialogue',
  'free_dialogue',
  'input',
  'choices',
  'set_variable',
  'show_character',
  'hide_character',
  'modify_character',
  'present_pic',
  'music',
  'stop_music',
  'ambient',
  'sound',
  'effect',
  'background',
  'achievement',
  'chapter_end',
]);

export function validateStory(story) {
  const errors = [];
  const warnings = [];
  const infos = [];

  const report = (level, code, message, where = {}) => {
    const entry = { code, message, chapter: where.chapter ?? null, index: where.index ?? null };
    if (level === 'error') errors.push(entry);
    else if (level === 'warn') warnings.push(entry);
    else infos.push(entry);
  };

  const chapters = story?.chapters ?? {};
  const chapterIds = Object.keys(chapters);

  if (!chapterIds.length) {
    report('error', 'story.empty', '剧本里没有任何章节');
    return finish(errors, warnings, infos);
  }

  if (!chapters[story.intro]) {
    report('error', 'config.no_intro', `入口章节 ${story.intro} 不存在`);
  }

  // 每个剧本都被别的章节指向，才可能被玩到
  const inbound = new Map(chapterIds.map((id) => [id, 0]));
  const edges = new Map(chapterIds.map((id) => [id, []]));

  for (const chapterId of chapterIds) {
    const events = chapters[chapterId] ?? [];
    const chapterVars = analyzeChapterVars(events);

    let ended = false;

    events.forEach((event, index) => {
      const where = { chapter: chapterId, index };
      const type = normalizeType(event.type);

      if (!KNOWN_TYPES.has(type)) {
        report('error', 'event.unknown_type', `未知事件类型：${event.type}`, where);
        return;
      }

      if (ended) {
        report('warn', 'chapter_end.not_last', 'chapter_end 之后还有事件，这些内容永远不会执行', where);
      }

      // 事件级条件：语法错误会让整条事件在运行时被静默跳过
      if (typeof event.condition === 'string' && event.condition.trim()) {
        try {
          testCondition(event.condition, { ...chapterVars.known, ...(story.variables ?? {}) });
        } catch (error) {
          const missing = /变量 (\S+) 未赋值/.exec(error.message);

          if (missing) {
            report('error', 'variable.never_set', `事件条件里用到的变量 ${missing[1]} 从未赋值`, where);
          } else {
            report('error', 'condition.invalid', `事件条件无法求值：${error.message}`, where);
          }
        }
      }

      if (type === 'player' && !String(event.text ?? '').trim()) {
        report('warn', 'player.empty_text', '玩家台词是空的', where);
      }

      if (type === 'chapter_end') {
        ended = true;
        const targets = endTargets(event);

        if (!targets.length) {
          report('error', 'chapter_end.empty_target', 'chapter_end 没有写 next / next_chapter', where);
        }

        for (const target of targets) {
          if (target === 'end') continue;

          if (!resolveChapter(chapters, target)) {
            report('error', 'chapter_end.dangling', `chapter_end 指向不存在的章节：${target}`, where);
            continue;
          }

          const resolved = resolveChapter(chapters, target);
          edges.get(chapterId).push(resolved);
          inbound.set(resolved, (inbound.get(resolved) ?? 0) + 1);
        }

        checkEndMode(event, where, report);
      }

      if (type === 'choices') {
        const options = event.options ?? [];
        const allowFree = event.allow_free === true || event.allowFree === true;

        // 允许自由输入时，空选项也成立：整段就是"玩家自己说"
        if (!options.length && !allowFree) {
          report('error', 'choices.empty', '选项列表是空的', where);
        }

        const seen = new Map();

        options.forEach((option, i) => {
          const text = String(option?.text ?? '');

          if (!text) report('warn', 'choices.empty_text', `第 ${i + 1} 个选项没有文案`, where);

          if (seen.has(text)) {
            report('error', 'choices.duplicate_text', `选项文案重复：${text}`, where);
          }

          seen.set(text, i);

          if (option?.condition) {
            try {
              testCondition(option.condition, { ...chapterVars.known, ...(story.variables ?? {}) });
            } catch (error) {
              const missing = /变量 (\S+) 未赋值/.exec(error.message);

              if (missing) {
                report('error', 'variable.never_set', `条件里用到的变量 ${missing[1]} 从未赋值`, where);
              } else {
                report('error', 'condition.invalid', `选项条件无法求值：${error.message}`, where);
              }
            }
          }

          for (const action of option?.actions ?? []) {
            const target = action?.goto ?? action?.next;

            // add_line 是「把玩家这句记进对话」，写成数字是旧玩法的遗留
            const addLine = action?.add_line ?? action?.addLine;

            if (addLine !== undefined) {
              if (typeof addLine === 'number') {
                report('warn', 'add_line.not_text', 'add_line 记录的是玩家台词，数值请用 set_var', where);
              } else if (!String(addLine).trim()) {
                report('info', 'add_line.empty', 'add_line 是空的，不会产生玩家台词', where);
              }
            }

            if (typeof target === 'string') {
              if (target !== 'end' && !resolveChapter(chapters, target)) {
                report('error', 'option.dangling', `选项跳转到不存在的章节：${target}`, where);
              } else if (target !== 'end') {
                edges.get(chapterId).push(resolveChapter(chapters, target));
                inbound.set(resolveChapter(chapters, target), (inbound.get(resolveChapter(chapters, target)) ?? 0) + 1);
              }
            }
          }
        });

        // 全部选项都带条件时，运行时可能一个都点不了（有自由输入兜底就不算卡死）
        if (!allowFree && options.length && options.every((option) => option?.condition)) {
          report('warn', 'choices.all_conditional', '所有选项都带条件，条件都不满足时会卡住，建议留一个无条件选项或 allow_free', where);
        }

        if (allowFree && options.length && options.every((option) => option?.condition)) {
          report('info', 'choices.free_fallback', '所有选项都可能被锁住，但允许自由输入，玩家仍可继续', where);
        }
      }

      if (type === 'ai_dialogue') {
        const prompt = String(event.prompt ?? '').trim();
        const text = String(event.text ?? '').trim();

        // 只有 prompt 时，没接模型会显示占位旁白；提醒一句别当正式台词写
        if (!prompt && !text) {
          report('info', 'ai_dialogue.no_prompt', 'ai_dialogue 没有 prompt / text，运行时只会显示占位旁白', where);
        }
      }

      if (type === 'free_dialogue') {
        const rounds = Number(event.max_rounds ?? event.maxRounds ?? 0);
        const endLine = event.end_line ?? event.endLine ?? '';
        const endPrompt = String(event.end_prompt ?? event.endPrompt ?? '').trim();

        if (rounds <= 0 && !endLine) {
          report('error', 'free_dialogue.no_exit', '自由对话既没有轮数上限也没有结束语，玩家会出不来', where);
        }

        if (endPrompt && !event.prompt) {
          report('info', 'free_dialogue.end_prompt_only', '只写了 end_prompt，收尾提示会用在下一次生成里', where);
        }
      }

      if (type === 'present_pic' && String(event.path ?? '') !== '') {
        const last = events[events.length - 1];
        if (last !== event) {
          // 图片会一直挂在舞台上，提醒作者记得收
          const later = events.slice(index + 1);
          const cleared = later.some((item) => normalizeType(item?.type) === 'present_pic' && !item.path);
          if (!cleared) {
            report('info', 'present_pic.not_cleared', '这一章展示了图片但没在结尾收掉', where);
          }
        }
      }

      if (type === 'show_character') {
        const id = event.character ?? event.id ?? event.name;
        if (id && !story.characters?.[id]) {
          report('info', 'character.undefined', `角色 ${id} 没有在 story_config 里定义，会用 id 当名字`, where);
        }
      }
    });

    if (!ended) {
      report('error', 'chapter.no_end', `章节 ${chapterId} 没有 chapter_end`, { chapter: chapterId });
    }

    // 变量分析
    for (const name of chapterVars.reads) {
      if (!chapterVars.targets.has(name) && !(name in (story.variables ?? {}))) {
        report('error', 'variable.never_set', `条件里用到的变量 ${name} 从未赋值`, { chapter: chapterId });
      }
    }

    for (const name of chapterVars.targets) {
      if (!chapterVars.reads.has(name)) {
        report('info', 'variable.never_read', `变量 ${name} 赋值后从未被读取`, { chapter: chapterId });
      }
    }
  }

  // 可达性
  const reachable = new Set();
  const queue = [story.intro];
  while (queue.length) {
    const current = queue.shift();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    for (const next of edges.get(current) ?? []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }

  for (const id of chapterIds) {
    if (!reachable.has(id)) {
      report('warn', 'graph.unreachable', `章节 ${id} 从入口不可达`, { chapter: id });
    }
  }

  // 环：回环本身可以是设计（大厅/循环日常），所以只提醒
  const state = new Map();
  const stack = [];

  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);

    for (const next of edges.get(id) ?? []) {
      const s = state.get(next);

      if (s === 1) {
        const loop = [...stack.slice(stack.indexOf(next)), next].join(' → ');
        report('warn', 'graph.cycle', `章节存在循环：${loop}`, { chapter: id });
      } else if (!s) {
        visit(next);
      }
    }

    stack.pop();
    state.set(id, 2);
  };

  if (chapters[story.intro]) visit(story.intro);

  return finish(errors, warnings, infos);
}

function finish(errors, warnings, infos) {
  return {
    ok: errors.length === 0,
    errorCount: errors.length,
    warnCount: warnings.length,
    infoCount: infos.length,
    errors,
    warnings,
    infos,
  };
}

function analyzeChapterVars(events) {
  const { targets, reads } = collectVariables(events);
  const known = Object.fromEntries([...targets].map((name) => [name, 0]));

  return { targets, reads, known };
}

function endTargets(event) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) out.push(value.trim().replace(/\.ya?ml$/i, ''));
  };

  push(event.next_chapter);
  push(event.next);

  for (const option of event.options ?? []) {
    push(option.next);
    push(option.next_chapter);
  }

  return out;
}

function checkEndMode(event, where, report) {
  const mode = event.mode ?? event.end_type;
  const options = event.options ?? [];

  if (mode === 'linear' || (!mode && (event.next || event.next_chapter))) return;

  if (!options.length) {
    report('error', 'chapter_end.no_options', '分支式 chapter_end 缺少 options', where);
    return;
  }

  if (!options.some((option) => option.default === true)) {
    report('warn', 'chapter_end.no_default', '分支没有 default 兜底，条件都不满足时会走到结局', where);
  }

  if (mode === 'branching' || (!mode && options.some((option) => option.condition !== undefined))) {
    for (const option of options) {
      if (option.default === true) continue;

      if (!option.condition) {
        report('error', 'branch.no_condition', '分支既不是 default 也没有 condition', where);
      }

      if (!option.next && !option.next_chapter) {
        report('error', 'branch.no_next', '分支没有写 next', where);
      }
    }
  }

  // ai_judged：模型靠 name 认分支，缺名字或重名都会让判定落空
  if (mode === 'ai_judged' || (!mode && !options.some((option) => option.condition !== undefined))) {
    const seen = new Set();

    for (const option of options) {
      const name = String(option.name ?? '').trim();

      if (!name) {
        report('error', 'ai_judged.no_name', 'ai_judged 分支缺少 name，模型无法选中它', where);
        continue;
      }

      if (seen.has(name)) {
        report('error', 'ai_judged.duplicate_name', `分支名重复：${name}`, where);
      }

      seen.add(name);

      if (!option.next && !option.next_chapter) {
        report('error', 'branch.no_next', '分支没有写 next', where);
      }
    }
  }
}

/** 允许 `Intro/intro`、`Chapters/Intro/intro.yaml`、以及只写文件名。 */
export function resolveChapter(chapters, target) {
  const normalized = String(target)
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^Chapters\//i, '')
    .replace(/\.ya?ml$/i, '');

  if (chapters[normalized]) return normalized;

  const tail = normalized.split('/').pop();
  return chapters[tail] ? tail : null;
}
