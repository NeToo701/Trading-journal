"""Основні браузерні перевірки: інтерфейс, локальний API, файли, імпорт, експорт, резервні копії."""
import base64, io, json, re, zipfile
from e2e_lib import *

NOTION_CSV = (
    "Name,Date,Pair,Side,TF,Setup,Entry,SL,TP,Result,Total%,Total$,Emotions,Comment\n"
    "Позиція №1,\"July 1, 2026 10:30 AM (GMT+3)\",EURUSD,Long,\"H4, M15\",Sweep + OB,1.0800,1.0780,1.0850,TP,0.72%,$16.79,\"FOMO, Спокій\",ок\n"
    "Позиція №2,\"July 2, 2026\",EURUSD,short,H1,sweep + ob,1.0900,1.0920,1.0850,SL,-0.5%,-$12.5,Лудоманія,\n"
    "Позиція №3,,GBPUSD,Long,,,,,,,,,,без дати\n"
    "Позиція №4,\"July 3, 2026\",EURUSD,short,H1,Breaker,1.0900,1.0920,1.0850,Вручну,0.1%,2,,\n")


def mk_journal(pg, name="Тест", market="crypto"):
    return expect_ok(pg, "post", "/journals", {"name": name, "market": market})["journal"]["id"]


def mk_entry(pg, jid, **data):
    d = {"opened_at": "2026-03-01T10:00", "symbol": "BTCUSDT", "direction": "Лонг"}
    d.update(data)
    return expect_ok(pg, "post", f"/journals/{jid}/entries", {"data": d})["entry"]


def upload(pg, eid, field, name, kind="png", size=(40, 30), noise=False):
    return pg.evaluate("""async ([eid, field, name, kind, size, noise]) => {
      const blob = kind === 'png' ? await __t.png(size[0], size[1], noise) : __t.mp4();
      try { return { ok: await JL.api.upload(`/entries/${eid}/media?field=${field}&name=${encodeURIComponent(name)}`, blob) }; }
      catch (e) { return { error: e.message, status: e.status }; }
    }""", [eid, field, name, kind, list(size), noise])


def t_ui_flow(env):
    pg = env.page()
    ok("Створи свій перший журнал" in pg.inner_text("#jr-main"), "порожній екран пропонує створити журнал")
    pg.click("text=Журнал для: крипта")
    pg.fill("#jr-prompt-input", "Мій журнал")
    pg.click("dialog[open] button:has-text('Створити')")
    pg.wait_for_selector("#jr-new")
    ok("Мій журнал" in pg.inner_text("#jr-h1"), "журнал створено")
    pg.click("#jr-new")
    pg.wait_for_selector("#jr-f-symbol")
    pg.fill("#jr-f-symbol", "BTCUSDT")
    pg.select_option("#jr-f-direction", "Лонг")
    pg.fill("#jr-f-pnl", "12,5")
    pg.fill("#jr-f-entry", "100"); pg.fill("#jr-f-stop", "95"); pg.fill("#jr-f-exit", "110")
    pg.select_option("#jr-f-outcome", "Тейк-профіт")
    pg.click("dialog[open] button[type=submit]")
    pg.wait_for_selector("#jr-list tr.jr-row", timeout=5000)
    txt = pg.inner_text("#jr-list")
    ok("BTCUSDT" in txt and "12,5" in txt, f"запис у списку: {txt[:120]!r}")
    # дані переживають перезавантаження
    pg.reload(); pg.wait_for_selector("#jr-list")
    pg.wait_for_selector("#jr-list tr.jr-row:has-text('BTCUSDT')")
    ok(True, "запис після перезавантаження")
    # вкладки статистики й розбору
    pg.click("#jr-tab-stats"); pg.wait_for_timeout(300)
    ok("1" in pg.inner_text("#jr-panel"), "вкладка статистики відкривається")
    pg.click("#jr-tab-review"); pg.wait_for_timeout(300)
    # експорт CSV: файл завантажується
    pg.click("#jr-tab-entries")
    with pg.expect_download() as d:
        pg.click("#jr-export")
    path = d.value.path()
    raw = open(path, "rb").read()
    ok(raw.startswith(b"\xef\xbb\xbf") and "BTCUSDT".encode() in raw and d.value.suggested_filename.endswith(".csv"), "експорт CSV: BOM, дані, ім'я файла")
    # перейменування й валюта
    pg.click("#jr-rename"); pg.fill("#jr-ed-name", "Новий"); pg.fill("#jr-ed-cur", "eur"); pg.click("dialog[open] button[type=submit]")
    pg.wait_for_selector("#jr-h1:text-is('Новий')")
    ok("EUR" in pg.inner_text(".jr-title"), "валюта оновилась у верхньому регістрі")
    # видалення журналу
    pg.click("#jr-delete"); pg.click("dialog[open] button:has-text('Видалити журнал')")
    pg.wait_for_selector("text=Створи свій перший журнал")
    ok(True, "журнал видалено")
    no_errors(pg)


