/* Бектести: окремий розділ (#backtest). Колекції угод з історичних тестів стратегії: мінімум полів (дата, інструмент, напрямок, сетап,
   результат у R, нотатка) і коротка статистика (Winrate, сума й середній R, profit factor, просадка, серії, крива результату, розбивки).
   Усе рахується в lib/jl-backtest.js, тут лише показ. Увесь текст вставляється через textContent. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, fmt } = JR;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const $ = (s, r) => (r || document).querySelector(s);
  const B = (JR.backtest = {});
  const LAST_KEY = "journal.bt.last.v1", SORT_KEY = "journal.bt.sort.v1", BY_KEY = "journal.bt.by.v1";
  const PAGE = 100;
  const QUICK_R = [-1, 0, 1, 2, 3];

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* без збереження теж працює */ } };

  let cols = [], current = null, data = null, shown = 0;
  let by = Object.keys(window.JL.bt.BREAKDOWNS).includes(lsGet(BY_KEY)) ? lsGet(BY_KEY) : "setup";
  let newestFirst = lsGet(SORT_KEY) !== "asc";
  let memo = null;                       // останні дата, інструмент, напрямок і сетап: підставляються в наступну нову угоду
  let resizeObs = null;

  const side = () => $("#bt-side");
  const main = () => $("#bt-main");
  const sg = (x, d = 2) => (x == null ? "—" : fmt.signed(x, d));
  const num = (x, d = 2) => (x == null ? "—" : fmt.num(x, d));
  const cls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
  const rText = (r) => String(r).replace(".", ",");

  // ---------------------------------------------------------------- завантаження
  async function loadCols() { cols = (await JR.api.get("/backtests")).backtests; }
  async function loadCurrent() {
    data = await JR.api.get(`/backtests/${current}`);
    shown = PAGE;
    renderMain();
  }
  const anyDialog = () => !!document.querySelector("dialog[open].jr-dialog");

  /** Викликається при кожному відкритті розділу: підтягує колекції й показує вибрану. */
  B.show = async function () {
    try {
      await loadCols();
      const want = Number(lsGet(LAST_KEY));
      const pick = cols.find((c) => c.id === current) || cols.find((c) => c.id === want) || cols[0] || null;
      current = pick ? pick.id : null;
      renderSide();
      if (current) await loadCurrent(); else { data = null; renderEmpty(); }
    } catch (e) {
      main().replaceChildren(el("section", { class: "jr-gate" }, el("h1", { text: "Не вдалося відкрити бектести" }), el("p", { text: e.message || String(e) }),
        el("div", { class: "jr-actions" }, el("button", { type: "button", class: "jr-btn is-primary", text: "Спробувати ще раз", onclick: () => B.show() }))));
    }
  };

  async function select(id) {
    current = id; lsSet(LAST_KEY, String(id));
    document.body.classList.remove("jr-side-open");
    renderSide();
    try { await loadCurrent(); } catch (e) { JR.toast(e.message, "error"); }
  }

  /** Після змін: оновити список (лічильники) і вміст, не закриваючи відкрите вікно. */
  async function refresh() {
    await loadCols();
    if (!cols.find((c) => c.id === current)) { current = cols[0] ? cols[0].id : null; }
    renderSide();
    if (current) await loadCurrent(); else { data = null; renderEmpty(); }
  }

  // ---------------------------------------------------------------- бічна панель
  function renderSide() {
    side().replaceChildren(
      el("section", { class: "jr-side-block", "aria-labelledby": "bt-side-h" },
        el("h2", { id: "bt-side-h", text: "Колекції бектестів" }),
        cols.length ? el("ul", { class: "jr-jlist" }, cols.map((c) => el("li", null,
          el("button", { type: "button", class: "jr-jbtn", "data-id": String(c.id), "aria-current": c.id === current ? "true" : null, onclick: () => select(c.id) },
            el("span", { class: "jr-jname", text: c.name }),
            el("span", { class: "jr-jcount", text: String(c.trades || 0), title: "Угод", "aria-label": `${c.trades || 0} угод` })))))
          : el("p", { class: "jr-dim jr-side-empty", text: "Колекцій ще немає" }),
        el("button", { type: "button", class: "jr-btn is-quiet jr-add", id: "bt-add-col", text: "+ Нова колекція", onclick: createCol })),
      el("p", { class: "jr-note", text: "Колекція це окремий бектест: наприклад «Пробій діапазону, BTC 2023» або «Відбій від рівня, EURUSD». У кожної своя статистика." }));
  }

  function renderEmpty() {
    main().replaceChildren(el("section", { class: "jr-gate", id: "bt-gate" },
      el("h1", { text: "Створи першу колекцію бектесту" }),
      el("p", { text: "Колекція це окремий бектест стратегії. Записуй у неї угоди з історичних тестів: дату, інструмент, напрямок, сетап і результат у R. Зверху автоматично рахується статистика й крива результату." }),
      el("div", { class: "jr-actions" },
        el("button", { type: "button", class: "jr-btn jr-only-narrow", text: "Колекції", onclick: toggleSide }),
        el("button", { type: "button", class: "jr-btn is-primary", id: "bt-create-first", text: "Нова колекція", onclick: createCol }))));
  }

  function toggleSide() {
    const open = document.body.classList.toggle("jr-side-open");
    const b = $("#bt-side-toggle"); if (b) b.setAttribute("aria-expanded", String(open));
  }

  // ---------------------------------------------------------------- вміст колекції
  function renderMain() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    const c = data.backtest, st = data.stats, n = data.trades.length;
    const period = st.first_day ? `, період ${fmt.dateTime(st.first_day)} – ${fmt.dateTime(st.last_day)}` : "";
    const head = el("header", { class: "jr-head" },
      el("div", { class: "jr-title" },
        el("h1", { id: "bt-h1", text: c.name }),
        el("p", { class: "jr-dim" }, el("span", { class: "jr-badge", text: "Бектест" }), `угод ${n}${c.risk_pct != null ? `, ризик ${num(c.risk_pct)}% на угоду` : ""}${period}`),
        c.note ? el("p", { class: "jr-note bt-colnote", text: c.note }) : null),
      el("div", { class: "jr-head-actions" },
        el("button", { type: "button", class: "jr-btn jr-only-narrow", id: "bt-side-toggle", "aria-expanded": String(document.body.classList.contains("jr-side-open")), "aria-controls": "bt-side", text: "Колекції", onclick: toggleSide }),
        el("button", { type: "button", class: "jr-btn is-primary", id: "bt-new-trade", text: "+ Нова угода", onclick: () => tradeForm(null) }),
        el("button", { type: "button", class: "jr-btn", id: "bt-edit-col", text: "Змінити", title: "Назва, опис і ризик на угоду", onclick: () => colForm(c) }),
        el("button", { type: "button", class: "jr-btn", id: "bt-export", text: "Експорт CSV", title: "Угоди колекції в таблицю для Excel", onclick: exportCsv }),
        el("button", { type: "button", class: "jr-btn is-danger-quiet", id: "bt-delete", text: "Видалити", onclick: deleteCol })));
    if (!n) {
      main().replaceChildren(head, el("div", { class: "jr-empty", id: "bt-empty" },
        el("h3", { text: "У цій колекції ще немає угод" }),
        el("p", { text: "Додай першу угоду з бектесту: достатньо вказати результат у R. Решту полів можна заповнити для зручнішої статистики." }),
        el("button", { type: "button", class: "jr-btn is-primary", id: "bt-first-trade", text: "+ Нова угода", onclick: () => tradeForm(null) })));
      return;
    }
    main().replaceChildren(head, kpis(st),
      el("section", { class: "jr-card bt-card", id: "bt-equity", "aria-label": "Крива результату" }, el("h3", { text: "Крива результату, R" }), equity(st)),
      breakdownCard(st), tradesCard());
  }

  function kpi(label, value, hint, sign, id) {
    return el("div", { class: "jr-kpi", id }, el("span", { class: "jr-kpi-l", text: label }), el("span", { class: "jr-kpi-v" + (sign ? " " + sign : ""), text: value }), hint ? el("span", { class: "jr-kpi-h", text: hint }) : null);
  }

  function kpis(s) {
    const pf = s.profit_factor;
    return el("div", { class: "jr-kpis", id: "bt-kpis" },
      kpi("Угод", String(s.trades), `${s.wins} прибуткових, ${s.losses} збиткових, ${s.be} в нуль`, "", "bt-k-trades"),
      kpi("Winrate", s.win_rate == null ? "—" : `${num(s.win_rate, 1)}%`, "частка прибуткових угод", "", "bt-k-winrate"),
      kpi("Результат", `${sg(s.total_r)} R`, s.return_pct != null ? `≈ ${sg(s.return_pct)}% рахунку при ризику ${num(s.risk_pct)}% на угоду` : "сума результатів усіх угод", cls(s.total_r), "bt-k-total"),
      kpi("Середній R", `${sg(s.avg_r)} R`, "очікування на одну угоду", cls(s.avg_r), "bt-k-avg"),
      kpi("Profit factor", pf == null ? "—" : num(pf), pf == null ? (s.wins ? "немає збиткових угод" : "потрібні прибуткові й збиткові") : "сума виграшів ÷ сума збитків", "", "bt-k-pf"),
      kpi("Макс. просадка", s.max_drawdown_r ? `−${num(s.max_drawdown_r)} R` : "0 R", s.max_drawdown_pct ? `≈ −${num(s.max_drawdown_pct)}% рахунку` : "від піку кривої результату", s.max_drawdown_r ? "neg" : "", "bt-k-dd"),
      kpi("Серії", `${s.win_streak} / ${s.loss_streak}`, "найдовші: прибуткових / збиткових поспіль", "", "bt-k-streak"),
      kpi("Виграш / збиток", `${sg(s.avg_win_r)} / ${sg(s.avg_loss_r)}`, `середні в R${s.payoff != null ? `, співвідношення ${num(s.payoff)}` : ""}. Краща угода ${sg(s.best_r)}, гірша ${sg(s.worst_r)}`, "", "bt-k-avgwl"));
  }

  // ---------------------------------------------------------------- крива результату
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, String(v));
    return n;
  };
  function equity(st) {
    const pts = st.equity;
    const wrap = el("div", { class: "jr-chart", role: "img", "aria-label": `Крива результату, ${pts.length} угод, підсумок ${sg(pts[pts.length - 1].r)} R` });
    const tip = el("div", { class: "jr-tip", hidden: true });
    wrap.append(tip);
    const draw = () => {
      wrap.querySelectorAll("svg").forEach((x) => x.remove());
      const W = Math.max(280, wrap.clientWidth), H = W < 520 ? 200 : 260;
      const pad = { l: 52, r: 12, t: 12, b: 24 };
      const ys = [0, ...pts.map((p) => p.r)];
      let lo = Math.min(...ys), hi = Math.max(...ys);
      if (hi === lo) { hi += 1; lo -= 1; }
      const span = hi - lo; lo -= span * 0.06; hi += span * 0.06;
      const x = (i) => pad.l + (pts.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (pts.length - 1)) * (W - pad.l - pad.r));
      const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
      const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
      for (let g = 0; g <= 4; g++) {
        const v = lo + ((hi - lo) * g) / 4, yy = y(v);
        svg.append(svgEl("line", { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: "jr-grid" }));
        const t = svgEl("text", { x: pad.l - 8, y: yy + 4, "text-anchor": "end", class: "jr-axis" }); t.textContent = fmt.num(v, hi - lo < 10 ? 2 : 0); svg.append(t);
      }
      svg.append(svgEl("line", { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: "jr-zero" }));
      const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.r).toFixed(1)}`).join(" ");
      const last = pts[pts.length - 1].r;
      svg.append(svgEl("path", { d: `${line} L${x(pts.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`, class: "jr-area " + (last >= 0 ? "is-pos" : "is-neg") }));
      svg.append(svgEl("path", { d: line, class: "jr-line " + (last >= 0 ? "is-pos" : "is-neg"), fill: "none" }));
      const left = svgEl("text", { x: pad.l, y: H - 6, class: "jr-axis" }); left.textContent = pts[0].day ? fmt.dateTime(pts[0].day) : "угода 1"; svg.append(left);
      const right = svgEl("text", { x: W - pad.r, y: H - 6, "text-anchor": "end", class: "jr-axis" }); right.textContent = pts[pts.length - 1].day ? fmt.dateTime(pts[pts.length - 1].day) : `угода ${pts.length}`; svg.append(right);
      const dot = svgEl("circle", { r: 4, class: "jr-dot" }); dot.style.display = "none"; svg.append(dot);
      svg.addEventListener("pointermove", (ev) => {
        const r = svg.getBoundingClientRect(), px = ev.clientX - r.left;
        const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1))));
        const p = pts[i];
        dot.style.display = ""; dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(p.r));
        tip.hidden = false; tip.textContent = `Угода ${p.n}${p.day ? ", " + fmt.dateTime(p.day) : ""}: ${sg(p.v, 3)} R, разом ${sg(p.r)} R`;
        tip.style.left = Math.min(Math.max(x(i) - 80, 0), W - 220) + "px"; tip.style.top = Math.max(y(p.r) - 38, 0) + "px";
      });
      svg.addEventListener("pointerleave", () => { tip.hidden = true; dot.style.display = "none"; });
      wrap.prepend(svg);
    };
    requestAnimationFrame(draw);
    if (window.ResizeObserver) { let w = 0; resizeObs = new ResizeObserver(() => { if (wrap.clientWidth !== w) { w = wrap.clientWidth; draw(); } }); resizeObs.observe(wrap); }
    return wrap;
  }

  // ---------------------------------------------------------------- розбивки
  function breakdownCard(st) {
    const labels = window.JL.bt.BREAKDOWNS;
    const seg = el("div", { class: "jr-seg", role: "radiogroup", "aria-label": "Розбивка за" },
      Object.entries(labels).map(([v, t]) => el("label", null,
        el("input", { type: "radio", name: "bt-by", value: v, checked: by === v, onchange: () => { by = v; lsSet(BY_KEY, v); paint(); } }),
        el("span", { text: t }))));
    const body = el("div", { id: "bt-by-body" });
    const paint = () => {
      const rows = st.breakdowns[by];
      if (rows.length === 1 && rows[0].key === "") {
        body.replaceChildren(el("p", { class: "jr-dim", id: "bt-by-empty", text: by === "month" ? "Вкажи дати угод, щоб бачити розбивку за місяцями." : `Заповнюй поле «${labels[by]}» в угодах, щоб бачити розбивку.` }));
        return;
      }
      body.replaceChildren(el("div", { class: "jr-table-wrap" }, el("table", { class: "jr-table jr-table-static", id: "bt-by-table" },
        el("thead", null, el("tr", null, [labels[by], "Угод", "Winrate", "Результат, R", "Середній R", "Profit factor"].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", null, rows.map((r) => el("tr", null,
          el("th", { scope: "row", text: r.label }),
          el("td", { "data-label": "Угод", class: "jr-num", text: String(r.trades) }),
          el("td", { "data-label": "Winrate", class: "jr-num", text: r.win_rate == null ? "—" : `${num(r.win_rate, 1)}%` }),
          el("td", { "data-label": "Результат, R", class: "jr-num " + cls(r.total_r), text: sg(r.total_r) }),
          el("td", { "data-label": "Середній R", class: "jr-num " + cls(r.avg_r), text: sg(r.avg_r) }),
          el("td", { "data-label": "Profit factor", class: "jr-num", text: r.profit_factor == null ? "—" : num(r.profit_factor) })))))));
    };
    paint();
    return el("section", { class: "jr-card bt-card", id: "bt-breakdown", "aria-label": "Розбивки" }, el("div", { class: "jr-toolbar bt-card-bar" }, el("h3", { text: "Розбивка" }), seg), body);
  }

  // ---------------------------------------------------------------- таблиця угод
  function tradesCard() {
    const rows = newestFirst ? [...data.trades].reverse() : data.trades;
    const sort = el("select", { id: "bt-sort", "aria-label": "Порядок угод", onchange: (ev) => { newestFirst = ev.target.value === "new"; lsSet(SORT_KEY, newestFirst ? "new" : "asc"); renderMain(); } },
      el("option", { value: "new", text: "Спочатку нові", selected: newestFirst }), el("option", { value: "asc", text: "Спочатку старі", selected: !newestFirst }));
    const open = (t) => tradeForm(t);
    const head = el("tr", null, ["№", "Дата", "Інструмент", "Напрямок", "Сетап", "Результат, R", "Скріншоти", "Нотатка"].map((h) => el("th", { scope: "col", text: h })));
    const body = el("tbody", { id: "bt-list" });
    const more = el("div", { class: "jr-more" });
    const paintRows = () => {
      body.replaceChildren(...rows.slice(0, shown).map((t) => {
        const tr = el("tr", { class: "jr-row", tabindex: "0", "data-id": String(t.id), role: "button", "aria-label": `Угода ${t.n}: ${sg(t.r, 3)} R. Відкрити для редагування`,
          onclick: () => open(t), onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(t); } } },
          el("td", { "data-label": "№", class: "jr-num jr-dim", text: String(t.n) }),
          el("td", { "data-label": "Дата", class: "jr-num", text: t.date ? fmt.dateTime(t.date) : "—" }),
          el("td", { "data-label": "Інструмент", text: t.symbol || "—" }),
          el("td", { "data-label": "Напрямок" }, t.direction ? el("span", { class: "jr-pill " + (t.direction === "Лонг" ? "is-long" : "is-short"), text: t.direction }) : "—"),
          el("td", { "data-label": "Сетап", text: t.setup || "—" }),
          el("td", { "data-label": "Результат, R", class: "jr-num " + cls(t.r), text: sg(t.r, 3) }),
          el("td", { "data-label": "Скріншоти", class: "bt-shots" }, t.shots ? el("button", { type: "button", class: "jr-btn is-quiet bt-shot", "aria-label": `Відкрити скріншоти угоди ${t.n}: ${t.shots}`, title: "Відкрити скріншоти", onclick: (ev) => { ev.stopPropagation(); showShots(t); } },
            el("span", { "aria-hidden": "true", text: "📷" }), ` ${t.shots}`) : "—"),
          el("td", { "data-label": "Нотатка", class: "bt-note", title: t.note || null, text: t.note || "—" }));
        return tr;
      }));
      more.replaceChildren(rows.length > shown ? el("button", { type: "button", class: "jr-btn", id: "bt-more", text: `Показати ще (${Math.min(PAGE, rows.length - shown)} з ${rows.length - shown})`, onclick: () => { shown += PAGE; paintRows(); } }) : null);
    };
    paintRows();
    return el("section", { class: "jr-card bt-card", id: "bt-trades", "aria-label": "Угоди колекції" },
      el("div", { class: "jr-toolbar bt-card-bar" }, el("h3", { text: `Угоди (${rows.length})` }), sort),
      el("div", { class: "jr-table-wrap" }, el("table", { class: "jr-table" }, el("thead", null, head), body)), more);
  }

  async function showShots(t) {
    try {
      const { media } = await JR.api.get(`/backtest-trades/${t.id}/media`);
      if (media.length) JR.entries.lightbox(media, media[0].id);
    } catch (e) { JR.toast(e.message, "error"); }
  }

  // ---------------------------------------------------------------- форма угоди
  async function tradeForm(trade) {
    if (!JR.state.meta) { try { await JR.loadMeta(); } catch (e) { JR.toast(e.message, "error"); return; } }
    // скріншоти вже збереженої угоди підвантажуються лише тут (в таблиці лише їх кількість)
    const shotsEntry = { media: [] };
    if (trade && trade.shots) { try { shotsEntry.media = (await JR.api.get(`/backtest-trades/${trade.id}/media`)).media; } catch (e) { JR.toast(e.message, "error"); return; } }
    const symbols = [...new Set(data.trades.map((t) => t.symbol).filter(Boolean))];
    const setups = [...new Set(data.trades.map((t) => t.setup).filter(Boolean))];
    const last = data.trades.length ? data.trades[data.trades.length - 1] : null;
    const start = trade || (memo ? { ...memo } : last ? { date: last.date, symbol: last.symbol, direction: last.direction, setup: last.setup } : {});
    const err = el("div", { class: "jr-error", role: "alert", hidden: true });
    const status = el("p", { class: "jr-note bt-status", id: "bt-trade-status", role: "status" });
    const date = el("input", { type: "date", id: "bt-f-date", value: start.date || "" });
    const symbol = el("input", { type: "text", id: "bt-f-symbol", value: start.symbol || "", maxlength: "20", list: "bt-dl-symbols", autocomplete: "off", placeholder: "Наприклад BTCUSDT" });
    const setup = el("input", { type: "text", id: "bt-f-setup", value: start.setup || "", maxlength: "40", list: "bt-dl-setups", autocomplete: "off", placeholder: "Наприклад Пробій діапазону" });
    const dir = [["", "—"], ["Лонг", "Лонг"], ["Шорт", "Шорт"]].map(([v, t]) =>
      el("label", { class: "jr-chip" }, el("input", { type: "radio", name: "bt-f-dir", value: v, checked: (start.direction || "") === v }), el("span", { text: t })));
    const r = el("input", { type: "text", id: "bt-f-r", inputmode: "decimal", autocomplete: "off", value: trade ? rText(trade.r) : "", placeholder: "Наприклад 2 або -1", "aria-describedby": "bt-r-hint" });
    const note = el("textarea", { id: "bt-f-note", rows: "2", maxlength: "500", placeholder: "Що було на графіку, чому така угода (необов'язково)" });
    note.value = trade ? trade.note || "" : "";
    const hint = el("small", { id: "bt-r-hint", class: "jr-rhint" });
    const showHint = () => {
      const v = window.JL.bt.parseNum(r.value);
      if (v === undefined) { hint.textContent = "Результат у R: 1 R це розмір ризику. Прибуток +2 R, стоп -1 R."; return; }
      if (!Number.isFinite(v)) { hint.textContent = "Потрібне число, наприклад 1,5 або -1."; return; }
      const o = window.JL.bt.outcome(v);
      hint.textContent = o === "win" ? "Прибуткова угода" : o === "loss" ? "Збиткова угода" : "Беззбиток (до ±0,05 R)";
    };
    r.addEventListener("input", showHint); showHint();
    const quick = el("div", { class: "bt-quick", role: "group", "aria-label": "Швидкий результат" },
      el("span", { class: "jr-dim", text: "Швидко:" }),
      QUICK_R.map((q) => el("button", { type: "button", class: "jr-btn is-quiet bt-q", text: q > 0 ? `+${q}` : q < 0 ? `−${-q}` : "0", title: `${q} R`, onclick: () => { r.value = String(q); showHint(); r.focus(); } })));

    // скріншоти: та сама секція, що у записах журналу (перетягування, Ctrl+V, кнопка «Вставити», перегляд на весь екран), лише фото
    const pending = [], uploaded = [];
    let touched = false, saved = trade, busy = false;
    const mkShots = () => JR.entries.mediaSection({ key: "shots", label: "Скріншоти" }, shotsEntry, pending, true, { imagesOnly: true, onChange: () => { touched = true; } });
    let shots = mkShots();
    const revoke = () => { [...pending, ...uploaded].forEach((p) => URL.revokeObjectURL(p.url)); };

    const res = await JR.modal((done) => {
      const buttons = () => [...form.querySelectorAll(".jr-actions button")];
      const body = () => ({ date: date.value, symbol: symbol.value, direction: (form.querySelector('input[name="bt-f-dir"]:checked') || { value: "" }).value, setup: setup.value, r: r.value, note: note.value });
      // закриття (×, «Скасувати», Esc) не губить додані, але ще не збережені скріншоти мовчки
      const askClose = async () => {
        if (busy) return;
        if (pending.length) {
          const ok = await JR.confirm({ title: "Закрити без збереження?", text: "Додані скріншоти ще не збережені. Вони зникнуть.", ok: "Закрити без збереження", danger: true });
          if (!ok) return;
        }
        done(false);
      };
      closeForm = askClose;
      const form = el("form", { class: "jr-entry-form", novalidate: true, onsubmit: async (ev) => {
        ev.preventDefault();
        if (busy) return;
        err.hidden = true; status.textContent = "";
        const next = !trade && !saved && !!ev.submitter && ev.submitter.dataset.next === "1";
        busy = true; buttons().forEach((x) => { x.disabled = true; });
        const free = () => { busy = false; buttons().forEach((x) => { x.disabled = false; }); };
        const b = body();
        try {
          if (saved) saved = (await JR.api.put(`/backtest-trades/${saved.id}`, b)).trade;
          else saved = (await JR.api.post(`/backtests/${current}/trades`, b)).trade;
          if (!trade) memo = { date: b.date, symbol: b.symbol.trim().toUpperCase(), direction: b.direction, setup: b.setup.trim() };
        } catch (e) { JR.showError(err, e); free(); return; }
        const failed = [];
        for (const p of pending.slice()) {
          p.setStatus("Завантажую…");
          try {
            await JR.api.upload(`/backtest-trades/${saved.id}/media?name=${encodeURIComponent(p.file.name)}`, p.file);
            pending.splice(pending.indexOf(p), 1); uploaded.push(p); touched = true; p.setStatus("Готово");
          } catch (e) { failed.push(`${p.file.name}: ${e.message}`); p.setStatus("Помилка", true); }
        }
        try { await refresh(); } catch (e) { /* список оновиться при наступній дії */ }
        if (failed.length) {          // угоду збережено, але частина скріншотів не пройшла: форма лишається відкритою (далі це правка)
          JR.showError(err, new Error("Угоду збережено, але не всі скріншоти завантажились. " + failed.join(" ")));
          free(); return;
        }
        if (next) {
          r.value = ""; note.value = ""; showHint(); saved = null;
          revoke(); uploaded.length = 0; shotsEntry.media = [];
          const fresh = mkShots(); shots.replaceWith(fresh); shots = fresh;
          status.textContent = `Додано. Усього угод у колекції: ${data.trades.length}. Вводь наступну.`; free(); r.focus();
        } else { JR.toast(trade ? "Угоду збережено" : "Угоду додано"); done(true); }
      } },
        el("div", { class: "jr-dlg-head" }, el("h2", { id: "jr-dlg-title", text: trade ? `Угода ${trade.n}` : "Нова угода бектесту" }),
          el("button", { type: "button", class: "jr-x", "aria-label": "Закрити", text: "×", onclick: () => askClose() })),
        el("div", { class: "jr-grid" },
          el("div", { class: "jr-field" }, el("label", { for: "bt-f-date", text: "Дата" }), date),
          el("div", { class: "jr-field" }, el("label", { for: "bt-f-symbol", text: "Інструмент" }), symbol),
          el("div", { class: "jr-field" }, el("span", { class: "jr-lbl", id: "bt-f-dir-l", text: "Напрямок" }), el("div", { class: "jr-chips", role: "radiogroup", "aria-labelledby": "bt-f-dir-l" }, dir)),
          el("div", { class: "jr-field" }, el("label", { for: "bt-f-setup", text: "Сетап" }), setup),
          el("div", { class: "jr-field is-wide" }, el("label", { for: "bt-f-r", text: "Результат, R (обов'язково)" }), r, quick, hint),
          el("div", { class: "jr-field is-wide" }, el("label", { for: "bt-f-note", text: "Нотатка" }), note)),
        el("datalist", { id: "bt-dl-symbols" }, symbols.map((s) => el("option", { value: s }))),
        el("datalist", { id: "bt-dl-setups" }, setups.map((s) => el("option", { value: s }))),
        shots, err, status,
        el("div", { class: "jr-actions" },
          trade ? el("button", { type: "button", class: "jr-btn is-danger-quiet", id: "bt-del-trade", text: "Видалити", onclick: async () => {
            const ok = await JR.confirm({ title: "Видалити угоду?", text: `Угода ${trade.n}: ${sg(trade.r, 3)} R${trade.shots || uploaded.length ? " і її скріншоти" : ""}. Це не можна скасувати.`, ok: "Видалити", danger: true });
            if (!ok) return;
            try { await JR.api.del(`/backtest-trades/${trade.id}`); await refresh(); JR.toast("Угоду видалено"); done(true); } catch (e) { JR.showError(err, e); }
          } }) : null,
          el("span", { class: "jr-spacer" }),
          el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => askClose() }),
          trade ? el("button", { type: "submit", class: "jr-btn is-primary", id: "bt-save-trade", text: "Зберегти" })
            : [el("button", { type: "submit", class: "jr-btn is-primary", id: "bt-save-next", "data-next": "1", text: "Зберегти й додати ще" }),
               el("button", { type: "submit", class: "jr-btn", id: "bt-save-trade", text: "Зберегти" })]));
      (trade || memo || last ? r : symbol).setAttribute("data-autofocus", "1");
      return form;
    }, { cls: "is-wide", onEscape: () => closeForm() });
    revoke();
    if (touched && !res) { try { await refresh(); } catch (e) { /* ок */ } }       // файли додавали або видаляли, але форму закрито без збереження
  }
  let closeForm = () => {};

  // ---------------------------------------------------------------- колекції
  function colForm(col) {
    return JR.modal((done) => {
      const name = el("input", { type: "text", id: "bt-c-name", maxlength: "60", value: col ? col.name : "", "data-autofocus": "1", placeholder: "Наприклад «Пробій діапазону, BTC 2023»" });
      const noteIn = el("textarea", { id: "bt-c-note", rows: "3", maxlength: "500", placeholder: "Правила входу й виходу, період, інструменти (необов'язково)" });
      noteIn.value = col ? col.note || "" : "";
      const risk = el("input", { type: "text", id: "bt-c-risk", inputmode: "decimal", autocomplete: "off", value: col && col.risk_pct != null ? rText(col.risk_pct) : "", placeholder: "Наприклад 1" });
      const err = el("div", { class: "jr-error", role: "alert", hidden: true });
      return el("form", { class: "jr-dlg-body", novalidate: true, onsubmit: async (ev) => {
        ev.preventDefault();
        const body = { name: name.value, note: noteIn.value, risk_pct: risk.value };
        try {
          if (col) { await JR.api.patch(`/backtests/${col.id}`, body); await refresh(); done(true); JR.toast("Збережено"); }
          else { const { backtest } = await JR.api.post("/backtests", body); done(true); current = backtest.id; lsSet(LAST_KEY, String(backtest.id)); memo = null; await refresh(); JR.toast("Колекцію створено"); }
        } catch (e) { JR.showError(err, e); }
      } },
        el("h2", { id: "jr-dlg-title", text: col ? "Змінити колекцію" : "Нова колекція бектесту" }),
        el("div", { class: "jr-field" }, el("label", { for: "bt-c-name", text: "Назва" }), name),
        el("div", { class: "jr-field" }, el("label", { for: "bt-c-note", text: "Опис" }), noteIn),
        el("div", { class: "jr-field" }, el("label", { for: "bt-c-risk", text: "Ризик на угоду, % від рахунку (необов'язково)" }), risk,
          el("small", { text: "Потрібен лише щоб оцінити дохідність у відсотках: сума R × ризик. Наприклад, +20 R при ризику 1% це приблизно +20%." })),
        err,
        el("div", { class: "jr-actions" }, el("span", { class: "jr-spacer" }),
          el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => done(false) }),
          el("button", { type: "submit", class: "jr-btn is-primary", id: "bt-c-save", text: col ? "Зберегти" : "Створити" })));
    }, { cls: "is-small" });
  }
  const createCol = () => colForm(null);

  async function deleteCol() {
    const c = data.backtest;
    const ok = await JR.confirm({ title: `Видалити колекцію «${c.name}»?`, text: `Разом з нею буде видалено всі угоди (${data.trades.length}). Це не можна скасувати. Перед видаленням можна зберегти угоди через «Експорт CSV».`, ok: "Видалити колекцію", danger: true });
    if (!ok) return;
    try { await JR.api.del(`/backtests/${c.id}`); current = null; memo = null; JR.toast("Колекцію видалено"); await B.show(); } catch (e) { JR.toast(e.message, "error"); }
  }

  async function exportCsv() {
    try { const { name, blob } = await window.JL.exportBacktestCsv(current); JR.account.download(blob, name); } catch (e) { JR.toast(e.message, "error"); }
  }

  // ---------------------------------------------------------------- зміни ззовні (хмара, відновлення з копії)
  let timer = null;
  function outside() {
    clearTimeout(timer);
    if (document.body.dataset.view !== "backtest") return;
    if (anyDialog()) { timer = setTimeout(outside, 2500); return; }
    B.show();
  }
  JR.bus.addEventListener("remote-data", outside);
  JR.bus.addEventListener("imported", outside);
})();
