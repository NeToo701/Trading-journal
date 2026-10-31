"""Браузерні перевірки розділу «Бектести»: оновлення бази зі старої версії, API колекцій і угод, весь інтерфейс (створення, швидке введення, правка,
видалення, статистика, розбивки, експорт, телефон), резервна копія та синхронізація між пристроями."""
import json, time
from e2e_lib import *
from e2e_sync import Cloud, device, login, sync_now, rebind


def mk_col(pg, name="Бектест", **kw):
    return expect_ok(pg, "post", "/backtests", {"name": name, **kw})["backtest"]["id"]


def mk_tr(pg, cid, r, **kw):
    return expect_ok(pg, "post", f"/backtests/{cid}/trades", {"r": r, **kw})["trade"]


def open_bt(pg):
    pg.evaluate("location.hash = '#backtest'")
    pg.wait_for_selector("#bt-shell:not([hidden])")
    pg.wait_for_selector("#bt-gate, #bt-h1", timeout=5000)


def kpi(pg, key):
    return pg.locator(f"#bt-k-{key} .jr-kpi-v").inner_text()


def add_trade_ui(pg, r, next_=True, **f):
    if f.get("date") is not None: pg.fill("#bt-f-date", f["date"])
    if f.get("symbol") is not None: pg.fill("#bt-f-symbol", f["symbol"])
    if f.get("setup") is not None: pg.fill("#bt-f-setup", f["setup"])
    if f.get("direction") is not None: pg.check(f'input[name=bt-f-dir][value="{f["direction"]}"]', force=True)
    pg.fill("#bt-f-r", str(r))
    pg.click("#bt-save-next" if next_ else "#bt-save-trade")


def bt_dump(pg):
    return pg.evaluate("""async () => JL.db.tx(['bt_cols','bt_trades'], 'readonly', async t => ({
      c: (await t.all('bt_cols')).map(x => [x.id, x.name, x.risk_pct, x._u]).sort(), t: (await t.all('bt_trades')).map(x => [x.id, x.col_id, x.r, x.setup, x.date]).sort() }))""")


# ------------------------------------------------------------------------------------------------ база
def t_db_upgrade(env):
    """Стара база (версія 1) з даними оновлюється до поточної версії: дані на місці, з'являються сховища бектестів і калькуляторів, курсор хмари скинуто."""
    pg = env.page(boot=False)
    pg.goto(env.url.replace("index.html", "manifest.webmanifest"))
    pg.evaluate("""() => new Promise((res, rej) => {
      const rq = indexedDB.open('journal-app-v1', 1);
      rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('meta'); db.createObjectStore('journals', { keyPath: 'id' });
        db.createObjectStore('entries', { keyPath: 'id' }).createIndex('journal_id', 'journal_id'); db.createObjectStore('reviews', { keyPath: 'key' });
        db.createObjectStore('media', { keyPath: 'id' }).createIndex('entry_id', 'entry_id'); db.createObjectStore('blobs'); db.createObjectStore('outbox', { keyPath: 'key' }); };
      rq.onsuccess = () => { const db = rq.result, t = db.transaction(['meta', 'journals'], 'readwrite');
        t.objectStore('meta').put('[1,"a"]', 'cursor'); t.objectStore('meta').put(777, 'lastBackup');
        t.objectStore('journals').put({ id: 111, name: 'Старий журнал', market: 'crypto', currency: 'USDT', fields: [], schema_v: 2, created_at: 1, _u: 5 });
        t.oncomplete = () => { db.close(); res(); }; t.onerror = () => rej(t.error); };
    })""")
    pg.goto(env.url)
    pg.wait_for_selector("#jr-side:not([hidden]), .jr-gate", timeout=10000)
    pg.evaluate(HELPERS)
    info = pg.evaluate("""async () => { const db = await JL.db.open();
      return { v: db.version, stores: [...db.objectStoreNames].sort(), idx: [...db.transaction('bt_trades').objectStore('bt_trades').indexNames],
               j: await JL.db.tx(['journals'], 'readonly', t => t.get('journals', 111)), cursor: (await JL.db.meta.get('cursor')) ?? null, backup: await JL.db.meta.get('lastBackup') }; }""")
    eq(info["v"], 3, "версія бази 3")
    ok("bt_cols" in info["stores"] and "bt_trades" in info["stores"] and "calc" in info["stores"] and len(info["stores"]) == 10, f"сховища: {info['stores']}")
    eq(info["idx"], ["col_id"], "індекс угод за колекцією")
    eq((info["j"]["name"], info["j"]["_u"]), ("Старий журнал", 5), "старий журнал не змінився")
    eq((info["cursor"], info["backup"]), (None, 777), "курсор хмари скинуто, решта налаштувань на місці")
    eq(expect_ok(pg, "get", "/backtests"), {"backtests": []}, "бектестів ще немає")
    cid = mk_col(pg, "Після оновлення"); mk_tr(pg, cid, 1)
    eq(len(expect_ok(pg, "get", "/backtests")["backtests"]), 1, "нова колекція зберігається")


