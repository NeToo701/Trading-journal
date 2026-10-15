"""Перевірка синхронізації на імітованій хмарі, спільній для кількох «пристроїв» (окремих профілів браузера).
Справжній Firebase тут недоступний, тому перевіряється уся наша логіка (черга, злиття, видалення, конфлікти, стиснення фото),
а не мережевий шар до Google. Його поведінку описано в README."""
import base64, json, time
from e2e_lib import *
from e2e_core import mk_journal, mk_entry, upload

FAKE = r"""
window.__mkCloud = () => {
  let user = null; const subs = [];
  const c = {
    configured: () => true, fromFile: () => false, config: () => ({}), setConfig() {}, parseConfig: () => ({}), validConfig: () => true,
    user: () => user, onUser(fn) { subs.push(fn); if (user) fn(user); }, async init() { return user; },
    async signIn(email) { user = { uid: 'uid-' + email, email }; subs.forEach((f) => f(user)); },
    async signUp(email) { return c.signIn(email); }, async reset() {},
    async signOut() { user = null; subs.forEach((f) => f(null)); },
    adapter: () => user ? { push: (docs) => window.__cloudPush(user.uid, docs), pull: (cursor, limit) => window.__cloudPull(user.uid, cursor, limit) } : null,
  };
  return c;
};
window.__login = async (email) => {
  if (!window.__cloud) { window.__cloud = window.__mkCloud(); JL.cloud = window.__cloud; JL.sync.bind(window.__cloud); }
  await window.__cloud.signIn(email);
};
window.__logout = async () => window.__cloud.signOut();
null;
"""


class Cloud:
    def __init__(self):
        self.users: dict[str, dict] = {}
        self.counter = 0
        self.fail = False
        self.pushes = 0

    def push(self, uid, docs):
        if self.fail:
            raise RuntimeError("Немає зв'язку з Firebase (імітація)")
        self.counter += 1
        self.pushes += 1
        store = self.users.setdefault(uid, {})
        for d in docs:
            assert len(d.get("blob") or "") + len(d.get("data") or "") < 1_000_000, "документ більший за ліміт Firestore"
            store[f"{d['kind']}_{d['rid']}"] = {**d, "srv": self.counter}      # усі документи одного пакета мають однаковий srv, як у Firestore

    def pull(self, uid, cursor, limit):
        if self.fail:
            raise RuntimeError("Немає зв'язку з Firebase (імітація)")
        store = self.users.get(uid, {})
        pos = tuple(json.loads(cursor)) if cursor else (-1, "")
        rest = sorted(((v["srv"], k, v) for k, v in store.items() if (v["srv"], k) > pos), key=lambda t: (t[0], t[1]))
        page = rest[:limit]
        docs = [{k: v for k, v in d.items() if k != "srv"} for _, _, d in page]
        nxt = json.dumps([page[-1][0], page[-1][1]]) if page else cursor
        return {"docs": docs, "cursor": nxt, "more": len(rest) > limit}

    def docs(self, uid, kind=None):
        return {k: v for k, v in self.users.get(uid, {}).items() if kind is None or v["kind"] == kind}


def device(env, cloud, ctx=None, boot=True):
    ctx = ctx or env.browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    ctx.expose_function("__cloudPush", lambda uid, docs: cloud.push(uid, docs))
    ctx.expose_function("__cloudPull", lambda uid, cursor, limit: cloud.pull(uid, cursor, limit))
    pg = env.page(ctx, boot=boot)
    if boot:
        pg.evaluate(FAKE)
    return pg


def rebind(pg):
    pg.evaluate(HELPERS); pg.evaluate(FAKE)


def settle(pg, timeout=15.0):
    """Ждемо, поки синхронізація завершиться: черга порожня, стан idle."""
    end = time.time() + timeout
    while time.time() < end:
        st = pg.evaluate("JL.sync.status()")
        pending = pg.evaluate("JL.sync.pendingCount()")
        if st["state"] in ("idle", "error", "offline") and pending == 0 or st["state"] in ("error", "offline"):
            return st
        time.sleep(0.1)
    raise AssertionError("синхронізація не завершилась: " + json.dumps(pg.evaluate("JL.sync.status()")))


