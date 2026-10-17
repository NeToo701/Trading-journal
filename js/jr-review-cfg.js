/* Журнал: вікно «Налаштувати розбір». Тут задається, з чого складається сторінка «Розбір місяця»:
   1) блоки сторінки (показати/сховати, порядок),
   2) статистика в підсумку: готова або власна за формулою (формули рахує lib/jl-formula.js без eval),
   3) поля висновку місяця будь-яких типів (порядок, ширина),
   4) питання по кожній угоді: будь-які поля журналу, у тому числі нові.
   Усе лежить у налаштуваннях журналу (journal.review_cfg) і синхронізується разом із ним. Нові поля журналу створюються при збереженні. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, state } = JR;
  const TABS = [["blocks", "Блоки"], ["metrics", "Статистика"], ["month", "Поля висновку"], ["pos", "Питання по угоді"]];
  const jlr = () => window.JL.reviewCfg;
  const typeLabel = (t) => (state.meta.types.find((x) => x.id === t) || {}).label || t;
  const newTypes = () => state.meta.types.filter((t) => t.id !== "media");
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function chk(text, checked, onchange, disabled) {
    return el("label", { class: "jr-check" }, el("input", { type: "checkbox", checked: !!checked, disabled: !!disabled, onchange: (ev) => onchange(ev.target.checked) }), el("span", { text }));
  }
  const blank = () => el("span", { "aria-hidden": "true" });

  JR.reviewCfg = {
    /** Відкриває вікно. Повертає true, якщо налаштування збережено. */
    async edit() {
      const j = JR.currentJournal();
      let w;
      try { w = clone((await JR.api.get(`/journals/${j.id}/review-config`)).config); }
      catch (e) { JR.toast(e.message, "error"); return false; }
      let tab = "blocks", curList = null, formulaInput = null;
      const err = el("div", { class: "jr-error", role: "alert", hidden: true });
      const content = el("div", { class: "jr-cfg-body", id: "jr-cfg-body" });

      const repaint = () => { content.replaceChildren(...build()); };
      function move(arr, i, d) {
        const k = i + d;
        if (k < 0 || k >= arr.length) return;
        [arr[i], arr[k]] = [arr[k], arr[i]];
        repaint();
        const b = curList && curList.children[k] && curList.children[k].querySelector(d < 0 ? ".jr-up" : ".jr-down");
        if (b) b.focus();
      }
      const arrows = (arr, i, name) => el("div", { class: "jr-schema-move" },
        el("button", { type: "button", class: "jr-icon jr-up", "aria-label": `Підняти: ${name}`, text: "↑", disabled: i === 0, onclick: () => move(arr, i, -1) }),
        el("button", { type: "button", class: "jr-icon jr-down", "aria-label": `Опустити: ${name}`, text: "↓", disabled: i === arr.length - 1, onclick: () => move(arr, i, 1) }));
      const list = (rows) => { curList = el("ol", { class: "jr-schema-list" }, rows); return curList; };

      // ---------------------------------------------------------------- блоки
      function tabBlocks() {
        const names = new Map(jlr().BLOCKS);
        return [el("p", { class: "jr-note", text: "Блоки показуються на сторінці зверху вниз у цьому порядку. Приховані блоки не видаляються: їх можна повернути." }),
          list(w.blocks.map((b, i) => el("li", { class: "jr-schema-row" + (b.visible ? "" : " is-off") },
            el("div", { class: "jr-schema-main" }, arrows(w.blocks, i, names.get(b.id)), el("strong", { text: names.get(b.id) }), el("span", { class: "jr-type", text: "Блок сторінки" }),
              chk("Показувати", b.visible, (v) => { b.visible = v; repaint(); }), blank(), blank()))))];
      }

      // ---------------------------------------------------------------- статистика
      const preview = (m) => {
        const ctx = JR.review.context();
        if (!ctx) return { text: "—", note: "Відкрий місяць з угодами, щоб побачити значення." };
        const r = jlr().evalMetric(m, ctx.summary, jlr().makeFieldAgg(ctx.fields, ctx.rows), state.fields);
        return r.error ? { text: "—", error: r.error } : { text: JR.review.fmtMetric(r.value, jlr().metricFmt(m), j.currency) };
      };

      function insertAtCursor(text) {
        if (!formulaInput || !formulaInput.isConnected) { JR.toast("Спочатку клікни в поле формули.", "error"); return; }
        const inp = formulaInput, a = inp.selectionStart == null ? inp.value.length : inp.selectionStart, b = inp.selectionEnd == null ? a : inp.selectionEnd;
        inp.value = inp.value.slice(0, a) + text + inp.value.slice(b);
        const pos = a + text.length; inp.focus(); inp.setSelectionRange(pos, pos);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }

      function metricRow(m, i) {
        const def = jlr().metricLabel({ id: m.id }, j.currency);
        const info = el("span", { class: "jr-type jr-cfg-val" });
        const showPreview = () => { const p = preview(m); info.textContent = p.text; info.classList.toggle("is-bad", !!p.error); info.title = p.error || ""; return p; };
        showPreview();
        const name = el("input", { type: "text", value: m.custom ? m.label : jlr().metricLabel(m, j.currency), maxlength: "60", "aria-label": "Назва статистики",
          oninput: (ev) => { const v = ev.target.value; if (m.custom) m.label = v; else if (v.trim() && v.trim() !== def) m.label = v; else delete m.label; } });
        const del = m.custom ? el("button", { type: "button", class: "jr-btn is-danger-quiet", text: "Видалити", "aria-label": `Видалити статистику ${m.label}`,
          onclick: () => { w.metrics = w.metrics.filter((x) => x !== m); repaint(); } }) : blank();
        const row = el("div", { class: "jr-schema-main" }, arrows(w.metrics, i, m.label || def), name, info, chk("Показувати", m.visible, (v) => { m.visible = v; li.classList.toggle("is-off", !v); }),
          el("span", { class: "jr-type", text: m.custom ? "Формула" : "Готова" }), del);
        const li = el("li", { class: "jr-schema-row" + (m.visible ? "" : " is-off") }, row);
        if (m.custom) {
          const msg = el("small", { class: "jr-cfg-msg" });
          const hasField = (r) => !!jlr().fieldLookup(state.fields)(r);
          const validate = () => {
            showPreview();
            try { window.JL.formula.compile(m.formula || "", { hasField }); msg.textContent = ""; msg.classList.remove("is-bad"); }
            catch (e) { msg.textContent = e.message; msg.classList.add("is-bad"); }
          };
          const f = el("input", { type: "text", class: "jr-cfg-formula", value: m.formula || "", maxlength: String(window.JL.formula.MAX_LEN), spellcheck: "false", autocomplete: "off",
            placeholder: "Формула, наприклад: win_rate / 100 * avg_r", "aria-label": `Формула для ${m.label}`,
            oninput: (ev) => { m.formula = ev.target.value; validate(); }, onfocus: (ev) => { formulaInput = ev.target; } });
          const fm = el("select", { "aria-label": "Формат значення", onchange: (ev) => { m.fmt = ev.target.value; validate(); } },
            jlr().FORMATS.map(([v, t]) => el("option", { value: v, selected: v === m.fmt, text: t })));
          const dec = el("select", { "aria-label": "Знаків після коми", onchange: (ev) => { m.dec = Number(ev.target.value); validate(); } },
            [0, 1, 2, 3, 4].map((n) => el("option", { value: String(n), selected: n === m.dec, text: n === 0 ? "ціле число" : `до ${n} знаків після коми` })));
          li.append(el("div", { class: "jr-cfg-sub" }, f, fm, dec), msg);
          validate();
        }
        return li;
      }

      function tabMetrics() {
        const vars = el("div", { class: "jr-cfg-vars" }, window.JL.formula.VARS.map(([k, t]) =>
          el("button", { type: "button", class: "jr-cfg-var", title: t, text: k, onclick: () => insertAtCursor(k) })));
        const fieldSel = el("select", { "aria-label": "Вставити поле журналу", onchange: (ev) => { if (ev.target.value) insertAtCursor(`[${ev.target.value}]`); ev.target.value = ""; } },
          el("option", { value: "", text: "Вставити поле журналу…" }), state.fields.filter((f) => f.type !== "media").map((f) => el("option", { value: f.label, text: f.label })));
        const addBtn = el("button", { type: "button", class: "jr-btn", id: "jr-cfg-add-metric", text: "＋ Додати свою статистику", onclick: () => {
          if (w.metrics.filter((m) => m.custom).length >= jlr().LIMITS.CUSTOM) { JR.showError(err, new Error(`Власних статистик не більше ${jlr().LIMITS.CUSTOM}.`)); return; }
          err.hidden = true;
          w.metrics.push({ custom: true, visible: true, label: "Моя статистика", formula: "", fmt: "number", dec: 2 });
          repaint(); content.scrollTop = content.scrollHeight;
          const inputs = content.querySelectorAll(".jr-cfg-formula"); const last = inputs[inputs.length - 1]; if (last) last.focus();
        } });
        return [
          el("p", { class: "jr-note", text: "Обирай, які цифри показувати в підсумку місяця, міняй їхній порядок і назви. Можна додати власну статистику: напиши формулу з готових змінних. Праворуч від назви видно значення за відкритий місяць." }),
          list(w.metrics.map((m, i) => metricRow(m, i))),
          addBtn,
          el("details", { class: "jr-cfg-help" }, el("summary", { text: "Як писати формули" }),
            el("p", { class: "jr-note", text: "Клікни в поле формули, потім на змінну, щоб вставити її. Можна: + − * / % ^ (степінь), дужки, порівняння < > <= >= == != та && || !. Функції: abs, round(x, знаків), floor, ceil, sqrt, min(a, b), max(a, b), if(умова, так, ні), ifnull(x, запасне). Ділення на нуль дає «—»." }),
            el("p", { class: "jr-note", text: "Підсумки по полях журналу беруться із закритих угод місяця: sum([Поле]), avg([Поле]), min([Поле]), max([Поле]), count([Поле]) (скільки угод заповнено), countif([Поле], \"Так\") (скільки угод мають це значення). Назва поля пишеться в квадратних дужках так, як у журналі." }),
            el("p", { class: "jr-note", text: "Приклади: win_rate / 100 * avg_win + (1 - win_rate / 100) * avg_loss (математичне сподівання)  ·  countif([Чи була угода за правилами?], \"Так\") / trades * 100 (% угод за правилами)  ·  sum([Комісії]) (комісії за місяць)." }),
            vars, fieldSel)];
      }

      // ---------------------------------------------------------------- поля висновку
      function monthRow(f, i) {
        const name = el("input", { type: "text", value: f.label, maxlength: "60", "aria-label": "Назва поля", oninput: (ev) => { f.label = ev.target.value; } });
        const del = f.builtin ? blank() : el("button", { type: "button", class: "jr-btn is-danger-quiet", text: "Видалити", "aria-label": `Видалити поле ${f.label}`,
          onclick: async () => {
            if (!(await JR.confirm({ title: "Видалити поле?", text: `Поле «${f.label}» зникне зі сторінки розбору, а введені в ньому значення більше не показуватимуться.`, ok: "Видалити", danger: true }))) return;
            w.month_fields = w.month_fields.filter((x) => x !== f); repaint();
          } });
        const li = el("li", { class: "jr-schema-row" + (f.visible ? "" : " is-off") },
          el("div", { class: "jr-schema-main" }, arrows(w.month_fields, i, f.label), name, el("span", { class: "jr-type", text: f.builtin ? "Великий текст" : typeLabel(f.type) }),
            chk("Показувати", f.visible, (v) => { f.visible = v; li.classList.toggle("is-off", !v); }),
            chk("На всю ширину", f.wide, (v) => { f.wide = v; }), del));
        if (!f.builtin && (f.type === "select" || f.type === "multiselect")) {
          li.append(el("div", { class: "jr-field jr-opts" }, el("label", { text: "Варіанти, кожен з нового рядка" }),
            el("textarea", { rows: "3", "aria-label": `Варіанти для ${f.label}`, text: (f.options || []).join("\n"), oninput: (ev) => { f.options = ev.target.value.split("\n").map((x) => x.trim()).filter(Boolean); } })));
        }
        return li;
      }

      function addForm(placeholder, onAdd, withForm) {
        const nameInp = el("input", { type: "text", maxlength: "60", placeholder, autocomplete: "off", "aria-label": "Назва нового поля" });
        const typeSel = el("select", { "aria-label": "Тип нового поля" }, newTypes().map((t) => el("option", { value: t.id, selected: t.id === "longtext", text: t.label })));
        const extra = withForm ? chk("Також показувати у формі запису", false, (v) => { extra.dataset.on = v ? "1" : ""; }) : null;
        const go = () => {
          err.hidden = true;
          const name = nameInp.value.trim();
          if (!name) { JR.showError(err, new Error("Введи назву нового поля.")); nameInp.focus(); return; }
          if (onAdd(name, typeSel.value, !!(extra && extra.dataset.on))) { nameInp.value = ""; }
        };
        nameInp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); go(); } });
        return el("div", { class: "jr-schema-add" }, el("h3", { text: "Нове поле" }),
          el("div", { class: "jr-schema-new" }, nameInp, typeSel, el("button", { type: "button", class: "jr-btn", text: "Додати поле", onclick: go })), extra);
      }

      function tabMonth() {
        return [el("p", { class: "jr-note", text: "Поля, які заповнюються один раз на місяць у блоці «Висновок місяця». Типи будь-які: текст, число, відсоток, список, оцінка від 1 до 5, галочка, дата, посилання." }),
          list(w.month_fields.map((f, i) => monthRow(f, i))),
          addForm("Назва поля, наприклад «Оцінка місяця»", (name, type) => {
            if (w.month_fields.length >= jlr().LIMITS.MONTH_FIELDS) { JR.showError(err, new Error(`Полів висновку не більше ${jlr().LIMITS.MONTH_FIELDS}.`)); return false; }
            const f = { key: undefined, label: name, type, visible: true, wide: type === "longtext" || type === "multiselect" };
            if (type === "select" || type === "multiselect") f.options = ["Варіант 1", "Варіант 2"];
            w.month_fields.push(f); repaint(); content.scrollTop = content.scrollHeight;
            return true;
          })];
      }

      // ---------------------------------------------------------------- питання по угоді
      const fieldOf = (key) => state.fields.find((f) => f.key === key);
      function posRow(p, i) {
        const f = p.key ? fieldOf(p.key) : null;
        const tmp = p.tmp;
        const label = tmp ? el("input", { type: "text", value: tmp.label, maxlength: "60", "aria-label": "Назва нового поля", oninput: (ev) => { tmp.label = ev.target.value; } })
          : el("strong", { text: f ? f.label : "(поле видалено)" });
        const li = el("li", { class: "jr-schema-row" + (p.visible ? "" : " is-off") },
          el("div", { class: "jr-schema-main" }, arrows(w.pos_fields, i, tmp ? tmp.label : (f && f.label) || "поле"), label,
            el("span", { class: "jr-type", text: tmp ? `${typeLabel(tmp.type)} (нове)` : f ? typeLabel(f.type) : "" }),
            chk("Показувати", p.visible, (v) => { p.visible = v; li.classList.toggle("is-off", !v); }),
            tmp ? chk("Також у формі запису", tmp.inForm, (v) => { tmp.inForm = v; }) : blank(),
            el("button", { type: "button", class: "jr-btn is-danger-quiet", text: tmp ? "Прибрати" : "Прибрати з розбору", title: tmp ? "" : "Поле лишається в журналі, зникає лише з питань розбору",
              onclick: () => { w.pos_fields = w.pos_fields.filter((x) => x !== p); repaint(); } })));
        if (tmp && (tmp.type === "select" || tmp.type === "multiselect")) {
          li.append(el("div", { class: "jr-field jr-opts" }, el("label", { text: "Варіанти, кожен з нового рядка" }),
            el("textarea", { rows: "3", "aria-label": `Варіанти для ${tmp.label}`, text: tmp.options.join("\n"), oninput: (ev) => { tmp.options = ev.target.value.split("\n").map((x) => x.trim()).filter(Boolean); } })));
        }
        return li;
      }

      function tabPos() {
        const used = new Set(w.pos_fields.filter((p) => p.key).map((p) => p.key));
        const free = state.fields.filter((f) => f.type !== "media" && !used.has(f.key));
        const pick = el("select", { id: "jr-cfg-pick", "aria-label": "Поле журналу для додавання" }, free.map((f) => el("option", { value: f.key, text: f.label })));
        const addOld = el("div", { class: "jr-schema-add" }, el("h3", { text: "Додати наявне поле журналу" }),
          el("div", { class: "jr-schema-new" }, pick, blank(), el("button", { type: "button", class: "jr-btn", id: "jr-cfg-add-old", text: "Додати в розбір", disabled: !free.length, onclick: () => {
            if (!pick.value) return;
            if (w.pos_fields.length >= jlr().LIMITS.POS_FIELDS) { JR.showError(err, new Error(`Питань по угоді не більше ${jlr().LIMITS.POS_FIELDS}.`)); return; }
            w.pos_fields.push({ key: pick.value, visible: true }); repaint();
          } })));
        return [el("p", { class: "jr-note", text: "Питання, які задаються в картці кожної угоди. Відповіді записуються прямо в запис журналу. Список і порядок свої; скріншоти й відео показуються завжди окремо." }),
          list(w.pos_fields.map((p, i) => posRow(p, i))),
          addOld,
          addForm("Назва нового поля, наприклад «Чи був сигнал?»", (name, type, inForm) => {
            if (w.pos_fields.length >= jlr().LIMITS.POS_FIELDS) { JR.showError(err, new Error(`Питань по угоді не більше ${jlr().LIMITS.POS_FIELDS}.`)); return false; }
            if (state.fields.length + w.pos_fields.filter((p) => p.tmp).length >= window.JL.LIMITS.MAX_FIELDS) { JR.showError(err, new Error(`Полів у журналі не більше ${window.JL.LIMITS.MAX_FIELDS}.`)); return false; }
            const tmp = { label: name, type, inForm, options: type === "select" || type === "multiselect" ? ["Так", "Ні"] : undefined };
            w.pos_fields.push({ tmp, visible: true }); repaint(); content.scrollTop = content.scrollHeight;
            return true;
          }, true)];
      }

      function build() {
        err.hidden = true;
        return tab === "blocks" ? tabBlocks() : tab === "metrics" ? tabMetrics() : tab === "month" ? tabMonth() : tabPos();
      }

      // ---------------------------------------------------------------- збереження
      const fieldPayload = (f) => {
        const o = { label: f.label, type: f.type, hidden: !!f.hidden, table: !!f.table, key: f.key };
        if (f.options) o.options = f.options;
        if (!f.builtin && f.help) o.help = f.help;
        return o;
      };

      const saved = await JR.modal((done) => {
        const tabsNav = el("div", { class: "jr-tabs jr-cfg-tabs", role: "tablist", "aria-label": "Розділи налаштувань" }, TABS.map(([id, t]) =>
          el("button", { type: "button", role: "tab", class: "jr-tab", id: "jr-cfg-tab-" + id, "aria-selected": String(tab === id), text: t, onclick: () => {
            tab = id; tabsNav.querySelectorAll(".jr-tab").forEach((b) => b.setAttribute("aria-selected", String(b.id === "jr-cfg-tab-" + id))); repaint();
          } })));
        repaint();
        const saveBtn = el("button", { type: "button", class: "jr-btn is-primary", id: "jr-cfg-save", text: "Зберегти" });
        saveBtn.addEventListener("click", async () => {
          err.hidden = true; saveBtn.disabled = true; saveBtn.textContent = "Зберігаю…";
          try {
            const tmps = w.pos_fields.filter((p) => p.tmp);
            if (tmps.length) {
              const payload = state.fields.map(fieldPayload).concat(tmps.map(({ tmp }) => {
                const o = { label: tmp.label.trim(), type: tmp.type, hidden: !tmp.inForm, table: false };
                if (tmp.options) o.options = tmp.options;
                return o;
              }));
              const r = await JR.api.put(`/journals/${j.id}/fields`, { fields: payload });
              state.fields = r.fields;
              const created = r.fields.slice(r.fields.length - tmps.length);
              tmps.forEach((p, k) => { p.key = created[k].key; delete p.tmp; });
            }
            const r2 = await JR.api.put(`/journals/${j.id}/review-config`, { config: w });
            w = clone(r2.config);
            JR.toast("Налаштування розбору збережено");
            done(true);
          } catch (e) { saveBtn.disabled = false; saveBtn.textContent = "Зберегти"; JR.showError(err, e); }
        });
        const reset = el("button", { type: "button", class: "jr-btn is-quiet", id: "jr-cfg-reset", text: "Скинути до стандартного", onclick: async () => {
          if (!(await JR.confirm({ title: "Скинути налаштування розбору?", text: "Блоки, статистика, поля висновку й питання по угоді повернуться до стандартних. Власні формули й поля висновку зникнуть зі сторінки. Поля журналу, створені тут, лишаться в журналі.", ok: "Скинути", danger: true }))) return;
          w = clone(jlr().defaults(state.fields)); repaint();
        } });
        return el("div", { class: "jr-schema jr-cfg" },
          el("div", { class: "jr-dlg-head" }, el("h2", { id: "jr-dlg-title", text: `Налаштувати розбір: «${j.name}»` }),
            el("button", { type: "button", class: "jr-x", "aria-label": "Закрити", text: "×", onclick: () => done(false) })),
          tabsNav, content, err,
          el("div", { class: "jr-actions" }, reset, el("span", { class: "jr-spacer" }), el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => done(false) }), saveBtn));
      }, { cls: "is-wide" });
      return saved === true;
    },
  };
})();