# ------------------------------------------------------------------------------------------------ API
def t_api(env):
    pg = env.page()
    eq(expect_ok(pg, "get", "/backtests"), {"backtests": []}, "порожній список")
    cid = mk_col(pg, "  Пробій  ", note="Опис", risk_pct="1,5")
    col = expect_ok(pg, "get", "/backtests")["backtests"][0]
    eq((col["name"], col["note"], col["risk_pct"], col["trades"]), ("Пробій", "Опис", 1.5, 0), "колекція створена, текст обрізано")
    expect_err(pg, 409, "post", "/backtests", {"name": "пробій"}, "та сама назва в іншому регістрі")
    expect_err(pg, 422, "post", "/backtests", {"name": ""}, "порожня назва")
    expect_err(pg, 422, "post", "/backtests", {"name": "X", "risk_pct": 500}, "ризик понад 100")
    expect_err(pg, 404, "get", "/backtests/1", None, "немає такої колекції")
    expect_err(pg, 404, "post", "/backtests/1/trades", {"r": 1}, "угода в неіснуючу колекцію")
    # угоди
    a = mk_tr(pg, cid, "2", date="2024-03-02", symbol="btcusdt", direction="лонг", setup="Breakout")
    mk_tr(pg, cid, "-1", date="2024-03-01", setup="breakout")
    mk_tr(pg, cid, "-1,5", date="2024-03-03", setup="BREAKOUT ")
    mk_tr(pg, cid, 0.04, date="2024-03-04", setup="Відбій")
    eq((a["symbol"], a["direction"], a["r"]), ("BTCUSDT", "Лонг", 2), "угода: інструмент у верхньому регістрі, напрямок, число")
    full = expect_ok(pg, "get", f"/backtests/{cid}")
    eq([t["setup"] for t in full["trades"]], ["Breakout", "Breakout", "Breakout", "Відбій"], "сетапи зведені до одного написання")
    eq([(t["n"], t["date"]) for t in full["trades"]], [(1, "2024-03-01"), (2, "2024-03-02"), (3, "2024-03-03"), (4, "2024-03-04")], "угоди в хронологічному порядку з номерами")
    st = full["stats"]
    eq((st["trades"], st["wins"], st["losses"], st["be"], st["total_r"], st["max_drawdown_r"], st["return_pct"]), (4, 1, 2, 1, -0.46, 1.5, -0.69), "статистика колекції")
    eq(full["backtest"]["trades"], 4, "лічильник у відповіді")
    # правка й помилки
    expect_err(pg, 422, "post", f"/backtests/{cid}/trades", {"symbol": "X"}, "без результату")
    expect_err(pg, 422, "post", f"/backtests/{cid}/trades", {"r": "abc"}, "результат не число")
    expect_err(pg, 422, "post", f"/backtests/{cid}/trades", {"r": 1, "date": "2024-13-01"}, "неіснуюча дата")
    t = expect_ok(pg, "put", f"/backtest-trades/{a['id']}", {"r": 3, "date": "2024-03-02", "setup": "breakout", "direction": "Шорт"})["trade"]
    eq((t["r"], t["setup"], t["direction"]), (3, "Breakout", "Шорт"), "правка угоди: сетап теж зведено")
    expect_err(pg, 404, "put", "/backtest-trades/5", {"r": 1}, "правка неіснуючої угоди")
    expect_err(pg, 404, "del", "/backtest-trades/5", None, "видалення неіснуючої угоди")
    # зміна колекції
    p = expect_ok(pg, "patch", f"/backtests/{cid}", {"name": "Пробій 2", "risk_pct": None})["backtest"]
    eq((p["name"], p["risk_pct"], p["note"], p["trades"]), ("Пробій 2", None, "Опис", 4), "PATCH: назва й ризик змінено, опис лишився")
    c2 = mk_col(pg, "Інша")
    expect_err(pg, 409, "patch", f"/backtests/{c2}", {"name": "ПРОБІЙ 2"}, "перейменування на зайняту назву")
    eq(expect_ok(pg, "patch", f"/backtests/{c2}", {"name": "Інша"})["backtest"]["name"], "Інша", "збереження своєї ж назви дозволене")
    # видалення угоди й колекції з угодами
    expect_ok(pg, "del", f"/backtest-trades/{a['id']}")
    eq(expect_ok(pg, "get", f"/backtests/{cid}")["backtest"]["trades"], 3, "угоду видалено")
    expect_ok(pg, "del", f"/backtests/{cid}")
    left = pg.evaluate("JL.db.tx(['bt_trades'], 'readonly', t => t.count('bt_trades'))")
    eq(left, 0, "угоди видаленої колекції теж видалено")
    ob = pg.evaluate("JL.db.tx(['outbox'], 'readonly', async t => (await t.all('outbox')).filter(o => o.kind.startsWith('bt_')).map(o => o.kind + ':' + o.op).sort())")
    ok(ob.count("bt_trades:del") == 4 and "bt_cols:del" in ob and "bt_cols:put" in ob, f"усе потрапило в чергу відправки: {ob}")
    # ліміт колекцій
    for i in range(49): mk_col(pg, f"К{i}")
    expect_err(pg, 422, "post", "/backtests", {"name": "Зайва"}, "50 колекцій: далі не можна")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ інтерфейс