def sync_now(pg):
    pg.evaluate("JL.sync.run()")
    time.sleep(0.15)
    return settle(pg)


def login(pg, email="a@test.io"):
    pg.evaluate("email => __login(email)", email)
    time.sleep(0.3)
    return settle(pg)


def dump(pg):
    return pg.evaluate("""async () => JL.db.tx(['journals','entries','reviews','media','blobs'], 'readonly', async t => ({
      j: (await t.all('journals')).map(x => [x.id, x.name, x._u]).sort(), e: (await t.all('entries')).map(x => [x.id, JSON.stringify(x.data), x._u]).sort(),
      r: (await t.all('reviews')).map(x => [x.key, JSON.stringify(x.data)]).sort(), m: (await t.all('media')).map(x => [x.id, x.name, x.mime]).sort(), b: (await t.keys('blobs')).sort() }))""")


def t_two_devices_basic(env):
    cloud = Cloud()
    A = device(env, cloud)
    j = mk_journal(A, "Спільний"); e1 = mk_entry(A, j, symbol="AAA"); e2 = mk_entry(A, j, symbol="BBB", opened_at="2026-03-02T10:00"); e3 = mk_entry(A, j, symbol="CCC", opened_at="2026-03-03T10:00")
    upload(A, e1["id"], "media", "a.png", size=(50, 30)); upload(A, e2["id"], "media", "v.mp4", kind="mp4")
    expect_ok(A, "put", f"/journals/{j}/review?month=2026-03", {"data": {"conclusion": "Висновок"}})
    st = login(A)
    eq(st["state"], "idle", "A синхронізовано"); eq(st["localOnly"], 1, "відео лишилось лише на пристрої")
    uid = "uid-a@test.io"
    kinds = {k: len(cloud.docs(uid, k)) for k in ("journals", "entries", "reviews", "media")}
    eq(kinds, {"journals": 1, "entries": 3, "reviews": 1, "media": 1}, "склад хмари")
    ok(all(d["u"] > 0 for d in cloud.docs(uid).values()), "кожен документ має час зміни")
    B = device(env, cloud)
    st = login(B)
    eq(st["state"], "idle", "B синхронізовано")
    da, db_ = dump(A), dump(B)
    eq((db_["j"], db_["e"], db_["r"]), (da["j"], da["e"], da["r"]), "B отримав журнал, записи й розбір")
    eq([m[1:] for m in db_["m"]], [["a.png", "image/png"]], "B отримав лише фото")
    got = expect_ok(B, "get", f"/entries/{e1['id']}")["entry"]
    nat = B.evaluate("""async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }""", got["media"][0]["url"])
    eq(nat, [50, 30], "фото на B відкривається")
    # B змінює, видаляє й додає
    time.sleep(0.02)
    expect_ok(B, "put", f"/entries/{e1['id']}", {"data": {"opened_at": "2026-03-01T10:00", "symbol": "AAA-B", "pnl": 5}})
    expect_ok(B, "del", f"/entries/{e2['id']}")
    e4 = mk_entry(B, j, symbol="DDD", opened_at="2026-03-04T10:00")
    sync_now(B); sync_now(A)
    da, db_ = dump(A), dump(B)
    eq(da["e"], db_["e"], "після синхронізації записи на A і B однакові")
    syms = sorted(json.loads(e[1])["symbol"] for e in da["e"])
    eq(syms, ["AAA-B", "CCC", "DDD"], "правка, видалення й новий запис дійшли до A")
    eq(da["m"], [m for m in db_["m"]], "файли однакові")
    # видалення журналу з файлами
    expect_ok(B, "del", f"/journals/{j}"); sync_now(B); sync_now(A)
    da = dump(A); eq((da["j"], da["e"], da["m"], da["b"]), ([], [], [], []), "видалення журналу дійшло до A разом із записами й файлами")
    no_errors(A); no_errors(B)