def t_api_journals_and_entries(env):
    pg = env.page()
    meta = expect_ok(pg, "get", "/meta")
    eq([m["id"] for m in meta["markets"]], ["crypto", "forex"], "ринки")
    ok(meta["limits"]["quota_mb"] > 0, "квота відома")
    j1 = mk_journal(pg, "Крипта", "crypto")
    j2 = mk_journal(pg, "Форекс", "forex")
    expect_err(pg, 409, "post", "/journals", {"name": "крипта", "market": "crypto"}, "дубль назви в ринку")
    expect_ok(pg, "post", "/journals", {"name": "крипта", "market": "forex"}, "та сама назва в іншому ринку")
    expect_err(pg, 422, "post", "/journals", {"name": "", "market": "crypto"}, "порожня назва")
    expect_err(pg, 422, "post", "/journals", {"name": "x", "market": "stocks"}, "невідомий ринок")
    expect_err(pg, 422, "post", "/journals", {"name": "x", "market": "crypto", "currency": "12345"}, "валюта з цифр")
    js = expect_ok(pg, "get", "/journals")["journals"]
    eq([j["name"] for j in js if j["market"] == "crypto"], ["Крипта"], "список журналів")
    eq(expect_ok(pg, "patch", f"/journals/{j1}", {"name": "Крипта 2", "currency": "usdt"})["journal"]["currency"], "USDT", "PATCH журналу")
    expect_err(pg, 404, "patch", "/journals/999", {"name": "x"}, "чужий журнал")

    # записи: створення, фільтри, сортування, сторінки
    rows = [("2026-01-05T10:00", "BTCUSDT", "Лонг", "Тейк-профіт", 10, "Пробій"), ("2026-02-10T12:00", "ETHUSDT", "Шорт", "Стоп-лос", -5, "  пробій "),
            ("2026-03-15T09:00", "BTCUSDT", "Шорт", "Беззбиток", 0, "Відкат"), ("2026-03-20T09:00", "SOLUSDT", "Лонг", "Відкрита", None, "Відкат")]
    ids = []
    for o, s, d, out, pnl, setup in rows:
        data = {"opened_at": o, "symbol": s, "direction": d, "outcome": out, "setup": setup}
        if pnl is not None: data["pnl"] = pnl
        ids.append(mk_entry(pg, j1, **data)["id"])
    lst = expect_ok(pg, "get", f"/journals/{j1}/entries")
    eq(lst["total"], 4, "усього записів")
    eq([e["data"]["symbol"] for e in lst["entries"]], ["SOLUSDT", "BTCUSDT", "ETHUSDT", "BTCUSDT"], "найновіші зверху")
    eq(expect_ok(pg, "get", f"/journals/{j1}/entries?limit=2&offset=1")["entries"][0]["data"]["symbol"], "BTCUSDT", "сторінки")
    eq(expect_ok(pg, "get", f"/journals/{j1}/entries?limit=2&offset=1")["total"], 4, "total не залежить від сторінки")
    f = lambda q: [e["data"]["symbol"] for e in expect_ok(pg, "get", f"/journals/{j1}/entries?{q}")["entries"]]
    eq(f("q=eth"), ["ETHUSDT"], "пошук без урахування регістру"); eq(f("direction=Шорт"), ["BTCUSDT", "ETHUSDT"], "фільтр напрямку")
    eq(f("outcome=win"), ["BTCUSDT"], "фільтр статусу win"); eq(f("outcome=loss"), ["ETHUSDT"], "фільтр статусу loss")
    eq(f("from=2026-02-01&to=2026-03-16"), ["BTCUSDT", "ETHUSDT"], "фільтр дат")
    eq(f("q=%D0%9F%D0%A0%D0%9E"), ["ETHUSDT", "BTCUSDT"], "пошук кирилицею")
    expect_err(pg, 400, "get", f"/journals/{j1}/entries?limit=abc", None, "limit не число")
    # сетапи: однакове написання підхоплюється
    setups = expect_ok(pg, "get", f"/journals/{j1}/setups")["setups"]
    eq([(s["name"], s["count"]) for s in setups], [("Відкат", 2), ("Пробій", 2)], "сетапи об'єднані за написанням")
    # оновлення, валідація
    e = expect_ok(pg, "put", f"/entries/{ids[0]}", {"data": {"opened_at": "2026-01-05T10:00", "symbol": "btc", "pnl": "7,5"}})["entry"]
    eq(e["data"]["pnl"], 7.5, "число з комою"); ok(e["updated_at"] >= e["created_at"], "updated_at")
    expect_err(pg, 422, "put", f"/entries/{ids[0]}", {"data": {"symbol": "x"}}, "без дати входу")
    expect_err(pg, 422, "put", f"/entries/{ids[0]}", {"data": {"opened_at": "2026-01-05T10:00", "pnl": "abc"}}, "не число")
    expect_err(pg, 422, "post", f"/journals/{j1}/entries", {"data": {"opened_at": "2026-01-05T10:00", "ghost": 1}}, "невідоме поле")
    eq(expect_ok(pg, "get", f"/entries/{ids[0]}")["entry"]["data"]["symbol"], "btc", "GET запису")
    expect_err(pg, 404, "get", "/entries/12345", None, "немає запису")
    expect_ok(pg, "del", f"/entries/{ids[1]}")
    eq(expect_ok(pg, "get", f"/journals/{j1}/entries")["total"], 3, "запис видалено")
    # статистика й розбір місяця
    st = expect_ok(pg, "get", f"/journals/{j1}/stats?group=month")
    ok(st["summary"]["trades"] >= 1, "статистика рахується")
    expect_err(pg, 400, "get", f"/journals/{j1}/stats?group=decade", None, "невірна група")
    rv = expect_ok(pg, "get", f"/journals/{j1}/review?month=2026-03")
    eq(rv["data"]["conclusion"] if "conclusion" in rv["data"] else "", "", "порожній розбір")
    keys = list(rv["data"].keys())
    saved = expect_ok(pg, "put", f"/journals/{j1}/review?month=2026-03", {"data": {keys[0]: "Нотатка"}})
    eq(saved["data"][keys[0]], "Нотатка", "розбір збережено")
    expect_err(pg, 400, "get", f"/journals/{j1}/review?month=2026-13", None, "невірний місяць")
    expect_err(pg, 422, "put", f"/journals/{j1}/review?month=2026-03", {"data": [1]}, "розбір не об'єкт")
    # видалення журналу прибирає все
    expect_ok(pg, "del", f"/journals/{j1}")
    expect_err(pg, 404, "get", f"/journals/{j1}/entries", None, "журнал зник")
    eq(pg.evaluate("JL.db.tx(['entries','reviews'], 'readonly', async t => [(await t.all('entries')).length, (await t.all('reviews')).length])"), [0, 0], "каскадне видалення")
    no_errors(pg)


