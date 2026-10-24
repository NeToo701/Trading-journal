/* Перевірки без браузера: бектести (перевірка введених даних, порядок угод, статистика колекції). Запуск: node tests/backtest.test.js */
"use strict";
const path = require("path");
const root = path.join(__dirname, "..");
for (const f of ["jl-util", "jl-schema", "jl-backtest"]) require(path.join(root, "lib", f + ".js"));
const JL = globalThis.JL, B = JL.bt;
let total = 0, failed = 0;
const ok = (cond, msg) => { total++; if (!cond) { failed++; console.log("✗", msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: очікувано ${JSON.stringify(b)}, отримано ${JSON.stringify(a)}`);
const throws = (fn, re, msg) => { total++; try { fn(); failed++; console.log("✗", msg, "(помилки не було)"); } catch (e) { if (!(e instanceof JL.ApiError) || (re && !re.test(e.message))) { failed++; console.log("✗", msg, "->", e.message); } } };

// ---------------------------------------------------------------- число з вводу
for (const [v, want] of [["1,5", 1.5], ["-2", -2], ["−1", -1], [" +3 ", 3], ["0", 0], [".5", 0.5], ["2.", 2], [2, 2], [-0.25, -0.25], ["", undefined], ["   ", undefined], [null, undefined], [undefined, undefined]])
  eq(B.parseNum(v), want, `parseNum(${JSON.stringify(v)})`);
for (const v of ["abc", "1e3", "1,2,3", "--1", "1 2", NaN, Infinity, {}, [], true]) ok(Number.isNaN(B.parseNum(v)), `parseNum(${String(v)}) це сміття`);

// ---------------------------------------------------------------- колекція
eq(B.cleanCol({ name: "  Пробій  ", note: "опис", risk_pct: "1,5" }), { name: "Пробій", note: "опис", risk_pct: 1.5 }, "cleanCol: звичайна колекція");
eq(B.cleanCol({ name: "A" }), { name: "A", note: "", risk_pct: null }, "cleanCol: лише назва");
eq(B.cleanCol({ name: "A", risk_pct: "" }).risk_pct, null, "cleanCol: порожній ризик");
throws(() => B.cleanCol({ name: "" }), /порожньою/, "cleanCol: порожня назва");
throws(() => B.cleanCol({}), /порожньою/, "cleanCol: без назви");
throws(() => B.cleanCol({ name: "x".repeat(61) }), /задовге/, "cleanCol: довга назва");
throws(() => B.cleanCol({ name: "A", note: "x".repeat(501) }), /задовге/, "cleanCol: довгий опис");
for (const bad of ["0", "-1", "101", "abc"]) throws(() => B.cleanCol({ name: "A", risk_pct: bad }), /Ризик/, `cleanCol: ризик ${bad}`);

// ---------------------------------------------------------------- угода
eq(B.cleanTrade({ date: "2024-02-29", symbol: " btc  usdt ", direction: "лонг", setup: "  Пробій   діапазону ", r: "2,5", note: " нотатка " }),
  { date: "2024-02-29", symbol: "BTC USDT", direction: "Лонг", setup: "Пробій діапазону", r: 2.5, note: "нотатка" }, "cleanTrade: звичайна угода");
eq(B.cleanTrade({ r: -1 }), { date: "", symbol: "", direction: "", setup: "", r: -1, note: "" }, "cleanTrade: лише результат");
eq(B.cleanTrade({ r: 0.123456 }).r, 0.1235, "cleanTrade: округлення до 4 знаків");
eq(B.cleanTrade({ r: 1, direction: "SHORT" }).direction, "Шорт", "cleanTrade: напрямок англійською");
throws(() => B.cleanTrade({}), /результат/i, "cleanTrade: без результату");
throws(() => B.cleanTrade({ r: "" }), /результат/i, "cleanTrade: порожній результат");
throws(() => B.cleanTrade({ r: "abc" }), /число/, "cleanTrade: результат не число");
throws(() => B.cleanTrade({ r: 1001 }), /число/, "cleanTrade: завеликий результат");
throws(() => B.cleanTrade({ r: 1, date: "2023-02-29" }), /дата/i, "cleanTrade: неіснуюча дата");
throws(() => B.cleanTrade({ r: 1, date: "01.02.2024" }), /дата/i, "cleanTrade: формат дати");
throws(() => B.cleanTrade({ r: 1, direction: "вгору" }), /Напрямок/, "cleanTrade: напрямок");
throws(() => B.cleanTrade({ r: 1, symbol: "x".repeat(21) }), /задовге/, "cleanTrade: довгий інструмент");
throws(() => B.cleanTrade({ r: 1, setup: "x".repeat(41) }), /задовге/, "cleanTrade: довгий сетап");
throws(() => B.cleanTrade({ r: 1, symbol: 5 }), /текстом/, "cleanTrade: інструмент не текст");

// ---------------------------------------------------------------- сетапи без дублів за регістром
eq(B.canonSetup([{ setup: "Breakout" }, { setup: "Breakout" }, { setup: "breakout" }], "BREAKOUT"), "Breakout", "canonSetup: найчастіше написання");
eq(B.canonSetup([{ setup: "Breakout" }], "Відбій"), "Відбій", "canonSetup: новий сетап");
eq(B.canonSetup([], ""), "", "canonSetup: порожній");

// ---------------------------------------------------------------- порядок угод
const T = (id, date, r, extra = {}) => ({ id, col_id: 1, date, symbol: "", direction: "", setup: "", r, note: "", ...extra });
eq(B.order([T(3, "2024-01-02", 1), T(1, "2024-01-03", 1), T(2, "2024-01-02", 1)]).map((t) => t.id), [2, 3, 1], "order: за датою, потім за порядком додавання");
eq(B.order([T(3, "2024-01-02", 1), T(1, "", 1), T(2, "2024-01-01", 1)]).map((t) => t.id), [1, 2, 3], "order: без дат хоча б в однієї угоди тільки за порядком додавання");

// ---------------------------------------------------------------- статистика (порахована вручну)
const rs = [2, -1, -1, 3, 0, -0.5, 1.5, -1];
const trades = rs.map((r, i) => T(i + 1, `2024-03-0${i + 1}`, r, { symbol: i % 2 ? "ETHUSDT" : "BTCUSDT", direction: i < 4 ? "Лонг" : "Шорт", setup: i < 5 ? "Пробій" : "Відбій" }));
const s = B.compute(trades.slice().reverse(), 1.5);
eq([s.trades, s.wins, s.losses, s.be], [8, 3, 4, 1], "stats: лічильники");
eq([s.win_rate, s.total_r, s.avg_r], [37.5, 3, 0.38], "stats: winrate, сума й середній R");
eq([s.profit_factor, s.avg_win_r, s.avg_loss_r, s.payoff], [1.86, 2.17, -0.88, 2.47], "stats: profit factor, середні, співвідношення");
eq([s.best_r, s.worst_r, s.max_drawdown_r], [3, -1, 2], "stats: найкраща, найгірша, просадка");
eq([s.win_streak, s.loss_streak], [1, 2], "stats: серії (беззбиток обриває серію)");
eq([s.risk_pct, s.return_pct, s.max_drawdown_pct], [1.5, 4.5, 3], "stats: дохідність у % при ризику 1,5%");
eq([s.first_day, s.last_day], ["2024-03-01", "2024-03-08"], "stats: період");
eq(s.equity.map((p) => p.r), [2, 1, 0, 3, 3, 2.5, 4, 3], "stats: крива результату (порядок не залежить від порядку вхідних даних)");
eq(s.equity.map((p) => p.n), [1, 2, 3, 4, 5, 6, 7, 8], "stats: номери угод");
const bs = s.breakdowns.setup;
eq(bs.map((r) => [r.label, r.trades, r.total_r]), [["Пробій", 5, 3], ["Відбій", 3, 0]], "stats: розбивка за сетапом");
eq(s.breakdowns.direction.map((r) => [r.label, r.trades, r.win_rate]), [["Лонг", 4, 50], ["Шорт", 4, 25]], "stats: розбивка за напрямком");
eq(s.breakdowns.month.map((r) => [r.label, r.trades]), [["Березень 2024", 8]], "stats: розбивка за місяцями");
eq(s.breakdowns.symbol.length, 2, "stats: розбивка за інструментом");
const noRisk = B.compute(trades, null);
eq([noRisk.risk_pct, noRisk.return_pct, noRisk.max_drawdown_pct], [null, null, null], "stats: без ризику немає відсотків");

// межі
const empty = B.compute([], null);
eq([empty.trades, empty.win_rate, empty.total_r, empty.avg_r, empty.profit_factor, empty.max_drawdown_r, empty.equity.length], [0, null, 0, null, null, null, 0], "stats: порожня колекція");
const wins = B.compute([T(1, "", 1), T(2, "", 2)], null);
eq([wins.profit_factor, wins.avg_loss_r, wins.payoff, wins.win_rate, wins.max_drawdown_r], [null, null, null, 100, 0], "stats: лише виграші (profit factor немає)");
const losses = B.compute([T(1, "", -1), T(2, "", -2)], null);
eq([losses.profit_factor, losses.win_rate, losses.max_drawdown_r, losses.loss_streak], [0, 0, 3, 2], "stats: лише збитки (profit factor 0)");
const onlyBe = B.compute([T(1, "", 0.04), T(2, "", -0.05)], null);
eq([onlyBe.wins, onlyBe.losses, onlyBe.be], [0, 0, 2], "stats: беззбиток до ±0,05 R");
eq(B.compute([T(1, "", 1)], null).breakdowns.setup.map((r) => r.label), ["Не вказано"], "stats: без сетапу «Не вказано»");
eq(B.compute([T(1, "", 1)], null).breakdowns.month.map((r) => r.label), ["Без дати"], "stats: без дати «Без дати»");
const noise = B.compute([0.1, 0.2, 0.3].map((r, i) => T(i + 1, "", r)), null);
eq(noise.equity.map((p) => p.r), [0.1, 0.3, 0.6], "stats: сума без похибки плаваючої коми");

console.log(failed ? `ПРОВАЛ: ${failed} з ${total}` : `OK: ${total} перевірок`);
process.exit(failed ? 1 : 0);
