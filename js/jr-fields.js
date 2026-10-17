/* Журнал: типи полів. Для кожного типу є поле введення (воно віддає значення) і відображення значення. */
(function () {
  "use strict";
  const { el } = window.JR;
  const F = (window.JR.fields = {});

  const SYMBOLS = {
    crypto: ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "DOGE/USDT", "ADA/USDT", "AVAX/USDT", "LINK/USDT", "TON/USDT"],
    forex: ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "USD/CAD", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY", "XAU/USD"],
  };
  F.symbols = (market) => SYMBOLS[market] || [];

  /* R за входом, стопом і виходом: так само, як на сервері, щоб підказка збігалась зі статистикою. */
  F.calcR = function (d) {
    const n = (k) => { const v = parseFloat(String(d[k] ?? "").replace(",", ".")); return Number.isFinite(v) ? v : null; };
    const entry = n("entry"), stop = n("stop"), exit = n("exit");
    const dir = String(d.direction || "").toLowerCase();
    if (entry == null || stop == null || exit == null || (dir !== "лонг" && dir !== "шорт")) return null;
    const risk = dir === "лонг" ? entry - stop : stop - entry;
    if (risk <= 0) return null;
    return Math.round(((dir === "лонг" ? exit - entry : entry - exit) / risk) * 100) / 100;
  };

  /* Плановане співвідношення ризик/прибуток за входом, стопом і тейком (стоп і тейк мають бути з правильних боків). */
  F.calcRR = function (d) {
    const n = (k) => { const v = parseFloat(String(d[k] ?? "").replace(",", ".")); return Number.isFinite(v) ? v : null; };
    const entry = n("entry"), stop = n("stop"), take = n("take");
    if (entry == null || stop == null || take == null) return null;
    const risk = Math.abs(entry - stop), gain = Math.abs(take - entry);
    if (risk <= 0 || (entry - stop) * (take - entry) <= 0) return null;
    return Math.round((gain / risk) * 100) / 100;
  };

  // ---------------------------------------------------------------- підказка «?»
  let openTip = null;
  const closeTip = () => { if (openTip) { openTip.classList.remove("is-open"); const b = openTip.querySelector(".jr-help"); if (b) b.setAttribute("aria-expanded", "false"); openTip = null; } };
  document.addEventListener("click", (ev) => { if (openTip && !openTip.contains(ev.target)) closeTip(); });

  F.helpButton = function (label, text, key) {
    const tipId = "jr-tip-" + key + "-" + Math.random().toString(36).slice(2, 7);
    const tip = el("span", { class: "jr-helptip", role: "tooltip", id: tipId, text });
    const btn = el("button", { type: "button", class: "jr-help", "aria-label": `Пояснення: ${label}`, "aria-describedby": tipId, "aria-expanded": "false", text: "?" });
    const wrap = el("span", { class: "jr-helpwrap" }, btn, tip);
    const place = () => {
      wrap.classList.remove("is-left");
      const r = tip.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) wrap.classList.add("is-left");
    };
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const was = wrap.classList.contains("is-open");
      closeTip();
      if (!was) { wrap.classList.add("is-open"); btn.setAttribute("aria-expanded", "true"); openTip = wrap; place(); }
    });
    btn.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && wrap.classList.contains("is-open")) { ev.preventDefault(); ev.stopPropagation(); closeTip(); } });
    wrap.addEventListener("mouseenter", place);
    btn.addEventListener("focus", place);
    return wrap;
  };

  // ---------------------------------------------------------------- введення
  /* Рядок із назвою поля, позначкою «необов'язково» і підказкою «?». */
  function labelRow(f, id, asSpan) {
    const lbl = asSpan ? el("span", { class: "jr-lbl", id: id + "-l", text: f.label }) : el("label", { for: id, text: f.label });
    return el("div", { class: "jr-lblrow" }, lbl, f.optional ? el("span", { class: "jr-opt", text: "необов'язково" }) : null,
      f.help ? F.helpButton(f.label, f.help, f.key) : null);
  }

  /* Повертає { node, get() }. get() віддає значення для запису або null, якщо поле порожнє. */
  F.input = function (f, value, ctx) {
    const id = "jr-f-" + f.key + (ctx && ctx.suffix ? "-" + ctx.suffix : "");      // suffix: однакові поля в багатьох картках розбору мають різні id
    const wrap = (inner, cls) => el("div", { class: "jr-field " + (cls || ""), "data-key": f.key }, ...inner);
    const hintText = f.key === "setup" ? "Починай вводити: з'являться раніше використані назви. Нова назва збережеться сама." : f.hint;
    const hint = hintText ? el("small", { id: id + "-hint", text: hintText }) : null;
    const t = f.type;
    if (t === "text" || t === "link") {
      const inp = el("input", { id, type: t === "link" ? "url" : "text", maxlength: "200", value: value || "", autocomplete: "off", spellcheck: "false",
                                placeholder: t === "link" ? "https://" : (f.key === "symbol" ? (f.hint || "") : f.key === "setup" ? "Назва сетапу" : null),
                                list: f.key === "symbol" ? "jr-symbols" : f.key === "setup" ? "jr-setups" : null });
      if (t === "link") inp.maxLength = 500;
      return { node: wrap([labelRow(f, id), inp, hint]), get: () => inp.value.trim() || null, input: inp };
    }
    if (t === "longtext") {
      const ta = el("textarea", { id, rows: "5", maxlength: "5000", text: value || "" });
      return { node: wrap([labelRow(f, id), ta, hint], "is-wide"), get: () => ta.value.trim() || null, input: ta };
    }
    if (t === "number" || t === "percent") {
      const inp = el("input", { id, type: "text", inputmode: "decimal", autocomplete: "off", value: value == null ? "" : String(value).replace(".", ","), placeholder: t === "percent" ? "%" : (f.key === "pnl" || f.key === "pct" ? "-0,5" : null) });
      return { node: wrap([labelRow(f, id), inp, hint]), get: () => inp.value.trim() || null, input: inp };
    }
    if (t === "date" || t === "datetime") {
      const inp = el("input", { id, type: t === "date" ? "date" : "datetime-local", value: value || "" });
      return { node: wrap([labelRow(f, id), inp, hint]), get: () => inp.value || null, input: inp };
    }
    if (t === "select") {
      const opts = f.options.slice();
      if (value && !opts.includes(value)) opts.push(value);               // старе значення, якого вже немає в списку, не губимо
      const sel = el("select", { id }, el("option", { value: "", text: "—" }), opts.map((o) => el("option", { value: o, selected: o === value, text: o })));
      return { node: wrap([labelRow(f, id), sel, hint]), get: () => sel.value || null, input: sel };
    }
    if (t === "multiselect") {
      const chosen = new Set(value || []);
      const opts = f.options.concat([...chosen].filter((v) => !f.options.includes(v)));
      const boxes = opts.map((o) => el("label", { class: "jr-chip" }, el("input", { type: "checkbox", value: o, checked: chosen.has(o) }), el("span", { text: o })));
      return { node: wrap([labelRow(f, id, true), el("div", { class: "jr-chips", role: "group", "aria-labelledby": id + "-l" }, boxes), hint], "is-wide"),
               get: () => { const v = boxes.map((b) => b.firstChild).filter((i) => i.checked).map((i) => i.value); return v.length ? v : null; } };
    }
    if (t === "checkbox") {
      const inp = el("input", { id, type: "checkbox", checked: value === true });
      return { node: wrap([el("label", { class: "jr-switch", for: id }, inp, el("span", { text: f.label }))]), get: () => (inp.checked ? true : null) };
    }
    if (t === "rating") {
      let cur = Number(value) || 0;
      const btns = [1, 2, 3, 4, 5].map((n) => el("button", { type: "button", class: "jr-star", "aria-label": `${n} з 5`, "aria-pressed": "false", text: "★",
        onclick: () => { cur = cur === n ? 0 : n; paint(); } }));
      const paint = () => btns.forEach((b, i) => { b.classList.toggle("is-on", i < cur); b.setAttribute("aria-pressed", String(i + 1 === cur)); });
      paint();
      return { node: wrap([labelRow(f, id, true), el("div", { class: "jr-stars", role: "group", "aria-labelledby": id + "-l" }, btns), hint]), get: () => cur || null };
    }
    return { node: el("div"), get: () => null };
  };

  // ---------------------------------------------------------------- відображення
  F.display = function (f, value, ctx) {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return el("span", { class: "jr-dim", text: "—" });
    const fmt = window.JR.fmt;
    switch (f.type) {
      case "datetime": case "date": return document.createTextNode(fmt.dateTime(value));
      case "number": {
        const cls = f.key === "r" || f.key === "pnl" ? fmt.sign(value) : "";
        const txt = f.key === "r" ? fmt.signed(value) + " R" : f.key === "pnl" ? fmt.signed(value) + (ctx && ctx.currency ? " " + ctx.currency : "")
          : f.key === "rr" ? "1:" + fmt.num(value, 2) : fmt.num(value, 8);
        return el("span", { class: "jr-num " + cls, text: txt });
      }
      case "percent": return f.key === "pct" ? el("span", { class: "jr-num " + fmt.sign(value), text: fmt.signed(value, 4) + "%" }) : document.createTextNode(fmt.num(value, 4) + "%");
      case "checkbox": return document.createTextNode(value ? "так" : "ні");
      case "rating": return el("span", { class: "jr-rate", "aria-label": `${value} з 5`, text: "★".repeat(value) + "☆".repeat(5 - value) });
      case "multiselect": return el("span", { class: "jr-tags" }, value.map((v) => el("span", { class: "jr-tag", text: v })));
      case "link": if (!/^https?:\/\//i.test(value)) return document.createTextNode(String(value));
        return el("a", { href: value, target: "_blank", rel: "noopener noreferrer nofollow", text: "відкрити" });
      case "select":
        if (f.key === "outcome") return el("span", { class: "jr-pill " + ({ "Тейк-профіт": "is-win", "Прибуток": "is-win", "Стоп-лос": "is-loss", "Збиток": "is-loss", "Беззбиток": "is-be", "Закрито вручну": "is-be", "Відкрита": "is-open" }[value] || ""), text: value });
        if (f.key === "direction") return el("span", { class: "jr-pill " + (value === "Лонг" ? "is-long" : "is-short"), text: value });
        return document.createTextNode(value);
      default: return document.createTextNode(String(value));
    }
  };
})();
