/* Перевірка scripts/fetch-news.js на локальному сервері: успіх, дублікати, відсутній наступний тиждень, повний збій + запасний файл. */
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const script = path.join(__dirname, "..", "scripts", "fetch-news.js");
let mode = "ok", failed = 0;
const week = [{ title: "CPI y/y", country: "USD", date: "2026-10-20T12:30:00+00:00", impact: "High", forecast: "3%", previous: "2.9%" },
              { title: "CPI y/y", country: "USD", date: "2026-10-20T12:30:00+00:00", impact: "High", forecast: "3%", previous: "2.9%" },
              { title: "", country: "USD", date: "2026-10-20T12:30:00+00:00" }, 5, null,
              { title: "Bank Holiday", country: "JPY", date: "2026-10-21T00:00:00+00:00", impact: "Holiday", forecast: null }];
const prevJson = { fetched_at: "2026-10-15T10:00:00.000Z", source: "faireconomy", events: [week[0]] };
const srv = http.createServer((req, res) => {
  if (req.url === "/this.json") { if (mode === "down") { res.writeHead(503); return res.end("x"); } res.end(JSON.stringify(week)); }
  else if (req.url === "/next.json") { res.writeHead(404); res.end("nope"); }
  else if (req.url === "/prev.json") res.end(JSON.stringify(prevJson));
  else { res.writeHead(404); res.end(); }
});
const ok = (c, m) => { if (!c) { failed++; console.log("✗ " + m); } };
srv.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  const run = (env) => new Promise((resolve) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fn-")), "data", "news.json");
    require("child_process").execFile("node", [script], { env: { ...process.env, OUT: out, FEED_URLS: `${base}/this.json,${base}/next.json`, ...env } }, (err, stdout) => resolve({ err, stdout, out }));
  });
  let r = await run({});
  ok(!r.err, "успішний запуск без помилки");
  let j = JSON.parse(fs.readFileSync(r.out, "utf8"));
  ok(j.source === "faireconomy" && j.events.length === 2, "2 унікальні події, є " + j.events.length);
  ok(j.events[1].forecast === "" && j.events[1].impact === "Holiday", "null -> порожній рядок");
  ok(Math.abs(Date.now() - Date.parse(j.fetched_at)) < 60000, "fetched_at свіжий");
  mode = "down";
  r = await run({ PREV_URL: `${base}/prev.json` });
  ok(!r.err, "збій фіду не валить запуск");
  ok(/::warning::/.test(r.stdout), "є попередження");
  j = JSON.parse(fs.readFileSync(r.out, "utf8"));
  ok(j.fetched_at === prevJson.fetched_at, "взято попередній файл");
  r = await run({});
  ok(!r.err && !fs.existsSync(r.out), "без запасного файлу нічого не створюється й запуск не падає");
  srv.close();
  console.log(failed ? `Провалено: ${failed}` : "OK: fetch-news працює");
  process.exit(failed ? 1 : 0);
});
