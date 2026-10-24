"""Браузерні перевірки правок: налаштовуваний «Розбір місяця» (блоки, статистика з формулами, поля, питання по угоді), нові назви
помилок і сховані питання розбору, міграція старих журналів, Winrate, згортання бічної панелі, кнопка «Вставити», перегляд фото на весь екран, прокрутка таблиці."""
import json
from e2e_lib import *


def mk_journal(pg, name="Тест", market="crypto"):
    return expect_ok(pg, "post", "/journals", {"name": name, "market": market})["journal"]["id"]


def mk_entry(pg, jid, **data):
    d = {"opened_at": "2026-03-01T10:00", "symbol": "BTCUSDT", "direction": "Лонг"}
    d.update(data)
    return expect_ok(pg, "post", f"/journals/{jid}/entries", {"data": d})["entry"]


def seed_march(pg, jid):
    """Три закриті угоди в березні 2026: +30, -10, -20 (одна прибуткова, дві збиткові)."""
    a = mk_entry(pg, jid, opened_at="2026-03-02T10:00", outcome="Тейк-профіт", pnl=30, fees=1.5, risk_pct=1)
    b = mk_entry(pg, jid, opened_at="2026-03-03T10:00", outcome="Стоп-лос", pnl=-10, fees=0.5, risk_pct=2, mistakes=["Спішка"])
    c = mk_entry(pg, jid, opened_at="2026-03-04T10:00", outcome="Стоп-лос", pnl=-20, fees=1, risk_pct=3)
    return a, b, c


def open_review(pg, month="2026-03"):
    pg.click("#jr-tab-review")
    pg.wait_for_selector("#jr-rv-month")
    pg.select_option("#jr-rv-month", month)
    pg.wait_for_selector("#jr-rv-body .jr-card, #jr-rv-body .jr-empty")


def metric_values(pg):
    return pg.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.jr-rv-sum-i')].map(i => [i.querySelector('.jr-kpi-l').textContent, i.querySelector('.jr-kpi-v').textContent]))""")


def block_titles(pg):
    return pg.evaluate("""() => [...document.querySelectorAll('#jr-rv-body > section, #jr-rv-body > div')].map(s => (s.querySelector('h3') || {}).textContent || (s.getAttribute('aria-label') || ''))""")


def read_journal(pg, jid):
    return pg.evaluate("(id) => JL.db.tx(['journals'], 'readonly', (t) => t.get('journals', id))", jid)


def select_journal(pg, jid):
    pg.reload(); pg.wait_for_selector("#jr-side:not([hidden])"); pg.evaluate(HELPERS)
    pg.click(f'.jr-jbtn[data-id="{jid}"]')
    pg.wait_for_selector("#jr-panel")


# ------------------------------------------------------------------------------------------------ нові журнали
def t_new_journal_defaults(env):
    pg = env.page()
    jid = mk_journal(pg)
    fields = expect_ok(pg, "get", f"/journals/{jid}/fields")["fields"]
    hidden = [f["key"] for f in fields if f.get("hidden")]
    eq(hidden, ["by_rules", "tp_after_stop", "re_enter", "re_enter_why"], "чотири питання розбору сховані з форми запису")
    mis = next(f for f in fields if f["key"] == "mistakes")["options"]
    ok("Порушення торгового плану" in mis and "Спішка" not in mis and len(mis) == 14, f"нові назви помилок: {mis}")
    ok(all(len(o) <= 40 for o in mis), "назви помилок вкладаються в ліміт")
    # форма запису без чотирьох полів, з новими варіантами помилок
    select_journal(pg, jid)
    pg.click("#jr-new"); pg.wait_for_selector("#jr-f-symbol")
    for k in ("by_rules", "tp_after_stop", "re_enter", "re_enter_why"):
        eq(pg.locator(f"#jr-f-{k}").count(), 0, f"у формі запису немає поля {k}")
    form = pg.inner_text("dialog[open]")
    for gone in ("Чи була угода за правилами?", "Чи дійшла ціна до тейку після стопа?", "Чи зайшов би я знову в цю позицію?", "Якщо ні, то чому?"):
        ok(gone not in form, f"у формі немає «{gone}»")
    ok("Емоційне рішення" in form and "Вхід без підтвердження сигналу" in form and "Погоня за рухом" not in form, "у формі нові варіанти ключових помилок")
    pg.click("dialog[open] button:has-text('Скасувати')")
    # поля лишаються доступні: у «Полях» їх можна повернути у форму
    pg.click("#jr-fields"); pg.wait_for_selector(".jr-schema-list")
    row = pg.locator("li.jr-schema-row:has(input[value='Чи була угода за правилами?'])")
    eq(row.locator("input[type=checkbox]").first.is_checked(), False, "у редакторі полів «У формі» вимкнено для схованого питання")
    row.locator("input[type=checkbox]").first.check()
    pg.click("dialog[open] button:has-text('Зберегти поля')"); pg.wait_for_selector("dialog[open]", state="detached")
    pg.click("#jr-new"); pg.wait_for_selector("#jr-f-by_rules")
    ok(True, "сховане питання можна повернути у форму через «Поля»")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ міграція
