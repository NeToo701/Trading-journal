/* Перевірки без браузера: 18 калькуляторів із lib/jl-calc-tools.js (математика, перевірка полів, показ). Запуск: node tests/calc-tools.test.js */
"use strict";
const path = require("path");
const root = path.join(__dirname, "..");
for (const f of ["jl-util", "jl-schema", "jl-calc", "jl-calc-tools"]) require(path.join(root, "lib", f + ".js"));
const JL = globalThis.JL, C = JL.calc, T = JL.calcTools;
let total = 0, failed = 0;
const ok = (cond, msg) => { total++; if (!cond) { failed++; console.log("✗", msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: очікувано ${JSON.stringify(b)}, отримано ${JSON.stringify(a)}`);
const near = (a, b, msg, eps = 1e-6) => ok(typeof a === "number" && Math.abs(a - b) < eps, `${msg}: очікувано ${b}, отримано ${a}`);
const [EUR, , XAU] = C.DEFAULT_ASSETS;

/** Форматувальники-заглушки: перевіряємо логіку показу, а не вигляд чисел. */
const F = { n: (x, d = 2) => String(Number(Number(x).toFixed(d))), n2: (x) => Number(x).toFixed(2), pct: (x, d = 2) => `${Number(x).toFixed(d)}%`,
  sgn: (x, d = 2) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d), px: (x) => String(Number(Number(x).toFixed(6))), cur: (x, c) => `${Number(x).toFixed(2)} ${c || ""}`.trim() };
const run = (id, v, ctx = {}) => T.byId(id).compute(v, { asset: null, acc: "USD", needRate: false, ...ctx });
const good = (id, v, ctx) => { const r = run(id, v, ctx); ok(r.ok === true, `${id}: ${JSON.stringify(v)} має рахуватись, отримано ${JSON.stringify(r)}`); return r; };
const bad = (id, v, key, re, ctx) => {
  const r = run(id, v, ctx);
  ok(r.ok === false && r.errors && r.errors[key] && (!re || re.test(r.errors[key])), `${id}: ${JSON.stringify(v)} має дати помилку в «${key}», отримано ${JSON.stringify(r)}`);
};
const miss = (id, v, keys, ctx) => { const r = run(id, v, ctx); ok(r.ok === false && JSON.stringify([...r.missing].sort()) === JSON.stringify([...keys].sort()), `${id}: бракує ${JSON.stringify(keys)}, отримано ${JSON.stringify(r)}`); };

// ---------------------------------------------------------------- реєстр
eq(T.TOOLS.map((t) => t.id), ["rr", "partial", "avg", "pipv", "futures", "liq", "pnl", "fees", "funding", "breakeven", "spot", "grid", "dca", "convert", "recovery", "daylimit", "expectancy", "montecarlo"], "список калькуляторів");
eq(T.GROUPS.map((g) => g[0]), ["risk", "fut", "stat"], "групи");
ok(new Set(T.TOOLS.map((t) => t.id)).size === T.TOOLS.length, "id унікальні");
for (const t of T.TOOLS) {
  ok(T.GROUPS.some((g) => g[0] === t.group), `${t.id}: група існує`);
  ok(t.title && t.hint && t.intro, `${t.id}: є назва, підказка й вступ`);
  ok(new Set(t.fields.map((f) => f.key)).size === t.fields.length, `${t.id}: ключі полів унікальні`);
  ok(t.fields.every((f) => ["num", "text", "ccy", "seg", "asset", "hidden"].includes(f.kind)), `${t.id}: типи полів відомі`);
  ok(t.fields.filter((f) => f.kind === "seg").every((f) => f.options.some(([o]) => o === f.def)), `${t.id}: значення seg за замовчуванням є серед варіантів`);
  ok(t.fields.every((f) => !/[/]/.test(f.key)), `${t.id}: ключі без «/»`);
  ok(t.fields.filter((f) => f.pref).every((f) => ["deposit", "leverage", "acc_ccy", "rate"].includes(f.pref)), `${t.id}: pref відомий`);
  // порожня форма: нічого не падає, відсутні поля названо, а всі вони справді існують
  const defaults = Object.fromEntries(t.fields.filter((f) => f.def != null).map((f) => [f.key, f.def]));
  const r = t.compute(defaults, { asset: null, acc: "USD", needRate: false });
  ok(r.ok === false && Array.isArray(r.missing), `${t.id}: порожня форма не рахується`);
  ok(r.missing.every((k) => t.fields.some((f) => f.key === k)), `${t.id}: відсутні поля існують у формі`);
}
eq(T.byId("nope"), null, "byId: невідомий");
eq(T.TOOLS.filter((t) => t.fromBacktest).map((t) => t.id), ["expectancy", "montecarlo"], "підстановка з бектесту лише там, де потрібна");

// ---------------------------------------------------------------- допоміжні формули
near(T.liqPrice(true, 100, 10, 0.005), 90.4522613, "liqPrice лонг", 1e-6);
near(T.liqPrice(false, 100, 10, 0.005), 109.4527363, "liqPrice шорт", 1e-6);
eq(T.liqPrice(true, 100, 1, 0.005), 0, "liqPrice: лонг без плеча не ліквідується");
near(T.liqPrice(false, 100, 1, 0.005), 199.0049751, "liqPrice: шорт при 1x", 1e-6);
near(T.liqPrice(true, 100, 10, 0.005, 0.05), 85.4271357, "liqPrice: додана маржа віддаляє ліквідацію", 1e-6);
near(T.maxLevForStop(true, 100, 90, 0.005), 1 / 0.1045, "maxLevForStop лонг");
near(T.maxLevForStop(false, 100, 110, 0.005), 1 / (110 * 1.005 / 100 - 1), "maxLevForStop шорт");
eq(T.maxLevForStop(true, 100, 120, 0.005), null, "maxLevForStop: стоп не з того боку");
eq(T.gridLevels(100, 200, 4, "arith"), [100, 125, 150, 175, 200], "рівні арифметичної сітки");
const gl = T.gridLevels(100, 400, 2, "geom"); near(gl[1], 200, "рівні геометричної сітки"); near(gl[2], 400, "кінець геометричної сітки");
{ const a = T.rng(7), b = T.rng(7), c = T.rng(8); const x = [a(), a(), a()], y = [b(), b(), b()];
  eq(x, y, "rng: однаковий seed дає однакову послідовність"); ok(JSON.stringify(x) !== JSON.stringify([c(), c(), c()]), "rng: інший seed дає іншу послідовність");
  ok(x.every((q) => q >= 0 && q < 1), "rng у проміжку [0, 1)"); }

// ---------------------------------------------------------------- R:R
{ let r = good("rr", { dir: "long", entry: "100", stop: "98", tp1: "106" });
  near(r.sd, 2, "rr: стоп"); near(r.rows[0].r, 3, "rr: 1:3"); near(r.rows[0].be, 25, "rr: беззбитковий winrate 25%"); near(r.sd_pct, 2, "rr: стоп у %"); eq(r.rows[0].money, null, "rr: без ризику немає грошей");
  r = good("rr", { dir: "short", entry: "100", stop: "102", tp1: "94", tp2: "90", tp3: "80", risk_money: "50" });
  eq(r.rows.map((q) => q.r), [3, 5, 10], "rr шорт: три тейки"); eq(r.rows.map((q) => q.money), [150, 250, 500], "rr: гроші за тейками");
  r = good("rr", { entry: "1,0850", stop: "1,0830", tp1: "1,0910" }); near(r.rows[0].r, 3, "rr: коми в числах"); near(r.sd, 0.002, "rr: float без шуму");
  eq(good("rr", { entry: "100", stop: "98", tp1: "106", tp3: "120" }).rows.length, 2, "rr: тейк 3 без тейку 2 теж береться");
  miss("rr", {}, ["entry", "stop", "tp1"]); miss("rr", { entry: "100" }, ["stop", "tp1"]);
  bad("rr", { dir: "long", entry: "100", stop: "101", tp1: "106" }, "stop", /нижче входу/); bad("rr", { dir: "short", entry: "100", stop: "99", tp1: "94" }, "stop", /вище входу/);
  bad("rr", { dir: "long", entry: "100", stop: "98", tp1: "99" }, "tp1", /вище входу/); bad("rr", { dir: "short", entry: "100", stop: "102", tp1: "101" }, "tp1", /нижче входу/);
  bad("rr", { entry: "100", stop: "98", tp1: "106", tp2: "95" }, "tp2"); bad("rr", { entry: "abc", stop: "98", tp1: "106" }, "entry", /число/);
  bad("rr", { entry: "100", stop: "0", tp1: "106" }, "stop", /більше нуля/); bad("rr", { entry: "100", stop: "98", tp1: "106", risk_money: "-5" }, "risk_money"); }

// ---------------------------------------------------------------- частковий вихід
{ const base = { dir: "long", entry: "100", stop: "98", tp1: "104", share1: "50" };
  let r = good("partial", { ...base, move: "be" });
  eq(r.scenarios.map((s) => [s.id, s.r]), [["stop", -1], ["tp1stop", 1]], "partial: беззбиток");
  near(r.r1, 2, "partial: тейк 1 це 2R");
  eq(good("partial", { ...base, move: "none" }).scenarios[1].r, 0.5, "partial: без зсуву стопу");
  r = good("partial", { ...base, move: "price", stop2: "101" }); near(r.scenarios[1].r, 1.25, "partial: стоп на ціну 101 (0,5R)");
  r = good("partial", { ...base, move: "be", tp2: "108", risk_money: "100" }); eq(r.scenarios.map((s) => s.id), ["stop", "tp1stop", "tp12"], "partial: сценарій з тейком 2");
  near(r.scenarios[2].r, 3, "partial: тейк 1 і тейк 2"); near(r.scenarios[2].money, 300, "partial: гроші"); near(r.r2, 4, "partial: тейк 2 це 4R");
  r = good("partial", { dir: "short", entry: "100", stop: "102", tp1: "96", share1: "25", move: "be", tp2: "92" }); near(r.scenarios[2].r, 0.25 * 2 + 0.75 * 4, "partial шорт");
  eq(good("partial", { ...base, move: "weird" }).rm, 0, "partial: невідомий режим стопу це беззбиток");
  miss("partial", {}, ["entry", "stop", "tp1", "share1"]); miss("partial", { ...base, move: "price" }, ["stop2"]);
  bad("partial", { ...base, share1: "100" }, "share1"); bad("partial", { ...base, share1: "0" }, "share1");
  bad("partial", { ...base, tp2: "103" }, "tp2", /далі/); bad("partial", { ...base, move: "price", stop2: "105" }, "stop2", /боку входу/);
  bad("partial", { ...base, stop: "101" }, "stop"); bad("partial", { ...base, tp1: "99" }, "tp1"); }

// ---------------------------------------------------------------- усереднення
{ let r = good("avg", { dir: "long", p1: "100", q1: "1", p2: "80", q2: "1" });
  near(r.avg, 90, "avg: середня"); near(r.qty, 2, "avg: кількість"); near(r.cost, 180, "avg: вкладено"); eq(r.n, 2, "avg: входів"); near(r.mean, 90, "avg: проста середня");
  r = good("avg", { p1: "100", q1: "1", p2: "50", q2: "3" }); near(r.avg, 62.5, "avg: зважена середня"); near(r.mean, 75, "avg: проста середня відрізняється");
  r = good("avg", { dir: "long", p1: "100", q1: "1", p2: "80", q2: "1", cur: "95", tgt: "10" });
  near(r.pnl, 10, "avg: результат лонга"); near(r.pnl_pct, 100 * (95 / 90 - 1), "avg: % лонга"); near(r.target_price, 99, "avg: ціна цілі");
  r = good("avg", { dir: "short", p1: "100", q1: "1", p2: "120", q2: "1", cur: "100", tgt: "5" }); near(r.avg, 110, "avg шорт: середня"); near(r.pnl, 20, "avg шорт: результат"); near(r.target_price, 104.5, "avg шорт: ціна цілі нижче");
  r = good("avg", { p1: "100", q1: "1", p2: "80", q2: "1", add_price: "70", want: "80" });
  near(r.add_qty, 2, "avg: скільки докупити"); near(r.add_cost, 140, "avg: вартість докупівлі"); near(r.new_qty, 4, "avg: нова кількість");
  near((r.cost + r.add_cost) / r.new_qty, 80, "avg: нова середня справді 80");
  r = good("avg", { p1: "100", q1: "2", p2: "110", q2: "1", p3: "90", q3: "3", p4: "95", q4: "1", p5: "105", q5: "2" }); eq(r.n, 5, "avg: п'ять входів");
  miss("avg", {}, ["p1", "q1"]); miss("avg", { p1: "100", q1: "1", p2: "90" }, ["q2"]); miss("avg", { p1: "100", q1: "1", q2: "1" }, ["p2"]);
  miss("avg", { p1: "100", q1: "1", add_price: "90" }, ["want"]); miss("avg", { p1: "100", q1: "1", want: "95" }, ["add_price"]);
  bad("avg", { p1: "100", q1: "1", add_price: "90", want: "105" }, "want", /між/); bad("avg", { p1: "100", q1: "1", add_price: "90", want: "90" }, "want", /між/); bad("avg", { p1: "100", q1: "1", add_price: "90", want: "100" }, "want", /між/);
  bad("avg", { p1: "-1", q1: "1" }, "p1"); bad("avg", { p1: "100", q1: "0" }, "q1"); }

// ---------------------------------------------------------------- вартість пункту
{ let r = good("pipv", { lots: "0,5" }, { asset: EUR });
  near(r.pip_value, 10, "pipv: EURUSD 10 за лот"); near(r.pos_value, 5, "pipv: 0,5 лота"); near(r.units, 50000, "pipv: обсяг"); near(r.unit_value, 50000, "pipv: зміна на 1,0");
  r = good("pipv", { lots: "0,5", pips: "20", money: "50" }, { asset: EUR }); near(r.money_for_pips, 100, "pipv: 20 пунктів = 100"); near(r.pips_for_money, 10, "pipv: 50 = 10 пунктів");
  r = good("pipv", { lots: "1" }, { asset: XAU }); near(r.pip_value, 10, "pipv: золото 0,1 × 100"); near(r.units, 100, "pipv: золото 100 унцій");
  const jpy = C.cleanAsset({ symbol: "USDJPY", contract_size: 100000, pip_size: 0.01, quote_ccy: "JPY", digits: 3, min_lot: 0.01, lot_step: 0.01, max_lot: 50 });
  r = good("pipv", { lots: "1", rate: "0,0066" }, { asset: jpy, needRate: true }); near(r.pip_value, 6.6, "pipv: єна з курсом", 1e-9);
  miss("pipv", { lots: "1" }, ["rate"], { asset: jpy, needRate: true }); miss("pipv", {}, ["lots"], { asset: EUR }); miss("pipv", { lots: "1" }, ["asset"]);
  bad("pipv", { lots: "0" }, "lots", null, { asset: EUR }); bad("pipv", { lots: "1", rate: "-1" }, "rate", null, { asset: jpy, needRate: true }); }

// ---------------------------------------------------------------- ф'ючерсна позиція
{ let r = good("futures", { dir: "long", entry: "60000", lev: "10", size_mode: "margin", size: "100", fee: "0,05", mmr: "0,5" });
  near(r.margin, 100, "futures: маржа"); near(r.notional, 1000, "futures: номінал"); near(r.qty, 1000 / 60000, "futures: кількість"); near(r.liq, 54271.356784, "futures: ліквідація лонга", 1e-4);
  near(r.fee_round, 1, "futures: комісія вхід + вихід"); near(r.fee_open, 0.5, "futures: комісія входу"); near(r.liq_dist_pct, 9.5477, "futures: відстань до ліквідації", 1e-3); eq(r.loss, undefined, "futures: без стопу немає збитку");
  r = good("futures", { entry: "100", lev: "5", size_mode: "notional", size: "1000", fee: "0" }); near(r.margin, 200, "futures: номінал → маржа"); near(r.qty, 10, "futures: номінал → кількість");
  r = good("futures", { entry: "100", lev: "5", size_mode: "qty", size: "3", fee: "0" }); near(r.notional, 300, "futures: кількість → номінал"); near(r.margin, 60, "futures: кількість → маржа");
  r = good("futures", { dir: "long", entry: "100", lev: "10", size_mode: "risk", risk_mode: "money", risk: "10", stop: "90", fee: "0", mmr: "0,5" });
  near(r.qty, 1, "futures: під ризик 10 при стопі 10"); near(r.margin, 10, "futures: маржа під ризик"); near(r.loss, 10, "futures: збиток на стопі = ризик");
  ok(r.warnings.some((w) => /ліквідац/.test(w)), "futures: стоп за ліквідацією дає попередження"); near(r.max_lev, 1 / 0.1045, "futures: максимальне плече");
  r = good("futures", { dir: "long", entry: "100", lev: "5", size_mode: "risk", risk_mode: "money", risk: "10", stop: "90", fee: "0,1" });
  near(r.loss, 10, "futures: ризик з комісіями теж рівно 10", 1e-9); ok(r.qty < 1, "futures: комісії зменшують розмір");
  r = good("futures", { dir: "long", entry: "100", lev: "5", size_mode: "risk", risk_mode: "pct", risk: "2", deposit: "1000", stop: "95", fee: "0", tp: "110" });
  near(r.qty, 20 / 5, "futures: 2% від 1000 при стопі 5"); near(r.loss_pct, 2, "futures: збиток 2% депозиту"); near(r.profit, 40, "futures: прибуток на тейку"); near(r.rr, 2, "futures: R:R"); near(r.margin_pct, (4 * 100 / 5 / 1000) * 100, "futures: маржа у % депозиту");
  r = good("futures", { dir: "short", entry: "100", lev: "10", size_mode: "margin", size: "10", fee: "0", mmr: "0,5", stop: "105", tp: "90" });
  near(r.liq, 109.4527363, "futures шорт: ліквідація", 1e-6); near(r.profit, 10, "futures шорт: прибуток"); near(r.loss, 5, "futures шорт: збиток");
  r = good("futures", { entry: "100", lev: "2", size_mode: "margin", size: "600", deposit: "500" }); ok(r.warnings.some((w) => /маржі/.test(w)), "futures: не вистачає маржі");
  miss("futures", {}, ["entry", "lev", "size"]); miss("futures", { entry: "100", lev: "10", size_mode: "risk" }, ["risk", "deposit", "stop"]);
  miss("futures", { entry: "100", lev: "10", size_mode: "risk", risk_mode: "money", risk: "10" }, ["stop"]);
  bad("futures", { entry: "100", lev: "0,5", size: "10" }, "lev"); bad("futures", { entry: "100", lev: "1001", size: "10" }, "lev"); bad("futures", { entry: "100", lev: "10", size: "10", fee: "6" }, "fee");
  bad("futures", { dir: "long", entry: "100", lev: "10", size: "10", stop: "101" }, "stop", /нижче входу/); bad("futures", { dir: "short", entry: "100", lev: "10", size: "10", tp: "101" }, "tp", /нижче входу/);
  bad("futures", { entry: "100", lev: "10", size_mode: "risk", risk: "150", deposit: "100", stop: "90" }, "risk"); }

// ---------------------------------------------------------------- ціна ліквідації
{ let r = good("liq", { dir: "long", entry: "100", lev: "10", mmr: "0,5" });
  near(r.liq, 90.4522613, "liq: лонг"); near(r.dist_pct, 9.5477387, "liq: відстань"); eq(r.no_liq, false, "liq: лонг 10x ліквідується"); eq(r.table.map((q) => q.lev), [2, 3, 5, 10, 20, 50, 100], "liq: таблиця плечей");
  near(r.table[3].price, 90.4522613, "liq: рядок 10x збігається з результатом"); ok(r.table[6].dist < r.table[0].dist, "liq: що більше плече, то ближча ліквідація"); eq(r.max_lev, null, "liq: без стопу немає макс. плеча");
  r = good("liq", { dir: "short", entry: "100", lev: "10", mmr: "0,5" }); near(r.liq, 109.4527363, "liq: шорт");
  r = good("liq", { dir: "long", entry: "100", lev: "1" }); eq([r.no_liq, r.liq], [true, 0], "liq: при 1x лонг не ліквідується"); eq(good("liq", { dir: "short", entry: "100", lev: "1" }).no_liq, false, "liq: шорт при 1x має ціну");
  r = good("liq", { dir: "long", entry: "100", lev: "10", stop: "95" }); eq(r.warn_stop, false, "liq: стоп до ліквідації це добре"); near(r.max_lev, 1 / (1 - 95 * 0.995 / 100), "liq: макс. плече для стопу 95");
  r = good("liq", { dir: "long", entry: "100", lev: "10", stop: "90" }); eq(r.warn_stop, true, "liq: стоп за ліквідацією");
  r = good("liq", { dir: "long", entry: "100", lev: "10", notional: "1000", extra: "50" }); near(r.liq, T.liqPrice(true, 100, 10, 0.005, 0.05), "liq: з доданою маржею"); ok(r.liq < 90.45, "liq: додана маржа відсуває ліквідацію");
  r = good("liq", { entry: "100", lev: "10" }); near(r.liq, 90.4522613, "liq: mmr за замовчуванням 0,5");
  r = good("liq", { entry: "100", lev: "10", mmr: "0" }); near(r.liq, 90, "liq: нульова підтримуюча маржа");
  miss("liq", {}, ["entry", "lev"]); miss("liq", { entry: "100", lev: "10", extra: "5" }, ["notional"]);
  bad("liq", { entry: "100", lev: "10", stop: "101" }, "stop"); bad("liq", { entry: "100", lev: "0" }, "lev"); bad("liq", { entry: "100", lev: "10", mmr: "51" }, "mmr"); }

// ---------------------------------------------------------------- PnL і ROE
{ let r = good("pnl", { dir: "long", entry: "100", exit: "110", size_mode: "qty", size: "2", lev: "10", fee_in: "0", fee_out: "0" });
  near(r.gross, 20, "pnl: результат без комісій"); near(r.net, 20, "pnl: чистий"); near(r.margin, 20, "pnl: маржа"); near(r.roe, 100, "pnl: ROE 100%"); near(r.change_pct, 10, "pnl: зміна ціни");
  r = good("pnl", { dir: "long", entry: "100", exit: "110", size_mode: "qty", size: "2", lev: "10", fee_in: "0,05", fee_out: "0,05" });
  near(r.fees, 200 * 0.0005 + 220 * 0.0005, "pnl: комісії від входу й виходу"); near(r.net, 20 - 0.21, "pnl: чистий з комісіями");
  r = good("pnl", { dir: "short", entry: "100", exit: "90", size_mode: "notional", size: "1000", lev: "5", fee_in: "0", fee_out: "0" }); near(r.qty, 10, "pnl: номінал → кількість"); near(r.gross, 100, "pnl шорт: прибуток"); near(r.roe, 50, "pnl шорт: ROE"); near(r.change_pct, 10, "pnl шорт: зміна ціни у твою сторону");
  r = good("pnl", { dir: "short", entry: "100", exit: "110", size_mode: "qty", size: "1", fee_in: "0", fee_out: "0" }); near(r.net, -10, "pnl шорт: збиток"); eq(r.roe, null, "pnl: без плеча немає ROE"); near(r.net_pct, -10, "pnl: % від номіналу");
  r = good("pnl", { dir: "long", entry: "100", exit: "105", size_mode: "margin", size: "50", lev: "10", fee_in: "0", fee_out: "0" }); near(r.notional, 500, "pnl: маржа × плече = номінал"); near(r.qty, 5, "pnl: кількість з маржі"); near(r.roe, 50, "pnl: ROE від маржі");
  miss("pnl", {}, ["entry", "exit", "size"]); miss("pnl", { entry: "100", exit: "110", size_mode: "margin", size: "50" }, ["lev"]);
  bad("pnl", { entry: "100", exit: "-1", size: "1" }, "exit"); bad("pnl", { entry: "100", exit: "110", size: "1", fee_in: "9" }, "fee_in"); }

// ---------------------------------------------------------------- комісії
{ let r = good("fees", { notional: "10000", maker: "0,02", taker: "0,05", entry_type: "taker", exit_type: "taker", discount: "0" });
  near(r.total, 10, "fees: тейкер + тейкер"); near(r.fee_in, 5, "fees: вхід"); near(r.fee_out, 5, "fees: вихід"); near(r.total_pct, 0.1, "fees: % разом");
  eq(r.combos.map((c) => Math.round(c.money * 1e9) / 1e9), [4, 7, 7, 10], "fees: чотири комбінації"); near(r.combos[1].money, 7, "fees: мейкер + тейкер"); eq(r.net, null, "fees: без результату"); eq(r.month, null, "fees: без угод на місяць");
  r = good("fees", { notional: "10000", maker: "0,02", taker: "0,05", entry_type: "maker", exit_type: "maker" }); near(r.total, 4, "fees: мейкер + мейкер");
  r = good("fees", { notional: "10000", maker: "0,02", taker: "0,05", entry_type: "taker", exit_type: "taker", discount: "10" }); near(r.total, 9, "fees: знижка 10%");
  r = good("fees", { notional: "10000", entry_type: "taker", exit_type: "taker", gross: "100", lev: "10", trades: "20" });
  near(r.net, 90, "fees: чистий результат"); near(r.share, 10, "fees: частка комісій"); near(r.margin_pct, 1, "fees: від маржі"); near(r.month, 200, "fees: за місяць");
  r = good("fees", { notional: "1000", entry_type: "taker", exit_type: "taker", gross: "-50" }); near(r.net, -51, "fees: збиток з комісіями");
  r = good("fees", { notional: "1000", entry_type: "taker", exit_type: "taker", maker: "", taker: "" }); near(r.total, 1, "fees: ставки за замовчуванням");
  miss("fees", {}, ["notional"]); bad("fees", { notional: "1000", discount: "101" }, "discount"); bad("fees", { notional: "1000", trades: "2,5" }, "trades", /ціле/); bad("fees", { notional: "1000", maker: "-1" }, "maker"); }

// ---------------------------------------------------------------- фандинг
{ let r = good("funding", { dir: "long", notional: "1000", rate: "0,01", interval: "8", hold: "3", unit: "d" });
  near(r.periods, 9, "funding: 9 періодів"); near(r.one, 0.1, "funding: один період"); near(r.day, 0.3, "funding: за добу"); near(r.month, 9, "funding: за 30 днів"); near(r.total, 0.9, "funding: разом"); near(r.apr, 10.95, "funding: у річних"); eq(r.pays, true, "funding: лонг платить");
  r = good("funding", { dir: "short", notional: "1000", rate: "0,01", interval: "8", hold: "3", unit: "d" }); near(r.total, -0.9, "funding: шорт отримує"); eq(r.pays, false, "funding: шорт не платить"); near(r.apr, -10.95, "funding: річні шорта");
  r = good("funding", { dir: "long", notional: "1000", rate: "-0,02", interval: "8", hold: "8", unit: "h" }); near(r.total, -0.2, "funding: від'ємна ставка, лонг отримує"); eq(r.pays, false, "funding: лонг не платить");
  r = good("funding", { dir: "long", notional: "1000", rate: "0,01", interval: "1", hold: "10", unit: "h" }); near(r.periods, 10, "funding: період 1 год"); near(r.day, 0.1 * 24, "funding: за добу при 1 год");
  r = good("funding", { dir: "long", notional: "1000", rate: "0,01", interval: "4", hold: "1", unit: "d", lev: "10" }); near(r.periods, 6, "funding: період 4 год"); near(r.margin_pct, (0.6 / 100) * 100, "funding: від маржі");
  r = good("funding", { dir: "long", notional: "1000", rate: "0", hold: "1" }); eq(r.total, 0, "funding: нульова ставка");
  miss("funding", {}, ["notional", "rate", "hold"]); bad("funding", { notional: "1000", rate: "6", hold: "1" }, "rate"); bad("funding", { notional: "1000", rate: "0,01", hold: "0" }, "hold"); }

// ---------------------------------------------------------------- беззбиткова ціна
{ let r = good("breakeven", { dir: "long", entry: "100", fee_in: "0,05", fee_out: "0,05" }); near(r.be, 100 * 1.0005 / 0.9995, "breakeven: лонг"); ok(r.be > 100.1, "breakeven: трохи більше за суму відсотків");
  r = good("breakeven", { dir: "short", entry: "100", fee_in: "0,05", fee_out: "0,05" }); near(r.be, 100 * 0.9995 / 1.0005, "breakeven: шорт"); ok(r.be < 100, "breakeven: шорт нижче входу");
  r = good("breakeven", { dir: "long", entry: "100", fee_in: "0", fee_out: "0", funding: "1" }); near(r.be, 101, "breakeven: фандинг 1%");
  r = good("breakeven", { dir: "long", entry: "100", fee_in: "0", fee_out: "0", funding: "-1" }); near(r.be, 99, "breakeven: фандинг-дохід"); near(r.pct, 1, "breakeven: рух 1%");
  r = good("breakeven", { dir: "long", entry: "100", fee_in: "0,05", fee_out: "0,05", lev: "10" }); near(r.margin_pct, r.pct * 10, "breakeven: від маржі з плечем");
  r = good("breakeven", { dir: "long", entry: "100" }); near(r.be, 100, "breakeven: без комісій");
  miss("breakeven", {}, ["entry"]); bad("breakeven", { dir: "short", entry: "100", fee_in: "0", fee_out: "0", funding: "100" }, "funding", /100%/); bad("breakeven", { entry: "100", fee_in: "-1" }, "fee_in"); }

// ---------------------------------------------------------------- спот
{ let r = good("spot", { mode: "amount", size: "1000", buy: "100", fee: "0,1" });
  near(r.coins, 9.99, "spot: монет після комісії"); near(r.spent, 1000, "spot: витрачено"); near(r.eff_price, 1000 / 9.99, "spot: реальна ціна входу"); near(r.be_price, 100.2003003, "spot: беззбиток", 1e-6);
  near(r.be_price, 100 / 0.999 / 0.999, "spot: беззбиток = buy / (1-f)²"); eq(r.pnl, undefined, "spot: без ціни продажу немає результату");
  r = good("spot", { mode: "amount", size: "1000", buy: "100", fee: "0,1", sell: "110", target: "10" });
  near(r.proceeds, 9.99 * 110 * 0.999, "spot: виручка"); near(r.pnl, 9.99 * 110 * 0.999 - 1000, "spot: результат"); near(r.roi, (r.pnl / 1000) * 100, "spot: ROI");
  near(r.coins * r.target_price * 0.999, 1100, "spot: ціна для цілі справді дає +10%");
  r = good("spot", { mode: "qty", size: "10", buy: "100", fee: "0,1" }); near(r.coins, 10, "spot: задано кількість"); near(r.spent, 1000 / 0.999, "spot: потрібна сума з комісією");
  r = good("spot", { mode: "amount", size: "1000", buy: "100", fee: "0" }); near(r.coins, 10, "spot: без комісії"); near(r.be_price, 100, "spot: без комісії беззбиток = ціна");
  miss("spot", {}, ["size", "buy"]); bad("spot", { size: "1", buy: "1", fee: "51" }, "fee"); bad("spot", { size: "1", buy: "0" }, "buy"); }

// ---------------------------------------------------------------- грид-бот
{ const base = { low: "100", high: "200", n: "10", invest: "1000", kind: "arith", fee: "0,1" };
  let r = good("grid", base);
  near(r.step, 10, "grid: крок"); near(r.amt, 100, "grid: капітал на сітку"); near(r.net_max, (110 / 100 * 0.999 * 0.999 - 1) * 100, "grid: чистий % на нижній сітці", 1e-9); near(r.net_min, (200 / 190 * 0.999 * 0.999 - 1) * 100, "grid: чистий % на верхній сітці", 1e-9);
  near(r.net_max, 9.78, "grid: ≈9,78%", 1e-2); near(r.net_min, 5.0527, "grid: ≈5,05%", 1e-3);
  const hand = Array.from({ length: 10 }, (_, i) => { const l = 100 + 10 * i; return 100 * ((l + 10) / l * 0.999 * 0.999 - 1); }).reduce((a, b) => a + b, 0); near(r.cycle, hand, "grid: прибуток за цикл");
  near(r.cycle_pct, (r.cycle / 1000) * 100, "grid: цикл у %"); eq(r.geom, false, "grid: арифметична");
  r = good("grid", { ...base, kind: "geom" }); near(r.ratio_pct, (Math.pow(2, 0.1) - 1) * 100, "grid: геометричний крок"); near(r.net_min, r.net_max, "grid: геометрична сітка однакова в %", 1e-9); eq(r.step, null, "grid: у геометричної немає фіксованого кроку");
  near(r.net_max, (Math.pow(2, 0.1) * 0.999 * 0.999 - 1) * 100, "grid: геометричний чистий %", 1e-9);
  r = good("grid", { ...base, n: "500", fee: "0,5" }); ok(r.net_min < 0, "grid: надто дрібна сітка з великою комісією в мінусі");
  const v = T.byId("grid").view(r, F); ok(v.warnings.length === 1, "grid: попередження про комісії, що з'їдають прибуток");
  ok(T.byId("grid").view(good("grid", base), F).warnings.length === 0, "grid: без попередження при нормальних параметрах");
  miss("grid", {}, ["low", "high", "n", "invest"]); // n має значення за замовчуванням лише в інтерфейсі
  bad("grid", { ...base, high: "100" }, "high", /вищою/); bad("grid", { ...base, high: "50" }, "high"); bad("grid", { ...base, n: "1" }, "n"); bad("grid", { ...base, n: "501" }, "n"); bad("grid", { ...base, n: "2,5" }, "n", /ціле/); bad("grid", { ...base, fee: "11" }, "fee"); }

// ---------------------------------------------------------------- DCA
{ let r = good("dca", { amount: "100", prices: "100 50", fee: "0" });
  near(r.qty, 3, "dca: монет"); near(r.total, 200, "dca: вкладено"); near(r.avg, 200 / 3, "dca: середня ціна"); near(r.mean, 75, "dca: проста середня"); ok(r.saving > 0, "dca: вигідніше за просту середню"); eq([r.min, r.max, r.n], [50, 100, 2], "dca: діапазон");
  r = good("dca", { amount: "100", prices: "60000; 58000 55500;62000", cur: "70000" }); eq(r.n, 4, "dca: роздільники пробіл і крапка з комою"); near(r.value, r.qty * 70000, "dca: вартість"); near(r.pnl, r.qty * 70000 - 400, "dca: результат"); near(r.pnl_pct, (r.pnl / 400) * 100, "dca: результат у %");
  r = good("dca", { amount: "100", prices: "100", fee: "1" }); near(r.qty, 0.99, "dca: комісія зменшує кількість"); near(r.avg, 100 / 0.99, "dca: середня з комісією");
  r = good("dca", { amount: "100", prices: "1,5 2,5" }); near(r.mean, 2, "dca: коми в цінах");
  r = good("dca", { amount: "10", prices: Array.from({ length: 200 }, () => "5").join(" ") }); eq(r.n, 200, "dca: рівно 200 цін");
  miss("dca", {}, ["amount", "prices"]); miss("dca", { amount: "100" }, ["prices"]); miss("dca", { amount: "100", prices: "  " }, ["prices"]);
  bad("dca", { amount: "100", prices: "100 abc" }, "prices", /додатними/); bad("dca", { amount: "100", prices: "100 0" }, "prices"); bad("dca", { amount: "100", prices: "100 -5" }, "prices"); bad("dca", { amount: "100", prices: "1e3" }, "prices");
  bad("dca", { amount: "100", prices: Array.from({ length: 201 }, () => "5").join(" ") }, "prices", /200/); bad("dca", { amount: "0", prices: "5" }, "amount"); bad("dca", { amount: "100", prices: "5", fee: "51" }, "fee"); }

// ---------------------------------------------------------------- конвертер
{ let r = good("convert", { base: "btc", quote: "usdt", rate: "60000", dir: "to_quote", amount: "0,5" });
  near(r.result, 30000, "convert: монета у валюту"); eq([r.from, r.to], ["BTC", "USDT"], "convert: назви великими"); near(r.inverse, 1 / 60000, "convert: зворотний курс");
  r = good("convert", { base: "btc", quote: "usdt", rate: "60000", dir: "to_base", amount: "60000" }); near(r.result, 1, "convert: валюта в монету"); eq([r.from, r.to], ["USDT", "BTC"], "convert: напрям назв");
  r = good("convert", { rate: "2", amount: "3" }); eq([r.base, r.quote], ["BASE", "QUOTE"], "convert: назви за замовчуванням"); near(r.result, 6, "convert: без назв");
  const v = T.byId("convert").view(good("convert", { base: "btc", quote: "usdt", rate: "60000", amount: "0,5" }), F); eq(v.big.copy, "30000", "convert: текст для копіювання без зайвих нулів");
  eq(T.byId("convert").view(good("convert", { rate: "3", amount: "1" }), F).big.copy, "3", "convert: копіювання цілого");
  eq(T.byId("convert").view(good("convert", { rate: "3", amount: "1", dir: "to_base" }), F).big.copy, "0.33333333", "convert: копіювання округлюється до 8 знаків");
  eq(T.byId("convert").fields.find((f) => f.key === "rate").label({ base: "eth", quote: "" }), "Курс: 1 ETH = ? валюта", "convert: підпис курсу");
  miss("convert", {}, ["rate", "amount"]); bad("convert", { rate: "0", amount: "1" }, "rate"); bad("convert", { rate: "1", amount: "-1" }, "amount"); }

// ---------------------------------------------------------------- відновлення після просадки
{ let r = good("recovery", { mode: "pct", dd: "50" }); near(r.gain, 100, "recovery: −50% → +100%");
  near(good("recovery", { dd: "20" }).gain, 25, "recovery: −20% → +25%"); near(good("recovery", { dd: "10" }).gain, 100 / 9, "recovery: −10%");
  r = good("recovery", { mode: "bal", peak: "1000", cur: "800" }); near(r.dd, 20, "recovery: просадка з балансів"); near(r.gain, 25, "recovery: приріст з балансів"); near(r.need_money, 200, "recovery: скільки заробити");
  r = good("recovery", { mode: "pct", dd: "50", monthly: "10" }); near(r.months, Math.log(2) / Math.log(1.1), "recovery: місяців");
  r = good("recovery", { mode: "pct", dd: "50", risk: "1", exp: "0,5" }); near(r.trades, Math.log(2) / Math.log(1.005), "recovery: угод"); eq(r.months, undefined, "recovery: місяців немає без дохідності");
  eq(good("recovery", { dd: "50", risk: "1" }).trades, undefined, "recovery: для угод потрібні і ризик, і очікування");
  eq(r.table.length, 10, "recovery: таблиця 5–90%"); near(r.table[5].gain, 100, "recovery: рядок 50% = 100%");
  miss("recovery", {}, ["dd"]); miss("recovery", { mode: "bal" }, ["peak", "cur"]);
  bad("recovery", { dd: "100" }, "dd"); bad("recovery", { dd: "0" }, "dd"); bad("recovery", { mode: "bal", peak: "1000", cur: "1000" }, "cur", /просадки немає/); bad("recovery", { mode: "bal", peak: "1000", cur: "1200" }, "cur"); }

// ---------------------------------------------------------------- ліміти ризику
{ let r = good("daylimit", { deposit: "10000", risk: "1", day: "3", week: "6" });
  eq([r.stops_day, r.stops_week], [3, 6], "daylimit: стопів у день і тиждень"); near(r.risk_money, 100, "daylimit: ризик у грошах"); near(r.day_money, 300, "daylimit: денний ліміт"); near(r.week_money, 600, "daylimit: тижневий ліміт"); near(r.days_week, 2, "daylimit: днів у тижні");
  eq(r.warnings, [], "daylimit: без попереджень"); eq(r.table.map((q) => q.n), [1, 2, 3, 5, 8, 10, 15, 20], "daylimit: таблиця серій");
  near(r.table[1].equity, 9801, "daylimit: баланс після двох стопів"); near(r.table[1].loss, 1.99, "daylimit: збиток після двох стопів"); near(r.table[1].recover, (1 / 0.9801 - 1) * 100, "daylimit: потрібний приріст");
  eq(good("daylimit", { deposit: "1000", risk: "0,1", day: "0,3", week: "1" }).stops_day, 3, "daylimit: без помилки округлення (0,3 ÷ 0,1)");
  eq(good("daylimit", { deposit: "1000", risk: "1", day: "3,9", week: "7" }).stops_day, 3, "daylimit: ціла частина");
  r = good("daylimit", { deposit: "1000", risk: "4", day: "3", week: "6" }); ok(r.warnings.some((w) => /більший за денний/.test(w)), "daylimit: ризик більший за ліміт"); eq(r.stops_day, 0, "daylimit: жодного стопу не вміщається");
  r = good("daylimit", { deposit: "1000", risk: "1", day: "7", week: "6" }); ok(r.warnings.some((w) => /Денний ліміт більший/.test(w)), "daylimit: день більший за тиждень");
  miss("daylimit", {}, ["deposit", "risk", "day", "week"]); bad("daylimit", { deposit: "0", risk: "1", day: "3", week: "6" }, "deposit"); bad("daylimit", { deposit: "1000", risk: "101", day: "3", week: "6" }, "risk"); }

// ---------------------------------------------------------------- очікування
{ let r = good("expectancy", { wr: "40", win: "2", loss: "1" });
  near(r.exp, 0.2, "expectancy: 0,2R"); near(r.pf, 0.8 / 0.6, "expectancy: profit factor"); near(r.be_wr, 100 / 3, "expectancy: беззбитковий winrate"); near(r.kelly, 10, "expectancy: Келлі 10%"); near(r.half_kelly, 5, "expectancy: половина Келлі");
  r = good("expectancy", { wr: "50", win: "2", loss: "1" }); near(r.exp, 0.5, "expectancy: 50% при 2R"); near(r.pf, 2, "expectancy: pf 2"); near(r.kelly, 25, "expectancy: Келлі 25%");
  r = good("expectancy", { wr: "50", win: "2", loss: "1", fee: "0,1" }); near(r.exp, 0.4, "expectancy: комісії віднімаються");
  r = good("expectancy", { wr: "100", win: "2", loss: "1" }); eq(r.pf, null, "expectancy: без збиткових угод pf не визначений"); near(r.exp, 2, "expectancy: 100% winrate");
  r = good("expectancy", { wr: "30", win: "1", loss: "1" }); near(r.exp, -0.4, "expectancy: збиткова"); ok(r.kelly < 0, "expectancy: Келлі від'ємний");
  ok(T.byId("expectancy").view(r, F).warnings.length === 1, "expectancy: попередження при від'ємному очікуванні"); eq(T.byId("expectancy").view(r, F).tiles.find((t) => t.id === "kelly").value, "0%", "expectancy: Келлі не показує від'ємне");
  r = good("expectancy", { wr: "40", win: "2", loss: "1", risk: "1", trades: "20" }); near(r.per_trade_pct, 0.2, "expectancy: % рахунку на угоду"); near(r.month_pct, (Math.pow(1.002, 20) - 1) * 100, "expectancy: за місяць зі складним відсотком");
  eq(good("expectancy", { wr: "40", win: "2", loss: "1", trades: "20" }).month_pct, undefined, "expectancy: місячний результат потребує ризику");
  miss("expectancy", {}, ["wr", "win", "loss"]); bad("expectancy", { wr: "101", win: "2", loss: "1" }, "wr"); bad("expectancy", { wr: "-1", win: "2", loss: "1" }, "wr"); bad("expectancy", { wr: "40", win: "0", loss: "1" }, "win"); bad("expectancy", { wr: "40", win: "2", loss: "1", fee: "-1" }, "fee"); }

// ---------------------------------------------------------------- Монте-Карло
{ const base = { wr: "45", win: "2", loss: "1", trades: "100", risk: "1", limit: "20", seed: "1" };
  const a = good("montecarlo", base), b = good("montecarlo", base), c = good("montecarlo", { ...base, seed: "2" });
  eq(a, b, "montecarlo: однаковий seed дає однаковий результат"); ok(a.median !== c.median || a.dd_p95 !== c.dd_p95 || a.profit_prob !== c.profit_prob, "montecarlo: інший seed дає інший результат");
  eq(a.sims, T.SIMS, "montecarlo: кількість симуляцій"); ok(a.p5 <= a.median && a.median <= a.p95, "montecarlo: p5 ≤ медіана ≤ p95"); ok(a.dd_median <= a.dd_p95, "montecarlo: просадка типова ≤ 95-й перцентиль");
  ok(a.streak_median <= a.streak_p95 && a.streak_median >= 1, "montecarlo: серії стопів"); near(a.exp, 0.35, "montecarlo: очікування в R"); ok(a.profit_prob > 80 && a.profit_prob <= 100, "montecarlo: при +0,35R прибуток у більшості серій");
  ok(a.median > 20 && a.median < 60, `montecarlo: типовий результат близький до +40%: ${a.median}`); ok(a.dd_prob >= 0 && a.dd_prob <= 100, "montecarlo: ймовірність просадки в межах 0–100");
  let r = good("montecarlo", { ...base, wr: "100" }); eq(r.profit_prob, 100, "montecarlo: 100% winrate завжди в плюс"); near(r.median, (Math.pow(1.02, 100) - 1) * 100, "montecarlo: 100% winrate = детермінований складний відсоток", 1e-6); eq(r.dd_p95, 0, "montecarlo: без збитків немає просадки"); eq(r.streak_p95, 0, "montecarlo: без збитків немає серій");
  r = good("montecarlo", { ...base, wr: "0" }); eq(r.profit_prob, 0, "montecarlo: 0% winrate завжди в мінус"); eq(r.streak_median, 100, "montecarlo: усі 100 угод збиткові"); near(r.median, (Math.pow(0.99, 100) - 1) * 100, "montecarlo: 0% winrate = детермінована просадка", 1e-6);
  ok(T.byId("montecarlo").view(r, F).warnings.length === 1, "montecarlo: попередження при від'ємному очікуванні");
  const lo = good("montecarlo", { ...base, trades: "1" }); ok(lo.profit_prob > 30 && lo.profit_prob < 60, "montecarlo: одна угода ≈ winrate"); eq(good("montecarlo", { ...base, limit: "" }).dd_limit, 20, "montecarlo: поріг просадки за замовчуванням 20");
  eq(good("montecarlo", { ...base, seed: "x" }), good("montecarlo", { ...base, seed: "1" }), "montecarlo: сміття в seed це 1");
  const s = T.simulate({ w: 0.5, win: 1, loss: 1, trades: 10, risk: 1, seed: 5, sims: 50 }); eq([s.finals.length, s.dds.length, s.streaks.length], [50, 50, 50], "simulate: довжини масивів");
  const w = T.simulate({ w: 0.5, win: 1, loss: 1, trades: 10, risk: 1, seed: 5, sims: 50 }); eq(s, w, "simulate: детермінована");
  miss("montecarlo", { trades: "100", risk: "1", win: "2", loss: "1" }, ["wr"]); miss("montecarlo", {}, ["wr", "win", "loss", "trades", "risk"]);
  bad("montecarlo", { ...base, trades: "0" }, "trades"); bad("montecarlo", { ...base, trades: "2001" }, "trades"); bad("montecarlo", { ...base, trades: "10,5" }, "trades", /ціле/); bad("montecarlo", { ...base, wr: "101" }, "wr");
  bad("montecarlo", { ...base, risk: "100", loss: "1" }, "risk", /весь баланс/); bad("montecarlo", { ...base, risk: "60", loss: "2" }, "risk", /весь баланс/);
  const act = T.byId("montecarlo").actions[0]; const vals = { seed: "1" }; act.run(vals); eq(vals.seed, "2", "montecarlo: «Нова симуляція» збільшує seed"); act.run(vals); eq(vals.seed, "3", "montecarlo: і далі");
  act.run((vals.seed = "abc", vals)); eq(vals.seed, "2", "montecarlo: сміття в seed → 2"); }

// ---------------------------------------------------------------- показ: усі калькулятори на типових даних
const SAMPLES = {
  rr: { entry: "100", stop: "98", tp1: "106", tp2: "110", risk_money: "50" }, partial: { entry: "100", stop: "98", tp1: "104", share1: "50", move: "be", tp2: "108", risk_money: "100" },
  avg: { p1: "100", q1: "1", p2: "80", q2: "1", cur: "95", tgt: "10", add_price: "70", want: "80" }, pipv: { lots: "0,5", pips: "20", money: "50" },
  futures: { entry: "100", lev: "10", size_mode: "risk", risk_mode: "pct", risk: "1", deposit: "1000", stop: "95", tp: "110", fee: "0,05" }, liq: { entry: "100", lev: "10", stop: "95", notional: "1000", extra: "10" },
  pnl: { entry: "100", exit: "110", size: "2", lev: "10", fee_in: "0,05", fee_out: "0,05" }, fees: { notional: "10000", gross: "100", lev: "10", trades: "20" }, funding: { notional: "1000", rate: "0,01", hold: "3", lev: "10" },
  breakeven: { entry: "100", funding: "0,1", lev: "10" }, spot: { size: "1000", buy: "100", sell: "110", target: "10" }, grid: { low: "100", high: "200", n: "10", invest: "1000" },
  dca: { amount: "100", prices: "100 50", cur: "80" }, convert: { rate: "60000", amount: "0,5" }, recovery: { dd: "30", monthly: "5", risk: "1", exp: "0,3" },
  daylimit: { deposit: "10000", risk: "1", day: "3", week: "6" }, expectancy: { wr: "45", win: "2", loss: "1", fee: "0,05", risk: "1", trades: "20" }, montecarlo: { wr: "45", win: "2", loss: "1", trades: "50", risk: "1" },
};
for (const t of T.TOOLS) {
  const defaults = Object.fromEntries(t.fields.filter((f) => f.def != null).map((f) => [f.key, f.def]));
  for (const dir of ["long", "short"]) {
    const v = { ...defaults, ...SAMPLES[t.id], dir };
    const ctx = { asset: t.id === "pipv" ? EUR : null, acc: "USD", needRate: false };
    const res = t.compute(v, ctx);
    if (!res.ok) { // шорт може бути недопустимим для тих самих цін: тоді перевіряємо лише, що помилка названа
      ok(dir === "short" && Object.keys(res.errors).length > 0, `${t.id} (${dir}): типові дані мають рахуватись: ${JSON.stringify(res)}`);
      continue;
    }
    let view;
    try { view = t.view(res, F, ctx); } catch (e) { ok(false, `${t.id} (${dir}): view впав: ${e.message}`); continue; }
    ok(view.big && view.big.label && view.big.value && !/NaN|undefined|Infinity/.test(JSON.stringify(view)), `${t.id} (${dir}): у показі немає NaN/undefined: ${JSON.stringify(view).match(/.{0,40}(NaN|undefined|Infinity).{0,40}/)}`);
    const ids = (view.tiles || []).map((x) => x.id);
    ok(new Set(ids).size === ids.length && ids.every(Boolean), `${t.id} (${dir}): id плиток унікальні`);
    ok((view.tiles || []).every((x) => x.label && typeof x.value === "string"), `${t.id} (${dir}): плитки мають підпис і текстове значення`);
    for (const tb of view.tables || []) ok(tb.id && tb.rows.length && tb.rows.every((row) => row.length === tb.head.length && row.every((c) => typeof c === "string")), `${t.id} (${dir}): таблиця ${tb.id} прямокутна`);
    ok(!view.warnings || view.warnings.every((w) => typeof w === "string"), `${t.id} (${dir}): попередження це рядки`);
  }
}

console.log(failed ? `\nПровалено ${failed} з ${total}` : `OK: ${total} перевірок калькуляторів`);
process.exit(failed ? 1 : 0);
