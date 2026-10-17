/* Формули для власної статистики в «Розборі місяця». Це маленький безпечний обчислювач: ні eval, ні new Function
   (сторінка працює під CSP без 'unsafe-eval'). Розбір у дерево, потім обчислення.

   Що вміє формула:
   - числа (1, 2.5), дужки, + - * / % ^ (степінь), унарний мінус;
   - порівняння < > <= >= == != та && || ! (результат 1 або 0);
   - змінні зі статистики місяця: trades, win_rate, pnl, r, ... (JL.formula.VARS);
   - функції: abs, round(x, n), floor, ceil, sqrt, min(a, b, ...), max(a, b, ...), if(умова, так, ні), ifnull(x, запасне);
   - підсумки по полях журналу: sum([Поле]), avg([Поле]), min([Поле]), max([Поле]), count([Поле]), countif([Поле], "Так"),
     де [Поле] це назва (або ключ) поля журналу в квадратних дужках.
   «Порожнє» значення (null) передається далі: будь-яка арифметика з ним дає null; ділення на нуль теж дає null.
   Результат null показується як «—». */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const ApiError = JL.ApiError || class extends Error { constructor(m, s) { super(m); this.status = s; } };
  const MAX_LEN = 300;

  // [ім'я, пояснення]: змінні, які бере формула зі статистики місяця (ключі збігаються з JL.stats.compute().summary)
  const VARS = [
    ["trades", "Закритих угод"], ["wins", "Прибуткових угод"], ["losses", "Збиткових угод"], ["be", "Беззбиткових угод"],
    ["win_rate", "Winrate, %"], ["pnl", "Результат у валюті"], ["r", "Результат, R"], ["pct", "Результат, %"],
    ["avg_r", "Середній результат, R"], ["avg_pnl", "Середній результат у валюті"], ["avg_pct", "Середній результат, %"],
    ["avg_win", "Середній виграш"], ["avg_loss", "Середній збиток (від'ємний)"], ["payoff", "Співвідношення виграш/збиток"],
    ["profit_factor", "Профіт-фактор"], ["best", "Найкраща угода"], ["worst", "Найгірша угода"],
    ["best_r", "Найкраща, R"], ["worst_r", "Найгірша, R"], ["best_pct", "Найкраща, %"], ["worst_pct", "Найгірша, %"],
    ["max_drawdown", "Макс. просадка у валюті"], ["max_drawdown_r", "Макс. просадка, R"], ["max_drawdown_pct", "Макс. просадка, %"],
    ["win_streak", "Серія виграшів"], ["loss_streak", "Серія збитків"], ["avg_discipline", "Дотримання плану (1-5)"], ["open_trades", "Відкритих записів"],
  ];
  const VAR_NAMES = new Set(VARS.map((v) => v[0]));
  const AGG = new Set(["sum", "avg", "count", "countif"]);          // перший аргумент завжди [Поле]
  const SCALAR = { abs: [1, 1], round: [1, 2], floor: [1, 1], ceil: [1, 1], sqrt: [1, 1], if: [3, 3], ifnull: [2, 2] };   // [мін, макс] аргументів

  const fail = (msg) => { throw new ApiError(msg, 422, "formula"); };

  // ---------------------------------------------------------------- лексер
  function lex(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
        let j = i;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
        if (src[j] === ".") { j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
        out.push({ t: "num", v: Number(src.slice(i, j)), at: i }); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        out.push({ t: "id", v: src.slice(i, j), at: i }); i = j; continue;
      }
      if (c === "[") {
        const j = src.indexOf("]", i);
        if (j < 0) fail("Не закрито квадратну дужку у назві поля.");
        const name = src.slice(i + 1, j).trim();
        if (!name) fail("Порожня назва поля в квадратних дужках.");
        out.push({ t: "ref", v: name, at: i }); i = j + 1; continue;
      }
      if (c === '"' || c === "'") {
        const j = src.indexOf(c, i + 1);
        if (j < 0) fail("Не закрито лапки в тексті.");
        out.push({ t: "str", v: src.slice(i + 1, j), at: i }); i = j + 1; continue;
      }
      const two = src.slice(i, i + 2);
      if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) { out.push({ t: "op", v: two, at: i }); i += 2; continue; }
      if ("+-*/%^(),<>!=".includes(c)) { out.push({ t: "op", v: c === "=" ? "==" : c, at: i }); i++; continue; }
      fail(`Незрозумілий символ «${c}».`);
    }
    return out;
  }

  // ---------------------------------------------------------------- парсер (рекурсивний спуск)
  function parse(tokens) {
    let p = 0;
    const peek = () => tokens[p];
    const isOp = (v) => tokens[p] && tokens[p].t === "op" && tokens[p].v === v;
    const eat = (v) => { if (!isOp(v)) fail(`Очікувалось «${v}».`); p++; };

    function orExpr() { let a = andExpr(); while (isOp("||")) { p++; a = { t: "bin", op: "||", a, b: andExpr() }; } return a; }
    function andExpr() { let a = cmpExpr(); while (isOp("&&")) { p++; a = { t: "bin", op: "&&", a, b: cmpExpr() }; } return a; }
    function cmpExpr() {
      let a = addExpr();
      while (["<", ">", "<=", ">=", "==", "!="].some(isOp)) { const op = tokens[p++].v; a = { t: "bin", op, a, b: addExpr() }; }
      return a;
    }
    function addExpr() {
      let a = mulExpr();
      while (isOp("+") || isOp("-")) { const op = tokens[p++].v; a = { t: "bin", op, a, b: mulExpr() }; }
      return a;
    }
    function mulExpr() {
      let a = unary();
      while (isOp("*") || isOp("/") || isOp("%")) { const op = tokens[p++].v; a = { t: "bin", op, a, b: unary() }; }
      return a;
    }
    function unary() {
      if (isOp("-")) { p++; return { t: "un", op: "-", a: unary() }; }
      if (isOp("+")) { p++; return unary(); }
      if (isOp("!")) { p++; return { t: "un", op: "!", a: unary() }; }
      return power();
    }
    function power() {
      const base = primary();
      if (isOp("^")) { p++; return { t: "bin", op: "^", a: base, b: unary() }; }      // праворуч: 2^3^2 = 2^(3^2); -2^2 = -(2^2)
      return base;
    }
    function primary() {
      const tk = peek();
      if (!tk) fail("Формула обривається: чогось не вистачає в кінці.");
      if (tk.t === "num") { p++; return { t: "num", v: tk.v }; }
      if (tk.t === "str") { p++; return { t: "str", v: tk.v }; }
      if (tk.t === "ref") { p++; return { t: "ref", ref: tk.v }; }
      if (tk.t === "id") {
        p++;
        if (isOp("(")) {
          p++;
          const args = [];
          if (!isOp(")")) { args.push(orExpr()); while (isOp(",")) { p++; args.push(orExpr()); } }
          eat(")");
          return { t: "call", fn: tk.v.toLowerCase(), args, name: tk.v };
        }
        if (!VAR_NAMES.has(tk.v)) fail(`Невідома змінна «${tk.v}». Обери зі списку змінних під полем формули.`);
        return { t: "var", name: tk.v };
      }
      if (isOp("(")) { p++; const e = orExpr(); eat(")"); return e; }
      fail(`Несподіваний символ «${tk.v}».`);
    }
    const ast = orExpr();
    if (p < tokens.length) fail(`Зайве «${tokens[p].v}» у формулі.`);
    return ast;
  }

  // ---------------------------------------------------------------- перевірка дерева
  function check(n, refs, hasField) {
    if (n.t === "num" || n.t === "var") return;
    if (n.t === "str") fail("Текст у лапках можна писати лише другим аргументом countif.");
    if (n.t === "ref") fail(`Поле [${n.ref}] можна використовувати лише всередині sum, avg, min, max, count або countif.`);
    if (n.t === "un") return check(n.a, refs, hasField);
    if (n.t === "bin") { check(n.a, refs, hasField); check(n.b, refs, hasField); return; }
    const fn = n.fn;
    const refArg = (a) => { if (!a || a.t !== "ref") fail(`У ${fn}() перший аргумент має бути полем у квадратних дужках, наприклад ${fn}([Назва поля]).`); refs.add(a.ref); if (hasField && !hasField(a.ref)) fail(`Невідоме поле [${a.ref}].`); };
    if (AGG.has(fn)) {
      const want = fn === "countif" ? 2 : 1;
      if (n.args.length !== want) fail(fn === "countif" ? 'countif потребує два аргументи: countif([Поле], "значення").' : `${fn}() приймає один аргумент: ${fn}([Поле]).`);
      refArg(n.args[0]);
      if (fn === "countif") { const v = n.args[1]; if (v.t !== "str" && v.t !== "num") fail('Другий аргумент countif має бути значенням у лапках, наприклад "Так".'); }
      return;
    }
    if (fn === "min" || fn === "max") {
      if (n.args.length === 1 && n.args[0].t === "ref") { refArg(n.args[0]); return; }
      if (n.args.length < 2) fail(`${fn}() потребує щонайменше два числа або одне поле: ${fn}([Поле]).`);
      n.args.forEach((a) => check(a, refs, hasField));
      return;
    }
    const sig = SCALAR[fn];
    if (!sig) fail(`Невідома функція «${n.name}». Доступні: abs, round, floor, ceil, sqrt, min, max, if, ifnull, sum, avg, count, countif.`);
    if (n.args.length < sig[0] || n.args.length > sig[1]) fail(`${fn}() приймає ${sig[0] === sig[1] ? sig[0] : `від ${sig[0]} до ${sig[1]}`} аргумент(и).`);
    n.args.forEach((a) => check(a, refs, hasField));
  }

  // ---------------------------------------------------------------- обчислення
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const truthy = (x) => x != null && x !== 0;
  function evalNode(n, ctx) {
    switch (n.t) {
      case "num": return n.v;
      case "var": return num(ctx.vars[n.name] == null ? null : Number(ctx.vars[n.name]));
      case "un": {
        const a = evalNode(n.a, ctx);
        if (n.op === "!") return truthy(a) ? 0 : 1;
        return a == null ? null : -a;
      }
      case "bin": {
        if (n.op === "&&") { const a = evalNode(n.a, ctx); return truthy(a) && truthy(evalNode(n.b, ctx)) ? 1 : 0; }
        if (n.op === "||") { const a = evalNode(n.a, ctx); return truthy(a) || truthy(evalNode(n.b, ctx)) ? 1 : 0; }
        const a = evalNode(n.a, ctx), b = evalNode(n.b, ctx);
        if (a == null || b == null) return null;
        switch (n.op) {
          case "+": return num(a + b);
          case "-": return num(a - b);
          case "*": return num(a * b);
          case "/": return b === 0 ? null : num(a / b);
          case "%": return b === 0 ? null : num(a % b);
          case "^": return num(Math.pow(a, b));
          case "<": return a < b ? 1 : 0;
          case ">": return a > b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          case "==": return a === b ? 1 : 0;
          case "!=": return a !== b ? 1 : 0;
        }
        return null;
      }
      case "call": {
        const fn = n.fn;
        if (AGG.has(fn) || ((fn === "min" || fn === "max") && n.args.length === 1)) {
          if (!ctx.field) return null;
          const arg = fn === "countif" ? n.args[1].v : undefined;
          return num(ctx.field(n.args[0].ref, fn, arg));
        }
        if (fn === "if") return truthy(evalNode(n.args[0], ctx)) ? evalNode(n.args[1], ctx) : evalNode(n.args[2], ctx);
        const v = n.args.map((a) => evalNode(a, ctx));
        if (fn === "ifnull") return v[0] == null ? v[1] : v[0];
        if (v.some((x) => x == null)) return null;
        if (fn === "abs") return Math.abs(v[0]);
        if (fn === "floor") return Math.floor(v[0]);
        if (fn === "ceil") return Math.ceil(v[0]);
        if (fn === "sqrt") return v[0] < 0 ? null : Math.sqrt(v[0]);
        if (fn === "round") { const d = Math.max(0, Math.min(8, Math.trunc(v[1] == null ? 0 : v[1]))); const k = 10 ** d; return num(Math.round(v[0] * k) / k); }
        if (fn === "min") return Math.min(...v);
        if (fn === "max") return Math.max(...v);
        return null;
      }
    }
    return null;
  }

  const cache = new Map();
  /** Розбирає й перевіряє формулу. Кидає ApiError з поясненням українською. opts.hasField(ref) -> bool (необов'язково). */
  function compile(src, opts = {}) {
    if (typeof src !== "string" || !src.trim()) fail("Напиши формулу, наприклад: win_rate * avg_r");
    if (src.length > MAX_LEN) fail(`Формула задовга: не більше ${MAX_LEN} символів.`);
    const refs = new Set();
    let ast = cache.get(src);
    if (!ast) { ast = parse(lex(src)); if (cache.size > 200) cache.clear(); cache.set(src, ast); }
    check(ast, refs, opts.hasField);
    return { refs: [...refs], run: (ctx) => evalNode(ast, ctx) };
  }

  JL.formula = { compile, VARS, MAX_LEN };
})(typeof window !== "undefined" ? window : globalThis);