def t_migration(env):
    pg = env.page()
    jid = mk_journal(pg, "Старий")
    # імітуємо журнал зі старої версії: старі поля, старі назви помилок, без позначки schema_v
    pg.evaluate("""async (id) => {
      await JL.db.tx(['journals', 'entries'], 'readwrite', async (t) => {
        const j = await t.get('journals', id);
        j.fields = JL.defaultFields('crypto'); delete j.schema_v; await t.put('journals', j);
      });
    }""", jid)
    e1 = mk_entry(pg, jid, mistakes=["Спішка", "Вплив емоцій", "Моя власна"])
    e2 = mk_entry(pg, jid, opened_at="2026-03-02T10:00", mistakes=["FOMO"], by_rules="Так")
    f = expect_ok(pg, "get", f"/journals/{jid}/fields")["fields"]
    eq([x["key"] for x in f if x.get("hidden")], [], "до міграції всі питання видимі")
    n = pg.evaluate("() => JL.migrateJournals()")
    ok(n >= 1, f"міграція обробила журнали: {n}")
    f = expect_ok(pg, "get", f"/journals/{jid}/fields")["fields"]
    eq([x["key"] for x in f if x.get("hidden")], ["by_rules", "tp_after_stop", "re_enter", "re_enter_why"], "після міграції питання розбору сховані")
    mis = next(x for x in f if x["key"] == "mistakes")["options"]
    eq(mis, [m for m in __import__("json").loads(pg.evaluate("() => JSON.stringify(JL.PRO_MISTAKES)"))], "варіанти помилок замінено на нові")
    d1 = expect_ok(pg, "get", f"/entries/{e1['id']}")["entry"]["data"]
    eq(sorted(d1["mistakes"]), sorted(["Поспішний вхід", "Емоційне рішення", "Моя власна"]), "у збережених записах помилки перейменовано, власні лишились")
    d2 = expect_ok(pg, "get", f"/entries/{e2['id']}")["entry"]["data"]
    eq((d2["mistakes"], d2["by_rules"]), (["FOMO (страх упущеної вигоди)"], "Так"), "відповіді розбору не втрачено")
    j = read_journal(pg, jid)
    eq(j["schema_v"], 2, "позначка версії схеми записана")
    ob = pg.evaluate("() => JL.db.tx(['outbox'], 'readonly', (t) => t.all('outbox')).then(r => r.map(x => x.key))")
    ok(f"journals/{jid}" in ob and f"entries/{e1['id']}" in ob, "зміни поставлено в чергу синхронізації")
    # повторний запуск нічого не змінює, а вибір користувача не скидається
    f2 = [dict(x, hidden=False) if x["key"] == "by_rules" else x for x in f]
    expect_ok(pg, "put", f"/journals/{jid}/fields", {"fields": [{k: v for k, v in x.items() if k in ("key", "label", "type", "hidden", "table", "options", "help")} for x in f2]})
    eq(pg.evaluate("() => JL.migrateJournals()"), 0, "повторна міграція нічого не робить")
    f = expect_ok(pg, "get", f"/journals/{jid}/fields")["fields"]
    eq(next(x for x in f if x["key"] == "by_rules").get("hidden"), False, "повернуте користувачем питання не ховається знову")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ розбір місяця
def t_review_default_look(env):
    pg = env.page()
    jid = mk_journal(pg); seed_march(pg, jid)
    select_journal(pg, jid)
    open_review(pg)
    vals = metric_values(pg)
    eq(list(vals.keys()), ["Winrate", "Результат, %", "Результат, USDT", "Результат, R", "Угод", "Збиткових"], "типові показники підсумку")
    eq((vals["Winrate"], vals["Угод"], vals["Збиткових"]), ("33,3%", "3", "2"), "значення підсумку")
    eq(vals["Результат, USDT"], "0 USDT", "результат у валюті (+30 −10 −20 = 0)")
    titles = block_titles(pg)
    eq([t for t in titles if t], ["Підсумок місяця", "Ключові помилки місяця", "Збиткові угоди", "Висновок: березень 2026"], "порядок блоків за замовчуванням")
    # у картці угоди типові питання розбору
    card = pg.locator(".jr-rv-pos").first.inner_text()
    for q in ("Чи була угода за правилами?", "Чи дійшла ціна до тейку після стопа?", "Чи зайшов би я знову в цю позицію?", "Якщо ні, то чому?", "Ключові помилки", "Висновок"):
        ok(q in card, f"у картці угоди є питання «{q}»")
    # відповідь на питання пишеться в запис
    pg.locator(".jr-rv-pos").first.locator(".jr-choice", has_text="Так").first.click()
    pg.wait_for_timeout(1200)
    entries = expect_ok(pg, "get", f"/journals/{jid}/entries?outcome=loss")["entries"]
    ok(any(e["data"].get("by_rules") == "Так" or e["data"].get("tp_after_stop") == "Так" for e in entries), "відповідь у картці зберігається в запис")
    # висновок місяця зберігається
    pg.fill("#jr-rv-m-summary", "Тестовий висновок"); pg.wait_for_timeout(1200)
    eq(expect_ok(pg, "get", f"/journals/{jid}/review?month=2026-03")["data"]["summary"], "Тестовий висновок", "висновок місяця збережено")
    no_errors(pg)


