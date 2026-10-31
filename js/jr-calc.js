/* Калькулятори: окремий розділ (#calc). Зліва список калькуляторів, справа вибраний. Зараз є один: розмір позиції (лоти під ризик).
   Усе рахується в lib/jl-calc.js, тут лише показ. Список активів спільний для всіх калькуляторів: його можна змінювати прямо з будь-якого
   калькулятора (кнопки «Параметри» й «+ Новий» біля вибору активу) або в вікні «Активи». Увесь текст вставляється через textContent. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el } = JR;
  const JL = window.JL;
  const $ = (s, r) => (r || document).querySelector(s);
  const C = (JR.calc = {});
  const TOOL_KEY = "journal.calc.tool.v1";
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* без збереження теж працює */ } };

  let assets = [], prefs = null, tool = null;
  // Введене в полях зберігається, поки відкрита сторінка: при поверненні на вкладку нічого не стирається.
  const S = { ready: false, symbol: "", direction: "long", entry: "", stop: "", stop_mode: "price", tp_mode: "none", tp: "",
    acc_ccy: "USD", deposit: "", risk_mode: "pct", risk_pct: "1", risk_money: "", leverage: "", rates: {} };

  const side = () => $("#calc-side");
  const main = () => $("#calc-main");
  const fx = (x, min, max) => (x == null || !Number.isFinite(x) ? "—" : x.toLocaleString("uk-UA", { minimumFractionDigits: min, maximumFractionDigits: max }));
  const n = (x, d = 2) => fx(x, 0, d);
  const n2 = (x) => fx(x, 2, 2);
  const sgn = (x, d = 2) => (x > 0 ? "+" : x < 0 ? "−" : "") + fx(Math.abs(x), 0, d);
  const txt = (x) => {
    if (x == null) return "";
    let s = String(x);
    if (/e/i.test(s) && Number.isFinite(Number(x))) s = Number(x).toFixed(8).replace(/\.?0+$/, "");     // 1e-8 без показника степеня
    return s.replace(".", ",");
  };

  // ---------------------------------------------------------------- дані
  async function loadShared() {
    const [a, p] = await Promise.all([JR.api.get("/calc/assets"), JR.api.get("/calc/prefs")]);
    assets = a.assets; prefs = p.prefs;
    if (!S.ready) {
      S.ready = true;
      S.acc_ccy = prefs.acc_ccy; S.deposit = txt(prefs.deposit); S.risk_mode = prefs.risk_mode; S.risk_pct = txt(prefs.risk_pct); S.risk_money = txt(prefs.risk_money);
      S.leverage = txt(prefs.leverage); S.symbol = prefs.symbol || ""; S.rates = Object.fromEntries(Object.entries(prefs.rates || {}).map(([k, v]) => [k, txt(v)]));
    }
    if (!assets.some((x) => x.symbol === S.symbol)) S.symbol = assets[0] ? assets[0].symbol : "";
  }
  const curAsset = () => assets.find((x) => x.symbol === S.symbol) || null;

  let saveTimer = null;
  /** Депозит, ризик, валюта рахунку, плече й курси запам'ятовуються (і синхронізуються): наступного разу вводити лише ціни. */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const num = (v) => { const x = JL.calc.parseNum(v); return x === undefined ? null : x; };
      const body = { risk_mode: S.risk_mode, symbol: S.symbol };
      for (const [k, v] of [["deposit", S.deposit], ["risk_pct", S.risk_pct], ["risk_money", S.risk_money], ["leverage", S.leverage]]) { const x = num(v); if (x === null || Number.isFinite(x)) body[k] = x; }
      if (/^[A-Za-z]{2,8}$/.test(S.acc_ccy.trim())) body.acc_ccy = S.acc_ccy.trim().toUpperCase();
      const rates = {};
      for (const [k, v] of Object.entries(S.rates)) { const x = num(v); if (Number.isFinite(x) && x > 0) rates[k] = x; }
      body.rates = rates;
      try { prefs = (await JR.api.put("/calc/prefs", body)).prefs; } catch (e) { /* неприпустиме значення просто не зберігається */ }
    }, 500);
  }

  // ---------------------------------------------------------------- розділ
  const TOOLS = [{ id: "lots", title: "Розмір позиції", hint: "лоти під заданий ризик", render: renderLots }];

  C.show = async function () {
    try {
      await loadShared();
      if (!tool) tool = TOOLS.find((t) => t.id === lsGet(TOOL_KEY)) || TOOLS[0];
      renderSide(); renderTool();
    } catch (e) {
      main().replaceChildren(el("section", { class: "jr-gate" }, el("h1", { text: "Не вдалося відкрити калькулятори" }), el("p", { text: e.message || String(e) }),
        el("div", { class: "jr-actions" }, el("button", { type: "button", class: "jr-btn is-primary", text: "Спробувати ще раз", onclick: () => C.show() }))));
    }
  };

  function renderSide() {
    side().replaceChildren(
      el("section", { class: "jr-side-block", "aria-labelledby": "calc-side-h" },
        el("h2", { id: "calc-side-h", text: "Калькулятори" }),
        el("ul", { class: "jr-jlist" }, TOOLS.map((t) => el("li", null,
          el("button", { type: "button", class: "jr-jbtn", "data-tool": t.id, "aria-current": t === tool ? "true" : null, onclick: () => pickTool(t), title: t.hint },
            el("span", { class: "jr-jname", text: t.title }))))),
        el("button", { type: "button", class: "jr-btn is-quiet jr-add", id: "calc-assets-btn", text: "Активи й параметри", title: "Список активів, розмір контракту, пункту, лота", onclick: () => assetsDialog() })),
      el("p", { class: "jr-note", text: "Активи спільні для всіх калькуляторів. Параметри (контракт, пункт, крок лота) беруться зі специфікації твого брокера: вони можуть відрізнятися, тому їх можна змінити." }));
  }

  function pickTool(t) {
    tool = t; lsSet(TOOL_KEY, t.id);
    document.body.classList.remove("jr-side-open");
    renderSide(); renderTool();
  }
  function toggleSide() {
    const open = document.body.classList.toggle("jr-side-open");
    const b = $("#calc-side-toggle"); if (b) b.setAttribute("aria-expanded", String(open));
  }
  const renderTool = () => tool.render();
  const head = (title, sub) => el("header", { class: "jr-head" },
    el("div", { class: "jr-title" }, el("h1", { id: "calc-h1", text: title }), el("p", { class: "jr-dim", text: sub })),
    el("div", { class: "jr-head-actions" },
      el("button", { type: "button", class: "jr-btn jr-only-narrow", id: "calc-side-toggle", "aria-expanded": String(document.body.classList.contains("jr-side-open")), "aria-controls": "calc-side", text: "Калькулятори", onclick: toggleSide }),
      el("button", { type: "button", class: "jr-btn", id: "calc-assets-btn2", text: "Активи", title: "Список активів і їхні параметри", onclick: () => assetsDialog() })));

  // ---------------------------------------------------------------- дрібні елементи форми
  function seg(name, legend, options, value, onChange) {
    return el("div", { class: "jr-seg cc-seg", role: "radiogroup", "aria-label": legend }, options.map(([v, t]) =>
      el("label", null, el("input", { type: "radio", name, value: v, checked: v === value, onchange: () => onChange(v) }), el("span", { text: t }))));
  }
  /** Поле вводу з підписом, необов'язковим перемикачем режиму й рядком помилки. */
  function field(id, label, input, { segEl, hint, err } = {}) {
    return el("div", { class: "jr-field", id: `${id}-f` },
      el("div", { class: "cc-lblrow" }, el("label", { for: id, id: `${id}-l`, text: label }), segEl || null),
      input, hint ? el("small", { text: hint }) : null, el("small", { class: "cc-err", id: `${id}-err`, "data-for": err || id, role: "alert" }));
  }
  const textIn = (id, value, oninput, extra) => {
    const i = el("input", { type: "text", id, inputmode: "decimal", autocomplete: "off", value: value || "", ...(extra || {}) });
    i.addEventListener("input", () => oninput(i.value));
    return i;
  };

  // ---------------------------------------------------------------- вибір активу (спільний для калькуляторів)
  function assetSummary(a) {
    const bits = [`1 лот = ${n(a.contract_size, 8)}`, `пункт ${n(a.pip_size, 8)}`, `лот від ${n(a.min_lot, 8)} до ${n(a.max_lot, 8)}, крок ${n(a.lot_step, 8)}`, `ціна в ${a.quote_ccy}`];
    if (a.commission) bits.push(`комісія ${n(a.commission)} за лот`);
    return bits.join(" · ");
  }
  /** Блок «Актив»: список, кнопки «Параметри» і «+ Новий», підсумок параметрів. onChange викликається після зміни активу або його параметрів. */
  C.assetField = function (onChange) {
    const sel = el("select", { id: "cc-asset", "aria-label": "Актив" });
    const sum = el("p", { class: "jr-note cc-asset-sum", id: "cc-asset-sum" });
    const edit = el("button", { type: "button", class: "jr-btn", id: "cc-edit-asset", text: "Параметри", title: "Змінити параметри цього активу (розмір контракту, пункту, лота)", onclick: async () => {
      const a = curAsset(); if (!a) return;
      if (await assetForm(a)) { await loadShared(); paint(); onChange(); }
    } });
    const add = el("button", { type: "button", class: "jr-btn", id: "cc-new-asset", text: "+ Новий", title: "Додати свій актив", onclick: async () => {
      const made = await assetForm(null);
      if (made) { await loadShared(); S.symbol = made; scheduleSave(); paint(); onChange(); }
    } });
    function paint() {
      sel.replaceChildren(...assets.map((a) => el("option", { value: a.symbol, text: a.name ? `${a.symbol}: ${a.name}` : a.symbol, selected: a.symbol === S.symbol })));
      sel.disabled = !assets.length; edit.disabled = !assets.length;
      const a = curAsset();
      sum.textContent = a ? assetSummary(a) : "Усі активи сховано. Відкрий «Активи» й показуй потрібні або додай свій.";
    }
    sel.addEventListener("change", () => { S.symbol = sel.value; scheduleSave(); paint(); onChange(); });
    paint();
    return { node: el("div", { class: "jr-field cc-asset" }, el("div", { class: "cc-lblrow" }, el("label", { for: "cc-asset", text: "Актив" })), el("div", { class: "cc-asset-row" }, sel, edit, add), sum), paint };
  };

  // ---------------------------------------------------------------- калькулятор лотів
  function renderLots() {
    const asset = C.assetField(() => recalc());
    const dirSeg = seg("cc-dir", "Напрямок", [["long", "Лонг"], ["short", "Шорт"]], S.direction, (v) => { S.direction = v; recalc(); });
    const dep = textIn("cc-deposit", S.deposit, (v) => { S.deposit = v; scheduleSave(); recalc(); }, { placeholder: "Наприклад 10 000" });
    const acc = textIn("cc-acc", S.acc_ccy, (v) => { S.acc_ccy = v.toUpperCase(); scheduleSave(); recalc(); }, { maxlength: "8", inputmode: "text", placeholder: "USD" });
    const riskIn = textIn("cc-risk", S.risk_mode === "pct" ? S.risk_pct : S.risk_money, (v) => { S[S.risk_mode === "pct" ? "risk_pct" : "risk_money"] = v; scheduleSave(); recalc(); }, { placeholder: "Наприклад 1" });
    const riskSeg = seg("cc-rmode", "Ризик у", [["pct", "%"], ["money", "Сума"]], S.risk_mode, (v) => {
      S.risk_mode = v; riskIn.value = v === "pct" ? S.risk_pct : S.risk_money; riskIn.placeholder = v === "pct" ? "Наприклад 1" : "Наприклад 100"; scheduleSave(); recalc();
    });
    const entry = textIn("cc-entry", S.entry, (v) => { S.entry = v; recalc(); }, { placeholder: "Наприклад 1,0850" });
    const stopIn = textIn("cc-stop", S.stop, (v) => { S.stop = v; recalc(); }, { placeholder: S.stop_mode === "price" ? "Наприклад 1,0830" : "Наприклад 20" });
    const stopSeg = seg("cc-smode", "Стоп задано", [["price", "Ціна"], ["pips", "Пункти"]], S.stop_mode, (v) => { S.stop_mode = v; stopIn.placeholder = v === "price" ? "Наприклад 1,0830" : "Наприклад 20"; recalc(); });
    const tpIn = textIn("cc-tp", S.tp, (v) => { S.tp = v; recalc(); }, { placeholder: "" });
    const tpPh = { price: "Наприклад 1,0910", rr: "Наприклад 2", pips: "Наприклад 40" };
    const tpSeg = seg("cc-tmode", "Тейк-профіт", [["none", "Немає"], ["price", "Ціна"], ["rr", "R:R"], ["pips", "Пункти"]], S.tp_mode, (v) => { S.tp_mode = v; tpIn.placeholder = tpPh[v] || ""; recalc(); });
    tpIn.placeholder = tpPh[S.tp_mode] || "";
    const lev = textIn("cc-lev", S.leverage, (v) => { S.leverage = v; scheduleSave(); recalc(); }, { placeholder: "Наприклад 100" });
    const rate = textIn("cc-rate", "", (v) => { const a = curAsset(); if (a) { S.rates[a.quote_ccy] = v; scheduleSave(); recalc(); } }, { placeholder: "Наприклад 0,0066" });

    const fDep = field("cc-deposit", "Депозит", dep), fAcc = field("cc-acc", "Валюта рахунку", acc);
    const fRisk = field("cc-risk", "Ризик на угоду", riskIn, { segEl: riskSeg });
    const fEntry = field("cc-entry", "Ціна входу", entry), fStop = field("cc-stop", "Стоп", stopIn, { segEl: stopSeg });
    const fTp = field("cc-tp", "Тейк-профіт", tpIn, { segEl: tpSeg });
    const fLev = field("cc-lev", "Кредитне плече (необов'язково)", lev, { hint: "Потрібне лише щоб показати маржу. Достатньо числа: 100 це 1:100." });
    const fRate = field("cc-rate", "Курс", rate, { hint: "" });
    const result = el("section", { class: "jr-card cc-result", id: "cc-result", "aria-live": "polite", "aria-label": "Результат" });
    const copyText = { v: "" };

    const form = el("section", { class: "jr-card cc-form", "aria-label": "Дані угоди" },
      asset.node,
      el("div", { class: "jr-field" }, el("span", { class: "jr-lbl", id: "cc-dir-l", text: "Напрямок" }), dirSeg),
      el("div", { class: "cc-row" }, fDep, fAcc), fRisk,
      el("div", { class: "cc-row" }, fEntry, fStop), fTp, fLev, fRate);

    main().replaceChildren(head("Калькулятор лотів", "Розмір позиції під заданий ризик: від депозиту, ціни входу й стопу"),
      el("div", { class: "cc-grid" }, form, result));

    const errFields = ["deposit", "risk", "entry", "stop", "tp", "leverage", "rate"];
    const inputOf = { deposit: dep, risk: riskIn, entry, stop: stopIn, tp: tpIn, leverage: lev, rate };
    function recalc() {
      const a = curAsset();
      if (!a) { result.replaceChildren(el("p", { class: "jr-dim", id: "cc-empty", text: "Немає активу для розрахунку. Додай свій або покажи сховані в «Активи»." })); return; }
      const needRate = !JL.calc.sameCcy(a.quote_ccy, S.acc_ccy.trim().toUpperCase() || "USD");
      fRate.hidden = !needRate;
      if (needRate) {
        $("#cc-rate-l").textContent = `Курс: 1 ${a.quote_ccy} = ? ${S.acc_ccy.trim().toUpperCase() || "USD"}`;
        if (document.activeElement !== rate) rate.value = S.rates[a.quote_ccy] || "";
      }
      $("#cc-entry-l").textContent = S.stop_mode === "price" || S.tp_mode === "price" ? "Ціна входу" : "Ціна входу (необов'язково)";
      tpIn.hidden = S.tp_mode === "none";
      const r = JL.calc.sizeLots({ deposit: S.deposit, risk_mode: S.risk_mode, risk: S.risk_mode === "pct" ? S.risk_pct : S.risk_money, direction: S.direction,
        entry: S.entry, stop_mode: S.stop_mode, stop: S.stop, tp_mode: S.tp_mode, tp: S.tp, acc_ccy: S.acc_ccy.trim().toUpperCase() || "USD", rate: S.rates[a.quote_ccy], leverage: S.leverage }, a);
      for (const f of errFields) {
        const box = $(`#cc-${f === "risk" ? "risk" : f === "leverage" ? "lev" : f}-err`);
        const msg = r.errors[f] || "";
        if (box) box.textContent = msg;
        if (inputOf[f]) { if (msg) inputOf[f].setAttribute("aria-invalid", "true"); else inputOf[f].removeAttribute("aria-invalid"); }
      }
      paintResult(result, r, a, copyText);
    }
    recalc();
  }

  const LABELS = { deposit: "депозит", risk: "ризик", stop: "стоп", entry: "ціну входу", tp: "тейк-профіт", rate: "курс валюти" };

  function kpi(label, value, hint, sign, id) {
    return el("div", { class: "jr-kpi", id }, el("span", { class: "jr-kpi-l", text: label }), el("span", { class: "jr-kpi-v" + (sign ? " " + sign : ""), text: value }), hint ? el("span", { class: "jr-kpi-h", text: hint }) : null);
  }

  function paintResult(box, r, a, copyText) {
    if (!r.ok) {
      const has = Object.keys(r.errors).length;
      box.replaceChildren(el("h3", { text: "Розмір позиції" }), el("p", { class: "jr-dim", id: "cc-wait" },
        has ? "Виправ позначені поля, і лот порахується." : `Заповни: ${r.missing.map((f) => LABELS[f] || f).join(", ")}. Лот порахується автоматично.`));
      return;
    }
    const x = r.result, dec = JL.calc.stepDecimals(a.lot_step), acc = x.acc_ccy;
    const lotText = fx(x.lots, Math.min(dec, 2), Math.max(dec, 2));
    copyText.v = x.lots.toFixed(dec);
    const tiles = [
      kpi("Ризик", `${n2(x.risk_money)} ${acc}`, x.risk_pct != null ? `${n(x.risk_pct, 2)}% депозиту${Math.abs(x.risk_money - x.risk_money_target) > 0.005 ? `, ціль ${n2(x.risk_money_target)}` : ""}` : `ціль ${n2(x.risk_money_target)}`, "", "cc-k-risk"),
      kpi("Стоп", `${n(x.stop_pips, 1)} пунктів`, `${fx(x.dist, a.digits < 2 ? 0 : 2, Math.max(a.digits, 2))} у ціні${x.stop_price != null ? `, стоп ${fx(x.stop_price, a.digits, a.digits)}` : ""}`, "", "cc-k-stop"),
      kpi("Вартість пункту", `${n2(x.pip_value * x.lots)} ${acc}`, `за 1 лот ${n2(x.pip_value)} ${acc}`, "", "cc-k-pip"),
      kpi("Обсяг", `${n(x.units, 6)}`, x.notional != null ? `одиниць активу, номінал ${n2(x.notional)} ${a.quote_ccy}` : "одиниць активу", "", "cc-k-units"),
      x.margin != null ? kpi("Маржа", `${n2(x.margin)} ${acc}`, "потрібно для відкриття позиції", "", "cc-k-margin") : null,
      x.commission_total ? kpi("Комісія", `${n2(x.commission_total)} ${acc}`, "вхід і вихід разом", "", "cc-k-comm") : null,
      x.rr != null ? kpi("Профіт при тейку", `${sgn(x.profit_money)} ${acc}`, `${x.profit_pct != null ? `${sgn(x.profit_pct)}% депозиту` : ""}${x.tp_price != null ? `, тейк ${fx(x.tp_price, a.digits, a.digits)}` : ""}`.replace(/^, /, ""), x.profit_money > 0 ? "pos" : x.profit_money < 0 ? "neg" : "", "cc-k-profit") : null,
      x.rr != null ? kpi("R:R", `1 : ${n(x.rr, 2)}`, `${n(x.tp_pips, 1)} пунктів до тейку; беззбитковий winrate ${n(x.breakeven_winrate, 1)}%`, "", "cc-k-rr") : null,
    ];
    box.replaceChildren(
      el("div", { class: "cc-big", id: "cc-big" },
        el("span", { class: "cc-big-l", text: "Розмір позиції" }),
        el("span", { class: "cc-big-v", id: "cc-lots", text: x.lots ? `${lotText} лота` : "—" }),
        el("span", { class: "cc-big-h", text: x.lots ? `${n(x.units, 6)} одиниць · ризик ${n2(x.risk_money)} ${acc}` : "з таким ризиком і стопом відкрити позицію не вийде" }),
        x.lots ? el("button", { type: "button", class: "jr-btn is-quiet cc-copy", id: "cc-copy", text: "Копіювати", title: `Скопіювати ${copyText.v}`, onclick: async () => {
          try { await navigator.clipboard.writeText(copyText.v); JR.toast(`Скопійовано: ${copyText.v}`); } catch (e) { JR.toast("Не вдалося скопіювати. Виділи число вручну.", "error"); }
        } }) : null),
      r.warnings.length ? el("ul", { class: "cc-warn", id: "cc-warn", role: "status" }, r.warnings.map((w) => el("li", { text: w }))) : null,
      el("div", { class: "cc-kpis", id: "cc-kpis" }, tiles),
      x.alternatives.length ? el("div", { class: "cc-alt", id: "cc-alt" }, el("h3", { text: "Лот при іншому ризику" }),
        el("div", { class: "jr-table-wrap" }, el("table", { class: "jr-table jr-table-static jr-mini-table" },
          el("thead", null, el("tr", null, ["Ризик", "Лот", `Ризик, ${acc}`].map((h) => el("th", { scope: "col", text: h })))),
          el("tbody", null, x.alternatives.map((s) => el("tr", { "data-pct": String(s.pct) },
            el("th", { scope: "row", text: `${n(s.pct, 2)}%` }),
            el("td", { class: "jr-num", text: s.lots ? fx(s.lots, Math.min(dec, 2), Math.max(dec, 2)) : "менше мінімуму" }),
            el("td", { class: "jr-num", text: s.lots ? n2(s.risk_money) : "—" }))))))) : null,
      el("p", { class: "jr-note", text: "Лот округлюється вниз до кроку, тому реальний ризик не перевищує заданий. Розрахунок орієнтовний: перевір вартість пункту у своєму брокері." }));
  }

  // ---------------------------------------------------------------- форма активу
  const KIND_OPTS = Object.entries(JL.calc.KINDS);
  /** Форма нового чи наявного активу. Повертає символ збереженого активу, або null, якщо закрито без змін. */
  function assetForm(asset) {
    return JR.modal((done) => {
      const isNew = !asset;
      const base = asset || JL.calc.PRESETS[0];
      const err = el("div", { class: "jr-error", role: "alert", hidden: true });
      const mk = (id, label, value, hint, extra) => el("div", { class: "jr-field" }, el("label", { for: id, text: label }), el("input", { type: "text", id, value: value == null ? "" : txt(value), autocomplete: "off", ...(extra || {}) }), hint ? el("small", { text: hint }) : null);
      const symbol = mk("cc-a-symbol", "Символ", asset ? asset.symbol : "", asset ? "Символ не змінюється." : "Наприклад USDJPY, US30 або BTCUSDT.", { maxlength: "20", ...(asset ? { readonly: true } : { "data-autofocus": "1" }) });
      const name = mk("cc-a-name", "Назва (необов'язково)", asset ? asset.name : "", null, { maxlength: "40", placeholder: "Наприклад Долар / єна" });
      const kind = el("select", { id: "cc-a-kind" }, KIND_OPTS.map(([v, t]) => el("option", { value: v, text: t, selected: v === base.kind })));
      const contract = mk("cc-a-contract", "Розмір контракту", base.contract_size, "Скільки одиниць базового активу в 1 лоті: форекс 100 000, золото 100 унцій, крипта 1.", { inputmode: "decimal" });
      const pip = mk("cc-a-pip", "Розмір пункту", base.pip_size, "Крок ціни, який рахуєш за 1 пункт: форекс 0,0001 (з JPY 0,01), золото зазвичай 0,1. Брокери розходяться: звір зі специфікацією.", { inputmode: "decimal" });
      const quote = mk("cc-a-quote", "Валюта котирування", base.quote_ccy, "У якій валюті ціна й прибуток: для EURUSD це USD.", { maxlength: "8" });
      const digits = mk("cc-a-digits", "Знаків у ціні", base.digits, "Скільки знаків після коми показує брокер.", { inputmode: "numeric" });
      const minLot = mk("cc-a-min", "Мінімальний лот", base.min_lot, null, { inputmode: "decimal" });
      const step = mk("cc-a-step", "Крок лота", base.lot_step, null, { inputmode: "decimal" });
      const maxLot = mk("cc-a-max", "Максимальний лот", base.max_lot, null, { inputmode: "decimal" });
      const comm = mk("cc-a-comm", "Комісія за 1 лот", base.commission, "Вхід і вихід разом, у валюті рахунку. Немає: 0.", { inputmode: "decimal" });
      const ids = { contract_size: contract, pip_size: pip, quote_ccy: quote, digits, min_lot: minLot, lot_step: step, max_lot: maxLot, commission: comm };
      const preset = isNew ? el("div", { class: "jr-field is-wide" }, el("label", { for: "cc-a-preset", text: "Шаблон параметрів" }),
        el("select", { id: "cc-a-preset", onchange: (ev) => {
          const p = JL.calc.PRESETS.find((q) => q.id === ev.target.value); if (!p) return;
          kind.value = p.kind;
          for (const [k, node] of Object.entries(ids)) node.querySelector("input").value = txt(p[k]);
        } }, JL.calc.PRESETS.map((p) => el("option", { value: p.id, text: p.label }))),
        el("small", { text: "Підставляє типові значення, далі все можна змінити." })) : null;
      const body = () => ({ symbol: symbol.querySelector("input").value, name: name.querySelector("input").value, kind: kind.value,
        ...Object.fromEntries(Object.entries(ids).map(([k, node]) => [k, node.querySelector("input").value])) });
      const form = el("form", { class: "jr-entry-form", novalidate: true, onsubmit: async (ev) => {
        ev.preventDefault(); err.hidden = true;
        try {
          if (isNew) { const { asset: a } = await JR.api.post("/calc/assets", body()); JR.toast("Актив додано"); done(a.symbol); }
          else { await JR.api.put(`/calc/assets/${asset.symbol}`, body()); JR.toast("Параметри збережено"); done(asset.symbol); }
        } catch (e) { JR.showError(err, e); }
      } },
        el("div", { class: "jr-dlg-head" }, el("h2", { id: "jr-dlg-title", text: isNew ? "Новий актив" : `Параметри ${asset.symbol}` }),
          el("button", { type: "button", class: "jr-x", "aria-label": "Закрити", text: "×", onclick: () => done(null) })),
        el("p", { class: "jr-note", text: "Параметри беруться зі специфікації контракту у твого брокера. У різних брокерів вони можуть відрізнятися, тому їх можна змінити під свій рахунок." }),
        el("div", { class: "jr-grid" }, preset, symbol, name, el("div", { class: "jr-field" }, el("label", { for: "cc-a-kind", text: "Тип" }), kind), contract, pip, quote, digits, minLot, step, maxLot, comm),
        err,
        el("div", { class: "jr-actions" },
          !isNew && !asset.builtin ? el("button", { type: "button", class: "jr-btn is-danger-quiet", id: "cc-a-del", text: "Видалити", onclick: async () => {
            const ok = await JR.confirm({ title: `Видалити актив ${asset.symbol}?`, text: "Актив зникне зі списку в усіх калькуляторах.", ok: "Видалити", danger: true });
            if (!ok) return;
            try { await JR.api.del(`/calc/assets/${asset.symbol}`); JR.toast("Актив видалено"); done(asset.symbol); } catch (e) { JR.showError(err, e); }
          } }) : null,
          !isNew && asset.builtin && asset.modified ? el("button", { type: "button", class: "jr-btn", id: "cc-a-reset", text: "Скинути до стандартних", title: "Повернути вбудовані параметри", onclick: async () => {
            try { await JR.api.del(`/calc/assets/${asset.symbol}`); JR.toast("Параметри скинуто"); done(asset.symbol); } catch (e) { JR.showError(err, e); }
          } }) : null,
          el("span", { class: "jr-spacer" }),
          el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => done(null) }),
          el("button", { type: "submit", class: "jr-btn is-primary", id: "cc-a-save", text: isNew ? "Додати" : "Зберегти" })));
      return form;
    }, { cls: "is-wide" });
  }

  // ---------------------------------------------------------------- вікно «Активи»
  async function assetsDialog() {
    let changed = false;
    await JR.modal((done) => {
      const list = el("div", { class: "cc-alist", id: "cc-alist" });
      const paint = async () => {
        const all = (await JR.api.get("/calc/assets?all=1")).assets;
        list.replaceChildren(el("div", { class: "jr-table-wrap" }, el("table", { class: "jr-table jr-table-static", id: "cc-atable" },
          el("thead", null, el("tr", null, ["Символ", "Назва", "Тип", "Контракт", "Пункт", "Лот (мін / крок)", ""].map((h) => el("th", { scope: "col", text: h })))),
          el("tbody", null, all.map((a) => el("tr", { "data-symbol": a.symbol, class: a.hidden ? "cc-hidden" : "" },
            el("th", { scope: "row", "data-label": "Символ" }, a.symbol, a.builtin ? el("span", { class: "jr-badge cc-badge", text: a.modified ? "змінений" : "стандартний" }) : null, a.hidden ? el("span", { class: "jr-badge cc-badge", text: "схований" }) : null),
            el("td", { "data-label": "Назва", text: a.name || "—" }),
            el("td", { "data-label": "Тип", text: JL.calc.KINDS[a.kind] || a.kind }),
            el("td", { "data-label": "Контракт", class: "jr-num", text: n(a.contract_size, 8) }),
            el("td", { "data-label": "Пункт", class: "jr-num", text: n(a.pip_size, 8) }),
            el("td", { "data-label": "Лот (мін / крок)", class: "jr-num", text: `${n(a.min_lot, 8)} / ${n(a.lot_step, 8)}` }),
            el("td", { class: "cc-acts" },
              el("button", { type: "button", class: "jr-btn", "data-act": "edit", text: "Змінити", onclick: async () => { if (await assetForm(a)) { changed = true; await paint(); } } }),
              a.builtin ? el("button", { type: "button", class: "jr-btn is-quiet", "data-act": "hide", text: a.hidden ? "Показати" : "Сховати", onclick: async () => {
                try { await JR.api.put(`/calc/assets/${a.symbol}`, { ...a, hidden: !a.hidden }); changed = true; await paint(); } catch (e) { JR.toast(e.message, "error"); }
              } }) : null)))))));
      };
      paint().catch((e) => JR.toast(e.message, "error"));
      return el("div", { class: "jr-entry-form" },
        el("div", { class: "jr-dlg-head" }, el("h2", { id: "jr-dlg-title", text: "Активи й параметри" }),
          el("button", { type: "button", class: "jr-x", "aria-label": "Закрити", text: "×", onclick: () => done(null) })),
        el("p", { class: "jr-note", text: "Один список активів для всіх калькуляторів. Стандартні (EURUSD, GBPUSD, XAUUSD) можна змінити під свого брокера, скинути до вбудованих значень або сховати. Власні активи можна видалити." }),
        list,
        el("div", { class: "jr-actions" },
          el("button", { type: "button", class: "jr-btn is-primary", id: "cc-add-asset", text: "+ Новий актив", onclick: async () => { const made = await assetForm(null); if (made) { changed = true; await paint(); } } }),
          el("span", { class: "jr-spacer" }),
          el("button", { type: "button", class: "jr-btn", id: "cc-assets-close", text: "Закрити", onclick: () => done(null) })));
    }, { cls: "is-wide" });
    if (changed) { await loadShared(); renderTool(); }
  }

  // ---------------------------------------------------------------- зміни ззовні (хмара, відновлення з копії)
  let timer = null;
  function outside() {
    clearTimeout(timer);
    if (document.body.dataset.view !== "calc") return;
    if (document.querySelector("dialog[open].jr-dialog") || document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { timer = setTimeout(outside, 2500); return; }
    C.show();
  }
  JR.bus.addEventListener("remote-data", outside);
  JR.bus.addEventListener("imported", outside);
})();
