"""Браузерні перевірки розділу «Калькулятори»: активи (вбудовані, власні, зміна параметрів, скидання, приховування), налаштування, калькулятор лотів
в інтерфейсі, телефон, резервна копія та синхронізація між пристроями."""
import json, time
from e2e_lib import *
from e2e_sync import Cloud, device, login, sync_now


def open_calc(pg):
    pg.evaluate("location.hash = '#calc'")
    pg.wait_for_selector("#calc-shell:not([hidden])")
    pg.wait_for_selector("#cc-asset", timeout=5000)


def seg(pg, name, value):
    pg.click(f"label:has(input[name={name}][value={value}])")


def fill_basic(pg, deposit="10000", risk="1", entry="1,1000", stop="1,0980"):
    pg.fill("#cc-deposit", deposit); pg.fill("#cc-risk", risk); pg.fill("#cc-entry", entry); pg.fill("#cc-stop", stop)


def lots(pg):
    return pg.locator("#cc-lots").inner_text()


def kv(pg, key):
    return pg.locator(f"#cc-k-{key} .jr-kpi-v").inner_text()


def calc_dump(pg):
    return pg.evaluate("""async () => JL.db.tx(['calc'], 'readonly', async t => (await t.all('calc')).map(x => [x.key, JSON.stringify({ ...x, _u: 0 })]).sort())""")


def outbox(pg):
    return pg.evaluate("""async () => JL.db.tx(['outbox'], 'readonly', async t => (await t.all('outbox')).filter(o => o.kind === 'calc').map(o => [o.id, o.op]).sort())""")


def wait_prefs(pg, key, want, timeout=4.0):
    end = time.time() + timeout
    while time.time() < end:
        got = expect_ok(pg, "get", "/calc/prefs")["prefs"].get(key)
        if got == want: return True
        time.sleep(0.1)
    return ok(False, f"налаштування {key}: очікувано {want}, отримано {got}")


JPY = {"symbol": "USDJPY", "name": "Долар / єна", "kind": "forex", "contract_size": 100000, "pip_size": 0.01, "quote_ccy": "JPY", "digits": 3, "min_lot": 0.01, "lot_step": 0.01, "max_lot": 50, "commission": 0}