def t_ui_flow(env):
    pg = env.page()
    ok(pg.locator("#tab-backtest").is_visible(), "у шапці є розділ «Бектести»")
    pg.click("#tab-backtest")
    pg.wait_for_selector("#bt-gate")
    eq(pg.evaluate("document.body.dataset.view"), "backtest", "відкрито розділ бектестів")
    eq(pg.locator("#tab-backtest").get_attribute("aria-current"), "page", "вкладка підсвічена")
    ok(pg.locator("#jr-shell").is_hidden() and pg.locator("#bt-shell").is_visible(), "журнал сховано, бектести видно")
    ok(pg.locator("#bt-side-toggle").count() == 0 and pg.locator("#bt-gate .jr-only-narrow").is_hidden(), "на комп'ютері кнопки «Колекції» немає")
    # створення колекції
    pg.click("#bt-create-first")
    pg.fill("#bt-c-name", "Пробій діапазону"); pg.fill("#bt-c-note", "Вхід на пробої 4H"); pg.fill("#bt-c-risk", "1")
    pg.click("#bt-c-save")
    pg.wait_for_selector("#bt-empty")
    eq(pg.locator("#bt-h1").inner_text(), "Пробій діапазону", "заголовок колекції")
    ok("ризик 1% на угоду" in pg.locator(".jr-title .jr-dim").inner_text(), "ризик у заголовку")
    eq(pg.locator('.jr-jbtn[aria-current="true"] .jr-jname').inner_text(), "Пробій діапазону", "колекція вибрана в списку")
    # швидке введення: поля зберігаються, результат і нотатка очищаються
    pg.click("#bt-first-trade"); pg.wait_for_selector("#bt-f-r")
    eq(pg.evaluate("document.activeElement.id"), "bt-f-symbol", "для першої угоди фокус на інструменті")
    add_trade_ui(pg, "2", date="2024-03-01", symbol="btcusdt", setup="Пробій", direction="Лонг")
    pg.wait_for_selector("#bt-trade-status:not(:empty)")
    eq(pg.evaluate("document.activeElement.id"), "bt-f-r", "після «Зберегти й додати ще» фокус на результаті")
    eq((pg.input_value("#bt-f-r"), pg.input_value("#bt-f-symbol"), pg.input_value("#bt-f-setup"), pg.input_value("#bt-f-date")), ("", "btcusdt", "Пробій", "2024-03-01"), "дата, інструмент і сетап лишились, результат очищено")
    ok(pg.locator('input[name=bt-f-dir][value="Лонг"]').is_checked(), "напрямок лишився")
    ok("Усього угод у колекції: 1" in pg.inner_text("#bt-trade-status"), "рядок стану про додану угоду")
    pg.click(".bt-q >> text=−1"); eq(pg.input_value("#bt-f-r"), "-1", "швидка кнопка −1")
    ok("Збиткова" in pg.inner_text("#bt-r-hint"), "підказка про тип угоди")
    pg.click("#bt-save-next"); pg.wait_for_selector("#bt-trade-status:not(:empty)")
    for r in ("-1", "3", "1,5", "0"):
        pg.fill("#bt-f-r", r); pg.click("#bt-save-next"); pg.wait_for_timeout(120)
    pg.fill("#bt-f-r", "-0,5"); pg.keyboard.press("Enter"); pg.wait_for_timeout(200)       # Enter у полі = «Зберегти й додати ще»
    ok(pg.locator("dialog[open]").count() == 1, "Enter не закрив форму")
    # помилки в формі
    pg.fill("#bt-f-r", ""); pg.click("#bt-save-trade")
    pg.wait_for_selector("dialog[open] .jr-error:not([hidden])")
    ok("результат" in pg.inner_text("dialog[open] .jr-error").lower(), "порожній результат: зрозуміла помилка")
    pg.fill("#bt-f-r", "abc"); pg.click("#bt-save-trade")
    ok("число" in pg.inner_text("dialog[open] .jr-error"), "результат не число: помилка")
    pg.fill("#bt-f-r", "0"); pg.click("#bt-save-trade")                                    # зберегти й закрити
    pg.wait_for_selector("dialog[open]", state="detached")
    pg.wait_for_selector("#bt-kpis")
    # статистика: 2, -1, -1, 3, 1.5, 0, -0.5, 0
    eq(pg.locator("#bt-trades h3").inner_text(), "Угоди (8)", "угод у таблиці")
    eq((kpi(pg, "trades"), kpi(pg, "winrate"), kpi(pg, "total"), kpi(pg, "avg")), ("8", "37,5%", "+4 R", "+0,5 R"), "Угод, Winrate, Результат, Середній R")
    eq((kpi(pg, "pf"), kpi(pg, "dd"), kpi(pg, "streak"), kpi(pg, "avgwl")), ("2,6", "−2 R", "2 / 2", "+2,17 / −0,83"), "Profit factor, просадка, серії, виграш/збиток")
    ok("≈ +4% рахунку при ризику 1% на угоду" in pg.inner_text("#bt-k-total"), "дохідність у відсотках")
    ok(pg.locator("#bt-k-total .jr-kpi-v").get_attribute("class").endswith("pos") and pg.locator("#bt-k-dd .jr-kpi-v").get_attribute("class").endswith("neg"), "кольори результату й просадки")
    ok(pg.locator("#bt-equity svg path.jr-line").count() == 1, "крива результату намальована")
    pg.hover("#bt-equity svg", position={"x": 300, "y": 100})
    ok(pg.locator("#bt-equity .jr-tip:not([hidden])").count() == 1 and "Угода" in pg.inner_text("#bt-equity .jr-tip"), "підказка над кривою")
    # таблиця: нові зверху, порядок зберігається
    nums = lambda: pg.eval_on_selector_all("#bt-list tr", "rows => rows.map(r => r.querySelector('td').textContent)")
    eq(nums(), ["8", "7", "6", "5", "4", "3", "2", "1"], "спочатку нові")
    pg.select_option("#bt-sort", "asc")
    eq(nums()[:3], ["1", "2", "3"], "спочатку старі")
    pg.reload(); pg.wait_for_selector("#bt-list")
    eq(nums()[:2], ["1", "2"], "порядок пам'ятається після перезавантаження")
    eq(pg.locator('.jr-jbtn[aria-current="true"] .jr-jname').inner_text(), "Пробій діапазону", "вибрана колекція пам'ятається")
    first = pg.locator("#bt-list tr").first.inner_text()
    ok("BTCUSDT" in first and "Лонг" in first and "Пробій" in first and "+2" in first, f"рядок угоди: {first!r}")
    # розбивки
    ok("Пробій" in pg.inner_text("#bt-by-table") and "Winrate" in pg.inner_text("#bt-by-table"), "розбивка за сетапом")
    pg.click("#bt-breakdown label:has-text('Місяць')")
    ok("Березень 2024" in pg.inner_text("#bt-by-table"), "розбивка за місяцем")
    pg.click("#bt-breakdown label:has-text('Інструмент')")
    ok("BTCUSDT" in pg.inner_text("#bt-by-table"), "розбивка за інструментом")
    pg.reload(); pg.wait_for_selector("#bt-by-table")
    ok(pg.locator("#bt-breakdown input[value=symbol]").is_checked(), "вибрана розбивка пам'ятається")
    # правка угоди
    pg.select_option("#bt-sort", "asc")
    pg.click("#bt-list tr >> nth=0")
    pg.wait_for_selector("#bt-f-r")
    eq((pg.input_value("#bt-f-r"), pg.input_value("#bt-f-symbol"), pg.input_value("#bt-f-date")), ("2", "BTCUSDT", "2024-03-01"), "форма правки заповнена")
    ok(pg.locator("#bt-save-next").count() == 0, "у правці немає «додати ще»")
    pg.fill("#bt-f-r", "5"); pg.fill("#bt-f-note", "Перевірена нотатка"); pg.click("#bt-save-trade")
    pg.wait_for_selector("dialog[open]", state="detached")
    eq(kpi(pg, "total"), "+7 R", "результат після правки")
    ok("Перевірена нотатка" in pg.locator("#bt-list tr").first.inner_text(), "нотатка в таблиці")
    # видалення угоди
    pg.click("#bt-list tr >> nth=1"); pg.wait_for_selector("#bt-del-trade")
    pg.click("#bt-del-trade"); pg.click("dialog[open] .jr-btn.is-danger")
    pg.wait_for_selector("#bt-trades h3:has-text('Угоди (7)')")
    eq(len(nums()), 7, "угоду видалено")
    # друга колекція
    pg.click("#bt-add-col"); pg.fill("#bt-c-name", "пробій ДІАПАЗОНУ"); pg.click("#bt-c-save")
    pg.wait_for_selector("dialog[open] .jr-error:not([hidden])")
    ok("вже є" in pg.inner_text("dialog[open] .jr-error"), "дубль назви колекції відхилено")
    pg.fill("#bt-c-name", "Відбій від рівня"); pg.click("#bt-c-save")
    pg.wait_for_selector("#bt-empty")
    eq(pg.locator(".jr-jbtn").count(), 2, "дві колекції в списку")
    eq(pg.locator(".jr-jbtn >> nth=0 >> .jr-jcount").inner_text(), "7", "лічильник угод у списку")
    pg.click('.jr-jbtn >> nth=0'); pg.wait_for_selector("#bt-kpis")
    eq(pg.locator("#bt-h1").inner_text(), "Пробій діапазону", "перемикання колекцій")
    # експорт CSV
    with pg.expect_download() as dl:
        pg.click("#bt-export")
    path = dl.value.path()
    raw = open(path, "rb").read()
    ok(raw.startswith(b"\xef\xbb\xbf"), "CSV з BOM для Excel")
    lines = raw.decode("utf-8-sig").strip().split("\r\n")
    eq(lines[0], '№,Дата,Інструмент,Напрямок,Сетап,"Результат, R",Нотатка,Скріншотів', "заголовок CSV")
    eq(len(lines), 8, "у CSV сім угод")
    ok(lines[1].startswith("1,2024-03-01,BTCUSDT,Лонг,Пробій,5,") and lines[1].endswith(",0"), f"перший рядок CSV: {lines[1]}")
    # зміна й видалення колекції
    pg.click("#bt-edit-col"); pg.fill("#bt-c-name", "Пробій v2"); pg.fill("#bt-c-risk", ""); pg.click("#bt-c-save")
    pg.wait_for_selector("dialog[open]", state="detached")
    eq(pg.locator("#bt-h1").inner_text(), "Пробій v2", "назву змінено")
    ok("ризик" not in pg.locator(".jr-title .jr-dim").inner_text() and "рахунку" not in pg.inner_text("#bt-k-total"), "без ризику немає відсотків")
    pg.click("#bt-delete"); pg.click("dialog[open] .jr-btn.is-danger")
    pg.wait_for_selector("#bt-empty")
    eq(pg.locator("#bt-h1").inner_text(), "Відбій від рівня", "після видалення відкрилась інша колекція")
    eq(pg.locator(".jr-jbtn").count(), 1, "у списку одна колекція")
    # повернення до журналу
    pg.click("#tab-journal")
    pg.wait_for_selector("#jr-shell:not([hidden])")
    ok(pg.locator("#bt-shell").is_hidden(), "назад у журнал")
    no_errors(pg)


