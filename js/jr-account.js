/* «Дані й хмара»: вхід в акаунт для синхронізації між пристроями, резервні копії, налаштування Firebase, очищення пристрою.
   Журнал повністю працює й без акаунта: тут лише те, що додає хмару та безпеку даних. Увесь текст вставляється через textContent. */
(function () {
  "use strict";
  const JR = window.JR, JL = window.JL;
  const { el } = JR;
  const A = (JR.account = {});
  const LAST_BACKUP = "lastBackup";
  let dlg = null, body = null, mode = "login", busyMsg = "", notice = null;

  const cloud = () => JL.cloud;
  const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const dmy = (ts) => { const d = new Date(ts); return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`; };

  // ---------------------------------------------------------------- стан синхронізації для кнопки в шапці й бічної панелі
  A.statusText = function () {
    const c = cloud(), s = JL.sync.status();
    if (!c || !c.configured()) return "";
    if (!c.user()) return "Хмару не підключено";
    if (s.state === "syncing") return "Синхронізую…";
    if (s.state === "offline") return "Немає інтернету: зміни чекають";
    if (s.state === "error") return "Помилка синхронізації";
    if (s.pending) return `Чекає відправки: ${s.pending}`;
    return s.last ? `Синхронізовано о ${hhmm(s.last)}` : "Синхронізовано";
  };
  A.paintButton = function () {
    const btn = document.getElementById("acc-btn");
    if (!btn) return;
    const c = cloud(), u = c && c.user();
    btn.replaceChildren();
    btn.classList.toggle("is-in", !!u);
    if (u) {
      btn.append(el("span", { class: "acc-avatar", "aria-hidden": "true", text: (u.email || "?").charAt(0).toUpperCase() }), el("span", { class: "acc-name", text: u.email }));
      btn.title = A.statusText();
      btn.setAttribute("aria-label", `Дані й хмара: ${u.email}. ${A.statusText()}`);
    } else {
      btn.append(el("span", { class: "acc-name", text: "Дані й хмара" }));
      btn.title = "Резервні копії та синхронізація між пристроями"; btn.setAttribute("aria-label", "Дані й хмара");
    }
    const line = document.getElementById("jr-sync-line");
    if (line) line.textContent = A.statusText();
  };

  // ---------------------------------------------------------------- вікно
  function ensure() {
    if (dlg) return;
    dlg = document.getElementById("acc-dialog"); body = document.getElementById("acc-body");
    document.getElementById("acc-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); });
  }
  A.open = function () {
    ensure(); notice = null; busyMsg = "";
    if (!dlg.open) dlg.showModal();
    paint();
  };
  const repaintIfOpen = () => { if (dlg && dlg.open) paint(); };

  function field(id, label, attrs, hint) {
    return el("div", { class: "acc-field" }, el("label", { for: id, text: label }), el("input", { id, ...attrs }), hint ? el("small", { text: hint }) : null);
  }
  const errBox = () => el("div", { class: "acc-error", role: "alert", hidden: true });
  const showErr = (box, e) => { box.textContent = e && e.message ? e.message : String(e); box.hidden = false; };
  async function guarded(box, btn, fn) {
    box.hidden = true; btn.disabled = true;
    try { await fn(); } catch (e) { showErr(box, e); } finally { btn.disabled = false; }
  }

  function paint() {
    const c = cloud();
    const sections = [];
    if (notice) sections.push(el("p", { class: "acc-ok", role: "status", text: notice }));
    sections.push(cloudSection(c), backupSection(), deviceSection());
    body.replaceChildren(...sections);
    document.getElementById("acc-title").textContent = "Дані й хмара";
  }

  // ---- хмара
  function cloudSection(c) {
    if (!c.configured()) return configSection(true);
    const u = c.user();
    if (u) return signedIn(c, u);
    return signInForm(c);
  }

  function signInForm(c) {
    const email = field("acc-email", "Пошта", { type: "email", autocomplete: "email", required: "", maxlength: "120", "data-autofocus": "1" });
    const pass = field("acc-pass", mode === "signup" ? "Пароль (щонайменше 6 символів)" : "Пароль", { type: "password", autocomplete: mode === "signup" ? "new-password" : "current-password", required: "", maxlength: "200" });
    const err = errBox();
    const submit = el("button", { type: "submit", class: "acc-primary", text: mode === "signup" ? "Створити акаунт" : "Увійти" });
    const form = el("form", { class: "acc-form", novalidate: "", onsubmit: (ev) => {
      ev.preventDefault();
      const e = email.querySelector("input").value.trim(), p = pass.querySelector("input").value;
      if (!e || !p) { showErr(err, new Error("Введи пошту й пароль.")); return; }
      guarded(err, submit, async () => {
        if (mode === "signup") await c.signUp(e, p); else await c.signIn(e, p);
        notice = mode === "signup" ? "Акаунт створено. Дані з цього пристрою відправляються в хмару." : "Ти увійшов. Дані синхронізуються.";
        paint();
      });
    } },
      el("h3", { text: "Хмарна синхронізація" }),
      el("p", { class: "acc-note", text: "Без акаунта журнал працює й зберігається на цьому пристрої. Акаунт потрібен лише щоб бачити той самий журнал на телефоні й комп'ютері." }),
      email, pass, err, submit,
      el("div", { class: "acc-alt" },
        el("button", { type: "button", class: "acc-link", id: "acc-switch", text: mode === "signup" ? "Уже є акаунт? Увійти" : "Немає акаунта? Створити", onclick: () => { mode = mode === "signup" ? "login" : "signup"; paint(); } }),
        mode === "signup" ? null : el("button", { type: "button", class: "acc-link", id: "acc-forgot", text: "Забув пароль", onclick: async () => {
          const e = email.querySelector("input").value.trim();
          if (!e) { showErr(err, new Error("Спершу введи пошту, на яку надіслати лист.")); return; }
          try { await c.reset(e); notice = "Лист для скидання пароля надіслано (перевір і «Спам»)."; paint(); } catch (x) { showErr(err, x); }
        } })));
    return el("section", { class: "acc-sub", "aria-label": "Хмара" }, form, c.fromFile() && !lsHasConfig() ? null : configLink());
  }
  const lsHasConfig = () => { try { return !!localStorage.getItem("journal.firebase.v1"); } catch (e) { return false; } };
  const configLink = () => el("button", { type: "button", class: "acc-link", id: "acc-cfg-link", text: "Налаштування Firebase", onclick: () => { paintConfigOnly(); } });

  function signedIn(c, u) {
    const s = JL.sync.status();
    const err = errBox();
    if (s.state === "error" && s.error) { err.textContent = s.error; err.hidden = false; }
    const syncBtn = el("button", { type: "button", class: "acc-secondary", id: "acc-sync", text: s.state === "syncing" ? "Синхронізую…" : "Синхронізувати зараз", disabled: s.state === "syncing",
      onclick: () => { JL.sync.run(); } });
    const out = el("button", { type: "button", class: "acc-secondary", id: "acc-out", text: "Вийти", onclick: async () => {
      const ok = await JR.confirm({ title: "Вийти з акаунта?", text: "Дані лишаться на цьому пристрої й у хмарі. Поки ти не ввійдеш знову, зміни в хмару не потрапляють.", ok: "Вийти" });
      if (!ok) return;
      try { await c.signOut(); notice = "Ти вийшов з акаунта."; paint(); A.paintButton(); } catch (e) { showErr(err, e); }
    } });
    return el("section", { class: "acc-account", "aria-label": "Хмара" },
      el("div", { class: "acc-who" }, el("span", { class: "acc-avatar acc-avatar-lg", "aria-hidden": "true", text: (u.email || "?").charAt(0).toUpperCase() }),
        el("div", null, el("strong", { text: u.email }), el("small", { id: "acc-status", text: A.statusText() }))),
      err,
      el("div", { class: "acc-row" }, syncBtn, out),
      el("p", { class: "acc-note", text: "Фото в хмару потрапляють стисненими (до 640 КБ), оригінали лишаються на пристрої, де їх додано. Відео зберігаються лише на тому пристрої, де їх додано, і в резервній копії." }));
  }

  // ---- налаштування Firebase
  function configSection(first) {
    const c = cloud();
    const ta = el("textarea", { id: "acc-cfg", rows: "7", spellcheck: "false", placeholder: 'const firebaseConfig = {\n  apiKey: "…",\n  authDomain: "….firebaseapp.com",\n  projectId: "…",\n  appId: "…"\n};', "data-autofocus": "1" });
    const err = errBox();
    const save = el("button", { type: "button", class: "acc-primary", id: "acc-cfg-save", text: "Зберегти й підключити" });
    save.addEventListener("click", () => guarded(err, save, async () => {
      c.setConfig(c.parseConfig(ta.value));
      notice = "Налаштування збережено.";
      await c.init();
      A.startSync();
      paint(); A.paintButton();
    }));
    return el("section", { class: "acc-sub", "aria-label": "Налаштування Firebase" },
      el("h3", { text: first ? "Хмарна синхронізація (необов'язково)" : "Налаштування Firebase" }),
      el("p", { class: "acc-note", text: first
        ? "Щоб журнал синхронізувався між пристроями, потрібен безкоштовний проєкт Firebase. Покрокова інструкція є у файлі README.md. Без цього журнал працює локально."
        : "Встав блок firebaseConfig із консолі Firebase (Project settings → Your apps)." }),
      el("div", { class: "acc-field" }, el("label", { for: "acc-cfg", text: "Налаштування Firebase" }), ta, el("small", { text: "Це не секрет у звичному сенсі: захист даних забезпечують правила Firestore." })),
      err, save,
      !first && lsHasConfig() ? el("button", { type: "button", class: "acc-link", text: "Прибрати збережені налаштування", onclick: async () => {
        const ok = await JR.confirm({ title: "Прибрати налаштування Firebase?", text: "Журнал лишиться на пристрої. Щоб знову підключити хмару, налаштування доведеться вставити ще раз.", ok: "Прибрати" });
        if (!ok) return;
        try { await c.signOut(); } catch (e) { /* ок */ }
        c.setConfig(null); notice = "Налаштування прибрано. Онови сторінку."; paint();
      } }) : null);
  }
  function paintConfigOnly() { body.replaceChildren(configSection(false), el("button", { type: "button", class: "acc-link", text: "← Назад", onclick: paint })); }

  // ---- резервні копії
  function backupSection() {
    const err = errBox();
    const info = el("p", { class: "acc-note", id: "acc-backup-info", text: "…" });
    JL.db.meta.get(LAST_BACKUP).then((ts) => { info.textContent = ts ? `Остання копія: ${dmy(ts)}.` : "Копій ще не було."; });
    const make = el("button", { type: "button", class: "acc-secondary", id: "acc-backup", text: "Зберегти копію (ZIP)" });
    make.addEventListener("click", () => guarded(err, make, async () => {
      make.textContent = "Готую файл…";
      try {
        const { name, blob, counts } = await JL.backupCreate();
        download(blob, name);
        await JL.db.meta.set(LAST_BACKUP, Date.now());
        notice = `Копію збережено: ${counts.entries} записів, ${counts.media} файлів.`;
        A.paintHint(); paint();
      } finally { make.textContent = "Зберегти копію (ZIP)"; }
    }));
    const input = el("input", { type: "file", accept: ".zip,application/zip", id: "acc-restore-file", hidden: true });
    input.addEventListener("change", async () => {
      const f = input.files[0]; input.value = "";
      if (!f) return;
      err.hidden = true;
      const ok = await JR.confirm({ title: "Відновити з копії?", text: "Записи з копії додадуться до поточних. Якщо запис є і там, і тут, лишиться той, що змінено пізніше. Нічого не видаляється.", ok: "Відновити" });
      if (!ok) return;
      try {
        const r = await JL.backupRestore(f);
        notice = `Відновлено: журналів ${r.journals}, записів ${r.entries}, розборів ${r.reviews}, файлів ${r.media}.`;
        JR.bus.dispatchEvent(new Event("imported")); paint();
      } catch (e) { showErr(err, e); }
    });
    const restore = el("button", { type: "button", class: "acc-secondary", id: "acc-restore", text: "Відновити з копії…", onclick: () => input.click() });
    return el("section", { class: "acc-sub", "aria-label": "Резервна копія" },
      el("h3", { text: "Резервна копія" }),
      el("p", { class: "acc-note", text: "Один файл з усіма журналами, записами, розборами, фото й відео. Зберігай його в надійному місці: на диску, у хмарному сховищі." }),
      info, err, el("div", { class: "acc-row" }, make, restore), input);
  }

  // ---- пристрій
  function deviceSection() {
    const state = el("p", { class: "acc-note", id: "acc-persist", text: "" });
    const refresh = async () => {
      let t = "";
      try {
        if (navigator.storage && navigator.storage.persisted) t = (await navigator.storage.persisted()) ? "Браузер не стиратиме дані журналу без твоєї згоди." : "Браузер може стерти дані, якщо на пристрої закінчиться місце. Роби резервні копії.";
        if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); t += ` Зайнято на пристрої: ${JR.fmt.bytes(e.usage || 0)}.`; }
      } catch (e) { /* ок */ }
      state.textContent = t.trim();
    };
    refresh();
    const prot = el("button", { type: "button", class: "acc-secondary", id: "acc-protect", text: "Захистити дані від автоочищення", onclick: async () => {
      const ok = await A.persist(); await refresh();
      if (!ok) JR.toast("Браузер не дав такого захисту. Роби резервні копії.", "error");
    } });
    const wipe = el("button", { type: "button", class: "acc-delete", id: "acc-wipe", text: "Видалити всі дані з цього пристрою", onclick: async () => {
      const ok = await JR.confirm({ title: "Видалити всі дані з цього пристрою?", text: "Будуть видалені журнали, записи й файли в цьому браузері. Якщо ввімкнено хмару й ти ввійшов, дані лишаться в хмарі й повернуться після входу. Без хмари і без копії відновити їх буде неможливо.", ok: "Видалити назавжди", danger: true });
      if (!ok) return;
      await JL.db.clearAll(false); JL.mediaUrls.dropAll();
      try { await JL.cloud.signOut(); } catch (e) { /* ок */ }
      location.reload();
    } });
    return el("section", { class: "acc-sub acc-danger", "aria-label": "Цей пристрій" },
      el("h3", { text: "Цей пристрій" }), state, el("div", { class: "acc-row" }, prot), wipe);
  }

  // ---------------------------------------------------------------- допоміжне
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name, hidden: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  A.download = download;

  A.persist = async function () {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* ок */ }
    return false;
  };

  /** Підказка в бічній панелі про резервну копію. */
  A.paintHint = function () { if (A.onHint) A.onHint(); };

  // ---------------------------------------------------------------- конфлікт акаунтів на одному пристрої
  A.askConflict = function (uid) {
    return JR.modal((done) => el("div", { class: "jr-dlg-body" },
      el("h2", { id: "jr-dlg-title", text: "На цьому пристрої дані іншого акаунта" }),
      el("p", { class: "jr-note", text: "Щоб увійти в цей акаунт, потрібно видалити з пристрою журнал, який тут зараз. У хмарі цей журнал лишиться, а якщо в нього не було акаунта, його втрачено. Спершу можна зберегти копію." }),
      el("div", { class: "jr-actions" },
        el("button", { type: "button", class: "jr-btn", id: "jr-cf-cancel", text: "Скасувати й вийти", onclick: () => done("cancel") }),
        el("button", { type: "button", class: "jr-btn", id: "jr-cf-backup", text: "Зберегти копію", onclick: async () => {
          try { const { name, blob } = await JL.backupCreate(); download(blob, name); await JL.db.meta.set(LAST_BACKUP, Date.now()); JR.toast("Копію збережено"); } catch (e) { JR.toast(e.message, "error"); }
        } }),
        el("button", { type: "button", class: "jr-btn is-danger", id: "jr-cf-wipe", text: "Видалити й увійти", onclick: () => done("wipe") }))), { cls: "is-small", onEscape: () => {} });
  };

  A.startSync = function () {
    if (A._started) return;
    A._started = true;
    JL.sync.on("status", () => { A.paintButton(); repaintIfOpen(); });
    JL.sync.on("conflict", async ({ uid }) => {
      const r = await A.askConflict(uid);
      await JL.sync.resolveConflict(uid, r === "wipe");
      if (r === "wipe") JR.bus.dispatchEvent(new Event("imported"));
      A.paintButton(); repaintIfOpen();
    });
    JL.sync.on("data", () => JR.bus.dispatchEvent(new Event("remote-data")));
    JL.sync.start();
  };
})();