def t_review_config_ui(env):
    pg = env.page()
    jid = mk_journal(pg); a, b, c = seed_march(pg, jid)
    select_journal(pg, jid)
    open_review(pg)
    pg.click("#jr-rv-cfg"); pg.wait_for_selector("dialog[open] .jr-cfg-body")

    # --- блоки: сховати «Ключові помилки», підняти «Висновок» нагору
    rows = pg.locator("dialog[open] li.jr-schema-row")
    eq(rows.count(), 4, "чотири блоки")
    rows.nth(1).locator("input[type=checkbox]").uncheck()
    pg.locator("dialog[open] li.jr-schema-row").nth(3).locator(".jr-up").click()
    pg.locator("dialog[open] li.jr-schema-row").nth(2).locator(".jr-up").click()
    pg.locator("dialog[open] li.jr-schema-row").nth(1).locator(".jr-up").click()

    # --- статистика: приховати «Угод», додати власні за формулою (змінні й підсумок по полю)
    pg.click("#jr-cfg-tab-metrics")
    pg.wait_for_selector("#jr-cfg-add-metric")
    trades_row = pg.locator("dialog[open] li.jr-schema-row:has(input[value='Угод'])")
    trades_row.locator("input[type=checkbox]").uncheck()
    pg.click("#jr-cfg-add-metric")
    new = pg.locator("dialog[open] li.jr-schema-row:has(.jr-cfg-formula)").last
    new.locator("input[aria-label='Назва статистики']").fill("Угод ×10 + збиткові")
    new.locator(".jr-cfg-formula").fill("trades * 10 + losses")
    ok(new.locator(".jr-cfg-val").inner_text() == "32", f"значення формули видно одразу: {new.locator('.jr-cfg-val').inner_text()!r}")
    pg.click("#jr-cfg-add-metric")
    new2 = pg.locator("dialog[open] li.jr-schema-row:has(.jr-cfg-formula)").last
    new2.locator("input[aria-label='Назва статистики']").fill("Комісії")
    new2.locator(".jr-cfg-formula").fill("sum([Комісії])")
    new2.locator("select").first.select_option("money")
    new2.locator("select").nth(1).select_option("1")
    pg.click("#jr-cfg-add-metric")
    bad = pg.locator("dialog[open] li.jr-schema-row:has(.jr-cfg-formula)").last
    bad.locator(".jr-cfg-formula").fill("foo + 1")
    ok("Невідома змінна" in bad.locator(".jr-cfg-msg").inner_text(), "помилка формули видно під полем")
    pg.click("#jr-cfg-save")
    pg.wait_for_selector("dialog[open] .jr-error:not([hidden])")
    ok("Невідома змінна" in pg.inner_text("dialog[open] .jr-error"), "збереження з кривою формулою відхилено з поясненням")
    ok(pg.locator("dialog[open]").count() == 1, "вікно лишається відкритим при помилці")
    bad.locator(".jr-cfg-formula").fill("sum([Ризик, % від депозиту]) + count([Ризик, % від депозиту]) * 0")
    # вставка змінної й поля кнопками
    pg.locator("dialog[open] details.jr-cfg-help summary").click()
    bad.locator(".jr-cfg-formula").fill("")
    bad.locator(".jr-cfg-formula").focus()
    pg.locator("dialog[open] .jr-cfg-var", has_text="win_rate").first.click()
    eq(bad.locator(".jr-cfg-formula").input_value(), "win_rate", "змінна вставляється кнопкою")
    bad.locator(".jr-cfg-formula").press("End")
    bad.locator(".jr-cfg-formula").type(" + 0")
    bad.locator("input[aria-label='Назва статистики']").fill("Winrate+0")

    # --- поля висновку: нове поле-оцінка
    pg.click("#jr-cfg-tab-month")
    pg.fill("dialog[open] .jr-schema-new input", "Оцінка місяця")
    pg.select_option("dialog[open] .jr-schema-new select", "rating")
    pg.click("dialog[open] .jr-schema-new button")
    ok(pg.locator("dialog[open] li.jr-schema-row:has(input[value='Оцінка місяця'])").count() == 1, "нове поле висновку додано в список")
    pg.fill("dialog[open] .jr-schema-new input", "Бал")
    pg.select_option("dialog[open] .jr-schema-new select", "number")
    pg.click("dialog[open] .jr-schema-new button")

    # --- питання по угоді: сховати одне стандартне, додати нове поле-список
    pg.click("#jr-cfg-tab-pos")
    pg.locator("dialog[open] li.jr-schema-row:has(strong:text-is('Якщо ні, то чому?')) input[type=checkbox]").uncheck()
    pg.fill("dialog[open] .jr-schema-add:has(h3:text-is('Нове поле')) input", "Чи був сигнал?")
    pg.select_option("dialog[open] .jr-schema-add:has(h3:text-is('Нове поле')) select", "select")
    pg.click("dialog[open] .jr-schema-add:has(h3:text-is('Нове поле')) button:has-text('Додати поле')")
    ok(pg.locator("dialog[open] li.jr-schema-row:has(input[value='Чи був сигнал?'])").count() == 1, "нове питання в списку")
    pg.click("#jr-cfg-save")
    pg.wait_for_selector("dialog[open]", state="detached", timeout=8000)

    # --- результат на сторінці
    pg.wait_for_selector("#jr-rv-body .jr-rv-sum")
    vals = metric_values(pg)
    ok("Угод" not in vals, "прихована статистика зникла з підсумку")
    eq(vals.get("Угод ×10 + збиткові"), "32", "власна статистика за формулою")
    eq(vals.get("Комісії"), "+3 USDT", "підсумок по полі журналу (sum([Комісії])) у форматі «гроші»")
    ok("Winrate+0" in vals and vals["Winrate+0"] == "33,3", f"власна статистика зі змінною: {vals.get('Winrate+0')!r}")
    titles = [t for t in block_titles(pg) if t]
    eq(titles, ["Висновок: березень 2026", "Підсумок місяця", "Збиткові угоди"], "блок схований, порядок змінено")
    ok(pg.locator("#jr-rv-m-summary").count() == 1, "поля висновку на місці")
    ok(pg.locator(".jr-rv-mgrid .jr-star").count() == 5, "нове поле-оцінка в висновку")
    card = pg.locator(".jr-rv-pos").first.inner_text()
    ok("Якщо ні, то чому?" not in card and "Чи був сигнал?" in card, "питання по угоді: одне сховано, нове додано")
    # нове поле журналу створено, у формі запису воно сховане
    fields = expect_ok(pg, "get", f"/journals/{jid}/fields")["fields"]
    sig = next(f for f in fields if f["label"] == "Чи був сигнал?")
    eq((sig["type"], sig.get("hidden"), sig["options"]), ("select", True, ["Так", "Ні"]), "створене поле: список «Так/Ні», приховане з форми")

    # --- відповіді на нові питання зберігаються
    pg.locator(".jr-rv-pos").first.locator(".jr-rv-q:has-text('Чи був сигнал?') .jr-choice", has_text="Так").click()
    pg.locator(".jr-rv-mgrid .jr-star").nth(3).click()
    pg.locator(".jr-rv-mgrid input[type=text]").first.fill("7,5")
    pg.wait_for_timeout(1300)
    ents = expect_ok(pg, "get", f"/journals/{jid}/entries?limit=10")["entries"]
    ok(any(e["data"].get(sig["key"]) == "Так" for e in ents), "відповідь на нове питання записана в запис")
    cfg = expect_ok(pg, "get", f"/journals/{jid}/review-config")["config"]
    kr = next(f for f in cfg["month_fields"] if f["type"] == "rating")["key"]
    kn = next(f for f in cfg["month_fields"] if f["type"] == "number")["key"]
    rv = expect_ok(pg, "get", f"/journals/{jid}/review?month=2026-03")["data"]
    eq((rv.get(kr), rv.get(kn)), (4, 7.5), "значення нових полів висновку збережено (оцінка 4, число 7,5)")

    # --- налаштування переживають перезавантаження; їх бачить і сама сторінка
    select_journal(pg, jid); open_review(pg)
    eq(metric_values(pg).get("Угод ×10 + збиткові"), "32", "налаштування після перезавантаження")
    eq(pg.locator(".jr-rv-mgrid .jr-star.is-on").count(), 4, "оцінка 4 після перезавантаження")
    # порожній місяць: власні формули не ламають сторінку
    pg.select_option("#jr-rv-month", "2026-03")
    # --- скидання до стандартного
    pg.click("#jr-rv-cfg"); pg.wait_for_selector("dialog[open] .jr-cfg-body")
    pg.click("#jr-cfg-reset"); pg.click("dialog[open] button:has-text('Скинути'):not(#jr-cfg-reset)")
    pg.click("#jr-cfg-save"); pg.wait_for_selector("dialog[open]", state="detached", timeout=8000)
    pg.wait_for_selector("#jr-rv-body .jr-rv-sum")
    eq(list(metric_values(pg).keys())[:3], ["Winrate", "Результат, %", "Результат, USDT"], "після скидання статистика стандартна")
    no_errors(pg)


