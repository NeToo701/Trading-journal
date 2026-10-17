/* Перевірки без браузера: движок формул, налаштування «Розбору місяця», підсумки по полях, нові назви помилок. Запуск: node tests/review_cfg.test.js */
"use strict";
const path = require("path");
const root = path.join(__dirname, "..");
for (const f of ["jl-util", "jl-schema", "jl-stats", "jl-formula", "jl-review"]) require(path.join(root, "lib", f + ".js"));
const JL = globalThis.JL;
let total = 0, failed = 0;
const ok = (cond, msg) => { total++; if (!cond) { failed++; console.log("✗", msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: очікувано ${JSON.stringify(b)}, отримано ${JSON.stringify(a)}`);
const throws = (fn, re, msg) => { total++; try { fn(); failed++; console.log("✗", msg, "(помилки не було)"); } catch (e) { if (!(e instanceof JL.ApiError) || (re && !re.test(e.message))) { failed++; console.log("✗", msg, "->", e.message); } } };

// ---------------------------------------------------------------- формули
const F = JL.formula;
const vars = { trades: 10, wins: 4, losses: 6, win_rate: 40, avg_r: 0.5, pnl: -20, avg_win: 30, avg_loss: -15, profit_factor: null };
const rows = [{ risk: 1, ok: "Так", tags: ["a", "b"], on: true, fees: 0.5 }, { risk: 2, ok: "Ні" }, { risk: "3", ok: "так", tags: ["b"] }, { ok: "Так", fees: 1.5 }];
const fields = [{ key: "risk", label: "Ризик, %", type: "percent" }, { key: "ok", label: "За правилами?", type: "select" }, { key: "tags", label: "Теги", type: "multiselect" },
  { key: "on", label: "Галочка", type: "checkbox" }, { key: "fees", label: "Комісії", type: "number" }, { key: "media", label: "Файли", type: "media" }];
const agg = JL.reviewCfg.makeFieldAgg(fields, rows);
const run = (src) => F.compile(src).run({ vars, field: agg });
const cases = [
  ["1 + 2 * 3", 7], ["(1 + 2) * 3", 9], ["10 / 4", 2.5], ["7 % 4", 3], ["2 ^ 3 ^ 2", 512], ["-2 ^ 2", -4], ["2 ^ -1", 0.5], ["--3", 3], [".5 + 1", 1.5],
  ["win_rate / 100 * avg_win + (1 - win_rate / 100) * avg_loss", 3], ["trades / 0", null], ["1 / 0 + 5", null], ["profit_factor + 1", null], ["ifnull(profit_factor, 0) + 1", 1],
  ["if(pnl < 0, 1, 2)", 1], ["if(pnl > 0, 1, 2)", 2], ["if(profit_factor, 1, 2)", 2], ["wins >= 4 && losses < 7", 1], ["wins > 4 || losses > 7", 0], ["!0", 1], ["!(1 == 1)", 0],
  ["abs(pnl)", 20], ["round(10 / 3, 2)", 3.33], ["round(2.5)", 3], ["floor(2.9) + ceil(2.1)", 5], ["sqrt(16)", 4], ["sqrt(0 - 4)", null], ["min(3, 1, 2)", 1], ["max(3, 1, 2)", 3],
  ["sum([Ризик, %])", 6], ["avg([Ризик, %])", 2], ["min([Ризик, %])", 1], ["max([Ризик, %])", 3], ["count([Ризик, %])", 3], ["count([За правилами?])", 4],
  ['countif([За правилами?], "Так")', 3], ['countif([За правилами?], "так")', 3], ['countif([Теги], "b")', 2], ['countif([Галочка], "Так")', 1],
  ['countif([За правилами?], "Так") / trades * 100', 30], ["sum([Комісії])", 2], ["sum([risk])", 6], ["sum([РИЗИК, %])", 6],
  ["1 = 1", 1], ["trades == 10", 1], ["trades != 10", 0], ["  trades\n+ 1 ", 11],
];
for (const [src, want] of cases) { let got; try { got = run(src); } catch (e) { got = "ПОМИЛКА: " + e.message; } eq(got, want, `формула ${src}`); }

throws(() => F.compile(""), /формулу/, "порожня формула");
throws(() => F.compile("1 +"), /обривається/, "обірвана формула");
throws(() => F.compile("foo + 1"), /Невідома змінна/, "невідома змінна");
throws(() => F.compile("1 + $"), /Незрозумілий символ/, "дивний символ");
throws(() => F.compile("(1 + 2"), /Очікувалось/, "незакриті дужки");
throws(() => F.compile("1 2"), /Зайве/, "зайве число");
throws(() => F.compile("nope(1)"), /Невідома функція/, "невідома функція");
throws(() => F.compile("abs(1, 2)"), /аргумент/, "кількість аргументів");
throws(() => F.compile("sum(1)"), /полем/, "sum без поля");
throws(() => F.compile("sum([Ризик, %], 2)"), /один аргумент/, "sum з двома аргументами");
throws(() => F.compile("[Ризик, %] + 1"), /лише всередині/, "поле поза агрегатом");
throws(() => F.compile('countif([Ризик, %])'), /два аргументи/, "countif з одним аргументом");
throws(() => F.compile('"x" + 1'), /лише другим аргументом/, "текст у виразі");
throws(() => F.compile("min(5)"), /щонайменше/, "min з одним числом");
throws(() => F.compile("x".repeat(F.MAX_LEN + 1)), /задовга/, "задовга формула");
throws(() => F.compile("sum([Немає])", { hasField: () => false }), /Невідоме поле/, "невідоме поле при перевірці");
throws(() => run("sum([Немає такого])"), /Невідоме поле/, "невідоме поле при обчисленні");
ok(F.compile('sum([A]) + countif([B], "x") + max([C])').refs.join("|") === "A|B|C", "посилання на поля збираються");
// ні eval, ні Function
const src = require("fs").readFileSync(path.join(root, "lib", "jl-formula.js"), "utf8");
ok(!/\beval\s*\(|new Function|Function\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "у формулах немає eval / new Function (CSP)");
// захист від важких виразів
ok(run("1" + " + 1".repeat(70)) === 71, "довгий ланцюг додавання");

// ---------------------------------------------------------------- налаштування розбору
const R = JL.reviewCfg;
const jf = JL.appDefaultFields("crypto");
const d0 = R.defaults(jf);
eq(d0.blocks.map((b) => b.id), ["summary", "mistakes", "positions", "conclusion"], "блоки за замовчуванням");
eq(d0.metrics.filter((m) => m.visible).map((m) => m.id), ["win_rate", "pct", "pnl", "r", "trades", "losses"], "видимі статистики за замовчуванням");
eq(d0.pos_fields.map((p) => p.key), ["by_rules", "tp_after_stop", "re_enter", "re_enter_why", "mistakes", "conclusion"], "питання по угоді за замовчуванням");
eq(d0.month_fields.map((f) => f.key), ["summary", "went_well", "fix", "plan"], "поля висновку за замовчуванням");
eq(R.normalize(undefined, jf), d0, "без збереженого = за замовчуванням");
eq(R.normalize(null, jf), d0, "null = за замовчуванням");
eq(R.normalize({ blocks: [{ id: "positions", visible: false }] }, jf).blocks, [{ id: "positions", visible: false }, { id: "summary", visible: true }, { id: "mistakes", visible: true }, { id: "conclusion", visible: true }], "відсутні блоки дописуються в кінець");
eq(R.normalize({ pos_fields: [{ key: "by_rules" }, { key: "зникло" }, { key: "media" }, { key: "by_rules" }] }, jf).pos_fields, [{ key: "by_rules", visible: true }], "невідомі й файлові поля та дублі відкидаються");
eq(R.normalize({ metrics: [{ id: "x_zzzz", custom: true, formula: "1" }, { id: "trades", visible: false, label: "N" }] }, jf).metrics.find((m) => m.id === "trades"), { id: "trades", visible: false, label: "N" }, "перейменування готової статистики");
ok(!R.normalize({ metrics: [{ id: "x_zzzz", custom: true, formula: "1" }] }, jf).metrics.some((m) => m.id === "x_zzzz"), "власна статистика з кривим id відкидається");

const base = () => JSON.parse(JSON.stringify(d0));
const custom = { custom: true, visible: true, label: "Очікування", formula: "win_rate / 100 * avg_win", fmt: "number", dec: 2 };
let c = base(); c.metrics.push({ ...custom });
let r = R.clean(c, jf);
const mc = r.metrics.find((m) => m.custom);
ok(mc && /^x_[0-9a-f]{8}$/.test(mc.id) && mc.formula === "win_rate / 100 * avg_win", "нова власна статистика отримує id");
const again = R.clean(r, jf);
eq(again.metrics.find((m) => m.custom).id, mc.id, "id власної статистики зберігається");
c = base(); c.metrics.push({ ...custom, formula: "foo" }); throws(() => R.clean(c, jf), /Очікування.*Невідома змінна/, "крива формула");
c = base(); c.metrics.push({ ...custom, formula: "sum([Немає такого])" }); throws(() => R.clean(c, jf), /Невідоме поле/, "формула з невідомим полем");
c = base(); c.metrics.push({ ...custom, formula: 'countif([Чи була угода за правилами?], "Так")' }); ok(!!R.clean(c, jf), "формула з полем за назвою");
c = base(); c.metrics.push({ ...custom, label: "" }); throws(() => R.clean(c, jf), /Назва/, "порожня назва");
c = base(); c.metrics.push({ ...custom, fmt: "x" }); throws(() => R.clean(c, jf), /формат/, "невідомий формат");
c = base(); c.metrics.push({ ...custom, dec: 9 }); throws(() => R.clean(c, jf), /від 0 до 4/, "забагато знаків");
c = base(); for (let i = 0; i < 21; i++) c.metrics.push({ ...custom, label: "M" + i }); throws(() => R.clean(c, jf), /не більше/, "ліміт власних статистик");
c = base(); c.metrics.push({ id: "nope", visible: true }); throws(() => R.clean(c, jf), /Невідома статистика/, "невідома готова статистика");
c = base(); c.blocks = [{ id: "zzz" }]; throws(() => R.clean(c, jf), /блоків/, "невідомий блок");
c = base(); c.month_fields.push({ label: "Оцінка", type: "rating", visible: true, wide: false }); r = R.clean(c, jf);
const mf = r.month_fields.find((f) => f.type === "rating");
ok(mf && /^m_[0-9a-f]{8}$/.test(mf.key) && mf.visible && !mf.wide, "нове поле висновку отримує ключ");
c = base(); c.month_fields.push({ label: "Тип", type: "media", visible: true }); throws(() => R.clean(c, jf), /тип/, "файли в полі висновку заборонені");
c = base(); c.month_fields.push({ label: "Список", type: "select", options: [], visible: true }); throws(() => R.clean(c, jf), /варіант/, "список без варіантів");
c = base(); c.month_fields.push({ label: "Список", type: "select", options: ["A", "a", " B "], visible: true }); eq(R.clean(c, jf).month_fields.find((f) => f.type === "select").options, ["A", "B"], "варіанти без дублів");
c = base(); c.month_fields.find((f) => f.key === "plan").label = "Мій план"; eq(R.clean(c, jf).month_fields.find((f) => f.key === "plan").label, "Мій план", "перейменування вбудованого поля");
c = base(); c.pos_fields.push({ key: "notes", visible: true }); ok(R.clean(c, jf).pos_fields.some((p) => p.key === "notes"), "додати наявне поле в питання");
c = base(); c.pos_fields.push({ key: "media", visible: true }); throws(() => R.clean(c, jf), /Файли/, "поле файлів не додається");
c = base(); c.pos_fields.push({ key: "немає", visible: true }); throws(() => R.clean(c, jf), /немає в журналі/, "поле, якого немає");
c = base(); c.pos_fields.push({ key: "by_rules", visible: true }); throws(() => R.clean(c, jf), /повторюється/, "дубль питання");
throws(() => R.clean("x", jf), /об'єктом/, "не об'єкт");

// значення висновку місяця
const cfgM = R.clean((() => { const x = base(); x.month_fields.push({ label: "Оцінка", type: "rating", visible: true }, { label: "Бал", type: "number", visible: true }, { label: "Теги", type: "multiselect", options: ["a", "b"], visible: true }); return x; })(), jf);
const kr = cfgM.month_fields.find((f) => f.type === "rating").key, kn = cfgM.month_fields.find((f) => f.type === "number").key, kt = cfgM.month_fields.find((f) => f.type === "multiselect").key;
eq(R.cleanMonthData(cfgM, { summary: " ok ", [kr]: 4, [kn]: "1,5", [kt]: ["a"], чужий: "x" }), { summary: "ok", went_well: "", fix: "", plan: "", [kr]: 4, [kn]: 1.5, [kt]: ["a"] }, "значення місяця очищаються");
throws(() => R.cleanMonthData(cfgM, { [kr]: 9 }), /оцінка/i, "оцінка поза межами");
throws(() => R.cleanMonthData(cfgM, { [kn]: "abc" }), /числом/, "не число");
throws(() => R.cleanMonthData(cfgM, { summary: "я".repeat(5001) }), /задовге/, "задовгий текст");
eq(R.cleanMonthData(cfgM, { [kr]: null, [kn]: "" }), { summary: "", went_well: "", fix: "", plan: "" }, "порожні значення пропускаються");

// обчислення статистики
const summary = { trades: 10, wins: 4, losses: 6, win_rate: 40, pnl: -20, avg_win: 30, avg_loss: -15, r: 3 };
eq(R.evalMetric({ id: "win_rate" }, summary), { value: 40 }, "готова статистика");
eq(R.evalMetric({ id: "profit_factor" }, summary), { value: null }, "готова статистика без значення");
eq(R.evalMetric({ custom: true, formula: "pnl / trades" }, summary, agg), { value: -2 }, "власна статистика");
ok(/Невідома змінна/.test(R.evalMetric({ custom: true, formula: "foo" }, summary, agg).error), "помилка у власній статистиці не ламає сторінку");
ok(/Невідоме поле/.test(R.evalMetric({ custom: true, formula: "sum([Немає])" }, summary, agg, fields).error), "помилка невідомого поля");
eq(R.metricLabel({ id: "pnl" }, "USDT"), "Результат, USDT", "назва з валютою");
eq(R.metricLabel({ id: "pnl", label: "PnL" }, "USDT"), "PnL", "своя назва");
eq(R.metricFmt({ id: "win_rate" }), { fmt: "percent", dec: 1, sign: false }, "формат готової");
eq(R.metricFmt({ custom: true, fmt: "money", dec: 3 }), { fmt: "money", dec: 3, sign: true }, "формат власної");

// ---------------------------------------------------------------- схема й назви помилок
for (const [old, nw] of Object.entries(JL.MISTAKE_RENAMES)) ok([...nw].length <= JL.LIMITS.MAX_OPTION_LEN && nw !== old, `нова назва помилки «${nw}» коротша за ліміт`);
eq(Object.keys(JL.MISTAKE_RENAMES).length, JL.PRO_MISTAKES.length, "кожну стару помилку перейменовано");
eq(new Set(JL.PRO_MISTAKES).size, JL.PRO_MISTAKES.length, "нові назви помилок унікальні");
for (const m of ["crypto", "forex"]) {
  const a = JL.appDefaultFields(m), b = JL.defaultFields(m);
  eq(a.map((f) => f.key), b.map((f) => f.key), `${m}: ті самі поля`);
  eq(a.filter((f) => f.hidden).map((f) => f.key), JL.REVIEW_ONLY_KEYS, `${m}: сховані лише чотири питання розбору`);
  eq(a.find((f) => f.key === "mistakes").options, JL.PRO_MISTAKES, `${m}: нові варіанти помилок`);
  eq(JL.cleanFields(a, b).map((f) => f.key), a.map((f) => f.key), `${m}: схема з новими полями проходить перевірку`);
  ok(JL.cleanEntry(a, { opened_at: "2026-01-01T10:00", mistakes: [JL.PRO_MISTAKES[0]], by_rules: "Так" }).by_rules === "Так", `${m}: сховані поля все одно зберігаються в записі`);
}

console.log(failed ? `\nПровалів: ${failed} із ${total}` : `OK: ${total} перевірок`);
process.exit(failed ? 1 : 0);
