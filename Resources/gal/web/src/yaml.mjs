/**
 * 零依赖 YAML 子集解析器。
 *
 * 只覆盖剧本实际用到的语法：映射、序列、行内标量、块标量（| 与 >）、引号、注释。
 * 刻意不支持锚点、标签、流式集合 —— 剧本里用不到，支持它们只会让报错更难懂。
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message}（第 ${line} 行）` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

export function parseYaml(source) {
  const lines = String(source)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n');

  const ctx = { lines, pos: 0 };

  skipBlank(ctx);
  if (ctx.pos >= lines.length) return null;

  const node = parseNode(ctx, indentOf(lines[ctx.pos]));

  skipBlank(ctx);
  if (ctx.pos < lines.length) {
    throw new YamlError('缩进不一致，无法继续解析', ctx.pos + 1);
  }

  return node;
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function isSeqItem(text) {
  return /^-(?:\s|$)/.test(text);
}

function skipBlank(ctx) {
  while (ctx.pos < ctx.lines.length) {
    const text = ctx.lines[ctx.pos].trim();
    if (text && !text.startsWith('#')) return;
    ctx.pos++;
  }
}

function parseNode(ctx, indent) {
  const text = ctx.lines[ctx.pos].slice(indent);
  return isSeqItem(text) ? parseSequence(ctx, indent) : parseMapping(ctx, indent);
}

function parseSequence(ctx, indent) {
  const out = [];

  for (;;) {
    skipBlank(ctx);
    if (ctx.pos >= ctx.lines.length) break;

    const line = ctx.lines[ctx.pos];
    if (indentOf(line) !== indent) break;

    const text = line.slice(indent);
    if (!isSeqItem(text)) break;

    const restRaw = text.slice(1);
    const rest = restRaw.trim();

    if (!rest) {
      ctx.pos++;
      skipBlank(ctx);
      if (ctx.pos >= ctx.lines.length) {
        out.push(null);
        break;
      }
      const next = indentOf(ctx.lines[ctx.pos]);
      out.push(next > indent ? parseNode(ctx, next) : null);
      continue;
    }

    // `- key: value` 等价于把 `- ` 换成两个空格后解析一个映射。
    // 直接改写这一行，后续同缩进的键就能自然并入同一个映射。
    const offset = indent + 1 + (restRaw.length - restRaw.trimStart().length);
    ctx.lines[ctx.pos] = ' '.repeat(offset) + rest;

    if (looksLikeEntry(rest)) {
      out.push(parseMapping(ctx, offset));
    } else {
      out.push(scalar(rest));
      ctx.pos++;
    }
  }

  return out;
}

function parseMapping(ctx, indent) {
  const out = {};

  for (;;) {
    skipBlank(ctx);
    if (ctx.pos >= ctx.lines.length) break;

    const line = ctx.lines[ctx.pos];
    const ind = indentOf(line);
    if (ind < indent) break;

    if (ind > indent) {
      throw new YamlError(`意外的缩进（期望 ${indent} 个空格，实际 ${ind} 个）`, ctx.pos + 1);
    }

    const text = line.slice(ind);
    if (isSeqItem(text)) break;

    const sep = findKeySeparator(text);
    if (sep < 0) {
      throw new YamlError(`无法识别的行：${text}`, ctx.pos + 1);
    }

    const key = unquote(text.slice(0, sep).trim());
    const rest = text.slice(sep + 1).trim();
    ctx.pos++;

    if (!rest) {
      skipBlank(ctx);
      const next = ctx.pos < ctx.lines.length ? indentOf(ctx.lines[ctx.pos]) : -1;
      out[key] = next > indent ? parseNode(ctx, next) : null;
      continue;
    }

    if (rest[0] === '|' || rest[0] === '>') {
      out[key] = parseBlockScalar(ctx, indent, rest);
      continue;
    }

    out[key] = scalar(rest);
  }

  return out;
}

/** 找到映射键后的冒号：跳过引号内的内容，要求冒号后是空格或行尾。 */
function findKeySeparator(text) {
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }

  return -1;
}

function looksLikeEntry(text) {
  return findKeySeparator(text) > 0;
}

function parseBlockScalar(ctx, parentIndent, header) {
  const fold = header[0] === '>';
  const strip = header.includes('-');
  const collected = [];
  let blockIndent = null;

  while (ctx.pos < ctx.lines.length) {
    const line = ctx.lines[ctx.pos];

    if (!line.trim()) {
      collected.push('');
      ctx.pos++;
      continue;
    }

    const ind = indentOf(line);
    if (ind <= parentIndent) break;

    if (blockIndent === null) blockIndent = ind;
    collected.push(line.length > blockIndent ? line.slice(blockIndent) : '');
    ctx.pos++;
  }

  while (collected.length && collected[collected.length - 1] === '') collected.pop();

  if (!collected.length) return '';

  if (!fold) return collected.join('\n');

  const text = collected.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
  return strip ? text.trimEnd() : text;
}

function unquote(text) {
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    return text
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
    return text.slice(1, -1).replace(/''/g, "'");
  }

  return text;
}

function scalar(raw) {
  const text = raw.trim();

  if (!text) return null;
  if (text[0] === '"' || text[0] === "'") return unquote(text);
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  if (text === 'null' || text === 'Null' || text === '~') return null;
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  if (/^[+-]?(?:\d+\.\d*|\.\d+)$/.test(text)) return Number(text);

  return text;
}
