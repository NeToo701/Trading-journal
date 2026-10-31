"""Браузерні перевірки 18 калькуляторів (окрім лотів): список по групах, форма й результат кожного, перемикачі, перевірка полів, спільні налаштування
(депозит, плече, актив, курс), збережені значення, підстановка з бектесту, нова симуляція, копіювання, телефон, відсутність помилок у консолі."""
import time
from e2e_lib import *

GROUPS = [("Позиція й ризик", ["lots", "rr", "partial", "avg", "pipv"]),
          ("Ф'ючерси й крипта", ["futures", "liq", "pnl", "fees", "funding", "breakeven", "spot", "grid", "dca", "convert"]),
          ("Облік і статистика", ["recovery", "daylimit", "expectancy", "montecarlo"])]
TITLES = {"lots": "Калькулятор лотів", "rr": "Ризик / прибуток (R:R)", "partial": "Частковий вихід і зсув стопу", "avg": "Усереднення позиції", "pipv": "Вартість пункту",
          "futures": "Ф'ючерсна позиція", "liq": "Ціна ліквідації", "pnl": "Прибуток і ROE", "fees": "Комісії біржі", "funding": "Фандинг", "breakeven": "Беззбиткова ціна",
          "spot": "Спот: вхід і прибуток", "grid": "Грид-бот", "dca": "DCA: регулярні покупки", "convert": "Конвертер", "recovery": "Відновлення після просадки",
          "daylimit": "Ризик на день і тиждень", "expectancy": "Очікування стратегії", "montecarlo": "Монте-Карло: серії угод"}
# (поля для вводу, очікуване велике значення, очікувані плитки: id → частина тексту). Числа перевірено вручну.
CASES = {
    "rr": ({"entry": "100", "stop": "98", "tp1": "106", "tp2": "110", "risk_money": "50"}, "1 : 3", {"be": "25%", "risk": "50,00", "stop": "2"}),
    "partial": ({"entry": "100", "stop": "98", "tp1": "104", "tp2": "108"}, "+3 R", {"stop": "−1 R", "tp1stop": "+1 R"}),
    "avg": ({"p1": "100", "q1": "1", "p2": "80", "q2": "1", "cur": "95", "add_price": "70", "want": "80"}, "90", {"qty": "2", "cost": "180,00", "pnl": "+10", "add": "Докупити 2 на 140,00"}),
    "pipv": ({"lots": "0,5", "pips": "20", "money": "50"}, "5,00 USD", {"units": "50 000", "mfp": "100,00 USD", "pfm": "10 пунктів"}),
    "futures": ({"entry": "100", "lev": "10", "size": "100", "stop": "95", "tp": "110"}, "10", {"notional": "1 000,00 USDT", "margin": "100,00 USDT", "liq": "90,4523", "fee": "1,00 USDT", "loss": "−50,98", "maxlev": "18,3x", "profit": "+98,95", "rr": "1 : 2"}),
    "liq": ({"entry": "100", "lev": "10", "stop": "95"}, "90,4523", {"maxlev": "18,3x"}),
    "pnl": ({"entry": "100", "exit": "110", "size": "2", "lev": "10"}, "+19,79 USDT", {"gross": "+20 USDT", "fees": "0,21 USDT", "change": "10%", "roe": "+98,95%"}),
    "fees": ({"notional": "10000", "gross": "100", "lev": "10", "trades": "20"}, "10,00 USDT", {"in": "5,00 USDT", "out": "5,00 USDT", "net": "+90 USDT", "month": "200,00 USDT"}),
    "funding": ({"notional": "1000", "rate": "0,01", "hold": "3"}, "0,90 USDT", {"day": "−0,30 USDT", "month": "−9,00 USDT"}),
    "breakeven": ({"entry": "100", "lev": "10"}, "100,1001", {"pct": "0,1001%"}),
    "spot": ({"size": "1000", "buy": "100", "sell": "110", "target": "10"}, "9,99", {"be": "100,2003", "pnl": "+97,8 USDT", "target": "110,2203"}),
    "grid": ({"low": "100", "high": "200", "n": "10", "invest": "1000"}, "+", {"amt": "100,00 USDT", "net": "5,053–9,78"}),
    "dca": ({"amount": "100", "prices": "100 50", "cur": "80"}, "66,6667", {"mean": "75", "range": "50 – 100", "pnl": "+40 USDT"}),
    "convert": ({"rate": "60000", "amount": "0,5"}, "30 000 USDT", {"inv": "0,0000166667 BTC"}),
    "recovery": ({"dd": "50", "monthly": "10"}, "100%", {"months": "7,3"}),
    "daylimit": ({"deposit": "10000"}, "3", {"week": "6", "days": "2"}),
    "expectancy": ({"wr": "40", "win": "2"}, "+0,2 R", {"pf": "1,33", "be": "33,3%", "kelly": "10%", "pt": "+0,2%"}),
    "montecarlo": ({"wr": "45"}, "99%", {"median": "+40,3%", "dd": "−7,7%", "streak": "7"}),
}
GENERIC = [t for _, ids in GROUPS for t in ids if t != "lots"]


