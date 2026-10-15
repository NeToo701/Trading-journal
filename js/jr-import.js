/* Журнал: імпорт записів із таблиці CSV або з архіву експорту Notion (ZIP). Три кроки: файл, зіставлення колонок, підсумок. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, state } = JR;

  JR.importer = {
    async open() {
      const j = JR.currentJournal();
      const limits = state.meta.limits;
      let changed = false;
      await JR.modal((done, dlg) => {
        const root = el("div", { class: "jr-import" });
        const head = (t) => el("div", { class: "jr-dlg-head" }, el("h2", { id: "jr-dlg-title", text: t }), el("button", { type: "button", class: "jr-x", "aria-label": "Закрити", text: "×", onclick: () => done(changed) }));
        const show = (...nodes) => root.replaceChildren(...nodes.filter(Boolean));

        // ---- крок 1: файл
        function stepFile(message) {
          const err = el("div", { class: "jr-error", role: "alert", hidden: true });
          if (message) JR.showError(err, new Error(message));
          const input = el("input", { type: "file", accept: ".csv,.zip,text/csv,application/zip", class: "jr-file", id: "jr-imp-file" });
          const drop = el("label", { class: "jr-drop", for: "jr-imp-file" }, el("strong", { text: "Обери файл експорту" }), el("span", { text: `CSV-таблицю або ZIP-архів із Notion, до ${limits.import_mb} МБ. Можна перетягнути сюди.` }));
          ["dragenter", "dragover"].forEach((n) => drop.addEventListener(n, (ev) => { ev.preventDefault(); drop.classList.add("is-over"); }));
          ["dragleave", "drop"].forEach((n) => drop.addEventListener(n, (ev) => { ev.preventDefault(); drop.classList.remove("is-over"); }));
          drop.addEventListener("drop", (ev) => { if (ev.dataTransfer.files[0]) upload(ev.dataTransfer.files[0], err); });
          input.addEventListener("change", () => { if (input.files[0]) upload(input.files[0], err); input.value = ""; });
          show(head(`Імпорт у журнал «${j.name}»`),
            el("ol", { class: "jr-steps" },
              el("li", { text: "У Notion відкрий свою базу угод, натисни «⋯» і «Export»." }),
              el("li", { text: "Формат «Markdown & CSV». Якщо хочеш перенести й скріншоти зі сторінок угод, увімкни «Include subpages»." }),
              el("li", { text: "Завантажений ZIP (або окремий CSV) обери нижче. Нічого не зміниться, поки ти не підтвердиш на наступному кроці." })),
            drop, input, err,
            el("p", { class: "jr-note", text: "Колонки зіставляються з полями журналу автоматично, потім їх можна виправити. Повторний імпорт того самого файлу не створює дублікатів." }),
            el("div", { class: "jr-actions" }, el("span", { class: "jr-spacer" }), el("button", { type: "button", class: "jr-btn", text: "Закрити", onclick: () => done(changed) })));
        }

        async function upload(file, err) {
          err.hidden = true;
          if (file.size > limits.import_mb * 1048576) { JR.showError(err, new Error(`Файл завеликий: до ${limits.import_mb} МБ.`)); return; }
          show(head("Читаю файл…"), el("p", { class: "jr-dim", role: "status", text: `Завантажую «${file.name}» і розпізнаю колонки. Для великого архіву це може зайняти хвилину.` }));
          try {
            const info = await JR.api.upload(`/journals/${j.id}/import?name=${encodeURIComponent(file.name)}`, file);
            stepMap(info, file.name);
          } catch (e) { stepFile(e.message); }
        }

        // ---- крок 2: зіставлення колонок
        function stepMap(info, fileName) {
          const targets = state.fields.filter((f) => f.type !== "media");
          const selects = info.columns.map((c) => el("select", { "aria-label": `Куди імпортувати колонку ${c.name}`, "data-col": c.name },
            el("option", { value: "", text: "— не імпортувати —" }), targets.map((f) => el("option", { value: f.key, selected: f.key === c.target, text: f.label }))));
          const err = el("div", { class: "jr-error", role: "alert", hidden: true });
          const skip = el("input", { type: "checkbox", id: "jr-imp-skip", checked: true });
          const dayFirst = el("select", { id: "jr-imp-day", "aria-label": "Порядок дати" },
            el("option", { value: "1", text: "день/місяць (01/07/2026 це 1 липня)" }), el("option", { value: "0", text: "місяць/день (01/07/2026 це 7 січня)" }));
          const go = el("button", { type: "button", class: "jr-btn is-primary", id: "jr-imp-go", text: `Імпортувати ${info.rows} рядків` });
          go.addEventListener("click", async () => {
            err.hidden = true;
            const mapping = {};
            selects.forEach((s) => { if (s.value) mapping[s.dataset.col] = s.value; });
            const vals = Object.values(mapping);
            if (!vals.includes("opened_at") && !vals.includes("closed_at")) { JR.showError(err, new Error("Обери колонку для «Дата й час входу»: без дати запис не можна додати.")); return; }
            const dup = vals.find((v, i) => vals.indexOf(v) !== i && (state.fields.find((f) => f.key === v) || {}).type !== "longtext");
            if (dup) { JR.showError(err, new Error(`Поле «${state.fields.find((f) => f.key === dup).label}» вибране для кількох колонок. Лишився один варіант.`)); return; }
            go.disabled = true; go.textContent = "Імпортую…";
            try {
              const res = await JR.api.post(`/journals/${j.id}/import/${info.token}`, { mapping, skip_duplicates: skip.checked, day_first: dayFirst.value === "1" });
              changed = true;
              stepDone(res);
            } catch (e) { go.disabled = false; go.textContent = `Імпортувати ${info.rows} рядків`; JR.showError(err, e); }
          });
          show(head("Зістав колонки"),
            el("p", { class: "jr-note", text: `Файл «${fileName}»: рядків ${info.rows}${info.kind === "zip" ? `, таблиця «${info.csv_name.split("/").pop()}»` : ""}.${info.images ? ` Знайдено скріншоти для ${info.images_rows} угод (${info.images} фото): їх буде прикріплено.` : info.kind === "zip" ? " Скріншотів на сторінках угод не знайдено." : ""}` }),
            el("div", { class: "jr-table-wrap jr-imp-wrap" }, el("table", { class: "jr-table jr-table-static jr-imp-table" },
              el("thead", null, el("tr", null, el("th", { scope: "col", text: "Колонка у файлі" }), el("th", { scope: "col", text: "Приклади" }), el("th", { scope: "col", text: "Поле журналу" }))),
              el("tbody", null, info.columns.map((c, i) => el("tr", null,
                el("th", { scope: "row", text: c.name }), el("td", { class: "jr-imp-samples", "data-label": "Приклади", text: c.samples.join(" | ") || "порожньо" }), el("td", { "data-label": "Поле журналу" }, selects[i])))))),
            el("div", { class: "jr-imp-opts" },
              el("label", { class: "jr-check" }, skip, el("span", { text: "Пропускати дублікати (той самий час входу, інструмент і напрямок)" })),
              el("div", { class: "jr-field" }, el("label", { for: "jr-imp-day", text: "Якщо дата записана цифрами" }), dayFirst)),
            err,
            el("div", { class: "jr-actions" }, el("span", { class: "jr-spacer" }), el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => done(changed) }), go));
        }

        // ---- крок 3: підсумок
        function stepDone(res) {
          show(head("Імпорт завершено"),
            el("ul", { class: "jr-imp-res" },
              el("li", null, el("strong", { text: String(res.created) }), " записів додано"),
              res.duplicates ? el("li", null, el("strong", { text: String(res.duplicates) }), " пропущено як дублікати") : null,
              res.media_added ? el("li", null, el("strong", { text: String(res.media_added) }), " скріншотів прикріплено") : null,
              res.failed_total ? el("li", { class: "is-bad" }, el("strong", { text: String(res.failed_total) }), " рядків не імпортовано") : null),
            res.failed.length ? el("details", { open: true }, el("summary", { text: "Що не вдалося" }), el("ul", { class: "jr-note" }, res.failed.map((f) => el("li", { text: `Рядок ${f.row}: ${f.message}` })))) : null,
            res.warnings.length ? el("details", null, el("summary", { text: "Попередження" }), el("ul", { class: "jr-note" }, res.warnings.map((w) => el("li", { text: `${w.text} (разів: ${w.count})` })))) : null,
            Object.keys(res.new_options || {}).length ? el("p", { class: "jr-note", text: "Нові варіанти у списках додано до полів: " + Object.entries(res.new_options).map(([k, v]) => `${(state.fields.find((f) => f.key === k) || { label: k }).label}: ${v.join(", ")}`).join("; ") + "." }) : null,
            el("div", { class: "jr-actions" }, el("span", { class: "jr-spacer" }), el("button", { type: "button", class: "jr-btn is-primary", id: "jr-imp-close", "data-autofocus": "1", text: "Готово", onclick: () => done(true) })));
        }

        stepFile();
        return root;
      }, { cls: "is-wide" });
      if (changed) {
        try { state.fields = (await JR.api.get(`/journals/${j.id}/fields`)).fields; } catch (e) { /* ок */ }
        JR.bus.dispatchEvent(new Event("imported"));
      }
    },
  };
})();
