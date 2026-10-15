/* Імпорт записів із таблиці CSV або з архіву експорту Notion (ZIP). Переніс app/journal_import.py: ті самі правила
   зіставлення колонок і перетворення значень, але все відбувається в браузері, файл нікуди не надсилається. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { ApiError } = JL;

  const MAX_CSV_BYTES = 20 * 1024 * 1024, MAX_ROWS = 5000, MAX_ZIP_MEMBERS = 20000, MAX_ZIP_UNPACKED = 600 * 1024 * 1024;
  const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    "січня": 1, "лютого": 2, "березня": 3, "квітня": 4, "травня": 5, "червня": 6, "липня": 7, "серпня": 8, "вересня": 9,
    "жовтня": 10, "листопада": 11, "грудня": 12,
    "січень": 1, "лютий": 2, "березень": 3, "квітень": 4, "травень": 5, "червень": 6, "липень": 7, "серпень": 8,
    "вересень": 9, "жовтень": 10, "листопад": 11, "грудень": 12,
  };
  const HINTS = [
    ["closed_at", ["дата виходу", "час виходу", "дата закриття", "закриття", "close time", "close date", "closed", "exit date", "exit time", "date close"]],
    ["opened_at", ["дата й час входу", "дата входу", "час входу", "дата відкриття", "відкриття", "open time", "open date", "opened", "entry date", "entry time", "date open", "date", "дата"]],
    ["symbol", ["інструмент", "пара", "актив", "symbol", "pair", "instrument", "asset", "ticker"]],
    ["direction", ["напрямок", "напрям", "direction", "side", "long/short", "buy/sell", "лонг/шорт"]],
    ["timeframe", ["таймфрейм", "timeframe", "тф", "tf"]],
    ["setup", ["сетап", "стратегі", "setup", "strategy", "pattern", "модель"]],
    ["session", ["сесія", "session"]],
    ["exit", ["ціна виходу", "price exit", "exit price", "close price", "вихід", "exit"]],
    ["entry", ["ціна входу", "entry price", "open price", "price entry", "вхід", "entry"]],
    ["stop", ["стоп-лос", "стоп лос", "stop loss", "стоп", "stop", "sl"]],
    ["take", ["тейк-профіт", "тейк профіт", "take profit", "тейк", "take", "target", "tp"]],
    ["lot", ["лот", "lot"]],
    ["size", ["обсяг", "size", "volume"]],
    ["leverage", ["плече", "leverage"]],
    ["risk_pct", ["ризик", "risk"]],
    ["rr", ["risk reward", "ризик/прибуток", "r:r", "rr"]],
    ["fees", ["комісі", "commission", "fees", "fee"]],
    ["swap", ["своп", "swap"]],
    ["pct", ["total%", "результат %", "результат, %", "result %", "pnl %", "profit %", "%", "відсоток", "percent"]],
    ["pnl", ["прибуток або збиток", "p&l", "pnl", "profit", "прибуток", "збиток", "total$", "результат $", "result $", "$"]],
    ["r", ["результат r", "результат, r", "result r", "r result", "multiple"]],
    ["outcome", ["статус", "status", "outcome", "результат", "result"]],
    ["emo_after", ["емоції після", "emotions after", "після"]],
    ["emo_before", ["емоції до", "emotions before", "емоції", "emotions", "emotion"]],
    ["mistakes", ["помилки", "mistakes", "errors", "mistake"]],
    ["by_rules", ["за правилами", "по правилам", "by rules", "rules"]],
    ["tp_after_stop", ["після стопа", "після стопу", "after stop"]],
    ["re_enter_why", ["якщо ні", "чому"]],
    ["re_enter", ["зайшов би", "знову", "re-enter", "reenter"]],
    ["conclusion", ["висновок", "conclusion"]],
    ["notes", ["нотатки", "коментар", "notes", "comment", "опис", "description", "note"]],
  ];

  const cut = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join("") : s; };
  const norm = (h) => String(h == null ? "" : h).toLowerCase().replace(/﻿/g, "").replace(/[^\p{L}\p{N}_%$&:/\-,\s]/gu, " ").replace(/\s+/g, " ").trim();

  function guessMapping(headers, samples, fieldKeys) {
    const out = {}; headers.forEach((h) => { out[h] = ""; });
    const used = new Set();
    const normed = {}; headers.forEach((h) => { normed[h] = norm(h); });
    const numberLike = (h) => {
      const vals = (samples[h] || []).filter((v) => v.trim());
      return vals.length > 0 && vals.every((v) => /^[+\-−(]?[$€₴£]?\s*[\d.,\s]+\s*[%$€₴£R]?\)?$/.test(v.trim()));
    };
    for (const exact of [true, false]) {
      for (const [key, hints] of HINTS) {
        if (!fieldKeys.has(key) || (used.has(key) && key !== "notes")) continue;
        for (const h of headers) {
          if (out[h] || (used.has(key) && key !== "notes")) continue;
          const n = normed[h];
          const hit = exact ? hints.includes(n) : hints.some((x) => x.length > 2 && n.includes(x));
          if (!hit) continue;
          if (key === "outcome" && numberLike(h)) {
            const key2 = (samples[h] || []).some((v) => v.includes("%")) ? "pct" : "pnl";
            if (fieldKeys.has(key2) && !used.has(key2)) { out[h] = key2; used.add(key2); }
            continue;
          }
          out[h] = key; used.add(key);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- читання джерела
  function decode(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, ""); } catch (e) { /* далі */ }
    if (!bytes.includes(0x98)) { try { return new TextDecoder("windows-1251", { fatal: true }).decode(bytes); } catch (e) { /* далі */ } }   // 0x98 у cp1251 не визначено
    return new TextDecoder("utf-8").decode(bytes);
  }

  function parseCsv(bytes) {
    if (bytes.length > MAX_CSV_BYTES) throw new ApiError("Таблиця завелика: не більше 20 МБ.", 413);
    const text = decode(bytes);
    const first = text.split("\n", 1)[0];
    let delim = ",", best = -1;
    for (const d of [",", ";", "\t"]) { const c = first.split(d).length - 1; if (c > best) { best = c; delim = d; } }
    const rows = JL.csvRead(text, delim).filter((r) => r.some((c) => c.trim()));
    if (rows.length < 2) throw new ApiError("У таблиці немає рядків із даними.", 422);
    const headers = [], seen = {};
    rows[0].forEach((h0, i) => {
      const h = h0.trim().replace(/^﻿+/, "") || `Колонка ${i + 1}`;
      seen[h] = (seen[h] || 0) + 1;
      headers.push(seen[h] === 1 ? h : `${h} (${seen[h]})`);
    });
    const body = rows.slice(1, MAX_ROWS + 1);
    return { headers, rows: body.map((r) => { const o = {}; headers.forEach((h, i) => { o[h] = i < r.length ? r[i].trim() : ""; }); return o; }) };
  }

  const IMG_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
  const isImg = (n) => IMG_EXT.some((e) => n.toLowerCase().endsWith(e));
  const titleKey = (s) => s.trim().replace(/\s+[0-9a-f]{32}$/, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
  function normpath(p) {
    const out = [];
    for (const part of p.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else out.push(".."); } else out.push(part);
    }
    return out.join("/");
  }

  async function matchPages(zip, infos, headers, rows) {
    const names = new Set(infos.map((i) => i.name));
    const pages = new Map();
    for (const i of infos) {
      if (!i.name.toLowerCase().endsWith(".md") || i.size > 5 * 1024 * 1024) continue;
      const stem = basename(i.name).slice(0, -3);
      const txt = decode(await zip.read(i));
      const refs = [];
      for (const m of txt.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        let ref = m[1];
        try { ref = decodeURIComponent(ref); } catch (e) { /* лишаємо як є */ }
        if (/^[a-z]+:\/\//.test(ref)) continue;
        const dir = dirname(i.name);
        const full = normpath(dir ? dir + "/" + ref : ref);
        if (names.has(full) && isImg(full)) refs.push(full);
      }
      const folder = i.name.slice(0, -3) + "/";
      for (const n of [...names].sort()) if (n.startsWith(folder) && isImg(n) && !refs.includes(n)) refs.push(n);
      if (refs.length && !pages.has(titleKey(stem))) pages.set(titleKey(stem), refs);
    }
    if (!pages.size) return {};
    let titleCols = headers.filter((h) => ["name", "назва", "title", "ім'я", "позиція"].includes(norm(h)));
    if (!titleCols.length) titleCols = headers.slice(0, 1);
    const out = {};
    rows.forEach((row, idx) => {
      for (const h of titleCols) {
        const refs = pages.get(titleKey(row[h] || ""));
        if (refs) { out[idx] = refs; break; }
      }
    });
    return out;
  }

  /** file: Blob/File. Повертає {kind, headers, rows, csvName, images, zip}. */
  async function readSource(file, filename) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (!(head[0] === 0x50 && head[1] === 0x4b)) {
      if (file.size > MAX_CSV_BYTES) throw new ApiError("Таблиця завелика: не більше 20 МБ.", 413);
      const { headers, rows } = parseCsv(new Uint8Array(await file.arrayBuffer()));
      return { kind: "csv", headers, rows, csvName: filename || "", images: {}, zip: null };
    }
    const zip = await JL.zipOpen(file);
    const infos = zip.entries.filter((e) => !e.dir);
    if (infos.length > MAX_ZIP_MEMBERS) throw new ApiError("В архіві забагато файлів.", 422);
    if (infos.reduce((a, e) => a + e.size, 0) > MAX_ZIP_UNPACKED) throw new ApiError("Архів після розпакування завеликий.", 413);
    const csvs = infos.filter((e) => e.name.toLowerCase().endsWith(".csv") && e.size <= MAX_CSV_BYTES);
    if (!csvs.length) throw new ApiError("В архіві немає CSV-таблиці. Експортуй базу даних Notion у форматі «Markdown & CSV».", 422);
    let best = null;
    for (const info of csvs) {
      let parsed;
      try { parsed = parseCsv(await zip.read(info)); } catch (e) { if (e instanceof ApiError) continue; throw e; }
      const score = [parsed.rows.length, info.name.toLowerCase().endsWith("_all.csv") ? 1 : 0];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { score, info, ...parsed };
    }
    if (!best) throw new ApiError("Не вдалося прочитати CSV в архіві.", 422);
    const images = await matchPages(zip, infos, best.headers, best.rows);
    return { kind: "zip", headers: best.headers, rows: best.rows, csvName: best.info.name, images, zip };
  }

  // ---------------------------------------------------------------- перетворення значень
  function parseNumber(v, ratio = false) {
    let s = String(v == null ? "" : v).trim().replace(/[  ]/g, " ").replace(/−/g, "-").replace(/–/g, "-");
    if (!s) return null;
    let neg = false;
    if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1); }
    if (ratio && /^\s*1\s*[:/]\s*\d+([.,]\d+)?\s*$/.test(s)) s = s.split(/[:/]/)[1];
    s = s.replace(/[$€₴£%]|usdt?|usd|eur|uah|\s/gi, "");
    s = s.replace(/[rр]$/i, "");
    if (s.startsWith("+")) s = s.slice(1);
    const dashes = (s.match(/-/g) || []).length;
    if (dashes > 1 || (dashes === 1 && !s.startsWith("-"))) return null;
    if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(".") > s.lastIndexOf(",") ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(/,/g, ".");
    else if (s.includes(",")) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(/,/g, ".");
    const x = JL.pyFloat(s);
    if (x === null || !Number.isFinite(x) || Math.abs(x) > 1e12) return null;
    return neg ? -x : x;
  }

  /** -> {day: {y,m,d,iso}, time: "HH:MM"|null} або null */
  function parseDatetime(v, dayFirst = true) {
    let s = String(v == null ? "" : v).trim();
    if (!s) return null;
    s = s.split(/\s*(?:→|->|—)\s*/)[0];
    s = s.replace(/\(?\bGMT[+-]\d+(?::\d+)?\)?|\bUTC\b|(?<![\p{L}\p{N}_])р\.?(?=\s|$)/gu, "").trim();
    let t = null;
    const tm = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(s);
    if (tm) {
      let h = +tm[1]; const mi = +tm[2];
      if (tm[3]) h = (h % 12) + (tm[3].toLowerCase() === "pm" ? 12 : 0);
      if (h < 24 && mi < 60) t = `${JL.pad(h)}:${JL.pad(mi)}`;
      s = (s.slice(0, tm.index) + " " + s.slice(tm.index + tm[0].length)).trim();
    }
    s = s.replace(/T/g, " ").trim().replace(/,+$/, "");
    let d = null, m;
    if ((m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(s))) d = [+m[1], +m[2], +m[3]];
    if (!d && (m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/.exec(s))) {
      const a = +m[1], b = +m[2]; let y = +m[3];
      if (y < 100) y += 2000;
      if (s.includes(".") || s.includes("-")) d = [y, b, a];
      else if (a > 12) d = [y, b, a];
      else if (b > 12) d = [y, a, b];
      else d = dayFirst ? [y, b, a] : [y, a, b];
    }
    const L = "A-Za-zА-Яа-яІіЇїЄєґҐ";
    if (!d && (m = new RegExp(`^([${L}]+)\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})$`).exec(s)) && MONTHS[m[1].toLowerCase()]) d = [+m[3], MONTHS[m[1].toLowerCase()], +m[2]];
    if (!d && (m = new RegExp(`^(\\d{1,2})\\s+([${L}]+)\\.?,?\\s+(\\d{4})$`).exec(s)) && MONTHS[m[2].toLowerCase()]) d = [+m[3], MONTHS[m[2].toLowerCase()], +m[1]];
    if (!d || !JL.validDate(d[0], d[1], d[2])) return null;
    return { day: JL.mkDay(d[0], d[1], d[2]), time: t };
  }

  const DIRECTION = { long: "Лонг", buy: "Лонг", "лонг": "Лонг", b: "Лонг", l: "Лонг", "купівля": "Лонг", "buy limit": "Лонг",
    short: "Шорт", sell: "Шорт", "шорт": "Шорт", s: "Шорт", "продаж": "Шорт", "sell limit": "Шорт" };
  const OUTCOME = {
    "тейк-профіт": "Тейк-профіт", "тейк профіт": "Тейк-профіт", "тейк": "Тейк-профіт", tp: "Тейк-профіт", "take profit": "Тейк-профіт",
    "take-profit": "Тейк-профіт", win: "Тейк-профіт", profit: "Тейк-профіт", "прибуток": "Тейк-профіт", "виграш": "Тейк-профіт",
    "стоп-лос": "Стоп-лос", "стоп лос": "Стоп-лос", "стоп": "Стоп-лос", sl: "Стоп-лос", "stop loss": "Стоп-лос", stop: "Стоп-лос",
    loss: "Стоп-лос", lose: "Стоп-лос", "збиток": "Стоп-лос", "програш": "Стоп-лос", "стопнуло": "Стоп-лос",
    "беззбиток": "Беззбиток", "б/у": "Беззбиток", "бу": "Беззбиток", be: "Беззбиток", breakeven: "Беззбиток", "break even": "Беззбиток",
    "вручну": "Закрито вручну", "закрито вручну": "Закрито вручну", manual: "Закрито вручну", manually: "Закрито вручну",
    "відкрита": "Відкрита", open: "Відкрита", active: "Відкрита", "в роботі": "Відкрита",
  };
  const TRUE = new Set(["yes", "true", "так", "1", "✅", "y", "x", "да"]), FALSE = new Set(["no", "false", "ні", "0", "n", "нет", "❌"]);
  const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

  function normTf(v) {
    const t = v.trim().toLowerCase().replace(/ /g, "");
    let m = /^([mhdw])(\d+)$/.exec(t);
    if (m) return `${+m[2]}${m[1]}`;
    m = /^(\d+)(min|m|h|hr|d|w)$/.exec(t);
    if (m) return `${+m[1]}${{ min: "m", hr: "h" }[m[2]] || m[2]}`;
    return v.trim();
  }

  class Converter {
    constructor(fields, mapping, dayFirst = true) {
      this.fields = new Map(fields.map((f) => [f.key, f]));
      this.mapping = {};
      for (const [c, k] of Object.entries(mapping)) if (k && this.fields.has(k) && this.fields.get(k).type !== "media") this.mapping[c] = k;
      this.dayFirst = dayFirst;
      this.shared = {};
      for (const k of Object.values(this.mapping)) this.shared[k] = (this.shared[k] || 0) + 1;
      this.newOptions = {}; this.warnings = new Map();
    }
    warn(t) { this.warnings.set(t, (this.warnings.get(t) || 0) + 1); }
    option(f, v) {
      const opts = [...(f.options || []), ...(this.newOptions[f.key] || [])];
      const low = v.toLowerCase().trim();
      const hit = opts.find((o) => o.toLowerCase() === low);
      if (hit) return hit;
      if (f.key === "direction" || f.key === "outcome") return null;
      if (opts.length >= 30 || [...v].length > 40) { this.warn(`«${f.label}»: значення «${cut(v, 30)}» не додано до списку (забагато варіантів)`); return null; }
      (this.newOptions[f.key] = this.newOptions[f.key] || []).push(v);
      return v;
    }
    convert(row) {
      const data = {}, problems = [];
      for (const [col, key] of Object.entries(this.mapping)) {
        const raw = (row[col] || "").trim();
        if (!raw) continue;
        const f = this.fields.get(key), t = f.type, label = f.label;
        if (t === "text") { if (!(key in data)) data[key] = cut(raw, 200); }
        else if (t === "longtext") {
          const piece = (this.shared[key] || 0) > 1 ? `${col}: ${raw}` : raw;
          data[key] = cut(data[key] ? data[key] + "\n" + piece : piece, 5000);
        } else if (t === "number" || t === "percent") {
          const x = parseNumber(raw, key === "rr");
          if (x == null) this.warn(`«${label}»: не вдалося прочитати число`); else data[key] = x;
        } else if (t === "date" || t === "datetime") {
          const p = parseDatetime(raw, this.dayFirst);
          if (!p) { this.warn(`«${label}»: не вдалося прочитати дату`); continue; }
          data[key] = t === "date" ? p.day.iso : `${p.day.iso}T${p.time || "00:00"}`;
        } else if (t === "select") {
          let v;
          if (key === "direction") v = own(DIRECTION, raw.toLowerCase());
          else if (key === "outcome") {
            v = own(OUTCOME, raw.toLowerCase());
            if (v === undefined && /^(tp|тейк|win|take)/i.test(raw)) v = "Тейк-профіт";
            else if (v === undefined && /^(sl|стоп|loss|lose)/i.test(raw)) v = "Стоп-лос";
          } else v = this.option(f, raw);
          if (v == null) this.warn(`«${label}»: значення «${cut(raw, 30)}» не розпізнано`); else data[key] = v;
        } else if (t === "multiselect") {
          const vals = [];
          for (let x of raw.split(/[,;|\n]/).map((s) => s.trim()).filter(Boolean)) {
            if (key === "timeframe") x = normTf(x);
            const v = this.option(f, x);
            if (v && !vals.includes(v)) vals.push(v);
          }
          if (vals.length) data[key] = vals.slice(0, 30);
        } else if (t === "checkbox") {
          const low = raw.toLowerCase();
          if (TRUE.has(low)) data[key] = true; else if (FALSE.has(low)) data[key] = false;
        } else if (t === "rating") {
          let n = raw.split("⭐").length - 1 || raw.split("★").length - 1;
          if (!n) { const x = parseNumber(raw); n = x != null ? Math.trunc(x) : 0; }
          if (n >= 1 && n <= 5) data[key] = n; else this.warn(`«${label}»: оцінка має бути від 1 до 5`);
        } else if (t === "link") {
          const m = /https?:\/\/[^\s<>"')]+/.exec(raw);
          if (m) data[key] = cut(m[0], 500);
        }
      }
      if (this.fields.has("opened_at") && !data.opened_at) {
        if (data.closed_at) { data.opened_at = data.closed_at; this.warn("Немає дати входу: використано дату виходу"); }
        else problems.push("немає дати входу");
      }
      if (data.setup) data.setup = cut(data.setup.split(/\s+/).filter(Boolean).join(" "), 200);
      return [data, problems];
    }
  }

  JL.importer = { guessMapping, parseCsv, readSource, parseNumber, parseDatetime, Converter, normTf, decode, MAX_ROWS };
})(typeof window !== "undefined" ? window : globalThis);