def t_conflicts(env):
    cloud = Cloud()
    A = device(env, cloud); B = device(env, cloud)
    j = mk_journal(A); e = mk_entry(A, j, symbol="BASE"); other = mk_entry(A, j, symbol="OTHER", opened_at="2026-03-05T10:00")
    login(A); login(B)
    # обидва змінюють той самий запис без зв'язку: пізніша правка перемагає, хто б першим не синхронізувався
    cloud.fail = True
    expect_ok(A, "put", f"/entries/{e['id']}", {"data": {"opened_at": "2026-03-01T10:00", "symbol": "FROM-A"}}); time.sleep(0.05)
    expect_ok(B, "put", f"/entries/{e['id']}", {"data": {"opened_at": "2026-03-01T10:00", "symbol": "FROM-B"}})
    st = sync_now(A); eq(st["state"], "error", "без зв'язку стан «помилка»"); ok("Немає зв'язку" in st["error"], "текст помилки видно")
    ok(A.evaluate("JL.sync.pendingCount()") >= 1, "зміни чекають у черзі")
    cloud.fail = False
    sync_now(A); sync_now(B); sync_now(A); sync_now(B)
    sym = lambda p: json.loads(dict((x[0], x[1]) for x in dump(p)["e"])[e["id"]])["symbol"]
    eq((sym(A), sym(B)), ("FROM-B", "FROM-B"), "перемагає пізніша правка (порядок A, B)")
    # той самий конфлікт, інший порядок синхронізації
    cloud.fail = True
    expect_ok(B, "put", f"/entries/{e['id']}", {"data": {"opened_at": "2026-03-01T10:00", "symbol": "B2"}}); time.sleep(0.05)
    expect_ok(A, "put", f"/entries/{e['id']}", {"data": {"opened_at": "2026-03-01T10:00", "symbol": "A2"}})
    cloud.fail = False
    sync_now(B); sync_now(A); sync_now(B); sync_now(A)
    eq((sym(A), sym(B)), ("A2", "A2"), "перемагає пізніша правка (порядок B, A)")
    # правка пізніша за видалення: запис воскресає; видалення пізніше за правку: запис зникає
    cloud.fail = True
    expect_ok(A, "del", f"/entries/{other['id']}"); time.sleep(0.05)
    expect_ok(B, "put", f"/entries/{other['id']}", {"data": {"opened_at": "2026-03-05T10:00", "symbol": "ALIVE"}})
    expect_ok(B, "del", f"/entries/{e['id']}"); time.sleep(0.05)
    expect_ok(A, "put", f"/entries/{e['id']}", {"data": {"opened_at": "2026-03-01T10:00", "symbol": "TOO-EARLY"}})
    cloud.fail = False
    for _ in range(2): sync_now(A); sync_now(B)
    ids = lambda p: sorted(x[0] for x in dump(p)["e"])
    eq(ids(A), ids(B), "після конфліктів видалення/правки пристрої збігаються")
    eq(ids(A), sorted([other["id"], e["id"]]), "обидва записи вціліли, бо правки були пізніші за видалення")
    # видалення пізніше за правку
    cloud.fail = True
    expect_ok(A, "put", f"/entries/{e['id']}", {"data": {"opened_at": "2026-03-01T10:00", "symbol": "EDIT"}}); time.sleep(0.05)
    expect_ok(B, "del", f"/entries/{e['id']}")
    cloud.fail = False
    for _ in range(2): sync_now(A); sync_now(B)
    eq(ids(A), [other["id"]], "пізніше видалення перемагає ранішу правку")
    eq(ids(B), [other["id"]], "те саме на B")
    no_errors(A); no_errors(B)


