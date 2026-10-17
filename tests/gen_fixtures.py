"""Генерує tests/fixtures/parity.json.gz: вхідні дані й ЕТАЛОННІ відповіді, пораховані серверним кодом сайту «Розбір ринку» (Python).
Далі tests/parity.test.js проганяє ті самі входи через JavaScript-код цього застосунку й вимагає точного збігу.

Запуск (потрібен код сайту):  python3 tests/gen_fixtures.py /шлях/до/ai-trading/backend
Файл fixtures/parity.json.gz уже згенеровано й лежить у репозиторії: заново запускати потрібно лише якщо змінюється логіка на сайті."""
import base64, gzip, json, random, sys
from pathlib import Path

backend = Path(sys.argv[1] if len(sys.argv) > 1 else "../backend").resolve()
sys.path.insert(0, str(backend))
from app import journal, journal_import as ji, journal_stats as js   # noqa: E402
from app.accounts import AccountError                                  # noqa: E402
from app import news as nw                                             # noqa: E402
from app.news.glossary import describe                                 # noqa: E402
from app.service import AnalysisService                                # noqa: E402
from types import SimpleNamespace                                      # noqa: E402
from datetime import datetime, timezone                                # noqa: E402

rnd = random.Random(20260615)
OUT = {}


def capture(fn, *a, **kw):
    try:
        return {"ok": fn(*a, **kw)}
    except AccountError as e:
        return {"error": e.message, "status": e.status, "field": e.field}


def norm_keys(x):
    """Власні поля мають випадкові ключі c_xxxxxxxx: замінюємо їх на c_N за порядком появи."""
    seen = {}
    def walk(v):
        if isinstance(v, dict):
            return {walk_key(k): walk(val) for k, val in v.items()}
        if isinstance(v, list):
            return [walk(i) for i in v]
        if isinstance(v, str) and v.startswith("c_") and len(v) == 10:
            return walk_key(v)
        return v
    def walk_key(k):
        if isinstance(k, str) and k.startswith("c_") and len(k) == 10:
            seen.setdefault(k, f"c_{len(seen)}")
            return seen[k]
        return k
    return walk(x)


# ------------------------------------------------------------------ поля за замовчуванням
OUT["default_fields"] = {m: journal.default_fields(m) for m in ("crypto", "forex")}
F = {m: journal.default_fields(m) for m in ("crypto", "forex")}

# ------------------------------------------------------------------ clean_entry
def rand_val(f):
    t, r = f["type"], rnd.random()
    if r < 0.12: return rnd.choice([None, "", [], "  ", "x" * 300, 12, True, 3.5, {"a": 1}, ["a"]])
    if t == "text": return rnd.choice(["BTCUSDT", "  eth/usdt ", "Ґанок 🚀", "я" * 200, "я" * 201, "😀" * 200, "😀" * 201, "a\nb"])
    if t == "longtext": return rnd.choice(["Нотатка", " довга\n" * 100, "x" * 5000, "x" * 5001, "😀" * 5000, "😀" * 5001])
    if t in ("number", "percent"): return rnd.choice([1, 2.5, "3,5", " 4 000 ", "-7.25", "abc", "1e3", "1e13", -1e12, 1e12, 0, 123456789012345678, True, "inf", "nan", "٣", "1_0", "0x10", "1e400", 7.0, 1e15, 12345678901234.0])
    if t == "date": return rnd.choice(["2026-02-30", "2026-03-01", "2026-3-1", "20260301", "2026-03-01T10:00", 5, "0000-01-01", "9999-12-31"])
    if t == "datetime": return rnd.choice(["2026-03-01T10:20", "2026-03-01T10:20:33", "2026-03-01 10:20", "2026-13-01T10:20", "2026-03-01T25:20", "2026-03-01T10:20:33Z", "2026-03-01T10:2", 5, "2026-03-01T10:20:61"])
    if t == "select":
        opts = f.get("options") or ["Так", "Ні"]
        return rnd.choice(opts + ["Інше значення", " " + opts[0] + " ", "x" * 41, 5])
    if t == "multiselect":
        opts = f.get("options") or ["a"]
        return rnd.choice([[rnd.choice(opts), rnd.choice(opts)], [opts[0]] * 3, "рядок", ["x" * 41], [1], ["", opts[0]], [opts[0]] * 31, [" a ", "a"]])
    if t == "checkbox": return rnd.choice([True, False, "так", 1])
    if t == "rating": return rnd.choice([1, 3, 5, 0, 6, 2.5, True, "4"])
    if t == "link": return rnd.choice(["https://example.com/a?b=1", "http://x.y", "ftp://x.y", "javascript:alert(1)", "https://a b", "https://x\"y", "  https://ok.io  "])
    return "?"

