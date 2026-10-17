"""Браузерні перевірки вкладки «Календар новин»: дані з data/news.json (підміняється в тестах), фільтри, час, нагадування,
чіп у шапці, перемикання вкладок, відсутній/пошкоджений/застарілий файл, мобільний вигляд."""
import json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from e2e_lib import *
from e2e_core import mk_journal, mk_entry

SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] not in ("-k",) and not sys.argv[1].startswith("-") else None


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def ev(title, cur, impact, minutes, fc="1%", prev="2%"):
    return {"title": title, "country": cur, "date": iso(datetime.now(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=minutes)),
            "impact": impact, "forecast": fc, "previous": prev}


def feed(age_min=5, events=None):
    return {"fetched_at": (datetime.now(timezone.utc) - timedelta(minutes=age_min)).isoformat(), "source": "faireconomy",
            "events": events if events is not None else [
                ev("CPI y/y", "USD", "High", 25, "3.1%", "3.0%"),
                ev("Core CPI m/m", "USD", "High", 25, "0.3%", "0.3%"),
                ev("JOLTS Job Openings", "USD", "Medium", 180),
                ev("Unemployment Claims", "USD", "Low", 200),
                ev("Main Refinancing Rate", "EUR", "High", 26 * 60),
                ev("Bank Holiday", "JPY", "Holiday", 120, "", ""),
                ev("Fed Chair Powell Speaks", "USD", "High", -120, "", ""),
                ev("Retail Sales m/m", "GBP", "Medium", 300)]}


def open_cal(env, body, status=200, width=1280, height=900, hash_="#calendar", ctx=None):
    ctx = ctx or env.browser.new_context(viewport={"width": width, "height": height}, service_workers="block")  # сервіс-воркер обходить route()
    pg = env.page(ctx=ctx, width=width, height=height, boot=False)
    if body is not None:
        pg.route("**/data/news.json*", lambda r: r.fulfill(status=status, content_type="application/json", body=body if isinstance(body, str) else json.dumps(body)))
    pg.goto(env.url + hash_)
    if hash_ == "#calendar":
        pg.wait_for_selector("#cal-list .ev, #cal-status:not([hidden]), #cal-list .empty", timeout=10000)
    else:
        pg.wait_for_selector("#jr-side:not([hidden]), .jr-gate", timeout=10000)
    return pg


def rows(pg):
    return pg.locator("#cal-list .ev").count()


def shot(pg, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(SHOTS / name), full_page=True)


