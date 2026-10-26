/**
 * 条件表达式与赋值语句。
 *
 * 相比原剧本引擎只支持 `var` / `var == v` / `var != v`，这里补上了比较运算、
 * 逻辑运算、括号与算术 —— 这是"好感度 ≥ 60 才进真结局"这类写法的前提。
 * 求值走递归下降，不用 eval / new Function，剧本来自外部时也不会变成代码执行。
 */

export class ExprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExprError';
  }
}

const OPERATORS = ['&&', '||', '==', '!=', '>=', '<=', '+', '-', '*', '/', '%', '!', '(', ')', '<', '>', ','];

const astCache = new Map();

export function compileExpression(source) {
  const key = String(source);
  const cached = astCache.get(key);
  if (cached) return cached;

  const tokens = tokenize(key);
  const parser = { tokens, pos: 0 };
  const ast = parseOr(parser);

  if (peek(parser).t !== 'eof') {
    throw new ExprError(`条件后有多余内容：${peek(parser).v}`);
  }

  astCache.set(key, ast);
  return ast;
}

export function evaluateExpression(source, vars = {}, rng = Math.random) {
  return valueOf(compileExpression(source), vars, rng);
}

export function testCondition(source, vars = {}, rng = Math.random) {
  if (source === undefined || source === null || source === '') return true;
  if (typeof source === 'boolean') return source;
  return truthy(evaluateExpression(source, vars, rng));
}

/**
 * 解析并执行一条赋值语句，返回 { name, op, value }。
 * 语句里不允许直接调用有副作用的函数，random 除外。
 */
export function runAssignment(statement, vars = {}, rng = Math.random) {
  const text = String(statement ?? '').trim();
  if (!text) throw new ExprError('赋值语句为空');

  const matched = /^([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*(\+=|-=|\*=|\/=|=)\s*([\s\S]+)$/.exec(text);

  if (!matched) {
    throw new ExprError(`无法解析赋值语句：${text}`);
  }

  const [, name, op, expression] = matched;
  const next = evaluateAssignmentValue(expression, vars, rng);

  if (op === '=') {
    vars[name] = next;
    return { name, op, value: next };
  }

  if (!(name in vars)) {
    throw new ExprError(`变量 ${name} 尚未赋值，不能使用 ${op}`);
  }

  const current = vars[name];

  if (op === '+=') {
    vars[name] = typeof current === 'string' || typeof next === 'string'
      ? String(current) + String(next)
      : toNumber(current) + toNumber(next);
  } else if (op === '-=') {
    vars[name] = toNumber(current) - toNumber(next);
  } else if (op === '*=') {
    vars[name] = toNumber(current) * toNumber(next);
  } else {
    vars[name] = toNumber(current) / toNumber(next);
  }

  return { name, op, value: vars[name] };
}

/** 从语句里取出变量名，供校验器做"从未赋值 / 从未读取"分析。 */
export function assignmentTarget(statement) {
  const matched = /^\s*([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*(\+=|-=|\*=|\/=|=)/.exec(String(statement ?? ''));
  return matched ? matched[1] : null;
}

/**
 * 取出表达式里引用到的变量名。
 * 传入 declared 时会过滤掉"看起来像变量、其实是字面量"的名字 ——
 * 剧本里 `route == A` 的 A 只是字符串，不该被当成未声明变量报警。
 */
export function referencedVariables(source, declared = null) {
  const names = new Set();
  const ast = compileExpression(source);

  walk(ast, (node) => {
    if (node.type !== 'var') return;
    if (declared && !declared.has(node.name)) return;
    names.add(node.name);
  });

  return names;
}

/**
 * 赋值右值的取值方式。
 * `route = A` 里的 A 是字面量（原剧本就是这么写的），不能被当成未定义变量，
 * 所以"孤零零一个裸标识符"直接按字符串处理。
 */
function evaluateAssignmentValue(expression, vars, rng) {
  const text = String(expression).trim();
  const bare = /^[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*$/.test(text);

  if (bare && text !== 'true' && text !== 'false' && text !== 'null' && !(text in vars)) {
    return text;
  }

  return evaluateExpression(text, vars, rng);
}

// ---------------------------------------------------------------- 词法

function tokenize(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const { text, end } = readString(source, i);
      tokens.push({ t: 'str', v: text });
      i = end;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1]))) {
      const matched = /^\d*\.?\d+/.exec(source.slice(i));
      tokens.push({ t: 'num', v: Number(matched[0]) });
      i += matched[0].length;
      continue;
    }

    if (/[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
      const matched = /^[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*/.exec(source.slice(i));
      tokens.push({ t: 'ident', v: matched[0] });
      i += matched[0].length;
      continue;
    }

    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));

    if (!op) throw new ExprError(`无法识别的字符 "${ch}"`);

    tokens.push({ t: 'op', v: op });
    i += op.length;
  }

  tokens.push({ t: 'eof', v: '' });
  return tokens;
}