def norm(s):
    return " ".join(s.replace(" ", " ").split())


def open_calc(pg):
    pg.evaluate("location.hash = '#calc'")
    pg.wait_for_selector("#calc-shell:not([hidden])")
    pg.wait_for_selector("#calc-side [data-tool]", state="attached", timeout=5000)


def tool(pg, tid):
    pg.click(f"#calc-side [data-tool={tid}]")
    pg.wait_for_selector(f"#calc-side [data-tool={tid}][aria-current=true]")
    pg.wait_for_selector("#calc-h1")
    eq(pg.locator("#calc-h1").inner_text(), TITLES[tid], f"заголовок {tid}")


def fill(pg, vals):
    for k, v in vals.items():
        pg.fill(f"#cg-{k}", v)


def seg(pg, tid, key, value):
    pg.click(f'label:has(input[name=cg-{tid}-{key}][value="{value}"])')


def big(pg):
    return norm(pg.locator("#cc-bigv").inner_text())


def tile(pg, tid):
    return norm(pg.locator(f"#cc-t-{tid}").inner_text())


def err(pg, key):
    return norm(pg.locator(f"[data-key={key}] .cc-err").inner_text())


def hidden(pg, key):
    return pg.locator(f"#calc-main [data-key={key}]").is_hidden()


def wait_prefs(pg, key, want, timeout=4.0):
    end = time.time() + timeout
    got = None
    while time.time() < end:
        got = expect_ok(pg, "get", "/calc/prefs")["prefs"].get(key)
        if got == want:
            return True
        time.sleep(0.1)
    return ok(False, f"налаштування {key}: очікувано {want}, отримано {got}")


def mk_backtest(pg):
    cid = expect_ok(pg, "post", "/backtests", {"name": "Тест R"})["backtest"]["id"]
    for r in (2, 2, -1, -1, 2):
        expect_ok(pg, "post", f"/backtests/{cid}/trades", {"r": r})
    return cid


# ------------------------------------------------------------------------------------------------ список
def t_nav(env):
    pg = env.page()
    open_calc(pg)
    eq([b.get_attribute("data-tool") for b in pg.locator("#calc-side [data-tool]").all()], [t for _, ids in GROUPS for t in ids], "19 калькуляторів у списку в потрібному порядку")
    eq([norm(h.inner_text()) for h in pg.locator("#calc-side h2").all()], [g for g, _ in GROUPS], "три групи з назвами")
    for gid, (name, ids) in zip(("risk", "fut", "stat"), GROUPS):
        eq([b.get_attribute("data-tool") for b in pg.locator(f"#calc-side section[aria-labelledby=calc-g-{gid}] [data-tool]").all()], ids, f"група «{name}»")
    ok(pg.locator("#calc-assets-btn").count() == 1, "кнопка «Активи й параметри» лишилась")
    for tid in [t for _, ids in GROUPS for t in ids]:
        tool(pg, tid)
        if tid != "lots":
            ok(pg.locator("#cc-wait").count() == 1 or pg.locator("#cc-bigv").count() == 1, f"{tid}: є результат або підказка")
    # підказка про незаповнені поля: назви валют і монет зберігають регістр
    tool(pg, "convert")
    pg.fill("#cg-base", "eth"); pg.fill("#cg-quote", "usdc")
    pg.wait_for_selector("#cc-wait")
    eq(norm(pg.locator("#cc-wait").inner_text()), "Заповни: курс: 1 ETH = ? USDC; кількість.", "підказка: тікери великими літерами")
    tool(pg, "futures")
    ok(norm(pg.locator("#cc-wait").inner_text()).startswith("Заповни: ціна входу;"), "підказка починається з малої літери")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ значення