def t_api_fields(env):
    pg = env.page()
    j = mk_journal(pg)
    fields = expect_ok(pg, "get", f"/journals/{j}/fields")["fields"]
    keys = [f["key"] for f in fields]
    ok("opened_at" in keys and "media" in keys, "стандартні поля")
    e = mk_entry(pg, j, notes="Нотатка", pnl=5)
    custom = fields + [{"label": "Мій індикатор", "type": "number", "table": True}, {"label": "Теги", "type": "multiselect", "options": ["a", "b"]}]
    new = expect_ok(pg, "put", f"/journals/{j}/fields", {"fields": custom})["fields"]
    ck = [f["key"] for f in new if f["key"].startswith("c_")]
    eq(len(ck), 2, "додано власні поля")
    expect_ok(pg, "put", f"/entries/{e['id']}", {"data": {"opened_at": "2026-03-01T10:00", ck[0]: "42", ck[1]: ["a"]}})
    eq(expect_ok(pg, "get", f"/entries/{e['id']}")["entry"]["data"][ck[0]], 42, "значення власного поля")
    # видалення власного поля чистить дані
    kept = [f for f in new if f["key"] != ck[0]]
    expect_ok(pg, "put", f"/journals/{j}/fields", {"fields": kept})
    ok(ck[0] not in expect_ok(pg, "get", f"/entries/{e['id']}")["entry"]["data"], "значення видаленого поля прибрано із записів")
    expect_err(pg, 422, "put", f"/journals/{j}/fields", {"fields": [f for f in kept if f["key"] != "pnl"]}, "вбудоване поле не можна видалити")
    expect_err(pg, 422, "put", f"/journals/{j}/fields", {"fields": []}, "порожній список")
    # додаткове поле для файлів, а потім його видалення прибирає файли
    withm = kept + [{"label": "Графіки", "type": "media"}]
    nf = expect_ok(pg, "put", f"/journals/{j}/fields", {"fields": withm})["fields"]
    mk = [f["key"] for f in nf if f["type"] == "media" and f["key"] != "media"][0]
    r = upload(pg, e["id"], mk, "g.png"); ok("ok" in r, f"файл у новому полі {r}")
    expect_ok(pg, "put", f"/journals/{j}/fields", {"fields": [f for f in nf if f["key"] != mk]})
    eq(expect_ok(pg, "get", f"/entries/{e['id']}")["entry"]["media"], [], "файли видаленого поля прибрано")
    eq(pg.evaluate("JL.db.tx(['blobs'], 'readonly', t => t.keys('blobs'))"), [], "blob теж прибрано")
    no_errors(pg)