def t_ui_mobile(env):
    pg = env.page(width=390, height=800)
    cid = mk_col(pg, "Телефон", risk_pct=1)
    for i, r in enumerate([2, -1, 3, -1, 1.5, -1, 2]): mk_tr(pg, cid, r, date=f"2024-03-{i + 1:02d}", symbol="EURUSD", setup="Відбій")
    open_bt(pg); pg.wait_for_selector("#bt-kpis")
    ok(pg.locator("#bt-side-toggle").is_visible(), "на телефоні є кнопка «Колекції»")
    ok(pg.locator("#bt-side").is_hidden(), "список колекцій схований")
    pg.click("#bt-side-toggle"); ok(pg.locator("#bt-side").is_visible(), "кнопка відкриває список")
    pg.click(".jr-jbtn"); ok(pg.locator("#bt-side").is_hidden(), "вибір колекції закриває список")
    over = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    ok(over <= 1, f"немає горизонтальної прокрутки сторінки ({over}px)")
    ok(pg.evaluate("getComputedStyle(document.querySelector('#bt-trades thead')).position") == "absolute", "таблиця угод стає картками")
    ok(pg.locator("#bt-list tr").first.locator("td[data-label]").count() >= 5, "у картках підписані значення")
    pg.click("#bt-list tr >> nth=0"); pg.wait_for_selector("#bt-f-r")
    box = pg.locator("dialog[open]").bounding_box()
    ok(box["x"] >= 0 and box["x"] + box["width"] <= 391, "форма вміщується в екран телефона")
    pg.keyboard.press("Escape")
    pg.wait_for_selector("dialog[open]", state="detached")
    over = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    ok(over <= 1, "після закриття форми теж без прокрутки вбік")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ копія