cases = []
for m in ("crypto", "forex"):
    for _ in range(700):
        data = {}
        for f in rnd.sample(F[m], rnd.randint(1, len(F[m]))):
            if f["type"] == "media" and rnd.random() < .7: continue
            data[f["key"]] = rand_val(f)
        if rnd.random() < .85: data["opened_at"] = rnd.choice(["2026-01-05T09:30", "2025-12-31T23:59", "2026-06-15T00:00:44"])
        if rnd.random() < .04: data["неіснуюче"] = 1
        cases.append({"market": m, "data": data, "result": capture(journal.clean_entry, F[m], data)})
cases += [{"market": "crypto", "data": d, "result": capture(journal.clean_entry, F["crypto"], d)} for d in (None, [], "x", 5, {}, {"opened_at": "2026-01-01T10:00"},
          {"opened_at": "2026-01-01T10:00", "notes": "x" * 5000, "conclusion": "y" * 5000, "re_enter_why": "z" * 5000, "setup": "й" * 200})]
OUT["clean_entry"] = cases

# ------------------------------------------------------------------ clean_fields
def fcase(market, new):
    return {"market": market, "new": new, "result": norm_keys(capture(journal.clean_fields, new, F[market]))}

def base(m): return [dict(key=f["key"], label=f["label"], type=f["type"], hidden=f.get("hidden", False), table=f.get("table", False), options=f.get("options")) for f in F[m]]

fc = []
for m in ("crypto", "forex"):
    b = base(m)
    fc.append(fcase(m, b))
    r = list(reversed(b)); fc.append(fcase(m, r))
    h = [dict(x, hidden=True) for x in b]; fc.append(fcase(m, h))
    fc.append(fcase(m, b + [{"label": "Мій індикатор", "type": "number", "table": True}]))
    fc.append(fcase(m, b + [{"label": "Теги", "type": "multiselect", "options": ["a", "A", "b", " b ", "", "c"], "help": "підказка"}]))
    fc.append(fcase(m, b + [{"label": "Вибір", "type": "select"}]))
    fc.append(fcase(m, b + [{"label": "Вибір", "type": "select", "options": ["x"] * 3}]))
    fc.append(fcase(m, b + [{"label": "Вибір", "type": "select", "options": [str(i) for i in range(31)]}]))
    fc.append(fcase(m, b + [{"label": "", "type": "text"}]))
    fc.append(fcase(m, b + [{"label": "я" * 61, "type": "text"}]))
    fc.append(fcase(m, b + [{"label": "ab\x01", "type": "text"}]))
    fc.append(fcase(m, b + [{"label": "Лонг", "type": "dropdown"}]))
    fc.append(fcase(m, b + [{"key": "nope", "label": "x", "type": "text"}]))
    fc.append(fcase(m, b + [b[0]]))
    fc.append(fcase(m, b[1:]))
    fc.append(fcase(m, [dict(x, type="text") if x["key"] == "pnl" else x for x in b]))
    fc.append(fcase(m, [dict(x, options=["Інше"]) if x["key"] == "direction" else x for x in b]))
    fc.append(fcase(m, b + [{"label": "Файли2", "type": "media"}]))
    fc.append(fcase(m, b + [{"label": "Файли2", "type": "media"}, {"label": "Файли3", "type": "media"}, {"label": "Файли4", "type": "media"}]))
    fc.append(fcase(m, b + [{"label": f"П{i}", "type": "text"} for i in range(40)]))
    fc.append(fcase(m, b + [{"label": f"П{i}", "type": "text"} for i in range(31)]))
    fc.append(fcase(m, [dict(x, hidden=True) if x["key"] == "opened_at" else x for x in b]))
    fc.append(fcase(m, [dict(x, label="  Нова назва  ") if x["key"] == "symbol" else x for x in b]))
    fc.append(fcase(m, b + [{"label": "Т", "type": "text", "help": "я" * 201}]))
    fc.append(fcase(m, b + [{"label": "Т", "type": "text", "help": "я" * 200}]))
