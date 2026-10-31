/* Калькулятори трейдера (крім калькулятора лотів, він у jl-calc.js). Кожен калькулятор це опис: поля форми (fields), чиста функція
   розрахунку compute(v, ctx) і функція показу view(res, F, ctx). Інтерфейс (js/jr-calc.js) будує форму з опису, тому тут немає DOM.

   v    значення полів як рядки (так, як у полях вводу); для полів, прив'язаних до налаштувань, туди вже підставлено збережене
   ctx  {asset, acc, needRate}: вибраний актив, валюта рахунку, чи потрібен курс до валюти котирування
   compute повертає {ok:false, missing:[ключі], errors:{ключ:текст}} або {ok:true, ...числа}
   view   повертає {big, tiles, tables, warnings, note}; F це форматувальники інтерфейсу (F.n, F.n2, F.pct, F.sgn, F.px, F.cur)
   Усе це перевіряє tests/calc-tools.test.js. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { parseNum } = JL.calc;

  const GROUPS = [["risk", "Позиція й ризик"], ["fut", "Ф'ючерси й крипта"], ["stat", "Облік і статистика"]];

  // ---------------------------------------------------------------- читання полів
  /** Збирає числа з полів і помилки. num(ключ, назва, {req, pos, min, max, int}) повертає число або undefined. */
  function reader(v) {
    const missing = [], errors = {};
    const num = (key, label, o = {}) => {
      const n = parseNum(v[key]);
      if (n === undefined) { if (o.req) missing.push(key); return undefined; }
      if (!Number.isFinite(n)) { errors[key] = `${label}: потрібне число.`; return undefined; }
      if (o.pos && n <= 0) { errors[key] = `${label}: число більше нуля.`; return undefined; }
      if (o.min != null && n < o.min) { errors[key] = `${label}: не менше ${o.min}.`; return undefined; }
      if (o.max != null && n > o.max) { errors[key] = `${label}: не більше ${o.max}.`; return undefined; }
      if (o.int && !Number.isInteger(n)) { errors[key] = `${label}: ціле число.`; return undefined; }
      return n;
    };
    return { missing, errors, num, err: (k, m) => { errors[k] = m; },
      bad: () => missing.length > 0 || Object.keys(errors).length > 0,
      fail: () => ({ ok: false, missing: [...new Set(missing)].filter((k) => !errors[k]), errors }) };
  }
  const r10 = (x) => Math.round(x * 1e10) / 1e10;
  const sgnOf = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
  const isLong = (v) => v.dir !== "short";
  const DIR = { key: "dir", label: "Напрямок", kind: "seg", options: [["long", "Лонг"], ["short", "Шорт"]], def: "long", wide: true };
  const ok = (o) => ({ ok: true, ...o });
  const clean = (a) => a.filter(Boolean);
  const pctl = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

  /** Ціна ліквідації ізольованої лінійної (USDT) позиції без урахування комісій: формула біржі з нульовою додатковою сумою.
      extra = додана маржа / номінал. */
  function liqPrice(long, entry, lev, mmr, extra = 0) {
    return Math.max(0, long ? (entry * (1 - 1 / lev - extra)) / (1 - mmr) : (entry * (1 + 1 / lev + extra)) / (1 + mmr));
  }
  /** Найбільше плече, при якому ліквідація ще не ближче за стоп. */
  function maxLevForStop(long, entry, stop, mmr) {
    const d = long ? 1 - (stop * (1 - mmr)) / entry : (stop * (1 + mmr)) / entry - 1;
    return d > 0 ? 1 / d : null;
  }

  // ---------------------------------------------------------------- 1. R:R
  const rr = {
    id: "rr", group: "risk", title: "Ризик / прибуток (R:R)", hint: "відношення тейків до стопу",
    intro: "Скільки R дає кожен тейк і який winrate потрібен, щоб вийти в нуль.",
    fields: [DIR,
      { key: "entry", label: "Ціна входу", kind: "num", ph: "Наприклад 1,0850" },
      { key: "stop", label: "Стоп (ціна)", kind: "num", ph: "Наприклад 1,0830" },
      { key: "tp1", label: "Тейк 1 (ціна)", kind: "num", ph: "Наприклад 1,0910" },
      { key: "tp2", label: "Тейк 2 (необов'язково)", kind: "num" },
      { key: "tp3", label: "Тейк 3 (необов'язково)", kind: "num", show: (v) => !!String(v.tp2 || "").trim() },
      { key: "risk_money", label: "Ризик у грошах (необов'язково)", kind: "num", hint: "Тоді в таблиці буде прибуток у грошах для кожного тейку." }],
    compute(v) {
      const r = reader(v);
      const entry = r.num("entry", "Ціна входу", { req: 1, pos: 1 }), stop = r.num("stop", "Стоп", { req: 1, pos: 1 });
      const tps = [["tp1", 1], ["tp2", 0], ["tp3", 0]].map(([k, req], i) => [k, r.num(k, `Тейк ${i + 1}`, { req, pos: 1 })]).filter(([, x]) => x !== undefined);
      const risk = r.num("risk_money", "Ризик", { pos: 1 });
      if (r.bad()) return r.fail();
      const long = isLong(v);
      if (long ? stop >= entry : stop <= entry) r.err("stop", long ? "Для лонга стоп має бути нижче входу." : "Для шорта стоп має бути вище входу.");
      for (const [k, x] of tps) if (long ? x <= entry : x >= entry) r.err(k, long ? "Для лонга тейк має бути вище входу." : "Для шорта тейк має бути нижче входу.");
      if (r.bad()) return r.fail();
      const sd = r10(Math.abs(entry - stop));
      const rows = tps.map(([k, x], i) => { const d = r10(Math.abs(x - entry)); const rr_ = d / sd; return { n: i + 1, price: x, dist: d, pct: (d / entry) * 100, r: rr_, money: risk ? rr_ * risk : null, be: 100 / (1 + rr_) }; });
      return ok({ sd, sd_pct: (sd / entry) * 100, rows, risk_money: risk || null });
    },
    view(x, F) {
      const t = x.rows[0];
      return { big: { label: "R:R до тейку 1", value: `1 : ${F.n(t.r, 2)}`, hint: `стоп ${F.px(x.sd)} · ${F.n(x.sd_pct, 2)}% від входу` },
        tiles: clean([{ id: "stop", label: "Відстань до стопу", value: F.px(x.sd), hint: `${F.n(x.sd_pct, 2)}% від ціни входу` },
          { id: "be", label: "Беззбитковий winrate", value: F.pct(t.be, 1), hint: "для тейку 1, без комісій" },
          x.risk_money ? { id: "risk", label: "Ризик", value: F.n2(x.risk_money), hint: "1 R" } : null]),
        tables: [{ id: "tps", title: "Тейки", head: ["Тейк", "Ціна", "Відстань", "% від входу", "R", "Прибуток", "Беззбитковий winrate"],
          rows: x.rows.map((q) => [`№${q.n}`, F.px(q.price), F.px(q.dist), F.pct(q.pct, 2), `+${F.n(q.r, 2)} R`, q.money != null ? F.sgn(q.money, 2) : "—", F.pct(q.be, 1)]) }],
        note: "Беззбитковий winrate = 1 ÷ (1 + R): частка прибуткових угод, при якій результат нульовий, якщо кожна закривається на цьому тейку." };
    },
  };

  // ---------------------------------------------------------------- 2. Частковий вихід
  const partial = {
    id: "partial", group: "risk", title: "Частковий вихід і зсув стопу", hint: "що дасть закриття частини на тейку",
    intro: "Закриваєш частину позиції на першому тейку, стоп переносиш (або ні). Тут видно результат у R у кожному сценарії.",
    fields: [DIR,
      { key: "entry", label: "Ціна входу", kind: "num" },
      { key: "stop", label: "Стоп (ціна)", kind: "num" },
      { key: "tp1", label: "Тейк 1 (ціна)", kind: "num" },
      { key: "share1", label: "Частка, що закривається на тейку 1, %", kind: "num", def: "50", keep: true },
      { key: "tp2", label: "Тейк 2 для решти (необов'язково)", kind: "num" },
      { key: "move", label: "Стоп для решти після тейку 1", kind: "seg", options: [["none", "Без зміни"], ["be", "У беззбиток"], ["price", "На ціну"]], def: "be", keep: true, wide: true },
      { key: "stop2", label: "Новий стоп (ціна)", kind: "num", show: (v) => v.move === "price" },
      { key: "risk_money", label: "Ризик у грошах (необов'язково)", kind: "num" }],
    compute(v) {
      const r = reader(v);
      const entry = r.num("entry", "Ціна входу", { req: 1, pos: 1 }), stop = r.num("stop", "Стоп", { req: 1, pos: 1 }), tp1 = r.num("tp1", "Тейк 1", { req: 1, pos: 1 });
      const share = r.num("share1", "Частка", { req: 1, min: 1, max: 99 }), tp2 = r.num("tp2", "Тейк 2", { pos: 1 });
      const move = ["none", "be", "price"].includes(v.move) ? v.move : "be";
      const stop2 = move === "price" ? r.num("stop2", "Новий стоп", { req: 1, pos: 1 }) : undefined;
      const risk = r.num("risk_money", "Ризик", { pos: 1 });
      if (r.bad()) return r.fail();
      const long = isLong(v), s = long ? 1 : -1;
      if (long ? stop >= entry : stop <= entry) r.err("stop", long ? "Для лонга стоп має бути нижче входу." : "Для шорта стоп має бути вище входу.");
      if (long ? tp1 <= entry : tp1 >= entry) r.err("tp1", long ? "Для лонга тейк має бути вище входу." : "Для шорта тейк має бути нижче входу.");
      if (tp2 !== undefined && (long ? tp2 <= tp1 : tp2 >= tp1)) r.err("tp2", "Тейк 2 має бути далі від входу, ніж тейк 1.");
      if (stop2 !== undefined && (long ? stop2 >= tp1 : stop2 <= tp1)) r.err("stop2", "Новий стоп має бути з боку входу від тейку 1.");
      if (r.bad()) return r.fail();
      const sd = r10(Math.abs(entry - stop)), f = share / 100;
      const R = (p) => ((p - entry) * s) / sd;
      const rm = move === "none" ? -1 : move === "be" ? 0 : R(stop2);
      const sc = [{ id: "stop", label: "Стоп до тейку 1", r: -1 },
        { id: "tp1stop", label: `Тейк 1, решта по ${move === "none" ? "початковому стопу" : move === "be" ? "беззбитку" : "новому стопу"}`, r: f * R(tp1) + (1 - f) * rm }];
      if (tp2 !== undefined) sc.push({ id: "tp12", label: "Тейк 1 і тейк 2", r: f * R(tp1) + (1 - f) * R(tp2) });
      return ok({ sd, r1: R(tp1), r2: tp2 !== undefined ? R(tp2) : null, rm, share, scenarios: sc.map((q) => ({ ...q, money: risk ? q.r * risk : null })), risk_money: risk || null });
    },
    view(x, F) {
      const best = x.scenarios[x.scenarios.length - 1];
      return { big: { label: best.label, value: `${F.sgn(best.r, 2)} R`, hint: `тейк 1 дає ${F.sgn(x.r1, 2)} R${x.r2 != null ? `, тейк 2 дає ${F.sgn(x.r2, 2)} R` : ""}` },
        tiles: x.scenarios.slice(0, -1).map((q) => ({ id: q.id, label: q.label, value: `${F.sgn(q.r, 2)} R`, hint: q.money != null ? `${F.sgn(q.money, 2)} у грошах` : "", sign: sgnOf(q.r) })),
        note: "Результат у R враховує частку, яка закрита на кожному рівні. Комісії й прослизання не враховано." };
    },
  };

  // ---------------------------------------------------------------- 3. Усереднення
  const pairFields = [];
  for (let i = 1; i <= 5; i++) {
    const prev = i === 1 ? null : (v) => ["p", "q"].some((k) => String(v[`${k}${i - 1}`] || "").trim());
    pairFields.push({ key: `p${i}`, label: `Ціна покупки ${i}`, kind: "num", show: i <= 2 ? null : prev }, { key: `q${i}`, label: `Кількість ${i}`, kind: "num", show: i <= 2 ? null : prev });
  }
  const avg = {
    id: "avg", group: "risk", title: "Усереднення позиції", hint: "середня ціна входу після докупівель",
    intro: "Середня ціна всіх входів, результат при поточній ціні й скільки докупити, щоб вийти на потрібну середню.",
    fields: [DIR, ...pairFields,
      { key: "cur", label: "Поточна ціна (необов'язково)", kind: "num", heading: "Результат" },
      { key: "tgt", label: "Цільовий прибуток, % (необов'язково)", kind: "num" },
      { key: "add_price", label: "Ціна докупівлі", kind: "num", heading: "Скільки докупити" },
      { key: "want", label: "Бажана середня ціна", kind: "num" }],
    compute(v) {
      const r = reader(v);
      const rows = [];
      for (let i = 1; i <= 5; i++) {
        const p = r.num(`p${i}`, `Ціна покупки ${i}`, { req: i === 1, pos: 1 }), q = r.num(`q${i}`, `Кількість ${i}`, { req: i === 1, pos: 1 });
        if (p !== undefined && q === undefined && i > 1 && !r.errors[`q${i}`]) r.missing.push(`q${i}`);
        if (q !== undefined && p === undefined && i > 1 && !r.errors[`p${i}`]) r.missing.push(`p${i}`);
        if (p !== undefined && q !== undefined) rows.push([p, q]);
      }
      const cur = r.num("cur", "Поточна ціна", { pos: 1 }), tgt = r.num("tgt", "Цільовий прибуток", { pos: 1 });
      const addP = r.num("add_price", "Ціна докупівлі", { pos: 1 }), want = r.num("want", "Бажана середня", { pos: 1 });
      if (addP !== undefined && want === undefined) r.missing.push("want");
      if (want !== undefined && addP === undefined) r.missing.push("add_price");
      if (r.bad()) return r.fail();
      const s = isLong(v) ? 1 : -1;
      const Q = rows.reduce((a, [, q]) => a + q, 0), cost = rows.reduce((a, [p, q]) => a + p * q, 0), A = cost / Q;
      const out = { qty: Q, cost, avg: A, n: rows.length, mean: rows.reduce((a, [p]) => a + p, 0) / rows.length };
      if (cur !== undefined) { out.cur = cur; out.pnl = (cur - A) * Q * s; out.pnl_pct = (cur / A - 1) * 100 * s; }
      if (tgt !== undefined) out.target_price = A * (1 + (s * tgt) / 100);
      if (want !== undefined) {
        const d = want - addP;
        if (d === 0 || (A - want) * d <= 0) { r.err("want", "Бажана середня має лежати між поточною середньою та ціною докупівлі."); return r.fail(); }
        const x = (Q * (A - want)) / d;
        out.add_qty = x; out.add_cost = x * addP; out.new_qty = Q + x; out.want = want;
      }
      return ok(out);
    },
    view(x, F) {
      return { big: { label: "Середня ціна входу", value: F.px(x.avg), hint: `${F.n(x.qty, 8)} разом · вкладено ${F.n2(x.cost)}` },
        tiles: clean([{ id: "qty", label: "Загальна кількість", value: F.n(x.qty, 8), hint: `${x.n} ${x.n === 1 ? "вхід" : "входи"}` },
          { id: "cost", label: "Вкладено", value: F.n2(x.cost) },
          x.pnl != null ? { id: "pnl", label: "Результат при поточній ціні", value: F.sgn(x.pnl, 2), hint: `${F.sgn(x.pnl_pct, 2)}% від середньої`, sign: sgnOf(x.pnl) } : null,
          x.target_price != null ? { id: "target", label: "Ціна для цільового прибутку", value: F.px(x.target_price) } : null,
          x.add_qty != null ? { id: "add", label: "Докупити", value: F.n(x.add_qty, 8), hint: `на ${F.n2(x.add_cost)}, разом ${F.n(x.new_qty, 8)} зі середньою ${F.px(x.want)}` } : null]),
        note: "Кількість можна вводити в будь-яких одиницях: лотах, монетах, акціях. Комісії не враховано." };
    },
  };

  // ---------------------------------------------------------------- 4. Вартість пункту
  const pipv = {
    id: "pipv", group: "risk", title: "Вартість пункту", hint: "пункти й гроші для активу",
    intro: "Скільки коштує один пункт для вибраного активу й лота, і скільки це в грошах (або навпаки).",
    fields: [{ key: "asset", label: "Актив", kind: "asset" },
      { key: "lots", label: "Лот", kind: "num", ph: "Наприклад 0,5" },
      { key: "pips", label: "Рух у пунктах (необов'язково)", kind: "num", hint: "Покаже, скільки це в грошах." },
      { key: "money", label: "Сума в грошах (необов'язково)", kind: "num", hint: "Покаже, скільки це пунктів." },
      { key: "acc_ccy", label: "Валюта рахунку", kind: "ccy", pref: "acc_ccy" },
      { key: "rate", label: (v, ctx) => `Курс: 1 ${ctx.asset ? ctx.asset.quote_ccy : ""} = ? ${ctx.acc}`, kind: "num", pref: "rate", show: (v, ctx) => ctx.needRate }],
    compute(v, ctx) {
      const r = reader(v);
      if (!ctx.asset) return { ok: false, missing: ["asset"], errors: {} };
      const lots = r.num("lots", "Лот", { req: 1, pos: 1 }), pips = r.num("pips", "Пункти", { pos: 1 }), money = r.num("money", "Сума", { pos: 1 });
      const rate = ctx.needRate ? r.num("rate", "Курс", { req: 1, pos: 1 }) : 1;
      if (r.bad()) return r.fail();
      const a = ctx.asset, pv = a.pip_size * a.contract_size * rate;
      return ok({ pip_value: pv, pos_value: pv * lots, unit_value: a.contract_size * rate * lots, units: a.contract_size * lots, lots, acc: ctx.acc,
        money_for_pips: pips !== undefined ? pips * pv * lots : null, pips, pips_for_money: money !== undefined ? money / (pv * lots) : null, money, symbol: a.symbol });
    },
    view(x, F) {
      return { big: { label: `Вартість 1 пункту для ${F.n(x.lots, 8)} лота`, value: F.cur(x.pos_value, x.acc), hint: `за 1 лот ${F.cur(x.pip_value, x.acc)}` },
        tiles: clean([{ id: "units", label: "Обсяг", value: F.n(x.units, 8), hint: "одиниць активу" },
          { id: "unit", label: "Зміна ціни на 1,0", value: F.cur(x.unit_value, x.acc), hint: "для цього лота" },
          x.money_for_pips != null ? { id: "mfp", label: `${F.n(x.pips, 4)} пунктів це`, value: F.cur(x.money_for_pips, x.acc) } : null,
          x.pips_for_money != null ? { id: "pfm", label: `${F.cur(x.money, x.acc)} це`, value: `${F.n(x.pips_for_money, 2)} пунктів` } : null]),
        note: "Параметри активу (контракт, пункт) можна змінити під свого брокера кнопкою «Параметри»." };
    },
  };

  // ---------------------------------------------------------------- 5. Ф'ючерсна позиція
  const futures = {
    id: "futures", group: "fut", title: "Ф'ючерсна позиція", hint: "маржа, плече, розмір, ліквідація",
    intro: "Розмір ф'ючерсної (USDT) позиції за маржею, номіналом, кількістю або під заданий ризик, разом із ліквідацією й комісіями.",
    fields: [DIR,
      { key: "entry", label: "Ціна входу", kind: "num", ph: "Наприклад 60000" },
      { key: "lev", label: "Кредитне плече", kind: "num", pref: "leverage", ph: "Наприклад 10", hint: "Достатньо числа: 10 це 10x." },
      { key: "size_mode", label: "Розмір задано", kind: "seg", options: [["margin", "Маржа"], ["notional", "Номінал"], ["qty", "Кількість"], ["risk", "Під ризик"]], def: "margin", keep: true, wide: true },
      { key: "size", label: (v) => (v.size_mode === "notional" ? "Номінал позиції, USDT" : v.size_mode === "qty" ? "Кількість, монет" : "Маржа, USDT"), kind: "num", show: (v) => v.size_mode !== "risk" },
      { key: "risk_mode", label: "Ризик у", kind: "seg", options: [["pct", "% депозиту"], ["money", "Сума"]], def: "pct", keep: true, show: (v) => v.size_mode === "risk" },
      { key: "risk", label: "Ризик", kind: "num", show: (v) => v.size_mode === "risk", ph: "Наприклад 1" },
      { key: "deposit", label: (v) => (v.size_mode === "risk" && v.risk_mode !== "money" ? "Депозит, USDT" : "Депозит, USDT (необов'язково)"), kind: "num", pref: "deposit" },
      { key: "stop", label: (v) => (v.size_mode === "risk" ? "Стоп (ціна)" : "Стоп (необов'язково)"), kind: "num" },
      { key: "tp", label: "Тейк (необов'язково)", kind: "num" },
      { key: "fee", label: "Комісія біржі, % за сторону", kind: "num", def: "0,05", keep: true, hint: "Тейкер на більшості бірж 0,04–0,06%." },
      { key: "mmr", label: "Підтримуюча маржа, %", kind: "num", def: "0,5", keep: true, hint: "Залежить від розміру позиції на біржі; для невеликих зазвичай 0,4–0,5%." }],
    compute(v) {
      const r = reader(v);
      const mode = ["margin", "notional", "qty", "risk"].includes(v.size_mode) ? v.size_mode : "margin";
      const entry = r.num("entry", "Ціна входу", { req: 1, pos: 1 }), lev = r.num("lev", "Плече", { req: 1, min: 1, max: 1000 });
      const size = mode !== "risk" ? r.num("size", "Розмір", { req: 1, pos: 1 }) : undefined;
      const moneyRisk = v.risk_mode === "money";
      const risk = mode === "risk" ? r.num("risk", "Ризик", { req: 1, pos: 1, max: moneyRisk ? undefined : 100 }) : undefined;
      const dep = r.num("deposit", "Депозит", { pos: 1, req: mode === "risk" && !moneyRisk }), stop = r.num("stop", "Стоп", { pos: 1, req: mode === "risk" }), tp = r.num("tp", "Тейк", { pos: 1 });
      const fee = r.num("fee", "Комісія", { min: 0, max: 5 }), mmrIn = r.num("mmr", "Підтримуюча маржа", { min: 0, max: 50 });
      if (r.bad()) return r.fail();
      const long = isLong(v), f = (fee === undefined ? 0 : fee) / 100, mmr = (mmrIn === undefined ? 0.5 : mmrIn) / 100;
      if (stop !== undefined && (long ? stop >= entry : stop <= entry)) r.err("stop", long ? "Для лонга стоп має бути нижче входу." : "Для шорта стоп має бути вище входу.");
      if (tp !== undefined && (long ? tp <= entry : tp >= entry)) r.err("tp", long ? "Для лонга тейк має бути вище входу." : "Для шорта тейк має бути нижче входу.");
      if (r.bad()) return r.fail();
      let qty, N, M;
      if (mode === "risk") {
        const money = moneyRisk ? risk : (dep * risk) / 100;
        qty = money / (Math.abs(entry - stop) + (entry + stop) * f); N = qty * entry; M = N / lev;
      } else if (mode === "margin") { M = size; N = M * lev; qty = N / entry; }
      else if (mode === "notional") { N = size; qty = N / entry; M = N / lev; }
      else { qty = size; N = qty * entry; M = N / lev; }
      const liq = liqPrice(long, entry, lev, mmr), warnings = [];
      const out = { mode, qty, notional: N, margin: M, margin_pct: dep ? (M / dep) * 100 : null, liq, liq_dist_pct: (Math.abs(entry - liq) / entry) * 100, fee_open: N * f, fee_round: N * f * 2,
        entry, long, lev, mmr: mmr * 100 };
      if (stop !== undefined) {
        out.loss = qty * Math.abs(entry - stop) + qty * (entry + stop) * f; out.loss_pct = dep ? (out.loss / dep) * 100 : null;
        out.max_lev = maxLevForStop(long, entry, stop, mmr);
        if (long ? stop <= liq : stop >= liq) warnings.push(`Стоп лежить за ціною ліквідації (${liq.toFixed(4)}): позицію ліквідує раніше. Зменш плече.`);
      }
      if (tp !== undefined) {
        out.profit = qty * Math.abs(tp - entry) - qty * (entry + tp) * f; out.profit_pct = dep ? (out.profit / dep) * 100 : null;
        if (stop !== undefined) out.rr = Math.abs(tp - entry) / Math.abs(entry - stop);
      }
      if (dep && M > dep) warnings.push(`Не вистачає маржі: потрібно ${M.toFixed(2)}, на рахунку ${dep.toFixed(2)}.`);
      return ok({ ...out, warnings });
    },
    view(x, F) {
      return { big: { label: "Кількість", value: F.n(x.qty, 8), hint: `номінал ${F.n2(x.notional)} USDT · маржа ${F.n2(x.margin)} USDT` },
        warnings: x.warnings,
        tiles: clean([{ id: "notional", label: "Номінал", value: `${F.n2(x.notional)} USDT`, hint: `плече ${F.n(x.lev, 2)}x` },
          { id: "margin", label: "Маржа", value: `${F.n2(x.margin)} USDT`, hint: x.margin_pct != null ? `${F.n(x.margin_pct, 1)}% депозиту` : "потрібно для відкриття" },
          { id: "liq", label: "Ціна ліквідації", value: F.px(x.liq), hint: `${F.n(x.liq_dist_pct, 2)}% від входу, орієнтовно` },
          { id: "fee", label: "Комісія вхід + вихід", value: `${F.n2(x.fee_round)} USDT`, hint: `на вході ${F.n2(x.fee_open)}` },
          x.loss != null ? { id: "loss", label: "Збиток на стопі", value: `−${F.n2(x.loss)} USDT`, hint: x.loss_pct != null ? `${F.n(x.loss_pct, 2)}% депозиту, з комісіями` : "з комісіями", sign: "neg" } : null,
          x.max_lev != null ? { id: "maxlev", label: "Макс. плече до стопу", value: `${F.n(x.max_lev, 1)}x`, hint: "при більшому плечі ліквідація ближче за стоп" } : null,
          x.profit != null ? { id: "profit", label: "Прибуток на тейку", value: `+${F.n2(x.profit)} USDT`, hint: `${x.profit_pct != null ? `${F.n(x.profit_pct, 2)}% депозиту, ` : ""}з комісіями`, sign: "pos" } : null,
          x.rr != null ? { id: "rr", label: "R:R", value: `1 : ${F.n(x.rr, 2)}` } : null]),
        note: "Ціна ліквідації орієнтовна: це формула ізольованої маржі USDT-ф'ючерсів. Точні цифри залежать від ступенів підтримуючої маржі твоєї біржі й комісій, звір їх на біржі." };
    },
  };

  // ---------------------------------------------------------------- 6. Ціна ліквідації
  const liq = {
    id: "liq", group: "fut", title: "Ціна ліквідації", hint: "ізольована маржа, лонг і шорт",
    intro: "Де ліквідує позицію при заданому плечі, і яке плече безпечне для твого стопу.",
    fields: [DIR,
      { key: "entry", label: "Ціна входу", kind: "num" },
      { key: "lev", label: "Кредитне плече", kind: "num", pref: "leverage" },
      { key: "mmr", label: "Підтримуюча маржа, %", kind: "num", def: "0,5", keep: true },
      { key: "stop", label: "Стоп (необов'язково)", kind: "num", hint: "Покаже максимальне плече, при якому стоп спрацює раніше за ліквідацію." },
      { key: "notional", label: "Номінал позиції, USDT (для додаткової маржі)", kind: "num", heading: "Додаткова маржа" },
      { key: "extra", label: "Додана маржа, USDT", kind: "num" }],
    compute(v) {
      const r = reader(v);
      const entry = r.num("entry", "Ціна входу", { req: 1, pos: 1 }), lev = r.num("lev", "Плече", { req: 1, min: 1, max: 1000 });
      const mmrIn = r.num("mmr", "Підтримуюча маржа", { min: 0, max: 50 }), stop = r.num("stop", "Стоп", { pos: 1 });
      const extra = r.num("extra", "Додана маржа", { pos: 1 }), N = r.num("notional", "Номінал", { pos: 1, req: extra !== undefined });
      if (r.bad()) return r.fail();
      const long = isLong(v), mmr = (mmrIn === undefined ? 0.5 : mmrIn) / 100;
      if (stop !== undefined && (long ? stop >= entry : stop <= entry)) r.err("stop", long ? "Для лонга стоп має бути нижче входу." : "Для шорта стоп має бути вище входу.");
      if (r.bad()) return r.fail();
      const ex = extra !== undefined ? extra / N : 0;
      const p = liqPrice(long, entry, lev, mmr, ex);
      const table = [2, 3, 5, 10, 20, 50, 100].map((l) => { const q = liqPrice(long, entry, l, mmr, ex); return { lev: l, price: q, dist: (Math.abs(entry - q) / entry) * 100 }; });
      const out = { liq: p, dist: Math.abs(entry - p), dist_pct: (Math.abs(entry - p) / entry) * 100, table, long, no_liq: long && p === 0, max_lev: stop !== undefined ? maxLevForStop(long, entry, stop, mmr) : null, lev, stop: stop === undefined ? null : stop };
      out.warn_stop = stop !== undefined && (long ? stop <= p : stop >= p);
      return ok(out);
    },
    view(x, F) {
      return { big: { label: x.long ? "Ціна ліквідації лонга" : "Ціна ліквідації шорта", value: x.no_liq ? "немає" : F.px(x.liq), hint: x.no_liq ? "при плечі 1x лонг не ліквідується" : `${F.n(x.dist_pct, 2)}% від входу (${F.px(x.dist)})` },
        warnings: x.warn_stop ? [`Стоп (${F.px(x.stop)}) лежить за ціною ліквідації: позицію ліквідує раніше. Зменш плече.`] : [],
        tiles: clean([x.max_lev != null ? { id: "maxlev", label: "Макс. плече до стопу", value: `${F.n(x.max_lev, 1)}x`, hint: "при більшому плечі ліквідація ближче за стоп" } : null]),
        tables: [{ id: "levs", title: "Ліквідація при різному плечі", head: ["Плече", "Ціна ліквідації", "Відстань від входу"], rows: x.table.map((q) => [`${q.lev}x`, F.px(q.price), F.pct(q.dist, 2)]) }],
        note: "Формула ізольованої маржі USDT-ф'ючерсів без комісій. Біржі застосовують ступені підтримуючої маржі залежно від розміру позиції, тому точну ціну дивись на біржі." };
    },
  };

  // ---------------------------------------------------------------- 7. PnL і ROE
  const pnl = {
    id: "pnl", group: "fut", title: "Прибуток і ROE", hint: "результат позиції у грошах і % маржі",
    intro: "Прибуток або збиток позиції з комісіями, зміна ціни й ROE від маржі.",
    fields: [DIR,
      { key: "entry", label: "Ціна входу", kind: "num" },
      { key: "exit", label: "Ціна виходу", kind: "num" },
      { key: "size_mode", label: "Розмір задано", kind: "seg", options: [["qty", "Кількість"], ["notional", "Номінал"], ["margin", "Маржа"]], def: "qty", keep: true, wide: true },
      { key: "size", label: (v) => (v.size_mode === "notional" ? "Номінал, USDT" : v.size_mode === "margin" ? "Маржа, USDT" : "Кількість, монет"), kind: "num" },
      { key: "lev", label: (v) => (v.size_mode === "margin" ? "Кредитне плече" : "Кредитне плече (для ROE)"), kind: "num", pref: "leverage" },
      { key: "fee_in", label: "Комісія входу, %", kind: "num", def: "0,05", keep: true },
      { key: "fee_out", label: "Комісія виходу, %", kind: "num", def: "0,05", keep: true }],
    compute(v) {
      const r = reader(v);
      const mode = ["qty", "notional", "margin"].includes(v.size_mode) ? v.size_mode : "qty";
      const entry = r.num("entry", "Ціна входу", { req: 1, pos: 1 }), exit = r.num("exit", "Ціна виходу", { req: 1, pos: 1 }), size = r.num("size", "Розмір", { req: 1, pos: 1 });
      const lev = r.num("lev", "Плече", { req: mode === "margin", min: 1, max: 1000 });
      const fin = r.num("fee_in", "Комісія входу", { min: 0, max: 5 }), fout = r.num("fee_out", "Комісія виходу", { min: 0, max: 5 });
      if (r.bad()) return r.fail();
      const s = isLong(v) ? 1 : -1;
      let qty, N, M = null;
      if (mode === "qty") { qty = size; N = qty * entry; } else if (mode === "notional") { N = size; qty = N / entry; } else { M = size; N = M * lev; qty = N / entry; }
      if (M == null && lev !== undefined) M = N / lev;
      const gross = (exit - entry) * qty * s, fees = qty * entry * ((fin || 0) / 100) + qty * exit * ((fout || 0) / 100), net = gross - fees;
      return ok({ qty, notional: N, margin: M, gross, fees, net, change_pct: (exit / entry - 1) * 100 * s, roe: M ? (net / M) * 100 : null, roe_gross: M ? (gross / M) * 100 : null, net_pct: (net / N) * 100 });
    },
    view(x, F) {
      return { big: { label: "Чистий результат", value: `${F.sgn(x.net, 2)} USDT`, hint: x.roe != null ? `ROE ${F.sgn(x.roe, 2)}% від маржі` : `${F.sgn(x.net_pct, 2)}% від номіналу` },
        tiles: clean([{ id: "gross", label: "Результат без комісій", value: `${F.sgn(x.gross, 2)} USDT`, sign: sgnOf(x.gross) },
          { id: "fees", label: "Комісії", value: `${F.n2(x.fees)} USDT`, hint: "вхід і вихід" },
          { id: "change", label: "Зміна ціни", value: F.pct(x.change_pct, 2), hint: "у твою сторону", sign: sgnOf(x.change_pct) },
          x.roe != null ? { id: "roe", label: "ROE", value: `${F.sgn(x.roe, 2)}%`, hint: `маржа ${F.n2(x.margin)} USDT`, sign: sgnOf(x.roe) } : null,
          { id: "size", label: "Позиція", value: `${F.n(x.qty, 8)}`, hint: `номінал ${F.n2(x.notional)} USDT` }]) };
    },
  };

  // ---------------------------------------------------------------- 8. Комісії
  const fees = {
    id: "fees", group: "fut", title: "Комісії біржі", hint: "скільки забирають мейкер і тейкер",
    intro: "Скільки коштує вхід і вихід, на скільки має піти ціна, щоб покрити комісії, і яка різниця між мейкером і тейкером.",
    fields: [{ key: "notional", label: "Номінал позиції, USDT", kind: "num", ph: "Наприклад 10000" },
      { key: "maker", label: "Мейкер, %", kind: "num", def: "0,02", keep: true },
      { key: "taker", label: "Тейкер, %", kind: "num", def: "0,05", keep: true },
      { key: "entry_type", label: "Вхід", kind: "seg", options: [["maker", "Мейкер"], ["taker", "Тейкер"]], def: "taker", keep: true },
      { key: "exit_type", label: "Вихід", kind: "seg", options: [["maker", "Мейкер"], ["taker", "Тейкер"]], def: "taker", keep: true },
      { key: "discount", label: "Знижка на комісію, %", kind: "num", def: "0", keep: true, hint: "Наприклад 10% за оплату комісії токеном біржі." },
      { key: "gross", label: "Результат без комісій (необов'язково)", kind: "num", hint: "Прибуток або збиток угоди, щоб побачити частку комісій." },
      { key: "lev", label: "Кредитне плече (необов'язково)", kind: "num", pref: "leverage" },
      { key: "trades", label: "Угод на місяць (необов'язково)", kind: "num", hint: "Покаже, скільки комісій на місяць." }],
    compute(v) {
      const r = reader(v);
      const N = r.num("notional", "Номінал", { req: 1, pos: 1 }), maker = r.num("maker", "Мейкер", { min: 0, max: 5 }), taker = r.num("taker", "Тейкер", { min: 0, max: 5 });
      const disc = r.num("discount", "Знижка", { min: 0, max: 100 }), gross = r.num("gross", "Результат без комісій"), lev = r.num("lev", "Плече", { min: 1, max: 1000 });
      const trades = r.num("trades", "Угод на місяць", { pos: 1, int: 1 });
      if (r.bad()) return r.fail();
      const mk = (maker === undefined ? 0.02 : maker), tk = (taker === undefined ? 0.05 : taker), k = 1 - (disc || 0) / 100;
      const rate = (t) => (t === "maker" ? mk : tk) * k;
      const rin = rate(v.entry_type === "maker" ? "maker" : "taker"), rout = rate(v.exit_type === "maker" ? "maker" : "taker");
      const total = (N * (rin + rout)) / 100;
      const combos = [["maker", "maker"], ["maker", "taker"], ["taker", "maker"], ["taker", "taker"]].map(([a, b]) => ({ a, b, pct: rate(a) + rate(b), money: (N * (rate(a) + rate(b))) / 100 }));
      return ok({ fee_in: (N * rin) / 100, fee_out: (N * rout) / 100, total, total_pct: rin + rout, margin_pct: lev ? (total / (N / lev)) * 100 : null,
        net: gross !== undefined ? gross - total : null, share: gross ? (total / Math.abs(gross)) * 100 : null, month: trades ? total * trades : null, trades, combos, rin, rout });
    },
    view(x, F) {
      const T = { maker: "мейкер", taker: "тейкер" };
      return { big: { label: "Комісії за вхід і вихід", value: `${F.n2(x.total)} USDT`, hint: `${F.n(x.total_pct, 4)}% від номіналу: ціна має пройти стільки, щоб вийти в нуль` },
        tiles: clean([{ id: "in", label: "Вхід", value: `${F.n2(x.fee_in)} USDT`, hint: `${F.n(x.rin, 4)}%` }, { id: "out", label: "Вихід", value: `${F.n2(x.fee_out)} USDT`, hint: `${F.n(x.rout, 4)}%` },
          x.margin_pct != null ? { id: "margin", label: "Від маржі", value: F.pct(x.margin_pct, 2), hint: "частка маржі, яку з'їдають комісії" } : null,
          x.net != null ? { id: "net", label: "Чистий результат", value: `${F.sgn(x.net, 2)} USDT`, hint: x.share != null ? `комісії це ${F.n(x.share, 1)}% від результату` : "", sign: sgnOf(x.net) } : null,
          x.month != null ? { id: "month", label: `Комісії за місяць (${x.trades} угод)`, value: `${F.n2(x.month)} USDT` } : null]),
        tables: [{ id: "combos", title: "Мейкер чи тейкер", head: ["Вхід", "Вихід", "Разом, %", "Разом, USDT"], rows: x.combos.map((q) => [T[q.a], T[q.b], F.pct(q.pct, 4), F.n2(q.money)]) }],
        note: "Вихід рахується від того самого номіналу, що й вхід. Для точності на виході врахуй зміну ціни." };
    },
  };

  // ---------------------------------------------------------------- 9. Фандинг
  const funding = {
    id: "funding", group: "fut", title: "Фандинг", hint: "скільки платиш або отримуєш за утримання",
    intro: "Вартість фандингу безстрокового ф'ючерса за час утримання позиції. Додатна ставка: лонги платять шортам.",
    fields: [DIR,
      { key: "notional", label: "Номінал позиції, USDT", kind: "num" },
      { key: "rate", label: "Ставка фандингу, % за період", kind: "num", ph: "Наприклад 0,01" },
      { key: "interval", label: "Період виплати", kind: "seg", options: [["8", "8 год"], ["4", "4 год"], ["1", "1 год"]], def: "8", keep: true },
      { key: "hold", label: "Час утримання", kind: "num", ph: "Наприклад 3" },
      { key: "unit", label: "Одиниця", kind: "seg", options: [["h", "годин"], ["d", "днів"]], def: "d", keep: true },
      { key: "lev", label: "Кредитне плече (необов'язково)", kind: "num", pref: "leverage" }],
    compute(v) {
      const r = reader(v);
      const N = r.num("notional", "Номінал", { req: 1, pos: 1 }), rate = r.num("rate", "Ставка", { req: 1, min: -5, max: 5 }), hold = r.num("hold", "Час утримання", { req: 1, pos: 1 });
      const lev = r.num("lev", "Плече", { min: 1, max: 1000 });
      if (r.bad()) return r.fail();
      const per = ["8", "4", "1"].includes(v.interval) ? Number(v.interval) : 8, hours = hold * (v.unit === "d" ? 24 : 1), periods = hours / per, s = isLong(v) ? 1 : -1;
      const one = (s * N * rate) / 100, day = one * (24 / per);
      return ok({ periods, per, one, day, month: day * 30, total: one * periods, apr: s * rate * (24 / per) * 365, move_pct: (one * periods / N) * 100, margin_pct: lev ? (Math.abs(one * periods) / (N / lev)) * 100 : null, pays: one * periods > 0 });
    },
    view(x, F) {
      const sign = (n) => (n > 0 ? "neg" : n < 0 ? "pos" : "");
      return { big: { label: x.total === 0 ? "Фандинг" : x.pays ? "Ти платиш" : "Ти отримуєш", value: `${F.n2(Math.abs(x.total))} USDT`, hint: `${F.n(x.periods, 2)} періодів по ${x.per} год` },
        tiles: clean([{ id: "one", label: "За один період", value: `${x.one > 0 ? "−" : x.one < 0 ? "+" : ""}${F.n(Math.abs(x.one), 4)} USDT`, sign: sign(x.one) },
          { id: "day", label: "За добу", value: `${x.day > 0 ? "−" : x.day < 0 ? "+" : ""}${F.n2(Math.abs(x.day))} USDT`, sign: sign(x.day) },
          { id: "month", label: "За 30 днів", value: `${x.month > 0 ? "−" : x.month < 0 ? "+" : ""}${F.n2(Math.abs(x.month))} USDT`, sign: sign(x.month) },
          { id: "apr", label: "У річних", value: F.pct(Math.abs(x.apr), 1), hint: x.apr > 0 ? "витрати за твоєю стороною" : x.apr < 0 ? "дохід за твоєю стороною" : "" },
          { id: "move", label: "Ціна має пройти", value: F.pct(Math.abs(x.move_pct), 3), hint: x.pays ? "щоб покрити фандинг" : "ти ще й заробляєш на фандингу" },
          x.margin_pct != null ? { id: "margin", label: "Від маржі", value: F.pct(x.margin_pct, 2) } : null]),
        note: "Орієнтовно: ставка фандингу змінюється, а фандинг стягується лише в моменти виплат. Кількість періодів тут пропорційна часу." };
    },
  };

  // ---------------------------------------------------------------- 10. Беззбиткова ціна
  const breakeven = {
    id: "breakeven", group: "fut", title: "Беззбиткова ціна", hint: "з комісіями й фандингом",
    intro: "Ціна, де позиція виходить у нуль після комісій на вході, виході та фандингу.",
    fields: [DIR,
      { key: "entry", label: "Ціна входу", kind: "num" },
      { key: "fee_in", label: "Комісія входу, %", kind: "num", def: "0,05", keep: true },
      { key: "fee_out", label: "Комісія виходу, %", kind: "num", def: "0,05", keep: true },
      { key: "funding", label: "Фандинг, % номіналу (необов'язково)", kind: "num", hint: "Сплачений або очікуваний за весь час. Додатне число це витрати, від'ємне це дохід." },
      { key: "lev", label: "Кредитне плече (необов'язково)", kind: "num", pref: "leverage" }],
    compute(v) {
      const r = reader(v);
      const entry = r.num("entry", "Ціна входу", { req: 1, pos: 1 }), fin = r.num("fee_in", "Комісія входу", { min: 0, max: 5 }), fout = r.num("fee_out", "Комісія виходу", { min: 0, max: 5 });
      const fund = r.num("funding", "Фандинг", { min: -100, max: 100 }), lev = r.num("lev", "Плече", { min: 1, max: 1000 });
      if (r.bad()) return r.fail();
      const a = (fin || 0) / 100, b = (fout || 0) / 100, c = (fund || 0) / 100, long = isLong(v);
      if (!long && 1 - a - c <= 0) { r.err("funding", "Витрати перевищують 100% номіналу."); return r.fail(); }
      const be = long ? (entry * (1 + a + c)) / (1 - b) : (entry * (1 - a - c)) / (1 + b);
      const d = Math.abs(be - entry), pct = (d / entry) * 100;
      return ok({ be, dist: d, pct, margin_pct: lev ? pct * lev : null, long });
    },
    view(x, F) {
      return { big: { label: "Беззбиткова ціна", value: F.px(x.be), hint: `${x.long ? "вище" : "нижче"} входу на ${F.px(x.dist)} (${F.n(x.pct, 4)}%)` },
        tiles: clean([{ id: "pct", label: "Рух до беззбитку", value: F.pct(x.pct, 4) }, x.margin_pct != null ? { id: "margin", label: "Від маржі", value: F.pct(x.margin_pct, 2), hint: "з плечем" } : null]),
        note: "Комісія виходу береться від ціни виходу, тому беззбиток трохи більший за просту суму відсотків." };
    },
  };

  // ---------------------------------------------------------------- 11. Спот
  const spot = {
    id: "spot", group: "fut", title: "Спот: вхід і прибуток", hint: "покупка монети, ціна виходу, комісія",
    intro: "Скільки монет отримаєш за суму, при якій ціні вийдеш у нуль, що дасть ціна продажу й яка ціна потрібна для цілі.",
    fields: [{ key: "mode", label: "Розмір задано", kind: "seg", options: [["amount", "Сума"], ["qty", "Кількість монет"]], def: "amount", keep: true, wide: true },
      { key: "size", label: (v) => (v.mode === "qty" ? "Кількість монет (після комісії)" : "Сума покупки, USDT"), kind: "num" },
      { key: "buy", label: "Ціна покупки", kind: "num" },
      { key: "fee", label: "Комісія біржі, % за угоду", kind: "num", def: "0,1", keep: true },
      { key: "sell", label: "Ціна продажу (необов'язково)", kind: "num" },
      { key: "target", label: "Цільовий прибуток, % (необов'язково)", kind: "num" }],
    compute(v) {
      const r = reader(v);
      const size = r.num("size", "Розмір", { req: 1, pos: 1 }), buy = r.num("buy", "Ціна покупки", { req: 1, pos: 1 }), fee = r.num("fee", "Комісія", { min: 0, max: 50 });
      const sell = r.num("sell", "Ціна продажу", { pos: 1 }), target = r.num("target", "Цільовий прибуток", { pos: 1 });
      if (r.bad()) return r.fail();
      const f = (fee === undefined ? 0.1 : fee) / 100;
      const qty = v.mode === "qty";
      const coins = qty ? size : (size / buy) * (1 - f), spent = qty ? (size * buy) / (1 - f) : size;
      const out = { coins, spent, eff_price: spent / coins, be_price: spent / (coins * (1 - f)) };
      if (sell !== undefined) { out.proceeds = coins * sell * (1 - f); out.pnl = out.proceeds - spent; out.roi = (out.pnl / spent) * 100; }
      if (target !== undefined) out.target_price = (spent * (1 + target / 100)) / (coins * (1 - f));
      return ok(out);
    },
    view(x, F) {
      return { big: { label: "Монет отримаєш", value: F.n(x.coins, 8), hint: `витрачено ${F.n2(x.spent)} USDT · реальна ціна входу ${F.px(x.eff_price)}` },
        tiles: clean([{ id: "be", label: "Беззбиткова ціна продажу", value: F.px(x.be_price), hint: "з комісіями за покупку й продаж" },
          x.pnl != null ? { id: "pnl", label: "Результат при продажу", value: `${F.sgn(x.pnl, 2)} USDT`, hint: `${F.sgn(x.roi, 2)}%, виручка ${F.n2(x.proceeds)}`, sign: sgnOf(x.pnl) } : null,
          x.target_price != null ? { id: "target", label: "Ціна для цілі", value: F.px(x.target_price), hint: "продаж з урахуванням комісій" } : null]),
        note: "Комісія знімається за кожну угоду: при купівлі з монет, при продажі з виручки." };
    },
  };

  // ---------------------------------------------------------------- 12. Грид-бот
  const gridLevels = (low, high, n, kind) => {
    const L = [];
    for (let i = 0; i <= n; i++) L.push(kind === "geom" ? low * Math.pow(high / low, i / n) : low + ((high - low) * i) / n);
    return L;
  };
  const grid = {
    id: "grid", group: "fut", title: "Грид-бот", hint: "сітка: крок, прибуток на сітку, капітал",
    intro: "Скільки заробляє одна сітка після комісій і який потрібен капітал на кожну.",
    fields: [{ key: "low", label: "Нижня межа", kind: "num" },
      { key: "high", label: "Верхня межа", kind: "num" },
      { key: "n", label: "Кількість сіток", kind: "num", def: "20", keep: true },
      { key: "invest", label: "Інвестиція, USDT", kind: "num" },
      { key: "kind", label: "Тип сітки", kind: "seg", options: [["arith", "Арифметична"], ["geom", "Геометрична"]], def: "arith", keep: true, wide: true },
      { key: "fee", label: "Комісія біржі, % за угоду", kind: "num", def: "0,1", keep: true }],
    compute(v) {
      const r = reader(v);
      const low = r.num("low", "Нижня межа", { req: 1, pos: 1 }), high = r.num("high", "Верхня межа", { req: 1, pos: 1 }), n = r.num("n", "Кількість сіток", { req: 1, min: 2, max: 500, int: 1 });
      const inv = r.num("invest", "Інвестиція", { req: 1, pos: 1 }), fee = r.num("fee", "Комісія", { min: 0, max: 10 });
      if (r.bad()) return r.fail();
      if (high <= low) { r.err("high", "Верхня межа має бути вищою за нижню."); return r.fail(); }
      const f = (fee === undefined ? 0.1 : fee) / 100, geom = v.kind === "geom", lv = gridLevels(low, high, n, v.kind), amt = inv / n;
      const net = [], gross = [];
      for (let i = 0; i < n; i++) { const g = lv[i + 1] / lv[i]; gross.push((g - 1) * 100); net.push((g * (1 - f) * (1 - f) - 1) * 100); }
      const cycle = net.reduce((a, p) => a + (amt * p) / 100, 0);
      return ok({ step: geom ? null : (high - low) / n, ratio_pct: geom ? (Math.pow(high / low, 1 / n) - 1) * 100 : null, amt, gross_min: Math.min(...gross), gross_max: Math.max(...gross), net_min: Math.min(...net), net_max: Math.max(...net),
        cycle, cycle_pct: (cycle / inv) * 100, n, geom, qty_low: amt / low, spacing_pct: Math.min(...gross) });
    },
    view(x, F) {
      return { big: { label: "Чистий прибуток за повний цикл сіток", value: `${F.sgn(x.cycle, 2)} USDT`, hint: `${F.sgn(x.cycle_pct, 2)}% від інвестиції, коли ціна пройшла всі сітки вгору` },
        warnings: x.net_min <= 0 ? ["Комісії з'їдають прибуток на частині сіток. Зменш кількість сіток або розтягни діапазон."] : [],
        tiles: [x.geom ? { id: "step", label: "Крок між сітками", value: F.pct(x.ratio_pct, 3), hint: "однаковий у відсотках" } : { id: "step", label: "Крок між сітками", value: F.px(x.step), hint: `${F.n(x.gross_min, 2)}–${F.n(x.gross_max, 2)}% залежно від рівня` },
          { id: "net", label: "Прибуток на сітку, чистий", value: Math.abs(x.net_max - x.net_min) < 5e-9 ? F.pct(x.net_max, 3) : `${F.n(x.net_min, 3)}–${F.n(x.net_max, 3)}%`, hint: "після комісій за купівлю й продаж", sign: sgnOf(x.net_min) },
          { id: "amt", label: "Капітал на одну сітку", value: `${F.n2(x.amt)} USDT`, hint: `${x.n} сіток` }],
        note: "Модель спотової сітки: кожна сітка купує на своєму рівні й продає на наступному. Реальний результат залежить від руху ціни, а при виході за межі діапазону сітка зупиняється." };
    },
  };

  // ---------------------------------------------------------------- 13. DCA
  const dca = {
    id: "dca", group: "fut", title: "DCA: регулярні покупки", hint: "середня ціна при рівних внесках",
    intro: "Купуєш однакову суму за різними цінами: ось середня ціна й результат. Ціни вводь через пробіл або крапку з комою.",
    fields: [{ key: "amount", label: "Сума однієї покупки, USDT", kind: "num" },
      { key: "prices", label: "Ціни покупок", kind: "text", ph: "Наприклад 60000 58000 55500 62000", hint: "Через пробіл або крапку з комою, до 200 цін." },
      { key: "fee", label: "Комісія біржі, %", kind: "num", def: "0", keep: true },
      { key: "cur", label: "Поточна ціна (необов'язково)", kind: "num" }],
    compute(v) {
      const r = reader(v);
      const amount = r.num("amount", "Сума покупки", { req: 1, pos: 1 }), fee = r.num("fee", "Комісія", { min: 0, max: 50 }), cur = r.num("cur", "Поточна ціна", { pos: 1 });
      const toks = String(v.prices || "").split(/[\s;]+/).filter(Boolean);
      if (!toks.length) r.missing.push("prices");
      const prices = toks.map(parseNum);
      if (toks.length > 200) r.err("prices", "Забагато цін: не більше 200.");
      else if (prices.some((p) => p === undefined || !Number.isFinite(p) || p <= 0)) r.err("prices", "Ціни мають бути додатними числами, розділеними пробілом або крапкою з комою.");
      if (r.bad()) return r.fail();
      const f = (fee || 0) / 100, n = prices.length, total = amount * n, qty = prices.reduce((a, p) => a + (amount / p) * (1 - f), 0), a = total / qty, mean = prices.reduce((x, p) => x + p, 0) / n;
      const out = { n, total, qty, avg: a, mean, saving: (mean / a - 1) * 100, min: Math.min(...prices), max: Math.max(...prices) };
      if (cur !== undefined) { out.value = qty * cur; out.pnl = out.value - total; out.pnl_pct = (out.pnl / total) * 100; }
      return ok(out);
    },
    view(x, F) {
      return { big: { label: "Середня ціна покупки", value: F.px(x.avg), hint: `${x.n} покупок · вкладено ${F.n2(x.total)} USDT · ${F.n(x.qty, 8)} монет` },
        tiles: clean([{ id: "mean", label: "Проста середня цін", value: F.px(x.mean), hint: x.saving > 0 ? `DCA вигідніший на ${F.n(x.saving, 2)}%` : "різниці майже немає" },
          { id: "range", label: "Діапазон цін", value: `${F.px(x.min)} – ${F.px(x.max)}` },
          x.pnl != null ? { id: "pnl", label: "Результат при поточній ціні", value: `${F.sgn(x.pnl, 2)} USDT`, hint: `${F.sgn(x.pnl_pct, 2)}%, вартість ${F.n2(x.value)}`, sign: sgnOf(x.pnl) } : null]),
        note: "Середня ціна DCA нижча за просту середню, бо за ту саму суму на низьких цінах купується більше монет." };
    },
  };

  // ---------------------------------------------------------------- 14. Конвертер
  const convert = {
    id: "convert", group: "fut", title: "Конвертер", hint: "монета ↔ USDT за введеним курсом",
    intro: "Швидкий перерахунок за курсом, який ти вводиш. Живих цін тут немає.",
    fields: [{ key: "base", label: "Монета", kind: "text", def: "BTC", keep: true },
      { key: "quote", label: "Валюта", kind: "text", def: "USDT", keep: true },
      { key: "rate", label: (v) => `Курс: 1 ${(v.base || "").toUpperCase() || "монета"} = ? ${(v.quote || "").toUpperCase() || "валюта"}`, kind: "num" },
      { key: "dir", label: "Напрямок", kind: "seg", options: [["to_quote", "Монета у валюту"], ["to_base", "Валюта в монету"]], def: "to_quote", keep: true, wide: true },
      { key: "amount", label: "Кількість", kind: "num" }],
    compute(v) {
      const r = reader(v);
      const rate = r.num("rate", "Курс", { req: 1, pos: 1 }), amount = r.num("amount", "Кількість", { req: 1, pos: 1 });
      const b = String(v.base || "").trim().toUpperCase() || "BASE", q = String(v.quote || "").trim().toUpperCase() || "QUOTE";
      if (r.bad()) return r.fail();
      const toQuote = v.dir !== "to_base";
      return ok({ result: toQuote ? amount * rate : amount / rate, from: toQuote ? b : q, to: toQuote ? q : b, amount, rate, base: b, quote: q, inverse: 1 / rate });
    },
    view(x, F) {
      return { big: { label: `${F.n(x.amount, 8)} ${x.from} це`, value: `${F.n(x.result, 8)} ${x.to}`, hint: `1 ${x.base} = ${F.n(x.rate, 8)} ${x.quote}`, copy: String(Number(x.result.toFixed(8))) },
        tiles: [{ id: "inv", label: `1 ${x.quote}`, value: `${F.n(x.inverse, 10)} ${x.base}` }] };
    },
  };

  // ---------------------------------------------------------------- 15. Відновлення після просадки
  const recovery = {
    id: "recovery", group: "stat", title: "Відновлення після просадки", hint: "який приріст повертає депозит",
    intro: "Чим глибша просадка, тим більший приріст потрібен, щоб повернутися до піку.",
    fields: [{ key: "mode", label: "Задати", kind: "seg", options: [["pct", "Просадку, %"], ["bal", "Баланси"]], def: "pct", wide: true },
      { key: "dd", label: "Просадка, %", kind: "num", ph: "Наприклад 20", show: (v) => v.mode !== "bal" },
      { key: "peak", label: "Максимальний баланс (пік)", kind: "num", show: (v) => v.mode === "bal" },
      { key: "cur", label: "Поточний баланс", kind: "num", show: (v) => v.mode === "bal" },
      { key: "monthly", label: "Дохідність на місяць, % (необов'язково)", kind: "num", heading: "Скільки часу піде" },
      { key: "risk", label: "Ризик на угоду, % (необов'язково)", kind: "num" },
      { key: "exp", label: "Очікування, R на угоду (необов'язково)", kind: "num", hint: "Середній результат угоди в R (див. калькулятор очікування)." }],
    compute(v) {
      const r = reader(v), bal = v.mode === "bal";
      const dd0 = !bal ? r.num("dd", "Просадка", { req: 1, pos: 1, max: 99.99 }) : undefined;
      const peak = bal ? r.num("peak", "Пік", { req: 1, pos: 1 }) : undefined, cur = bal ? r.num("cur", "Поточний баланс", { req: 1, pos: 1 }) : undefined;
      const monthly = r.num("monthly", "Дохідність", { pos: 1 }), risk = r.num("risk", "Ризик", { pos: 1, max: 100 }), exp = r.num("exp", "Очікування", { pos: 1 });
      if (r.bad()) return r.fail();
      let dd = dd0;
      if (bal) { if (cur >= peak) { r.err("cur", "Поточний баланс не нижчий за пік: просадки немає."); return r.fail(); } dd = ((peak - cur) / peak) * 100; }
      const d = dd / 100, lg = Math.log(1 / (1 - d));
      const out = { dd, gain: (1 / (1 - d) - 1) * 100, table: [5, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((p) => ({ dd: p, gain: (1 / (1 - p / 100) - 1) * 100 })) };
      if (bal) { out.peak = peak; out.cur = cur; out.need_money = peak - cur; }
      if (monthly !== undefined) out.months = lg / Math.log(1 + monthly / 100);
      if (risk !== undefined && exp !== undefined) out.trades = lg / Math.log(1 + (risk / 100) * exp);
      return ok(out);
    },
    view(x, F) {
      return { big: { label: "Потрібний приріст до піку", value: F.pct(x.gain, 2), hint: `просадка ${F.n(x.dd, 2)}%` },
        tiles: clean([x.need_money != null ? { id: "money", label: "Потрібно заробити", value: F.n2(x.need_money), hint: `з ${F.n2(x.cur)} до ${F.n2(x.peak)}` } : null,
          x.months != null ? { id: "months", label: "Місяців при заданій дохідності", value: F.n(x.months, 1), hint: "зі складним відсотком" } : null,
          x.trades != null ? { id: "trades", label: "Угод при заданому очікуванні", value: String(Math.ceil(x.trades)), hint: "зі складним відсотком" } : null]),
        tables: [{ id: "dds", title: "Просадка й потрібний приріст", head: ["Просадка", "Потрібний приріст"], rows: x.table.map((q) => [`${q.dd}%`, F.pct(q.gain, 1)]) }],
        note: "Приріст = 1 ÷ (1 − просадка) − 1. Саме тому просадку краще не допускати: після −50% потрібно +100%." };
    },
  };

  // ---------------------------------------------------------------- 16. Ліміти ризику
  const daylimit = {
    id: "daylimit", group: "stat", title: "Ризик на день і тиждень", hint: "ліміти збитку й серії стопів",
    intro: "Скільки стопів вміщається в денний і тижневий ліміт, і що буде з депозитом після серії збитків.",
    fields: [{ key: "deposit", label: "Депозит", kind: "num", pref: "deposit" },
      { key: "risk", label: "Ризик на угоду, %", kind: "num", def: "1", keep: true },
      { key: "day", label: "Денний ліміт збитку, %", kind: "num", def: "3", keep: true },
      { key: "week", label: "Тижневий ліміт збитку, %", kind: "num", def: "6", keep: true }],
    compute(v) {
      const r = reader(v);
      const dep = r.num("deposit", "Депозит", { req: 1, pos: 1 }), risk = r.num("risk", "Ризик", { req: 1, pos: 1, max: 100 }), day = r.num("day", "Денний ліміт", { req: 1, pos: 1, max: 100 }), week = r.num("week", "Тижневий ліміт", { req: 1, pos: 1, max: 100 });
      if (r.bad()) return r.fail();
      const q = 1 - risk / 100, warnings = [];
      if (risk > day) warnings.push("Ризик на угоду більший за денний ліміт: один стоп уже перевищує його.");
      if (day > week) warnings.push("Денний ліміт більший за тижневий.");
      return ok({ risk_money: (dep * risk) / 100, day_money: (dep * day) / 100, week_money: (dep * week) / 100, stops_day: Math.floor(day / risk + 1e-9), stops_week: Math.floor(week / risk + 1e-9), days_week: week / day, warnings,
        table: [1, 2, 3, 5, 8, 10, 15, 20].map((n) => ({ n, equity: dep * Math.pow(q, n), loss: (1 - Math.pow(q, n)) * 100, recover: (1 / Math.pow(q, n) - 1) * 100 })) });
    },
    view(x, F) {
      return { big: { label: "Стопів у денний ліміт", value: String(x.stops_day), hint: `денний ліміт ${F.n2(x.day_money)} · ризик на угоду ${F.n2(x.risk_money)}` }, warnings: x.warnings,
        tiles: [{ id: "week", label: "Стопів у тижневий ліміт", value: String(x.stops_week), hint: `ліміт ${F.n2(x.week_money)}` },
          { id: "days", label: "Денних лімітів у тижневому", value: F.n(x.days_week, 1) }],
        tables: [{ id: "streak", title: "Серія збиткових угод поспіль", head: ["Стопів", "Баланс", "Збиток", "Потрібний приріст"], rows: x.table.map((q) => [String(q.n), F.n2(q.equity), F.pct(q.loss, 2), F.pct(q.recover, 1)]) }],
        note: "Розрахунок зі складним відсотком: кожен наступний стоп береться від меншого балансу." };
    },
  };

  // ---------------------------------------------------------------- 17. Очікування стратегії
  const expectancy = {
    id: "expectancy", group: "stat", title: "Очікування стратегії", hint: "winrate, середній виграш і збиток",
    intro: "Скільки R в середньому приносить угода, profit factor, беззбитковий winrate і оптимальний ризик за Келлі.",
    fromBacktest: { wr: "wr", win: "win", loss: "loss" },
    fields: [{ key: "wr", label: "Winrate, %", kind: "num", ph: "Наприклад 45" },
      { key: "win", label: "Середній виграш, R", kind: "num", ph: "Наприклад 2" },
      { key: "loss", label: "Середній збиток, R", kind: "num", def: "1", keep: true },
      { key: "fee", label: "Комісії, R на угоду (необов'язково)", kind: "num", hint: "Скільки R в середньому з'їдають комісії." },
      { key: "risk", label: "Ризик на угоду, % (необов'язково)", kind: "num", def: "1", keep: true, heading: "У відсотках рахунку" },
      { key: "trades", label: "Угод на місяць (необов'язково)", kind: "num" }],
    compute(v) {
      const r = reader(v);
      const wr = r.num("wr", "Winrate", { req: 1, min: 0, max: 100 }), win = r.num("win", "Виграш", { req: 1, pos: 1 }), loss = r.num("loss", "Збиток", { req: 1, pos: 1 });
      const fee = r.num("fee", "Комісії", { min: 0 }), risk = r.num("risk", "Ризик", { pos: 1, max: 100 }), trades = r.num("trades", "Угод на місяць", { pos: 1 });
      if (r.bad()) return r.fail();
      const w = wr / 100, e = w * win - (1 - w) * loss - (fee || 0), b = win / loss;
      const kelly = ((w * b - (1 - w)) / b) * 100;
      const out = { exp: e, pf: w === 1 ? null : (w * win) / ((1 - w) * loss), be_wr: (loss / (win + loss)) * 100, kelly, half_kelly: kelly / 2, wr, win, loss };
      if (risk !== undefined) { out.per_trade_pct = e * risk; out.risk = risk; if (trades !== undefined) { out.trades = trades; out.month_pct = (Math.pow(1 + (e * risk) / 100, trades) - 1) * 100; } }
      return ok(out);
    },
    view(x, F) {
      return { big: { label: "Очікування на угоду", value: `${F.sgn(x.exp, 3)} R`, hint: x.exp > 0 ? "стратегія в середньому прибуткова" : x.exp < 0 ? "стратегія в середньому збиткова" : "нульове очікування" },
        warnings: x.exp <= 0 ? ["Очікування не додатне: при такому winrate й співвідношенні виграшу до збитку стратегія в плюс не вийде."] : [],
        tiles: clean([{ id: "pf", label: "Profit factor", value: x.pf == null ? "—" : F.n(x.pf, 2), hint: "сума виграшів ÷ сума збитків" },
          { id: "be", label: "Беззбитковий winrate", value: F.pct(x.be_wr, 1), hint: `у тебе ${F.n(x.wr, 1)}%`, sign: x.wr >= x.be_wr ? "pos" : "neg" },
          { id: "kelly", label: "Критерій Келлі", value: x.kelly > 0 ? F.pct(x.kelly, 1) : "0%", hint: x.kelly > 0 ? `половина Келлі ${F.n(x.half_kelly, 1)}%: обережніший ризик` : "ризикувати не варто" },
          x.per_trade_pct != null ? { id: "pt", label: "Очікування на угоду, % рахунку", value: `${F.sgn(x.per_trade_pct, 3)}%`, hint: `при ризику ${F.n(x.risk, 2)}% на угоду`, sign: sgnOf(x.per_trade_pct) } : null,
          x.month_pct != null ? { id: "month", label: `За місяць (${F.n(x.trades, 0)} угод)`, value: `${F.sgn(x.month_pct, 2)}%`, hint: "складний відсоток, у середньому", sign: sgnOf(x.month_pct) } : null]),
        note: "Очікування = winrate × виграш − (1 − winrate) × збиток. Критерій Келлі дає теоретичну межу ризику: на практиці беруть його частину." };
    },
  };

  // ---------------------------------------------------------------- 18. Монте-Карло
  /** Генератор псевдовипадкових чисел (mulberry32): однаковий seed дає однакову послідовність, тож результат стабільний між запусками. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const SIMS = 2000;
  /** Симуляція серій угод: усього sims прогонів по trades угод зі складним відсотком. */
  function simulate({ w, win, loss, trades, risk, seed = 1, sims = SIMS }) {
    const rnd = rng(seed), up = 1 + (risk / 100) * win, dn = 1 - (risk / 100) * loss;
    const finals = new Array(sims), dds = new Array(sims), streaks = new Array(sims);
    for (let s = 0; s < sims; s++) {
      let eq = 1, peak = 1, dd = 0, st = 0, best = 0;
      for (let i = 0; i < trades; i++) {
        if (rnd() < w) { eq *= up; st = 0; } else { eq *= dn; st++; if (st > best) best = st; }
        if (eq > peak) peak = eq; else { const d = 1 - eq / peak; if (d > dd) dd = d; }
      }
      finals[s] = (eq - 1) * 100; dds[s] = dd * 100; streaks[s] = best;
    }
    return { finals, dds, streaks };
  }
  const montecarlo = {
    id: "montecarlo", group: "stat", title: "Монте-Карло: серії угод", hint: "розкид результатів, просадка, серії стопів",
    intro: "Симуляція тисяч випадкових серій угод за твоїми параметрами: який може бути результат, просадка і серія збитків.",
    fromBacktest: { wr: "wr", win: "win", loss: "loss" },
    fields: [{ key: "wr", label: "Winrate, %", kind: "num", ph: "Наприклад 45" },
      { key: "win", label: "Середній виграш, R", kind: "num", def: "2", keep: true },
      { key: "loss", label: "Середній збиток, R", kind: "num", def: "1", keep: true },
      { key: "trades", label: "Кількість угод у серії", kind: "num", def: "100", keep: true },
      { key: "risk", label: "Ризик на угоду, %", kind: "num", def: "1", keep: true },
      { key: "limit", label: "Поріг просадки, %", kind: "num", def: "20", keep: true, hint: "Покаже ймовірність просадки не менше за це число." },
      { key: "seed", kind: "hidden", def: "1" }],
    actions: [{ id: "rerun", label: "Нова симуляція", title: "Прогнати ще раз з іншими випадковими числами", run: (vals) => { vals.seed = String((Number(vals.seed) || 1) + 1); } }],
    compute(v) {
      const r = reader(v);
      const wr = r.num("wr", "Winrate", { req: 1, min: 0, max: 100 }), win = r.num("win", "Виграш", { req: 1, pos: 1 }), loss = r.num("loss", "Збиток", { req: 1, pos: 1 });
      const trades = r.num("trades", "Угод у серії", { req: 1, min: 1, max: 2000, int: 1 }), risk = r.num("risk", "Ризик", { req: 1, pos: 1, max: 100 }), limit = r.num("limit", "Поріг просадки", { pos: 1, max: 100 });
      if (r.bad()) return r.fail();
      if ((risk / 100) * loss >= 1) { r.err("risk", "При такому ризику й збитку один стоп забирає весь баланс."); return r.fail(); }
      const w = wr / 100, seed = Number.isFinite(Number(v.seed)) ? Number(v.seed) : 1, lim = limit === undefined ? 20 : limit;
      const { finals, dds, streaks } = simulate({ w, win, loss, trades, risk, seed });
      const fs = [...finals].sort((a, b) => a - b), ds = [...dds].sort((a, b) => a - b), ss = [...streaks].sort((a, b) => a - b), n = fs.length;
      return ok({ sims: n, trades, median: pctl(fs, 0.5), p5: pctl(fs, 0.05), p95: pctl(fs, 0.95), profit_prob: (finals.filter((x) => x > 0).length / n) * 100,
        dd_median: pctl(ds, 0.5), dd_p95: pctl(ds, 0.95), dd_limit: lim, dd_prob: (dds.filter((x) => x >= lim).length / n) * 100, streak_median: pctl(ss, 0.5), streak_p95: pctl(ss, 0.95), exp: w * win - (1 - w) * loss });
    },
    view(x, F) {
      return { big: { label: "Ймовірність прибутку за серію", value: F.pct(x.profit_prob, 1), hint: `${F.n(x.sims, 0)} симуляцій по ${x.trades} угод` },
        warnings: x.exp <= 0 ? ["Очікування не додатне: більшість серій буде збитковою."] : [],
        tiles: [{ id: "median", label: "Типовий результат", value: `${F.sgn(x.median, 1)}%`, hint: `90% серій між ${F.sgn(x.p5, 1)}% і ${F.sgn(x.p95, 1)}%`, sign: sgnOf(x.median) },
          { id: "dd", label: "Просадка, типова", value: `−${F.n(x.dd_median, 1)}%`, hint: `у 95% серій не гірша за −${F.n(x.dd_p95, 1)}%`, sign: "neg" },
          { id: "ddp", label: `Ймовірність просадки від ${F.n(x.dd_limit, 0)}%`, value: F.pct(x.dd_prob, 1), hint: "хоч раз за серію" },
          { id: "streak", label: "Серія стопів поспіль", value: `${x.streak_median}`, hint: `типова найдовша; у 95% серій не довша за ${x.streak_p95}` }],
        note: "Симуляція рівномірно випадкова й не знає про ринок. Вона показує розкид, який дає твій winrate й співвідношення R, а не прогноз." };
    },
  };

  const TOOLS = [rr, partial, avg, pipv, futures, liq, pnl, fees, funding, breakeven, spot, grid, dca, convert, recovery, daylimit, expectancy, montecarlo];
  JL.calcTools = { GROUPS, TOOLS, byId: (id) => TOOLS.find((t) => t.id === id) || null, liqPrice, maxLevForStop, gridLevels, rng, simulate, SIMS };
})(typeof window !== "undefined" ? window : globalThis);
