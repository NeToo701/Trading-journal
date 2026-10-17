/* Розділ «Календар новин»: список подій із фільтрами, нагадування (на сторінці й системні), чіп «найближча новина»
   в шапці та перемикання між «Журнал» і «Календар новин» через #hash.
   Події беруться з data/news.json, який раз на ~30 хв оновлює GitHub Actions (див. README). Сервера немає, тому
   нагадування працюють, поки застосунок відкритий. Вигляд і логіка збігаються з календарем на сайті. */
(function () {
  "use strict";
  const { el, impactIcon, whenText, IMPACT_LABEL } = window.UI;
  const $ = (s) => document.querySelector(s);

  const CAL_KEY = "journal.cal.v1", ALERT_KEY = "journal.alerts.v1", SEEN_KEY = "journal.alerts.seen.v1";
  const DEFAULT_CAL = { impacts: ["high", "medium"], currencies: ["USD", "GBP"], period: "week", showPast: false, tz: "local" };
  const ALWAYS_CUR = ["USD", "GBP"];      // ці валюти є у фільтрі завжди, навіть коли подій по них ще немає
  const DEFAULT_ALERTS = { on: false, lead: 15, level: "high" };
  const SOURCE_LABEL = { faireconomy: "Forex Factory (неофіційний фід)", static: "ручний список", none: "немає даних" };
  const PAST_GRACE_MIN = 30; // скільки хвилин після виходу подія ще лишається в списку

  function read(key, dflt) {
    try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v && typeof v === "object" ? v : dflt; }
    catch (e) { return dflt; }
  }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* без збереження теж ок */ } }

  let data = null;       // вигляд календаря (як відповідь /api/calendar на сайті)
  let hint = "";         // пояснення, чому подій ще немає
  let loadError = null;
  const storedCal = read(CAL_KEY, null);
  let cal = { ...DEFAULT_CAL, ...(storedCal || {}), ...(storedCal ? {} : { gbp: true }) };      // gbp: фунт уже враховано (див. нижче)
  if (!Array.isArray(cal.impacts)) cal.impacts = DEFAULT_CAL.impacts;
  if (!Array.isArray(cal.currencies)) cal.currencies = DEFAULT_CAL.currencies;
  // Один раз додаємо фунт (GBP) до вже збережених налаштувань. Порожній вибір означає «усі валюти», його не чіпаємо.
  if (!cal.gbp) {
    if (cal.currencies.length && !cal.currencies.includes("GBP")) cal.currencies = [...cal.currencies, "GBP"];
    cal.gbp = true;
    write(CAL_KEY, cal);
  }
  let alerts = { ...DEFAULT_ALERTS, ...read(ALERT_KEY, {}) };
  let filtersBuilt = false;
  let curSig = "[]";

  const localTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; } })();
  const tzOpt = () => (cal.tz === "utc" ? { timeZone: "UTC" } : {});
  const fmtTime = (ts) => new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit", hour12: false, ...tzOpt() }).format(ts * 1000);
  const dayKey = (ts) => new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", ...tzOpt() }).format(ts * 1000);
  function dayLabel(ts) {
    // день тижня окремо, щоб він був у називному відмінку («середа», а не «середу»)
    const wd = new Intl.DateTimeFormat("uk-UA", { weekday: "long", ...tzOpt() }).format(ts * 1000);
    const dm = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", ...tzOpt() }).format(ts * 1000);
    const now = Date.now() / 1000;
    if (dayKey(ts) === dayKey(now)) return `Сьогодні, ${wd}, ${dm}`;
    if (dayKey(ts) === dayKey(now + 86400)) return `Завтра, ${wd}, ${dm}`;
    return `${wd.charAt(0).toUpperCase()}${wd.slice(1)}, ${dm}`;
  }
  const minutesTo = (ts) => (ts * 1000 - Date.now()) / 60000;

  // ---------------------------------------------------------------- вибірка
  const currencyOk = (c) => !cal.currencies.length || cal.currencies.includes(c);

  function visibleEvents() {
    if (!data || !data.events) return [];
    const now = Date.now() / 1000;
    const end = cal.period === "3d" ? now + 3 * 86400 : cal.period === "week" ? now + 7 * 86400 : null;
    const today = dayKey(now);
    return data.events.filter((e) => {
      if (!cal.impacts.includes(e.impact) || !currencyOk(e.currency)) return false;
      if (!cal.showPast && e.ts < now - PAST_GRACE_MIN * 60) return false;
      if (cal.period === "today") return dayKey(e.ts) === today;
      return e.ts <= end;
    });
  }

  // ---------------------------------------------------------------- маршрутизація
  function route() {
    const view = location.hash === "#calendar" ? "calendar" : "journal";
    const changed = document.body.dataset.view !== view;
    document.body.dataset.view = view;
    $("#calendar-view").hidden = view !== "calendar";
    $("#jr-shell").hidden = view !== "journal";
    for (const [id, v] of [["#tab-journal", "journal"], ["#tab-calendar", "calendar"]]) {
      const a = $(id);
      if (v === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    if (view === "calendar") renderAll();
    if (changed) window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- фільтри й нагадування
  function chipGroup(name, options, selected, onChange) {
    return el("div", { class: "chips" }, options.map(([val, node]) =>
      el("label", null,
        el("input", { type: "checkbox", name, value: val, checked: selected.includes(val),
                      onchange: (ev) => onChange(val, ev.target.checked) }),
        el("span", null, node))));
  }
  function segGroup(name, legend, options, selected, onChange) {
    return el("div", { class: "seg", role: "radiogroup", "aria-label": legend }, options.map(([val, text]) =>
      el("label", null,
        el("input", { type: "radio", name, value: val, checked: val === selected, onchange: () => onChange(val) }),
        el("span", { text }))));
  }
  const toggle = (arr, v, on) => (on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v));

  function currencyBlock() {
    const list = [...ALWAYS_CUR, ...((data && data.currencies) || []), ...cal.currencies];
    const ordered = [...new Set(list)].sort((a, b) => (a === "USD" ? -1 : b === "USD" ? 1 : a.localeCompare(b)));
    return el("div", { class: "field", id: "cal-cur" },
      el("span", { class: "lbl", text: "Валюта" }),
      ordered.length
        ? chipGroup("cal-cur", ordered.map((c) => [c, c]), cal.currencies, (c, on) => {
            cal.currencies = toggle(cal.currencies, c, on); saveCal(); renderAll();
          })
        : el("p", { class: "none", text: "Список з'явиться після завантаження." }),
      el("small", { id: "cal-cur-note", text: curNoteText() }));
  }
  const curNoteText = () => (cal.currencies.length ? "Для криптовалют найважливіші події США (USD); для пар із фунтом (GBP/USD, GBP/JPY) додай GBP."
                                                    : "Нічого не вибрано: показую всі валюти.");
  const curSignature = () => JSON.stringify((data && data.currencies) || []);

  function buildFilters() {
    $("#cal-filters").replaceChildren(
      el("div", { class: "field" },
        el("span", { class: "lbl", text: "Вплив на ринок" }),
        chipGroup("cal-imp", [["high", el("span", { class: "chip-line" }, impactIcon("high"), "Високий")],
                              ["medium", el("span", { class: "chip-line" }, impactIcon("medium"), "Середній")],
                              ["low", el("span", { class: "chip-line" }, impactIcon("low"), "Низький")],
                              ["holiday", "Вихідні"]],
          cal.impacts, (v, on) => { cal.impacts = toggle(cal.impacts, v, on); saveCal(); renderAll(); })),
      currencyBlock(),
      el("div", { class: "field" },
        el("span", { class: "lbl", text: "Період" }),
        segGroup("cal-period", "Період", [["today", "Сьогодні"], ["3d", "3 дні"], ["week", "Тиждень"]], cal.period,
          (v) => { cal.period = v; saveCal(); renderAll(); })),
      el("label", { class: "switch" },
        el("input", { type: "checkbox", name: "cal-past", checked: cal.showPast,
                      onchange: (ev) => { cal.showPast = ev.target.checked; saveCal(); renderAll(); } }),
        el("span", { text: "Показувати події, що вже вийшли" })));

    $("#cal-tz").replaceChildren(
      el("span", { class: "lbl", text: "Показувати час" }),
      segGroup("cal-tz", "Часовий пояс", [["local", localTz ? `Мій (${localTz.split("/").pop().replace("_", " ")})` : "Мій"], ["utc", "UTC"]],
        cal.tz, (v) => { cal.tz = v; saveCal(); renderAll(); }));
    buildAlerts();
    filtersBuilt = true;
    curSig = curSignature();
  }

  function permissionText() {
    if (!("Notification" in window)) return "Цей браузер не підтримує системних сповіщень: нагадування з'являтимуться на сторінці.";
    if (Notification.permission === "granted") return "Системні сповіщення дозволені: коли вкладка у фоні, нагадування прийде як сповіщення.";
    if (Notification.permission === "denied") return "Системні сповіщення заблоковані в налаштуваннях браузера: нагадування з'являтимуться на сторінці.";
    return "Браузер попросить дозвіл на системні сповіщення, коли ти увімкнеш нагадування.";
  }

  function buildAlerts() {
    const scope = () => (cal.currencies.length ? cal.currencies.join(", ") : "усіх валют");
    const note = el("small", { id: "alert-scope", text: "" });
    const perm = el("small", { id: "alert-perm", text: permissionText() });
    const refreshNote = () => { note.textContent = `Нагадування стосуються подій для: ${scope()} (змінюється у фільтрі валют).`; };
    refreshNote();
    $("#cal-alerts").replaceChildren(
      el("label", { class: "switch" },
        el("input", { type: "checkbox", name: "alert-on", checked: alerts.on,
                      onchange: async (ev) => {
                        alerts.on = ev.target.checked; saveAlerts();
                        if (alerts.on && "Notification" in window && Notification.permission === "default") {
                          try { await Notification.requestPermission(); } catch (e) { /* ок */ }
                        }
                        perm.textContent = permissionText();
                        checkAlerts();
                      } }),
        el("span", { text: "Нагадувати про новини" })),
      el("div", { class: "field" },
        el("label", { for: "alert-lead", text: "За скільки до події" }),
        el("select", { id: "alert-lead", name: "alert-lead",
                       onchange: (ev) => { alerts.lead = parseInt(ev.target.value, 10) || 15; saveAlerts(); checkAlerts(); } },
          [5, 15, 30, 60].map((m) => el("option", { value: String(m), selected: m === alerts.lead, text: `${m} хв` })))),
      el("div", { class: "field" },
        el("span", { class: "lbl", text: "Яка важливість" }),
        segGroup("alert-level", "Важливість нагадувань", [["high", "Лише високий"], ["medium", "Високий і середній"]], alerts.level,
          (v) => { alerts.level = v; saveAlerts(); checkAlerts(); })),
      note, perm,
      el("small", { text: "Працює, поки застосунок відкритий: сервера для push-повідомлень тут немає." }));
    window.__refreshAlertNote = refreshNote;
  }

  function saveCal() { write(CAL_KEY, cal); if (window.__refreshAlertNote) window.__refreshAlertNote(); }
  function saveAlerts() { write(ALERT_KEY, alerts); }

  // ---------------------------------------------------------------- список
  function evRow(e, isNext) {
    const mins = minutesTo(e.ts);
    const past = mins < 0;
    const more = el("div", { class: "ev-more", id: "more-" + e.id, hidden: true },
      el("p", { text: e.hint }),
      el("p", { class: "ev-tip", text: e.impact === "high"
        ? "Перед такою подією спреди розширюються, а після виходу ціна часто різко рухається в обидва боки. Вхід краще відкласти."
        : e.impact === "medium" ? "Може дати короткий сплеск волатильності." : "Зазвичай слабко впливає на ціну." }));
    const row = el("button", { type: "button", class: "ev-row", "aria-expanded": "false", "aria-controls": "more-" + e.id,
                               onclick: () => { const open = row.getAttribute("aria-expanded") === "true";
                                                row.setAttribute("aria-expanded", String(!open)); more.hidden = open; } },
      el("span", { class: "ev-time", text: fmtTime(e.ts) }),
      el("span", { class: "ev-cur", text: e.currency }),
      impactIcon(e.impact),
      el("span", { class: "ev-title" },
        el("span", { class: "ev-name", text: e.name_uk }),
        e.name_uk !== e.title ? el("span", { class: "ev-orig", text: e.title }) : null,
        isNext ? el("span", { class: "ev-flag", text: "Найближча важлива" }) : null),
      el("span", { class: "ev-nums" },
        e.forecast ? el("span", null, el("small", { text: "Прогноз" }), el("b", { text: e.forecast })) : null,
        e.previous ? el("span", null, el("small", { text: "Попереднє" }), el("b", { text: e.previous })) : null),
      el("span", { class: "ev-when", "data-ts": String(e.ts), text: whenText(mins) }));
    return el("li", { class: `ev ev-${e.impact}` + (past ? " is-past" : "") + (isNext ? " is-next" : "") }, row, more);
  }

  function statusBox(kind, text) {
    const box = $("#cal-status");
    box.className = "status" + (kind === "info" ? " is-info" : "");
    box.textContent = text;
    box.hidden = !text;
  }

  function renderList() {
    const root = $("#cal-list");
    root.replaceChildren();
    const meta = $("#cal-meta");
    if (loadError) { meta.textContent = ""; statusBox("error", loadError); return; }
    if (!data) { meta.textContent = "Завантажую події…"; statusBox(null, ""); return; }
    if (!data.enabled) {
      meta.textContent = "";
      statusBox("info", "Календар вимкнено.");
      return;
    }
    const src = SOURCE_LABEL[data.source] || data.source;
    const upd = data.fetched_at ? new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit", hour12: false, ...tzOpt() }).format(Date.parse(data.fetched_at)) : "";
    meta.textContent = `Джерело: ${src}.` + (upd ? ` Оновлено о ${upd}${cal.tz === "utc" ? " UTC" : ""}.` : "");
    if (data.error && !data.events.length) statusBox("error", `Календар недоступний: ${data.error} Спробуємо ще раз за кілька хвилин.`);
    else if (data.stale) statusBox("info", `Не вдалося оновити календар (${data.error}). Показано останні відомі дані.`);
    else if (hint) statusBox("info", hint);
    else statusBox(null, "");

    const evs = visibleEvents();
    if (!data.events.length) {
      root.append(el("div", { class: "panel empty" },
        el("h2", { text: "Подій ще немає" }),
        el("p", { text: "Календар заповниться після першого оновлення даних. Це робить GitHub Actions раз на ~30 хвилин (README, розділ «Календар новин»)." })));
      return;
    }
    if (!evs.length) {
      root.append(el("div", { class: "panel empty" },
        el("h2", { text: "За цими фільтрами подій немає" }),
        el("p", { text: "Спробуй додати середній вплив, інші валюти або довший період." })));
      return;
    }
    const nextId = (evs.find((e) => e.impact === "high" && e.ts * 1000 > Date.now()) || {}).id;
    const groups = new Map();
    for (const e of evs) { const k = dayKey(e.ts); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    for (const [, list] of groups) {
      root.append(el("section", { class: "cal-day" },
        el("h2", { class: "cal-day-h", text: dayLabel(list[0].ts) }),
        el("ul", { class: "ev-list" }, list.map((e) => evRow(e, e.id === nextId)))));
    }
  }

  function tickCountdowns() {
    document.querySelectorAll(".ev-when").forEach((n) => { n.textContent = whenText(minutesTo(parseInt(n.dataset.ts, 10))); });
  }

  // ---------------------------------------------------------------- чіп у шапці
  function updateNextChip() {
    const chip = $("#next-chip");
    if (!data || !data.events) { chip.hidden = true; return; }
    const now = Date.now() / 1000;
    const e = data.events.find((x) => x.impact === "high" && x.ts > now && currencyOk(x.currency));
    if (!e) { chip.hidden = true; return; }
    const m = minutesTo(e.ts);
    chip.replaceChildren(impactIcon("high"),
      el("span", { class: "next-text" }, el("b", { text: e.currency }), ` ${e.name_uk}, ${whenText(m)}`));
    chip.className = "next-chip" + (m <= 60 ? " is-soon" : "");
    chip.title = `${e.title}. Найближча подія високого впливу. Відкрити календар.`;
    chip.hidden = false;
  }

  // ---------------------------------------------------------------- нагадування
  function seenMap() { return read(SEEN_KEY, {}); }
  function checkAlerts() {
    if (!alerts.on || !data || !data.events) return;
    const now = Date.now() / 1000;
    const seen = seenMap();
    for (const k of Object.keys(seen)) if (seen[k] < now - 2 * 86400) delete seen[k];
    const fresh = [];
    for (const e of data.events) {
      if (!(e.impact === "high" || (alerts.level === "medium" && e.impact === "medium"))) continue;
      if (!currencyOk(e.currency) || seen[e.id]) continue;
      const mins = minutesTo(e.ts);
      if (mins <= 0 || mins > alerts.lead) continue;
      seen[e.id] = e.ts;
      fresh.push(e);
    }
    if (!fresh.length) return;
    write(SEEN_KEY, seen);
    // події з однаковим часом (наприклад, CPI і Core CPI) - одне нагадування, а не три
    const byTime = new Map();
    for (const e of fresh) { if (!byTime.has(e.ts)) byTime.set(e.ts, []); byTime.get(e.ts).push(e); }
    for (const list of byTime.values()) notify(list, minutesTo(list[0].ts));
  }

  const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? "подія" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "події" : "подій");

  function notify(list, mins) {
    const top = list.find((e) => e.impact === "high") || list[0];
    const many = list.length > 1;
    const title = many
      ? `${top.currency}: ${list.length} ${plural(list.length)} ${whenText(mins)}`
      : `${top.currency}: ${top.name_uk} ${whenText(mins)}`;
    const uniq = [...new Set(list.map((e) => e.name_uk))];
    const names = many ? uniq.slice(0, 4).join(", ") + (uniq.length > 4 ? " та інші" : "") + ". " : "";
    const body = names + (top.impact === "high"
      ? "Високий вплив. Біля новин ціна може різко рухатись, вхід краще відкласти."
      : "Середній вплив: можливий короткий сплеск волатильності.");
    toast(top, title, body, mins);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try { new Notification(title, { body, tag: top.id }); } catch (err) { /* ок */ }
    }
  }

  function toast(e, title, body, mins) {
    const box = $("#toasts");
    const node = el("div", { class: `toast toast-${e.impact}`, role: "status" },
      impactIcon(e.impact),
      el("div", { class: "toast-body" },
        el("strong", { text: title }),
        el("p", { text: body }),
        el("a", { href: "#calendar", text: "Відкрити календар", onclick: () => node.remove() })),
      el("button", { type: "button", class: "toast-x", "aria-label": "Закрити нагадування", text: "×", onclick: () => node.remove() }));
    box.append(node);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => node.remove(), Math.max(60, Math.round(mins * 60) + 120) * 1000);
  }

  // ---------------------------------------------------------------- завантаження
  function renderAll() {
    if (!filtersBuilt) buildFilters();
    else if (curSignature() !== curSig) {  // список валют змінився: перебудовуємо лише його (не збиваючи фокус)
      const cur = $("#cal-cur");
      if (cur) cur.replaceWith(currencyBlock());
      curSig = curSignature();
    } else { const note = $("#cal-cur-note"); if (note) note.textContent = curNoteText(); }
    renderList();
    updateNextChip();
  }

  async function load() {
    const now = Date.now();
    try {
      const r = await JL.news.load(null, now);
      // файлу ще немає (або він порожній): подій не показуємо, лише пояснюємо, як увімкнути оновлення
      hint = r.missing ? "Даних календаря ще немає. Автооновлення вмикається один раз (README, розділ «Календар новин»)." : "";
      data = JL.news.view(r.snap, now, 14, 24);
      loadError = null;
    } catch (err) {
      if (!data) loadError = "Не вдалося прочитати календар. Онови сторінку.";
    }
    renderAll();
    checkAlerts();
  }

  function init() {
    buildFilters();
    window.addEventListener("hashchange", route);
    route();
    load();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
    setInterval(load, 10 * 60 * 1000);
    setInterval(() => { tickCountdowns(); updateNextChip(); checkAlerts(); }, 30 * 1000);
  }
  init();
})();