def t_values(env):
    pg = env.page()
    open_calc(pg)
    for tid in GENERIC:
        vals, want_big, tiles = CASES[tid]
        tool(pg, tid)
        fill(pg, vals)
        pg.wait_for_selector("#cc-bigv", timeout=5000)
        ok(want_big in big(pg), f"{tid}: велике значення «{big(pg)}» має містити «{want_big}»")
        for k, part in tiles.items():
            ok(pg.locator(f"#cc-t-{k}").count() == 1 and part in tile(pg, k), f"{tid}: плитка {k}: «{tile(pg, k) if pg.locator(f'#cc-t-{k}').count() else 'немає'}» має містити «{part}»")
        ok("NaN" not in pg.locator("#cc-result").inner_text() and "undefined" not in pg.locator("#cc-result").inner_text(), f"{tid}: у результаті немає NaN")
    no_errors(pg)


def t_switches(env):
    pg = env.page()
    open_calc(pg)
    # R:R: третій тейк з'являється, коли заповнено другий; шорт
    tool(pg, "rr")
    ok(hidden(pg, "tp3"), "rr: тейк 3 схований, поки немає тейку 2")
    fill(pg, {"entry": "100", "stop": "102", "tp1": "94"}); seg(pg, "rr", "dir", "short")
    eq(big(pg), "1 : 3", "rr: шорт 1:3")
    fill(pg, {"tp2": "90"}); ok(not hidden(pg, "tp3"), "rr: тейк 3 з'явився")
    fill(pg, {"tp3": "80"}); eq(pg.locator("#cc-tbl-tps tbody tr").count(), 3, "rr: три рядки таблиці тейків")
    # частковий вихід: поле нового стопу лише для «На ціну»
    tool(pg, "partial")
    ok(hidden(pg, "stop2"), "partial: нового стопу не видно")
    fill(pg, {"entry": "100", "stop": "98", "tp1": "104"}); eq(pg.locator("#cg-share1").input_value(), "50", "partial: частка 50% за замовчуванням")
    eq(big(pg), "+1 R", "partial: беззбиток дає +1 R")
    seg(pg, "partial", "move", "none"); pg.wait_for_selector("#cc-bigv:has-text('+0,5 R')")
    seg(pg, "partial", "move", "price"); ok(not hidden(pg, "stop2"), "partial: поле стопу з'явилось")
    pg.wait_for_selector("#cc-wait"); fill(pg, {"stop2": "101"}); pg.wait_for_selector("#cc-bigv:has-text('+1,25 R')")
    # ф'ючерси: режими розміру
    tool(pg, "futures")
    ok(hidden(pg, "risk") and hidden(pg, "risk_mode"), "futures: ризик не видно в режимі маржі")
    fill(pg, {"entry": "100", "lev": "5"})
    seg(pg, "futures", "size_mode", "notional"); ok("Номінал" in pg.locator("[data-key=size] label").inner_text(), "futures: підпис поля став «Номінал»")
    fill(pg, {"size": "1000"}); eq(big(pg), "10", "futures: номінал 1000 при вході 100 = 10 монет"); ok("200,00 USDT" in tile(pg, "margin"), "futures: маржа 200 при плечі 5")
    seg(pg, "futures", "size_mode", "qty"); ok("Кількість" in pg.locator("[data-key=size] label").inner_text(), "futures: підпис «Кількість»")
    fill(pg, {"size": "3"}); ok("300,00 USDT" in tile(pg, "notional"), "futures: 3 монети = 300")
    seg(pg, "futures", "size_mode", "risk"); ok(not hidden(pg, "risk") and hidden(pg, "size"), "futures: режим ризику показує ризик і ховає розмір")
    seg(pg, "futures", "risk_mode", "money"); fill(pg, {"risk": "10", "stop": "90", "fee": "0"})
    pg.wait_for_selector("#cc-t-loss:has-text('−10,00 USDT')"); eq(big(pg), "1", "futures: ризик 10 при стопі 10 це 1 монета")
    fill(pg, {"lev": "10"}); pg.wait_for_selector("#cc-warn"); ok("ліквідації" in pg.locator("#cc-warn").inner_text(), "futures: при плечі 10 стоп 90 лежить за ліквідацією 90,45")
    # ліквідація: шорт і плече 1
    tool(pg, "liq")
    fill(pg, {"entry": "100", "lev": "10"}); seg(pg, "liq", "dir", "short"); pg.wait_for_selector("#cc-bigv:has-text('109,4527')")
    eq(pg.locator("#cc-tbl-levs tbody tr").count(), 7, "liq: таблиця для 7 значень плеча")
    seg(pg, "liq", "dir", "long"); fill(pg, {"lev": "1"}); pg.wait_for_selector("#cc-bigv:has-text('немає')")
    # фандинг: напрямок і одиниця часу
    tool(pg, "funding")
    fill(pg, {"notional": "1000", "rate": "0,01", "hold": "3"})
    eq(norm(pg.locator("#cc-big-l").inner_text()), "Ти платиш", "funding: лонг платить")
    seg(pg, "funding", "dir", "short"); pg.wait_for_selector("#cc-big-l:has-text('Ти отримуєш')")
    seg(pg, "funding", "unit", "h"); fill(pg, {"hold": "16"}); pg.wait_for_selector("#cc-big-h:has-text('2 періодів')")
    eq(big(pg), "0,20 USDT", "funding: 16 годин = 2 періоди по 0,1")
    seg(pg, "funding", "interval", "1"); pg.wait_for_selector("#cc-big-h:has-text('16 періодів')")
    # спот: задано кількість
    tool(pg, "spot")
    seg(pg, "spot", "mode", "qty"); fill(pg, {"size": "10", "buy": "100", "fee": "0,1"}); eq(big(pg), "10", "spot: кількість задано")
    ok("1 001,00" in norm(pg.locator("#cc-big-h").inner_text()), "spot: потрібна сума з комісією 1 001")
    # грид: геометрична сітка
    tool(pg, "grid")
    fill(pg, {"low": "100", "high": "200", "n": "10", "invest": "1000"}); seg(pg, "grid", "kind", "geom")
    pg.wait_for_selector("#cc-t-step:has-text('7,177%')"); ok("6,963%" in tile(pg, "net") and "–" not in tile(pg, "net"), f"grid: геометричний чистий прибуток однаковий на всіх сітках: {tile(pg, 'net')}")
    # конвертер: у зворотний бік
    tool(pg, "convert")
    fill(pg, {"base": "BTC", "quote": "USDT", "rate": "60000", "amount": "60000"}); seg(pg, "convert", "dir", "to_base"); pg.wait_for_selector("#cc-bigv:has-text('1 BTC')")
    # відновлення: режим балансів
    tool(pg, "recovery")
    ok(hidden(pg, "peak"), "recovery: баланси сховано")
    seg(pg, "recovery", "mode", "bal"); ok(hidden(pg, "dd") and not hidden(pg, "peak"), "recovery: режим балансів"); fill(pg, {"peak": "1000", "cur": "800"})
    eq(big(pg), "25%", "recovery: з 1000 до 800 потрібно +25%"); ok("200,00" in tile(pg, "money"), "recovery: потрібно заробити 200")
    # фініш: у шорті для rr, ф'ючерси і breakeven
    tool(pg, "breakeven")
    fill(pg, {"entry": "100", "fee_in": "0", "fee_out": "0", "funding": "1"}); eq(big(pg), "101", "breakeven: фандинг 1% = 101")
    seg(pg, "breakeven", "dir", "short"); eq(big(pg), "99", "breakeven: шорт нижче входу")
    no_errors(pg)