for bad in (None, [], "x", {}, [1], [None]):
    fc.append(fcase("crypto", bad))
OUT["clean_fields"] = fc

# ------------------------------------------------------------------ статистика
SYMS = ["BTCUSDT", "ethusdt", " SOLUSDT", "EUR/USD", "xauusd", "", "Ґанок"]
SETUPS = ["Пробій", "пробій", "Відкат", "  Відкат  ", "Рівень", "", "Тренд  вниз"]
EMO = ["Спокій", "Страх", "Жадібність", "Азарт", "Втома"]
MIS = ["Зайшов раніше", "Без стопу", "Збільшив ризик", "Пересидів"]
OUTC = ["Тейк-профіт", "Стоп-лос", "Беззбиток", "Закрито вручну", "Відкрита", None]

def money(): return rnd.choice([round(rnd.uniform(-300, 400), 2), round(rnd.uniform(-5, 5), 6), rnd.randint(-100, 100), 0, 0.0, None, "12.5", "abc", "", True, " 7 ", "1,5", "0x10", "1_0", "inf", "٣", "1e3"])

def day(i):
    y = rnd.choice([2024, 2025, 2025, 2026]); m = rnd.randint(1, 12); d = rnd.randint(1, 28)
    return f"{y}-{m:02d}-{d:02d}", f"{rnd.randint(0, 23):02d}:{rnd.randint(0, 59):02d}"

def entry(i):
    dd, tt = day(i)
    d = {"opened_at": f"{dd}T{tt}"}
    if rnd.random() < .75:
        d2, t2 = day(i); d["closed_at"] = f"{d2}T{t2}" if rnd.random() < .8 else f"{dd}T23:59"
    if rnd.random() < .05: d["opened_at"] = rnd.choice(["", "2026-02-30T10:00", "bad", "2026-01"])
    d["symbol"] = rnd.choice(SYMS); d["direction"] = rnd.choice(["Лонг", "Шорт", "лонг", "ШОРТ", "", None, "long"])
    d["outcome"] = rnd.choice(OUTC)
    for k in ("pnl", "pct", "r", "entry", "stop", "exit"):
        if rnd.random() < .7: d[k] = money() if k in ("pnl", "pct", "r") else rnd.choice([round(rnd.uniform(90, 110), 2), 100, "100.5", None, 0])
    if rnd.random() < .5: d["entry"], d["stop"], d["exit"] = 100, rnd.choice([95, 105, 100, 99.5]), rnd.choice([110, 90, 100, 103.3333])
    d["setup"] = rnd.choice(SETUPS); d["discipline"] = rnd.choice([1, 2, 3, 4, 5, None, "4", True])
    d["emo_before"] = rnd.sample(EMO, rnd.randint(0, 3)); d["emo_after"] = rnd.sample(EMO, rnd.randint(0, 2))
    if rnd.random() < .2: d["emotions"] = rnd.sample(EMO, 2); del d["emo_before"]
    d["mistakes"] = rnd.sample(MIS, rnd.randint(0, 2)); d["by_rules"] = rnd.choice(["Так", "Ні", "", None])
    if rnd.random() < .05: d["mistakes"] = "Один рядок"
    return d

def stats_case(n, seed_ids=True):
    rows = [[rnd.randint(1, 10**6) if seed_ids else i, entry(i)] for i in range(n)]
    seen = set(); out = []
    for rid, d in rows:
        while rid in seen: rid += 1
        seen.add(rid); out.append([rid, d])
    return out

st, datasets = [], []
for n, ranges in ((0, [(None, None)]), (1, [(None, None)]), (6, [(None, None)]), (120, [(None, None), ("2025-03-01", "2025-09-30"), ("2026-01-01", None), (None, "2024-12-31"), ("bad", None)]), (400, [(None, None), ("2025-01-01", "2025-12-31")])):
    entries = stats_case(n)
    datasets.append(entries)
    for g in ("day", "week", "month", "quarter", "year"):
        for a, b in ranges:
            st.append({"set": len(datasets) - 1, "group": g, "start": a, "end": b, "result": capture(js.compute, [(i, d) for i, d in entries], g, a, b)})