def t_api_media(env):
    pg = env.page()
    j = mk_journal(pg); e = mk_entry(pg, j)
    r = upload(pg, e["id"], "media", "скрін 1.png", size=(60, 40))
    ok("ok" in r and r["ok"]["media"]["mime"] == "image/png" and r["ok"]["media"]["url"].startswith("blob:"), f"фото завантажено {str(r)[:150]}")
    got = expect_ok(pg, "get", f"/entries/{e['id']}")["entry"]
    eq(len(got["media"]), 1, "файл у записі"); eq(got["media"][0]["name"], "скрін 1.png", "ім'я збережено")
    nat = pg.evaluate("""async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }""", got["media"][0]["url"])
    eq(nat, [60, 40], "фото відкривається за blob-адресою")
    ok("ok" in upload(pg, e["id"], "media", "v.mp4", kind="mp4"), "відео приймається")
    r = pg.evaluate("""async ([eid]) => { try { return { ok: await JL.api.upload(`/entries/${eid}/media?field=media&name=x.png`, new Blob(['not an image at all'])) }; } catch (e) { return { status: e.status, error: e.message }; } }""", [e["id"]])
    eq(r.get("status"), 415, "не фото й не відео відхилено за вмістом")
    r = pg.evaluate("""async ([eid]) => { try { return { ok: await JL.api.upload(`/entries/${eid}/media?field=media&name=x.png`, new Blob([])) }; } catch (e) { return { status: e.status }; } }""", [e["id"]])
    eq(r.get("status"), 400, "порожній файл")
    r = upload(pg, e["id"], "symbol", "x.png"); eq(r.get("status"), 422, "файл у не-файлове поле")
    r = upload(pg, 999, "media", "x.png"); eq(r.get("status"), 404, "файл до неіснуючого запису")
    for i in range(18): upload(pg, e["id"], "media", f"{i}.png", size=(8, 8))
    r = upload(pg, e["id"], "media", "extra.png", size=(8, 8)); eq(r.get("status"), 422, "ліміт 20 файлів до запису")
    meta = expect_ok(pg, "get", "/meta"); ok(meta["limits"]["used_bytes"] > 0, "зайняте місце рахується")
    mid = got["media"][0]["id"]
    expect_ok(pg, "del", f"/media/{mid}"); expect_err(pg, 404, "del", f"/media/{mid}", None, "повторне видалення файла")
    expect_ok(pg, "del", f"/entries/{e['id']}")
    eq(pg.evaluate("JL.db.tx(['blobs','media'], 'readonly', async t => [(await t.keys('blobs')).length, (await t.all('media')).length])"), [0, 0], "запис видалено разом із файлами")
    # великі фото: ліміт 10 МБ
    r = pg.evaluate("""async () => { try { await JL.api.upload('/entries/1/media', new Blob([new Uint8Array(11 * 1048576)])); } catch (e) { return e.status; } }""")
    ok(r in (404, 415), "завеликий/невалідний файл відхилено")
    no_errors(pg)