def t_validation(env):
    pg = env.page()
    open_calc(pg)
    tool(pg, "rr")
    fill(pg, {"entry": "100", "stop": "101", "tp1": "106"})
    pg.wait_for_selector("[data-key=stop] .cc-err:not(:empty)")
    ok("нижче входу" in err(pg, "stop"), f"rr: лонг зі стопом вище входу: «{err(pg, 'stop')}»")
    ok("Виправ" in pg.locator("#cc-wait").inner_text(), "rr: підказка просить виправити поля")
    eq(pg.locator("#cg-stop").get_attribute("aria-invalid"), "true", "rr: aria-invalid на полі")
    fill(pg, {"stop": "98"}); pg.wait_for_selector("#cc-bigv"); eq(err(pg, "stop"), "", "rr: помилка зникла"); eq(pg.locator("#cg-stop").get_attribute("aria-invalid"), None, "rr: aria-invalid знято")
    fill(pg, {"entry": "abc"}); pg.wait_for_selector("[data-key=entry] .cc-err:not(:empty)"); ok("число" in err(pg, "entry"), "rr: текст замість числа")
    tool(pg, "avg")
    fill(pg, {"p1": "100", "q1": "1", "add_price": "90", "want": "105"}); pg.wait_for_selector("[data-key=want] .cc-err:not(:empty)"); ok("між" in err(pg, "want"), "avg: бажана середня поза діапазоном")
    tool(pg, "dca")
    fill(pg, {"amount": "100", "prices": "100 abc"}); pg.wait_for_selector("[data-key=prices] .cc-err:not(:empty)"); ok("додатними" in err(pg, "prices"), "dca: сміття в цінах")
    fill(pg, {"prices": "100 50"}); pg.wait_for_selector("#cc-bigv"); eq(err(pg, "prices"), "", "dca: виправлено")
    tool(pg, "grid")
    fill(pg, {"low": "200", "high": "100", "invest": "1000"}); pg.wait_for_selector("[data-key=high] .cc-err:not(:empty)"); ok("вищою" in err(pg, "high"), "grid: верхня нижча за нижню")
    fill(pg, {"high": "300", "n": "500", "fee": "1"}); pg.wait_for_selector("#cc-warn"); ok("з'їдають" in pg.locator("#cc-warn").inner_text(), "grid: комісії з'їдають прибуток")
    tool(pg, "montecarlo")
    fill(pg, {"wr": "45", "risk": "100"}); pg.wait_for_selector("[data-key=risk] .cc-err:not(:empty)"); ok("весь баланс" in err(pg, "risk"), "montecarlo: ризик забирає весь баланс")
    tool(pg, "recovery")
    fill(pg, {"dd": "100"}); pg.wait_for_selector("[data-key=dd] .cc-err:not(:empty)")
    tool(pg, "expectancy")
    fill(pg, {"wr": "30", "win": "1"}); pg.wait_for_selector("#cc-warn"); ok("не додатне" in pg.locator("#cc-warn").inner_text(), "expectancy: попередження про від'ємне очікування")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ спільні налаштування й збереження
