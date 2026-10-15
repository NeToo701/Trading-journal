/* Статистика журналу: переніс app/journal_stats.py. Усе рахується лише із записів користувача. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { ApiError, pyRound, pySum, cmp } = JL;

  const GROUPS = ["day", "week", "month", "quarter", "year"];
  const BE_EPS = 0.05;
  const OUTCOMES = { win: "Тейк-профіт", loss: "Стоп-лос", be: "Беззбиток", open: "Відкрита" };
  const BY_LABEL = {};
  for (const [k, v] of Object.entries(OUTCOMES)) BY_LABEL[v.toLowerCase()] = k;
  BY_LABEL["прибуток"] = "win"; BY_LABEL["збиток"] = "loss";
  const WEEKDAYS = ["Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота", "Неділя"];
  const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
  const MONTH_NAMES = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
  const LONG = "лонг", SHORT = "шорт";

  function num(v) {
    if (typeof v === "boolean" || v == null || v === "") return null;
    let x;
    if (typeof v === "number") x = v;
    else if (typeof v === "string") {
      x = JL.pyFloat(v);
      if (x === null) return null;
    } else return null;
    return Number.isFinite(x) ? x : null;
  }
  const r2 = (x, nd = 2) => (x == null ? null : pyRound(x, nd));
  const sumOf = (vals) => { const v = vals.filter((x) => x != null); return v.length ? pySum(v) : null; };
  const dayIso = (d) => d.iso;

  function effectiveR(d) {
    const r = num(d.r);
    if (r != null) return r;
    const entry = num(d.entry), stop = num(d.stop), exit = num(d.exit), direction = String(d.direction || "").toLowerCase();
    if (entry == null || stop == null || exit == null || (direction !== LONG && direction !== SHORT)) return null;
    const risk = direction === LONG ? entry - stop : stop - entry;
    if (risk <= 0) return null;
    const move = direction === LONG ? exit - entry : entry - exit;
    return pyRound(move / risk, 4);
  }

  function effectiveOutcome(d) {
    const label = String(d.outcome || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(BY_LABEL, label)) return BY_LABEL[label];
    const pnl = num(d.pnl), r = effectiveR(d), pct = num(d.pct);
    if (pnl != null) return pnl > 0 ? "win" : pnl < 0 ? "loss" : "be";
    if (pct != null) return pct > 0 ? "win" : pct < 0 ? "loss" : "be";
    if (r != null) return Math.abs(r) <= BE_EPS ? "be" : r > 0 ? "win" : "loss";
    if (!d.closed_at && num(d.exit) == null) return "open";
    return null;
  }

  const effectiveDay = (d) => JL.parseDay(d.closed_at) || JL.parseDay(d.opened_at);

  function periodKey(day, group) {
    if (group === "day") return [day.iso, `${day.d} ${MONTHS[day.m - 1]} ${day.y}`];
    if (group === "week") {
      const [y, w] = JL.isoWeek(day);
      const mon = JL.isoMonday(y, w), sun = JL.addDays(mon, 6);
      const p = JL.pad;
      return [`${y}-W${p(w)}`, `${p(mon.d)}.${p(mon.m)} – ${p(sun.d)}.${p(sun.m)}.${sun.y}`];
    }
    if (group === "month") return [`${day.y}-${JL.pad(day.m)}`, `${MONTH_NAMES[day.m - 1]} ${day.y}`];
    if (group === "quarter") { const q = Math.floor((day.m - 1) / 3) + 1; return [`${day.y}-Q${q}`, `${q} квартал ${day.y}`]; }
    return [String(day.y), `${day.y} рік`];
  }

  const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" && v ? [v] : []);

  function trade(id, d) {
    const day = effectiveDay(d), outcome = effectiveOutcome(d);
    if (!day || outcome == null || outcome === "open") return null;
    const when = String(d.closed_at || d.opened_at || "");
    return { id, day, when, outcome, pnl: num(d.pnl), r: effectiveR(d), pct: num(d.pct),
      direction: String(d.direction || "").trim(), symbol: String(d.symbol || "").trim().toUpperCase(),
      setup: String(d.setup || "").trim(), discipline: num(d.discipline),
      emo_before: strs(d.emo_before != null ? d.emo_before : d.emotions), emo_after: strs(d.emo_after),
      mistakes: strs(d.mistakes), by_rules: String(d.by_rules || "").trim() };
  }

  function agg(trades) {
    const n = trades.length;
    const wins = trades.filter((t) => t.outcome === "win").length, losses = trades.filter((t) => t.outcome === "loss").length;
    return { trades: n, wins, losses, be: n - wins - losses,
      win_rate: n ? r2(100 * wins / n, 1) : null,
      pnl: r2(sumOf(trades.map((t) => t.pnl))), r: r2(sumOf(trades.map((t) => t.r))), pct: r2(sumOf(trades.map((t) => t.pct))) };
  }

  function drawdown(series) {
    let peak = 0, worst = 0, cum = 0;
    for (const x of series) { cum += x; peak = Math.max(peak, cum); worst = Math.min(worst, cum - peak); }
    return Math.abs(worst);
  }

  function streaks(trades) {
    let bw = 0, bl = 0, cw = 0, cl = 0;
    for (const t of trades) {
      if (t.outcome === "win") { cw++; cl = 0; } else if (t.outcome === "loss") { cl++; cw = 0; } else { cw = cl = 0; }
      bw = Math.max(bw, cw); bl = Math.max(bl, cl);
    }
    return [bw, bl];
  }

  const mean = (a) => pySum(a) / a.length;

  function summary(trades, openTrades) {
    const base = agg(trades);
    const pnls = trades.map((t) => t.pnl).filter((x) => x != null);
    const rs = trades.map((t) => t.r).filter((x) => x != null);
    const pcts = trades.map((t) => t.pct).filter((x) => x != null);
    const winP = pnls.filter((x) => x > 0), lossP = pnls.filter((x) => x < 0);
    const winR = rs.filter((x) => x > 0), lossR = rs.filter((x) => x < 0);
    let pf = null;
    if (winP.length || lossP.length) pf = lossP.length ? r2(pySum(winP) / -pySum(lossP), 2) : null;
    else if (winR.length || lossR.length) pf = lossR.length ? r2(pySum(winR) / -pySum(lossR), 2) : null;
    const avgWin = winP.length ? r2(pySum(winP) / winP.length) : null;
    const avgLoss = lossP.length ? r2(pySum(lossP) / lossP.length) : null;
    let payoff = avgWin != null && avgLoss ? r2(avgWin / -avgLoss, 2) : null;
    if (payoff == null && winR.length && lossR.length) payoff = r2(mean(winR) / -mean(lossR), 2);
    const [sw, sl] = streaks(trades);
    const disc = trades.map((t) => t.discipline).filter((x) => x != null);
    return { ...base, open_trades: openTrades,
      avg_r: rs.length ? r2(mean(rs)) : null, avg_pnl: pnls.length ? r2(mean(pnls)) : null,
      avg_win: avgWin, avg_loss: avgLoss, payoff, profit_factor: pf,
      best: pnls.length ? r2(Math.max(...pnls)) : null, worst: pnls.length ? r2(Math.min(...pnls)) : null,
      best_r: rs.length ? r2(Math.max(...rs)) : null, worst_r: rs.length ? r2(Math.min(...rs)) : null,
      avg_pct: pcts.length ? r2(mean(pcts)) : null,
      best_pct: pcts.length ? r2(Math.max(...pcts)) : null, worst_pct: pcts.length ? r2(Math.min(...pcts)) : null,
      max_drawdown_pct: pcts.length ? r2(drawdown(pcts)) : null,
      max_drawdown: pnls.length ? r2(drawdown(pnls)) : null,
      max_drawdown_r: rs.length ? r2(drawdown(rs)) : null,
      win_streak: sw, loss_streak: sl,
      avg_discipline: disc.length ? r2(mean(disc), 1) : null };
  }

  function breakdown(trades, keyOf, limit = 8) {
    const groups = new Map();
    for (const t of trades) {
      const keys = keyOf(t);
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    }
    const rows = [...groups].map(([k, v]) => ({ name: k, ...agg(v) }));
    rows.sort((a, b) => (b.trades - a.trades) || cmp(a.name, b.name));
    return rows.slice(0, limit);
  }

  function setupRows(trades) {
    const groups = new Map(), names = new Map();
    for (const t of trades) {
      const raw = t.setup.split(/\s+/).filter(Boolean).join(" ");
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (!names.has(key)) names.set(key, raw);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const rows = [];
    for (const [key, items] of groups) {
      const a = agg(items);
      const rs = items.map((t) => t.r).filter((x) => x != null), pn = items.map((t) => t.pnl).filter((x) => x != null);
      const wr = pySum(rs.filter((x) => x > 0)), lr = -pySum(rs.filter((x) => x < 0));
      const wp = pySum(pn.filter((x) => x > 0)), lp = -pySum(pn.filter((x) => x < 0));
      let pf = lr ? r2(wr / lr, 2) : null;
      if (pf == null && lp) pf = r2(wp / lp, 2);
      rows.push({ name: names.get(key), ...a, avg_r: rs.length ? r2(mean(rs)) : null, avg_pnl: pn.length ? r2(mean(pn)) : null, profit_factor: pf });
    }
    rows.sort((a, b) => (b.trades - a.trades) || cmp(a.name.toLowerCase(), b.name.toLowerCase()));
    return rows;
  }

  /** entries: [[id, data], ...]. Повертає все, що потрібно сторінці статистики. */
  function compute(entries, group = "month", start = null, end = null) {
    if (!GROUPS.includes(group)) throw new ApiError("group має бути одним із: " + GROUPS.join(", "), 400);
    const lo = JL.parseDay(start), hi = JL.parseDay(end);
    const trades = [];
    let openTrades = 0, undated = 0;
    for (const [rid, d] of entries) {
      const day = effectiveDay(d);
      if (!day) { undated++; continue; }
      if ((lo && day.iso < lo.iso) || (hi && day.iso > hi.iso)) continue;
      if (effectiveOutcome(d) === "open") { openTrades++; continue; }
      const t = trade(rid, d);
      if (t) trades.push(t);
    }
    trades.sort((a, b) => cmp(a.when, b.when) || (a.id - b.id));

    const periods = new Map();
    for (const t of trades) {
      const [k, label] = periodKey(t.day, group);
      if (!periods.has(k)) periods.set(k, { label, items: [] });
      periods.get(k).items.push(t);
    }
    const rows = [...periods.keys()].sort().map((k) => ({ key: k, label: periods.get(k).label, ...agg(periods.get(k).items) }));

    const days = new Map();
    for (const t of trades) {
      if (!days.has(t.day.iso)) days.set(t.day.iso, { trades: 0, pnl: 0, r: 0, pct: 0, hp: false, hr: false, hc: false });
      const a = days.get(t.day.iso);
      a.trades++;
      if (t.pnl != null) { a.pnl += t.pnl; a.hp = true; }
      if (t.r != null) { a.r += t.r; a.hr = true; }
      if (t.pct != null) { a.pct += t.pct; a.hc = true; }
    }
    const dayRows = {};
    for (const [k, v] of days) dayRows[k] = { trades: v.trades, pnl: v.hp ? r2(v.pnl) : null, r: v.hr ? r2(v.r) : null, pct: v.hc ? r2(v.pct) : null };

    let cp = 0, cr = 0, cc = 0;
    const equity = trades.map((t, i) => {
      cp += t.pnl || 0; cr += t.r || 0; cc += t.pct || 0;
      return { n: i + 1, day: t.day.iso, pnl: r2(cp), r: r2(cr), pct: r2(cc) };
    });

    const byWeekday = breakdown(trades, (t) => WEEKDAYS[JL.weekday(t.day)], 7);
    byWeekday.sort((a, b) => WEEKDAYS.indexOf(a.name) - WEEKDAYS.indexOf(b.name));
    return {
      group, from: start, to: end, summary: summary(trades, openTrades), undated,
      periods: rows, days: dayRows, equity,
      by_direction: breakdown(trades, (t) => t.direction), by_symbol: breakdown(trades, (t) => t.symbol),
      by_setup: setupRows(trades), by_rules: breakdown(trades, (t) => t.by_rules), by_weekday: byWeekday,
      by_emo_before: breakdown(trades, (t) => t.emo_before), by_emo_after: breakdown(trades, (t) => t.emo_after),
      by_mistake: breakdown(trades, (t) => t.mistakes),
    };
  }

  JL.stats = { compute, effectiveR, effectiveOutcome, effectiveDay, OUTCOMES, GROUPS, num };
})(typeof window !== "undefined" ? window : globalThis);