def t_backup(env):
    pg = env.page()
    cid = mk_col(pg, "У копії", note="н", risk_pct=2)
    for r in (1, -1, 2): mk_tr(pg, cid, r, date="2024-01-01", setup="S")
    before = bt_dump(pg)
    res = pg.evaluate("""async () => { const b = await JL.backupCreate(); return { counts: b.counts, size: b.blob.size }; }""")
    eq((res["counts"]["backtests"], res["counts"]["bt_trades"]), (1, 3), "у копію потрапили колекції й угоди")
    pg.evaluate("""async () => { window.__bk = (await JL.backupCreate()).blob; }""")
    expect_ok(pg, "del", f"/backtests/{cid}")
    eq(bt_dump(pg), {"c": [], "t": []}, "колекцію видалено")
    r = pg.evaluate("async () => JL.backupRestore(new File([window.__bk], 'k.zip'))")
    eq((r["backtests"], r["bt_trades"]), (1, 3), "відновлено колекцію й угоди")
    eq([x[:3] for x in bt_dump(pg)["t"]], [x[:3] for x in before["t"]], "угоди ті самі")
    eq(bt_dump(pg)["c"][0][1:3], ["У копії", 2], "колекція та сама")
    eq(len(expect_ok(pg, "get", f"/backtests/{cid}")["trades"]), 3, "угоди відкриваються після відновлення")
    r = pg.evaluate("async () => JL.backupRestore(new File([window.__bk], 'k.zip'))")
    eq((r["backtests"], r["bt_trades"]), (0, 0), "повторне відновлення нічого не дублює")
    # стара копія без бектестів і пошкоджені рядки
    r = pg.evaluate("""async () => { const mk = (o) => JL.zipCreate([{ name: 'data.json', data: new TextEncoder().encode(JSON.stringify({ format: 'journal-app-backup', version: 1, ...o })) }]);
      const old = await JL.backupRestore(new File([await mk({ journals: [], entries: [] })], 'old.zip'));
      const bad = await JL.backupRestore(new File([await mk({ journals: [], entries: [], bt_cols: [null, 5, { id: 9001, name: 'Добра', created_at: 1, _u: 1 }, { id: 'x', name: 'Погана' }],
        bt_trades: [{ id: 9002, col_id: 9001, r: 1, _u: 1 }, { id: 9003, col_id: 9001 }, null, { id: 9004, r: 1 }] })], 'bad.zip'));
      return { old, bad }; }""")
    eq((r["old"]["backtests"], r["old"]["bt_trades"]), (0, 0), "копія без бектестів відновлюється")
    eq((r["bad"]["backtests"], r["bad"]["bt_trades"], r["bad"]["skipped"]), (1, 1, 6), "пошкоджені рядки пропущено")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ хмара