def t_fresh(env):
    pg = open_cal(env, feed())
    eq(pg.get_attribute("#tab-calendar", "aria-current"), "page", "вкладка календаря активна")
    ok(pg.is_hidden("#jr-shell"), "журнал сховано")
    ok(pg.is_visible("#calendar-view"), "календар видно")
    eq(rows(pg), 4, "за замовчуванням: USD і GBP, високий і середній, без минулих (CPI, Core CPI, JOLTS, GBP Retail Sales)")
    ok(pg.is_checked('input[name="cal-cur"][value="GBP"]') and pg.is_checked('input[name="cal-cur"][value="USD"]'), "фунт (GBP) є у фільтрі й вибраний за замовчуванням")
    meta = pg.inner_text("#cal-meta")
    ok("Forex Factory" in meta and "Оновлено о" in meta, f"джерело й час оновлення: {meta}")
    ok(pg.is_hidden("#cal-status"), "статусу немає для свіжих даних")
    ok(pg.locator(".ev-flag").count() == 1, "є позначка найближчої важливої")
    ok("Інфляція (CPI)" in pg.inner_text("#cal-list"), "українська назва події")
    ok("3.1%" in pg.inner_text("#cal-list"), "прогноз показано")
    chip = pg.locator("#next-chip")
    ok(chip.is_visible(), "чіп найближчої новини видно")
    ok("USD" in chip.inner_text() and "через" in chip.inner_text(), f"текст чіпа: {chip.inner_text()}")
    ok("is-soon" in (chip.get_attribute("class") or ""), "чіп «скоро» (менше години)")
    # розгортання рядка
    first = pg.locator("#cal-list .ev-row").first
    eq(first.get_attribute("aria-expanded"), "false", "рядок згорнуто")
    first.click()
    eq(first.get_attribute("aria-expanded"), "true", "рядок розгорнуто")
    ok(pg.locator("#cal-list .ev-more:not([hidden])").count() == 1, "є пояснення")
    # фільтри
    pg.check('input[name="cal-imp"][value="low"]')
    eq(rows(pg), 5, "додали низький вплив")
    pg.check('input[name="cal-past"]')
    eq(rows(pg), 6, "додали минулі")
    pg.uncheck('input[name="cal-past"]')
    cur = pg.locator('input[name="cal-cur"]').evaluate_all("els => els.map(e => e.value)")
    eq(cur, ["USD", "EUR", "GBP", "JPY"], "валюти: USD першою, решта за абеткою")
    pg.uncheck('input[name="cal-cur"][value="GBP"]')
    eq(rows(pg), 4, "лише USD: фунтових подій немає")
    pg.check('input[name="cal-cur"][value="GBP"]')
    pg.uncheck('input[name="cal-cur"][value="USD"]')
    pg.uncheck('input[name="cal-cur"][value="GBP"]')
    ok("всі валюти" in pg.inner_text("#cal-cur-note"), "підказка «всі валюти»")
    eq(rows(pg), 6, "усі валюти, високий/середній/низький (без вихідних і минулих)")
    pg.check('input[name="cal-imp"][value="holiday"]')
    eq(rows(pg), 7, "додали вихідні")
    pg.check('input[name="cal-period"][value="today"]')
    n_today = rows(pg)
    ok(1 <= n_today <= 7, f"період «сьогодні»: {n_today}")
    pg.check('input[name="cal-period"][value="week"]')
    # збереження вибору
    pg.reload(); pg.wait_for_selector("#cal-list .ev")
    ok(pg.is_checked('input[name="cal-imp"][value="low"]'), "фільтр впливу збережено")
    eq(rows(pg), 7, "після перезавантаження ті самі події")
    # старі збережені налаштування (лише USD, без позначки про фунт): GBP додається один раз
    pg.evaluate("localStorage.setItem('journal.cal.v1', JSON.stringify({impacts: ['high','medium'], currencies: ['USD'], period: 'week', showPast: false, tz: 'local'}))")
    pg.reload(); pg.wait_for_selector("#cal-list .ev")
    ok(pg.is_checked('input[name="cal-cur"][value="GBP"]'), "у старих налаштуваннях фунт додано")
    pg.uncheck('input[name="cal-cur"][value="GBP"]')
    pg.reload(); pg.wait_for_selector("#cal-list .ev")
    ok(not pg.is_checked('input[name="cal-cur"][value="GBP"]'), "вимкнений користувачем фунт знову не вмикається")
    pg.evaluate("localStorage.setItem('journal.cal.v1', JSON.stringify({impacts: ['high'], currencies: [], period: 'week', showPast: false, tz: 'local'}))")
    pg.reload(); pg.wait_for_selector("#cal-list .ev")
    ok(not pg.is_checked('input[name="cal-cur"][value="GBP"]') and not pg.is_checked('input[name="cal-cur"][value="USD"]'), "вибір «усі валюти» не звужується до фунта")
    # час: UTC
    t_local = pg.locator("#cal-list .ev-time").first.inner_text()
    pg.check('input[name="cal-tz"][value="utc"]')
    t_utc = pg.locator("#cal-list .ev-time").first.inner_text()
    ok(":" in t_utc and ":" in t_local, "час показано")
    ok("UTC" in pg.inner_text("#cal-meta"), "у шапці вказано UTC")
    shot(pg, "calendar-desktop.png")
    no_errors(pg, "календар: свіжі дані")
    pg.context.close()


def t_stale_missing_corrupt(env):
    pg = open_cal(env, feed(age_min=8 * 60))
    ok("не оновлювався понад 6 годин" in pg.inner_text("#cal-status"), f"застарілі дані: {pg.inner_text('#cal-status')}")
    ok(rows(pg) >= 1, "застарілі дані все одно показано")
    pg.context.close()

    pg = open_cal(env, "", status=404)
    ok("Даних календаря ще немає" in pg.inner_text("#cal-status") and "README" in pg.inner_text("#cal-status"), "файлу немає: підказка про налаштування")
    eq(rows(pg), 0, "вигаданих подій немає")
    ok("Подій ще немає" in pg.inner_text("#cal-list"), "показано порожній стан")
    pg.context.close()

    pg = open_cal(env, feed(events=[]))
    ok("Даних календаря ще немає" in pg.inner_text("#cal-status"), "порожній файл = немає даних")
    pg.context.close()

    pg = open_cal(env, "{це не json")
    ok("пошкоджено" in pg.inner_text("#cal-status"), f"пошкоджений файл: {pg.inner_text('#cal-status')}")
    eq(rows(pg), 0, "подій немає")
    ok(pg.is_hidden("#next-chip"), "чіпа немає")
    pg.context.close()

    pg = open_cal(env, {"events": "x"})
    ok("незнайомий формат" in pg.inner_text("#cal-status"), "незнайомий формат")
    pg.context.close()

    pg = open_cal(env, [1, 2, 3])
    ok("незнайомий формат" in pg.inner_text("#cal-status"), "масив замість об'єкта")
    pg.context.close()

    # сміттєві записи всередині нормального файлу пропускаються
    pg = open_cal(env, feed(events=[ev("CPI y/y", "USD", "High", 60), {"title": "x"}, 5, None, {"title": "A", "country": "USD", "date": "nonsense"}]))
    eq(rows(pg), 1, "сміттєві записи пропущено")
    no_errors(pg, "календар: сміттєві записи")
    pg.context.close()