def t_shared(env):
    pg = env.page()
    open_calc(pg)
    # депозит і плече з калькулятора лотів видно в інших калькуляторах, і навпаки
    pg.click("#calc-side [data-tool=lots]"); pg.wait_for_selector("#cc-deposit")
    pg.fill("#cc-deposit", "5000"); pg.fill("#cc-lev", "20")
    wait_prefs(pg, "deposit", 5000); wait_prefs(pg, "leverage", 20)
    tool(pg, "futures")
    eq((pg.input_value("#cg-deposit"), pg.input_value("#cg-lev")), ("5000", "20"), "futures: депозит і плече взято з налаштувань")
    tool(pg, "daylimit"); eq(pg.input_value("#cg-deposit"), "5000", "daylimit: депозит той самий")
    pg.wait_for_selector("#cc-bigv"); ok("500,00" in norm(pg.locator("#cc-t-week").inner_text()) or "300,00" in norm(pg.locator("#cc-t-week").inner_text()), "daylimit: ліміти рахуються від 5000")
    eq(norm(pg.locator("#cc-big-h").inner_text()).split(" · ")[0], "денний ліміт 150,00", "daylimit: денний ліміт 3% від 5000")
    pg.fill("#cg-deposit", "7777"); wait_prefs(pg, "deposit", 7777)
    tool(pg, "fees"); eq(pg.input_value("#cg-lev"), "20", "fees: плече з налаштувань")
    pg.fill("#cg-lev", "50"); wait_prefs(pg, "leverage", 50)
    tool(pg, "liq"); eq(pg.input_value("#cg-lev"), "50", "liq: змінене плече видно скрізь")
    tool(pg, "lots"); pg.wait_for_selector("#cc-deposit")
    eq((pg.input_value("#cc-deposit"), pg.input_value("#cc-lev")), ("7777", "50"), "лоти: зміни з інших калькуляторів")
    # актив і курс у «Вартості пункту»
    expect_ok(pg, "post", "/calc/assets", {"symbol": "USDJPY", "name": "Долар / єна", "kind": "forex", "contract_size": 100000, "pip_size": 0.01, "quote_ccy": "JPY", "digits": 3, "min_lot": 0.01, "lot_step": 0.01, "max_lot": 50, "commission": 0})
    pg.reload(); pg.wait_for_selector("#calc-shell:not([hidden])"); pg.evaluate(HELPERS); open_calc(pg)
    tool(pg, "pipv")
    ok(pg.locator("#cc-asset option[value=USDJPY]").count() == 1, "pipv: власний актив є у списку")
    pg.select_option("#cc-asset", "XAUUSD"); fill(pg, {"lots": "1"}); pg.wait_for_selector("#cc-bigv:has-text('10,00 USD')"); eq(tile(pg, "units").split(" ")[1], "100", "pipv: золото 100 унцій")
    pg.select_option("#cc-asset", "USDJPY"); pg.wait_for_selector("[data-key=rate]:not([hidden])")
    ok("JPY" in pg.locator("[data-key=rate] label").inner_text(), "pipv: поле курсу для єни")
    pg.wait_for_selector("#cc-wait"); fill(pg, {"rate": "0,0066"}); pg.wait_for_selector("#cc-bigv:has-text('6,60 USD')")
    wait_prefs(pg, "rates", {"JPY": 0.0066})
    pg.select_option("#cc-asset", "EURUSD"); pg.wait_for_selector("[data-key=rate]", state="hidden"); pg.wait_for_selector("#cc-bigv:has-text('10,00 USD')")
    fill(pg, {"acc_ccy": "EUR"}); pg.wait_for_selector("[data-key=rate]:not([hidden])")
    ok("USD" in pg.locator("[data-key=rate] label").inner_text() and "EUR" in pg.locator("[data-key=rate] label").inner_text(), "pipv: курс USD → EUR")
    fill(pg, {"acc_ccy": "USD"}); wait_prefs(pg, "acc_ccy", "USD")
    no_errors(pg)