def t_sync(env):
    cloud = Cloud()
    A = device(env, cloud)
    c1 = mk_col(A, "Спільна", risk_pct=1); c2 = mk_col(A, "Друга")
    t1 = mk_tr(A, c1, 2, date="2024-01-01", setup="S1"); t2 = mk_tr(A, c1, -1, date="2024-01-02"); t3 = mk_tr(A, c1, 3, date="2024-01-03"); mk_tr(A, c2, 1)
    login(A)
    uid = "uid-a@test.io"
    eq({k: len(cloud.docs(uid, k)) for k in ("bt_cols", "bt_trades")}, {"bt_cols": 2, "bt_trades": 4}, "колекції й угоди в хмарі")
    B = device(env, cloud)
    login(B)
    eq(bt_dump(B), bt_dump(A), "B отримав усі колекції й угоди")
    eq(expect_ok(B, "get", f"/backtests/{c1}")["stats"]["total_r"], 4, "статистика на B та сама")
    # B змінює, видаляє й додає; A отримує
    time.sleep(0.02)
    expect_ok(B, "put", f"/backtest-trades/{t1['id']}", {"r": 5, "date": "2024-01-01", "setup": "S1"})
    expect_ok(B, "del", f"/backtest-trades/{t2['id']}")
    mk_tr(B, c1, 1, date="2024-01-04")
    expect_ok(B, "patch", f"/backtests/{c2}", {"name": "Друга v2"})
    sync_now(B); sync_now(A)
    eq(bt_dump(A), bt_dump(B), "після синхронізації однаково")
    eq(sorted(x[2] for x in bt_dump(A)["t"] if x[1] == c1), [1, 3, 5], "правка, видалення й нова угода дійшли до A")
    ok("Друга v2" in [x[1] for x in bt_dump(A)["c"]], "перейменування дійшло")
    # видалення колекції дійшло разом з угодами
    expect_ok(B, "del", f"/backtests/{c1}")
    sync_now(B); sync_now(A)
    eq(bt_dump(A), bt_dump(B), "видалення колекції дійшло")
    eq(len(bt_dump(A)["t"]), 1, "лишилась угода другої колекції")
    # інтерфейс на A оновлюється сам, коли дані приходять із хмари
    A.evaluate("location.hash = '#backtest'"); A.wait_for_selector("#bt-h1")
    eq(A.locator("#bt-h1").inner_text(), "Друга v2", "A показує вцілілу колекцію")
    mk_tr(B, c2, 2); sync_now(B); sync_now(A)
    A.wait_for_selector("#bt-trades h3:has-text('Угоди (2)')", timeout=8000)
    ok(True, "нова угода з іншого пристрою з'явилась на екрані без перезавантаження")
    # перехід на інший акаунт не стирає бектести мовчки: є конфлікт
    C = device(env, cloud)
    mk_col(C, "Локальна на C")
    C.evaluate("email => __login(email)", "other@test.io"); time.sleep(0.4)
    C.evaluate("email => __login(email)", "a@test.io"); time.sleep(0.6)
    no_errors(A); no_errors(B)


# ------------------------------------------------------------------------------------------------ скріншоти
UPLOAD = """async ([id, w, h, name]) => { const b = await __t.png(w, h, false);
  try { const r = await JL.api.upload(`/backtest-trades/${id}/media?name=${name}`, b); return { ok: r }; } catch (e) { return { error: e.message, status: e.status }; } }"""


def shot(pg, tid, w=40, h=30, name="a.png"):
    r = pg.evaluate(UPLOAD, [tid, w, h, name])
    ok("ok" in r, f"завантаження {name}: {r.get('error')}")
    return r.get("ok", {}).get("media")


def media_state(pg):
    return pg.evaluate("""async () => JL.db.tx(['media', 'blobs', 'outbox'], 'readonly', async t => ({
      m: (await t.all('media')).map(x => [x.id, x.entry_id, x.bt || 0, x.mime]).sort(), b: (await t.keys('blobs')).length,
      ob: (await t.all('outbox')).filter(o => o.kind === 'media').map(o => o.op).sort() }))""")


def t_shots_api(env):
    pg = env.page()
    cid = mk_col(pg, "Скріни")
    t1 = mk_tr(pg, cid, 2, date="2024-01-01"); t2 = mk_tr(pg, cid, -1, date="2024-01-02")
    eq(expect_ok(pg, "get", f"/backtest-trades/{t1['id']}/media"), {"media": []}, "спочатку скріншотів немає")
    m1 = shot(pg, t1["id"], 50, 30, "a b.png"); shot(pg, t1["id"], 20, 20, "c.png")
    eq((m1["mime"], m1["field"], m1["name"]), ("image/png", "shots", "a b.png"), "скріншот збережено")
    nat = pg.evaluate("""async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }""", m1["url"])
    eq(nat, [50, 30], "скріншот відкривається")
    got = expect_ok(pg, "get", f"/backtests/{cid}")["trades"]
    eq([(t["id"] == t1["id"], t["shots"]) for t in got], [(True, 2), (False, 0)], "лічильник скріншотів у списку угод")
    eq([x["name"] for x in expect_ok(pg, "get", f"/backtest-trades/{t1['id']}/media")["media"]], ["a b.png", "c.png"], "список скріншотів угоди")
    ms = media_state(pg)
    ok(all(x[1] == t1["id"] and x[2] == 1 for x in ms["m"]) and ms["b"] == 2, f"файли лежать у сховищі з позначкою bt: {ms}")
    # відхилення: відео, текст, порожній файл, неіснуюча угода
    for label, js in (("відео", "__t.mp4()"), ("текст", "new Blob(['hello world, not an image'], { type: 'image/png' })"), ("порожній", "new Blob([], { type: 'image/png' })")):
        r = pg.evaluate("async ([id]) => { try { await JL.api.upload(`/backtest-trades/${id}/media?name=x`, " + js + "); return { ok: 1 }; } catch (e) { return { status: e.status, error: e.message }; } }", [t2["id"]])
        ok(r.get("status") in (400, 415), f"{label} не приймається: {r}")
    r = pg.evaluate("async () => { try { await JL.api.upload('/backtest-trades/5/media?name=x', await __t.png(5, 5, false)); return { ok: 1 }; } catch (e) { return { status: e.status }; } }")
    eq(r.get("status"), 404, "скріншот до неіснуючої угоди")
    expect_err(pg, 404, "get", "/backtest-trades/5/media", None, "список скріншотів неіснуючої угоди")
    # ліміт на угоду
    for i in range(18): shot(pg, t1["id"], 5, 5, f"s{i}.png")
    r = pg.evaluate(UPLOAD, [t1["id"], 5, 5, "зайвий.png"])
    eq(r.get("status"), 422, "20 скріншотів на угоду: далі не можна")
    # видалення одного скріншота загальним маршрутом
    expect_ok(pg, "del", f"/media/{m1['id']}")
    eq(len(expect_ok(pg, "get", f"/backtest-trades/{t1['id']}/media")["media"]), 19, "скріншот видалено")
    # видалення угоди прибирає її скріншоти, файли й ставить видалення в чергу
    shot(pg, t2["id"], 8, 8, "t2.png")
    before = media_state(pg)
    expect_ok(pg, "del", f"/backtest-trades/{t1['id']}")
    ms = media_state(pg)
    eq((len(ms["m"]), ms["b"]), (1, 1), "після видалення угоди лишився лише скріншот іншої")
    ok(ms["ob"].count("del") == 20, f"видалення скріншотів у черзі відправки: {ms['ob'].count('del')}")
    # видалення колекції
    expect_ok(pg, "del", f"/backtests/{cid}")
    eq(media_state(pg)["m"], [], "після видалення колекції скріншотів не лишилось")
    eq(media_state(pg)["b"], 0, "файли теж видалені")
    no_errors(pg)


