/* Журнал: редактор полів. Можна перейменувати, сховати, змінити порядок, показати в таблиці, змінити варіанти списків,
   додати власні поля будь-якого типу й видалити власні. Вбудовані поля видалити не можна, лише сховати. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, state } = JR;
  const LOCKED = ["direction", "outcome"];
  const HINTS = {
    text: "Короткий рядок", longtext: "Великий текст, нотатки", number: "Число з комою чи крапкою", percent: "Число зі знаком %",
    date: "Тільки дата", datetime: "Дата й час", select: "Обрати один варіант зі списку", multiselect: "Обрати кілька варіантів",
    checkbox: "Галочка так або ні", rating: "Зірки від 1 до 5", link: "Посилання на TradingView чи інший сайт", media: "Фото й відео",
  };

  JR.schema = {
    async edit() {
      const j = JR.currentJournal();
      let working = state.fields.map((f) => ({ ...f, options: f.options ? f.options.slice() : undefined }));
      const err = el("div", { class: "jr-error", role: "alert", hidden: true });
      const list = el("ol", { class: "jr-schema-list" });
      const typeSel = el("select", { id: "jr-new-type", "aria-label": "Тип нового поля" },
        state.meta.types.map((t) => el("option", { value: t.id, text: t.label })));
      const nameInp = el("input", { type: "text", id: "jr-new-name", maxlength: "60", placeholder: "Назва нового поля, наприклад «Новини»", autocomplete: "off" });
      const typeHint = el("small", { class: "jr-dim" });
      const updHint = () => { typeHint.textContent = HINTS[typeSel.value] || ""; };
      typeSel.addEventListener("change", updHint); updHint();
      nameInp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } });

      const mediaCount = () => working.filter((f) => f.type === "media").length;

      const paint = () => {
        list.replaceChildren(...working.map((f, i) => row(f, i)));
      };

      function move(i, d) {
        const k = i + d;
        if (k < 0 || k >= working.length) return;
        [working[i], working[k]] = [working[k], working[i]];
        paint();
        const btn = list.children[k] && list.children[k].querySelector(d < 0 ? ".jr-up" : ".jr-down");
        if (btn) btn.focus();
      }

      function row(f, i) {
        const isOpened = f.key === "opened_at";
        const canOptions = (f.type === "select" || f.type === "multiselect") && !LOCKED.includes(f.key);
        const label = el("input", { type: "text", value: f.label, maxlength: "60", "aria-label": "Назва поля", oninput: (ev) => { f.label = ev.target.value; } });
        const hidden = el("label", { class: "jr-check" }, el("input", { type: "checkbox", checked: !f.hidden, disabled: isOpened, onchange: (ev) => { f.hidden = !ev.target.checked; } }), el("span", { text: "У формі" }));
        const inTable = f.type === "longtext" || f.type === "media" ? null
          : el("label", { class: "jr-check" }, el("input", { type: "checkbox", checked: !!f.table, onchange: (ev) => { f.table = ev.target.checked; } }), el("span", { text: "У таблиці" }));
        const del = f.builtin ? null : el("button", { type: "button", class: "jr-btn is-danger-quiet", text: "Видалити", "aria-label": `Видалити поле ${f.label}`, onclick: async () => {
          const ok = await JR.confirm({ title: "Видалити поле?", text: `Поле «${f.label}» зникне зі схеми, а введені в ньому значення старих записів більше не показуватимуться.`, ok: "Видалити", danger: true });
          if (!ok) return;
          working = working.filter((x) => x !== f); paint();
        } });
        const opts = canOptions ? el("div", { class: "jr-field jr-opts" },
          el("label", { text: "Варіанти, кожен з нового рядка" }),
          el("textarea", { rows: "4", "aria-label": `Варіанти для ${f.label}`, text: f.options.join("\n"),
            oninput: (ev) => { f.options = ev.target.value.split("\n").map((x) => x.trim()).filter(Boolean); } })) : null;
        const tip = f.builtin ? null : el("div", { class: "jr-schema-help" },
          el("input", { type: "text", value: f.help || "", maxlength: "200", placeholder: "Підказка до поля (необов'язково): з'явиться за знаком «?»", "aria-label": `Підказка до поля ${f.label}`, oninput: (ev) => { f.help = ev.target.value; } }));
        return el("li", { class: "jr-schema-row" + (f.hidden ? " is-off" : "") },
          el("div", { class: "jr-schema-main" },
            el("div", { class: "jr-schema-move" },
              el("button", { type: "button", class: "jr-icon jr-up", "aria-label": `Підняти поле ${f.label}`, text: "↑", disabled: i === 0, onclick: () => move(i, -1) }),
              el("button", { type: "button", class: "jr-icon jr-down", "aria-label": `Опустити поле ${f.label}`, text: "↓", disabled: i === working.length - 1, onclick: () => move(i, 1) })),
            label,
            el("span", { class: "jr-type", text: (state.meta.types.find((t) => t.id === f.type) || {}).label || f.type }),
            hidden, inTable, del),
          tip, opts);
      }

      const add = () => {
        err.hidden = true;
        const name = nameInp.value.trim();
        if (!name) { JR.showError(err, new Error("Введи назву нового поля.")); nameInp.focus(); return; }
        const type = typeSel.value;
        if (type === "media" && mediaCount() >= 3) { JR.showError(err, new Error("Полів для файлів не більше 3.")); return; }
        if (working.length >= 60) { JR.showError(err, new Error("Полів не більше 60.")); return; }
        const f = { label: name, type, hidden: false, table: false, builtin: false };
        if (type === "select" || type === "multiselect") f.options = ["Варіант 1", "Варіант 2"];
        working.push(f); nameInp.value = ""; paint();
        const last = list.lastElementChild; if (last) { last.scrollIntoView({ block: "nearest" }); const inp = last.querySelector("input[type=text]"); if (inp) inp.focus(); }
      };

      await JR.modal((done) => {
        paint();
        const save = el("button", { type: "button", class: "jr-btn is-primary", text: "Зберегти поля" });
        save.addEventListener("click", async () => {
          err.hidden = true;
          const payload = working.map((f) => {
            const o = { label: (f.label || "").trim(), type: f.type, hidden: !!f.hidden, table: !!f.table };
            if (f.key) o.key = f.key;
            if (f.options) o.options = f.options;
            if (!f.builtin && f.help) o.help = f.help;
            return o;
          });
          save.disabled = true; save.textContent = "Зберігаю…";
          try {
            const r = await JR.api.put(`/journals/${j.id}/fields`, { fields: payload });
            state.fields = r.fields;
            JR.toast("Поля збережено");
            done(true);
          } catch (e) { save.disabled = false; save.textContent = "Зберегти поля"; JR.showError(err, e); }
        });
        return el("div", { class: "jr-schema" },
          el("div", { class: "jr-dlg-head" }, el("h2", { id: "jr-dlg-title", text: `Поля журналу «${j.name}»` }),
            el("button", { type: "button", class: "jr-x", "aria-label": "Закрити", text: "×", onclick: () => done(false) })),
          el("p", { class: "jr-note", text: "Вбудовані поля можна сховати й перейменувати, але не видалити. Власні поля можна додавати, міняти місцями й видаляти. Тип поля після створення змінити не можна." }),
          list,
          el("div", { class: "jr-schema-add" },
            el("h3", { text: "Нове поле" }),
            el("div", { class: "jr-schema-new" }, nameInp, typeSel, el("button", { type: "button", class: "jr-btn", text: "Додати поле", onclick: add })), typeHint),
          err,
          el("div", { class: "jr-actions" }, el("span", { class: "jr-spacer" }), el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => done(false) }), save));
      }, { cls: "is-wide" });
    },
  };
})();
