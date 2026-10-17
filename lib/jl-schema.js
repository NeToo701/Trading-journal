/* Схема журналу: шаблони полів, перевірка схеми й записів. Це переніс app/journal.py з сайту, правила ті самі. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { ApiError } = JL;

  const MARKETS = { crypto: { label: "Крипта", currency: "USDT" }, forex: { label: "Форекс", currency: "USD" } };
  const FIELD_TYPES = ["text", "longtext", "number", "percent", "date", "datetime", "select", "multiselect", "checkbox", "rating", "link", "media"];
  const TYPE_LABELS = {
    text: "Текст", longtext: "Великий текст", number: "Число", percent: "Відсоток", date: "Дата", datetime: "Дата й час",
    select: "Список (один варіант)", multiselect: "Список (кілька варіантів)", checkbox: "Так або ні", rating: "Оцінка від 1 до 5",
    link: "Посилання", media: "Фото й відео",
  };
  const L = {
    MAX_JOURNALS: 20, MAX_FIELDS: 60, MAX_MEDIA_FIELDS: 3, MAX_ENTRIES_PER_JOURNAL: 5000, MAX_MEDIA_PER_ENTRY: 20,
    MAX_ENTRY_BYTES: 20 * 1024, MAX_OPTIONS: 30, MAX_OPTION_LEN: 40,
    IMAGE_LIMIT: 10 * 1024 * 1024, VIDEO_LIMIT: 150 * 1024 * 1024, IMPORT_LIMIT: 300 * 1024 * 1024,
  };
  const LOCKED = { direction: ["Лонг", "Шорт"], outcome: ["Тейк-профіт", "Стоп-лос", "Беззбиток", "Закрито вручну", "Відкрита"] };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const REVIEW_FIELDS = ["summary", "went_well", "fix", "plan"];
  Object.assign(JL, { MARKETS, FIELD_TYPES, TYPE_LABELS, LIMITS: L, LOCKED, MONTH_RE, REVIEW_FIELDS });

  const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
  const EMOTIONS = ["Спокій", "Впевненість", "Страх", "Жадібність", "Азарт", "Втома", "Нетерпіння", "Сумніви", "ФОМО", "Лудоманія"];
  const MISTAKES = ["Статистичний стоп", "Вплив емоцій", "Недотримання правил/стратегії", "FOMO", "Спішка", "Вплив інших ідей",
    "Позиція відкрита не в ОТТ", "Торгував проти ФТА зон", "Не дочекався підтверджень", "Ігнорував новини",
    "Не закрив в б/у", "Погоня за рухом", "Неуважність", "Ненадійні значення для с-л"];
  const SESSIONS = ["Азія", "Франкфурт", "Лондон", "Нью-Йорк", "Перекриття Лондон і Нью-Йорк"];

  function F(key, label, type, o = {}) {
    const out = { key, label, type, builtin: true, hidden: false, table: !!o.table };
    if (o.options) out.options = [...o.options];
    if (o.hint) out.hint = o.hint;
    if (o.help) out.help = o.help;
    if (o.optional) out.optional = true;
    return out;
  }

  JL.defaultFields = function (market) {
    if (!MARKETS[market]) throw new ApiError("Невідомий ринок.", 422, "market");
    const fx = market === "forex";
    const f = [
      F("opened_at", "Дата й час входу", "datetime", { table: true }),
      F("closed_at", "Дата й час виходу", "datetime"),
      F("symbol", "Інструмент", "text", { table: true, hint: fx ? "EUR/USD" : "BTC/USDT" }),
      F("direction", "Напрямок", "select", { options: LOCKED.direction, table: true }),
      F("timeframe", "Таймфрейми", "multiselect", { options: TIMEFRAMES,
        help: "Можна обрати кілька: ті, які ти використовував в аналізі. Наприклад, 4h для контексту й 15m для входу." }),
      F("setup", "Сетап або стратегія", "text", { table: true,
        help: "Введи назву сетапу. Нові назви запам'ятовуються й пропонуються при наступних записах. Для кожного сетапу є окрема статистика на вкладці «Статистика»." }),
    ];
    if (fx) f.push(F("session", "Сесія", "select", { options: SESSIONS }));
    f.push(
      F("entry", "Ціна входу", "number"),
      F("stop", "Стоп", "number", { help: "Ціна стоп-лосу: де позиція закрилась би зі збитком." }),
      F("take", "Тейк-профіт", "number", { help: "Ціна, де ти планував зафіксувати прибуток." }),
      F("exit", "Ціна виходу", "number", { help: "Ціна, за якою ти сам закрив позицію вручну, до того як ціна дійшла до виставлених стопу чи тейк-профіту. Якщо угода закрилась сама по стопу чи тейку, поле можна не заповнювати." }),
    );
    if (fx) f.push(F("lot", "Розмір, лоти", "number"));
    else f.push(F("size", "Обсяг позиції", "number"), F("leverage", "Плече", "number"));
    f.push(
      F("risk_pct", "Ризик, % від депозиту", "percent"),
      F("rr", "RR", "number", { help: "Заплановане співвідношення ризику до прибутку. Наприклад, 3 означає 1:3. Якщо порожньо, порахується за ціною входу, стопом і тейк-профітом." }),
      F("fees", "Комісії", "number", { optional: true, help: "Необов'язкове поле." }),
    );
    if (fx) f.push(F("swap", "Своп", "number", { optional: true, help: "Необов'язкове поле." }));
    f.push(
      F("pct", "Результат, %", "percent", { table: true, help: "Результат угоди у відсотках від депозиту. Для збитку постав мінус перед числом, наприклад -0,5." }),
      F("pnl", "Прибуток або збиток, $", "number", { table: true, help: "Результат у доларах. Для збитку постав мінус перед числом, наприклад -25." }),
      F("r", "Результат, R", "number", { table: true, hint: "Якщо порожньо, порахується за входом, стопом і виходом",
        help: "Результат у частках ризику: +2 означає, що прибуток удвічі більший за ризик, -1 це повний стоп." }),
      F("outcome", "Статус", "select", { options: LOCKED.outcome, table: true,
        help: "Чим закінчилась угода. «Закрито вручну» для угод, які ти закрив сам до стопу чи тейку: прибутковою чи збитковою вона вважатиметься за знаком результату." }),
      F("emo_before", "Емоції до відкриття", "multiselect", { options: EMOTIONS }),
      F("emo_after", "Емоції після закриття", "multiselect", { options: EMOTIONS }),
      F("mistakes", "Ключові помилки", "multiselect", { options: MISTAKES }),
      F("by_rules", "Чи була угода за правилами?", "select", { options: ["Так", "Ні"] }),
      F("tp_after_stop", "Чи дійшла ціна до тейку після стопа?", "select", { options: ["Так", "Майже дійшла", "Ні"] }),
      F("re_enter", "Чи зайшов би я знову в цю позицію?", "select", { options: ["Так", "Ні"] }),
      F("re_enter_why", "Якщо ні, то чому?", "longtext"),
      F("discipline", "Дотримання плану", "rating"),
      F("notes", "Нотатки", "longtext"),
      F("conclusion", "Висновок", "longtext"),
      F("media", "Скріншоти й відео", "media"),
    );
    return f;
  };

  // ---------------------------------------------------------------- перевірка
  function text(v, field, limit, label) {
    if (typeof v !== "string") throw new ApiError(`«${label}» має бути текстом.`, 422, field);
    v = v.trim();
    if ([...v].length > limit) throw new ApiError(`«${label}» задовге: не більше ${limit} символів.`, 422, field);
    return v;
  }
  JL.cleanText = text;

  JL.cleanName = function (v, what = "Назва") {
    v = text(v == null ? "" : v, "name", 60, what);
    if (!v) throw new ApiError(`${what} не може бути порожньою.`, 422, "name");
    if ([...v].some((c) => c.codePointAt(0) < 32)) throw new ApiError(`${what} містить недозволені символи.`, 422, "name");
    return v;
  };

  JL.cleanFields = function (nw, current) {
    if (!Array.isArray(nw) || !nw.length) throw new ApiError("Список полів має бути непорожнім.", 422, "fields");
    if (nw.length > L.MAX_FIELDS) throw new ApiError(`Полів забагато: не більше ${L.MAX_FIELDS}.`, 422, "fields");
    const byKey = new Map(current.map((f) => [f.key, f]));
    const out = [], seen = new Set();
    for (const raw of nw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("Некоректне поле.", 422, "fields");
      let key = raw.key;
      const label = JL.cleanName(raw.label, "Назва поля");
      const old = key ? byKey.get(key) : null;
      if (key && !old) throw new ApiError("Невідоме поле.", 422, "fields");
      const ftype = raw.type;
      if (old) {
        if (ftype !== old.type) throw new ApiError(`Тип поля «${old.label}» змінити не можна.`, 422, "fields");
      } else {
        if (!FIELD_TYPES.includes(ftype)) throw new ApiError("Невідомий тип поля.", 422, "fields");
        key = "c_" + JL.randomHex(4);
      }
      if (seen.has(key)) throw new ApiError("Поле повторюється.", 422, "fields");
      seen.add(key);
      const field = { key, label, type: ftype, builtin: !!(old && old.builtin), hidden: !!raw.hidden,
        table: !!raw.table && ftype !== "longtext" && ftype !== "media" };
      if (old && old.hint) field.hint = old.hint;
      if (old && old.builtin) {
        if (old.help) field.help = old.help;
        if (old.optional) field.optional = true;
      } else if (raw.help) {
        field.help = text(raw.help, "fields", 200, "Підказка");
      }
      if (key === "opened_at") field.hidden = false;
      if (ftype === "select" || ftype === "multiselect") {
        if (LOCKED[key]) field.options = [...LOCKED[key]];
        else {
          const opts = raw.options;
          if (!Array.isArray(opts) || opts.length < 1 || opts.length > L.MAX_OPTIONS)
            throw new ApiError(`Для «${label}» потрібно від 1 до ${L.MAX_OPTIONS} варіантів.`, 422, "fields");
          const clean = [], uniq = new Set();
          for (let o of opts) {
            o = text(o, "fields", L.MAX_OPTION_LEN, "Варіант");
            if (o && !uniq.has(o.toLowerCase())) { uniq.add(o.toLowerCase()); clean.push(o); }
          }
          if (!clean.length) throw new ApiError(`Для «${label}» потрібен хоч один варіант.`, 422, "fields");
          field.options = clean;
        }
      }
      out.push(field);
    }
    const missing = current.filter((f) => f.builtin && !seen.has(f.key)).map((f) => f.label);
    if (missing.length) throw new ApiError(`Вбудовані поля не можна видалити: ${missing[0]}. Їх можна приховати.`, 422, "fields");
    if (out.filter((f) => f.type === "media").length > L.MAX_MEDIA_FIELDS)
      throw new ApiError(`Полів для файлів не більше ${L.MAX_MEDIA_FIELDS}.`, 422, "fields");
    return out;
  };

  /** Перевіряє одне значення за типом поля. Повертає очищене значення або undefined (тип без значення, наприклад файли). */
  function cleanValue(f, key, val) {
    const label = f.label, t = f.type;
    if (t === "text") return text(val, key, 200, label);
    if (t === "longtext") return text(val, key, 5000, label);
    if (t === "number" || t === "percent") {
      if (typeof val !== "number" && typeof val !== "string") throw new ApiError(`«${label}» має бути числом.`, 422, key);
      let x;
      if (typeof val === "string") {
        x = JL.pyFloat(val.replace(/,/g, ".").replace(/ /g, ""));
        if (x === null) throw new ApiError(`«${label}» має бути числом.`, 422, key);
      } else x = val;
      if (!Number.isFinite(x) || Math.abs(x) > 1e12) throw new ApiError(`«${label}»: число поза допустимими межами.`, 422, key);
      return x;
    }
    if (t === "date") {
      if (typeof val !== "string" || !DATE_RE.test(val)) throw new ApiError(`«${label}»: потрібна дата.`, 422, key);
      return val;
    }
    if (t === "datetime") {
      if (typeof val !== "string" || !DATETIME_RE.test(val.slice(0, 16)) || (val.length !== 16 && val.length !== 19))
        throw new ApiError(`«${label}»: потрібні дата й час.`, 422, key);
      return val.slice(0, 16);
    }
    if (t === "select") {
      const v = text(val, key, L.MAX_OPTION_LEN, label);
      if (LOCKED[key] && !LOCKED[key].includes(v)) throw new ApiError(`«${label}»: некоректне значення.`, 422, key);
      return v;
    }
    if (t === "multiselect") {
      if (!Array.isArray(val) || val.length > L.MAX_OPTIONS) throw new ApiError(`«${label}»: некоректне значення.`, 422, key);
      return [...new Set(val.filter((x) => x).map((x) => text(x, key, L.MAX_OPTION_LEN, label)))];
    }
    if (t === "checkbox") {
      if (typeof val !== "boolean") throw new ApiError(`«${label}»: потрібне значення так чи ні.`, 422, key);
      return val;
    }
    if (t === "rating") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > 5) throw new ApiError(`«${label}»: оцінка від 1 до 5.`, 422, key);
      return val;
    }
    if (t === "link") {
      const v = text(val, key, 500, label);
      if (!/^https?:\/\/[^\s<>"']+$/i.test(v)) throw new ApiError(`«${label}»: потрібне посилання, що починається з http:// або https://.`, 422, key);
      return v;
    }
    return undefined;
  }
  JL.cleanValue = cleanValue;

  JL.cleanEntry = function (fields, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("Дані запису мають бути об'єктом.", 422);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const out = {};
    for (const [key, val] of Object.entries(data)) {
      const f = byKey.get(key);
      if (!f) throw new ApiError("У записі є невідоме поле.", 422, String(key).slice(0, 40));
      if (f.type === "media") continue;
      if (val == null || val === "" || (Array.isArray(val) && !val.length)) continue;
      const v = cleanValue(f, key, val);
      if (v !== undefined) out[key] = v;
    }
    if (!out.opened_at && byKey.has("opened_at")) throw new ApiError("Вкажи дату й час входу.", 422, "opened_at");
    if (new TextEncoder().encode(JSON.stringify(out)).length > L.MAX_ENTRY_BYTES) throw new ApiError("Запис завеликий.", 413);
    return out;
  };

  // ---------------------------------------------------------------- налаштування цього застосунку (поза паритетом із сайтом)
  /* JL.defaultFields вище лишається точною копією сайту (її звіряє parity.test.js). Усе, чим цей застосунок відрізняється,
     накладається тут: нові журнали створюються через JL.appDefaultFields, старі підтягує JL.migrateJournals (lib/jl-api.js). */
  const SCHEMA_V = 2;
  // Питання розбору місяця: заповнюються на сторінці «Розбір місяця», у формі запису за замовчуванням сховані
  const REVIEW_ONLY_KEYS = ["by_rules", "tp_after_stop", "re_enter", "re_enter_why"];
  // Ключові помилки: стара назва -> нова, професійніша (до 40 символів)
  const MISTAKE_RENAMES = {
    "Статистичний стоп": "Статистичний стоп (в межах системи)",
    "Вплив емоцій": "Емоційне рішення",
    "Недотримання правил/стратегії": "Порушення торгового плану",
    "FOMO": "FOMO (страх упущеної вигоди)",
    "Спішка": "Поспішний вхід",
    "Вплив інших ідей": "Вхід за сторонньою ідеєю",
    "Позиція відкрита не в ОТТ": "Вхід поза ОТТ",
    "Торгував проти ФТА зон": "Торгівля проти зон ФТА",
    "Не дочекався підтверджень": "Вхід без підтвердження сигналу",
    "Ігнорував новини": "Ігнорування новинного фону",
    "Не закрив в б/у": "Не переведено стоп у беззбиток",
    "Погоня за рухом": "Вхід навздогін руху ціни",
    "Неуважність": "Втрата концентрації",
    "Ненадійні значення для с-л": "Стоп-лос за ненадійним рівнем",
  };
  const PRO_MISTAKES = MISTAKES.map((m) => MISTAKE_RENAMES[m]);
  Object.assign(JL, { SCHEMA_V, REVIEW_ONLY_KEYS, MISTAKE_RENAMES, PRO_MISTAKES });

  JL.appDefaultFields = function (market) {
    return JL.defaultFields(market).map((f) => {
      if (f.key === "mistakes") return { ...f, options: [...PRO_MISTAKES] };
      if (REVIEW_ONLY_KEYS.includes(f.key)) return { ...f, hidden: true };
      return f;
    });
  };
})(typeof window !== "undefined" ? window : globalThis);