def t_shots_ui(env):
    ctx = env.browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    pg = env.page(ctx)
    cid = mk_col(pg, "UI скріни")
    expect_ok(pg, "get", "/meta")
    open_bt(pg); pg.wait_for_selector("#bt-empty")
    clip = lambda w, h: pg.evaluate("""async ([w, h]) => { const b = await __t.png(w, h, false); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); }""", [w, h])
    # нова угода: кнопка «Вставити» і Ctrl+V
    pg.click("#bt-first-trade"); pg.wait_for_selector("#jr-paste-shots")
    ok("Додати скріншоти" in pg.inner_text(".jr-media"), "у формі секція скріншотів")
    ok("video" not in (pg.locator("#jr-file-shots").get_attribute("accept") or ""), "приймаються лише фото")
    clip(120, 80); pg.click("#jr-paste-shots"); pg.wait_for_selector(".jr-thumb.is-pending")
    pg.fill("#bt-f-r", "2"); pg.focus("#bt-f-r"); clip(60, 40); pg.keyboard.press("Control+V")
    pg.locator(".jr-thumb.is-pending").nth(1).wait_for()
    eq(pg.input_value("#bt-f-r"), "2", "Ctrl+V із зображенням не псує текст у полі")
    # ще не збережений скріншот відкривається на весь екран
    pg.click(".jr-thumb.is-pending .jr-thumb-open >> nth=0"); pg.wait_for_selector("dialog.is-lightbox[open] .jr-vw-stage img")
    eq(pg.locator(".jr-vw-count").inner_text(), "1 / 2", "у перегляді обидва скріншоти")
    pg.keyboard.press("Escape"); pg.wait_for_selector("dialog.is-lightbox", state="detached")
    # Esc у формі з доданими скріншотами питає підтвердження
    pg.keyboard.press("Escape"); pg.wait_for_selector("dialog[open] .jr-btn.is-danger")
    ok("скріншоти" in pg.inner_text("dialog[open]:last-of-type"), "попередження про незбережені скріншоти")
    pg.click("dialog[open]:last-of-type .jr-btn:not(.is-danger)")
    pg.wait_for_selector("#bt-f-r")
    eq(pg.locator(".jr-thumb.is-pending").count(), 2, "після «Скасувати» форма й скріншоти на місці")
    # збереження й додати ще: секція очищується
    pg.click("#bt-save-next"); pg.wait_for_selector("#bt-trade-status:not(:empty)")
    eq(pg.locator(".jr-thumb").count(), 0, "для наступної угоди скріншотів немає")
    pg.fill("#bt-f-r", "-1"); pg.click("#bt-save-trade"); pg.wait_for_selector("dialog[open]", state="detached")
    pg.wait_for_selector("#bt-list tr")
    rows = pg.eval_on_selector_all("#bt-list tr", "rs => rs.map(r => r.querySelector('.bt-shots').textContent.trim())")
    eq(rows, ["—", "📷 2"], "в таблиці видно кількість скріншотів (нові зверху)")
    ok("Скріншоти" in pg.inner_text("#bt-trades thead"), "колонка «Скріншоти»")
    # клік по 📷 відкриває перегляд, а не форму
    pg.click("#bt-list tr >> nth=1 >> .bt-shot"); pg.wait_for_selector("dialog.is-lightbox[open] .jr-vw-stage img")
    eq((pg.locator("dialog[open]").count(), pg.locator(".jr-vw-count").inner_text()), (1, "1 / 2"), "відкрився лише перегляд зі скріншотами")
    ok(pg.locator(".jr-vw-note").is_hidden(), "збережені скріншоти без позначки")
    pg.keyboard.press("Escape"); pg.wait_for_selector("dialog.is-lightbox", state="detached")
    # правка: збережені скріншоти видно, один видаляється, форму закрито без збереження — таблиця все одно оновилась
    pg.click("#bt-list tr >> nth=1 >> td >> nth=0"); pg.wait_for_selector("#jr-paste-shots")
    eq(pg.locator(".jr-thumb:not(.is-pending)").count(), 2, "у правці збережені скріншоти")
    pg.click(".jr-thumb >> nth=0 >> .jr-thumb-x"); pg.click("dialog[open]:last-of-type .jr-btn.is-danger")
    pg.locator(".jr-thumb").nth(1).wait_for(state="detached")
    pg.click("dialog[open] .jr-actions .jr-btn >> text=Скасувати"); pg.wait_for_selector("dialog[open]", state="detached")
    pg.wait_for_selector("#bt-list tr >> nth=1 >> .bt-shot:has-text('1')")
    # додати ще в існуючу угоду й видалити угоду
    pg.click("#bt-list tr >> nth=1 >> td >> nth=0"); pg.wait_for_selector("#jr-paste-shots")
    clip(30, 30); pg.click("#jr-paste-shots"); pg.wait_for_selector(".jr-thumb.is-pending")
    pg.click("#bt-save-trade"); pg.wait_for_selector("dialog[open]", state="detached")
    pg.wait_for_selector("#bt-list tr >> nth=1 >> .bt-shot:has-text('2')")
    pg.click("#bt-list tr >> nth=1 >> td >> nth=0"); pg.wait_for_selector("#bt-del-trade")
    pg.click("#bt-del-trade"); ok("скріншоти" in pg.inner_text("dialog[open]:last-of-type"), "підтвердження видалення згадує скріншоти")
    pg.click("dialog[open]:last-of-type .jr-btn.is-danger"); pg.wait_for_selector("dialog[open]", state="detached")
    eq(media_state(pg)["m"], [], "скріншоти видаленої угоди прибрано")
    # CSV: кількість скріншотів
    no_errors(pg)
    ctx.close()