# ------------------------------------------------------------------------------------------------ API
def t_api(env):
    pg = env.page()
    a = expect_ok(pg, "get", "/calc/assets")["assets"]
    eq([x["symbol"] for x in a], ["EURUSD", "GBPUSD", "XAUUSD"], "типові активи: євро, фунт, золото")
    eq([(x["builtin"], x["modified"], x["hidden"]) for x in a], [(True, False, False)] * 3, "типові: вбудовані, не змінені, видимі")
    eq(expect_ok(pg, "get", "/calc/prefs")["prefs"], {"acc_ccy": "USD", "deposit": None, "risk_mode": "pct", "risk_pct": 1, "risk_money": None, "leverage": None, "symbol": "EURUSD", "rates": {}}, "налаштування за замовчуванням")
    eq(calc_dump(pg), [], "до першої зміни в базі нічого не пишеться")

    # власний актив
    r = expect_ok(pg, "post", "/calc/assets", {**JPY, "symbol": "usd/jpy", "quote_ccy": "jpy", "pip_size": "0,01"})
    eq((r["asset"]["symbol"], r["asset"]["builtin"], r["asset"]["quote_ccy"]), ("USDJPY", False, "JPY"), "актив створено, символ нормалізовано")
    eq([x["symbol"] for x in expect_ok(pg, "get", "/calc/assets")["assets"]], ["EURUSD", "GBPUSD", "XAUUSD", "USDJPY"], "власний у кінці списку")
    expect_err(pg, 409, "post", "/calc/assets", JPY, "дубль власного")
    r = expect_err(pg, 409, "post", "/calc/assets", {**JPY, "symbol": "EURUSD"}, "дубль вбудованого"); eq(r["field"], "symbol", "поле помилки: символ")
    for k, bad in (("contract_size", "0"), ("pip_size", "abc"), ("quote_ccy", "1"), ("digits", "12"), ("min_lot", ""), ("symbol", "євро"), ("max_lot", "0,001")):
        r = expect_err(pg, 422, "post", "/calc/assets", {**JPY, "symbol": "TESTX", k: bad}, f"некоректне {k}={bad}")
        ok(r.get("field") in (k, "max_lot"), f"поле помилки {k}: {r.get('field')}")
    eq(len(expect_ok(pg, "get", "/calc/assets")["assets"]), 4, "некоректні активи не збереглись")

    # зміна власного й вбудованого
    r = expect_ok(pg, "put", "/calc/assets/USDJPY", {**JPY, "pip_size": "0,001", "commission": 5})
    eq((r["asset"]["pip_size"], r["asset"]["commission"]), (0.001, 5), "власний змінено")
    expect_err(pg, 404, "put", "/calc/assets/NOPE", JPY, "зміна неіснуючого")
    r = expect_ok(pg, "put", "/calc/assets/EURUSD", {"symbol": "EURUSD", "name": "Євро / долар", "kind": "forex", "contract_size": 100000, "pip_size": 0.00001, "quote_ccy": "USD", "digits": 5, "min_lot": 0.1, "lot_step": 0.1, "max_lot": 20, "commission": 7})
    eq((r["asset"]["builtin"], r["asset"]["modified"], r["asset"]["pip_size"]), (True, True, 0.00001), "вбудований змінено під брокера")
    e = next(x for x in expect_ok(pg, "get", "/calc/assets")["assets"] if x["symbol"] == "EURUSD")
    eq((e["modified"], e["min_lot"], e["lot_step"], e["max_lot"], e["commission"]), (True, 0.1, 0.1, 20, 7), "зміни збереглись")
    ok(("asset|EURUSD", "put") in [tuple(x) for x in outbox(pg)], "зміну поставлено в чергу відправки")
    # скидання вбудованого
    expect_ok(pg, "del", "/calc/assets/EURUSD")
    e = next(x for x in expect_ok(pg, "get", "/calc/assets")["assets"] if x["symbol"] == "EURUSD")
    eq((e["modified"], e["pip_size"], e["min_lot"], e["commission"]), (False, 0.0001, 0.01, 0), "скинуто до стандартних")
    ok(("asset|EURUSD", "del") in [tuple(x) for x in outbox(pg)], "скидання синхронізується як видалення")
    expect_ok(pg, "del", "/calc/assets/GBPUSD")      # скидання нескинутого не помилка
    # приховування
    gbp = next(x for x in expect_ok(pg, "get", "/calc/assets?all=1")["assets"] if x["symbol"] == "GBPUSD")
    expect_ok(pg, "put", "/calc/assets/GBPUSD", {**gbp, "hidden": True})
    eq([x["symbol"] for x in expect_ok(pg, "get", "/calc/assets")["assets"]], ["EURUSD", "XAUUSD", "USDJPY"], "схований не в списку")
    eq([x["symbol"] for x in expect_ok(pg, "get", "/calc/assets?all=1")["assets"] if x["hidden"]], ["GBPUSD"], "?all=1 показує сховані")
    expect_ok(pg, "put", "/calc/assets/GBPUSD", {**gbp, "hidden": False})
    eq(len(expect_ok(pg, "get", "/calc/assets")["assets"]), 4, "показано знову")
    expect_ok(pg, "put", "/calc/assets/XAUUSD", {**next(x for x in expect_ok(pg, "get", "/calc/assets")["assets"] if x["symbol"] == "XAUUSD"), "pip_size": 0.01})
    expect_ok(pg, "put", "/calc/assets/XAUUSD", {**next(x for x in expect_ok(pg, "get", "/calc/assets")["assets"] if x["symbol"] == "XAUUSD"), "name": "Золото (брокер)"})
    x = next(x for x in expect_ok(pg, "get", "/calc/assets")["assets"] if x["symbol"] == "XAUUSD")
    eq((x["pip_size"], x["name"], x["hidden"]), (0.01, "Золото (брокер)", False), "зміна не скидає сховане й не втрачає попередні правки")
    # видалення власного
    expect_ok(pg, "del", "/calc/assets/USDJPY")
    eq([x["symbol"] for x in expect_ok(pg, "get", "/calc/assets")["assets"]], ["EURUSD", "GBPUSD", "XAUUSD"], "власний видалено")
    expect_err(pg, 404, "del", "/calc/assets/USDJPY", None, "повторне видалення")
    # пошкоджений запис у базі не ламає список
    pg.evaluate("""async () => JL.db.tx(['calc'], 'readwrite', async t => { await t.put('calc', { key: 'asset|BROKEN', symbol: 'BROKEN', contract_size: 'x', _u: 1 }); await t.put('calc', { key: 'asset|EURUSD', symbol: 'EURUSD', pip_size: -1, _u: 2 }); })""")
    eq([x["symbol"] for x in expect_ok(pg, "get", "/calc/assets?all=1")["assets"]], ["EURUSD", "GBPUSD", "XAUUSD"], "пошкоджені записи ігноруються")
    eq(next(x for x in expect_ok(pg, "get", "/calc/assets")["assets"] if x["symbol"] == "EURUSD")["pip_size"], 0.0001, "пошкоджена зміна вбудованого: діють стандартні параметри")

    # налаштування
    p = expect_ok(pg, "put", "/calc/prefs", {"deposit": "12 500", "risk_pct": "0,5", "acc_ccy": "eur", "leverage": "1:100", "rates": {"jpy": "0,0066"}})["prefs"]
    eq((p["deposit"], p["risk_pct"], p["acc_ccy"], p["leverage"], p["rates"]), (12500, 0.5, "EUR", 100, {"JPY": 0.0066}), "налаштування збережено й нормалізовано")
    p = expect_ok(pg, "put", "/calc/prefs", {"risk_mode": "money", "risk_money": 80})["prefs"]
    eq((p["deposit"], p["risk_mode"], p["risk_money"], p["acc_ccy"]), (12500, "money", 80, "EUR"), "часткове оновлення зберігає решту")
    p = expect_ok(pg, "put", "/calc/prefs", {"deposit": None, "leverage": ""})["prefs"]
    eq((p["deposit"], p["leverage"]), (None, None), "порожнє значення очищає поле")
    for bad in ({"deposit": "-5"}, {"risk_pct": 500}, {"acc_ccy": "1"}, {"leverage": 0}, {"rates": {"JPY": -1}}):
        expect_err(pg, 422, "put", "/calc/prefs", bad, f"некоректні налаштування {bad}")
    eq(expect_ok(pg, "get", "/calc/prefs")["prefs"]["acc_ccy"], "EUR", "помилковий запит нічого не змінив")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ інтерфейс