def t_import_csv_and_zip(env):
    pg = env.page()
    j = mk_journal(pg, "Notion", "forex")
    up = lambda name, data: pg.evaluate("""async ([j, name, b64]) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); try { return { ok: await JL.api.upload(`/journals/${j}/import?name=${encodeURIComponent(name)}`, new Blob([bytes])) }; } catch (e) { return { error: e.message, status: e.status }; } }""", [j, name, base64.b64encode(data).decode()])
    info = up("trades.csv", NOTION_CSV.encode())["ok"]
    m = {c["name"]: c["target"] for c in info["columns"]}
    ok(info["kind"] == "csv" and info["rows"] == 4, "аналіз CSV")
    ok(m["Date"] == "opened_at" and m["Pair"] == "symbol" and m["Side"] == "direction" and m["TF"] == "timeframe", f"зіставлення {m}")
    ok(m["SL"] == "stop" and m["TP"] == "take" and m["Result"] == "outcome" and m["Total%"] == "pct" and m["Total$"] == "pnl", f"зіставлення 2 {m}")
    mapping = dict(m); mapping["Comment"] = "notes"; mapping["Name"] = "notes"
    res = expect_ok(pg, "post", f"/journals/{j}/import/{info['token']}", {"mapping": mapping})
    ok(res["created"] == 3 and res["failed_total"] == 1 and res["failed"][0]["row"] == 4 and "дати" in res["failed"][0]["message"], f"результат імпорту {res}")
    rows = {e["data"]["notes"].split("\n")[0]: e["data"] for e in expect_ok(pg, "get", f"/journals/{j}/entries")["entries"]}
    r1 = rows.get("Name: Позиція №1")
    ok(r1 is not None, "перший рядок імпортовано")
    if r1:
        ok(r1["opened_at"] == "2026-07-01T10:30" and r1["direction"] == "Лонг" and r1["timeframe"] == ["4h", "15m"] and r1["entry"] == 1.08, f"дані 1 {r1}")
        ok(r1["outcome"] == "Тейк-профіт" and r1["pct"] == 0.72 and r1["pnl"] == 16.79 and r1["setup"] == "Sweep + OB", "дані 1б")
    r2 = rows.get("Name: Позиція №2")
    ok(r2 and r2["direction"] == "Шорт" and r2["opened_at"] == "2026-07-02T00:00" and r2["pnl"] == -12.5 and r2["setup"] == "Sweep + OB", "сетап під уже наявною назвою")
    # повторний імпорт без дублів, із дублями на вимогу
    info = up("trades.csv", NOTION_CSV.encode())["ok"]
    again = expect_ok(pg, "post", f"/journals/{j}/import/{info['token']}", {"mapping": mapping})
    ok(again["created"] == 0 and again["duplicates"] == 3, f"дублі {again}")
    info = up("trades.csv", NOTION_CSV.encode())["ok"]
    forced = expect_ok(pg, "post", f"/journals/{j}/import/{info['token']}", {"mapping": mapping, "skip_duplicates": False})
    eq(forced["created"], 3, "дублі на вимогу"); eq(expect_ok(pg, "get", f"/journals/{j}/entries")["total"], 6, "усього 6")
    expect_err(pg, 404, "post", f"/journals/{j}/import/{'0' * 32}", {"mapping": mapping}, "невідомий токен")
    info = up("trades.csv", NOTION_CSV.encode())["ok"]
    expect_err(pg, 422, "post", f"/journals/{j}/import/{info['token']}", {"mapping": {"Pair": "symbol"}}, "без дати входу")
    expect_err(pg, 422, "post", f"/journals/{j}/import/{info['token']}", {"mapping": {}}, "порожнє зіставлення")
    # ZIP із Notion і скріншотами сторінок
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Export/Trades abcdef0123456789abcdef0123456789.csv", NOTION_CSV)
        for title, imgs in {"Позиція №1": [("a.png", png), ("b.png", png), ("fake.png", b"not an image at all....")], "Позиція №2": [("c.png", png)]}.items():
            for n, b in imgs:
                z.writestr(f"Export/Trades/{title} abcdef0123456789abcdef0123456789/{n}", b)
            z.writestr(f"Export/Trades/{title} abcdef0123456789abcdef0123456789.md", "x")
    j2 = mk_journal(pg, "Zip", "forex")
    r = pg.evaluate("""async ([j, b64]) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); try { return { ok: await JL.api.upload(`/journals/${j}/import?name=n.zip`, new Blob([bytes])) }; } catch (e) { return { error: e.message, status: e.status }; } }""", [j2, base64.b64encode(buf.getvalue()).decode()])
    zinfo = r.get("ok"); ok(zinfo is not None, f"аналіз ZIP {r}")
    if zinfo:
        ok(zinfo["kind"] == "zip" and zinfo["images_rows"] == 2 and zinfo["rows"] == 4, f"ZIP: {zinfo['kind']} {zinfo['images_rows']} {zinfo['rows']}")
        zres = expect_ok(pg, "post", f"/journals/{j2}/import/{zinfo['token']}", {"mapping": {c["name"]: c["target"] for c in zinfo["columns"]}})
        ok(zres["created"] == 3 and zres["media_added"] == 3, f"ZIP імпорт {zres}")
        by = {e["data"].get("pnl"): e for e in expect_ok(pg, "get", f"/journals/{j2}/entries")["entries"]}
        eq((len(by[16.79]["media"]), len(by[-12.5]["media"])), (2, 1), "скріншоти прикріплено до угод")
        eq(by[16.79]["media"][0]["mime"], "image/png", "mime")
    # поламані файли
    for name, data in (("x", b"PK\x03\x04 broken"), ("x", b""), ("x.csv", "Колонка\n".encode())):
        r = up(name, data); ok(r.get("status") in (400, 422), f"поганий файл {name!r}: {r}")
    # кодування Windows-1251 і UTF-16 з BOM
    for enc, label in (("cp1251", "cp1251"), ("utf-16", "utf-16")):
        text = "Пара;Дата;Результат\nБТК;05.01.2026;12,5\n"
        r = up("t.csv", text.encode(enc)); ok("ok" in r and r["ok"]["columns"][0]["name"] == "Пара", f"{label}: {str(r)[:120]}")
    # круговий шлях: експорт журналу сайту й імпорт назад розпізнається автоматично
    j3 = mk_journal(pg, "Круг", "crypto")
    mk_entry(pg, j3, symbol="ETHUSDT", direction="Шорт", pnl=-3.5, outcome="Стоп-лос", setup="Тест", timeframe=["1h", "4h"], notes="a\nb", opened_at="2026-04-01T08:15")
    csv = pg.evaluate("""async (j) => (await (await JL.exportCsv(j)).blob.text())""", j3)
    bom = pg.evaluate("""async (j) => Array.from(new Uint8Array(await (await JL.exportCsv(j)).blob.slice(0, 3).arrayBuffer()))""", j3)
    eq(bom, [0xEF, 0xBB, 0xBF], "CSV починається з BOM (для Excel)")
    ok("ETHUSDT" in csv and "1h; 4h" in csv, "експорт містить дані")
    j4 = mk_journal(pg, "Назад", "crypto")
    r = pg.evaluate("""async ([j, text]) => ({ ok: await JL.api.upload(`/journals/${j}/import?name=e.csv`, new Blob([text])) })""", [j4, csv]); info = r["ok"]
    tg = {c["name"]: c["target"] for c in info["columns"]}
    ok(tg.get("Інструмент") == "symbol" and tg.get("Напрямок") == "direction" and tg.get("Дата й час входу") == "opened_at" and tg.get("Дотримання плану") == "discipline" and tg.get("Файлів") == "", f"власний експорт розпізнається {tg}")
    no_errors(pg)


