/* Журнал: розбір місяця. Підсумок за місяць, ключові помилки, кожна угода з питаннями для розбору (скріншоти, чи була угода
   за правилами, чи дійшла ціна до тейку після стопа, помилки, висновок) і загальний висновок місяця.
   Відповіді по угодах пишуться в самі записи журналу, висновки місяця зберігаються окремо. Усе зберігається саме. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, fmt, state } = JR;
  const $ = (s, r) => (r || document).querySelector(s);
  const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
  const REVIEW_FIELDS = [
    ["summary", "Загальний висновок місяця", "Що показав цей місяць загалом: головні висновки, закономірності."],
    ["went_well", "Що вдалося", "Що працювало й варто повторювати."],
    ["fix", "Що виправляти", "Які помилки повторюються й що з ними робити."],
    ["plan", "План на наступний місяць", "Правила й цілі, на яких ти зосередишся."],
  ];

  const R = (JR.review = {});
  let month = null, mode = "loss", seq = 0, months = [];
  const timers = new Map();

  const pad = (n) => String(n).padStart(2, "0");
  const nowMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const monthLabel = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
  const shift = (m, d) => { const t = new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1 + d, 1); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`; };
  const lastDay = (m) => `${m}-${pad(new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 0).getDate())}`;
  const field = (key) => state.fields.find((f) => f.key === key);

  R.reset = () => { month = null; months = []; seq++; };

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
        seg),
      el("p", { class: "jr-note", text: "Розбір схожий на сторінку місяця в Notion: підсумок, потім кожна угода з питаннями. Відповіді пишуться прямо в записи журналу й зберігаються самі." }),
      body);
    (async () => {
      try {
        const qs = new URLSearchParams({ from: `${month}-01`, to: lastDay(month), limit: "500" });
        if (mode === "loss") qs.set("outcome", "loss");
        const [stats, list, review] = await Promise.all([
          JR.api.get(`/journals/${j.id}/stats?group=month&from=${month}-01&to=${lastDay(month)}`),
          JR.api.get(`/journals/${j.id}/entries?${qs}`),
          JR.api.get(`/journals/${j.id}/review?month=${month}`),
        ]);
        if (my !== seq) return;
        const entries = list.entries.slice().reverse();                        // від першої угоди місяця до останньої
        body.replaceChildren(summary(stats, j), mistakes(stats), positions(entries, j, root), conclusion(review));
      } catch (e) { if (my === seq) body.replaceChildren(el("div", { class: "jr-error", role: "alert", text: e.message })); }
    })();
  }

  // ---------------------------------------------------------------- підсумок
  function summary(st, j) {
    const s = st.summary;
    if (!s.trades) return el("div", { class: "jr-empty" }, el("h3", { text: `У ${monthLabel(month).toLowerCase()} немає закритих угод` }),
      el("p", { text: s.open_trades ? `Відкритих записів: ${s.open_trades}.` : "Обери інший місяць або додай записи на вкладці «Записи»." }));
    const item = (label, value, cls) => el("div", { class: "jr-rv-sum-i" }, el("span", { class: "jr-kpi-l", text: label }), el("strong", { class: "jr-kpi-v " + (cls || ""), text: value }));
    return el("section", { class: "jr-card jr-rv-sum", "aria-label": "Підсумок місяця" },
      item("Прибуткових", s.win_rate == null ? "—" : `${fmt.num(s.win_rate, 1)}%`),
      item("Результат, %", s.pct == null ? "—" : `${fmt.signed(s.pct)}%`, fmt.sign(s.pct)),
      item(`Результат, ${j.currency}`, s.pnl == null ? "—" : fmt.signed(s.pnl), fmt.sign(s.pnl)),
      item("Результат, R", s.r == null ? "—" : fmt.signed(s.r), fmt.sign(s.r)),
      item("Угод", String(s.trades)),
      item("Збиткових", String(s.losses)));
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
  function positions(entries, j, root) {
    const head = el("h3", { id: "jr-rv-pos-h", text: mode === "loss" ? "Збиткові угоди" : "Усі угоди" });
    if (!entries.length) return el("section", { class: "jr-card" }, head, el("p", { class: "jr-dim", text: mode === "loss" ? "У цьому місяці немає збиткових угод. Можна обрати «Усі угоди»." : "У цьому місяці немає записів." }));
    return el("section", { class: "jr-rv-list", "aria-labelledby": "jr-rv-pos-h" }, head, entries.map((e, i) => position(e, i + 1, j)));
  }

  function chips(f, value, onPick) {
    if (!f) return null;
    const id = "jr-rv-" + f.key + "-" + Math.random().toString(36).slice(2, 7);
    const btns = f.options.map((o) => {
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

  function position(entry, n, j) {
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
    const area = (key) => {
      const f = field(key);
      if (!f) return null;
      const id = `jr-rv-${key}-${entry.id}`;
      const ta = el("textarea", { id, rows: "3", maxlength: "5000", text: d[key] || "" });
      ta.addEventListener("input", () => save({ [key]: ta.value.trim() }));
      return el("div", { class: "jr-rv-q" }, el("div", { class: "jr-lblrow" }, el("label", { for: id, class: "jr-rv-ql", text: f.label })), ta);
    };
    const mis = field("mistakes");
    const misBox = mis ? (() => {
      const cur = new Set(d.mistakes || []);
      const opts = mis.options.concat([...cur].filter((x) => !mis.options.includes(x)));
      const id = `jr-rv-mis-${entry.id}`;
      return el("div", { class: "jr-rv-q" }, el("div", { class: "jr-lblrow" }, el("span", { class: "jr-rv-ql", id, text: mis.label })),
        el("div", { class: "jr-checks", role: "group", "aria-labelledby": id }, opts.map((o) =>
          el("label", { class: "jr-check" }, el("input", { type: "checkbox", checked: cur.has(o), onchange: (ev) => { if (ev.target.checked) cur.add(o); else cur.delete(o); save({ mistakes: [...cur] }); } }), el("span", { text: o })))));
    })() : null;
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
    const card = el("details", { class: "jr-rv-pos", open: n === 1 ? true : null }, sumLine,
      el("div", { class: "jr-rv-posbody" },
        gallery,
        el("div", { class: "jr-rv-qs" },
          chips(field("by_rules"), d.by_rules, (v) => save({ by_rules: v })),
          chips(field("tp_after_stop"), d.tp_after_stop, (v) => save({ tp_after_stop: v })),
          chips(field("re_enter"), d.re_enter, (v) => save({ re_enter: v })),
          area("re_enter_why"), misBox, area("conclusion")),
        el("div", { class: "jr-rv-foot" }, status, el("span", { class: "jr-spacer" }),
          el("button", { type: "button", class: "jr-btn is-quiet", text: "Відкрити запис повністю", onclick: async () => { await JR.entries.edit(entry.id); const root = $("#jr-panel"); if (root && $("#jr-rv-body")) paint(root); } }))));
    return card;
  }

  // ---------------------------------------------------------------- висновок місяця
  function conclusion(rv) {
    const data = { ...rv.data };
    const status = el("span", { class: "jr-rv-status", role: "status" });
    let timer = null;
    const m = month, jid = JR.currentJournal().id;
    const boxes = REVIEW_FIELDS.map(([key, label, hint]) => {
      const id = "jr-rv-m-" + key;
      const ta = el("textarea", { id, rows: "4", maxlength: "5000", text: data[key] || "" });
      ta.addEventListener("input", () => {
        data[key] = ta.value; status.textContent = "Зберігаю…"; status.classList.remove("is-bad");
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try { await JR.api.put(`/journals/${jid}/review?month=${m}`, { data }); status.textContent = "Збережено"; }
          catch (e) { status.textContent = e.message; status.classList.add("is-bad"); }
        }, 700);
      });
      return el("div", { class: "jr-rv-q" }, el("label", { for: id, class: "jr-rv-ql", text: label }), ta, el("small", { class: "jr-dim", text: hint }));
    });
    return el("section", { class: "jr-card", "aria-labelledby": "jr-rv-con-h" }, el("h3", { id: "jr-rv-con-h", text: `Висновок: ${monthLabel(month).toLowerCase()}` }), ...boxes, el("div", { class: "jr-rv-foot" }, status));
  }
})();