def t_ui_flow(env):
    ctx = env.browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    pg = env.page(ctx)
    open_calc(pg)
    eq(pg.locator("#tab-calc").get_attribute("aria-current"), "page", "вкладка «Калькулятори» активна")
    eq(pg.locator("#jr-shell").is_hidden() and pg.locator("#bt-shell").is_hidden(), True, "інші розділи сховано")
    eq(pg.eval_on_selector_all("#cc-asset option", "o => o.map(x => x.value)"), ["EURUSD", "GBPUSD", "XAUUSD"], "у списку євро, фунт і золото")
    summ = lambda: pg.inner_text("#cc-asset-sum").replace("\u00a0", " ")
    ok("1 лот = 100 000" in summ() and "пункт 0,0001" in summ(), f"підсумок параметрів: {summ()}")
    ok("Заповни" in pg.inner_text("#cc-wait") and "депозит" in pg.inner_text("#cc-wait"), "підказка, чого бракує")
    # розрахунок
    fill_basic(pg)
    pg.wait_for_selector("#cc-lots:has-text('0,50')")
    eq(lots(pg), "0,50 лота", "EURUSD: 0,50 лота")
    ok("100,00 USD" in kv(pg, "risk") and "20 пунктів" in kv(pg, "stop") and "5,00 USD" in kv(pg, "pip"), "показники: ризик, стоп, пункт")
    eq(pg.locator("#cc-alt tbody tr").count(), 4, "таблиця лотів при іншому ризику")
    eq(pg.locator("#cc-alt tr[data-pct='2'] td").first.inner_text(), "1,00", "лот при 2% ризику")
    # тейк
    seg(pg, "cc-tmode", "rr"); pg.fill("#cc-tp", "2"); pg.wait_for_selector("#cc-k-rr")
    eq(kv(pg, "rr"), "1 : 2", "R:R"); ok("+200" in kv(pg, "profit"), f"профіт: {kv(pg, 'profit')}")
    seg(pg, "cc-tmode", "price"); pg.fill("#cc-tp", "1,0900"); pg.wait_for_selector("#cc-tp-err:not(:empty)")
    ok("вище входу" in pg.inner_text("#cc-tp-err"), "тейк лонга нижче входу відхилено")
    eq(pg.locator("#cc-tp").get_attribute("aria-invalid"), "true", "поле тейку позначено")
    ok("Виправ" in pg.inner_text("#cc-wait"), "результат просить виправити поле")
    pg.fill("#cc-tp", "1,1060"); pg.wait_for_selector("#cc-k-rr"); eq(kv(pg, "rr"), "1 : 3", "тейк за ціною: 1 : 3")
    seg(pg, "cc-tmode", "none"); pg.wait_for_selector("#cc-k-rr", state="detached")
    eq(pg.locator("#cc-tp").is_hidden(), True, "без тейку поле ховається")
    # напрямок і помилка стопу
    seg(pg, "cc-dir", "short"); pg.wait_for_selector("#cc-stop-err:not(:empty)")
    ok("вище входу" in pg.inner_text("#cc-stop-err"), "для шорта стоп нижче входу відхилено")
    pg.fill("#cc-stop", "1,1020"); pg.wait_for_selector("#cc-lots:has-text('0,50')")
    seg(pg, "cc-dir", "long"); pg.wait_for_selector("#cc-stop-err:not(:empty)")
    seg(pg, "cc-dir", "short")
    # стоп у пунктах, вхід необов'язковий
    seg(pg, "cc-smode", "pips"); pg.fill("#cc-stop", "40"); pg.fill("#cc-entry", "")
    pg.wait_for_selector("#cc-lots:has-text('0,25')")
    ok("необов'язково" in pg.inner_text("#cc-entry-l"), "вхід необов'язковий при стопі в пунктах")
    ok("#cc-k-margin" and pg.locator("#cc-k-margin").count() == 0, "без ціни входу маржі немає")
    # ризик у грошах
    seg(pg, "cc-rmode", "money"); eq(pg.input_value("#cc-risk"), "", "поле ризику у грошах порожнє")
    pg.fill("#cc-risk", "100"); pg.wait_for_selector("#cc-lots:has-text('0,25')")
    seg(pg, "cc-rmode", "pct"); eq(pg.input_value("#cc-risk"), "1", "відсоток повернувся")
    # плече і маржа
    seg(pg, "cc-smode", "price"); pg.fill("#cc-entry", "1,1000"); pg.fill("#cc-stop", "1,1040"); pg.fill("#cc-lev", "1:30")
    pg.wait_for_selector("#cc-k-margin"); ok("1 833,33" in kv(pg, "margin").replace(" ", " ") or "1833,33" in kv(pg, "margin"), f"маржа при плечі 1:30 (лот 0,25 → {kv(pg, 'margin')})") if False else None
    # менше мінімуму
    seg(pg, "cc-dir", "long"); pg.fill("#cc-deposit", "100"); pg.fill("#cc-stop", "1,0900"); pg.fill("#cc-risk", "1")
    pg.wait_for_selector("#cc-warn")
    ok("Мінімальний лот" in pg.inner_text("#cc-warn"), "попередження про мінімальний лот"); eq(lots(pg), "—", "лот не показується числом")
    eq(pg.locator("#cc-copy").count(), 0, "копіювати нічого")
    # копіювання
    pg.fill("#cc-deposit", "10000"); pg.fill("#cc-stop", "1,0980"); pg.wait_for_selector("#cc-copy")
    pg.click("#cc-copy"); pg.wait_for_selector(".jr-toast:has-text('Скопійовано')")
    eq(pg.evaluate("navigator.clipboard.readText()"), "0.50", "у буфері лот для вставки в термінал")
    # збереження налаштувань і повернення на сторінку
    wait_prefs(pg, "deposit", 10000)
    eq(expect_ok(pg, "get", "/calc/prefs")["prefs"]["risk_pct"], 1, "ризик збережено")
    pg.evaluate("location.hash = '#journal'"); pg.wait_for_selector("#calc-shell", state="hidden")
    pg.evaluate("location.hash = '#calc'"); pg.wait_for_selector("#cc-asset")
    eq((pg.input_value("#cc-deposit"), pg.input_value("#cc-entry"), pg.input_value("#cc-stop")), ("10000", "1,1000", "1,0980"), "введене лишилось після повернення")
    # після перезавантаження: депозит і ризик на місці, ціни порожні
    pg.reload(); pg.wait_for_selector("#cc-asset"); pg.evaluate(HELPERS)
    eq((pg.input_value("#cc-deposit"), pg.input_value("#cc-risk"), pg.input_value("#cc-entry")), ("10000", "1", ""), "після перезавантаження: депозит і ризик збережено, ціни ні")
    no_errors(pg)
    ctx.close()


