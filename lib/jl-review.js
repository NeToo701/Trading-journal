/* Налаштування сторінки «Розбір місяця»: які блоки показувати і в якому порядку, яка статистика в підсумку (готова чи за власною
   формулою), які поля у висновку місяця й які питання ставити по кожній угоді. Налаштування лежать у записі журналу
   (journal.review_cfg), тому синхронізуються з хмарою і входять у резервну копію.

   cfg = {
     blocks:       [{id: "summary"|"mistakes"|"positions"|"conclusion", visible}],
     metrics:      [{id, visible, label?, custom?, formula?, fmt?, dec?}],       // id готової = ключ підсумку статистики, власної = x_xxxxxxxx
     month_fields: [{key, label, type, visible, wide, options?, hint?, builtin?}], // значення лежать у reviews.data[key]
     pos_fields:   [{key, visible}]                                               // key = ключ поля журналу, що питається в картці угоди
   } */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { ApiError } = JL;
  const LIM = { METRICS: 40, CUSTOM: 20, MONTH_FIELDS: 30, POS_FIELDS: 30, LABEL: 60, HINT: 200, OPTIONS: 30 };

  const BLOCKS = [
    ["summary", "Підсумок місяця (статистика)"],
    ["mistakes", "Ключові помилки місяця"],
    ["positions", "Розбір угод"],
    ["conclusion", "Висновок місяця"],
  ];
  const BLOCK_IDS = BLOCKS.map((b) => b[0]);

  // fmt: number | percent | money | r. sign: підсвічувати зелений/червоний за знаком. {cur} у назві = валюта журналу
  const METRICS = [
    { id: "win_rate", label: "Winrate", fmt: "percent", dec: 1, on: true },
    { id: "pct", label: "Результат, %", fmt: "percent", dec: 2, sign: true, on: true },
    { id: "pnl", label: "Результат, {cur}", fmt: "money", dec: 2, sign: true, on: true },
    { id: "r", label: "Результат, R", fmt: "r", dec: 2, sign: true, on: true },
    { id: "trades", label: "Угод", fmt: "number", dec: 0, on: true },
    { id: "losses", label: "Збиткових", fmt: "number", dec: 0, on: true },
    { id: "wins", label: "Прибуткових угод", fmt: "number", dec: 0 },
    { id: "be", label: "Беззбиткових", fmt: "number", dec: 0 },
    { id: "profit_factor", label: "Профіт-фактор", fmt: "number", dec: 2 },
    { id: "payoff", label: "Співвідношення виграш/збиток", fmt: "number", dec: 2 },
    { id: "avg_r", label: "Середня угода, R", fmt: "r", dec: 2, sign: true },
    { id: "avg_pnl", label: "Середня угода, {cur}", fmt: "money", dec: 2, sign: true },
    { id: "avg_pct", label: "Середня угода, %", fmt: "percent", dec: 2, sign: true },
    { id: "avg_win", label: "Середній виграш, {cur}", fmt: "money", dec: 2, sign: true },
    { id: "avg_loss", label: "Середній збиток, {cur}", fmt: "money", dec: 2, sign: true },
    { id: "best", label: "Найкраща угода, {cur}", fmt: "money", dec: 2, sign: true },
    { id: "worst", label: "Найгірша угода, {cur}", fmt: "money", dec: 2, sign: true },
    { id: "best_r", label: "Найкраща угода, R", fmt: "r", dec: 2, sign: true },
    { id: "worst_r", label: "Найгірша угода, R", fmt: "r", dec: 2, sign: true },
    { id: "max_drawdown", label: "Макс. просадка, {cur}", fmt: "money", dec: 2 },
    { id: "max_drawdown_r", label: "Макс. просадка, R", fmt: "r", dec: 2 },
    { id: "max_drawdown_pct", label: "Макс. просадка, %", fmt: "percent", dec: 2 },
    { id: "win_streak", label: "Серія виграшів", fmt: "number", dec: 0 },
    { id: "loss_streak", label: "Серія збитків", fmt: "number", dec: 0 },
    { id: "avg_discipline", label: "Дотримання плану (з 5)", fmt: "number", dec: 1 },
    { id: "open_trades", label: "Відкриті записи", fmt: "number", dec: 0 },
  ];
  const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));
  const FORMATS = [["number", "Число"], ["percent", "Відсоток"], ["money", "Гроші (з валютою)"], ["r", "У R"]];

  const MONTH_FIELDS = [
    { key: "summary", label: "Загальний висновок місяця", hint: "Що показав цей місяць загалом: головні висновки, закономірності." },
    { key: "went_well", label: "Що вдалося", hint: "Що працювало й варто повторювати." },
    { key: "fix", label: "Що виправляти", hint: "Які помилки повторюються й що з ними робити." },
    { key: "plan", label: "План на наступний місяць", hint: "Правила й цілі, на яких ти зосередишся." },
  ];
  const MONTH_BUILTIN = new Map(MONTH_FIELDS.map((f) => [f.key, f]));
  const POS_DEFAULT = ["by_rules", "tp_after_stop", "re_enter", "re_enter_why", "mistakes", "conclusion"];
  const MONTH_TYPES = JL.FIELD_TYPES.filter((t) => t !== "media");

  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const bool = (v, d) => (typeof v === "boolean" ? v : d);

  // ---------------------------------------------------------------- значення за замовчуванням і нормалізація
  function defaults(fields) {
    const have = new Set((fields || []).map((f) => f.key));
    return {
      blocks: BLOCK_IDS.map((id) => ({ id, visible: true })),
      metrics: METRICS.map((m) => ({ id: m.id, visible: !!m.on })),
      month_fields: MONTH_FIELDS.map((f) => ({ key: f.key, label: f.label, type: "longtext", visible: true, wide: true, hint: f.hint, builtin: true })),
      pos_fields: POS_DEFAULT.filter((k) => have.has(k)).map((key) => ({ key, visible: true })),
    };
  }

  /** Повна робоча конфігурація: те, що збережено, доповнене відсутніми готовими елементами. Нічого не кидає. */
  function normalize(raw, fields) {
    const d = defaults(fields), c = isObj(raw) ? raw : {};
    const byKey = new Map((fields || []).map((f) => [f.key, f]));

    const blocks = [], seenB = new Set();
    for (const b of Array.isArray(c.blocks) ? c.blocks : []) if (isObj(b) && BLOCK_IDS.includes(b.id) && !seenB.has(b.id)) { seenB.add(b.id); blocks.push({ id: b.id, visible: bool(b.visible, true) }); }
    for (const b of d.blocks) if (!seenB.has(b.id)) blocks.push(b);

    const metrics = [], seenM = new Set();
    for (const m of Array.isArray(c.metrics) ? c.metrics : []) {
      if (!isObj(m) || typeof m.id !== "string" || seenM.has(m.id)) continue;
      const base = METRIC_BY_ID.get(m.id);
      if (base) {
        seenM.add(m.id);
        const o = { id: m.id, visible: bool(m.visible, !!base.on) };
        if (typeof m.label === "string" && m.label.trim()) o.label = m.label.trim().slice(0, LIM.LABEL);
        metrics.push(o);
      } else if (/^x_[0-9a-f]{8}$/.test(m.id) && typeof m.formula === "string") {
        seenM.add(m.id);
        metrics.push({ id: m.id, custom: true, visible: bool(m.visible, true), label: String(m.label || "Моя статистика").slice(0, LIM.LABEL), formula: m.formula,
          fmt: FORMATS.some((f) => f[0] === m.fmt) ? m.fmt : "number", dec: Number.isInteger(m.dec) && m.dec >= 0 && m.dec <= 4 ? m.dec : 2 });
      }
    }
    for (const m of d.metrics) if (!seenM.has(m.id)) metrics.push(m);

    const month = [], seenF = new Set();
    for (const f of Array.isArray(c.month_fields) ? c.month_fields : []) {
      if (!isObj(f) || typeof f.key !== "string" || seenF.has(f.key)) continue;
      const base = MONTH_BUILTIN.get(f.key);
      if (base) {
        seenF.add(f.key);
        month.push({ key: f.key, label: String(f.label || base.label).slice(0, LIM.LABEL), type: "longtext", visible: bool(f.visible, true), wide: bool(f.wide, true), hint: base.hint, builtin: true });
      } else if (/^m_[0-9a-f]{8}$/.test(f.key) && MONTH_TYPES.includes(f.type)) {
        seenF.add(f.key);
        const o = { key: f.key, label: String(f.label || "Нове поле").slice(0, LIM.LABEL), type: f.type, visible: bool(f.visible, true), wide: bool(f.wide, f.type === "longtext" || f.type === "multiselect") };
        if (f.type === "select" || f.type === "multiselect") o.options = Array.isArray(f.options) && f.options.length ? f.options.map(String).slice(0, LIM.OPTIONS) : ["Варіант 1", "Варіант 2"];
        if (typeof f.hint === "string" && f.hint) o.hint = f.hint.slice(0, LIM.HINT);
        month.push(o);
      }
    }
    for (const f of d.month_fields) if (!seenF.has(f.key)) month.push(f);

    const pos = [], seenP = new Set();
    const rawPos = Array.isArray(c.pos_fields) ? c.pos_fields : null;
    if (rawPos) {
      for (const p of rawPos) {
        if (!isObj(p) || typeof p.key !== "string" || seenP.has(p.key)) continue;
        const f = byKey.get(p.key);
        if (!f || f.type === "media") continue;                         // поле видалили з журналу або воно для файлів
        seenP.add(p.key); pos.push({ key: p.key, visible: bool(p.visible, true) });
      }
    } else pos.push(...d.pos_fields);
    return { blocks, metrics, month_fields: month, pos_fields: pos };
  }

  // ---------------------------------------------------------------- перевірка того, що надіслав інтерфейс
  const label = (v, what) => {
    const s = JL.cleanText(v == null ? "" : v, "review", LIM.LABEL, what);
    if (!s) throw new ApiError(`${what} не може бути порожньою.`, 422, "review");
    if ([...s].some((c) => c.codePointAt(0) < 32)) throw new ApiError(`${what} містить недозволені символи.`, 422, "review");
    return s;
  };

  /** Сувора перевірка + нормалізація. Кидає ApiError з поясненням. fields: поля журналу. */
  function clean(raw, fields) {
    if (!isObj(raw)) throw new ApiError("Налаштування розбору мають бути об'єктом.", 422, "review");
    const byLabel = new Map((fields || []).filter((f) => f.type !== "media").flatMap((f) => [[f.key, f], [f.label.trim().toLowerCase(), f]]));
    const hasField = (ref) => byLabel.has(ref) || byLabel.has(ref.trim().toLowerCase());
    const byKey = new Map((fields || []).map((f) => [f.key, f]));

    if (!Array.isArray(raw.blocks) || raw.blocks.some((b) => !isObj(b) || !BLOCK_IDS.includes(b.id))) throw new ApiError("Некоректний список блоків.", 422, "review");

    const metrics = Array.isArray(raw.metrics) ? raw.metrics : [];
    if (metrics.length > LIM.METRICS) throw new ApiError(`Статистик забагато: не більше ${LIM.METRICS}.`, 422, "review");
    if (metrics.filter((m) => isObj(m) && m.custom).length > LIM.CUSTOM) throw new ApiError(`Власних статистик не більше ${LIM.CUSTOM}.`, 422, "review");
    const outMetrics = [], seen = new Set();
    for (const m of metrics) {
      if (!isObj(m)) throw new ApiError("Некоректна статистика.", 422, "review");
      let id = m.id;
      if (m.custom) {
        const nm = label(m.label, "Назва статистики");
        if (typeof m.formula !== "string") throw new ApiError(`«${nm}»: потрібна формула.`, 422, "review");
        try { JL.formula.compile(m.formula, { hasField }); }
        catch (e) { if (e instanceof ApiError) throw new ApiError(`«${nm}»: ${e.message}`, 422, "review"); throw e; }
        if (!FORMATS.some((f) => f[0] === m.fmt)) throw new ApiError(`«${nm}»: невідомий формат.`, 422, "review");
        const dec = Number.isInteger(m.dec) ? m.dec : 2;
        if (dec < 0 || dec > 4) throw new ApiError(`«${nm}»: знаків після коми від 0 до 4.`, 422, "review");
        if (!id) id = "x_" + JL.randomHex(4);
        if (!/^x_[0-9a-f]{8}$/.test(id)) throw new ApiError("Некоректний ідентифікатор статистики.", 422, "review");
        if (seen.has(id)) throw new ApiError("Статистика повторюється.", 422, "review");
        seen.add(id);
        outMetrics.push({ id, custom: true, visible: !!m.visible, label: nm, formula: m.formula.trim(), fmt: m.fmt, dec });
      } else {
        if (!METRIC_BY_ID.has(id)) throw new ApiError("Невідома статистика.", 422, "review");
        if (seen.has(id)) throw new ApiError("Статистика повторюється.", 422, "review");
        seen.add(id);
        const o = { id, visible: !!m.visible };
        if (typeof m.label === "string" && m.label.trim()) o.label = label(m.label, "Назва статистики");
        outMetrics.push(o);
      }
    }

    const mf = Array.isArray(raw.month_fields) ? raw.month_fields : [];
    if (mf.length > LIM.MONTH_FIELDS) throw new ApiError(`Полів висновку не більше ${LIM.MONTH_FIELDS}.`, 422, "review");
    const outMonth = [], seenK = new Set();
    for (const f of mf) {
      if (!isObj(f)) throw new ApiError("Некоректне поле висновку.", 422, "review");
      let key = f.key;
      const nm = label(f.label, "Назва поля");
      const base = MONTH_BUILTIN.get(key);
      if (base) {
        if (seenK.has(key)) throw new ApiError("Поле повторюється.", 422, "review");
        seenK.add(key);
        outMonth.push({ key, label: nm, type: "longtext", visible: !!f.visible, wide: !!f.wide, hint: base.hint, builtin: true });
        continue;
      }
      if (!MONTH_TYPES.includes(f.type)) throw new ApiError(`«${nm}»: невідомий тип поля.`, 422, "review");
      if (!key) key = "m_" + JL.randomHex(4);
      if (!/^m_[0-9a-f]{8}$/.test(key)) throw new ApiError("Некоректний ідентифікатор поля.", 422, "review");
      if (seenK.has(key)) throw new ApiError("Поле повторюється.", 422, "review");
      seenK.add(key);
      const o = { key, label: nm, type: f.type, visible: !!f.visible, wide: !!f.wide };
      if (f.type === "select" || f.type === "multiselect") {
        const opts = Array.isArray(f.options) ? f.options : [];
        const cl = [], uq = new Set();
        for (let x of opts) { x = JL.cleanText(x == null ? "" : x, "review", JL.LIMITS.MAX_OPTION_LEN, "Варіант"); if (x && !uq.has(x.toLowerCase())) { uq.add(x.toLowerCase()); cl.push(x); } }
        if (!cl.length || cl.length > LIM.OPTIONS) throw new ApiError(`Для «${nm}» потрібно від 1 до ${LIM.OPTIONS} варіантів.`, 422, "review");
        o.options = cl;
      }
      if (f.hint) o.hint = JL.cleanText(f.hint, "review", LIM.HINT, "Підказка");
      outMonth.push(o);
    }

    const pf = Array.isArray(raw.pos_fields) ? raw.pos_fields : [];
    if (pf.length > LIM.POS_FIELDS) throw new ApiError(`Питань по угоді не більше ${LIM.POS_FIELDS}.`, 422, "review");
    const outPos = [], seenP = new Set();
    for (const p of pf) {
      if (!isObj(p) || !byKey.has(p.key)) throw new ApiError("Питання по угоді вказує на поле, якого немає в журналі.", 422, "review");
      if (byKey.get(p.key).type === "media") throw new ApiError("Файли показуються окремо: поле для файлів не додається в питання.", 422, "review");
      if (seenP.has(p.key)) throw new ApiError("Питання повторюється.", 422, "review");
      seenP.add(p.key);
      outPos.push({ key: p.key, visible: !!p.visible });
    }
    return normalize({ blocks: raw.blocks, metrics: outMetrics, month_fields: outMonth, pos_fields: outPos }, fields);
  }

  // ---------------------------------------------------------------- значення місяця (висновок)
  /** Перевірка значень полів висновку місяця за налаштуваннями. Невідомі ключі ігноруються. */
  function cleanMonthData(cfg, data) {
    if (!isObj(data)) throw new ApiError("Дані розбору мають бути об'єктом.", 422);
    const out = {};
    for (const f of cfg.month_fields) {
      const v = data[f.key];
      if (f.type === "longtext" || f.type === "text") { out[f.key] = JL.cleanText(v == null ? "" : v, f.key, f.type === "text" ? 200 : 5000, f.label); continue; }
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      const x = JL.cleanValue({ label: f.label, type: f.type, key: f.key }, f.key, v);
      if (x !== undefined) out[f.key] = x;
    }
    return out;
  }

  // ---------------------------------------------------------------- обчислення статистики
  function fieldLookup(fields) {
    const m = new Map();
    for (const f of fields || []) { if (f.type === "media") continue; m.set(f.key, f); m.set(f.label.trim().toLowerCase(), f); }
    return (ref) => m.get(ref) || m.get(String(ref).trim().toLowerCase()) || null;
  }

  /** Повертає функцію field(ref, kind, arg) для формул: підсумки по полю серед записів місяця (data записів). */
  function makeFieldAgg(fields, rows) {
    const find = fieldLookup(fields);
    return function (ref, kind, arg) {
      const f = find(ref);
      if (!f) throw new ApiError(`Невідоме поле [${ref}].`, 422, "formula");
      const raw = rows.map((d) => d[f.key]).filter((v) => !(v == null || v === "" || (Array.isArray(v) && !v.length)));
      if (kind === "count") return raw.length;
      if (kind === "countif") {
        const want = String(arg).trim().toLowerCase();
        const yes = ["так", "true", "1", "yes"].includes(want);
        return raw.filter((v) => (Array.isArray(v) ? v.some((x) => String(x).trim().toLowerCase() === want) : typeof v === "boolean" ? v === yes && (yes || ["ні", "false", "0", "no"].includes(want)) : String(v).trim().toLowerCase() === want)).length;
      }
      const nums = raw.map((v) => JL.stats.num(v)).filter((x) => x != null);
      if (!nums.length) return null;
      if (kind === "sum") return JL.pySum(nums);
      if (kind === "avg") return JL.pySum(nums) / nums.length;
      if (kind === "min") return Math.min(...nums);
      if (kind === "max") return Math.max(...nums);
      return null;
    };
  }

  /** Значення однієї статистики. Повертає {value: число|null} або {error: текст}. */
  function evalMetric(m, summary, fieldAgg, fields) {
    if (!m.custom) { const v = summary[m.id]; return { value: typeof v === "number" && Number.isFinite(v) ? v : null }; }
    try {
      const c = JL.formula.compile(m.formula, fields ? { hasField: (r) => !!fieldLookup(fields)(r) } : {});
      const vars = {};
      for (const [k] of JL.formula.VARS) vars[k] = summary[k];
      return { value: c.run({ vars, field: fieldAgg }) };
    } catch (e) { return { error: e && e.message ? e.message : "Помилка у формулі" }; }
  }

  /** Назва статистики з підстановкою валюти журналу. */
  function metricLabel(m, currency) {
    const base = METRIC_BY_ID.get(m.id);
    return String(m.label || (base && base.label) || m.id).replace("{cur}", currency || "");
  }
  function metricFmt(m) { const b = METRIC_BY_ID.get(m.id); return m.custom ? { fmt: m.fmt, dec: m.dec, sign: m.fmt === "money" || m.fmt === "r" } : { fmt: b.fmt, dec: b.dec, sign: !!b.sign }; }

  JL.reviewCfg = { BLOCKS, METRICS, FORMATS, MONTH_FIELDS, MONTH_TYPES, LIMITS: LIM, defaults, normalize, clean, cleanMonthData, makeFieldAgg, evalMetric, metricLabel, metricFmt, fieldLookup };
})(typeof window !== "undefined" ? window : globalThis);
