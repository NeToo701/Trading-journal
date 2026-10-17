/* Журнал: статистика. Підсумки, крива результату, розбивка за днями, тижнями, місяцями, кварталами й роками,
   календар днів та розбивки за напрямком, інструментом, сетапом, днем тижня, емоціями й помилками.
   Усе рахує сервер із записів журналу; тут лише показ. Увесь текст вставляється через textContent. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, fmt } = JR;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const $ = (s, r) => (r || document).querySelector(s);

  const S = (JR.stats = {});
  const GROUPS = [["day", "Дні"], ["week", "Тижні"], ["month", "Місяці"], ["quarter", "Квартали"], ["year", "Роки"]];
  const MONTH_NAMES = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
  const WEEK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  let prefs = { group: "month", unit: "r", from: "", to: "" };
  let calMonth = null;                     // { y, m } для календаря днів
  let seq = 0, data = null, resizeObs = null;

  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, String(v));
    return n;
  };
  const unitLabel = (j) => (prefs.unit === "r" ? "R" : prefs.unit === "pct" ? "%" : j.currency);
  const val = (row) => (prefs.unit === "r" ? row.r : prefs.unit === "pct" ? row.pct : row.pnl);
  const pick = (s, base) => (prefs.unit === "r" ? s[base === "total" ? "r" : base + "_r"] : prefs.unit === "pct" ? s[base === "total" ? "pct" : base + "_pct"] : s[base === "total" ? "pnl" : base]);
  const show = (x, nd) => (x == null ? "—" : prefs.unit === "r" ? fmt.signed(x, nd == null ? 2 : nd) : fmt.signed(x, nd == null ? 2 : nd));
  const plain = (x, nd) => (x == null ? "—" : fmt.num(x, nd == null ? 2 : nd));

  // ---------------------------------------------------------------- каркас
  S.render = function (root) {
    root.replaceChildren();
    const j = JR.currentJournal();
    const group = el("div", { class: "jr-seg", role: "radiogroup", "aria-label": "Групування" },
      GROUPS.map(([v, t]) => el("label", null,
        el("input", { type: "radio", name: "jr-st-group", value: v, checked: prefs.group === v, onchange: () => { prefs.group = v; load(); } }),
        el("span", { text: t }))));
    const unit = el("div", { class: "jr-seg", role: "radiogroup", "aria-label": "Одиниці" },
      [["r", "У R"], ["pct", "У %"], ["pnl", "У " + j.currency]].map(([v, t]) => el("label", null,
        el("input", { type: "radio", name: "jr-st-unit", value: v, checked: prefs.unit === v, onchange: () => { prefs.unit = v; paint(); } }),
        el("span", { text: t }))));
    const from = el("input", { type: "date", "aria-label": "Від", value: prefs.from });
    const to = el("input", { type: "date", "aria-label": "До", value: prefs.to });
    const apply = () => { prefs.from = from.value; prefs.to = to.value; load(); };
    from.addEventListener("change", apply); to.addEventListener("change", apply);
    const quick = el("div", { class: "jr-quick" }, [["30 днів", 30], ["90 днів", 90], ["Цей рік", "year"], ["Усе", 0]].map(([t, v]) =>
      el("button", { type: "button", class: "jr-btn is-quiet", text: t, onclick: () => {
        const now = new Date(), pad = (n) => String(n).padStart(2, "0");
        const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        if (v === 0) { from.value = ""; to.value = ""; }
        else if (v === "year") { from.value = `${now.getFullYear()}-01-01`; to.value = iso(now); }
        else { const d = new Date(now); d.setDate(d.getDate() - v + 1); from.value = iso(d); to.value = iso(now); }
        apply();
      } })));
    root.append(
      el("div", { class: "jr-toolbar jr-stat-bar" }, group, unit,
        el("div", { class: "jr-filters" }, el("label", { class: "jr-range" }, el("span", { text: "Від" }), from), el("label", { class: "jr-range" }, el("span", { text: "До" }), to), quick)),
      el("div", { class: "jr-error", id: "jr-stat-error", role: "alert", hidden: true }),
      el("div", { id: "jr-stat-body", "aria-live": "polite" }, el("p", { class: "jr-dim", text: "Завантажую статистику…" })));
    load();
  };

  async function load() {
    const my = ++seq;
    const j = JR.currentJournal();
    const qs = new URLSearchParams({ group: prefs.group });
    if (prefs.from) qs.set("from", prefs.from);
    if (prefs.to) qs.set("to", prefs.to);
    try {
      const d = await JR.api.get(`/journals/${j.id}/stats?${qs}`);
      if (my !== seq) return;
      data = d; $("#jr-stat-error").hidden = true;
      paint();
    } catch (e) { if (my === seq && $("#jr-stat-error")) JR.showError($("#jr-stat-error"), e); }
  }

  // ---------------------------------------------------------------- малювання
  function paint() {
    const host = $("#jr-stat-body");
    if (!host || !data) return;
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    const j = JR.currentJournal(), s = data.summary;
    if (!s.trades) {
      host.replaceChildren(el("div", { class: "jr-empty" },
        el("h3", { text: "Поки немає закритих угод для статистики" }),
        el("p", { text: s.open_trades ? `Відкритих записів: ${s.open_trades}. Вони не рахуються, поки не стануть закритими.` : "Додай записи з результатом: прибутком чи збитком, або з ціною входу, стопом і виходом, тоді R порахується сам." }),
        data.undated ? el("p", { class: "jr-note", text: `Записів без дати: ${data.undated}.` }) : null));
      return;
    }
    host.replaceChildren(
      kpis(s, j),
      el("section", { class: "jr-card" }, el("h3", { text: "Крива результату" }), equity(j)),
      el("section", { class: "jr-card" }, el("h3", { text: "За періодами" }), periods(j)),
      el("section", { class: "jr-card" }, el("h3", { text: "Календар днів" }), calendar(j)),
      el("section", { class: "jr-card", id: "jr-setups-card" }, el("h3", { text: "Сетапи" }), setups(j)),
      el("div", { class: "jr-breakdowns" },
        breakdown("Напрямок", data.by_direction), breakdown("Інструмент", data.by_symbol), breakdown("День тижня", data.by_weekday),
        breakdown("Емоції до відкриття", data.by_emo_before), breakdown("Емоції після закриття", data.by_emo_after),
        breakdown("Ключові помилки", data.by_mistake), breakdown("Угода за правилами", data.by_rules)),
      ...(data.undated ? [el("p", { class: "jr-note", text: `Записів без дати, які не рахуються: ${data.undated}.` })] : []),
      el("p", { class: "jr-note", text: "Статистика рахується лише з твоїх записів і ніяк не пов'язана з розбором ринку на сайті. Дата угоди береться з поля «виходу», а якщо його немає, з поля «входу»." }));
  }

  function card(label, value, hint, cls) {
    return el("div", { class: "jr-kpi" }, el("span", { class: "jr-kpi-l", text: label }),
      el("strong", { class: "jr-kpi-v " + (cls || ""), text: value }), hint ? el("span", { class: "jr-kpi-h", text: hint }) : null);
  }

  function kpis(s, j) {
    const u = unitLabel(j);
    const total = pick(s, "total");
    const avg = prefs.unit === "r" ? s.avg_r : prefs.unit === "pct" ? s.avg_pct : s.avg_pnl;
    const best = prefs.unit === "r" ? s.best_r : prefs.unit === "pct" ? s.best_pct : s.best;
    const worst = prefs.unit === "r" ? s.worst_r : prefs.unit === "pct" ? s.worst_pct : s.worst;
    const dd = prefs.unit === "r" ? s.max_drawdown_r : prefs.unit === "pct" ? s.max_drawdown_pct : s.max_drawdown;
    return el("div", { class: "jr-kpis" },
      card("Результат", total == null ? "—" : `${show(total)} ${u}`, `${s.trades} угод`, fmt.sign(total)),
      card("Winrate", s.win_rate == null ? "—" : `${plain(s.win_rate, 1)}%`, `${s.wins} з ${s.trades}; збиткових ${s.losses}; беззбиток ${s.be}`),
      card("Профіт-фактор", s.profit_factor == null ? "—" : plain(s.profit_factor), "сума виграшів ÷ сума збитків"),
      card("Середня угода", avg == null ? "—" : `${show(avg)} ${u}`, null, fmt.sign(avg)),
      card("Співвідношення", s.payoff == null ? "—" : plain(s.payoff), "середній виграш ÷ середній збиток"),
      card("Макс. просадка", dd == null ? "—" : `${plain(dd)} ${u}`, "від піку кривої", dd ? "neg" : ""),
      card("Найкраща / найгірша", best == null ? "—" : `${show(best)} / ${show(worst)}`, u),
      card("Серії", `${s.win_streak} / ${s.loss_streak}`, "найдовша серія виграшів / збитків"),
      s.avg_discipline != null ? card("Дотримання плану", `${plain(s.avg_discipline, 1)} з 5`, "середня оцінка") : null,
      s.open_trades ? card("Відкриті", String(s.open_trades), "не рахуються у статистиці") : null);
  }

  // ---- крива результату
  function equity(j) {
    const pts = data.equity.map((p) => ({ n: p.n, day: p.day, v: prefs.unit === "r" ? p.r : prefs.unit === "pct" ? p.pct : p.pnl }));
    const wrap = el("div", { class: "jr-chart", role: "img", "aria-label": `Крива результату, ${pts.length} угод, підсумок ${show(pts[pts.length - 1].v)} ${unitLabel(j)}` });
    const tip = el("div", { class: "jr-tip", hidden: true });
    wrap.append(tip);
    const draw = () => {
      wrap.querySelectorAll("svg").forEach((n) => n.remove());
      const W = Math.max(280, wrap.clientWidth), H = W < 520 ? 200 : 260;
      const pad = { l: 52, r: 12, t: 12, b: 24 };
      const ys = [0, ...pts.map((p) => p.v)];
      let lo = Math.min(...ys), hi = Math.max(...ys);
      if (hi === lo) { hi += 1; lo -= 1; }
      const span = hi - lo; lo -= span * 0.06; hi += span * 0.06;
      const x = (i) => pad.l + (pts.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (pts.length - 1)) * (W - pad.l - pad.r));
      const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
      const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
      for (let g = 0; g <= 4; g++) {
        const v = lo + ((hi - lo) * g) / 4, yy = y(v);
        svg.append(svgEl("line", { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: "jr-grid" }));
        const t = svgEl("text", { x: pad.l - 8, y: yy + 4, "text-anchor": "end", class: "jr-axis" }); t.textContent = fmt.num(v, Math.abs(hi - lo) < 10 ? 2 : 0); svg.append(t);
      }
      svg.append(svgEl("line", { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: "jr-zero" }));
      const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
      const last = pts[pts.length - 1].v;
      svg.append(svgEl("path", { d: `${line} L${x(pts.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`, class: "jr-area " + (last >= 0 ? "is-pos" : "is-neg") }));
      svg.append(svgEl("path", { d: line, class: "jr-line " + (last >= 0 ? "is-pos" : "is-neg"), fill: "none" }));
      const a = svgEl("text", { x: pad.l, y: H - 6, class: "jr-axis" }); a.textContent = fmt.dateTime(pts[0].day); svg.append(a);
      const b = svgEl("text", { x: W - pad.r, y: H - 6, "text-anchor": "end", class: "jr-axis" }); b.textContent = fmt.dateTime(pts[pts.length - 1].day); svg.append(b);
      const dot = svgEl("circle", { r: 4, class: "jr-dot", hidden: "hidden" }); dot.style.display = "none"; svg.append(dot);
      const move = (ev) => {
        const r = svg.getBoundingClientRect(), px = ev.clientX - r.left;
        const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1))));
        const p = pts[i];
        dot.style.display = ""; dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(p.v));
        tip.hidden = false; tip.textContent = `Угода ${p.n}, ${fmt.dateTime(p.day)}: ${show(p.v)} ${unitLabel(j)}`;
        tip.style.left = Math.min(Math.max(x(i) - 70, 0), W - 180) + "px"; tip.style.top = Math.max(y(p.v) - 38, 0) + "px";
      };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerleave", () => { tip.hidden = true; dot.style.display = "none"; });
      wrap.prepend(svg);
    };
    requestAnimationFrame(draw);
    if (window.ResizeObserver) { let w = 0; resizeObs = new ResizeObserver(() => { if (wrap.clientWidth !== w) { w = wrap.clientWidth; draw(); } }); resizeObs.observe(wrap); }
    return wrap;
  }

  // ---- періоди
  function periods(j) {
    const rows = data.periods.slice().reverse();                      // найновіші зверху
    const max = Math.max(1e-9, ...rows.map((r) => Math.abs(val(r) || 0)));
    const u = unitLabel(j);
    const body = rows.map((r) => {
      const v = val(r);
      const bar = el("span", { class: "jr-bar " + (v >= 0 ? "is-pos" : "is-neg") });
      bar.style.width = (v == null ? 0 : (Math.abs(v) / max) * 50) + "%";
      return el("tr", null,
        el("th", { scope: "row", text: r.label }),
        el("td", { "data-label": "Угод", text: String(r.trades) }),
        el("td", { "data-label": "Winrate", text: r.win_rate == null ? "—" : `${plain(r.win_rate, 0)}% (${r.wins}/${r.trades})` }),
        el("td", { "data-label": "Результат, " + u, class: "jr-num " + fmt.sign(v), text: v == null ? "—" : show(v) }),
        el("td", { class: "jr-barcell", "aria-hidden": "true" }, el("span", { class: "jr-barbox" }, bar)));
    });
    return el("div", { class: "jr-table-wrap" }, el("table", { class: "jr-table jr-table-static" },
      el("thead", null, el("tr", null, el("th", { scope: "col", text: "Період" }), el("th", { scope: "col", text: "Угод" }), el("th", { scope: "col", text: "Winrate" }), el("th", { scope: "col", text: "Результат, " + u }), el("th", { scope: "col", class: "jr-barcell", text: "" }))),
      el("tbody", null, body)));
  }

  // ---- календар днів
  function calendar(j) {
    const keys = Object.keys(data.days).sort();
    if (!calMonth) { const last = keys[keys.length - 1] || new Date().toISOString().slice(0, 10); calMonth = { y: +last.slice(0, 4), m: +last.slice(5, 7) - 1 }; }
    const host = el("div", { class: "jr-cal" });
    const render = () => {
      const { y, m } = calMonth;
      const first = new Date(y, m, 1), lead = (first.getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
      const vals = Object.entries(data.days).filter(([k]) => +k.slice(0, 4) === y && +k.slice(5, 7) === m + 1).map(([, v]) => Math.abs(val(v) || 0));
      const max = Math.max(1e-9, ...vals);
      const cells = [];
      for (let i = 0; i < lead; i++) cells.push(el("div", { class: "jr-day is-blank", "aria-hidden": "true" }));
      let total = 0, tradesN = 0;
      for (let d = 1; d <= days; d++) {
        const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const row = data.days[key];
        const v = row ? val(row) : null;
        if (row) { total += v || 0; tradesN += row.trades; }
        const c = el("div", { class: "jr-day" + (row ? " has-data " + (v > 0 ? "is-pos" : v < 0 ? "is-neg" : "") : ""), role: "listitem",
                              "aria-label": row ? `${d} ${MONTH_NAMES[m]}: угод ${row.trades}, ${show(v)} ${unitLabel(j)}` : `${d} ${MONTH_NAMES[m]}: угод немає` },
          el("span", { class: "jr-day-n", text: String(d) }),
          row ? el("span", { class: "jr-day-v", text: v == null ? "—" : show(v, prefs.unit === "r" ? 2 : 0) }) : null,
          row ? el("span", { class: "jr-day-t", text: `${row.trades} уг.` }) : null);
        if (row && v) c.style.setProperty("--i", String(0.18 + 0.62 * (Math.abs(v) / max)));
        cells.push(c);
      }
      const step = (d) => { const t = new Date(y, m + d, 1); calMonth = { y: t.getFullYear(), m: t.getMonth() }; render(); };
      host.replaceChildren(
        el("div", { class: "jr-cal-head" },
          el("button", { type: "button", class: "jr-btn", "aria-label": "Попередній місяць", text: "←", onclick: () => step(-1) }),
          el("strong", { text: `${MONTH_NAMES[m]} ${y}` }),
          el("button", { type: "button", class: "jr-btn", "aria-label": "Наступний місяць", text: "→", onclick: () => step(1) }),
          el("span", { class: "jr-dim jr-cal-sum", text: tradesN ? `Угод ${tradesN}, результат ${show(total)} ${unitLabel(j)}` : "Угод у місяці немає" })),
        el("div", { class: "jr-cal-week", "aria-hidden": "true" }, WEEK_SHORT.map((w) => el("span", { text: w }))),
        el("div", { class: "jr-cal-grid", role: "list" }, cells));
    };
    render();
    return host;
  }

  // ---- сетапи: окрема статистика за кожною назвою
  function setups(j) {
    const rows = data.by_setup || [];
    if (!rows.length) return el("p", { class: "jr-dim", text: "Сетапів ще немає. Вказуй назву сетапу в записах, і тут з'явиться статистика за кожним із них." });
    const u = unitLabel(j);
    const best = rows.filter((r) => r.trades >= 3).sort((a, b) => (b.avg_r ?? -1e9) - (a.avg_r ?? -1e9))[0];
    return el("div", null,
      el("div", { class: "jr-table-wrap" }, el("table", { class: "jr-table jr-table-static", id: "jr-setups-table" },
        el("thead", null, el("tr", null, ["Сетап", "Угод", "Winrate", "Профіт-фактор", "Сер. результат, R", "Результат, " + u].map((t) => el("th", { scope: "col", text: t })))),
        el("tbody", null, rows.map((r) => {
          const v = val(r);
          return el("tr", null,
            el("th", { scope: "row", text: r.name }),
            el("td", { "data-label": "Угод", text: String(r.trades) }),
            el("td", { "data-label": "Winrate", text: r.win_rate == null ? "—" : `${plain(r.win_rate, 0)}% (${r.wins}/${r.trades})` }),
            el("td", { "data-label": "Профіт-фактор", text: r.profit_factor == null ? "—" : plain(r.profit_factor) }),
            el("td", { "data-label": "Сер. результат, R", class: "jr-num " + fmt.sign(r.avg_r), text: r.avg_r == null ? "—" : show(r.avg_r) }),
            el("td", { "data-label": "Результат, " + u, class: "jr-num " + fmt.sign(v), text: v == null ? "—" : show(v) }));
        })))),
      best ? el("p", { class: "jr-note", text: `Найкращий середній результат серед сетапів із 3 і більше угодами: «${best.name}» (${show(best.avg_r)} R на угоду). Малі вибірки статистично ненадійні, дивись на тренд, а не на одне число.` }) : null);
  }

  // ---- розбивки
  function breakdown(title, rows) {
    if (!rows || !rows.length) return el("section", { class: "jr-card jr-mini" }, el("h3", { text: title }), el("p", { class: "jr-dim", text: "Немає даних. Заповнюй це поле в записах." }));
    return el("section", { class: "jr-card jr-mini" }, el("h3", { text: title }),
      el("table", { class: "jr-table jr-table-static jr-mini-table" },
        el("thead", null, el("tr", null, el("th", { scope: "col", text: "Значення" }), el("th", { scope: "col", text: "Угод" }), el("th", { scope: "col", text: "Winrate" }), el("th", { scope: "col", text: unitLabel(JR.currentJournal()) }))),
        el("tbody", null, rows.map((r) => {
          const v = val(r);
          return el("tr", null, el("th", { scope: "row", text: r.name }), el("td", { text: String(r.trades) }),
            el("td", { text: r.win_rate == null ? "—" : `${plain(r.win_rate, 0)}%` }), el("td", { class: "jr-num " + fmt.sign(v), text: v == null ? "—" : show(v) }));
        }))));
  }

  S.reset = () => { data = null; calMonth = null; seq++; };
})();
