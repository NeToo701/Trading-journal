/* Журнал: головний скрипт сторінки. Список журналів (папок) окремо для крипти й форексу, вкладки «Записи» й «Статистика»,
   керування журналом, встановлення як застосунок. Увесь текст вставляється через textContent. */
(function () {
  "use strict";
  const JR = window.JR;
  const { el, state } = JR;
  const $ = (s, r) => (r || document).querySelector(s);
  const LAST_KEY = "journal.last.v1", TAB_KEY = "journal.tab.v1", SIDE_KEY = "journal.side.collapsed.v1";
  const TABS = [["entries", "Записи"], ["review", "Розбір місяця"], ["stats", "Статистика"]];
  let tab = "entries";
  let starting = false;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* без збереження теж працює */ } };

  // ---------------------------------------------------------------- тема
  function initTheme() {
    const radios = document.querySelectorAll('input[name="theme"]');
    const sync = () => radios.forEach((r) => { r.checked = r.value === window.AppTheme.mode(); });
    sync();
    radios.forEach((r) => r.addEventListener("change", () => { if (r.checked) window.AppTheme.set(r.value); }));
    document.addEventListener("themechange", sync);
  }

  // ---------------------------------------------------------------- застосунок (PWA)
  function initInstall() {
    const btn = $("#jr-install");
    let deferred = null;
    window.addEventListener("beforeinstallprompt", (ev) => { ev.preventDefault(); deferred = ev; btn.hidden = false; });
    btn.addEventListener("click", async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (e) { /* ок */ }
      deferred = null; btn.hidden = true;
    });
    window.addEventListener("appinstalled", () => { btn.hidden = true; JR.toast("Журнал встановлено. Знайди його серед застосунків."); });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => { /* без сервіс-воркера теж працює */ });
    }
  }
  const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // ---------------------------------------------------------------- екрани
  const main = () => $("#jr-main");
  const side = () => $("#jr-side");

  function gate(title, text) {
    side().hidden = true;
    $("#jr-shell").classList.add("is-solo");
    main().replaceChildren(el("section", { class: "jr-gate" },
      el("h1", { text: title }), el("p", { text }),
      el("div", { class: "jr-actions" }, el("button", { type: "button", class: "jr-btn is-primary", text: "Спробувати ще раз", onclick: () => location.reload() }))));
  }

  async function start() {
    if (starting) return;
    starting = true;
    try { await boot(); } finally { starting = false; }
  }

  async function boot() {
    try {
      await window.JL.db.open();
      try { await window.JL.migrateJournals(); } catch (e) { /* міграція не критична: журнал працює й без неї */ }
      await Promise.all([JR.loadMeta(), JR.loadJournals()]);
    } catch (e) {
      gate("Не вдалося відкрити сховище", e.message || "Браузер не дозволяє зберігати дані. Вимкни приватний режим або дозволь сховище для цього сайту.");
      return;
    }
    $("#jr-shell").classList.remove("is-solo");
    const wanted = Number(lsGet(LAST_KEY));
    const first = state.journals.find((j) => j.id === wanted) || state.journals[0] || null;
    tab = ["stats", "review"].includes(lsGet(TAB_KEY)) ? lsGet(TAB_KEY) : "entries";
    side().hidden = false;
    await loadBackupAge();
    if (first) await select(first.id); else { renderSide(); renderEmpty(); }
  }

  // ---------------------------------------------------------------- нагадування про резервну копію
  let backupAge = null;      // мс від останньої копії; null = копій не було
  async function loadBackupAge() {
    const ts = await window.JL.db.meta.get("lastBackup").catch(() => null);
    backupAge = ts ? Date.now() - ts : null;
  }
  function backupHint() {
    const total = state.journals.reduce((a, j) => a + (j.entries || 0), 0);
    const cloudOn = window.JL.cloud && window.JL.cloud.user && window.JL.cloud.user();
    if (!total || cloudOn || (backupAge != null && backupAge < 30 * 86400000)) return null;
    return el("div", { class: "jr-note jr-backup-hint", id: "jr-backup-hint" },
      el("p", { text: backupAge == null ? "Дані зберігаються лише в цьому браузері. Збережи резервну копію, щоб не втратити їх." : "Остання резервна копія була понад місяць тому." }),
      el("button", { type: "button", class: "jr-btn", id: "jr-backup-now", text: "Зберегти копію", onclick: () => JR.account.open() }));
  }

  // ---------------------------------------------------------------- бічна панель
  /* Згортання панелі журналів на комп'ютері. Вибір зберігається в браузері (localStorage) і діє після перезавантаження сторінки чи застосунку.
     На вузьких екранах панель і так ховається за кнопкою «Журнали», тому там згортання не діє (див. media-запит у journal.css). */
  const sideCollapsed = () => lsGet(SIDE_KEY) === "1";
  function applySideCollapsed() {
    const on = sideCollapsed();
    $("#jr-shell").classList.toggle("is-side-collapsed", on);
    const b = $("#jr-side-collapse");
    if (b) {
      b.setAttribute("aria-expanded", String(!on));
      b.setAttribute("aria-label", on ? "Розгорнути панель журналів" : "Згорнути панель журналів");
      b.title = on ? "Розгорнути панель журналів" : "Згорнути панель журналів";
      b.textContent = on ? "»" : "«";
    }
  }
  function toggleSideCollapsed() { lsSet(SIDE_KEY, sideCollapsed() ? "0" : "1"); applySideCollapsed(); }

  function toggleSide() {
    const open = document.body.classList.toggle("jr-side-open");
    const b = $("#jr-side-toggle"); if (b) b.setAttribute("aria-expanded", String(open));
  }

  function renderSide() {
    const m = state.meta;
    const blocks = m.markets.map((mk) => {
      const items = state.journals.filter((j) => j.market === mk.id);
      return el("section", { class: "jr-side-block", "aria-labelledby": "jr-m-" + mk.id },
        el("h2", { id: "jr-m-" + mk.id, text: mk.label }),
        items.length ? el("ul", { class: "jr-jlist" }, items.map((j) => el("li", null,
          el("button", { type: "button", class: "jr-jbtn", "data-id": String(j.id), "aria-current": j.id === state.current ? "true" : null, onclick: () => select(j.id) },
            el("span", { class: "jr-jname", text: j.name }), el("span", { class: "jr-jcount", text: String(j.entries || 0), title: "Записів", "aria-label": `${j.entries || 0} записів` })))))
          : el("p", { class: "jr-dim jr-side-empty", text: "Журналів ще немає" }),
        el("button", { type: "button", class: "jr-btn is-quiet jr-add", "data-market": mk.id, text: "+ Новий журнал", onclick: () => createJournal(mk.id) }));
    });
    const lim = m.limits, used = lim.used_bytes || 0;
    const pct = Math.min(100, Math.round((used / (lim.quota_mb * 1048576)) * 100));
    const meter = el("div", { class: "jr-quota" },
      el("span", { class: "jr-dim", text: `Файли: ${JR.fmt.bytes(used)} з ${lim.quota_mb} МБ` }),
      el("progress", { max: "100", value: String(pct), "aria-label": "Зайняте місце для файлів" }));
    const syncLine = el("p", { class: "jr-dim jr-sync-line", id: "jr-sync-line", role: "status", text: JR.account.statusText() });
    const top = el("div", { class: "jr-side-top" },
      el("span", { class: "jr-side-title", text: "Журнали" }),
      el("button", { type: "button", class: "jr-side-collapse", id: "jr-side-collapse", "aria-controls": "jr-side", onclick: toggleSideCollapsed }));
    side().replaceChildren(top, ...blocks, meter, backupHint(), syncLine,
      ...(isIOS() && !isStandalone() ? [el("p", { class: "jr-note jr-ios-hint", text: "Щоб встановити на iPhone: натисни «Поділитися» і «На початковий екран»." })] : []));
    applySideCollapsed();
  }

  function renderEmpty() {
    $("#jr-shell").classList.remove("is-solo");
    document.body.classList.add("jr-side-open");
    main().replaceChildren(el("section", { class: "jr-gate" },
      el("h1", { text: "Створи свій перший журнал" }),
      el("p", { text: "Журнал це папка зі своїми записами й статистикою, наприклад «Журнал 2026» або «Мій журнал». Окремо для крипти й форексу; поля можна налаштувати під себе." }),
      el("div", { class: "jr-actions" }, state.meta.markets.map((mk, i) =>
        el("button", { type: "button", class: "jr-btn " + (i === 0 ? "is-primary" : ""), text: `Журнал для: ${mk.label.toLowerCase()}`, onclick: () => createJournal(mk.id) })))));
  }

  async function createJournal(market) {
    const label = JR.marketLabel(market);
    const name = await JR.prompt({ title: `Новий журнал: ${label.toLowerCase()}`, label: "Назва журналу", value: `Журнал ${new Date().getFullYear()}`,
      ok: "Створити", hint: "Наприклад «Журнал 2026» або «Мій журнал». Назву можна змінити пізніше." });
    if (!name) return;
    try {
      const { journal } = await JR.api.post("/journals", { name, market });
      await JR.loadJournals();
      JR.toast("Журнал створено");
      await select(journal.id);
    } catch (e) { JR.toast(e.message, "error"); }
  }

  // ---------------------------------------------------------------- вибраний журнал
  async function select(id) {
    state.current = id; lsSet(LAST_KEY, String(id));
    document.body.classList.remove("jr-side-open");
    JR.entries.resetFilters(); JR.stats.reset(); JR.review.reset();
    const j = JR.currentJournal();
    if (!j) { renderSide(); renderEmpty(); return; }
    try { state.fields = (await JR.api.get(`/journals/${id}/fields`)).fields; }
    catch (e) { JR.toast(e.message, "error"); return; }
    renderSide(); renderJournal();
  }

  function renderJournal() {
    const j = JR.currentJournal();
    $("#jr-shell").classList.remove("is-solo");
    const tabs = el("div", { class: "jr-tabs", role: "tablist", "aria-label": "Розділи журналу" },
      TABS.map(([id, t], i) =>
        el("button", { type: "button", role: "tab", id: "jr-tab-" + id, class: "jr-tab", "aria-selected": String(tab === id), "aria-controls": "jr-panel", tabindex: tab === id ? "0" : "-1", text: t, onclick: () => setTab(id),
          onkeydown: (ev) => { if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") { ev.preventDefault(); setTab(TABS[(i + (ev.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0], true); } } })));
    main().replaceChildren(
      el("header", { class: "jr-head" },
        el("div", { class: "jr-title" },
          el("h1", { id: "jr-h1", text: j.name }),
          el("p", { class: "jr-dim" }, el("span", { class: "jr-badge", text: JR.marketLabel(j.market) }), ` валюта ${j.currency}, записів ${j.entries || 0}`)),
        el("div", { class: "jr-head-actions" },
          el("button", { type: "button", class: "jr-btn jr-only-narrow", id: "jr-side-toggle", "aria-expanded": String(document.body.classList.contains("jr-side-open")), "aria-controls": "jr-side", text: "Журнали", onclick: toggleSide }),
          el("button", { type: "button", class: "jr-btn", id: "jr-fields", text: "Поля", title: "Додати, сховати або змінити поля", onclick: editFields }),
          el("button", { type: "button", class: "jr-btn", id: "jr-rename", text: "Назва й валюта", onclick: editJournal }),
          el("button", { type: "button", class: "jr-btn", id: "jr-import", text: "Імпорт", title: "Перенести угоди з Notion чи іншої таблиці", onclick: () => JR.importer.open() }),
          el("button", { type: "button", class: "jr-btn", id: "jr-export", text: "Експорт CSV", title: "Усі записи в таблицю для Excel", onclick: exportCsv }),
          el("button", { type: "button", class: "jr-btn is-danger-quiet", id: "jr-delete", text: "Видалити журнал", onclick: deleteJournal }))),
      tabs,
      el("div", { class: "jr-panel", id: "jr-panel", role: "tabpanel", "aria-labelledby": "jr-tab-" + tab }));
    paintTab();
  }

  function setTab(id, focus) {
    tab = id; lsSet(TAB_KEY, id);
    document.querySelectorAll(".jr-tab").forEach((t) => { const on = t.id === "jr-tab-" + id; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
    $("#jr-panel").setAttribute("aria-labelledby", "jr-tab-" + id);
    paintTab();
  }
  function paintTab() {
    const p = $("#jr-panel");
    if (!p) { if (JR.currentJournal()) renderJournal(); return; }      // екран ще не зібрано (наприклад, показано «Створи журнал»)
    if (tab === "stats") JR.stats.render(p); else if (tab === "review") JR.review.render(p); else JR.entries.render(p);
  }

  async function exportCsv() {
    const j = JR.currentJournal();
    try { const { name, blob } = await window.JL.exportCsv(j.id); JR.account.download(blob, name); } catch (e) { JR.toast(e.message, "error"); }
  }

  async function editFields() {
    await JR.schema.edit();
    paintTab();
  }

  async function editJournal() {
    const j = JR.currentJournal();
    const res = await JR.modal((done) => {
      const name = el("input", { type: "text", id: "jr-ed-name", value: j.name, maxlength: "60", "data-autofocus": "1" });
      const cur = el("input", { type: "text", id: "jr-ed-cur", value: j.currency, maxlength: "8" });
      const err = el("div", { class: "jr-error", role: "alert", hidden: true });
      const form = el("form", { class: "jr-dlg-body", onsubmit: async (ev) => {
        ev.preventDefault();
        try { await JR.api.patch(`/journals/${j.id}`, { name: name.value.trim(), currency: cur.value.trim() }); done(true); } catch (e) { JR.showError(err, e); }
      } },
        el("h2", { id: "jr-dlg-title", text: "Назва й валюта" }),
        el("div", { class: "jr-field" }, el("label", { for: "jr-ed-name", text: "Назва журналу" }), name),
        el("div", { class: "jr-field" }, el("label", { for: "jr-ed-cur", text: "Валюта прибутку" }), cur, el("small", { text: "Підписується біля суми прибутку, наприклад USD або USDT." })),
        err,
        el("div", { class: "jr-actions" }, el("button", { type: "button", class: "jr-btn", text: "Скасувати", onclick: () => done(false) }), el("button", { type: "submit", class: "jr-btn is-primary", text: "Зберегти" })));
      return form;
    }, { cls: "is-small" });
    if (!res) return;
    await JR.loadJournals(); renderSide(); renderJournal(); JR.toast("Збережено");
  }

  async function deleteJournal() {
    const j = JR.currentJournal();
    const ok = await JR.confirm({ title: `Видалити журнал «${j.name}»?`, text: `Разом із ним буде видалено всі записи (${j.entries || 0}) та їхні файли. Це не можна скасувати. Перед видаленням можна зберегти записи через «Експорт CSV».`, ok: "Видалити журнал", danger: true });
    if (!ok) return;
    try {
      await JR.api.del(`/journals/${j.id}`);
      await Promise.all([JR.loadJournals(), JR.loadMeta()]);
      JR.toast("Журнал видалено");
      state.current = null;
      if (state.journals.length) await select(state.journals[0].id); else { renderSide(); renderEmpty(); }
    } catch (e) { JR.toast(e.message, "error"); }
  }

  /* Оновити лічильники записів і зайняте місце, не перемальовуючи вміст. */
  JR.refreshCounts = async function () {
    try {
      await Promise.all([JR.loadJournals(), JR.loadMeta()]);
      renderSide();
      const j = JR.currentJournal(), p = $(".jr-title .jr-dim");
      if (j && p) p.replaceChildren(el("span", { class: "jr-badge", text: JR.marketLabel(j.market) }), ` валюта ${j.currency}, записів ${j.entries || 0}`);
    } catch (e) { /* не критично */ }
  };

  // ---------------------------------------------------------------- запуск
  JR.bus.addEventListener("imported", async () => {
    JR.entries.resetFilters(); JR.stats.reset(); JR.review.reset();
    await JR.refreshCounts();
    if (state.current && !JR.currentJournal()) { await select(state.journals[0] ? state.journals[0].id : null); return; }
    paintTab();
  });

  // Зміни з іншого пристрою (прийшли з хмари): оновлюємо екран, але не під час редагування у вікні
  let remoteTimer = null;
  async function onRemote() {
    clearTimeout(remoteTimer);
    if (document.querySelector("dialog[open].jr-dialog")) { remoteTimer = setTimeout(onRemote, 2500); return; }
    try { await window.JL.migrateJournals(); } catch (e) { /* ок */ }
    await Promise.all([JR.loadMeta(), JR.loadJournals()]);
    if (!state.journals.length) { state.current = null; renderSide(); renderEmpty(); return; }
    if (!JR.currentJournal()) { await select(state.journals[0].id); return; }
    try { state.fields = (await JR.api.get(`/journals/${state.current}/fields`)).fields; } catch (e) { /* ок */ }
    renderSide(); renderJournal();
  }
  JR.bus.addEventListener("remote-data", onRemote);

  // Просимо браузер не стирати дані: після першої зміни (деякі браузери питають дозволу)
  let persistAsked = false;
  window.JL.onChange(() => { if (!persistAsked) { persistAsked = true; JR.account.persist(); } });
  JR.account.onHint = async () => { await loadBackupAge(); if (state.meta) renderSide(); };

  document.getElementById("acc-btn").addEventListener("click", () => JR.account.open());
  applySideCollapsed();                        // згорнута панель з'являється одразу згорнутою, без блимання
  initTheme();
  initInstall();
  start().then(async () => {
    JR.account.paintButton();
    JR.account.startSync();
    try { if (window.JL.cloud.configured()) await window.JL.cloud.init(); } catch (e) { JR.account.paintButton(); }
  });
})();