def t_review_config_api(env):
    pg = env.page()
    jid = mk_journal(pg)
    cfg = expect_ok(pg, "get", f"/journals/{jid}/review-config")["config"]
    eq([b["id"] for b in cfg["blocks"]], ["summary", "mistakes", "positions", "conclusion"], "типова конфігурація")
    c = json.loads(json.dumps(cfg))
    c["metrics"].append({"custom": True, "visible": True, "label": "X", "formula": "1 +", "fmt": "number", "dec": 2})
    expect_err(pg, 422, "put", f"/journals/{jid}/review-config", {"config": c}, "крива формула")
    c["metrics"][-1]["formula"] = "trades + 1"
    saved = expect_ok(pg, "put", f"/journals/{jid}/review-config", {"config": c})["config"]
    ok(any(m.get("custom") and m["id"].startswith("x_") for m in saved["metrics"]), "власна статистика збережена з id")
    expect_err(pg, 422, "put", f"/journals/{jid}/review-config", {"config": {"blocks": [{"id": "bad"}]}}, "невідомий блок")
    expect_err(pg, 404, "get", "/journals/999/review-config", None, "немає журналу")
    # запис висновку: невідомі ключі ігноруються, типи перевіряються
    r = expect_ok(pg, "put", f"/journals/{jid}/review?month=2026-03", {"data": {"summary": "ok", "чужий": "x"}})["data"]
    eq((r["summary"], "чужий" in r), ("ok", False), "невідомі ключі висновку ігноруються")
    ok("ok" in call(pg, "put", f"/journals/{jid}/review?month=2026-03", {"data": {"plan": "я" * 5000}}), "5000 символів проходить")
    expect_err(pg, 422, "put", f"/journals/{jid}/review?month=2026-03", {"data": {"plan": "я" * 5001}}, "5001 символ відхилено")
    # конфіг входить у резервну копію і синхронізується разом із журналом
    j = read_journal(pg, jid)
    ok(j.get("review_cfg") and any(m.get("custom") for m in j["review_cfg"]["metrics"]), "конфіг лежить у записі журналу (синхронізується й потрапляє в копію)")
    # видалене з журналу поле зникає з питань розбору, не ламаючи сторінку
    f = expect_ok(pg, "get", f"/journals/{jid}/fields")["fields"]
    new = f + [{"label": "Тимчасове", "type": "text", "hidden": False, "table": False}]
    f2 = expect_ok(pg, "put", f"/journals/{jid}/fields", {"fields": [{k: v for k, v in x.items() if k in ("key", "label", "type", "hidden", "table", "options", "help")} for x in new]})["fields"]
    key = f2[-1]["key"]
    c = expect_ok(pg, "get", f"/journals/{jid}/review-config")["config"]
    c["pos_fields"].append({"key": key, "visible": True})
    expect_ok(pg, "put", f"/journals/{jid}/review-config", {"config": c})
    expect_ok(pg, "put", f"/journals/{jid}/fields", {"fields": [{k: v for k, v in x.items() if k in ("key", "label", "type", "hidden", "table", "options", "help")} for x in f2[:-1]]})
    c = expect_ok(pg, "get", f"/journals/{jid}/review-config")["config"]
    ok(all(p["key"] != key for p in c["pos_fields"]), "питання з видаленого поля зникає з конфігурації")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ статистика
