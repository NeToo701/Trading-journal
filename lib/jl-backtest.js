/* Бектести: перевірка введених даних і статистика колекцій. Лише чисті функції, без доступу до бази (роботу з базою роблять маршрути в jl-api.js).
   Колекція: {id, name, note, risk_pct}. Угода: {id, col_id, date, symbol, direction, setup, r, note}. Результат угоди завжди в R. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { ApiError, pyRound, pySum } = JL;

  const LIM = { MAX_COLS: 50, MAX_TRADES: 5000, NOTE: 500, SYMBOL: 20, SETUP: 40, MAX_R: 1000 };
  const DIRECTIONS = ["Лонг", "Шорт"];
  const BE_EPS = 0.05;                       // така сама межа беззбитку (в R), як у статистиці основного журналу
  const MONTH_NAMES = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];

  const squash = (s) => s.split(/\s+/).filter(Boolean).join(" ");
  const r2 = (x, nd = 2) => (x == null ? null : pyRound(x, nd));
  const mean = (a) => pySum(a) / a.length;

  /** Число зі «зручного» вводу: "1,5", "-2", "−1", " +3 ". Порожнє дає undefined, сміття дає NaN. */
  function parseNum(v) {
    if (v == null) return undefined;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v !== "string") return NaN;
    const s = v.trim().replace("−", "-");
    if (!s) return undefined;
    if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) return NaN;
    return Number(s.replace(",", "."));
  }

  function cleanCol(b) {
    b = b || {};
    const name = JL.cleanName(b.name, "Назва колекції");
    const note = b.note == null ? "" : JL.cleanText(b.note, "note", LIM.NOTE, "Опис");
    const risk = parseNum(b.risk_pct);
    if (risk !== undefined && (!Number.isFinite(risk) || risk <= 0 || risk > 100))
      throw new ApiError("Ризик на угоду: число від 0,01 до 100 (у відсотках від рахунку).", 422, "risk_pct");
    return { name, note, risk_pct: risk === undefined ? null : pyRound(risk, 2) };
  }

  function cleanTrade(b) {
    b = b || {};
    const r = parseNum(b.r);
    if (r === undefined) throw new ApiError("Вкажи результат угоди в R, наприклад 2, 0 або -1.", 422, "r");
    if (!Number.isFinite(r) || Math.abs(r) > LIM.MAX_R) throw new ApiError(`Результат у R: число від -${LIM.MAX_R} до ${LIM.MAX_R}, наприклад 1,5 або -1.`, 422, "r");
    const date = b.date == null ? "" : String(b.date).trim();
    if (date && !(/^\d{4}-\d{2}-\d{2}$/.test(date) && JL.parseDay(date))) throw new ApiError("Дата має бути справжньою датою у форматі РРРР-ММ-ДД.", 422, "date");
    const symbol = squash(JL.cleanText(b.symbol == null ? "" : b.symbol, "symbol", LIM.SYMBOL, "Інструмент")).toUpperCase();
    const setup = squash(JL.cleanText(b.setup == null ? "" : b.setup, "setup", LIM.SETUP, "Сетап"));
    let direction = "";
    const dr = String(b.direction == null ? "" : b.direction).trim().toLowerCase();
    if (dr) {
      if (dr === "лонг" || dr === "long") direction = "Лонг";
      else if (dr === "шорт" || dr === "short") direction = "Шорт";
      else throw new ApiError("Напрямок: Лонг або Шорт.", 422, "direction");
    }
    const note = b.note == null ? "" : JL.cleanText(b.note, "note", LIM.NOTE, "Нотатка");
    return { date, symbol, direction, setup, r: pyRound(r, 4), note };
  }

  /** Підбирає написання сетапу, яке вже є в колекції («breakout» і «Breakout» — один сетап). */
  function canonSetup(existing, setup) {
    if (!setup) return setup;
    const counts = new Map();
    for (const t of existing) if (t.setup) counts.set(t.setup, (counts.get(t.setup) || 0) + 1);
    const byFold = new Map();
    for (const [n] of [...counts].sort((a, b) => b[1] - a[1])) { const k = n.toLowerCase(); if (!byFold.has(k)) byFold.set(k, n); }
    return byFold.get(setup.toLowerCase()) || setup;
  }

  /** Хронологічний порядок: за датою (якщо вона є в усіх угод), далі за порядком додавання. Без дат: лише за порядком додавання. */
  function order(trades) {
    const all = trades.every((t) => t.date);
    return [...trades].sort((a, b) => (all ? JL.cmp(a.date, b.date) : 0) || (a.id - b.id));
  }

  const outcome = (r) => (Math.abs(r) <= BE_EPS ? "be" : r > 0 ? "win" : "loss");

  function drawdown(series) {
    let peak = 0, worst = 0, cum = 0;
    for (const x of series) { cum += x; peak = Math.max(peak, cum); worst = Math.min(worst, cum - peak); }
    return Math.abs(worst);
  }

  function streaks(rs) {
    let bw = 0, bl = 0, cw = 0, cl = 0;
    for (const r of rs) {
      const o = outcome(r);
      if (o === "win") { cw++; cl = 0; } else if (o === "loss") { cl++; cw = 0; } else { cw = cl = 0; }
      bw = Math.max(bw, cw); bl = Math.max(bl, cl);
    }
    return [bw, bl];
  }

  function totals(rs) {
    const n = rs.length;
    if (!n) return { trades: 0, wins: 0, losses: 0, be: 0, win_rate: null, total_r: 0, avg_r: null, profit_factor: null };
    const win = rs.filter((r) => outcome(r) === "win"), loss = rs.filter((r) => outcome(r) === "loss");
    const gw = pySum(win), gl = -pySum(loss);
    return { trades: n, wins: win.length, losses: loss.length, be: n - win.length - loss.length,
      win_rate: r2(100 * win.length / n, 1), total_r: r2(pySum(rs)), avg_r: r2(mean(rs)),
      profit_factor: loss.length && gl > 0 ? r2(gw / gl, 2) : null };
  }

  const BREAKDOWNS = { setup: "Сетап", direction: "Напрямок", symbol: "Інструмент", month: "Місяць" };
  function breakdown(ts, by) {
    const keyOf = (t) => {
      if (by === "month") return t.date ? t.date.slice(0, 7) : "";
      return t[by] || "";
    };
    const groups = new Map();
    for (const t of ts) { const k = keyOf(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t.r); }
    const label = (k) => {
      if (k === "") return by === "month" ? "Без дати" : "Не вказано";
      if (by === "month") return `${MONTH_NAMES[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`;
      return k;
    };
    const rows = [...groups].map(([k, rs]) => ({ key: k, label: label(k), ...totals(rs) }));
    rows.sort((a, b) => (by === "month" ? JL.cmp(a.key, b.key) : (b.total_r - a.total_r) || (b.trades - a.trades)));
    return rows.slice(0, 40);
  }

  /** Статистика колекції. risk — ризик на угоду, % від рахунку (або null): за ним оцінюється дохідність у %. */
  function compute(trades, risk) {
    const ts = order(trades);
    const rs = ts.map((t) => t.r);
    const base = totals(rs);
    const win = rs.filter((r) => outcome(r) === "win"), loss = rs.filter((r) => outcome(r) === "loss");
    const avgWin = win.length ? r2(mean(win)) : null, avgLoss = loss.length ? r2(mean(loss)) : null;
    const dd = rs.length ? r2(drawdown(rs)) : null;
    const [sw, sl] = streaks(rs);
    const k = risk == null ? null : Number(risk);
    let cum = 0;
    const equity = ts.map((t, i) => { cum = pyRound(cum + t.r, 4); return { n: i + 1, day: t.date, r: cum, v: t.r }; });
    const dated = ts.filter((t) => t.date);
    return { ...base,
      avg_win_r: avgWin, avg_loss_r: avgLoss, payoff: avgWin != null && avgLoss ? r2(avgWin / -avgLoss, 2) : null,
      best_r: rs.length ? r2(Math.max(...rs)) : null, worst_r: rs.length ? r2(Math.min(...rs)) : null,
      max_drawdown_r: dd, win_streak: sw, loss_streak: sl,
      risk_pct: k, return_pct: k && rs.length ? r2(base.total_r * k) : null, max_drawdown_pct: k && dd != null ? r2(dd * k) : null,
      first_day: dated.length ? dated[0].date : null, last_day: dated.length ? dated[dated.length - 1].date : null,
      equity,
      breakdowns: Object.fromEntries(Object.keys(BREAKDOWNS).map((by) => [by, breakdown(ts, by)])) };
  }

  JL.bt = { LIM, DIRECTIONS, BE_EPS, BREAKDOWNS, parseNum, cleanCol, cleanTrade, canonSetup, order, outcome, compute };
})(typeof window !== "undefined" ? window : globalThis);
