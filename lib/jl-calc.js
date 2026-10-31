/* Калькулятори: спільний список активів (з параметрами контракту) і розрахунок лота під заданий ризик. Лише чисті функції,
   без доступу до бази (роботу з базою роблять маршрути /calc/* у jl-api.js).

   Актив: {symbol, name, kind, contract_size, pip_size, quote_ccy, digits, min_lot, lot_step, max_lot, commission}
     contract_size  скільки одиниць базового активу в 1 лоті (EURUSD: 100000, золото: 100 унцій, крипта: 1 монета)
     pip_size       крок ціни, який вважаємо «пунктом» (EURUSD: 0,0001, золото: 0,1). Брокери тут розходяться, тому поле редагується
     quote_ccy      валюта, у якій виражена ціна (і прибуток або збиток)
     commission     комісія брокера за 1 лот (вхід + вихід) у валюті рахунку
   Стандартні активи (EURUSD, GBPUSD, XAUUSD) вбудовані. Зміна параметрів стандартного активу зберігається окремим записом
   поверх вбудованого, тому її можна скинути; власні активи лежать лише записами. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { ApiError } = JL;

  const KINDS = { forex: "Форекс", metal: "Метали", index: "Індекси", crypto: "Крипта", other: "Інше" };
  const LIM = { SYMBOL: 20, NAME: 40, MAX_ASSETS: 200, MAX_RATES: 20 };

  /** Шаблони для нового активу: підставляються у форму, далі все правиться вручну. */
  const PRESETS = [
    { id: "forex", label: "Форекс (пара з USD в котируванні)", kind: "forex", contract_size: 100000, pip_size: 0.0001, quote_ccy: "USD", digits: 5, min_lot: 0.01, lot_step: 0.01, max_lot: 100, commission: 0 },
    { id: "forex_jpy", label: "Форекс (пара з JPY)", kind: "forex", contract_size: 100000, pip_size: 0.01, quote_ccy: "JPY", digits: 3, min_lot: 0.01, lot_step: 0.01, max_lot: 100, commission: 0 },
    { id: "metal", label: "Метал (золото, срібло)", kind: "metal", contract_size: 100, pip_size: 0.1, quote_ccy: "USD", digits: 2, min_lot: 0.01, lot_step: 0.01, max_lot: 50, commission: 0 },
    { id: "index", label: "Індекс (CFD)", kind: "index", contract_size: 1, pip_size: 1, quote_ccy: "USD", digits: 1, min_lot: 0.1, lot_step: 0.1, max_lot: 100, commission: 0 },
    { id: "crypto", label: "Крипта (монета = 1 одиниця)", kind: "crypto", contract_size: 1, pip_size: 1, quote_ccy: "USDT", digits: 2, min_lot: 0.001, lot_step: 0.001, max_lot: 1000, commission: 0 },
  ];
  const pick = ({ kind, contract_size, pip_size, quote_ccy, digits, min_lot, lot_step, max_lot, commission }) => ({ kind, contract_size, pip_size, quote_ccy, digits, min_lot, lot_step, max_lot, commission });
  const byPreset = (id) => PRESETS.find((p) => p.id === id);

  const DEFAULT_ASSETS = [
    { symbol: "EURUSD", name: "Євро / долар", ...pick(byPreset("forex")) },
    { symbol: "GBPUSD", name: "Фунт / долар", ...pick(byPreset("forex")) },
    { symbol: "XAUUSD", name: "Золото", ...pick(byPreset("metal")) },
  ];
  const DEFAULT_PREFS = { acc_ccy: "USD", deposit: null, risk_mode: "pct", risk_pct: 1, risk_money: null, leverage: null, symbol: "EURUSD", rates: {} };

  /** Число зі «зручного» вводу: "1,5", "10 000", "−2". Порожнє дає undefined, сміття дає NaN. */
  function parseNum(v) {
    if (v == null) return undefined;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v !== "string") return NaN;
    const s = v.replace(/[\s ]/g, "").replace("−", "-");
    if (!s) return undefined;
    if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) return NaN;
    return Number(s.replace(",", "."));
  }
  /** Кредитне плече: «100» або «1:100». */
  const parseLev = (v) => parseNum(typeof v === "string" ? v.replace(/^\s*1\s*[:/]\s*/, "") : v);
  const round = (x, nd) => { const k = 10 ** nd; return Math.round((x + Number.EPSILON * Math.sign(x)) * k) / k; };

  /** Символ активу: великі літери, цифри, . _ -. «EUR/USD» і пробіли дають «EURUSD» (символ іде в ключ запису в хмарі). */
  function normSymbol(v) {
    const s = String(v == null ? "" : v).trim().toUpperCase().replace(/[\s/]+/g, "");
    if (!s) throw new ApiError("Вкажи символ активу, наприклад EURUSD.", 422, "symbol");
    if (s.length > LIM.SYMBOL) throw new ApiError(`Символ задовгий: не більше ${LIM.SYMBOL} знаків.`, 422, "symbol");
    if (!/^[A-Z0-9._-]+$/.test(s) || !/[A-Z0-9]/.test(s)) throw new ApiError("Символ: латинські літери й цифри (можна . _ -), наприклад EURUSD або BTCUSDT.", 422, "symbol");
    return s;
  }
  const normCcy = (v, field, label) => {
    const s = String(v == null ? "" : v).trim().toUpperCase();
    if (!/^[A-Z]{2,8}$/.test(s)) throw new ApiError(`${label}: код з 2–8 латинських літер, наприклад USD, EUR або USDT.`, 422, field);
    return s;
  };
  const USD_LIKE = new Set(["USD", "USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI"]);
  /** Чи це одна й та сама валюта для розрахунку (долар і стейблкоїни вважаємо однаковими). */
  const sameCcy = (a, b) => a === b || (USD_LIKE.has(a) && USD_LIKE.has(b));

  function posNum(v, field, label, { max = 1e9, min = 0, allowZero = false } = {}) {
    const n = parseNum(v);
    if (n === undefined) throw new ApiError(`Вкажи: ${label}.`, 422, field);
    if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0) || n > max || n < min) throw new ApiError(`${label}: число ${allowZero ? "від 0" : "більше 0"} до ${max}.`, 422, field);
    return round(n, 8);
  }

  function cleanAsset(b, symbol) {
    b = b || {};
    const sym = normSymbol(symbol != null ? symbol : b.symbol);
    const name = b.name == null ? "" : JL.cleanText(b.name, "name", LIM.NAME, "Назва").trim();
    const kind = b.kind == null || b.kind === "" ? "other" : String(b.kind);
    if (!KINDS[kind]) throw new ApiError("Тип активу: форекс, метали, індекси, крипта або інше.", 422, "kind");
    const contract_size = posNum(b.contract_size, "contract_size", "розмір контракту (одиниць у 1 лоті)");
    const pip_size = posNum(b.pip_size, "pip_size", "розмір пункту", { max: 1e6 });
    if (pip_size < 1e-8) throw new ApiError("Розмір пункту завеликий за точністю: від 0,00000001.", 422, "pip_size");
    const quote_ccy = normCcy(b.quote_ccy, "quote_ccy", "Валюта котирування");
    const dg = parseNum(b.digits);
    if (dg === undefined || !Number.isInteger(dg) || dg < 0 || dg > 8) throw new ApiError("Знаків після коми в ціні: ціле число від 0 до 8.", 422, "digits");
    const min_lot = posNum(b.min_lot, "min_lot", "мінімальний лот", { max: 1e6 });
    const lot_step = posNum(b.lot_step, "lot_step", "крок лота", { max: 1e6 });
    const max_lot = posNum(b.max_lot, "max_lot", "максимальний лот");
    if (max_lot < min_lot) throw new ApiError("Максимальний лот не може бути меншим за мінімальний.", 422, "max_lot");
    const cm = parseNum(b.commission);
    const commission = cm === undefined ? 0 : posNum(cm, "commission", "комісія за лот", { max: 1e6, allowZero: true });
    return { symbol: sym, name, kind, contract_size, pip_size, quote_ccy, digits: dg, min_lot, lot_step, max_lot, commission, hidden: !!b.hidden };
  }

  function cleanPrefs(b) {
    b = { ...DEFAULT_PREFS, ...(b || {}) };
    const num = (v, field, label, max, min = 0) => {
      const n = parseNum(v);
      if (n === undefined) return null;
      if (!Number.isFinite(n) || n <= min || n > max) throw new ApiError(`${label}: число більше ${min} до ${max}.`, 422, field);
      return round(n, 8);
    };
    const risk_mode = b.risk_mode === "money" ? "money" : "pct";
    const rates = {};
    const entries = Object.entries(b.rates && typeof b.rates === "object" ? b.rates : {});
    if (entries.length > LIM.MAX_RATES) throw new ApiError(`Курсів забагато: не більше ${LIM.MAX_RATES}.`, 422, "rates");
    for (const [k, v] of entries) { const n = num(v, "rates", `Курс ${k}`, 1e12); if (n != null) rates[normCcy(k, "rates", "Валюта курсу")] = n; }
    const lv = parseLev(b.leverage);
    let leverage = lv === undefined ? null : num(lv, "leverage", "Кредитне плече", 10000, 0);
    if (leverage != null && leverage < 1) throw new ApiError("Кредитне плече не може бути меншим за 1.", 422, "leverage");
    return { acc_ccy: normCcy(b.acc_ccy, "acc_ccy", "Валюта рахунку"), deposit: num(b.deposit, "deposit", "Депозит", 1e12), risk_mode,
      risk_pct: num(b.risk_pct, "risk_pct", "Ризик, %", 100), risk_money: num(b.risk_money, "risk_money", "Ризик, сума", 1e12), leverage,
      symbol: b.symbol ? normSymbol(b.symbol) : "", rates };
  }

  /** Список активів: вбудовані з накладеними змінами плюс власні. rows: записи з бази {key:"asset|SYM", ...}. */
  function mergeAssets(rows, all) {
    const over = new Map();
    for (const r of rows) if (r && typeof r.key === "string" && r.key.startsWith("asset|") && typeof r.symbol === "string") over.set(r.symbol, r);
    const strip = (r) => { const { key, _u, ...rest } = r; return rest; };
    const out = [];
    for (const d of DEFAULT_ASSETS) {
      const o = over.get(d.symbol); over.delete(d.symbol);
      out.push(o ? { ...d, ...strip(o), builtin: true, modified: true } : { ...d, hidden: false, builtin: true, modified: false });
    }
    for (const o of [...over.values()].sort((a, b) => JL.cmp(a.symbol, b.symbol))) out.push({ ...strip(o), builtin: false, modified: false });
    return all ? out : out.filter((a) => !a.hidden);
  }

  // ---------------------------------------------------------------- розрахунок лота
  const stepDecimals = (step) => { const s = String(step); const e = /e-(\d+)/.exec(s); if (e) return +e[1]; const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; };
  const floorToStep = (x, step) => Number((Math.floor(x / step + 1e-9) * step).toFixed(stepDecimals(step)));

  const RISK_PRESETS = [0.25, 0.5, 1, 2];

  /** Розраховує лот. inp: {deposit, risk_mode: pct|money, risk, direction: long|short, entry, stop_mode: price|pips, stop,
      tp_mode: none|price|rr|pips, tp, acc_ccy, rate, leverage}. Значення можуть бути рядками (як у полях вводу).
      Повертає {ok, missing, errors, warnings, result}. missing: ще не заповнені поля; errors: поля з неприпустимим значенням. */
  function sizeLots(inp, asset) {
    inp = inp || {};
    const missing = [], errors = {}, warnings = [];
    const need = (f, v, label) => { if (v === undefined) missing.push(f); else if (!Number.isFinite(v)) errors[f] = `${label}: потрібне число.`; return v; };
    const pos = (f, v, label) => { if (Number.isFinite(v) && v <= 0) errors[f] = `${label}: число більше нуля.`; };
    const accCcy = String(inp.acc_ccy || "USD").trim().toUpperCase();
    const long = inp.direction !== "short";
    const riskMoneyMode = inp.risk_mode === "money";
    const stopPips = inp.stop_mode === "pips";
    const tpMode = ["price", "rr", "pips"].includes(inp.tp_mode) ? inp.tp_mode : "none";

    const deposit = parseNum(inp.deposit), risk = parseNum(inp.risk), entry = parseNum(inp.entry), stop = parseNum(inp.stop);
    let tp = tpMode === "none" ? undefined : parseNum(inp.tp);
    const leverage = parseLev(inp.leverage);
    if (!riskMoneyMode) need("deposit", deposit, "Депозит"); else if (deposit !== undefined && !Number.isFinite(deposit)) errors.deposit = "Депозит: потрібне число.";
    pos("deposit", deposit, "Депозит");
    need("risk", risk, riskMoneyMode ? "Ризик у грошах" : "Ризик у відсотках"); pos("risk", risk, "Ризик");
    if (!riskMoneyMode && Number.isFinite(risk) && risk > 100) errors.risk = "Ризик у відсотках: не більше 100.";
    need("stop", stop, stopPips ? "Стоп у пунктах" : "Ціна стопу"); pos("stop", stop, "Стоп");
    if (!stopPips) need("entry", entry, "Ціна входу"); else if (entry !== undefined && !Number.isFinite(entry)) errors.entry = "Ціна входу: потрібне число.";
    pos("entry", entry, "Ціна входу");
    if (tpMode !== "none") { need("tp", tp, tpMode === "price" ? "Ціна тейку" : tpMode === "rr" ? "R:R" : "Тейк у пунктах"); pos("tp", tp, "Тейк"); if (tpMode === "price") need("entry", entry, "Ціна входу"); }
    if (leverage !== undefined && (!Number.isFinite(leverage) || leverage < 1 || leverage > 10000)) errors.leverage = "Кредитне плече: число від 1 до 10000.";
    let rate = 1;
    if (!sameCcy(asset.quote_ccy, accCcy)) {
      rate = parseNum(inp.rate);
      need("rate", rate, `Курс ${asset.quote_ccy} до ${accCcy}`); pos("rate", rate, "Курс");
    }
    if (Number.isFinite(entry) && Number.isFinite(stop) && !stopPips && !errors.entry && !errors.stop) {
      if (long && stop >= entry) errors.stop = "Для лонга стоп має бути нижче входу.";
      if (!long && stop <= entry) errors.stop = "Для шорта стоп має бути вище входу.";
    }
    if (tpMode === "price" && Number.isFinite(entry) && Number.isFinite(tp) && !errors.tp) {
      if (long && tp <= entry) errors.tp = "Для лонга тейк має бути вище входу.";
      if (!long && tp >= entry) errors.tp = "Для шорта тейк має бути нижче входу.";
    }
    const uniqMissing = [...new Set(missing)].filter((f) => !errors[f]);
    if (uniqMissing.length || Object.keys(errors).length) return { ok: false, missing: uniqMissing, errors, warnings, result: null };

    const dist = round(stopPips ? stop * asset.pip_size : Math.abs(entry - stop), 10);       // без хвостів на кшталт 0,0020000000000000018
    const lossPerLot = dist * asset.contract_size * rate + asset.commission;
    const riskMoney = riskMoneyMode ? risk : (deposit * risk) / 100;
    const lotsFor = (money) => {
      const raw = money / lossPerLot;
      let lots = floorToStep(raw, asset.lot_step);
      if (lots + 1e-12 < asset.min_lot) lots = 0;
      return { raw, lots: Math.min(lots, asset.max_lot), capped: lots > asset.max_lot };
    };
    const main = lotsFor(riskMoney);
    const lots = main.lots;
    const out = { lots, lots_raw: main.raw, risk_money_target: riskMoney, dist, stop_pips: dist / asset.pip_size,
      pip_value: asset.pip_size * asset.contract_size * rate, loss_per_lot: lossPerLot, direction: long ? "long" : "short", acc_ccy: accCcy, rate,
      stop_price: Number.isFinite(entry) ? (long ? entry - dist : entry + dist) : null };
    out.below_min = main.lots === 0;
    out.min_lot_risk = asset.min_lot * lossPerLot;
    out.min_lot_risk_pct = deposit > 0 ? (out.min_lot_risk / deposit) * 100 : null;
    out.risk_money = lots * lossPerLot;
    out.risk_pct = deposit > 0 ? (out.risk_money / deposit) * 100 : null;
    out.units = lots * asset.contract_size;
    out.notional = Number.isFinite(entry) ? out.units * entry : null;
    out.margin = Number.isFinite(entry) && Number.isFinite(leverage) ? (out.notional * rate) / leverage : null;
    out.commission_total = lots * asset.commission;
    if (out.below_min) warnings.push(`Мінімальний лот ${asset.min_lot} вже дає ризик ${round(out.min_lot_risk, 2)} ${accCcy}${out.min_lot_risk_pct != null ? ` (${round(out.min_lot_risk_pct, 2)}% депозиту)` : ""}, це більше за заданий. Зменш стоп або збільш ризик.`);
    if (main.capped) warnings.push(`Лот обмежено максимумом ${asset.max_lot} для цього активу.`);
    if (out.margin != null && deposit > 0 && out.margin > deposit && lots > 0) warnings.push(`Не вистачає маржі: потрібно ${round(out.margin, 2)} ${accCcy}, на рахунку ${round(deposit, 2)}.`);
    else if (out.margin != null && deposit > 0 && out.margin > deposit * 0.5 && lots > 0) warnings.push(`Позиція займе ${round((out.margin / deposit) * 100, 0)}% депозиту як маржа.`);
    if (!riskMoneyMode && risk > 5) warnings.push("Ризик понад 5% на угоду це дуже багато.");
    // тейк-профіт
    let tpDist = null;
    if (tpMode === "rr") tpDist = tp * dist; else if (tpMode === "pips") tpDist = tp * asset.pip_size; else if (tpMode === "price") tpDist = round(Math.abs(tp - entry), 10);
    if (tpDist != null) {
      out.tp_dist = tpDist; out.tp_pips = tpDist / asset.pip_size; out.rr = tpDist / dist;
      out.tp_price = Number.isFinite(entry) ? (long ? entry + tpDist : entry - tpDist) : null;
      out.profit_money = lots * (tpDist * asset.contract_size * rate - asset.commission);
      out.profit_pct = deposit > 0 ? (out.profit_money / deposit) * 100 : null;
      out.breakeven_winrate = (1 / (1 + out.rr)) * 100;
    }
    // лот при інших відсотках ризику (потрібен депозит)
    out.alternatives = deposit > 0 ? RISK_PRESETS.map((p) => { const a = lotsFor((deposit * p) / 100); return { pct: p, lots: a.lots, risk_money: a.lots * lossPerLot, risk_pct: deposit > 0 ? ((a.lots * lossPerLot) / deposit) * 100 : null }; }) : [];
    return { ok: true, missing: [], errors: {}, warnings, result: out };
  }

  JL.calc = { KINDS, LIM, PRESETS, DEFAULT_ASSETS, DEFAULT_PREFS, RISK_PRESETS, parseNum, normSymbol, sameCcy, cleanAsset, cleanPrefs, mergeAssets, sizeLots, floorToStep, stepDecimals };
})(typeof window !== "undefined" ? window : globalThis);
