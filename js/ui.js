/* Спільні дрібниці інтерфейсу для app.js і calendar.js. Увесь текст вставляється через textContent. */
(function () {
  "use strict";
  const SVG_NS = "http://www.w3.org/2000/svg";

  /* append / prepend / replaceChildren самі перетворюють null на текст «null». Пропускаємо порожні значення, щоб умовні блоки
     на кшталт `cond ? el(...) : null` нічого не друкували. */
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    for (const name of ["append", "prepend", "replaceChildren"]) {
      const orig = proto[name];
      proto[name] = function (...nodes) { return orig.apply(this, nodes.filter((x) => x != null && x !== false)); };
    }
  }

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  function svg(paths, opts) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", (opts && opts.box) || "0 0 12 12");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", (opts && opts.w) || "1.8");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      s.append(p);
    }
    return s;
  }

  const IMPACT_LABEL = { high: "Високий вплив", medium: "Середній вплив", low: "Низький вплив", holiday: "Вихідний" };

  /* Три стовпчики: кількість зафарбованих і є «значенням», тому колір не єдина ознака. */
  function impactIcon(impact) {
    if (impact === "holiday") return el("span", { class: "imp imp-holiday", role: "img", "aria-label": IMPACT_LABEL.holiday, text: "вих." });
    return el("span", { class: "imp imp-" + impact, role: "img", "aria-label": IMPACT_LABEL[impact] || impact },
      el("i"), el("i"), el("i"));
  }

  /* «через 2 год 10 хв», «15 хв тому», «зараз» */
  function whenText(minutes) {
    const m = Math.round(minutes);
    const abs = Math.abs(m);
    const dur = abs < 1 ? "" : abs < 60 ? `${abs} хв`
      : abs < 24 * 60 ? `${Math.floor(abs / 60)} год${abs % 60 ? " " + (abs % 60) + " хв" : ""}`
      : `${Math.floor(abs / 1440)} дн${Math.floor((abs % 1440) / 60) ? " " + Math.floor((abs % 1440) / 60) + " год" : ""}`;
    if (abs < 1) return "зараз";
    return m > 0 ? `через ${dur}` : `${dur} тому`;
  }

  window.UI = { el, svg, impactIcon, whenText, IMPACT_LABEL };
})();