function readString(source, start) {
  const quote = source[start];
  let text = '';
  let i = start + 1;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\' && quote === '"') {
      text += source[i + 1] ?? '';
      i += 2;
      continue;
    }

    if (ch === quote) return { text, end: i + 1 };

    text += ch;
    i++;
  }

  throw new ExprError('字符串没有闭合');
}

// ---------------------------------------------------------------- 语法

function peek(parser) {
  return parser.tokens[parser.pos];
}

function eat(parser, v) {
  const token = peek(parser);
  if (token.v === v && token.t === 'op') {
    parser.pos++;
    return true;
  }
  return false;
}

function parseOr(parser) {
  let left = parseAnd(parser);

  while (eat(parser, '||')) {
    const right = parseAnd(parser);
    left = { type: 'binary', op: '||', left, right };
  }

  return left;
}

function parseAnd(parser) {
  let left = parseEquality(parser);

  while (eat(parser, '&&')) {
    const right = parseEquality(parser);
    left = { type: 'binary', op: '&&', left, right };
  }

  return left;
}

function parseEquality(parser) {
  let left = parseComparison(parser);

  for (;;) {
    const op = peek(parser).v;
    if ((op === '==' || op === '!=') && peek(parser).t === 'op') {
      parser.pos++;
      left = { type: 'binary', op, left, right: parseComparison(parser) };
      continue;
    }
    return left;
  }
}

function parseComparison(parser) {
  let left = parseAdditive(parser);

  for (;;) {
    const op = peek(parser).v;
    if ((op === '>' || op === '<' || op === '>=' || op === '<=') && peek(parser).t === 'op') {
      parser.pos++;
      left = { type: 'binary', op, left, right: parseAdditive(parser) };
      continue;
    }
    return left;
  }
}

function parseAdditive(parser) {
  let left = parseMultiplicative(parser);

  for (;;) {
    const op = peek(parser).v;
    if ((op === '+' || op === '-') && peek(parser).t === 'op') {
      parser.pos++;
      left = { type: 'binary', op, left, right: parseMultiplicative(parser) };
      continue;
    }
    return left;
  }
}

function parseMultiplicative(parser) {
  let left = parseUnary(parser);

  for (;;) {
    const op = peek(parser).v;
    if ((op === '*' || op === '/' || op === '%') && peek(parser).t === 'op') {
      parser.pos++;
      left = { type: 'binary', op, left, right: parseUnary(parser) };
      continue;
    }
    return left;
  }
}

function parseUnary(parser) {
  if (eat(parser, '!')) return { type: 'unary', op: '!', value: parseUnary(parser) };
  if (eat(parser, '-')) return { type: 'unary', op: '-', value: parseUnary(parser) };
  return parsePrimary(parser);
}

function parsePrimary(parser) {
  const token = peek(parser);

  if (token.t === 'num' || token.t === 'str') {
    parser.pos++;
    return { type: token.t === 'num' ? 'num' : 'str', value: token.v };
  }

  if (token.t === 'op' && token.v === '(') {
    parser.pos++;
    const inner = parseOr(parser);
    if (!eat(parser, ')')) throw new ExprError('括号没有闭合');
    return inner;
  }

  if (token.t === 'ident') {
    parser.pos++;

    const name = token.v;

    if (name === 'true') return { type: 'bool', value: true };
    if (name === 'false') return { type: 'bool', value: false };
    if (name === 'null') return { type: 'null', value: null };

    if (peek(parser).v === '(' && peek(parser).t === 'op') {
      parser.pos++;
      const args = [];

      if (peek(parser).v !== ')') {
        for (;;) {
          args.push(parseOr(parser));
          if (!eat(parser, ',')) break;
        }
      }

      if (!eat(parser, ')')) throw new ExprError('函数调用缺少右括号');

      return { type: 'call', name, args };
    }

    return { type: 'var', name };
  }

  throw new ExprError(`表达式不完整，遇到 "${token.v || '结尾'}"`);
}

