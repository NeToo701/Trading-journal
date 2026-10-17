/* Календар новин: розбір подій і пояснення (порт backend/app/news/*), без мережі й сервера.
   Дані беруться з файлу data/news.json, який раз на ~30 хвилин оновлює GitHub Actions (scripts/fetch-news.js).
   Формат файла: { "fetched_at": ISO | null, "source": "faireconomy" | "none", "events": [сирі записи фіду] }. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const IMPACTS = ["high", "medium", "low", "holiday"];
  const cut = (s, n) => [...s].slice(0, n).join("");

  // ---------------------------------------------------------------- SHA-1 (для стабільного id події, як на сайті)
  function sha1hex(str) {
    const bytes = new TextEncoder().encode(str);
    const words = [];
    for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    const bitLen = bytes.length * 8;
    words[bitLen >> 5] |= 0x80 << (24 - (bitLen % 32));
    words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const rol = (x, n) => (x << n) | (x >>> (32 - n));
    for (let i = 0; i < words.length; i += 16) {
      const w = new Array(80);
      for (let t = 0; t < 80; t++) w[t] = t < 16 ? words[i + t] | 0 : rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const tmp = (rol(a, 5) + f + e + k + w[t]) | 0;
        e = d; d = c; c = rol(b, 30); b = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
  }

  // ---------------------------------------------------------------- пояснення подій для новачків (порт glossary.py)
  const RULES = [
    [/\bADP\b/i, "Зайнятість у приватному секторі (ADP)", "Попередній сигнал перед офіційним звітом про зайнятість. Впливає слабше, але теж може дати різкий рух."],
    [/Non-?Farm|\bNFP\b/i, "Звіт про зайнятість у США (NFP)", "Скільки нових робочих місць з'явилося в США. Одна з найсильніших подій тижня: ціна може різко піти в обидва боки за лічені секунди."],
    [/Unemployment Rate/i, "Рівень безробіття", "Частка людей без роботи. Виходить разом зі звітом про зайнятість; сильний ринок праці зазвичай підтримує долар."],
    [/Unemployment Claims/i, "Заявки на допомогу з безробіття", "Щотижневий показник ринку праці США. Вплив зазвичай середній або слабкий."],
    [/Core PCE|PCE Price/i, "Базова інфляція PCE", "Інфляційний показник, за яким найуважніше стежить ФРС. Впливає на очікування щодо ставки."],
    [/Core CPI|\bCPI\b/i, "Інфляція (CPI)", "Показує, наскільки зросли споживчі ціни. Від неї залежать рішення ФРС щодо ставки, тому реакція ринку зазвичай сильна."],
    [/\bPPI\b/i, "Ціни виробників (PPI)", "Інфляція на рівні виробників; часто випереджає споживчу. Вплив середній."],
    [/Federal Funds Rate/i, "Рішення ФРС щодо ставки", "Головна подія для долара й усіх ринків: розмір відсоткової ставки. Волатильність буває і до, і після виходу."],
    [/FOMC Press Conference/i, "Пресконференція ФРС", "Голова ФРС коментує рішення. Окремі фрази можуть розвернути рух уже під час виступу."],
    [/FOMC Statement/i, "Заява ФРС", "Текст рішення комітету ФРС. Ринок читає кожне слово, тому можливий різкий рух."],
    [/FOMC.*Minutes|Meeting Minutes/i, "Протокол засідання ФРС", "Деталі обговорення на попередньому засіданні. Зазвичай слабший рух, ніж від самого рішення."],
    [/Powell|Fed Chair/i, "Виступ голови ФРС", "Слова голови ФРС часто рухають ринок, навіть якщо цифр у виступі немає."],
    [/Speaks|Testifies|Speech/i, "Виступ посадовця", "Виступ представника центробанку. Зазвичай слабкий вплив, але несподівана фраза може рухнути ринок."],
    [/Rate Statement|Interest Rate|Main Refinancing|Official Bank Rate|Policy Rate|Cash Rate|Monetary Policy/i, "Рішення центробанку щодо ставки", "Зміна ставки центробанку впливає на курс національної валюти та на настрій усього ринку."],
    [/\bGDP\b/i, "Зростання економіки (ВВП)", "Показує, росте економіка чи слабшає. Сильні відхилення від прогнозу рухають ринок."],
    [/Retail Sales/i, "Роздрібні продажі", "Скільки витрачають споживачі: це основа економіки США. Вплив середній або сильний."],
    [/PMI/i, "Індекс ділової активності (PMI)", "Опитування менеджерів компаній: значення вище 50 означає зростання активності, нижче 50 спад."],
    [/JOLTS|Job Openings/i, "Вакансії (JOLTS)", "Скільки вакансій відкрито в економіці. Додатковий сигнал про стан ринку праці."],
    [/Consumer Confidence|Consumer Sentiment/i, "Споживча довіра", "Наскільки впевнено почуваються споживачі. Вплив зазвичай середній."],
    [/Crude Oil/i, "Запаси нафти в США", "Тижневий звіт, важливіший для нафти, ніж для крипторинку. Вплив слабкий."],
    [/Auction/i, "Аукціон держоблігацій", "Попит на облігації впливає на дохідність, а вона - на долар і ризикові активи."],
    [/Manufacturing Index|Empire State|Philly Fed/i, "Індекс виробництва", "Регіональне опитування промисловості. Вплив зазвичай слабкий або середній."],
    [/Trade Balance|Durable Goods|Home Sales|Housing/i, "Другорядна економічна статистика", "Показник, який рідко рухає ринок сам по собі, якщо не відрізняється від прогнозу."],
    [/Holiday/i, "Вихідний", "Банки або біржі в цій країні не працюють: ліквідність нижча, рухи можуть бути несподіваними."],
  ];
  const FALLBACK = {
    high: "Важлива подія: можливий різкий рух ціни в обидва боки.",
    medium: "Помітна подія: може дати короткий сплеск волатильності.",
    low: "Другорядна подія: зазвичай вплив слабкий.",
    holiday: "Вихідний: ліквідність нижча, рухи можуть бути несподіваними.",
  };
  function describe(title, impact) {
    if (impact === "holiday") return ["Вихідний", RULES[RULES.length - 1][2]];
    for (const [rx, name, hint] of RULES) if (rx.test(title)) return [name, hint];
    return [title, FALLBACK[impact] || FALLBACK.low];
  }

  // ---------------------------------------------------------------- розбір фіду (порт parse_faireconomy)
  const norm = (v) => String(v == null ? "" : v).trim();
  const DT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

  /** ISO-рядок із часовим поясом -> {ms, micro} в UTC або null (як datetime.fromisoformat + відкидання «наївних» дат). */
  function parseWhen(s) {
    const m = DT.exec(s.replace(/Z/g, "+00:00"));
    if (!m) return null;
    const [y, mo, d, h, mi = "0", se = "0", fr = ""] = m.slice(1, 8);
    const off = m[8];
    if (!JL.validDate(+y, +mo, +d) || +h > 23 || +mi > 59 || +se > 59) return null;
    const om = /^([+-])(\d{2}):?(\d{2})?$/.exec(off === "Z" ? "+00:00" : off);
    const oh = +om[2], omin = +(om[3] || 0);
    if (oh > 23 || omin > 59) return null;
    const offMin = (om[1] === "-" ? -1 : 1) * (oh * 60 + omin);
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - offMin * 60000;
    if (!Number.isFinite(ms)) return null;
    return { ms, micro: fr ? +fr.slice(0, 6).padEnd(6, "0") : 0 };
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  function isoUtc(ms) {
    const t = new Date(ms);
    return `${String(t.getUTCFullYear()).padStart(4, "0")}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}T${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())}+00:00`;
  }

  /** Подія з готових полів; id, name_uk і hint рахуються як на сайті. */
  function mkEvent(title, currency, impact, ms, micro, forecast, previous) {
    const iso = isoUtc(ms) .replace("+00:00", micro ? `.${String(micro).padStart(6, "0")}+00:00` : "+00:00");
    const [nameUk, hint] = describe(title, impact);
    return {
      id: sha1hex(`${title}|${currency}|${iso}`).slice(0, 10), title, name_uk: nameUk, hint, currency, impact,
      time: isoUtc(ms), ts: Math.floor(ms / 1000), forecast, previous,
    };
  }

  function parseFaireconomy(items) {
    if (!Array.isArray(items)) throw new JL.ApiError("Календар повернув дані в незнайомому форматі.", 422);
    const out = [], micros = new Map(); // дробові секунди потрібні лише для порядку (як у Python: сортування за повним datetime)
    for (const it of items) {
      if (!it || typeof it !== "object" || Array.isArray(it)) continue;
      const title = norm(it.title), cur = norm(it.country).toUpperCase();
      if (!title || [...cur].length !== 3 || !/^\p{L}+$/u.test(cur)) continue;
      const when = parseWhen(norm(it.date));
      if (!when) continue;
      let impact = norm(it.impact).toLowerCase();
      if (!IMPACTS.includes(impact)) impact = "low";
      const ev = mkEvent(cut(title, 120), cur, impact, when.ms, when.micro, cut(norm(it.forecast), 24), cut(norm(it.previous), 24));
      micros.set(ev, when.micro);
      out.push(ev);
    }
    return out.sort((a, b) => (a.ts - b.ts) || (micros.get(a) - micros.get(b)) || JL.cmp(a.currency, b.currency) || JL.cmp(a.title, b.title));
  }

  // ---------------------------------------------------------------- вигляд для сторінки (порт AnalysisService.calendar)
  function view(snap, nowMs, days = 7, pastHours = 6) {
    days = Math.max(1, Math.min(Math.trunc(days), 14));
    pastHours = Math.max(0, Math.min(Math.trunc(pastHours), 48));
    const lo = nowMs - pastHours * 3600000, hi = nowMs + days * 86400000;
    return {
      enabled: true, source: snap.source, error: snap.error, stale: snap.stale, now: isoUtc(nowMs),
      fetched_at: snap.fetched_at ? isoUtc(snap.fetched_at) : null,
      currencies: [...new Set(snap.events.map((e) => e.currency))].sort((a, b) => JL.cmp(a, b)),
      events: snap.events.filter((e) => e.ts * 1000 >= lo && e.ts * 1000 <= hi),
    };
  }

  // ---------------------------------------------------------------- завантаження
  const STALE_AFTER_H = 6;
  /** Читає data/news.json. Повертає {snap: {events, fetched_at(мс), source, error, stale}, missing: bool}. */
  async function load(fetchFn, nowMs) {
    const f = fetchFn || ((u, o) => root.fetch(u, o));
    let res;
    try { res = await f("data/news.json", { cache: "no-store" }); }
    catch (e) { return { snap: { events: [], fetched_at: null, source: "none", error: "Не вдалося завантажити календар. Перевір інтернет.", stale: false }, missing: false }; }
    if (!res.ok) return { snap: { events: [], fetched_at: null, source: "none", error: null, stale: false }, missing: true };
    let j;
    try { j = await res.json(); } catch (e) { return { snap: { events: [], fetched_at: null, source: "none", error: "Файл календаря пошкоджено.", stale: false }, missing: false }; }
    if (!j || typeof j !== "object" || !Array.isArray(j.events)) return { snap: { events: [], fetched_at: null, source: "none", error: "Файл календаря має незнайомий формат.", stale: false }, missing: false };
    const events = parseFaireconomy(j.events);
    const fetched = j.fetched_at ? Date.parse(j.fetched_at) : NaN;
    const fetchedAt = Number.isFinite(fetched) ? fetched : null;
    const now = nowMs == null ? Date.now() : nowMs;
    const old = fetchedAt != null && now - fetchedAt > STALE_AFTER_H * 3600000;
    return { snap: { events, fetched_at: fetchedAt, source: String(j.source || "faireconomy"), stale: old && events.length > 0,
      error: old && events.length ? `Календар не оновлювався понад ${STALE_AFTER_H} годин` : null }, missing: !events.length };
  }

  JL.news = { describe, parseFaireconomy, parseWhen, mkEvent, view, load, sha1hex, isoUtc, STALE_AFTER_H };
})(typeof window !== "undefined" ? window : globalThis);
