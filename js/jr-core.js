/* Журнал: спільне ядро (запити до сервера, стан, діалоги підтвердження, сповіщення, форматування).
   Увесь текст вставляється через textContent. */
(function () {
  "use strict";
  const { el } = window.UI;

  const JR = (window.JR = { el, state: { journals: [], current: null, fields: [], meta: null }, bus: new EventTarget() });

  // ---------------------------------------------------------------- запити
  // У цій версії «сервер» працює прямо в браузері (lib/jl-api.js): ті самі запити, але дані лежать у IndexedDB цього пристрою.
  JR.api = window.JL.api;

  // ---------------------------------------------------------------- форматування
  const pad = (n) => String(n).padStart(2, "0");
  JR.fmt = {
    num(x, d = 2) {
      if (x == null || x === "") return "—";
      const n = Number(x);
      return Number.isFinite(n) ? n.toLocaleString("uk-UA", { maximumFractionDigits: d }) : "—";
    },
    signed(x, d = 2) {
      if (x == null) return "—";
      return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(Number(x)).toLocaleString("uk-UA", { maximumFractionDigits: d });
    },
    money(x, cur) { return x == null ? "—" : `${JR.fmt.signed(x)} ${cur || ""}`.trim(); },
    dateTime(s) {
      if (!s) return "—";
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
      if (!m) return s;
      return `${m[3]}.${m[2]}.${m[1]}` + (m[4] ? ` ${m[4]}:${m[5]}` : "");
    },
    nowInput() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; },
    bytes(n) { return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1048576).toFixed(1)} МБ`; },
    sign: (x) => (x > 0 ? "pos" : x < 0 ? "neg" : ""),
  };

  // ---------------------------------------------------------------- сповіщення
  let toasts;
  JR.toast = function (text, kind) {
    toasts = toasts || document.getElementById("jr-toasts");
    const t = el("div", { class: "jr-toast" + (kind ? " is-" + kind : ""), text });
    toasts.append(t);
    setTimeout(() => t.remove(), kind === "error" ? 7000 : 3500);
  };

  // ---------------------------------------------------------------- діалоги
  function modal(build, opts = {}) {
    return new Promise((resolve) => {
      const dlg = el("dialog", { class: "jr-dialog " + (opts.cls || "") , "aria-labelledby": "jr-dlg-title" });
      const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.append(build(done, dlg));
      // Подія cancel спливає від поля вибору файлу: коли закриваєш вікно «Відкрити» без вибору, вона не має закривати форму.
      dlg.addEventListener("cancel", (ev) => {
        if (ev.target !== dlg) return;
        ev.preventDefault();
        if (opts.onEscape) opts.onEscape(); else done(null);
      });
      document.body.append(dlg);
      dlg.showModal();
      const first = dlg.querySelector("[data-autofocus]") || dlg.querySelector("input, select, button");
      if (first) first.focus();
    });
  }
  JR.modal = modal;

  JR.confirm = ({ title, text, ok = "Підтвердити", danger = false }) =>
    modal((done) => el("div", { class: "jr-dlg-body" },
      el("h2", { id: "jr-dlg-title", text: title }),
      text ? el("p", { class: "jr-note", text }) : null,
      el("div", { class: "jr-actions" },
        el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => done(false) }),
        el("button", { type: "button", class: "jr-btn " + (danger ? "is-danger" : "is-primary"), "data-autofocus": "1", text: ok, onclick: () => done(true) }))), { cls: "is-small" });

  JR.prompt = ({ title, label, value = "", ok = "Зберегти", maxlength = 60, hint }) =>
    modal((done) => {
      const input = el("input", { type: "text", value, maxlength: String(maxlength), "data-autofocus": "1", id: "jr-prompt-input" });
      const f = el("form", { class: "jr-dlg-body", onsubmit: (ev) => { ev.preventDefault(); done(input.value.trim()); } },
        el("h2", { id: "jr-dlg-title", text: title }),
        el("div", { class: "jr-field" }, el("label", { for: "jr-prompt-input", text: label }), input, hint ? el("small", { text: hint }) : null),
        el("div", { class: "jr-actions" },
          el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => done(null) }),
          el("button", { type: "submit", class: "jr-btn is-primary", text: ok })));
      return f;
    }, { cls: "is-small" });

  JR.showError = function (box, err) {
    box.textContent = err && err.message ? err.message : String(err);
    box.hidden = false;
  };

  // ---------------------------------------------------------------- завантаження даних
  JR.loadMeta = async () => { JR.state.meta = await JR.api.get("/meta"); return JR.state.meta; };
  JR.loadJournals = async () => { JR.state.journals = (await JR.api.get("/journals")).journals; return JR.state.journals; };
  JR.currentJournal = () => JR.state.journals.find((j) => j.id === JR.state.current) || null;
  JR.marketLabel = (id) => ((JR.state.meta && JR.state.meta.markets.find((m) => m.id === id)) || { label: id }).label;
})();