OUT["stats_sets"] = datasets
OUT["stats"] = st

# ------------------------------------------------------------------ імпорт: числа, дати, таймфрейми
NUMS = ["", "  ", "1", "-1", "+5", "1,5", "1.5", "1,234", "1,234.56", "1.234,56", "12,345,678", "(100)", "(1 000,5)", "−3,2", "–3", "$100", "100$", "€ 1 200", "12.5%", "50 USDT", "30usdt", "5 usd", "7 UAH", "100р", "100r", "1:3", "1/2.5", " 1 : 2 ", "1e5", "1e13", "abc", "--5", "5-", "1-1", "∞", "inf", "nan", "0", "-0", "0,0001", "٣", "1_0", "0x1f", ".5", "5.", "1.2.3", "1,2,3", "12 345,67", "12 345,67", "+", "-", "%", "$", "1 000 000 000 000", "999999999999.9", "1000000000001"]
OUT["parse_number"] = [{"v": v, "ratio": r, "result": ji.parse_number(v, ratio=r)} for v in NUMS for r in (False, True)]

DATES = ["", "2026-01-05", "2026-01-05 14:30", "2026-01-05T14:30:59", "05.01.2026", "5.1.2026 9:05", "05/01/2026", "01/05/2026", "13/01/2026", "01/13/2026", "5/1/26", "05.01.26", "2026/01/05", "January 5, 2026 2:30 PM", "January 5, 2026 12:00 AM", "January 5, 2026 12:30 PM", "Jan 5, 2026", "5 січня 2026 р.", "5 січня 2026 14:30", "5 Січня 2026", "05 лист 2026", "May 15, 2026 (GMT+2)", "2026-01-05 14:30 UTC", "2026-01-05 → 2026-01-07", "January 5, 2026 → January 7, 2026", "5 січня 2026 → 7 січня 2026", "2026-02-30", "32.01.2026", "00.01.2026", "13.13.2026", "abc", "2026", "2026-01", "14:30", "5 січня", "2026-1-5", "20260105", "05-01-2026", "5-1-2026 7:5", "2026-01-05 25:61", "1/2/2026 3:04 am", "1/2/2026 3:04 PM", "12/31/2026 11:59 PM", "31/12/2026 23:59", "Dec 31, 2026 11:59 PM", "2026-12-31T23:59:59Z", "5 February 2026", "February 5 2026 09:15", "9 березня 2025", "9 бер 2025", "9 берез. 2025", "9 березня 2025р.", "9 березня 2025 р", "1.1.1", "1.1.0001", "9999-12-31", "10000-01-01"]
OUT["parse_datetime"] = [{"v": v, "day_first": df,
    "result": (lambda p: None if p is None else [p[0].isoformat(), p[1]])(ji.parse_datetime(v, df))} for v in DATES for df in (True, False)]

TFS = ["M5", "m15", "H1", "h4", "D1", "1d", "W1", "1w", "15 min", "15min", "15m", "1h", "4hr", "2 h", "1D", "M 5", "5", "abc", "", " H1 ", "H01", "m005", "10w", "1мін", "15 хв"]
OUT["norm_tf"] = [{"v": v, "result": ji.norm_tf(v)} for v in TFS]

# ------------------------------------------------------------------ CSV
def b64(b): return base64.b64encode(b).decode()
csv_texts = {
    "comma": 'Назва,Дата,Результат\n"BTC, long",05.01.2026,"1,5"\nETH,06.01.2026,2\n',
    "semi": "Pair;Date;PnL\nBTCUSDT;2026-01-05;12,5\nETHUSDT;2026-01-06;-3\n",
    "tab": "Pair\tDate\tPnL\nBTCUSDT\t2026-01-05\t12.5\n",
    "pipe": "a|b|c\n1|2|3\n",
    "quotes": 'a,b\n"he said ""hi""","line1\nline2"\n"x",y\n',
    "crlf": "a,b\r\n1,2\r\n3,4\r\n",
    "cr": "a,b\r1,2\r3,4\r",
    "trailing": "a,b\n1,2\n\n\n",
    "blank_rows": "a,b\n1,2\n,\n \n3,4\n",
    "ragged": "a,b,c\n1,2\n1,2,3,4\n",
    "dup_headers": "a,a,b,\n1,2,3,4\n",
    "empty_header": "a,,c\n1,2,3\n",
    "space_headers": " a , b \n 1 , 2 \n",
    "one_col": "a\n1\n2\n",
    "only_header": "a,b\n",
    "unicode": "Символ,Нотатка\nBTC,Ґанок 🚀 «тест»\n",
    "bom": "﻿a,b\n1,2\n",
    "formula": "a,b\n=1+1,@x\n",
}
csv_cases = []
for name, text in csv_texts.items():
    csv_cases.append({"name": name, "enc": "utf-8", "bytes": b64(text.encode("utf-8")), "result": None})