def t_offline_queue_survives_reload(env):
    cloud = Cloud()
    A = device(env, cloud)
    login(A)
    cloud.fail = True
    j = mk_journal(A); e = mk_entry(A, j, symbol="OFFLINE")
    st = sync_now(A); eq(st["state"], "error", "помилка зв'язку")
    pend = A.evaluate("JL.sync.pendingCount()"); ok(pend >= 2, f"у черзі {pend}")
    A.reload(); A.wait_for_selector("#jr-side:not([hidden])"); rebind(A)
    eq(A.evaluate("JL.sync.pendingCount()"), pend, "черга пережила перезавантаження")
    cloud.fail = False
    login(A)
    eq(A.evaluate("JL.sync.pendingCount()"), 0, "чергу відправлено")
    eq(len(cloud.docs("uid-a@test.io", "entries")), 1, "запис дійшов до хмари")
    # без інтернету браузера: стан «offline», нічого не відправляється
    A.context.set_offline(True); time.sleep(0.3)
    eq(A.evaluate("JL.sync.status().state"), "offline", "стан offline")
    expect_ok(A, "post", f"/journals/{j}/entries", {"data": {"opened_at": "2026-03-09T10:00", "symbol": "WHILE-OFFLINE"}})
    A.evaluate("JL.sync.run()"); time.sleep(0.3)
    eq(A.evaluate("JL.sync.status().state"), "offline", "у режимі offline синхронізація не запускається")
    A.context.set_offline(False)
    A.evaluate("window.dispatchEvent(new Event('online'))"); time.sleep(1.2); settle(A)
    eq(len(cloud.docs("uid-a@test.io", "entries")), 2, "після повернення інтернету зміни відправились самі")
    no_errors(A)


def t_first_login_merge(env):
    cloud = Cloud()
    A = device(env, cloud); B = device(env, cloud)
    ja = mk_journal(A, "Ноутбук"); mk_entry(A, ja, symbol="FROM-LAPTOP")
    jb = mk_journal(B, "Телефон"); mk_entry(B, jb, symbol="FROM-PHONE")
    login(A, "m@test.io"); login(B, "m@test.io"); sync_now(A)
    names = lambda p: sorted(x[1] for x in dump(p)["j"])
    eq(names(A), ["Ноутбук", "Телефон"], "A об'єднав обидва журнали")
    eq(names(B), ["Ноутбук", "Телефон"], "B об'єднав обидва журнали")
    eq(sorted(json.loads(x[1])["symbol"] for x in dump(A)["e"]), ["FROM-LAPTOP", "FROM-PHONE"], "записи обох пристроїв")
    eq(A.evaluate("JL.db.meta.get('cloudUid')"), "uid-m@test.io", "пристрій прив'язано до акаунта")
    no_errors(A); no_errors(B)


def t_other_account_conflict(env):
    cloud = Cloud()
    A = device(env, cloud)
    j = mk_journal(A, "Мій"); mk_entry(A, j, symbol="MINE")
    login(A, "one@test.io")
    # другий акаунт на тому ж пристрої: UI питає, що робити
    A.evaluate("__logout()")
    A.evaluate("email => __login(email)", "two@test.io")
    A.wait_for_selector("#jr-cf-wipe", timeout=5000)
    ok("дані іншого акаунта" in A.inner_text("dialog[open]"), "показано вікно конфлікту акаунтів")
    A.click("#jr-cf-cancel"); time.sleep(0.5)
    eq(A.evaluate("__cloud.user()"), None, "скасування виходить з акаунта")
    eq(len(dump(A)["j"]), 1, "локальні дані не чіпали")
    # тепер погоджуємось видалити
    cloud.users["uid-two@test.io"] = {}
    B = device(env, cloud); jb = mk_journal(B, "Чужий"); mk_entry(B, jb, symbol="OTHER"); login(B, "two@test.io")
    A.evaluate("email => __login(email)", "two@test.io")
    A.wait_for_selector("#jr-cf-wipe"); A.click("#jr-cf-wipe"); time.sleep(0.5); settle(A)
    eq(sorted(x[1] for x in dump(A)["j"]), ["Чужий"], "після погодження лишилися лише дані другого акаунта")
    eq(A.evaluate("JL.db.meta.get('cloudUid')"), "uid-two@test.io", "пристрій прив'язано до другого акаунта")
    eq(len(cloud.docs("uid-one@test.io", "entries")), 1, "дані першого акаунта в хмарі збереглись")
    no_errors(A)