def t_export_csv_details(env):
    pg = env.page()
    j = mk_journal(pg)
    mk_entry(pg, j, symbol="=HYPERLINK(1)", notes="+cmd", setup="@x", direction="Лонг")
    csv = pg.evaluate("""async (j) => (await (await JL.exportCsv(j)).blob.text())""", j)
    ok("'=HYPERLINK(1)" in csv and "'+cmd" in csv and "'@x" in csv, "захист від формул в Excel")
    header = csv.lstrip(chr(0xfeff)).split("\n")[0].strip()
    ok(header.endswith("Файлів") and "Інструмент" in header, f"заголовок {header[:80]}")
    expect_err(pg, 404, "get", "/journals/1/entries")
    no_errors(pg)


def t_backup_restore(env):
    pg = env.page()
    j = mk_journal(pg, "Копія"); e1 = mk_entry(pg, j, symbol="AAA"); e2 = mk_entry(pg, j, symbol="BBB", opened_at="2026-03-02T10:00")
    upload(pg, e1["id"], "media", "a.png", size=(50, 20)); upload(pg, e2["id"], "media", "v.mp4", kind="mp4")
    expect_ok(pg, "put", f"/journals/{j}/review?month=2026-03", {"data": {"conclusion": "Висновок"}})
    snap = lambda: pg.evaluate("""async () => JL.db.tx(['journals','entries','reviews','media','blobs'], 'readonly', async t => ({
        j: await t.all('journals'), e: await t.all('entries'), r: await t.all('reviews'), m: (await t.all('media')).map(m => [m.id, m.name, m.mime, m.size]), b: (await t.keys('blobs')).length }))""")
    before = snap()
    zipb64 = pg.evaluate("""async () => { const { blob, counts, name } = await JL.backupCreate(); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192)); window.__bk = blob; return [btoa(s), counts, name]; }""")
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(zipb64[0])))
    names = z.namelist()
    ok("data.json" in names and sum(n.startswith("media/") for n in names) == 2, f"склад копії {names}")
    ok(zipb64[2].startswith("zhurnal-kopiya-") and zipb64[1]["entries"] == 2, "ім'я та лічильники")
    ok(z.testzip() is None, "ZIP валідний (CRC)")
    # повне стирання й відновлення
    pg.evaluate("JL.db.clearAll(true)"); pg.evaluate("JL.mediaUrls.dropAll()")
    eq(snap()["e"], [], "після стирання порожньо")
    r = pg.evaluate("JL.backupRestore(window.__bk)")
    eq((r["journals"], r["entries"], r["reviews"], r["media"]), (1, 2, 1, 2), "лічильники відновлення")
    after = snap()
    eq(after, before, "дані після відновлення ідентичні")
    got = expect_ok(pg, "get", f"/entries/{e1['id']}")["entry"]
    nat = pg.evaluate("""async (u) => { const i = new Image(); i.src = u; await i.decode(); return i.naturalWidth; }""", got["media"][0]["url"])
    eq(nat, 50, "фото відновлено й відкривається")
    # «новіше перемагає»: відновлення старої копії не затирає свіжі зміни
    expect_ok(pg, "put", f"/entries/{e1['id']}", {"data": {"opened_at": "2026-03-01T10:00", "symbol": "ЗМІНЕНО"}})
    r = pg.evaluate("JL.backupRestore(window.__bk)")
    eq((r["entries"], r["media"]), (0, 0), "стара копія нічого не перезаписує")
    eq(expect_ok(pg, "get", f"/entries/{e1['id']}")["entry"]["data"]["symbol"], "ЗМІНЕНО", "свіжа зміна збереглась")
    # відновлення додає видалене
    expect_ok(pg, "del", f"/entries/{e2['id']}")
    pg.evaluate("JL.db.tx(['outbox'], 'readwrite', t => t.del('outbox', 'entries/' + %d))" % e2["id"])
    # (видалений запис у копії має старіший _u, тож відновлення його поверне)
    r = pg.evaluate("JL.backupRestore(window.__bk)"); eq(r["entries"], 1, "видалений запис повернувся з копії")
    # некоректні файли
    for body in ("not a zip at all, definitely not a zip file", ""):
        e = pg.evaluate("""async (t) => { try { await JL.backupRestore(new Blob([t])); } catch (e) { return e.status; } }""", body); eq(e, 422, "поганий файл копії")
    e = pg.evaluate("""async () => { const z = await JL.zipCreate([{ name: 'data.json', data: new TextEncoder().encode('{"format":"other"}') }]); try { await JL.backupRestore(z); } catch (e) { return [e.status, e.message]; } }""")
    eq(e[0], 422, "чужий data.json")
    no_errors(pg)