variants = [("utf-8-bom", "﻿" + csv_texts["semi"], "utf-8"), ("utf-16", csv_texts["comma"], "utf-16"), ("utf-16le-bom", csv_texts["semi"], "utf-16"),
            ("cp1251", "Пара;Дата;Результат\nБТК;05.01.2026;12,5\nЕТН;06.01.2026;-3\n", "cp1251")]
for name, text, enc in variants:
    raw = text.encode(enc)
    csv_cases.append({"name": name, "enc": enc, "bytes": b64(raw), "result": None})
csv_cases.append({"name": "empty", "enc": "utf-8", "bytes": b64(b""), "result": None})
csv_cases.append({"name": "garbage", "enc": "bin", "bytes": b64(bytes(range(256))), "result": None})
for c in csv_cases:
    raw = base64.b64decode(c["bytes"])
    c["result"] = capture(lambda: (lambda hr: {"headers": hr[0], "rows": hr[1]})(ji.parse_csv(raw)))
OUT["parse_csv"] = csv_cases

# ------------------------------------------------------------------ зіставлення колонок
fkeys = {m: {f["key"] for f in F[m]} for m in F}
HEADER_SETS = [
    ["Name", "Date", "Ticker", "Side", "Entry Price", "Exit Price", "Stop Loss", "Take Profit", "PnL", "Fees", "Notes", "Result"],
    ["Дата", "Пара", "Напрямок", "Вхід", "Стоп", "Тейк", "Вихід", "Результат", "Прибуток", "Коментар", "Помилки", "Емоції"],
    ["Назва", "Дата входу", "Дата виходу", "Символ", "Напрям", "Таймфрейм", "Сетап", "Ціна входу", "Стоп-лос", "Тейк-профіт", "Ціна виходу", "Розмір", "Плече", "Ризик, %", "RR", "Комісії", "Результат, %", "Результат, USD", "R", "Підсумок", "Емоції до", "Емоції після", "Помилки", "Дисципліна", "Нотатки", "Висновок"],
    ["Opened", "Closed", "Symbol", "Direction", "Lot", "Swap", "Profit", "Session", "Setup", "Tags"],
    ["A", "B", "C"], ["", "date", "date"], ["Тип угоди", "Time", "Instrument", "Volume", "Commission", "Net P&L", "Screenshot", "Comment", "Rating"],
    ["Open Time", "Close Time", "Type", "Size", "Item", "Price", "S / L", "T / P", "Price.1", "Commission", "Taxes", "Swap", "Profit"],
]
SAMPLES = {"Date": ["2026-01-05", "06.01.2026"], "Дата": ["05.01.2026"], "Result": ["TP", "SL"], "Side": ["Long", "Short"], "Напрямок": ["Лонг", "Шорт"], "A": ["1", "2.5"], "B": ["abc"], "C": ["10%", "5%"], "PnL": ["12.5", "-3"], "Вхід": ["100.5"], "Profit": ["10.5", "-2"], "Time": ["2026-01-05 10:00"]}
gm = []
for m in ("crypto", "forex"):
    for hs in HEADER_SETS:
        samples = {h: SAMPLES.get(h, []) for h in hs}
        gm.append({"market": m, "headers": hs, "samples": samples, "result": ji.guess_mapping(hs, samples, fkeys[m])})
OUT["guess_mapping"] = gm