def t_keep(env):
    pg = env.page()
    open_calc(pg)
    tool(pg, "funding"); seg(pg, "funding", "unit", "h"); seg(pg, "funding", "interval", "4")
    tool(pg, "fees"); fill(pg, {"maker": "0,03", "taker": "0,06"}); seg(pg, "fees", "entry_type", "maker")
    tool(pg, "convert"); fill(pg, {"base": "eth", "quote": "usdc"})
    tool(pg, "grid"); fill(pg, {"n": "33"}); seg(pg, "grid", "kind", "geom")
    tool(pg, "montecarlo"); fill(pg, {"trades": "250"})
    tool(pg, "rr"); fill(pg, {"entry": "100"})
    pg.reload(); pg.wait_for_selector("#calc-shell:not([hidden])"); pg.wait_for_selector("#calc-side [data-tool]", state="attached")
    tool(pg, "funding")
    ok(pg.locator("input[name=cg-funding-unit][value=h]").is_checked() and pg.locator("input[name=cg-funding-interval][value='4']").is_checked(), "funding: одиниця й період збереглись")
    tool(pg, "fees")
    eq((pg.input_value("#cg-maker"), pg.input_value("#cg-taker"), pg.locator("input[name=cg-fees-entry_type][value=maker]").is_checked()), ("0,03", "0,06", True), "fees: ставки й тип входу збереглись")
    tool(pg, "convert"); eq((pg.input_value("#cg-base"), pg.input_value("#cg-quote")), ("eth", "usdc"), "convert: пара збереглась")
    tool(pg, "grid"); eq(pg.input_value("#cg-n"), "33", "grid: кількість сіток збереглась"); ok(pg.locator("input[name=cg-grid-kind][value=geom]").is_checked(), "grid: тип сітки збережено")
    tool(pg, "montecarlo"); eq(pg.input_value("#cg-trades"), "250", "montecarlo: кількість угод збережена")
    tool(pg, "rr"); eq(pg.input_value("#cg-entry"), "", "rr: ціни, що не позначені для збереження, не лишаються")
    # значення за замовчуванням у нових полях
    tool(pg, "futures"); eq((pg.input_value("#cg-fee"), pg.input_value("#cg-mmr")), ("0,05", "0,5"), "futures: комісія й підтримуюча маржа за замовчуванням")
    tool(pg, "daylimit"); eq((pg.input_value("#cg-risk"), pg.input_value("#cg-day"), pg.input_value("#cg-week")), ("1", "3", "6"), "daylimit: типові ліміти")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ бектест, симуляція, копіювання