def t_image_downscale(env):
    cloud = Cloud()
    A = device(env, cloud)
    j = mk_journal(A); e = mk_entry(A, j)
    r = upload(A, e["id"], "media", "big.png", size=(1400, 1000), noise=True)
    ok("ok" in r, f"велике фото додано локально {r}")
    orig = A.evaluate("JL.db.tx(['media'], 'readonly', async t => (await t.all('media'))[0].size)")
    ok(orig > 1_000_000, f"оригінал великий: {orig}")
    login(A)
    docs = list(cloud.docs("uid-a@test.io", "media").values())
    eq(len(docs), 1, "фото в хмарі")
    meta = json.loads(docs[0]["data"]); raw = base64.b64decode(docs[0]["blob"])
    ok(len(raw) <= 640 * 1024, f"у хмарі фото стиснуте: {len(raw)}"); eq(meta["mime"], "image/jpeg", "у хмарі це JPEG"); ok(raw[:3] == b"\xff\xd8\xff", "справжній JPEG")
    eq(A.evaluate("JL.db.tx(['media'], 'readonly', async t => (await t.all('media'))[0].size)"), orig, "оригінал на A не змінено")
    B = device(env, cloud); login(B)
    got = B.evaluate("JL.db.tx(['media','blobs'], 'readonly', async t => { const m = (await t.all('media'))[0]; const b = await t.get('blobs', m.id); return [m.mime, m.size, b.size, b.type]; })")
    eq(got[0], "image/jpeg", "на B фото стиснуте"); ok(got[2] <= 640 * 1024 and got[1] == got[2], f"розмір збігається {got}")
    # PNG до ліміту лишається без змін
    e2 = mk_entry(A, j, symbol="SMALL", opened_at="2026-03-03T10:00"); upload(A, e2["id"], "media", "s.png", size=(60, 40)); sync_now(A)
    small = [json.loads(d["data"]) for d in cloud.docs("uid-a@test.io", "media").values() if json.loads(d["data"])["name"] == "s.png"]
    eq(small[0]["mime"], "image/png", "маленьке фото не перекодовується")
    no_errors(A); no_errors(B)


def t_pagination_and_bad_docs(env):
    cloud = Cloud()
    A = device(env, cloud)
    j = mk_journal(A)
    A.evaluate("""async (j) => { await JL.db.tx(['entries','outbox'], 'readwrite', async t => { for (let i = 0; i < 80; i++) { const e = { id: JL.db.nextId(), journal_id: j, data: { opened_at: '2026-01-01T10:00', symbol: 'S' + i }, opened: '2026-01-01T10:00', created_at: 1, updated_at: 1, _u: Date.now() }; await t.put('entries', e); await t.mark('entries', e.id); } }); }""", j)
    login(A)
    eq(len(cloud.docs("uid-a@test.io", "entries")), 80, "80 записів у хмарі")
    # пакет з однаковим srv розбивається на сторінки по 25: нічого не губиться
    B = device(env, cloud); login(B)
    eq(len(dump(B)["e"]), 80, "B отримав усі 80 записів через сторінки")
    # погані документи ігноруються
    store = cloud.users["uid-a@test.io"]; cloud.counter += 1
    store["entries_777"] = {"kind": "entries", "rid": "777", "deleted": False, "u": 5, "data": "{not json", "blob": None, "srv": cloud.counter}
    store["weird_1"] = {"kind": "weird", "rid": "1", "deleted": False, "u": 5, "data": "{}", "blob": None, "srv": cloud.counter}
    store["entries_abc"] = {"kind": "entries", "rid": "abc", "deleted": False, "u": 5, "data": "{}", "blob": None, "srv": cloud.counter}
    store["media_778"] = {"kind": "media", "rid": "778", "deleted": False, "u": 5, "data": "{}", "blob": None, "srv": cloud.counter}
    st = sync_now(B); eq(st["state"], "idle", "погані документи не ламають синхронізацію")
    eq(len(dump(B)["e"]), 80, "кількість не змінилась")
    no_errors(B)