def t_stats_winrate(env):
    pg = env.page()
    jid = mk_journal(pg); seed_march(pg, jid)
    select_journal(pg, jid)
    pg.click("#jr-tab-stats"); pg.wait_for_selector(".jr-kpis")
    labels = pg.evaluate("() => [...document.querySelectorAll('.jr-kpi-l')].map(n => n.textContent)")
    ok("Winrate" in labels and "Прибуткових" not in labels, f"у картках статистики Winrate: {labels}")
    heads = pg.evaluate("() => [...document.querySelectorAll('#jr-stat-body th')].map(n => n.textContent)")
    ok("Winrate" in heads and "Прибуткових" not in heads, f"у таблицях Winrate: {heads}")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ бічна панель
def t_sidebar_collapse(env):
    pg = env.page()
    jid = mk_journal(pg)
    select_journal(pg, jid)
    btn = pg.locator("#jr-side-collapse")
    eq(btn.get_attribute("aria-expanded"), "true", "панель розгорнута за замовчуванням")
    w0 = pg.evaluate("document.querySelector('#jr-side').getBoundingClientRect().width")
    btn.click()
    eq(btn.get_attribute("aria-expanded"), "false", "після кліку панель згорнута")
    w1 = pg.evaluate("document.querySelector('#jr-side').getBoundingClientRect().width")
    ok(w0 > 200 and w1 < 80, f"ширина панелі: було {w0}, стало {w1}")
    ok(not pg.locator(".jr-jbtn").first.is_visible(), "список журналів схований")
    ok(pg.evaluate("document.querySelector('#jr-main').getBoundingClientRect().width") > 900, "вміст зайняв звільнене місце")
    # вибір переживає перезавантаження
    pg.reload(); pg.wait_for_selector("#jr-side:not([hidden])")
    ok(pg.evaluate("document.querySelector('#jr-shell').classList.contains('is-side-collapsed')"), "після перезавантаження панель лишається згорнутою")
    eq(pg.locator("#jr-side-collapse").get_attribute("aria-label"), "Розгорнути панель журналів", "підпис кнопки")
    pg.locator("#jr-side-collapse").click()
    ok(pg.locator(".jr-jbtn").first.is_visible(), "панель розгорнулась")
    pg.reload(); pg.wait_for_selector("#jr-side:not([hidden])")
    ok(not pg.evaluate("document.querySelector('#jr-shell').classList.contains('is-side-collapsed')"), "розгорнутий стан теж зберігається")
    # на вузькому екрані згортання не заважає
    pg.locator("#jr-side-collapse").click()
    pg.set_viewport_size({"width": 700, "height": 900}); pg.wait_for_timeout(200)
    ok(not pg.locator("#jr-side-collapse").is_visible(), "на телефоні кнопки згортання немає")
    pg.click("#jr-side-toggle"); pg.wait_for_timeout(200)
    ok(pg.locator(".jr-jbtn").first.is_visible(), "на телефоні список журналів відкривається кнопкою «Журнали»")
    no_errors(pg)