# ------------------------------------------------------------------ перетворення рядків
def row_vals():
    return {
        "Дата": rnd.choice(["05.01.2026 14:30", "2026-01-05", "January 5, 2026 2:30 PM", "13/01/2026", "abc", "", "5 січня 2026 р."]),
        "Закрито": rnd.choice(["06.01.2026 09:00", "", "2026-01-06 10:00", "bad"]),
        "Пара": rnd.choice(["BTCUSDT", "eth/usdt", "", " sol "]),
        "Напрям": rnd.choice(["Long", "short", "ЛОНГ", "Шорт", "buy", "sell", "x", ""]),
        "ТФ": rnd.choice(["M5", "15 min, H1", "4h;D1", "1d|W1", "abc", "", "H1, H1"]),
        "Сетап": rnd.choice(["Пробій", "  пробій  ", "Новий сетап " + str(rnd.randint(1, 40)), "", "x" * 50]),
        "Вхід": rnd.choice(["100.5", "1,234.5", "abc", ""]), "Стоп": rnd.choice(["99", "(5)", ""]), "Результат": rnd.choice(["12,5", "-3", "$100", "1:3", "abc", ""]),
        "Підсумок": rnd.choice(["TP", "SL", "Тейк-профіт", "стоп-лос", "Беззбиток", "win", "loss", "take profit", "Stopped", "", "xyz", "закрито вручну"]),
        "Емоції": rnd.choice(["Спокій, Страх", "Нова емоція", "", "Спокій;Спокій", "a|b|c"]),
        "Рейтинг": rnd.choice(["⭐⭐⭐", "★★", "4", "7", "0", "abc", "", "3.9"]),
        "Правила": rnd.choice(["так", "ні", "yes", "No", "1", "0", "maybe", ""]),
        "Лінк": rnd.choice(["https://t.me/x?a=1", "see http://x.io/p) ok", "no link", ""]),
        "Нотатка": rnd.choice(["Текст", "багато\nрядків", "", "я" * 6000]), "Нотатка2": rnd.choice(["Ще", ""]),
    }
mapping_all = {"Дата": "opened_at", "Закрито": "closed_at", "Пара": "symbol", "Напрям": "direction", "ТФ": "timeframe", "Сетап": "setup", "Вхід": "entry", "Стоп": "stop",
               "Результат": "pnl", "Підсумок": "outcome", "Емоції": "emo_before", "Рейтинг": "discipline", "Правила": "by_rules", "Лінк": "notes", "Нотатка": "notes", "Нотатка2": "notes"}
conv = []
for m in ("crypto", "forex"):
    for df in (True, False):
        for variant in range(3):
            mp = dict(mapping_all)
            if variant == 1: mp = {k: v for k, v in mp.items() if v not in ("opened_at",)}
            if variant == 2: mp.update({"Лінк": "ризик_нема", "Рейтинг": "media", "Нотатка2": "re_enter_why", "Результат": "rr"})
            rows = [row_vals() for _ in range(90)]
            c = ji.Converter(F[m], mp, df)
            res = [c.convert(r) for r in rows]
            conv.append({"market": m, "day_first": df, "mapping": mp, "rows": rows, "results": [[d, p] for d, p in res], "warnings": c.warnings, "new_options": c.new_options})
OUT["converter"] = conv

# ------------------------------------------------------------------ допоміжні
OUT["safe_filename"] = [{"v": v, "result": journal.safe_filename(v)} for v in ["a.png", "../../etc/passwd", "ім'я файла.jpg", "a" * 200 + ".png", "", "  ", "a b?c*d.png", "COM1", ".hidden", "name.", "a/b\\c", "😀.png", "\x00x", "x" * 119 + "ї.png"]]
OUT["csv_cell"] = [{"v": v, "result": journal.csv_cell(v)} for v in ["=1+1", "+1", "-1", "@a", "\tx", "\rx", "ok", "", 5, 1.5, None, "  =x", "'x"]]

# ------------------------------------------------------------------ календар новин
TITLES = ["Non-Farm Employment Change", "ADP Non-Farm Employment Change", "Unemployment Rate", "Unemployment Claims", "Core PCE Price Index m/m", "CPI y/y", "Core CPI m/m",
          "PPI m/m", "Federal Funds Rate", "FOMC Press Conference", "FOMC Statement", "FOMC Meeting Minutes", "Fed Chair Powell Speaks", "ECB President Lagarde Speaks",
          "Official Bank Rate", "Main Refinancing Rate", "Prelim GDP q/q", "Retail Sales m/m", "ISM Manufacturing PMI", "JOLTS Job Openings", "CB Consumer Confidence",
          "Crude Oil Inventories", "10-y Bond Auction", "Empire State Manufacturing Index", "Trade Balance", "Bank Holiday", "Something Unknown", "Річні збори", "x" * 130,
          "  Padded Title  ", "ІНФЛЯЦІЯ CPI", "Cash Rate Monetary Policy"]