def t_account_dialog_ui(env):
    cloud = Cloud()
    A = device(env, cloud)
    mk_journal(A)
    A.click("#acc-btn"); A.wait_for_selector("#acc-dialog[open]")
    txt = A.inner_text("#acc-body")
    ok("Налаштування Firebase" in txt or "Хмарна синхронізація" in txt, "без налаштувань пропонується підключити Firebase")
    ok(A.is_visible("#acc-backup") and A.is_visible("#acc-restore") and A.is_visible("#acc-wipe"), "кнопки копії й очищення на місці")
    # вставка налаштувань розбирається й зберігається (без запуску SDK: перехоплюємо init)
    A.evaluate("JL.cloud.init = async () => null")
    A.fill("#acc-cfg", 'const firebaseConfig = {\n apiKey: "AIzaXYZ",\n authDomain: "p.firebaseapp.com",\n projectId: "p",\n storageBucket: "p.appspot.com",\n appId: "1:2:web:3"\n};')
    A.click("#acc-cfg-save"); time.sleep(0.4)
    saved = A.evaluate("JSON.parse(localStorage.getItem('journal.firebase.v1'))")
    eq(saved["projectId"], "p", "налаштування збережено"); eq(saved["apiKey"], "AIzaXYZ", "apiKey")
    ok("Увійти" in A.inner_text("#acc-body"), "після збереження з'явилась форма входу")
    A.fill("#acc-cfg-link", "") if False else None
    # неповні налаштування
    A.evaluate("localStorage.removeItem('journal.firebase.v1')"); A.reload(); A.wait_for_selector("#jr-side:not([hidden])")
    A.click("#acc-btn"); A.fill("#acc-cfg", "apiKey: 'x'"); A.click("#acc-cfg-save")
    A.wait_for_selector("#acc-body .acc-error:not([hidden])")
    ok("бракує" in A.inner_text("#acc-body .acc-error"), "неповні налаштування відхилено з поясненням")
    A.screenshot(path=str(ROOT / "tests" / "out_account_dialog.png"))
    # після входу діалог показує пошту й стан
    A.keyboard.press("Escape")
    A.evaluate("JL.sync.start = JL.sync.start"); rebind(A)
    login(A, "ui@test.io")
    A.click("#acc-btn"); A.wait_for_selector("#acc-sync")
    ok("ui@test.io" in A.inner_text("#acc-body") and "Синхронізовано" in A.inner_text("#acc-status"), f"стан у діалозі: {A.inner_text('#acc-body')[:200]!r}")
    A.click("#acc-sync"); time.sleep(0.5)
    A.screenshot(path=str(ROOT / "tests" / "out_account_signed_in.png"))
    no_errors(A)


TESTS = [("two_devices_basic", t_two_devices_basic), ("conflicts", t_conflicts), ("offline_queue_survives_reload", t_offline_queue_survives_reload),
         ("first_login_merge", t_first_login_merge), ("other_account_conflict", t_other_account_conflict), ("image_downscale", t_image_downscale),
         ("pagination_and_bad_docs", t_pagination_and_bad_docs), ("account_dialog_ui", t_account_dialog_ui)]

if __name__ == "__main__":
    import sys
    sys.exit(run(TESTS, sys.argv[1] if len(sys.argv) > 1 else None))
