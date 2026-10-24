/* Журнал: список записів із фільтрами, форма запису, завантаження файлів, перегляд фото й відео. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, fmt, state } = JR;
  const $ = (s, r) => (r || document).querySelector(s);
  const PAGE = 50;
  const OUTCOMES = [["", "Усі статуси"], ["win", "Прибуткові"], ["loss", "Збиткові"], ["be", "Беззбиток"], ["open", "Відкриті"]];

  const E = (JR.entries = {});
  let filters = { q: "", outcome: "", direction: "", from: "", to: "" };
  let loaded = [], total = 0, timer = null, seq = 0;

  const visibleFields = () => state.fields.filter((f) => !f.hidden);
  const tableFields = () => state.fields.filter((f) => f.table && !f.hidden && f.type !== "media" && f.type !== "longtext");
  const mediaFields = () => state.fields.filter((f) => f.type === "media" && !f.hidden);

  // ---------------------------------------------------------------- список
  E.render = function (root) {
    root.replaceChildren();
    const j = JR.currentJournal();
    const search = el("input", { type: "search", id: "jr-q", placeholder: "Пошук за текстом запису", value: filters.q, "aria-label": "Пошук", autocomplete: "off" });
    const status = el("select", { "aria-label": "Статус" }, OUTCOMES.map(([v, t]) => el("option", { value: v, selected: v === filters.outcome, text: t })));
    const dir = el("select", { "aria-label": "Напрямок" }, [["", "Лонг і шорт"], ["Лонг", "Лонг"], ["Шорт", "Шорт"]].map(([v, t]) => el("option", { value: v, selected: v === filters.direction, text: t })));
    const from = el("input", { type: "date", "aria-label": "Від", value: filters.from });
    const to = el("input", { type: "date", "aria-label": "До", value: filters.to });
    const reload = () => { filters = { q: search.value.trim(), outcome: status.value, direction: dir.value, from: from.value, to: to.value }; load(true); };
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(reload, 300); });
    for (const n of [status, dir, from, to]) n.addEventListener("change", reload);
    const reset = el("button", { type: "button", class: "jr-btn is-quiet", text: "Скинути", onclick: () => { filters = { q: "", outcome: "", direction: "", from: "", to: "" }; E.render(root); } });
    root.append(
      el("div", { class: "jr-toolbar" },
        el("button", { type: "button", class: "jr-btn is-primary", id: "jr-new", text: "Новий запис", onclick: () => E.edit(null) }),
        el("div", { class: "jr-filters" }, search, status, dir, el("label", { class: "jr-range" }, el("span", { text: "Від" }), from), el("label", { class: "jr-range" }, el("span", { text: "До" }), to), reset)),
      el("div", { class: "jr-error", id: "jr-list-error", role: "alert", hidden: true }),
      el("div", { class: "jr-list", id: "jr-list", "aria-live": "polite" }),
      el("div", { class: "jr-more" }, el("button", { type: "button", class: "jr-btn", id: "jr-more", hidden: true, text: "Показати ще", onclick: () => load(false) })),
      el("datalist", { id: "jr-symbols" }, JR.fields.symbols(j && j.market).map((s) => el("option", { value: s }))));
    load(true);
  };

  async function load(reset) {
    const list = $("#jr-list");
    if (!list) return;
    const my = ++seq;
    const j = JR.currentJournal();
    const offset = reset ? 0 : loaded.length;
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (filters.q) qs.set("q", filters.q);
    if (filters.outcome) qs.set("outcome", filters.outcome);
    if (filters.direction) qs.set("direction", filters.direction);
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    try {
      const data = await JR.api.get(`/journals/${j.id}/entries?${qs}`);
      if (my !== seq) return;
      $("#jr-list-error").hidden = true;
      loaded = reset ? data.entries : loaded.concat(data.entries);
      total = data.total;
      paint();
    } catch (e) {
      if (my === seq) JR.showError($("#jr-list-error"), e);
    }
  }

  function paint() {
    const list = $("#jr-list"), j = JR.currentJournal();
    if (!list) return;
    const filtered = filters.q || filters.outcome || filters.direction || filters.from || filters.to;
    if (!loaded.length) {
      list.replaceChildren(el("div", { class: "jr-empty" },
        el("h3", { text: filtered ? "Нічого не знайдено" : "У цьому журналі ще немає записів" }),
        el("p", { text: filtered ? "Зміни або скинь фільтри." : "Додай першу угоду або нотатку: дата входу вже підставлена, решту полів можна залишити порожніми." })));
    } else {
      const cols = tableFields();
      const head = el("tr", null, cols.map((f) => el("th", { scope: "col", text: f.label })), el("th", { scope: "col", text: "Файли" }));
      const body = loaded.map((e) => {
        const tr = el("tr", { class: "jr-row", tabindex: "0", "data-id": String(e.id), role: "button", "aria-label": `Відкрити запис від ${fmt.dateTime(e.data.opened_at)}` },
          cols.map((f) => el("td", { "data-label": f.label }, JR.fields.display(f, f.key === "r" && e.data.r == null ? JR.fields.calcR(e.data) : e.data[f.key], { currency: j.currency }))),
          el("td", { "data-label": "Файли", class: "jr-dim", text: e.media.length ? `${e.media.length}` : "—" }));
        tr.addEventListener("click", () => E.edit(e.id));
        tr.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); E.edit(e.id); } });
        return tr;
      });
      const wrap = el("div", { class: "jr-table-wrap" }, el("table", { class: "jr-table" }, el("thead", null, head), el("tbody", null, body)));
      list.replaceChildren(tableNav(wrap), wrap, el("p", { class: "jr-count", text: `Показано ${loaded.length} із ${total}` }));
    }
    const more = $("#jr-more");
    if (more) more.hidden = loaded.length >= total;
  }

  /* Кнопки над таблицею: прокрутити її вбік до кінця й назад. Повзунок прокрутки таблиці стоїть під нею, а при багатьох угодах
     до нього довго гортати сторінку. Показуються лише тоді, коли таблиця ширша за екран. */
  function tableNav(wrap) {
    const smooth = () => (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
    const start = el("button", { type: "button", class: "jr-btn is-quiet", id: "jr-scroll-start", text: "« На початок", onclick: () => wrap.scrollTo({ left: 0, behavior: smooth() }) });
    const end = el("button", { type: "button", class: "jr-btn is-quiet", id: "jr-scroll-end", text: "На кінець »", onclick: () => wrap.scrollTo({ left: wrap.scrollWidth, behavior: smooth() }) });
    const node = el("div", { class: "jr-table-nav", id: "jr-table-nav", role: "group", "aria-label": "Прокрутка таблиці вбік", hidden: true },
      start, el("span", { class: "jr-dim jr-table-nav-hint", text: "Таблиця ширша за екран" }), end);
    const update = () => {
      const max = wrap.scrollWidth - wrap.clientWidth;
      node.hidden = max <= 2;
      start.disabled = wrap.scrollLeft <= 1;
      end.disabled = wrap.scrollLeft >= max - 1;
    };
    wrap.addEventListener("scroll", update, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(update).observe(wrap); else window.addEventListener("resize", update);
    requestAnimationFrame(update);
    return node;
  }

  // ---------------------------------------------------------------- форма запису
  E.edit = async function (id) {
    const j = JR.currentJournal();
    let entry = null;
    if (id) {
      entry = loaded.find((e) => e.id === id);
      try { entry = (await JR.api.get(`/entries/${id}`)).entry; } catch (e) { JR.toast(e.message, "error"); return; }
    }
    const data = entry ? entry.data : { opened_at: fmt.nowInput() };
    const inputs = [];
    const fieldNodes = visibleFields().filter((f) => f.type !== "media").map((f) => {
      const inp = JR.fields.input(f, data[f.key], { market: j.market });
      inputs.push([f, inp]);
      return inp.node;
    });
    const hints = { r: el("small", { class: "jr-rhint", "aria-live": "polite" }), rr: el("small", { class: "jr-rhint", "aria-live": "polite" }) };
    const updateAuto = () => {
      const cur = Object.fromEntries(inputs.map(([f, i]) => [f.key, f.type === "text" || f.type === "number" || f.type === "select" ? i.get() : null]));
      for (const [key, calc, fmtv] of [["r", JR.fields.calcR, (v) => `${fmt.signed(v)} R`], ["rr", JR.fields.calcRR, (v) => `1:${fmt.num(v, 2)}`]]) {
        const field = inputs.find(([f]) => f.key === key);
        if (!field) continue;
        const auto = cur[key] == null ? calc(cur) : null;
        hints[key].textContent = auto != null ? `Порахується автоматично: ${fmtv(auto)}` : "";
        if (!hints[key].isConnected) field[1].node.append(hints[key]);
      }
    };
    for (const [f, i] of inputs) if (i.input && ["entry", "stop", "take", "exit", "r", "rr", "direction"].includes(f.key)) { i.input.addEventListener("input", updateAuto); i.input.addEventListener("change", updateAuto); }

    // сетапи, які вже траплялись у журналі, пропонуються при введенні
    let setups = [];
    try { setups = (await JR.api.get(`/journals/${j.id}/setups`)).setups; } catch (e) { /* підказки не критичні */ }
    const setupList = el("datalist", { id: "jr-setups" }, setups.map((x) => el("option", { value: x.name })));

    // файли
    const pending = [];                                              // { file, field, url, node }
    const mediaBoxes = mediaFields().map((f, i) => mediaSection(f, entry, pending, i === 0));

    const err = el("div", { class: "jr-error", role: "alert", hidden: true });
    const save = el("button", { type: "submit", class: "jr-btn is-primary", text: "Зберегти" });
    const del = entry ? el("button", { type: "button", class: "jr-btn is-danger-quiet", text: "Видалити запис", onclick: async () => {
      const ok = await JR.confirm({ title: "Видалити запис?", text: "Запис і всі його файли буде видалено без можливості відновлення.", ok: "Видалити", danger: true });
      if (!ok) return;
      try { await JR.api.del(`/entries/${entry.id}`); forceClose(); JR.toast("Запис видалено"); JR.refreshCounts(); load(true); } catch (e) { JR.showError(err, e); }
    } }) : null;
    const form = el("form", { class: "jr-entry-form", novalidate: "novalidate", "aria-label": entry ? "Редагування запису" : "Новий запис" },
      el("div", { class: "jr-dlg-head" },
        el("h2", { id: "jr-dlg-title", text: entry ? "Запис" : "Новий запис" }),
        el("button", { type: "button", class: "jr-x", "aria-label": "Закрити", text: "×", onclick: () => close() })),
      el("div", { class: "jr-grid" }, fieldNodes),
      ...mediaBoxes, err,
      el("div", { class: "jr-actions" }, del, el("span", { class: "jr-spacer" }), el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => close() }), save));
    let closeFn = () => {};
    const close = () => closeFn();
    updateAuto();

    const readPayload = () => { const out = {}; for (const [f, i] of inputs) { const v = i.get(); if (v != null) out[f.key] = v; } return out; };
    const snapshot = JSON.stringify(readPayload());
    const dirty = () => JSON.stringify(readPayload()) !== snapshot || pending.length > 0;
    let saving = false;

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (save.disabled) return;
      err.hidden = true;
      const payload = readPayload();
      if (!payload.opened_at) { JR.showError(err, new Error("Вкажи дату й час входу.")); const x = $("#jr-f-opened_at"); if (x) x.focus(); return; }
      save.disabled = true; save.textContent = "Зберігаю…"; saving = true;
      let saved;
      try {
        saved = (entry ? await JR.api.put(`/entries/${entry.id}`, { data: payload }) : await JR.api.post(`/journals/${j.id}/entries`, { data: payload })).entry;
      } catch (e) {
        save.disabled = false; save.textContent = "Зберегти"; saving = false;
        JR.showError(err, e);
        if (e.field) { const x = $("#jr-f-" + e.field); if (x) x.focus(); }
        return;
      }
      const failed = [];
      for (const p of pending.slice()) {
        p.setStatus("Завантажую…");
        try {
          await JR.api.upload(`/entries/${saved.id}/media?field=${encodeURIComponent(p.field)}&name=${encodeURIComponent(p.file.name)}`, p.file);
          pending.splice(pending.indexOf(p), 1);
          p.setStatus("Готово");
        } catch (e) { failed.push(`${p.file.name}: ${e.message}`); p.setStatus("Помилка", true); }
      }
      if (failed.length) {
        // запис збережено, але частина файлів не пройшла: лишаємо форму відкритою в режимі редагування
        entry = saved; save.disabled = false; save.textContent = "Зберегти"; saving = false;
        JR.showError(err, new Error("Запис збережено, але не все завантажилось. " + failed.join(" ")));
        load(true); JR.refreshCounts();
        return;
      }
      saving = false; forceClose(); JR.toast("Збережено"); JR.refreshCounts(); load(true);
    });
    let doneFn = () => {};
    const forceClose = () => { pending.forEach((p) => URL.revokeObjectURL(p.url)); doneFn(null); };
    // Закриття (×, «Скасувати», Esc) не губить незбережене мовчки
    const askClose = async () => {
      if (saving) return;
      if (dirty()) {
        const ok = await JR.confirm({ title: "Закрити без збереження?", text: "У формі є незбережені зміни. Вони зникнуть.", ok: "Закрити без збереження", danger: true });
        if (!ok) return;
      }
      forceClose();
    };
    closeFn = askClose;
    await JR.modal((done) => { doneFn = done; form.append(setupList); return form; }, { cls: "is-wide", onEscape: askClose });
  };

  // ---------------------------------------------------------------- файли в формі
  function mediaSection(field, entry, pending, first) {
    const existing = entry ? entry.media.filter((m) => m.field === field.key) : [];
    const grid = el("div", { class: "jr-thumbs" });
    const limits = state.meta.limits;
    const err = el("p", { class: "jr-note jr-warn", hidden: true });
    let seq = 0;
    // Усе, що можна гортати в перегляді: збережені файли поля і ті, що додані до запису, але ще не збережені
    const viewItems = () => [
      ...(entry ? entry.media.filter((x) => x.field === field.key) : []),
      ...pending.filter((p) => p.field === field.key).map((p) => ({ id: p.vid, name: p.file.name, mime: p.type, url: p.url, size: p.file.size, note: "ще не збережено" }))];
    const paintThumb = (m) => {
      const node = thumb(m, viewItems, {
        onDelete: async () => {
          const ok = await JR.confirm({ title: "Видалити файл?", text: m.name, ok: "Видалити", danger: true });
          if (!ok) return;
          try { await JR.api.del(`/media/${m.id}`); node.remove(); if (entry) entry.media = entry.media.filter((x) => x.id !== m.id); JR.refreshCounts(); } catch (e) { JR.toast(e.message, "error"); }
        } });
      grid.append(node);
    };
    existing.forEach(paintThumb);
    const addFiles = (files) => {
      err.hidden = true;
      const bad = [];
      for (const file of files) {
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        const type = file.type || ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" }[ext] || "");
        const isVideo = type.startsWith("video/"), isImage = type.startsWith("image/") && type !== "image/svg+xml";
        if (!isVideo && !isImage) { bad.push(`${file.name}: підтримуються фото й відео`); continue; }
        const lim = (isVideo ? limits.video_mb : limits.image_mb) * 1048576;
        if (file.size > lim) { bad.push(`${file.name}: більше ${isVideo ? limits.video_mb : limits.image_mb} МБ`); continue; }
        if (existing.length + pending.length >= limits.media_per_entry) { bad.push(`не більше ${limits.media_per_entry} файлів до запису`); break; }
        const url = URL.createObjectURL(file);
        const status = el("span", { class: "jr-thumb-status", text: "Буде завантажено" });
        const vid = "pending-" + (++seq);
        const view = el("button", { type: "button", class: "jr-thumb-open", "aria-label": `Відкрити ${file.name}`, onclick: () => E.lightbox(viewItems(), vid) },
          isVideo ? el("video", { src: url, muted: true, preload: "metadata", "aria-hidden": "true" }) : el("img", { src: url, alt: file.name }),
          isVideo ? el("span", { class: "jr-play", "aria-hidden": "true", text: "▶" }) : null);
        const node = el("figure", { class: "jr-thumb is-pending" }, view,
          el("figcaption", null, el("span", { class: "jr-thumb-name", text: file.name }), status),
          el("button", { type: "button", class: "jr-thumb-x", "aria-label": `Прибрати ${file.name}`, text: "×", onclick: () => { pending.splice(pending.indexOf(item), 1); URL.revokeObjectURL(url); node.remove(); } }));
        const item = { file, field: field.key, url, node, vid, type, setStatus: (t, bad2) => { status.textContent = t; status.classList.toggle("is-bad", !!bad2); } };
        pending.push(item); grid.append(node);
      }
      if (bad.length) { err.textContent = bad.join("; ") + "."; err.hidden = false; }
    };
    const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime", multiple: true, class: "jr-file", id: "jr-file-" + field.key });
    input.addEventListener("change", () => { addFiles([...input.files]); input.value = ""; });
    const drop = el("label", { class: "jr-drop", for: input.id },
      el("strong", { text: "Додати фото або відео" }),
      el("span", { text: `Перетягни сюди, натисни або встав зі скріншота (Ctrl+V чи кнопка «Вставити»). Фото до ${limits.image_mb} МБ, відео до ${limits.video_mb} МБ.` }));
    ["dragenter", "dragover"].forEach((n) => drop.addEventListener(n, (ev) => { ev.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((n) => drop.addEventListener(n, (ev) => { ev.preventDefault(); drop.classList.remove("is-over"); }));
    drop.addEventListener("drop", (ev) => addFiles([...ev.dataTransfer.files]));
    // Кнопка «Вставити»: бере зображення з буфера обміну (скріншот, скопійоване фото) без Ctrl+V
    const warn = (t) => { err.textContent = t; err.hidden = false; };
    const paste = el("button", { type: "button", class: "jr-btn jr-paste", id: "jr-paste-" + field.key, title: "Вставити фото чи скріншот з буфера обміну",
      onclick: async () => {
        err.hidden = true;
        if (!navigator.clipboard || !navigator.clipboard.read) { warn("Цей браузер не дозволяє читати буфер обміну кнопкою. Натисни Ctrl+V (на Mac ⌘V), коли відкрито цю форму."); return; }
        try {
          const found = [];
          for (const it of await navigator.clipboard.read()) {
            const type = it.types.find((t) => t.startsWith("image/") && t !== "image/svg+xml");
            if (!type) continue;
            const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[type];
            if (!ext) continue;
            const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
            const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
            found.push(new File([await it.getType(type)], `pasted-${stamp}${found.length ? "-" + (found.length + 1) : ""}.${ext}`, { type }));
          }
          if (!found.length) { warn("У буфері обміну немає зображення. Скопіюй скріншот чи фото і натисни «Вставити» ще раз."); return; }
          addFiles(found);
        } catch (e) {
          warn(e && e.name === "NotAllowedError" ? "Браузер не дав доступ до буфера обміну. Дозволь його в налаштуваннях сайту або натисни Ctrl+V." : "Не вдалося вставити з буфера обміну. Спробуй Ctrl+V.");
        }
      } }, el("span", { "aria-hidden": "true", text: "📋" }), el("span", { text: "Вставити" }));
    const section = el("section", { class: "jr-media", "aria-label": field.label }, el("h3", { text: field.label }), el("div", { class: "jr-media-row" }, drop, paste), input, err, grid);
    // Вставка з буфера: скріншот або скопійований у провіднику файл. Працює, навіть якщо курсор у текстовому полі,
    // бо файл у таке поле вставити неможливо. Звичайний текст вставляється як завжди. Вставку приймає лише перше файлове поле.
    if (first) {
      const dlgPaste = (ev) => {
        if (!section.isConnected) { document.removeEventListener("paste", dlgPaste); return; }
        if (document.querySelector(".jr-dialog.is-lightbox")) return;
        const files = pastedFiles(ev.clipboardData);
        if (!files.length) return;
        ev.preventDefault();
        addFiles(files);
      };
      document.addEventListener("paste", dlgPaste);
    }
    return section;
  }

  function pastedFiles(cd) {
    if (!cd) return [];
    const out = [...(cd.files || [])];
    if (!out.length) for (const it of cd.items || []) if (it.kind === "file") { const f = it.getAsFile(); if (f) out.push(f); }
    return out;
  }

  function thumb(m, siblings, hooks) {
    const url = m.url;
    const isVideo = m.mime.startsWith("video/");
    const open = el("button", { type: "button", class: "jr-thumb-open", "aria-label": `Відкрити ${m.name}`, onclick: () => E.lightbox(typeof siblings === "function" ? siblings() : siblings, m.id) },
      isVideo ? el("video", { src: url + "#t=0.1", preload: "metadata", muted: true, "aria-hidden": "true" }) : el("img", { src: url, alt: m.name, loading: "lazy" }),
      isVideo ? el("span", { class: "jr-play", "aria-hidden": "true", text: "▶" }) : null);
    return el("figure", { class: "jr-thumb" }, open,
      el("figcaption", null, el("span", { class: "jr-thumb-name", text: m.name }), el("span", { class: "jr-thumb-status", text: fmt.bytes(m.size) })),
      hooks && hooks.onDelete ? el("button", { type: "button", class: "jr-thumb-x", "aria-label": `Видалити ${m.name}`, text: "×", onclick: hooks.onDelete }) : null);
  }

  // ---------------------------------------------------------------- перегляд на весь екран
  // Фото розкривається на все вікно: коліщатко або кнопки +/− змінюють масштаб, перетягування пересуває, подвійний клік
  // наближає, «1:1» показує справжні пікселі скріншота. Працює і для ще незбережених файлів (адреса blob:).
  E.lightbox = function (items, startId) {
    let idx = Math.max(0, items.findIndex((m) => m.id === startId));
    return JR.modal((done, dlg) => {
      let s = 1, tx = 0, ty = 0, node = null, pinch = null, moved = 0, downTarget = null, startX = 0, startY = 0;
      const ptrs = new Map();
      const stage = el("div", { class: "jr-vw-stage", tabindex: "-1", "data-autofocus": "1" });
      const title = el("span", { class: "jr-vw-name" });
      const note = el("span", { class: "jr-vw-note" });
      const count = el("span", { class: "jr-vw-count" });
      const level = el("span", { class: "jr-vw-level", "aria-live": "polite" });
      const isImg = () => !!node && node.tagName === "IMG";
      const fitK = () => (node && node.naturalWidth ? node.clientWidth / node.naturalWidth : 1);
      const maxS = () => Math.min(24, Math.max(6, 4 / (fitK() || 1)));
      const clamp = () => {
        const mx = Math.max(0, (node.clientWidth * s - stage.clientWidth) / 2), my = Math.max(0, (node.clientHeight * s - stage.clientHeight) / 2);
        tx = Math.min(mx, Math.max(-mx, tx)); ty = Math.min(my, Math.max(-my, ty));
      };
      const apply = () => {
        if (!isImg()) { level.textContent = ""; return; }
        if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
        clamp();
        node.style.transform = s === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${s})`;
        stage.classList.toggle("is-zoomed", s > 1);
        level.textContent = node.naturalWidth ? `${Math.round(fitK() * s * 100)}%` : "";
      };
      // Масштабування навколо точки (px, py — від центру області перегляду)
      const zoomTo = (ns, px = 0, py = 0) => {
        if (!isImg()) return;
        ns = Math.min(maxS(), Math.max(1, ns));
        const k = ns / s;
        tx = px - (px - tx) * k; ty = py - (py - ty) * k; s = ns;
        apply();
      };
      const rel = (cx, cy) => { const r = stage.getBoundingClientRect(); return [cx - r.left - r.width / 2, cy - r.top - r.height / 2]; };
      const actual = () => { const k = fitK(); return k > 0 && k < 1 ? 1 / k : 1; };
      const toggleActual = () => { if (Math.abs(s - actual()) < 0.02 || actual() === 1) zoomTo(1); else zoomTo(actual()); };

      const zoomBtns = [];
      const tool = (cls, text, label, fn) => {
        const b = el("button", { type: "button", class: "jr-vw-btn " + cls, title: label, "aria-label": label, text, onclick: fn });
        zoomBtns.push(b);
        return b;
      };
      const open = el("a", { class: "jr-vw-btn", title: "Відкрити в новій вкладці", "aria-label": "Відкрити в новій вкладці", target: "_blank", rel: "noopener", text: "↗" });
      const fs = dlg.requestFullscreen ? el("button", { type: "button", class: "jr-vw-btn", id: "jr-vw-fs", title: "Повноекранний режим (F)", "aria-label": "Повноекранний режим", text: "⛶",
        onclick: () => { try { (document.fullscreenElement ? document.exitFullscreen() : dlg.requestFullscreen()).catch(() => {}); } catch (e) { /* не підтримується */ } } }) : null;
      const prev = el("button", { type: "button", class: "jr-vw-nav is-prev", id: "jr-vw-prev", "aria-label": "Попереднє", text: "‹", onclick: () => step(-1) });
      const next = el("button", { type: "button", class: "jr-vw-nav is-next", id: "jr-vw-next", "aria-label": "Наступне", text: "›", onclick: () => step(1) });

      const show = () => {
        const m = items[idx], isV = m.mime.startsWith("video/");
        s = 1; tx = 0; ty = 0; ptrs.clear(); pinch = null;
        node = isV ? el("video", { src: m.url, controls: true, autoplay: true, playsinline: true }) : el("img", { src: m.url, alt: m.name, draggable: false });
        if (!isV) node.addEventListener("load", apply);
        stage.classList.remove("is-zoomed", "is-drag");
        stage.classList.toggle("is-video", isV);
        stage.replaceChildren(node);
        zoomBtns.forEach((b) => { b.disabled = isV; });
        title.textContent = m.name; note.textContent = m.note || ""; note.hidden = !m.note;
        count.textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : "";
        open.href = m.url;
        apply();
      };
      const step = (d) => { if (items.length > 1) { idx = (idx + d + items.length) % items.length; show(); } };

      // Масштаб: коліщатко (і щипок на тачпаді)
      stage.addEventListener("wheel", (ev) => {
        if (!isImg()) return;
        ev.preventDefault();
        const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
        const [px, py] = rel(ev.clientX, ev.clientY);
        zoomTo(s * Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0015)), px, py);
      }, { passive: false });
      stage.addEventListener("dblclick", (ev) => {
        if (!isImg()) return;
        const [px, py] = rel(ev.clientX, ev.clientY);
        if (s > 1.01) zoomTo(1); else zoomTo(Math.max(2.5, actual()), px, py);
      });
      // Пересування мишею/пальцем і щипок двома пальцями; свайп вбік гортає, клік по порожньому полю закриває
      stage.addEventListener("pointerdown", (ev) => {
        if (!isImg() || ev.button > 0) return;
        downTarget = ev.target;
        try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* ігноруємо */ }
        ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (ptrs.size === 1) { moved = 0; startX = ev.clientX; startY = ev.clientY; }
        if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s }; }
        if (s > 1) stage.classList.add("is-drag");
      });
      stage.addEventListener("pointermove", (ev) => {
        const p = ptrs.get(ev.pointerId);
        if (!p) return;
        const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
        p.x = ev.clientX; p.y = ev.clientY; moved += Math.abs(dx) + Math.abs(dy);
        if (ptrs.size === 2 && pinch) {
          const [a, b] = [...ptrs.values()];
          const [px, py] = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
          zoomTo(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, px, py);
        } else if (ptrs.size === 1 && s > 1) { tx += dx; ty += dy; apply(); }
      });
      const release = (ev) => {
        if (!ptrs.has(ev.pointerId)) return;
        ptrs.delete(ev.pointerId);
        if (ptrs.size < 2) pinch = null;
        if (ptrs.size) return;
        stage.classList.remove("is-drag");
        if (ev.type !== "pointerup") return;
        if (moved < 6) { if (downTarget === stage && s === 1) done(null); }
        else if (ev.pointerType !== "mouse" && s === 1 && Math.abs(ev.clientX - startX) > 60 && Math.abs(ev.clientY - startY) < 60) step(ev.clientX < startX ? 1 : -1);
      };
      stage.addEventListener("pointerup", release);
      stage.addEventListener("pointercancel", release);

      dlg.addEventListener("keydown", (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.key === "ArrowLeft") { ev.preventDefault(); step(-1); }
        else if (ev.key === "ArrowRight") { ev.preventDefault(); step(1); }
        else if (ev.key === "+" || ev.key === "=") zoomTo(s * 1.5);
        else if (ev.key === "-" || ev.key === "_") zoomTo(s / 1.5);
        else if (ev.key === "0") zoomTo(1);
        else if (ev.key === "1") toggleActual();
        else if (ev.code === "KeyF" && fs) fs.click();
      });
      const onResize = () => { if (!dlg.isConnected) { window.removeEventListener("resize", onResize); return; } apply(); };
      window.addEventListener("resize", onResize);

      const bar = el("div", { class: "jr-vw-bar" },
        el("h2", { id: "jr-dlg-title", class: "jr-vw-h" }, title, note, count),
        el("div", { class: "jr-vw-tools" },
          tool("", "−", "Зменшити (−)", () => zoomTo(s / 1.5)), level, tool("", "+", "Збільшити (+)", () => zoomTo(s * 1.5)),
          tool("is-text", "По екрану", "Вмістити в екран (0)", () => zoomTo(1)),
          tool("is-text", "1:1", "Справжній розмір, один піксель до одного (1)", toggleActual),
          fs, open),
        el("button", { type: "button", class: "jr-vw-btn is-close", id: "jr-vw-close", title: "Закрити (Esc)", "aria-label": "Закрити", text: "×", onclick: () => done(null) }));
      show();
      return el("div", { class: "jr-vw" }, bar, el("div", { class: "jr-vw-main" }, stage, items.length > 1 ? prev : null, items.length > 1 ? next : null));
    }, { cls: "is-lightbox" });
  };

  E.resetFilters = () => { filters = { q: "", outcome: "", direction: "", from: "", to: "" }; loaded = []; total = 0; };
})();