def t_persistence_after_reload(env):
    pg = env.page()
    j = mk_journal(pg); e = mk_entry(pg, j, symbol="PERSIST"); upload(pg, e["id"], "media", "p.png", size=(33, 22))
    pg.reload(); pg.wait_for_selector("#jr-side:not([hidden])"); pg.evaluate(HELPERS)
    js = expect_ok(pg, "get", "/journals")["journals"]
    eq([(x["name"], x["entries"]) for x in js], [("Тест", 1)], "журнал і лічильник після перезавантаження")
    got = expect_ok(pg, "get", f"/entries/{e['id']}")["entry"]
    nat = pg.evaluate("""async (u) => { const i = new Image(); i.src = u; await i.decode(); return i.naturalWidth; }""", got["media"][0]["url"])
    eq(nat, 33, "фото після перезавантаження")
    # інший контекст (інший «браузер») порожній: дані не витікають
    pg2 = env.page()
    eq(expect_ok(pg2, "get", "/journals")["journals"], [], "інший профіль порожній")
    no_errors(pg)


def t_ids_and_limits(env):
    pg = env.page()
    ids = pg.evaluate("Array.from({length: 2000}, () => JL.db.nextId())")
    ok(len(set(ids)) == 2000 and ids == sorted(ids), "ідентифікатори унікальні й зростають")
    ok(all(i < 2**53 for i in ids), "ідентифікатори безпечні для JS-чисел")
    for i in range(20): mk_journal(pg, f"Ж{i}")
    expect_err(pg, 422, "post", "/journals", {"name": "Ж21", "market": "crypto"}, "ліміт 20 журналів")
    no_errors(pg)