def t_backtest_fill(env):
    pg = env.page()
    open_calc(pg)
    tool(pg, "expectancy")
    eq(pg.locator("#cg-bt").count(), 0, "без бектестів вибору колекції немає")
    ok(pg.locator("#cg-btfill").is_hidden(), "блок підстановки схований")
    for tid in GENERIC:
        if tid not in ("expectancy", "montecarlo"):
            tool(pg, tid); eq(pg.locator("#cg-btfill").count(), 0, f"{tid}: підстановки з бектесту немає")
    mk_backtest(pg)
    for tid in ("expectancy", "montecarlo"):
        tool(pg, tid)
        pg.wait_for_selector("#cg-bt", timeout=5000)
        eq(pg.locator("#cg-bt option").count(), 2, f"{tid}: «Не підставляти» і колекція")
        pg.select_option("#cg-bt", index=1)
        end = time.time() + 4
        while time.time() < end and pg.input_value("#cg-wr") == "":
            time.sleep(0.05)
        eq((pg.input_value("#cg-wr"), pg.input_value("#cg-win"), pg.input_value("#cg-loss")), ("60", "2", "1"), f"{tid}: winrate і R підставлено зі статистики")
        ok("Підставлено" in pg.locator("#jr-toasts").inner_text(), f"{tid}: повідомлення про підстановку")
    tool(pg, "expectancy")
    pg.select_option("#cg-bt", index=1)
    pg.wait_for_selector("#cc-bigv:has-text('+0,8 R')")      # 0,6 × 2 − 0,4 × 1
    ok("Критерій Келлі" in pg.locator("#cc-t-kelly").inner_text() and "40%" in tile(pg, "kelly"), "expectancy: Келлі 40% для 60% і 2R")
    no_errors(pg)


def t_montecarlo(env):
    pg = env.page()
    open_calc(pg)
    tool(pg, "montecarlo")
    ok(pg.locator("#cg-seed").count() == 0, "seed не показується в полях")
    fill(pg, {"wr": "45"}); pg.wait_for_selector("#cc-t-median")
    a = norm(pg.locator("#cc-kpis").inner_text())
    pg.fill("#cg-wr", "46"); pg.fill("#cg-wr", "45"); pg.wait_for_selector("#cc-t-median")
    eq(norm(pg.locator("#cc-kpis").inner_text()), a, "той самий вхід дає той самий результат")
    pg.click("#cg-act-rerun"); pg.wait_for_selector("#cc-t-median")
    b = norm(pg.locator("#cc-kpis").inner_text())
    ok(b != a, "«Нова симуляція» дає інші числа")
    pg.click("#cg-act-rerun"); c = norm(pg.locator("#cc-kpis").inner_text()); ok(c != b, "і ще раз інші")
    ok("−" in norm(pg.locator("#cc-t-dd").inner_text()), "просадка показана зі знаком мінус")
    fill(pg, {"wr": "100"}); pg.wait_for_selector("#cc-bigv:has-text('100%')")
    fill(pg, {"wr": "0"}); pg.wait_for_selector("#cc-warn"); ok("не додатне" in pg.locator("#cc-warn").inner_text(), "montecarlo: попередження при нульовому winrate")
    no_errors(pg)