# ------------------------------------------------------------------------------------------------ вставка зображення й прокрутка таблиці
def t_paste_button(env):
    ctx = env.browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    pg = env.page(ctx)
    jid = mk_journal(pg)
    select_journal(pg, jid)
    pg.click("#jr-new"); pg.wait_for_selector("#jr-paste-media")
    ok(pg.locator("#jr-paste-media").is_visible() and "Вставити" in pg.inner_text("#jr-paste-media"), "поруч із завантаженням є кнопка «Вставити»")
    box_drop = pg.locator(".jr-drop").bounding_box(); box_btn = pg.locator("#jr-paste-media").bounding_box()
    ok(box_btn["x"] > box_drop["x"] + box_drop["width"] - 2 and abs(box_btn["y"] - box_drop["y"]) < 40, "кнопка стоїть поруч (праворуч від зони завантаження)")
    # у буфері немає зображення
    pg.evaluate("navigator.clipboard.writeText('просто текст')")
    pg.click("#jr-paste-media")
    pg.wait_for_selector(".jr-media .jr-warn:not([hidden])")
    ok("немає зображення" in pg.inner_text(".jr-media .jr-warn"), "текст у буфері: зрозуміле повідомлення")
    # зображення в буфері
    pg.evaluate("""async () => { const b = await __t.png(60, 40, false); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); }""")
    pg.click("#jr-paste-media")
    pg.wait_for_selector(".jr-thumb.is-pending", timeout=5000)
    eq(pg.locator(".jr-thumb.is-pending").count(), 1, "зображення з буфера додано до запису")
    ok(pg.locator(".jr-thumb.is-pending .jr-thumb-name").inner_text().startswith("pasted-"), "ім'я файла pasted-…")
    ok(pg.locator(".jr-media .jr-warn").is_hidden(), "попередження зникло")
    pg.fill("#jr-f-symbol", "ETHUSDT")
    pg.click("dialog[open] button[type=submit]")
    pg.wait_for_selector("#jr-list tr.jr-row", timeout=5000)
    ents = expect_ok(pg, "get", f"/journals/{jid}/entries")["entries"]
    eq((len(ents), len(ents[0]["media"]), ents[0]["media"][0]["mime"]), (1, 1, "image/png"), "запис збережено разом із вставленим зображенням")
    # Ctrl+V як і раніше працює
    pg.click(".jr-row")
    pg.wait_for_selector("#jr-paste-media")
    pg.evaluate("""async () => { const b = await __t.png(30, 30, false); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); }""")
    pg.click("#jr-paste-media")
    pg.wait_for_selector(".jr-thumb.is-pending")
    eq(pg.locator(".jr-thumb").count(), 2, "до наявного файла додається ще один")
    no_errors(pg)
    ctx.close()


