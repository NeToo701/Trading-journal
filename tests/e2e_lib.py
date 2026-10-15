"""Спільне для браузерних перевірок (Playwright, Chromium): сервер, сторінка, виклики API в сторінці, лічильник помилок."""
import contextlib, json, subprocess, sys, time, socket
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FAILS: list[str] = []
CHECKS = [0]
HELPERS = r"""
window.__t = {
  async png(w, h, noise) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    if (noise) { const d = g.createImageData(w, h); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i+1] = Math.random() * 255; d.data[i+2] = Math.random() * 255; d.data[i+3] = 255; } g.putImageData(d, 0, 0); }
    else { g.fillStyle = '#2a7'; g.fillRect(0, 0, w, h); g.fillStyle = '#fa0'; g.fillRect(w / 4, h / 4, w / 2, h / 2); }
    return await new Promise((r) => c.toBlob(r, 'image/png'));
  },
  mp4() { const b = new Uint8Array(64); b.set([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d], 0); return new Blob([b], { type: 'video/mp4' }); },
  async call(method, path, body) {
    try { return { ok: await JL.api[method](path, body) }; }
    catch (e) { return { error: e.message, status: e.status, field: e.field === undefined ? null : e.field }; }
  },
};
"""


def free_port():
    with contextlib.closing(socket.socket()) as s:
        s.bind(("127.0.0.1", 0)); return s.getsockname()[1]


class Env:
    def __init__(self):
        self.port = free_port()
        self.server = subprocess.Popen([sys.executable, "-m", "http.server", str(self.port), "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.url = f"http://127.0.0.1:{self.port}/index.html"
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", self.port), 0.2).close(); break
            except OSError:
                time.sleep(0.1)
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch()

    def close(self):
        self.browser.close(); self.pw.stop(); self.server.terminate()

    def page(self, ctx=None, width=1280, height=900, boot=True):
        ctx = ctx or self.browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True)
        pg = ctx.new_page()
        pg.logs = []
        pg.on("console", lambda m: pg.logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: pg.logs.append(("pageerror", str(e) + " | " + (e.stack or "")[:400])))
        pg.add_init_script("window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));")
        if boot:
            pg.goto(self.url)
            pg.wait_for_selector("#jr-side:not([hidden]), .jr-gate", timeout=10000)
            pg.evaluate(HELPERS)
        return pg


def ok(cond, msg):
    CHECKS[0] += 1
    if not cond:
        FAILS.append(msg); print("  ✗", msg)
    return cond


def eq(got, want, msg):
    CHECKS[0] += 1
    if got != want:
        s = f"{msg}: очікувано {json.dumps(want, ensure_ascii=False)[:300]}, отримано {json.dumps(got, ensure_ascii=False)[:300]}"
        FAILS.append(s); print("  ✗", s)
        return False
    return True


def no_errors(pg, msg="консоль"):
    bad = [l for l in pg.logs if l[0] in ("error", "pageerror") or "violat" in l[1].lower()]
    csp = pg.evaluate("window.__csp || []")
    ok(not bad and not csp, f"{msg}: помилки в консолі {bad[:3]} / CSP {csp[:3]}")


def call(pg, method, path, body=None):
    return pg.evaluate("([m, p, b]) => __t.call(m, p, b)", [method, path, body])


def expect_ok(pg, method, path, body=None, msg=None):
    r = call(pg, method, path, body)
    ok("ok" in r, f"{msg or method + ' ' + path}: {r.get('error')}")
    return r.get("ok")


def expect_err(pg, status, method, path, body=None, msg=None):
    r = call(pg, method, path, body)
    ok("error" in r and r["status"] == status, f"{msg or method + ' ' + path}: очікувалась помилка {status}, отримано {json.dumps(r, ensure_ascii=False)[:200]}")
    return r


def run(tests, only=None):
    env = Env()
    try:
        for name, fn in tests:
            if only and only not in name:
                continue
            before = len(FAILS)
            print(f"== {name}")
            try:
                fn(env)
            except Exception as e:  # noqa: BLE001
                import traceback; traceback.print_exc()
                FAILS.append(f"{name}: виняток {type(e).__name__}: {e}")
            print("   ", "OK" if len(FAILS) == before else "ПРОВАЛ")
    finally:
        env.close()
    print(f"\nПеревірок: {CHECKS[0]}, провалів: {len(FAILS)}")
    for f in FAILS:
        print(" -", f)
    return 1 if FAILS else 0
