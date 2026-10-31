/* Калькулятори: окремий розділ (#calc). Зліва список калькуляторів за групами, справа вибраний. Калькулятор лотів (розмір позиції) написано
   окремо нижче, решта будується з описів у lib/jl-calc-tools.js однією спільною функцією renderGeneric (форма з полів, результат з опису).
   Усе рахується в lib/jl-calc.js і lib/jl-calc-tools.js, тут лише показ. Список активів спільний для всіх калькуляторів: його можна змінювати прямо з будь-якого
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
  const TOOLS = [{ id: "lots", group: "risk", title: "Розмір позиції (лоти)", hint: "лоти під заданий ризик", render: renderLots },
    ...JL.calcTools.TOOLS.map((spec) => ({ id: spec.id, group: spec.group, title: spec.title, hint: spec.hint, render: () => renderGeneric(spec) }))];

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
    const blocks = JL.calcTools.GROUPS.map(([gid, label]) => el("section", { class: "jr-side-block", "aria-labelledby": `calc-g-${gid}` },
      el("h2", { id: `calc-g-${gid}`, text: label }),
      el("ul", { class: "jr-jlist" }, TOOLS.filter((t) => t.group === gid).map((t) => el("li", null,
        el("button", { type: "button", class: "jr-jbtn", "data-tool": t.id, "aria-current": t === tool ? "true" : null, onclick: () => pickTool(t), title: t.hint },
          el("span", { class: "jr-jname", text: t.title })))))));
    side().replaceChildren(...blocks,
      el("section", { class: "jr-side-block" },
        el("button", { type: "button", class: "jr-btn is-quiet jr-add", id: "calc-assets-btn", text: "Активи й параметри", title: "Список активів, розмір контракту, пункту, лота", onclick: () => assetsDialog() }),
        el("p", { class: "jr-note", text: "Активи спільні для всіх калькуляторів. Параметри (контракт, пункт, крок лота) беруться зі специфікації твого брокера: вони можуть відрізнятися, тому їх можна змінити." })));
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

  // ---------------------------------------------------------------- решта калькуляторів: форма й результат за описом (lib/jl-calc-tools.js)
  const VALS_KEY = "journal.calc.vals.v1";
  const VALS = {};          // id калькулятора -> значення полів; живуть, поки відкрита сторінка
  const keepLoad = () => { try { const o = JSON.parse(lsGet(VALS_KEY) || "{}"); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; } };
  /** Налаштування-звички (комісії, ставки, режими) запам'ятовуються між запусками, а ціни й суми ні. */
  const keepSave = (spec, vals) => { const all = keepLoad(); all[spec.id] = Object.fromEntries(spec.fields.filter((f) => f.keep).map((f) => [f.key, vals[f.key]])); lsSet(VALS_KEY, JSON.stringify(all)); };
  function valsOf(spec) {
    if (!VALS[spec.id]) {
      const saved = keepLoad()[spec.id] || {};
      VALS[spec.id] = Object.fromEntries(spec.fields.filter((f) => f.kind !== "asset" && !f.pref).map((f) => [f.key, f.keep && saved && typeof saved[f.key] === "string" ? saved[f.key] : (f.def || "")]));
    }
    return VALS[spec.id];
  }
  const PREF = {
    deposit: { get: () => S.deposit, set: (x) => { S.deposit = x; } },
    leverage: { get: () => S.leverage, set: (x) => { S.leverage = x; } },
    acc_ccy: { get: () => S.acc_ccy, set: (x) => { S.acc_ccy = x.toUpperCase(); } },
    rate: { get: (ctx) => (ctx.asset ? S.rates[ctx.asset.quote_ccy] || "" : ""), set: (x, ctx) => { if (ctx.asset) S.rates[ctx.asset.quote_ccy] = x; } },
  };
  const mkCtx = () => {
    const asset = curAsset(), acc = S.acc_ccy.trim().toUpperCase() || "USD";
    return { asset, acc, needRate: !!asset && !JL.calc.sameCcy(asset.quote_ccy, acc) };
  };
  const px = (x) => { if (x == null || !Number.isFinite(x)) return "—"; const a = Math.abs(x); return fx(x, 0, a >= 1000 ? 2 : a >= 10 ? 4 : a >= 1 ? 5 : 8); };
  const FMT = { n, n2, px, sgn, pct: (x, d = 2) => `${n(x, d)}%`, cur: (x, c) => `${n2(x)} ${c}` };

  function tableBlock(t) {
    return el("div", { class: "cc-alt", id: `cc-tbl-${t.id}` }, el("h3", { text: t.title }),
      el("div", { class: "jr-table-wrap" }, el("table", { class: "jr-table jr-table-static jr-mini-table" },
        el("thead", null, el("tr", null, t.head.map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", null, t.rows.map((row) => el("tr", null, row.map((c, i) => (i === 0 ? el("th", { scope: "row", text: c }) : el("td", { class: "jr-num", text: c })))))))));
  }

  const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  function paintGeneric(box, spec, res, v, ctx, copyText) {
    if (!res.ok) {
      const labels = spec.fields.reduce((m, f) => { m[f.key] = typeof f.label === "function" ? f.label(v, ctx) : f.label; return m; }, {});
      const has = Object.keys(res.errors).length;
      box.replaceChildren(el("h3", { text: "Результат" }), el("p", { class: "jr-dim", id: "cc-wait" },
        has ? "Виправ позначені поля, і результат порахується." : `Заповни: ${res.missing.map((k) => lowerFirst((labels[k] || k).replace(/\s*\(необов'язково\)/, "").replace(/, %$/, ""))).join("; ")}.`));
      return;
    }
    const view = spec.view(res, FMT, ctx), tiles = (view.tiles || []).filter(Boolean);
    copyText.v = view.big && view.big.copy ? view.big.copy : "";
    box.replaceChildren(
      view.big ? el("div", { class: "cc-big", id: "cc-big" }, el("span", { class: "cc-big-l", id: "cc-big-l", text: view.big.label }), el("span", { class: "cc-big-v", id: "cc-bigv", text: view.big.value }),
        view.big.hint ? el("span", { class: "cc-big-h", id: "cc-big-h", text: view.big.hint }) : null,
        copyText.v ? el("button", { type: "button", class: "jr-btn is-quiet cc-copy", id: "cc-copy", text: "Копіювати", onclick: async () => {
          try { await navigator.clipboard.writeText(copyText.v); JR.toast(`Скопійовано: ${copyText.v}`); } catch (e) { JR.toast("Не вдалося скопіювати. Виділи число вручну.", "error"); }
        } }) : null) : null,
      view.warnings && view.warnings.length ? el("ul", { class: "cc-warn", id: "cc-warn", role: "status" }, view.warnings.map((w) => el("li", { text: w }))) : null,
      tiles.length ? el("div", { class: "cc-kpis", id: "cc-kpis" }, tiles.map((t) => kpi(t.label, t.value, t.hint, t.sign, `cc-t-${t.id}`))) : null,
      ...(view.tables || []).map(tableBlock),
      view.note ? el("p", { class: "jr-note", text: view.note }) : null);
  }

  function renderGeneric(spec) {
    const vals = valsOf(spec), nodes = new Map();
    const result = el("section", { class: "jr-card cc-result", id: "cc-result", "aria-live": "polite", "aria-label": "Результат" });
    const copyText = { v: "" };
    const readAll = (ctx) => { const v = {}; for (const f of spec.fields) if (f.kind !== "asset") v[f.key] = f.pref ? PREF[f.pref].get(ctx) : vals[f.key]; return v; };
    const labelOf = (f, v, ctx) => (typeof f.label === "function" ? f.label(v, ctx) : f.label);
    const onInput = (f, value) => {
      if (f.pref) { PREF[f.pref].set(value, mkCtx()); scheduleSave(); } else { vals[f.key] = value; if (f.keep) keepSave(spec, vals); }
      update();
    };
    const ctx0 = mkCtx(), v0 = readAll(ctx0);
    const items = [];
    for (const f of spec.fields) {
      if (f.kind === "hidden") continue;
      const id = `cg-${f.key}`;
      let inner, input = null, err = null, labelEl = null;
      if (f.kind === "asset") {
        const af = C.assetField(() => update());
        inner = af.node;
      } else if (f.kind === "seg") {
        inner = el("div", { class: "jr-field", id: `${id}-f` }, el("span", { class: "jr-lbl", id: `${id}-l`, text: labelOf(f, v0, ctx0) }),
          seg(`cg-${spec.id}-${f.key}`, labelOf(f, v0, ctx0), f.options, v0[f.key], (val) => onInput(f, val)));
        labelEl = inner.querySelector(".jr-lbl");
      } else {
        input = textIn(id, v0[f.key], (val) => onInput(f, val), { placeholder: f.ph || "", ...(f.kind === "num" ? {} : { inputmode: "text" }), ...(f.kind === "ccy" ? { maxlength: "8" } : {}) });
        inner = field(id, labelOf(f, v0, ctx0), input, { hint: f.hint });
        labelEl = inner.querySelector("label"); err = inner.querySelector(".cc-err");
      }
      const wrap = el("div", { class: "cc-fw" + (f.wide || f.heading || f.kind === "asset" ? " is-wide" : ""), "data-key": f.key }, f.heading ? el("h3", { class: "cc-sub", text: f.heading }) : null, inner);
      nodes.set(f.key, { wrap, input, err, labelEl });
      items.push(wrap);
    }
    const actions = (spec.actions || []).map((a) => el("button", { type: "button", class: "jr-btn", id: `cg-act-${a.id}`, text: a.label, title: a.title || null, onclick: () => { a.run(vals); update(); } }));

    function update() {
      const ctx = mkCtx(), v = readAll(ctx);
      for (const f of spec.fields) {
        const nd = nodes.get(f.key); if (!nd) continue;
        nd.wrap.hidden = f.show ? !f.show(v, ctx) : false;
        const lab = labelOf(f, v, ctx);
        if (nd.labelEl && nd.labelEl.textContent !== lab) nd.labelEl.textContent = lab;
        if (f.pref === "rate" && nd.input && document.activeElement !== nd.input) nd.input.value = v[f.key] || "";
      }
      const res = spec.compute(v, ctx);
      for (const f of spec.fields) {
        const nd = nodes.get(f.key); if (!nd || !nd.err) continue;
        const msg = (!res.ok && res.errors[f.key]) || "";
        nd.err.textContent = msg;
        if (msg) nd.input.setAttribute("aria-invalid", "true"); else nd.input.removeAttribute("aria-invalid");
      }
      paintGeneric(result, spec, res, v, ctx, copyText);
    }

    // «Підставити з бектесту»: winrate і середні виграш та збиток колекції
    const btFill = spec.fromBacktest ? el("div", { class: "jr-field cc-btfill", id: "cg-btfill", hidden: true }) : null;
    if (btFill) fillFromBacktest(spec, vals, nodes, btFill, update);

    main().replaceChildren(head(spec.title, spec.intro),
      el("div", { class: "cc-grid" }, el("section", { class: "jr-card cc-form", "aria-label": "Дані" }, btFill, el("div", { class: "cc-fgrid" }, items), actions.length ? el("div", { class: "jr-actions" }, actions) : null), result));
    update();
  }

  async function fillFromBacktest(spec, vals, nodes, box, update) {
    let list = [];
    try { list = (await JR.api.get("/backtests")).backtests.filter((c) => c.trades > 0); } catch (e) { return; }
    if (!list.length) return;
    const sel = el("select", { id: "cg-bt", "aria-label": "Підставити з бектесту" }, el("option", { value: "", text: "Не підставляти" }), list.map((c) => el("option", { value: String(c.id), text: `${c.name} (${c.trades} угод)` })));
    sel.addEventListener("change", async () => {
      if (!sel.value) return;
      try {
        const { backtest, stats } = await JR.api.get(`/backtests/${sel.value}`);
        const m = spec.fromBacktest, put = (key, x) => { if (x == null) return; vals[key] = txt(x); const nd = nodes.get(key); if (nd && nd.input) nd.input.value = vals[key]; };
        put(m.wr, stats.win_rate); put(m.win, stats.avg_win_r); put(m.loss, stats.avg_loss_r == null ? null : Math.abs(stats.avg_loss_r));
        keepSave(spec, vals); update();
        JR.toast(`Підставлено з «${backtest.name}»: winrate ${n(stats.win_rate, 1)}%${stats.avg_win_r != null ? `, виграш ${n(stats.avg_win_r)} R` : ""}${stats.avg_loss_r != null ? `, збиток ${n(Math.abs(stats.avg_loss_r))} R` : ""}`);
      } catch (e) { JR.toast(e.message, "error"); }
    });
    box.append(el("label", { for: "cg-bt", text: "Підставити з бектесту" }), sel, el("small", { text: "Winrate, середні виграш і збиток береться зі статистики колекції." }));
    box.hidden = false;
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