DATES_NW = ["2026-01-13T08:30:00-05:00", "2026-01-13T13:30:00Z", "2026-01-13T13:30:00+00:00", "2026-01-13T13:30:00+02:00", "2026-01-13T13:30+0530", "2026-01-13 13:30:00+01:00",
            "2026-01-13T13:30:00.250+00:00", "2026-01-13T13:30:00.123456789Z", "2026-01-13T13:30:00", "2026-01-13", "garbage", "", "2026-02-30T10:00:00Z", "2026-01-13T25:00:00Z",
            "2026-01-13T13:30:61Z", "2026-12-31T23:59:59-08:00", "2026-03-08T02:30:00-05:00", "2025-12-29T00:00:00+00:00", "2026-01-13T13Z", None, 5, "2026-01-13T13:30:00-24:00"]
def nw_item():
    r = rnd.random()
    it = {"title": rnd.choice(TITLES), "country": rnd.choice(["USD", "EUR", "GBP", "JPY", "usd", "All", "AU", "ПЛН", "US1", " eur ", "", None, "CHF"]),
          "date": rnd.choice(DATES_NW), "impact": rnd.choice(["High", "Medium", "Low", "Holiday", "Non-Economic", "", None, "HIGH", "x"]),
          "forecast": rnd.choice(["", "1.2%", "250K", None, "x" * 40, " 0.3% ", 5]), "previous": rnd.choice(["", "1.1%", "240K", None, "y" * 30])}
    if r < 0.03: return rnd.choice([None, 5, "x", [], {"title": "only"}])
    if r < 0.06: it.pop(rnd.choice(["title", "date", "country"]), None)
    return it
nw_cases = [[nw_item() for _ in range(rnd.randint(0, 60))] for _ in range(12)] + [[], "notalist", {"a": 1}, None]
def nw_capture(items):
    try:
        return {"ok": [e.to_dict() for e in nw.parse_faireconomy(items)]}
    except nw.NewsError as e:
        return {"error": str(e)}
OUT["news_parse"] = [{"items": c, "result": nw_capture(c)} for c in nw_cases]
OUT["news_describe"] = [{"title": t, "impact": i, "result": list(describe(t, i))} for t in TITLES + ["Core CPI", "FOMC Minutes", "BoE Holiday"] for i in ("high", "medium", "low", "holiday", "weird")]

base_items = [{"title": t, "country": rnd.choice(["USD", "EUR", "GBP", "JPY"]), "date": f"2026-01-{rnd.randint(5, 25):02d}T{rnd.randint(0, 23):02d}:{rnd.choice(['00', '15', '30', '45'])}:00-05:00",
               "impact": rnd.choice(["High", "Medium", "Low", "Holiday"]), "forecast": "1%", "previous": "2%"} for t in TITLES[:26] * 3]
store = nw.NewsStore(nw.StaticProvider(nw.parse_faireconomy(base_items)), clock=lambda: 1768000000.0)
snap = store.snapshot()
views = []
for now_iso in ("2026-01-09T12:00:00+00:00", "2026-01-15T09:30:00+00:00", "2026-01-31T00:00:00+00:00", "2026-01-01T00:00:00+00:00"):
    now = datetime.fromisoformat(now_iso)
    ns = SimpleNamespace(news=store, _clock=lambda n=now: n.timestamp())
    for days, past in ((7, 6), (1, 0), (14, 48), (30, 100), (0, -5), (3, 24)):
        res = AnalysisService.calendar(ns, days, past)
        views.append({"now": now_iso, "days": days, "past": past, "result": res})
OUT["news_view"] = {"items": base_items, "fetched_at": snap.fetched_at, "views": views}

p = Path(__file__).parent / "fixtures" / "parity.json.gz"
p.write_bytes(gzip.compress(json.dumps(OUT, ensure_ascii=False, default=str).encode("utf-8"), 9, mtime=0))
print("записано", p, p.stat().st_size // 1024, "КБ;", {k: len(v) for k, v in OUT.items()})