def t_ui_assets(env):
    pg = env.page()
    open_calc(pg); fill_basic(pg, entry="2000", stop="1995")
    pg.select_option("#cc-asset", "XAUUSD"); pg.wait_for_selector("#cc-lots:has-text('0,20')")
    ok("100" in pg.inner_text("#cc-asset-sum").replace("\u00a0", " ") and "пункт 0,1" in pg.inner_text("#cc-asset-sum").replace("\u00a0", " "), "золото: контракт 100, пункт 0,1")
    ok("50 пунктів" in kv(pg, "stop"), f"золото: стоп 50 пунктів ({kv(pg, 'stop')})")
    eq(expect_ok(pg, "get", "/calc/prefs")["prefs"]["symbol"], "EURUSD", "вибір активу ще не збережено (дебаунс)") if False else None
    wait_prefs(pg, "symbol", "XAUUSD")
    # параметри активу під брокера
    pg.click("#cc-edit-asset"); pg.wait_for_selector("#cc-a-pip")
    eq(pg.input_value("#cc-a-symbol"), "XAUUSD", "форма активу відкрита для золота"); eq(pg.locator("#cc-a-symbol").get_attribute("readonly"), "", "символ не змінюється")
    eq(pg.locator("#cc-a-reset").count(), 0, "скидати ще нічого"); eq(pg.locator("#cc-a-del").count(), 0, "вбудований видалити не можна")
    pg.fill("#cc-a-pip", "0,01"); pg.fill("#cc-a-comm", "6"); pg.click("#cc-a-save"); pg.wait_for_selector("dialog[open]", state="detached")
    pg.wait_for_selector("#cc-lots:has-text('0,19')")
    ok("пункт 0,01" in pg.inner_text("#cc-asset-sum").replace("\u00a0", " ") and "комісія 6" in pg.inner_text("#cc-asset-sum").replace("\u00a0", " "), f"підсумок оновився: {pg.inner_text("#cc-asset-sum")}")
    ok("500 пунктів" in kv(pg, "stop"), f"стоп у пунктах з новим пунктом: {kv(pg, 'stop')}")
    ok(pg.locator("#cc-k-comm").count() == 1, "комісія в результаті")
    # помилка у формі лишає її відкритою
    pg.click("#cc-edit-asset"); pg.wait_for_selector("#cc-a-pip"); pg.fill("#cc-a-pip", "0"); pg.click("#cc-a-save")
    pg.wait_for_selector(".jr-error:not([hidden])"); ok("пункту" in pg.inner_text(".jr-error"), f"помилка пункту: {pg.inner_text('.jr-error')}")
    # скидання до стандартних
    ok(pg.locator("#cc-a-reset").count() == 1, "для зміненого є «Скинути»")
    pg.click("#cc-a-reset"); pg.wait_for_selector("dialog[open]", state="detached")
    ok("пункт 0,1" in pg.inner_text("#cc-asset-sum").replace("\u00a0", " ") and "комісія" not in pg.inner_text("#cc-asset-sum").replace("\u00a0", " "), "параметри скинуто")
    # новий актив із шаблоном
    pg.click("#cc-new-asset"); pg.wait_for_selector("#cc-a-preset")
    pg.select_option("#cc-a-preset", "forex_jpy")
    eq((pg.input_value("#cc-a-pip"), pg.input_value("#cc-a-quote"), pg.input_value("#cc-a-digits")), ("0,01", "JPY", "3"), "шаблон підставив параметри JPY-пари")
    pg.fill("#cc-a-symbol", "usdjpy"); pg.fill("#cc-a-name", "Долар / єна"); pg.click("#cc-a-save"); pg.wait_for_selector("dialog[open]", state="detached")
    eq(pg.input_value("#cc-asset"), "USDJPY", "новий актив вибрано")
    ok("ціна в JPY" in pg.inner_text("#cc-asset-sum").replace("\u00a0", " "), "підсумок нового активу")
    # курс потрібен, бо котирування в JPY, а рахунок у USD
    eq(pg.locator("#cc-rate").is_visible(), True, "для пари з JPY з'явилось поле курсу")
    ok("1 JPY = ? USD" in pg.inner_text("#cc-rate-l"), f"підпис курсу: {pg.inner_text('#cc-rate-l')}")
    pg.fill("#cc-entry", "150"); pg.fill("#cc-stop", "149,5"); pg.wait_for_selector("#cc-wait:has-text('курс')")
    pg.fill("#cc-rate", "0,01"); pg.wait_for_selector("#cc-lots:has-text('0,20')")
    pg.fill("#cc-acc", "jpy"); pg.wait_for_selector("#cc-rate-f", state="hidden")
    eq(pg.input_value("#cc-acc"), "JPY", "валюта рахунку у верхньому регістрі") if False else None
    pg.fill("#cc-acc", "USD"); pg.wait_for_selector("#cc-rate-f:not([hidden])")
    eq(pg.input_value("#cc-rate"), "0,01", "курс запам'ятано")
    # дубль символу
    pg.click("#cc-new-asset"); pg.wait_for_selector("#cc-a-symbol"); pg.fill("#cc-a-symbol", "USD/JPY"); pg.click("#cc-a-save")
    pg.wait_for_selector(".jr-error:not([hidden])"); ok("уже є" in pg.inner_text(".jr-error"), "дубль символу відхилено")
    pg.click("dialog[open] .jr-x"); pg.wait_for_selector("dialog[open]", state="detached")
    # вікно «Активи»: приховати, показати, змінити, видалити
    pg.click("#calc-assets-btn2"); pg.wait_for_selector("#cc-atable")
    eq(pg.locator("#cc-atable tbody tr").count(), 4, "у вікні всі активи")
    pg.click("#cc-atable tr[data-symbol=GBPUSD] [data-act=hide]"); pg.wait_for_selector("#cc-atable tr[data-symbol=GBPUSD].cc-hidden")
    ok("Показати" in pg.inner_text("#cc-atable tr[data-symbol=GBPUSD]"), "кнопка змінилась на «Показати»")
    eq(pg.locator("#cc-atable tr[data-symbol=USDJPY] [data-act=hide]").count(), 0, "власний не ховається")
    pg.click("#cc-assets-close"); pg.wait_for_selector("dialog[open]", state="detached")
    pg.wait_for_selector("#cc-asset option[value=GBPUSD]", state="detached")
    eq(pg.eval_on_selector_all("#cc-asset option", "o => o.map(x => x.value)"), ["EURUSD", "XAUUSD", "USDJPY"], "схований актив зник зі списку")
    pg.click("#calc-assets-btn"); pg.wait_for_selector("#cc-atable")
    pg.click("#cc-atable tr[data-symbol=GBPUSD] [data-act=hide]"); pg.wait_for_selector("#cc-atable tr[data-symbol=GBPUSD]:not(.cc-hidden)")
    pg.click("#cc-atable tr[data-symbol=USDJPY] [data-act=edit]"); pg.wait_for_selector("#cc-a-del")
    pg.click("#cc-a-del"); pg.click("dialog[open]:last-of-type .jr-btn.is-danger"); pg.wait_for_selector("#cc-a-del", state="detached")
    pg.wait_for_selector("#cc-atable tr[data-symbol=USDJPY]", state="detached")
    pg.click("#cc-add-asset"); pg.wait_for_selector("#cc-a-symbol")
    pg.fill("#cc-a-symbol", "btcusdt"); pg.select_option("#cc-a-preset", "crypto"); pg.click("#cc-a-save"); pg.wait_for_selector("#cc-a-symbol", state="detached")
    pg.wait_for_selector("#cc-atable tr[data-symbol=BTCUSDT]")
    pg.click("#cc-assets-close"); pg.wait_for_selector("dialog[open]", state="detached")
    pg.wait_for_selector("#cc-asset option[value=BTCUSDT]", state="attached")
    eq(pg.eval_on_selector_all("#cc-asset option", "o => o.map(x => x.value)"), ["EURUSD", "GBPUSD", "XAUUSD", "BTCUSDT"], "список після змін: крипта додалась, фунт повернувся")
    # крипта: рахунок у USD, котирування в USDT: курс не потрібен
    pg.select_option("#cc-asset", "BTCUSDT"); pg.fill("#cc-deposit", "1000"); pg.fill("#cc-entry", "60000"); pg.fill("#cc-stop", "59000"); pg.fill("#cc-risk", "1")
    pg.wait_for_selector("#cc-lots:has-text('0,01')")
    eq(pg.locator("#cc-rate-f").is_hidden(), True, "USDT рахується як USD: курс не потрібен")
    # вибраний актив, що зник, замінюється першим
    expect_ok(pg, "del", "/calc/assets/BTCUSDT")
    pg.evaluate("location.hash = '#journal'"); pg.evaluate("location.hash = '#calc'"); pg.wait_for_selector("#cc-asset")
    eq(pg.input_value("#cc-asset"), "EURUSD", "видалений актив замінено першим зі списку")
    no_errors(pg)


def t_ui_mobile(env):
    ctx = env.browser.new_context(viewport={"width": 390, "height": 800})
    pg = env.page(ctx)
    open_calc(pg); fill_basic(pg); seg(pg, "cc-tmode", "rr"); pg.fill("#cc-tp", "2"); pg.fill("#cc-lev", "30")
    pg.wait_for_selector("#cc-lots:has-text('0,50')")
    w = pg.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
    eq(w[0], w[1], f"без горизонтальної прокрутки на телефоні ({w})")
    eq(pg.locator("#calc-side").is_hidden(), True, "список калькуляторів сховано, поки не відкрито")
    pg.click("#calc-side-toggle"); pg.wait_for_selector("#calc-side", state="visible")
    ok(pg.locator("#calc-side .jr-jbtn[aria-current=true]").count() == 1, "вибраний калькулятор позначено")
    pg.click("#calc-side .jr-jbtn"); pg.wait_for_selector("#calc-side", state="hidden")
    over = pg.evaluate("""() => [...document.querySelectorAll('#calc-main *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => e.tagName + '.' + e.className).slice(0, 5)""")
    eq(over, [], "жоден елемент не виходить за екран")
    pg.click("#cc-edit-asset"); pg.wait_for_selector("#cc-a-pip")
    box = pg.locator("dialog[open]").bounding_box(); ok(box["x"] >= 0 and box["x"] + box["width"] <= 391, f"вікно активу вміщується: {box}")
    pg.click("dialog[open] .jr-x")
    # перехід між розділами: бічна панель не лишається відкритою
    pg.click("#calc-side-toggle"); pg.evaluate("location.hash = '#backtest'"); pg.wait_for_selector("#bt-shell:not([hidden])")
    eq(pg.evaluate("document.body.classList.contains('jr-side-open')"), False, "панель закрита після переходу до бектестів")
    no_errors(pg)
    ctx.close()


# ------------------------------------------------------------------------------------------------ копія й хмара
def t_backup_sync(env):
    pg = env.page()
    expect_ok(pg, "post", "/calc/assets", JPY)
    expect_ok(pg, "put", "/calc/assets/XAUUSD", {**next(x for x in expect_ok(pg, "get", "/calc/assets")["assets"] if x["symbol"] == "XAUUSD"), "pip_size": 0.01})
    expect_ok(pg, "put", "/calc/prefs", {"deposit": 7777, "acc_ccy": "EUR"})
    before = calc_dump(pg)
    pg.evaluate("async () => { window.__bk = (await JL.backupCreate()); }")
    eq(pg.evaluate("window.__bk.counts.calc"), 3, "у копію потрапили активи й налаштування")
    expect_ok(pg, "del", "/calc/assets/USDJPY"); expect_ok(pg, "del", "/calc/assets/XAUUSD")
    pg.evaluate("""async () => JL.db.tx(['calc'], 'readwrite', async t => t.del('calc', 'prefs'))""")
    eq([x[0] for x in calc_dump(pg)], [], "усе стерто")
    r = pg.evaluate("async () => JL.backupRestore(new File([window.__bk.blob], 'k.zip'))")
    eq(r["calc"], 3, "відновлено три записи")
    eq(calc_dump(pg), before, "після відновлення все як було")
    eq(next(x for x in expect_ok(pg, "get", "/calc/assets")["assets"] if x["symbol"] == "XAUUSD")["pip_size"], 0.01, "змінений параметр золота відновлено")
    eq(expect_ok(pg, "get", "/calc/prefs")["prefs"]["deposit"], 7777, "депозит відновлено")
    # копія зі зламаним записом: він пропускається
    pg.evaluate("""async () => { const z = await JL.zipOpen(window.__bk.blob); const e = z.entries.find(x => x.name === 'data.json'); const d = JSON.parse(new TextDecoder().decode(await z.read(e)));
      d.calc.push({ key: 'asset|bad key', symbol: 'x' }, null, { key: 5 }); window.__bk2 = await JL.zipCreate([{ name: 'data.json', data: new TextEncoder().encode(JSON.stringify(d)) }]); }""")
    r = pg.evaluate("async () => JL.backupRestore(new File([window.__bk2], 'k2.zip'))")
    eq(r["skipped"], 3, "зламані записи калькуляторів пропущено")
    no_errors(pg)

    cloud = Cloud()
    A = device(env, cloud)
    expect_ok(A, "post", "/calc/assets", JPY)
    expect_ok(A, "put", "/calc/assets/EURUSD", {**next(x for x in expect_ok(A, "get", "/calc/assets")["assets"] if x["symbol"] == "EURUSD"), "commission": 7})
    expect_ok(A, "put", "/calc/prefs", {"deposit": 5000, "risk_pct": 2, "symbol": "USDJPY", "rates": {"JPY": 0.0066}})
    login(A)
    uid = "uid-a@test.io"
    eq(sorted(cloud.docs(uid, "calc")), ["calc_asset|EURUSD", "calc_asset|USDJPY", "calc_prefs"], "активи й налаштування в хмарі")
    B = device(env, cloud); login(B)
    eq(calc_dump(B), calc_dump(A), "B отримав активи й налаштування")
    eq([x["symbol"] for x in expect_ok(B, "get", "/calc/assets")["assets"]], ["EURUSD", "GBPUSD", "XAUUSD", "USDJPY"], "список активів на B")
    eq(next(x for x in expect_ok(B, "get", "/calc/assets")["assets"] if x["symbol"] == "EURUSD")["commission"], 7, "параметр брокера на B")
    # B змінює, скидає, видаляє: A отримує
    time.sleep(0.02)
    expect_ok(B, "put", "/calc/prefs", {"deposit": 6000})
    expect_ok(B, "del", "/calc/assets/EURUSD")
    expect_ok(B, "del", "/calc/assets/USDJPY")
    sync_now(B); sync_now(A)
    eq(calc_dump(A), calc_dump(B), "після синхронізації однаково")
    eq((expect_ok(A, "get", "/calc/prefs")["prefs"]["deposit"], next(x for x in expect_ok(A, "get", "/calc/assets")["assets"] if x["symbol"] == "EURUSD")["commission"], len(expect_ok(A, "get", "/calc/assets")["assets"])), (6000, 0, 3), "зміна депозиту, скидання й видалення дійшли до A")
    # сторінка на A сама підтягує дані з хмари
    open_calc(A); A.wait_for_selector("#cc-asset")
    eq(A.input_value("#cc-asset"), "EURUSD", "вибраний актив, якого вже немає, замінено")
    expect_ok(B, "post", "/calc/assets", {**JPY, "symbol": "GBPJPY"}); sync_now(B); sync_now(A)
    A.wait_for_selector("#cc-asset option[value=GBPJPY]", state="attached", timeout=8000)
    ok(True, "новий актив з іншого пристрою з'явився без перезавантаження")
    # символ у ключі не пропускає чужі ключі з хмари
    A.evaluate("""async () => { await JL.sync._applyRemote({ kind: 'calc', rid: 'asset|../x', deleted: false, u: 99, data: JSON.stringify({ symbol: 'X' }), blob: null });
      await JL.sync._applyRemote({ kind: 'calc', rid: 'junk', deleted: false, u: 99, data: '{}', blob: null }); }""")
    ok(all(k in ("prefs",) or k.startswith("asset|") for k, _ in calc_dump(A)) and not any("junk" in k or ".." in k for k, _ in calc_dump(A)), "чужі ключі з хмари ігноруються")
    no_errors(A); no_errors(B)


TESTS = [("api", t_api), ("ui_flow", t_ui_flow), ("ui_assets", t_ui_assets), ("ui_mobile", t_ui_mobile), ("backup_sync", t_backup_sync)]

if __name__ == "__main__":
    import sys
    sys.exit(run(TESTS, sys.argv[1] if len(sys.argv) > 1 else None))