def t_copy(env):
    ctx = env.browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    pg = env.page(ctx)
    open_calc(pg)
    tool(pg, "convert")
    ok(pg.locator("#cc-copy").count() == 0, "кнопки копіювання немає, поки немає результату")
    fill(pg, {"rate": "60000", "amount": "0,5"})
    pg.click("#cc-copy"); pg.wait_for_selector("#jr-toasts .jr-toast")
    eq(pg.evaluate("navigator.clipboard.readText()"), "30000", "у буфері число без пробілів і зайвих нулів")
    fill(pg, {"rate": "3", "amount": "1"}); seg(pg, "convert", "dir", "to_base"); pg.click("#cc-copy")
    eq(pg.evaluate("navigator.clipboard.readText()"), "0.33333333", "округлення до 8 знаків")
    tool(pg, "rr"); fill(pg, {"entry": "100", "stop": "98", "tp1": "106"}); ok(pg.locator("#cc-copy").count() == 0, "в інших калькуляторах кнопки копіювання немає")
    no_errors(pg)
    ctx.close()


# ------------------------------------------------------------------------------------------------ телефон
def t_mobile(env):
    ctx = env.browser.new_context(viewport={"width": 390, "height": 800})
    pg = env.page(ctx)
    open_calc(pg)
    for tid in GENERIC:
        pg.click("#calc-side-toggle") if pg.locator("#calc-side").is_hidden() else None
        pg.wait_for_selector("#calc-side", state="visible")
        pg.click(f"#calc-side [data-tool={tid}]"); pg.wait_for_selector("#calc-side", state="hidden")
        fill(pg, CASES[tid][0]); pg.wait_for_selector("#cc-bigv", timeout=5000)
        w = pg.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
        eq(w[0], w[1], f"{tid}: без горизонтальної прокрутки ({w})")
        over = pg.evaluate("""() => [...document.querySelectorAll('#calc-main *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && !e.closest('.jr-table-wrap'); }).map(e => e.tagName + '.' + e.className).slice(0, 4)""")
        eq(over, [], f"{tid}: нічого не виходить за екран")
    no_errors(pg)
    ctx.close()


def t_theme(env):
    pg = env.page()
    open_calc(pg)
    pg.click("label:has(input[name=theme][value=dark])")
    tool(pg, "futures"); fill(pg, CASES["futures"][0]); pg.wait_for_selector("#cc-t-liq")
    def lum(sel):
        return pg.evaluate("""(s) => { const c = getComputedStyle(document.querySelector(s)); const m = c.backgroundColor.match(/[\\d.]+/g).map(Number); return (m[0] + m[1] + m[2]) / 3; }""", sel)
    ok(lum("#cc-t-liq") < 100, f"плитка результату темна у темній темі ({lum('#cc-t-liq')})")
    ok(lum("#cc-result") < 100, "картка результату темна")
    pg.click("label:has(input[name=theme][value=light])")
    ok(lum("#cc-t-liq") > 150, "і світла у світлій темі")
    no_errors(pg)


TESTS = [("nav", t_nav), ("values", t_values), ("switches", t_switches), ("validation", t_validation), ("shared", t_shared), ("keep", t_keep),
         ("backtest_fill", t_backtest_fill), ("montecarlo", t_montecarlo), ("copy", t_copy), ("mobile", t_mobile), ("theme", t_theme)]

if __name__ == "__main__":
    import sys
    sys.exit(run(TESTS, sys.argv[1] if len(sys.argv) > 1 else None))