def t_viewer_fullscreen(env):
    """Фото (і ще не збережені, вставлені зі скріншота) відкриваються на весь екран зі зумом і гортанням."""
    ctx = env.browser.new_context(viewport={"width": 1280, "height": 800}, permissions=["clipboard-read", "clipboard-write"])
    pg = env.page(ctx)
    jid = mk_journal(pg)
    select_journal(pg, jid)
    pg.click("#jr-new"); pg.wait_for_selector("#jr-paste-media")
    pg.evaluate("""async () => { const b = await __t.png(1600, 1000, false); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); }""")
    pg.click("#jr-paste-media")
    pg.wait_for_selector(".jr-thumb.is-pending")
    # незбережене фото відкривається
    pg.click(".jr-thumb.is-pending .jr-thumb-open")
    pg.wait_for_selector("dialog.is-lightbox[open] .jr-vw-stage img")
    box = pg.locator("dialog.is-lightbox").bounding_box()
    eq((round(box["x"]), round(box["y"]), round(box["width"]), round(box["height"])), (0, 0, 1280, 800), "перегляд займає весь екран")
    img = pg.locator(".jr-vw-stage img").bounding_box()
    ok(img["width"] > 900 and img["width"] <= 1280 and img["height"] <= 800 - 40, f"фото вписане в екран: {img}")
    ok(pg.locator("dialog.is-lightbox .jr-vw-note").inner_text() == "ще не збережено", "позначка, що фото ще не збережене")
    eq(pg.locator("dialog[open]").count(), 2, "форма запису лишилась під переглядом")
    ok(pg.locator("#jr-vw-prev").count() == 0, "одне фото: стрілок гортання немає")
    lvl = lambda: pg.locator(".jr-vw-level").inner_text()
    tr = lambda: pg.evaluate("document.querySelector('.jr-vw-stage img').style.transform")
    eq(lvl(), "75%", "масштаб по екрану (1000 px заввишки у вікні 745 px)")
    # кнопки масштабу
    pg.click('button[aria-label^="Збільшити"]')
    ok(tr() != "" and int(lvl()[:-1]) > 100, f"кнопка + збільшує: {lvl()}")
    pg.click('button[aria-label^="Справжній розмір"]')
    eq(lvl(), "100%", "«1:1» показує справжній розмір")
    pg.click('button[aria-label^="Справжній розмір"]')
    eq((lvl(), tr()), ("75%", ""), "повторне «1:1» повертає за розміром екрана")
    # коліщатко
    pg.mouse.move(640, 450); pg.mouse.wheel(0, -400); pg.wait_for_timeout(100)
    ok(tr() != "" and int(lvl()[:-1]) > 75, f"коліщатко збільшує: {lvl()}")
    # перетягування пересуває (у межах фото)
    t0 = tr()
    pg.mouse.move(640, 450); pg.mouse.down(); pg.mouse.move(540, 400, steps=5); pg.mouse.up()
    ok(tr() != t0, "перетягування пересуває збільшене фото")
    # подвійний клік: повертає за розміром екрана і навпаки
    pg.mouse.dblclick(640, 450)
    eq((lvl(), tr()), ("75%", ""), "подвійний клік скидає масштаб")
    pg.mouse.dblclick(640, 450)
    ok(int(lvl()[:-1]) > 150, f"подвійний клік наближає: {lvl()}")
    pg.keyboard.press("0")
    eq(lvl(), "75%", "клавіша 0 вміщує фото в екран")
    # Esc закриває лише перегляд, форма лишається з фото
    pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    eq(pg.locator("dialog[open]").count(), 1, "Esc закрив перегляд, форма на місці")
    eq(pg.locator(".jr-thumb.is-pending").count(), 1, "вставлене фото досі в формі")
    # Ctrl+V під час перегляду не додає файлів
    pg.click(".jr-thumb.is-pending .jr-thumb-open")
    pg.wait_for_selector("dialog.is-lightbox[open]")
    pg.click("#jr-vw-close"); pg.wait_for_timeout(150)
    eq(pg.locator("dialog.is-lightbox").count(), 0, "кнопка × закриває перегляд")
    # зберегти, відкрити збережений запис, додати ще одне фото: гортання між збереженим і незбереженим
    pg.fill("#jr-f-symbol", "ETHUSDT")
    pg.click("dialog[open] button[type=submit]")
    pg.wait_for_selector("#jr-list tr.jr-row", timeout=5000)
    pg.click(".jr-row"); pg.wait_for_selector("#jr-paste-media")
    pg.evaluate("""async () => { const b = await __t.png(300, 200, false); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); }""")
    pg.click("#jr-paste-media"); pg.wait_for_selector(".jr-thumb.is-pending")
    pg.locator(".jr-thumb:not(.is-pending) .jr-thumb-open").click()
    pg.wait_for_selector("dialog.is-lightbox[open] .jr-vw-stage img")
    eq(pg.locator(".jr-vw-count").inner_text(), "1 / 2", "у перегляді два фото")
    ok(pg.locator(".jr-vw-note").is_hidden(), "збережене фото без позначки")
    pg.click("#jr-vw-next"); pg.wait_for_timeout(100)
    eq((pg.locator(".jr-vw-count").inner_text(), pg.locator(".jr-vw-note").inner_text()), ("2 / 2", "ще не збережено"), "стрілка → показує незбережене фото")
    pg.keyboard.press("ArrowLeft")
    eq(pg.locator(".jr-vw-count").inner_text(), "1 / 2", "клавіша ← гортає назад")
    # клік по порожньому темному полю закриває перегляд (фото вписане, поле з боків вільне)
    pg.mouse.click(8, 400); pg.wait_for_timeout(150)
    eq(pg.locator("dialog.is-lightbox").count(), 0, "клік по темному полю закриває перегляд")
    no_errors(pg)
    # телефон: перегляд теж на весь екран, панель інструментів не виходить за край
    pg.set_viewport_size({"width": 390, "height": 760}); pg.wait_for_timeout(200)
    pg.locator(".jr-thumb:not(.is-pending) .jr-thumb-open").click()
    pg.wait_for_selector("dialog.is-lightbox[open] .jr-vw-stage img")
    box = pg.locator("dialog.is-lightbox").bounding_box()
    eq((round(box["width"]), round(box["height"])), (390, 760), "на телефоні перегляд на весь екран")
    over = pg.evaluate("[...document.querySelectorAll('dialog.is-lightbox .jr-vw-bar button, dialog.is-lightbox .jr-vw-bar a')].filter(b => { const r = b.getBoundingClientRect(); return r.right > 391 || r.left < -1; }).length")
    eq(over, 0, "кнопки перегляду вміщуються в ширину телефона")
    ok(pg.locator("#jr-vw-close").is_visible(), "кнопка закриття видима")
    no_errors(pg)
    ctx.close()


