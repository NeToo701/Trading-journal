/* Журнал: розбір місяця. Підсумок за місяць (готова статистика й власні формули), ключові помилки, кожна угода з питаннями
   для розбору (скріншоти та поля, які обрав користувач) і висновок місяця з довільними полями.
   Що саме показувати й у якому порядку, задає кнопка «Налаштувати розбір» (js/jr-review-cfg.js, налаштування лежать у журналі).
   Відповіді по угодах пишуться в самі записи журналу, висновки місяця зберігаються окремо. Усе зберігається саме. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, fmt, state } = JR;
  const $ = (s, r) => (r || document).querySelector(s);
  const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];

  const R = (JR.review = {});
  let month = null, mode = "loss", seq = 0, months = [];
  let lastCtx = null;                       // {summary, rows, fields}: те, на чому рахується статистика (для перегляду формул у редакторі)
  const timers = new Map();

  const pad = (n) => String(n).padStart(2, "0");
  const nowMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const monthLabel = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
  const shift = (m, d) => { const t = new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1 + d, 1); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`; };
  const lastDay = (m) => `${m}-${pad(new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 0).getDate())}`;
  const field = (key) => state.fields.find((f) => f.key === key);

  R.reset = () => { month = null; months = []; seq++; lastCtx = null; };
  R.context = () => lastCtx;
  R.monthLabel = monthLabel;

  /* Значення статистики для показу. f = {fmt, dec, sign} з JL.reviewCfg.metricFmt. */
  R.fmtMetric = function (v, f, currency) {
    if (v == null) return "—";
    switch (f.fmt) {
      case "percent": return (f.sign ? fmt.signed(v, f.dec) : fmt.num(v, f.dec)) + "%";
      case "money": return `${f.sign ? fmt.signed(v, f.dec) : fmt.num(v, f.dec)} ${currency || ""}`.trim();
      case "r": return `${f.sign ? fmt.signed(v, f.dec) : fmt.num(v, f.dec)} R`;
      default: return fmt.num(v, f.dec);
    }
  };

  R.render = async function (root) {
    root.replaceChildren(el("p", { class: "jr-dim", text: "Завантажую розбір…" }));
    const j = JR.currentJournal();
    const my = ++seq;
    try {
      const all = await JR.api.get(`/journals/${j.id}/stats?group=month`);
      if (my !== seq) return;
      months = all.periods.map((p) => p.key);
    } catch (e) { root.replaceChildren(el("div", { class: "jr-error", role: "alert", text: e.message })); return; }
    if (!month) month = months.length ? months[months.length - 1] : nowMonth();
    paint(root);
  };

  function paint(root) {
    const j = JR.currentJournal();
    const my = ++seq;
    const known = months.includes(month) ? months : [...months, month].sort();
    const select = el("select", { id: "jr-rv-month", "aria-label": "Місяць" }, known.slice().reverse().map((m) => el("option", { value: m, selected: m === month, text: monthLabel(m) })));
    select.addEventListener("change", () => { month = select.value; paint(root); });
    const seg = el("div", { class: "jr-seg", role: "radiogroup", "aria-label": "Які угоди розбирати" },
      [["loss", "Збиткові"], ["all", "Усі угоди"]].map(([v, t]) => el("label", null,
        el("input", { type: "radio", name: "jr-rv-mode", value: v, checked: mode === v, onchange: () => { mode = v; paint(root); } }), el("span", { text: t }))));
    const body = el("div", { id: "jr-rv-body", "aria-live": "polite" }, el("p", { class: "jr-dim", text: "Завантажую…" }));
    root.replaceChildren(
      el("div", { class: "jr-toolbar jr-rv-bar" },
        el("button", { type: "button", class: "jr-btn", "aria-label": "Попередній місяць", text: "←", onclick: () => { month = shift(month, -1); paint(root); } }),
        select,
        el("button", { type: "button", class: "jr-btn", "aria-label": "Наступний місяць", text: "→", onclick: () => { month = shift(month, 1); paint(root); } }),
        seg,
        el("span", { class: "jr-spacer" }),
        el("button", { type: "button", class: "jr-btn", id: "jr-rv-cfg", text: "Налаштувати розбір", title: "Блоки, статистика, формули, поля й питання по угоді",
          onclick: async () => { if (await JR.reviewCfg.edit()) paint(root); } })),
      el("p", { class: "jr-note", text: "Розбір схожий на сторінку місяця в Notion: підсумок, потім кожна угода з питаннями. Відповіді пишуться прямо в записи журналу й зберігаються самі. Що саме показувати, задається кнопкою «Налаштувати розбір»." }),
      body);
    (async () => {
      try {
        const base = new URLSearchParams({ from: `${month}-01`, to: lastDay(month), limit: "500" });
        const lossQs = new URLSearchParams(base); lossQs.set("outcome", "loss");
        const [stats, list, review, cfgRes, allList] = await Promise.all([
          JR.api.get(`/journals/${j.id}/stats?group=month&from=${month}-01&to=${lastDay(month)}`),
          JR.api.get(`/journals/${j.id}/entries?${mode === "loss" ? lossQs : base}`),
          JR.api.get(`/journals/${j.id}/review?month=${month}`),
          JR.api.get(`/journals/${j.id}/review-config`),
          mode === "loss" ? JR.api.get(`/journals/${j.id}/entries?${base}`) : null,
        ]);
        if (my !== seq) return;
        const cfg = cfgRes.config;
        const entries = list.entries.slice().reverse();                        // від першої угоди місяця до останньої
        // дані закритих угод місяця: на них рахуються підсумки по полях у формулах (sum([Поле]) тощо)
        const rows = (allList || list).entries.map((e) => e.data).filter((d) => { const o = window.JL.stats.effectiveOutcome(d); return o && o !== "open"; });
        lastCtx = { summary: stats.summary, rows, fields: state.fields };
        const builders = {
          summary: () => summary(stats, j, cfg, rows),
          mistakes: () => mistakes(stats),
          positions: () => positions(entries, j, cfg),
          conclusion: () => conclusion(review, cfg),
        };
        const shown = cfg.blocks.filter((b) => b.visible).map((b) => builders[b.id]());
        body.replaceChildren(...(shown.length ? shown : [el("div", { class: "jr-empty" }, el("h3", { text: "Усі блоки приховано" }),
          el("p", { text: "Відкрий «Налаштувати розбір» і ввімкни потрібні блоки." }))]));
      } catch (e) { if (my === seq) body.replaceChildren(el("div", { class: "jr-error", role: "alert", text: e.message })); }
    })();
  }

  // ---------------------------------------------------------------- підсумок
  function summary(st, j, cfg, rows) {
    const s = st.summary;
    if (!s.trades) return el("div", { class: "jr-empty" }, el("h3", { text: `У ${monthLabel(month).toLowerCase()} немає закритих угод` }),
      el("p", { text: s.open_trades ? `Відкритих записів: ${s.open_trades}.` : "Обери інший місяць або додай записи на вкладці «Записи»." }));
    const agg = window.JL.reviewCfg.makeFieldAgg(state.fields, rows);
    const items = cfg.metrics.filter((m) => m.visible).map((m) => {
      const r = window.JL.reviewCfg.evalMetric(m, s, agg, state.fields);
      const f = window.JL.reviewCfg.metricFmt(m);
      return el("div", { class: "jr-rv-sum-i", title: r.error || null },
        el("span", { class: "jr-kpi-l", text: window.JL.reviewCfg.metricLabel(m, j.currency) }),
        el("strong", { class: "jr-kpi-v " + (f.sign && r.value != null ? fmt.sign(r.value) : ""), text: r.error ? "—" : R.fmtMetric(r.value, f, j.currency) }),
        r.error ? el("span", { class: "jr-kpi-h is-bad", text: "Помилка у формулі" }) : null);
    });
    return el("section", { class: "jr-card jr-rv-sum", "aria-label": "Підсумок місяця" },
      ...(items.length ? items : [el("p", { class: "jr-dim", text: "Жодну статистику не вибрано. Увімкни потрібну в «Налаштувати розбір»." })]));
  }

  function mistakes(st) {
    const rows = (st.by_mistake || []).slice().sort((a, b) => b.trades - a.trades);
    const losses = st.summary.losses;
    return el("section", { class: "jr-card", "aria-labelledby": "jr-rv-mis-h" },
      el("h3", { id: "jr-rv-mis-h", text: "Ключові помилки місяця" }),
      rows.length ? el("ul", { class: "jr-rv-mis" }, rows.map((r) => {
        const bar = el("span", { class: "jr-rv-misbar" }); bar.style.width = Math.max(4, Math.round((r.trades / rows[0].trades) * 100)) + "%";
        return el("li", null, el("span", { class: "jr-rv-misname", text: r.name }), el("span", { class: "jr-rv-misbox", "aria-hidden": "true" }, bar),
          el("span", { class: "jr-rv-miscnt", text: `${r.trades}${losses ? ` з ${st.summary.trades}` : ""}` }));
      })) : el("p", { class: "jr-dim", text: "Помилки ще не відмічені. Відмічай їх у картках угод нижче." }));
  }

  // ---------------------------------------------------------------- угоди
  function positions(entries, j, cfg) {
    const head = el("h3", { id: "jr-rv-pos-h", text: mode === "loss" ? "Збиткові угоди" : "Усі угоди" });
    if (!entries.length) return el("section", { class: "jr-card" }, head, el("p", { class: "jr-dim", text: mode === "loss" ? "У цьому місяці немає збиткових угод. Можна обрати «Усі угоди»." : "У цьому місяці немає записів." }));
    return el("section", { class: "jr-rv-list", "aria-labelledby": "jr-rv-pos-h" }, head, entries.map((e, i) => position(e, i + 1, j, cfg)));
  }

  function chips(f, value, onPick) {
    const id = "jr-rv-" + f.key + "-" + Math.random().toString(36).slice(2, 7);
    const opts = f.options.slice();
    if (value && !opts.includes(value)) opts.push(value);                    // старе значення, якого вже немає в списку, не губимо
    const btns = opts.map((o) => {
      const b = el("button", { type: "button", class: "jr-choice", "aria-pressed": String(value === o), text: o });
      b.addEventListener("click", () => {
        const was = b.getAttribute("aria-pressed") === "true";
        btns.forEach((x) => x.setAttribute("aria-pressed", "false"));
        if (!was) b.setAttribute("aria-pressed", "true");
        onPick(was ? null : o);
      });
      return b;
    });
    return el("div", { class: "jr-rv-q" },
      el("div", { class: "jr-lblrow" }, el("span", { class: "jr-rv-ql", id, text: f.label }), f.help ? JR.fields.helpButton(f.label, f.help, f.key) : null),
      el("div", { class: "jr-choices", role: "group", "aria-labelledby": id }, btns));
  }

  /* Одне питання в картці угоди. Вигляд залежить від типу поля; значення пишуться в запис через save(). */
  function question(f, entry, d, save) {
    const key = f.key, t = f.type;
    if (t === "select") return chips(f, d[key], (v) => save({ [key]: v }));
    if (t === "multiselect") {
      const cur = new Set(d[key] || []);
      const opts = f.options.concat([...cur].filter((x) => !f.options.includes(x)));
      const id = `jr-rv-${key}-${entry.id}`;
      return el("div", { class: "jr-rv-q" }, el("div", { class: "jr-lblrow" }, el("span", { class: "jr-rv-ql", id, text: f.label })),
        el("div", { class: "jr-checks", role: "group", "aria-labelledby": id }, opts.map((o) =>
          el("label", { class: "jr-check" }, el("input", { type: "checkbox", checked: cur.has(o), onchange: (ev) => { if (ev.target.checked) cur.add(o); else cur.delete(o); save({ [key]: [...cur] }); } }), el("span", { text: o })))));
    }
    if (t === "longtext") {
      const id = `jr-rv-${key}-${entry.id}`;
      const ta = el("textarea", { id, rows: "3", maxlength: "5000", text: d[key] || "" });
      ta.addEventListener("input", () => save({ [key]: ta.value.trim() }));
      return el("div", { class: "jr-rv-q" }, el("div", { class: "jr-lblrow" }, el("label", { for: id, class: "jr-rv-ql", text: f.label })), ta);
    }
    // решта типів (текст, число, дата, оцінка, галочка, посилання): звичайне поле введення, як у формі запису
    const inp = JR.fields.input(f, d[key], { suffix: "rv" + entry.id, market: JR.currentJournal().market });
    const push = () => save({ [key]: inp.get() });
    ["input", "change", "click"].forEach((n) => inp.node.addEventListener(n, push));
    inp.node.classList.add("jr-rv-field");
    return inp.node;
  }

  function position(entry, n, j, cfg) {
    const d = entry.data;
    const status = el("span", { class: "jr-rv-status", role: "status" });
    const save = (changes) => {
      for (const [k, v] of Object.entries(changes)) { if (v == null || v === "" || (Array.isArray(v) && !v.length)) delete d[k]; else d[k] = v; }
      status.textContent = "Зберігаю…"; status.classList.remove("is-bad");
      clearTimeout(timers.get(entry.id));
      timers.set(entry.id, setTimeout(async () => {
        try { await JR.api.put(`/entries/${entry.id}`, { data: d }); status.textContent = "Збережено"; }
        catch (e) { status.textContent = e.message; status.classList.add("is-bad"); }
      }, 700));
    };
    const imgs = entry.media.filter((m) => m.mime.startsWith("image/") || m.mime.startsWith("video/"));
    const gallery = imgs.length ? el("div", { class: "jr-rv-shots" }, imgs.map((m) => {
      const url = m.url;
      return el("button", { type: "button", class: "jr-rv-shot", "aria-label": `Відкрити ${m.name}`, onclick: () => JR.entries.lightbox(imgs, m.id) },
        m.mime.startsWith("video/") ? el("video", { src: url + "#t=0.1", preload: "metadata", muted: true, "aria-hidden": "true" }) : el("img", { src: url, alt: m.name, loading: "lazy" }));
    })) : el("p", { class: "jr-dim", text: "Скріншотів немає. Додай їх у записі, щоб розбирати угоду візуально." });
    const r = d.r != null ? d.r : JR.fields.calcR(d);
    const facts = [
      d.symbol, d.direction, d.setup, Array.isArray(d.timeframe) ? d.timeframe.join(", ") : d.timeframe,
      d.pct != null ? `${fmt.signed(d.pct, 4)}%` : null, d.pnl != null ? `${fmt.signed(d.pnl)} ${j.currency}` : null, r != null ? `${fmt.signed(r)} R` : null,
    ].filter(Boolean);
    const sumLine = el("summary", { class: "jr-rv-sumline" },
      el("strong", { text: `Позиція №${n}` }), el("span", { class: "jr-rv-when", text: fmt.dateTime(d.opened_at) }), el("span", { class: "jr-rv-facts", text: facts.join(" · ") }));
    const qs = cfg.pos_fields.filter((p) => p.visible).map((p) => field(p.key)).filter((f) => f && f.type !== "media").map((f) => question(f, entry, d, save));
    const card = el("details", { class: "jr-rv-pos", open: n === 1 ? true : null }, sumLine,
      el("div", { class: "jr-rv-posbody" },
        gallery,
        el("div", { class: "jr-rv-qs" }, ...qs),
        el("div", { class: "jr-rv-foot" }, status, el("span", { class: "jr-spacer" }),
          el("button", { type: "button", class: "jr-btn is-quiet", text: "Відкрити запис повністю", onclick: async () => { await JR.entries.edit(entry.id); const root = $("#jr-panel"); if (root && $("#jr-rv-body")) paint(root); } }))));
    return card;
  }

  // ---------------------------------------------------------------- висновок місяця
  function conclusion(rv, cfg) {
    const data = { ...rv.data };
    const status = el("span", { class: "jr-rv-status", role: "status" });
    let timer = null;
    const m = month, jid = JR.currentJournal().id;
    const save = (key, value, isText) => {
      data[key] = isText ? (value == null ? "" : value) : value;
      status.textContent = "Зберігаю…"; status.classList.remove("is-bad");
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { await JR.api.put(`/journals/${jid}/review?month=${m}`, { data }); status.textContent = "Збережено"; }
        catch (e) { status.textContent = e.message; status.classList.add("is-bad"); }
      }, 700);
    };
    const boxes = cfg.month_fields.filter((f) => f.visible).map((f) => {
      if (f.type === "longtext") {
        const id = "jr-rv-m-" + f.key;
        const ta = el("textarea", { id, rows: "4", maxlength: "5000", text: data[f.key] || "" });
        ta.addEventListener("input", () => save(f.key, ta.value, true));
        return el("div", { class: "jr-rv-q jr-rv-mf" + (f.wide ? " is-wide" : "") }, el("label", { for: id, class: "jr-rv-ql", text: f.label }), ta, f.hint ? el("small", { class: "jr-dim", text: f.hint }) : null);
      }
      const inp = JR.fields.input({ ...f, hint: f.hint }, data[f.key], { suffix: "m" });
      const push = () => save(f.key, inp.get(), f.type === "text");
      ["input", "change", "click"].forEach((n) => inp.node.addEventListener(n, push));
      inp.node.classList.add("jr-rv-mf"); inp.node.classList.toggle("is-wide", !!f.wide);
      return inp.node;
    });
    return el("section", { class: "jr-card", "aria-labelledby": "jr-rv-con-h" }, el("h3", { id: "jr-rv-con-h", text: `Висновок: ${monthLabel(month).toLowerCase()}` }),
      boxes.length ? el("div", { class: "jr-rv-mgrid" }, boxes) : el("p", { class: "jr-dim", text: "Полів висновку не вибрано. Додай їх у «Налаштувати розбір»." }),
      el("div", { class: "jr-rv-foot" }, status));
  }
})();