def t_tabs(env):
    pg = open_cal(env, feed(), hash_="")
    pg.wait_for_selector("#jr-side:not([hidden]), .jr-gate", timeout=10000)
    eq(pg.get_attribute("#tab-journal", "aria-current"), "page", "за замовчуванням журнал")
    ok(pg.is_hidden("#calendar-view"), "календар сховано")
    pg.click("#tab-calendar")
    pg.wait_for_selector("#cal-list .ev")
    ok(pg.is_hidden("#jr-shell"), "журнал сховано")
    pg.click("#next-chip")
    ok(pg.is_visible("#calendar-view"), "чіп веде в календар")
    pg.click("#tab-journal")
    pg.wait_for_selector("#jr-side:not([hidden])")
    ok(pg.is_visible("#jr-shell") and pg.is_hidden("#calendar-view"), "повернулися до журналу")
    ok(pg.is_visible("#next-chip"), "чіп лишається видимим у журналі")
    pg.go_back()
    pg.wait_for_selector("#calendar-view:not([hidden])")
    ok(True, "кнопка «Назад» працює")
    # журнал працює після відвідин календаря
    pg.click("#tab-journal"); pg.wait_for_selector("#jr-side:not([hidden])")
    pg.evaluate(HELPERS)
    jid = mk_journal(pg, "Після календаря")
    mk_entry(pg, jid)
    eq(len(expect_ok(pg, "get", f"/journals/{jid}/entries")["entries"]), 1, "запис створюється")
    no_errors(pg, "перемикання вкладок")
    pg.context.close()


def t_alerts(env):
    ctx = env.browser.new_context(viewport={"width": 1280, "height": 900}, service_workers="block")
    pg = open_cal(env, feed(), ctx=ctx)
    ok(pg.locator("#toasts .toast").count() == 0, "нагадувань ще немає")
    pg.select_option("#alert-lead", "30")
    pg.check('input[name="alert-on"]')
    pg.wait_for_selector("#toasts .toast", timeout=5000)
    eq(pg.locator("#toasts .toast").count(), 1, "дві події о тій самій хвилині = одне нагадування")
    txt = pg.inner_text("#toasts")
    ok("USD" in txt and "2 події" in txt, f"текст нагадування: {txt[:120]}")
    pg.click("#toasts .toast-x")
    eq(pg.locator("#toasts .toast").count(), 0, "нагадування закривається")
    pg.select_option("#alert-lead", "60")
    eq(pg.locator("#toasts .toast").count(), 0, "повторно те саме нагадування не з'являється")
    seen = pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('journal.alerts.seen.v1') || '{}')).length")
    eq(seen, 2, "показані події запам'ятано")
    pg.reload(); pg.wait_for_selector("#cal-list .ev")
    pg.wait_for_timeout(300)
    eq(pg.locator("#toasts .toast").count(), 0, "після перезавантаження повтору немає")
    ok(pg.is_checked('input[name="alert-on"]'), "перемикач нагадувань збережено")
    ctx.close()
    # середній вплив при рівні «Високий і середній» та вузькому вікні
    pg = open_cal(env, feed(events=[ev("JOLTS Job Openings", "USD", "Medium", 10)]))
    pg.select_option("#alert-lead", "15")
    pg.check('input[name="alert-on"]')
    pg.wait_for_timeout(300)
    eq(pg.locator("#toasts .toast").count(), 0, "середній вплив не нагадує при рівні «лише високий»")
    pg.check('input[name="alert-level"][value="medium"]')
    pg.wait_for_selector("#toasts .toast", timeout=5000)
    ok(True, "середній вплив нагадує при рівні «високий і середній»")
    no_errors(pg, "нагадування")
    pg.context.close()


def t_mobile(env):
    pg = open_cal(env, feed(), width=375, height=800)
    over = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    ok(over <= 0, f"немає горизонтальної прокрутки на 375px (надлишок {over})")
    ok(pg.is_visible("#cal-list .ev"), "події видно")
    shot(pg, "calendar-mobile.png")
    pg.click("#tab-journal"); pg.wait_for_selector("#jr-side:not([hidden])")
    over = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    ok(over <= 0, f"журнал на 375px з вкладками без прокрутки вбік (надлишок {over})")
    shot(pg, "journal-mobile.png")
    no_errors(pg, "мобільний вигляд")
    pg.context.close()


TESTS = [("fresh", t_fresh), ("stale_missing_corrupt", t_stale_missing_corrupt), ("tabs", t_tabs), ("alerts", t_alerts), ("mobile", t_mobile)]

if __name__ == "__main__":
    only = None
    if "-k" in sys.argv:
        only = sys.argv[sys.argv.index("-k") + 1]
    sys.exit(run(TESTS, only))