def t_table_scroll_buttons(env):
    pg = env.page(width=1000, height=800)
    jid = mk_journal(pg)
    f = expect_ok(pg, "get", f"/journals/{jid}/fields")["fields"]
    for x in f:
        if x["type"] not in ("longtext", "media"): x["table"] = True
    expect_ok(pg, "put", f"/journals/{jid}/fields", {"fields": [{k: v for k, v in x.items() if k in ("key", "label", "type", "hidden", "table", "options", "help")} for x in f]})
    for i in range(25):
        mk_entry(pg, jid, opened_at=f"2026-03-{(i % 27) + 1:02d}T10:00", setup="Довга назва сетапу для ширини", outcome="Тейк-профіт", pnl=i)
    select_journal(pg, jid)
    pg.wait_for_selector("#jr-list tr.jr-row")
    pg.wait_for_selector("#jr-table-nav:not([hidden])", timeout=4000)
    ok(pg.locator("#jr-scroll-end").is_visible(), "кнопка «На кінець» над таблицею видима")
    top_nav = pg.locator("#jr-table-nav").bounding_box()["y"]; top_tbl = pg.locator(".jr-table-wrap").bounding_box()["y"]
    ok(top_nav < top_tbl, "кнопки стоять над таблицею")
    eq(pg.locator("#jr-scroll-start").is_disabled(), True, "на початку «На початок» вимкнено")
    pg.click("#jr-scroll-end"); pg.wait_for_timeout(900)
    sl = pg.evaluate("(() => { const w = document.querySelector('.jr-table-wrap'); return [w.scrollLeft, w.scrollWidth - w.clientWidth]; })()")
    ok(sl[0] > 0 and abs(sl[0] - sl[1]) < 3, f"таблицю прокручено в кінець: {sl}")
    eq(pg.locator("#jr-scroll-end").is_disabled(), True, "у кінці «На кінець» вимкнено")
    pg.click("#jr-scroll-start"); pg.wait_for_timeout(900)
    eq(pg.evaluate("document.querySelector('.jr-table-wrap').scrollLeft"), 0, "кнопка «На початок» повертає назад")
    # на широкому екрані, де таблиця вміщується, кнопки не потрібні
    pg.set_viewport_size({"width": 1900, "height": 900}); pg.wait_for_timeout(500)
    wide = pg.evaluate("(() => { const w = document.querySelector('.jr-table-wrap'); return w.scrollWidth <= w.clientWidth + 2; })()")
    if wide: ok(pg.locator("#jr-table-nav").is_hidden(), "якщо таблиця вміщується, кнопки приховані")
    no_errors(pg)


TESTS = [("new_journal_defaults", t_new_journal_defaults), ("migration", t_migration), ("review_default_look", t_review_default_look),
         ("review_config_ui", t_review_config_ui), ("review_config_api", t_review_config_api), ("stats_winrate", t_stats_winrate),
         ("sidebar_collapse", t_sidebar_collapse), ("paste_button", t_paste_button), ("viewer_fullscreen", t_viewer_fullscreen), ("table_scroll_buttons", t_table_scroll_buttons)]

if __name__ == "__main__":
    import sys
    sys.exit(run(TESTS, sys.argv[1] if len(sys.argv) > 1 else None))