// ---------------------------------------------------------------- 求值

function valueOf(node, vars, rng) {
  switch (node.type) {
    case 'num':
    case 'str':
    case 'bool':
      return node.value;

    case 'null':
      return null;

    case 'var':
      if (!(node.name in vars)) throw new ExprError(`变量 ${node.name} 未赋值`);
      return vars[node.name];

    case 'unary': {
      const inner = valueOf(node.value, vars, rng);
      return node.op === '!' ? !truthy(inner) : -toNumber(inner);
    }

    case 'call':
      return callFunction(node, vars, rng);

    case 'binary':
      return binaryOf(node, vars, rng);

    default:
      throw new ExprError(`未知节点 ${node.type}`);
  }
}

function binaryOf(node, vars, rng) {
  if (node.op === '&&') {
    return truthy(valueOf(node.left, vars, rng)) && truthy(valueOf(node.right, vars, rng));
  }

  if (node.op === '||') {
    return truthy(valueOf(node.left, vars, rng)) || truthy(valueOf(node.right, vars, rng));
  }

  // 相等比较允许裸标识符当字面量：`route == A`。
  // 大小比较则不行 —— 那里拿未定义变量去比大小一定是写错了，应当报出来。
  const loose = node.op === '==' || node.op === '!=';
  const left = loose ? operandOf(node.left, vars, rng) : valueOf(node.left, vars, rng);
  const right = loose ? operandOf(node.right, vars, rng) : valueOf(node.right, vars, rng);

  switch (node.op) {
    case '==': return looseEqual(left, right);
    case '!=': return !looseEqual(left, right);
    case '>': return toNumber(left) > toNumber(right);
    case '<': return toNumber(left) < toNumber(right);
    case '>=': return toNumber(left) >= toNumber(right);
    case '<=': return toNumber(left) <= toNumber(right);
    case '+': return typeof left === 'string' || typeof right === 'string'
      ? String(left) + String(right)
      : toNumber(left) + toNumber(right);
    case '-': return toNumber(left) - toNumber(right);
    case '*': return toNumber(left) * toNumber(right);
    case '/': return toNumber(left) / toNumber(right);
    case '%': return toNumber(left) % toNumber(right);
    default: throw new ExprError(`不支持的运算符 ${node.op}`);
  }
}

function operandOf(node, vars, rng) {
  if (node.type === 'var' && !(node.name in vars)) return node.name;
  return valueOf(node, vars, rng);
}

function callFunction(node, vars, rng) {
  const args = node.args.map((arg) => valueOf(arg, vars, rng));

  if (node.name === 'random') {
    const min = Math.trunc(toNumber(args[0] ?? 0));
    const max = Math.trunc(toNumber(args[1] ?? 100));
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return low + Math.floor(rng() * (high - low + 1));
  }

  if (node.name === 'min') return Math.min(...args.map(toNumber));
  if (node.name === 'max') return Math.max(...args.map(toNumber));
  if (node.name === 'abs') return Math.abs(toNumber(args[0]));

  throw new ExprError(`未知函数 ${node.name}()`);
}

function looseEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  if (typeof left === 'number' || typeof right === 'number') {
    const a = Number(left);
    const b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return String(left) === String(right);
}

function toNumber(input) {
  if (typeof input === 'number') return input;
  if (typeof input === 'boolean') return input ? 1 : 0;
  if (input === null || input === undefined) return 0;
  const n = Number(input);
  if (!Number.isFinite(n)) throw new ExprError(`"${input}" 不是数字`);
  return n;
}

function truthy(input) {
  if (typeof input === 'string') return input.length > 0 && input !== 'false';
  return Boolean(input);
}

function walk(node, visit) {
  visit(node);

  if (node.left) walk(node.left, visit);
  if (node.right) walk(node.right, visit);
  if (node.value && typeof node.value === 'object') walk(node.value, visit);
  if (Array.isArray(node.args)) node.args.forEach((arg) => walk(arg, visit));
}