def t_offline_pwa(env):
    ctx = env.browser.new_context(viewport={"width": 1000, "height": 800})
    pg = env.page(ctx)
    mk_journal(pg, "Офлайн")
    pg.evaluate("navigator.serviceWorker.ready.then(() => 0)")
    for _ in range(40):                                  # чекаємо, поки воркер візьме сторінку під контроль і заповнить кеш
        if pg.evaluate("!!navigator.serviceWorker.controller") and pg.evaluate("caches.keys().then(k => k.length)") >= 1: break
        pg.wait_for_timeout(250)
    pg.reload(); pg.wait_for_selector("#jr-side:not([hidden])"); pg.wait_for_timeout(500)
    ctx.set_offline(True)
    pg.reload(); pg.wait_for_selector("#jr-side:not([hidden])", timeout=8000)
    ok("Офлайн" in pg.inner_text("#jr-side"), "без інтернету застосунок відкривається з даними")
    ctx.set_offline(False)
    mf = pg.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
    eq(mf["start_url"], "./", "manifest: відносні шляхи"); ok(all(not i["src"].startswith("/") for i in mf["icons"]), "іконки з відносними шляхами")
    no_errors(pg)


TESTS = [("ui_flow", t_ui_flow), ("api_journals_and_entries", t_api_journals_and_entries), ("api_fields", t_api_fields), ("api_media", t_api_media),
         ("import_csv_and_zip", t_import_csv_and_zip), ("export_csv_details", t_export_csv_details), ("backup_restore", t_backup_restore),
         ("persistence_after_reload", t_persistence_after_reload), ("ids_and_limits", t_ids_and_limits), ("offline_pwa", t_offline_pwa)]

if __name__ == "__main__":
    import sys
    sys.exit(run(TESTS, sys.argv[1] if len(sys.argv) > 1 else None))
