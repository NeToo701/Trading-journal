/* Перевірки без браузера: калькулятори (активи, налаштування, розрахунок лота). Запуск: node tests/calc.test.js */
"use strict";
const path = require("path");
const root = path.join(__dirname, "..");
for (const f of ["jl-util", "jl-schema", "jl-calc"]) require(path.join(root, "lib", f + ".js"));
const JL = globalThis.JL, C = JL.calc;
let total = 0, failed = 0;
const ok = (cond, msg) => { total++; if (!cond) { failed++; console.log("✗", msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: очікувано ${JSON.stringify(b)}, отримано ${JSON.stringify(a)}`);
const near = (a, b, msg, eps = 1e-6) => ok(typeof a === "number" && Math.abs(a - b) < eps, `${msg}: очікувано ${b}, отримано ${a}`);
const throws = (fn, re, msg) => { total++; try { fn(); failed++; console.log("✗", msg, "(помилки не було)"); } catch (e) { if (!(e instanceof JL.ApiError) || (re && !re.test(e.message))) { failed++; console.log("✗", msg, "->", e.message); } } };
const [EUR, GBP, XAU] = C.DEFAULT_ASSETS;
const JPY = () => C.cleanAsset({ ...good, commission: 0 });
const lots = (inp, a) => { const r = C.sizeLots(inp, a); return r.ok ? r.result : r; };

// ---------------------------------------------------------------- число з вводу
for (const [v, want] of [["1,5", 1.5], ["10 000", 10000], ["10 000,5", 10000.5], ["−2", -2], ["+3", 3], [".5", 0.5], [7, 7], ["", undefined], ["  ", undefined], [null, undefined]])
  eq(C.parseNum(v), want, `parseNum(${JSON.stringify(v)})`);
for (const v of ["abc", "1e3", "1,2,3", "1 2 x", NaN, Infinity, {}, true]) ok(Number.isNaN(C.parseNum(v)), `parseNum(${String(v)}) це сміття`);

// ---------------------------------------------------------------- стандартні активи
eq(C.DEFAULT_ASSETS.map((a) => a.symbol), ["EURUSD", "GBPUSD", "XAUUSD"], "стандартні активи: євро, фунт, золото");
eq([EUR, GBP, XAU].map((a) => [a.contract_size, a.pip_size, a.quote_ccy]), [[100000, 0.0001, "USD"], [100000, 0.0001, "USD"], [100, 0.1, "USD"]], "параметри стандартних активів");
for (const a of C.DEFAULT_ASSETS) { const c = C.cleanAsset(a); eq([c.symbol, c.contract_size, c.pip_size], [a.symbol, a.contract_size, a.pip_size], `стандартний ${a.symbol} проходить власну перевірку`); }
Object.freeze(EUR);

// ---------------------------------------------------------------- символ
for (const [v, want] of [["eurusd", "EURUSD"], [" EUR/USD ", "EURUSD"], ["btc usdt", "BTCUSDT"], ["US30.cash", "US30.CASH"], ["a_b-1", "A_B-1"]]) eq(C.normSymbol(v), want, `normSymbol(${v})`);
for (const v of ["", "   ", "євро", "x".repeat(21), "...", "a|b", null]) throws(() => C.normSymbol(v), /символ/i, `normSymbol(${v}) відхиляється`);

// ---------------------------------------------------------------- перевірка активу
const good = { symbol: "usdjpy", name: " Долар / єна ", kind: "forex", contract_size: "100 000", pip_size: "0,01", quote_ccy: "jpy", digits: "3", min_lot: "0,01", lot_step: "0,01", max_lot: "50", commission: "3,5" };
eq(C.cleanAsset(good), { symbol: "USDJPY", name: "Долар / єна", kind: "forex", contract_size: 100000, pip_size: 0.01, quote_ccy: "JPY", digits: 3, min_lot: 0.01, lot_step: 0.01, max_lot: 50, commission: 3.5, hidden: false }, "cleanAsset: звичайний актив");
eq(C.cleanAsset({ ...good, commission: "", name: null, kind: "" }).commission, 0, "cleanAsset: комісія за замовчуванням 0");
eq(C.cleanAsset({ ...good, kind: "" }).kind, "other", "cleanAsset: тип за замовчуванням");
eq(C.cleanAsset({ ...good, hidden: true }).hidden, true, "cleanAsset: схований");
eq(C.cleanAsset({ ...good, symbol: "x" }, "eurusd").symbol, "EURUSD", "cleanAsset: символ береться з шляху");
for (const [k, bad, re] of [["contract_size", "0", /розмір контракту/], ["contract_size", "-5", /розмір контракту/], ["contract_size", "abc", /розмір контракту/], ["contract_size", "", /Вкажи/],
  ["pip_size", "0", /пункту/], ["pip_size", "1e-9", /пункту/], ["quote_ccy", "U", /Валюта/], ["quote_ccy", "ДОЛАР", /Валюта/], ["quote_ccy", "", /Валюта/],
  ["digits", "9", /Знаків/], ["digits", "2,5", /Знаків/], ["digits", "-1", /Знаків/], ["digits", "", /Знаків/], ["min_lot", "0", /мінімальний/], ["lot_step", "0", /крок/], ["max_lot", "0", /максимальний/],
  ["commission", "-1", /комісія/], ["commission", "abc", /комісія/], ["kind", "акції", /Тип/]])
  throws(() => C.cleanAsset({ ...good, [k]: bad }), re, `cleanAsset: ${k}=${bad}`);
throws(() => C.cleanAsset({ ...good, min_lot: 1, max_lot: "0,5" }), /Максимальний лот/, "cleanAsset: максимум менший за мінімум");
throws(() => C.cleanAsset({ ...good, name: "x".repeat(41) }), /задовге/, "cleanAsset: довга назва");
throws(() => C.cleanAsset(null), /символ/i, "cleanAsset: порожнє тіло");
eq(C.cleanAsset({ ...good, pip_size: "0,00000001" }).pip_size, 1e-8, "cleanAsset: найменший пункт");

// ---------------------------------------------------------------- налаштування
eq(C.cleanPrefs({}), { acc_ccy: "USD", deposit: null, risk_mode: "pct", risk_pct: 1, risk_money: null, leverage: null, symbol: "EURUSD", rates: {} }, "cleanPrefs: за замовчуванням");
eq(C.cleanPrefs({ risk_mode: "money", risk_money: "75", deposit: "12 500,5", acc_ccy: "eur", symbol: "xauusd", leverage: "1:100", rates: { jpy: "0,0066" } }),
  { acc_ccy: "EUR", deposit: 12500.5, risk_mode: "money", risk_pct: 1, risk_money: 75, leverage: 100, symbol: "XAUUSD", rates: { JPY: 0.0066 } }, "cleanPrefs: всі поля");
eq(C.cleanPrefs({ risk_pct: null, deposit: "" }).risk_pct, null, "cleanPrefs: порожній ризик стає null");
eq(C.cleanPrefs({ risk_mode: "щось" }).risk_mode, "pct", "cleanPrefs: невідомий режим ризику");
for (const [k, bad, re] of [["deposit", "-1", /Депозит/], ["deposit", "abc", /Депозит/], ["risk_pct", "101", /Ризик/], ["risk_pct", "0", /Ризик/], ["leverage", "0,5", /плече/], ["leverage", "10001", /плече/], ["acc_ccy", "1", /рахунку/], ["symbol", "євро", /символ/i]])
  throws(() => C.cleanPrefs({ [k]: bad }), re, `cleanPrefs: ${k}=${bad}`);
throws(() => C.cleanPrefs({ rates: { JPY: "-1" } }), /Курс/, "cleanPrefs: від'ємний курс");
throws(() => C.cleanPrefs({ rates: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`A${"B".repeat(i + 1)}`, 1])) }), /забагато/, "cleanPrefs: забагато курсів");

// ---------------------------------------------------------------- злиття списку активів
const names = (l) => l.map((a) => a.symbol);
eq(names(C.mergeAssets([], false)), ["EURUSD", "GBPUSD", "XAUUSD"], "mergeAssets: лише вбудовані");
eq(C.mergeAssets([], false).map((a) => [a.builtin, a.modified, a.hidden]), [[true, false, false], [true, false, false], [true, false, false]], "mergeAssets: ознаки вбудованих");
const usdjpy = { key: "asset|USDJPY", ...C.cleanAsset(good), _u: 1 };
const eurMod = { key: "asset|EURUSD", ...C.cleanAsset({ ...EUR, pip_size: 0.00001 }), _u: 2 };
const gbpHidden = { key: "asset|GBPUSD", ...C.cleanAsset({ ...GBP, hidden: true }), _u: 3 };
let m = C.mergeAssets([usdjpy, eurMod, gbpHidden, { key: "prefs", _u: 1 }, null, { key: "asset|BAD" }], false);
eq(names(m), ["EURUSD", "XAUUSD", "USDJPY"], "mergeAssets: схований не показується, власний в кінці, сміття ігнорується");
eq(m[0].pip_size, 0.00001, "mergeAssets: змінений параметр застосовано"); eq([m[0].builtin, m[0].modified], [true, true], "mergeAssets: змінений вбудований");
eq([m[2].builtin, m[2].modified], [false, false], "mergeAssets: власний");
ok(!("key" in m[0]) && !("_u" in m[0]), "mergeAssets: службових полів немає");
eq(names(C.mergeAssets([usdjpy, eurMod, gbpHidden], true)), ["EURUSD", "GBPUSD", "XAUUSD", "USDJPY"], "mergeAssets: усі, зокрема сховані");
eq(EUR.pip_size, 0.0001, "mergeAssets не змінює вбудовані значення");

// ---------------------------------------------------------------- лот: EURUSD
let r = lots({ deposit: "10 000", risk_mode: "pct", risk: "1", direction: "long", entry: "1,1000", stop_mode: "price", stop: "1,0980", tp_mode: "rr", tp: "2", leverage: "30" }, EUR);
eq([r.lots, r.risk_money, r.risk_pct, r.units], [0.5, 100, 1, 50000], "EURUSD: лот, ризик, обсяг");
near(r.stop_pips, 20, "EURUSD: стоп 20 пунктів"); near(r.pip_value, 10, "EURUSD: пункт 10 USD за лот"); near(r.loss_per_lot, 200, "EURUSD: збиток на лот");
near(r.notional, 55000, "EURUSD: номінал"); near(r.margin, 55000 / 30, "EURUSD: маржа при плечі 30");
near(r.rr, 2, "EURUSD: R:R"); near(r.profit_money, 200, "EURUSD: профіт на тейку 2R"); near(r.tp_price, 1.104, "EURUSD: ціна тейку"); near(r.breakeven_winrate, 100 / 3, "EURUSD: беззбитковий winrate");
near(r.stop_price, 1.098, "EURUSD: ціна стопу");
eq(r.alternatives.map((a) => [a.pct, a.lots]), [[0.25, 0.12], [0.5, 0.25], [1, 0.5], [2, 1]], "EURUSD: лот при іншому ризику");
r = lots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20 }, EUR);
eq([r.lots, r.margin, r.notional, r.stop_price], [0.5, null, null, null], "EURUSD: стоп у пунктах без ціни входу");
// округлення вниз до кроку, ризик ніколи не перевищує заданий
r = lots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 13 }, EUR);     // 100 / 130 = 0,769 -> 0,76
eq(r.lots, 0.76, "EURUSD: округлення лота вниз"); ok(r.risk_money <= 100 && r.risk_money > 98, `ризик не перевищує заданий: ${r.risk_money}`);
r = lots({ deposit: 10000, risk: 0.5, stop_mode: "pips", stop: 7 }, EUR);    // 50 / 70 = 0,7142
eq(r.lots, 0.71, "EURUSD: ще одне округлення");
// ризик у грошах без депозиту
r = lots({ risk_mode: "money", risk: "250", stop_mode: "pips", stop: 25 }, EUR);
eq([r.lots, r.risk_pct, r.alternatives.length], [1, null, 0], "ризик у грошах: депозит не потрібен, відсотків немає");
r = lots({ risk_mode: "money", risk: 50, deposit: 5000, stop_mode: "pips", stop: 10 }, EUR);
eq([r.lots, r.risk_pct], [0.5, 1], "ризик у грошах з депозитом: відсоток рахується");
// шорт
r = lots({ deposit: 10000, risk: 1, direction: "short", entry: 1.1, stop_mode: "price", stop: 1.102, tp_mode: "price", tp: 1.096 }, EUR);
eq([r.lots, r.direction], [0.5, "short"], "шорт: лот"); near(r.rr, 2, "шорт: R:R за ціною тейку"); near(r.profit_money, 200, "шорт: профіт"); near(r.stop_price, 1.102, "шорт: стоп");
r = lots({ deposit: 10000, risk: 1, direction: "short", entry: 1.1, stop_mode: "pips", stop: 20, tp_mode: "pips", tp: 60 }, EUR);
near(r.rr, 3, "шорт: тейк у пунктах"); near(r.tp_price, 1.094, "шорт: ціна тейку з пунктів"); near(r.stop_price, 1.102, "шорт: ціна стопу з пунктів");

// ---------------------------------------------------------------- лот: GBPUSD і золото
r = lots({ deposit: 25000, risk: 0.5, entry: 1.27, stop_mode: "price", stop: 1.2655 }, GBP);      // 45 пунктів: 125 / 450
eq(r.lots, 0.27, "GBPUSD: лот"); near(r.stop_pips, 45, "GBPUSD: 45 пунктів");
r = lots({ deposit: 10000, risk: 1, entry: 2000, stop_mode: "price", stop: 1995 }, XAU);
eq(r.lots, 0.2, "XAUUSD: стоп 5 доларів = 0,2 лота"); near(r.stop_pips, 50, "XAUUSD: стоп 50 пунктів за пунктом 0,1"); near(r.pip_value, 10, "XAUUSD: пункт 10 USD за лот"); near(r.loss_per_lot, 500, "XAUUSD: збиток на лот");
r = lots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 50 }, XAU);
eq(r.lots, 0.2, "XAUUSD: стоп у пунктах");
// брокер з іншим пунктом: змінений параметр дає інший результат
const xau2 = C.cleanAsset({ ...XAU, pip_size: 0.01 });
r = lots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 50 }, xau2);
eq(r.lots, 2, "XAUUSD з пунктом 0,01: 50 пунктів це 0,5 долара, лот 2");

// ---------------------------------------------------------------- валюта рахунку
r = C.sizeLots({ deposit: 10000, risk: 1, entry: 150, stop_mode: "price", stop: 149.5 }, JPY());
eq([r.ok, r.missing], [false, ["rate"]], "JPY: потрібен курс");
r = lots({ deposit: 10000, risk: 1, entry: 150, stop_mode: "price", stop: 149.5, rate: "0,01" }, JPY());   // 0,5 * 100000 * 0,01 = 500 на лот
eq(r.lots, 0.2, "JPY: лот з курсом"); near(r.stop_pips, 50, "JPY: 50 пунктів"); near(r.pip_value, 10, "JPY: пункт 10 USD при курсі 0,01");
near(r.margin == null ? 0 : r.margin, 0, "JPY: без плеча маржі немає");
r = lots({ deposit: 10000, risk: 1, entry: 150, stop_mode: "price", stop: 149.5, rate: 0.01, leverage: 100 }, JPY());
near(r.margin, (0.2 * 100000 * 150 * 0.01) / 100, "JPY: маржа через курс");
r = lots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20, acc_ccy: "eur", rate: "1,1" }, EUR);                      // рахунок у EUR, котирування USD
near(r.pip_value, 11, "рахунок в EUR: пункт у євро"); eq(r.acc_ccy, "EUR", "валюта рахунку велика");
r = C.sizeLots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20, acc_ccy: "EUR" }, EUR);
eq(r.missing, ["rate"], "рахунок в EUR: потрібен курс USD до EUR");
ok(C.sameCcy("USD", "USDT") && C.sameCcy("USDC", "USD") && !C.sameCcy("USD", "EUR") && C.sameCcy("EUR", "EUR"), "sameCcy: долар і стейблкоїни однакові");
const btc = C.cleanAsset({ symbol: "BTCUSDT", ...C.PRESETS.find((p) => p.id === "crypto") });
eq([btc.min_lot, btc.lot_step, btc.quote_ccy], [0.001, 0.001, "USDT"], "шаблон крипти");
r = lots({ deposit: 1000, risk: 1, entry: 60000, stop_mode: "price", stop: 59000, leverage: 10 }, btc);     // 10 USDT ризику, збиток 1000 на монету
eq(r.lots, 0.01, "BTCUSDT: лот у монетах (рахунок USD, котирування USDT без курсу)"); near(r.margin, 60, "BTCUSDT: маржа");
r = lots({ deposit: 1000, risk: 1, entry: 60000, stop_mode: "price", stop: 59990 }, btc);                   // 10 / 10 = 1 монета
eq(r.lots, 1, "BTCUSDT: дрібний стоп дає цілу монету");

// ---------------------------------------------------------------- комісія, мінімум, максимум
const comm = C.cleanAsset({ ...EUR, commission: 7 });
r = lots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20 }, comm);        // 100 / 207 = 0,483 -> 0,48
eq(r.lots, 0.48, "комісія зменшує лот"); near(r.risk_money, 0.48 * 207, "ризик включає комісію"); near(r.commission_total, 3.36, "комісія за позицію");
r = lots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20, tp_mode: "rr", tp: 2 }, comm);
near(r.profit_money, 0.48 * (400 - 7), "профіт враховує комісію");
r = C.sizeLots({ deposit: 100, risk: 1, entry: 1.1, stop_mode: "price", stop: 1.09 }, EUR);                  // 1 USD ризику, мінімальний лот ризикує 10
eq([r.ok, r.result.lots, r.result.below_min], [true, 0, true], "менше мінімального лота: лот 0");
ok(r.warnings.some((w) => /Мінімальний лот 0\.01/.test(w) && /10 USD/.test(w)), `попередження про мінімальний лот: ${r.warnings}`);
near(r.result.min_lot_risk, 10, "ризик мінімального лота"); near(r.result.min_lot_risk_pct, 10, "ризик мінімального лота у %");
const capped = C.cleanAsset({ ...EUR, max_lot: 0.3 });
r = C.sizeLots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20 }, capped);
eq(r.result.lots, 0.3, "ліміт максимального лота"); ok(r.warnings.some((w) => /максимумом 0\.3/.test(w)), "попередження про максимум");
r = C.sizeLots({ deposit: 1000, risk: 1, entry: 1.1, stop_mode: "price", stop: 1.098, leverage: 5 }, EUR);   // 10 / 200 = 0,05 лота; номінал 5500, маржа 1100 > 1000
ok(r.warnings.some((w) => /Не вистачає маржі/.test(w)), `нестача маржі: ${r.warnings}`);
r = C.sizeLots({ deposit: 1000, risk: 8, stop_mode: "pips", stop: 20 }, EUR);
ok(r.warnings.some((w) => /понад 5%/.test(w)), "попередження про великий ризик");
eq(C.floorToStep(0.29999999999, 0.01), 0.3, "floorToStep: похибка числа з рухомою комою"); eq(C.floorToStep(0.2999, 0.01), 0.29, "floorToStep: вниз"); eq(C.floorToStep(1.234, 0.5), 1, "floorToStep: крок 0,5");
eq([C.stepDecimals(0.01), C.stepDecimals(0.001), C.stepDecimals(1), C.stepDecimals(1e-7), C.stepDecimals(0.5)], [2, 3, 0, 7, 1], "stepDecimals");

// ---------------------------------------------------------------- незаповнені й неправильні дані
let x = C.sizeLots({}, EUR);
eq([x.ok, x.missing.sort(), Object.keys(x.errors)], [false, ["deposit", "entry", "risk", "stop"], []], "порожня форма: чого бракує");
x = C.sizeLots({ stop_mode: "pips", risk_mode: "money" }, EUR);
eq(x.missing.sort(), ["risk", "stop"], "ризик у грошах, стоп у пунктах: ні депозит, ні вхід не потрібні");
x = C.sizeLots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20, tp_mode: "price", tp: 1.2 }, EUR);
eq(x.missing, ["entry"], "тейк за ціною потребує входу");
x = C.sizeLots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20, tp_mode: "rr" }, EUR);
eq(x.missing, ["tp"], "тейк R:R без значення");
x = C.sizeLots({ deposit: 10000, risk: 1, stop_mode: "pips", stop: 20, tp_mode: "none", tp: "abc" }, EUR);
eq(x.ok, true, "без тейку значення тейку ігнорується");
for (const [inp, field, re] of [
  [{ deposit: "abc", risk: 1, stop_mode: "pips", stop: 20 }, "deposit", /Депозит/],
  [{ deposit: -5, risk: 1, stop_mode: "pips", stop: 20 }, "deposit", /більше нуля/],
  [{ deposit: 1000, risk: 0, stop_mode: "pips", stop: 20 }, "risk", /більше нуля/],
  [{ deposit: 1000, risk: 150, stop_mode: "pips", stop: 20 }, "risk", /не більше 100/],
  [{ deposit: 1000, risk: 1, stop_mode: "pips", stop: "-3" }, "stop", /більше нуля/],
  [{ deposit: 1000, risk: 1, entry: 1.1, stop_mode: "price", stop: 1.2 }, "stop", /нижче входу/],
  [{ deposit: 1000, risk: 1, entry: 1.1, stop_mode: "price", stop: 1.1 }, "stop", /нижче входу/],
  [{ deposit: 1000, risk: 1, direction: "short", entry: 1.1, stop_mode: "price", stop: 1.09 }, "stop", /вище входу/],
  [{ deposit: 1000, risk: 1, entry: 1.1, stop_mode: "price", stop: 1.09, tp_mode: "price", tp: 1.05 }, "tp", /вище входу/],
  [{ deposit: 1000, risk: 1, direction: "short", entry: 1.1, stop_mode: "price", stop: 1.11, tp_mode: "price", tp: 1.2 }, "tp", /нижче входу/],
  [{ deposit: 1000, risk: 1, stop_mode: "pips", stop: 20, leverage: "0,5" }, "leverage", /плече/],
  [{ deposit: 1000, risk: 1, stop_mode: "pips", stop: 20, entry: "abc" }, "entry", /Ціна входу/],
  [{ deposit: 1000, risk: 1, stop_mode: "pips", stop: 20, acc_ccy: "EUR", rate: "-2" }, "rate", /більше нуля/],
]) { const res = C.sizeLots(inp, EUR); ok(!res.ok && res.errors[field] && re.test(res.errors[field]) && res.result === null, `помилка поля ${field}: ${JSON.stringify(res.errors)}`); }
eq(C.sizeLots({ deposit: 1000, risk: 1, entry: 1.1, stop_mode: "pips", stop: 20, leverage: "1:100" }, EUR).result.margin, 55, "плече у вигляді 1:100");

console.log(`Перевірок: ${total}, провалів: ${failed}`);
process.exit(failed ? 1 : 0);