def t_shots_backup_sync(env):
    # резервна копія
    pg = env.page()
    cid = mk_col(pg, "Копія зі скріншотами"); t = mk_tr(pg, cid, 1)
    shot(pg, t["id"], 33, 22)
    pg.evaluate("async () => { window.__bk = (await JL.backupCreate()).blob; }")
    expect_ok(pg, "del", f"/backtests/{cid}")
    eq(media_state(pg)["m"], [], "усе видалено")
    r = pg.evaluate("async () => JL.backupRestore(new File([window.__bk], 'k.zip'))")
    eq((r["backtests"], r["bt_trades"], r["media"]), (1, 1, 1), "відновлено колекцію, угоду й скріншот")
    got = expect_ok(pg, "get", f"/backtest-trades/{t['id']}/media")["media"]
    nat = pg.evaluate("""async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }""", got[0]["url"])
    eq(nat, [33, 22], "скріншот відкривається після відновлення")
    no_errors(pg)
    # хмара
    cloud = Cloud()
    A = device(env, cloud)
    c1 = mk_col(A, "Хмарна"); t1 = mk_tr(A, c1, 2); t2 = mk_tr(A, c1, 1)
    shot(A, t1["id"], 41, 27); shot(A, t2["id"], 10, 10)
    login(A)
    uid = "uid-a@test.io"
    eq(len(cloud.docs(uid, "media")), 2, "скріншоти в хмарі")
    B = device(env, cloud); login(B)
    eq(media_state(B)["m"], media_state(A)["m"], "B отримав скріншоти")
    got = expect_ok(B, "get", f"/backtest-trades/{t1['id']}/media")["media"]
    nat = B.evaluate("""async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }""", got[0]["url"])
    eq(nat, [41, 27], "скріншот відкривається на B")
    eq(expect_ok(B, "get", f"/backtests/{c1}")["trades"][0]["shots"], 1, "лічильник на B")
    # B видаляє скріншот, потім угоду: на A все зникає
    time.sleep(0.02)
    expect_ok(B, "del", f"/media/{got[0]['id']}")
    sync_now(B); sync_now(A)
    eq(len(media_state(A)["m"]), 1, "видалення скріншота дійшло до A")
    expect_ok(B, "del", f"/backtest-trades/{t2['id']}")
    sync_now(B); sync_now(A)
    st = media_state(A)
    eq((st["m"], st["b"]), ([], 0), "видалення угоди прибрало скріншот на A")
    # видалення колекції зі скріншотами
    t3 = mk_tr(A, c1, 3); shot(A, t3["id"], 12, 12); sync_now(A); sync_now(B)
    eq(len(media_state(B)["m"]), 1, "новий скріншот дійшов до B")
    expect_ok(A, "del", f"/backtests/{c1}"); sync_now(A); sync_now(B)
    st = media_state(B)
    eq((st["m"], st["b"]), ([], 0), "видалення колекції прибрало скріншоти на B")
    no_errors(A); no_errors(B)


TESTS = [("db_upgrade", t_db_upgrade), ("api", t_api), ("ui_flow", t_ui_flow), ("ui_mobile", t_ui_mobile), ("backup", t_backup), ("sync", t_sync),
         ("shots_api", t_shots_api), ("shots_ui", t_shots_ui), ("shots_backup_sync", t_shots_backup_sync)]

if __name__ == "__main__":
    import sys
    sys.exit(run(TESTS, sys.argv[1] if len(sys.argv) > 1 else None))
