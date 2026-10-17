/* Звірка JavaScript-коду цього застосунку з серверним Python-кодом сайту на однакових вхідних даних.
   Еталони лежать у fixtures/parity.json.gz (їх генерує gen_fixtures.py). Запуск: node tests/parity.test.js */
"use strict";
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const root = path.join(__dirname, "..");
for (const f of ["jl-util", "jl-schema", "jl-stats", "jl-import", "jl-news"]) require(path.join(root, "lib", f + ".js"));
const JL = globalThis.JL;
const FX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "parity.json.gz"))).toString("utf8"));

function same(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!(k in b) || !same(a[k], b[k])) return false;
  return true;
}
const norm = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));
const short = (x) => { const s = JSON.stringify(x); return s.length > 400 ? s.slice(0, 400) + "…" : s; };
let failed = 0, total = 0;
function check(group, label, got, want, input) {
  total++;
  if (same(norm(got), want)) return;
  failed++;
  if (!check.shown[group]) check.shown[group] = 0;
  if (check.shown[group]++ < 4) console.log(`✗ ${group} ${label}\n    вхід:     ${short(input)}\n    очікувано: ${short(want)}\n    отримано:  ${short(norm(got))}`);
}
check.shown = {};
const capture = (fn) => { try { return { ok: fn() }; } catch (e) { if (e instanceof JL.ApiError) return { error: e.message, status: e.status, field: e.field === undefined ? null : e.field }; throw e; } };
// власні поля мають випадкові ключі c_xxxxxxxx: нумеруємо за порядком появи, як у генераторі
function normKeys(x) {
  const seen = {};
  const key = (k) => { if (typeof k === "string" && /^c_[0-9a-f]{8}$/.test(k)) { if (!(k in seen)) seen[k] = `c_${Object.keys(seen).length}`; return seen[k]; } return k; };
  const walk = (v) => Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, val]) => [key(k), walk(val)])) : (typeof v === "string" ? key(v) : v);
  return walk(x);
}

// поля за замовчуванням
for (const m of ["crypto", "forex"]) check("default_fields", m, JL.defaultFields(m), FX.default_fields[m], m);
const F = { crypto: JL.defaultFields("crypto"), forex: JL.defaultFields("forex") };

for (const c of FX.clean_entry) check("clean_entry", c.market, capture(() => JL.cleanEntry(F[c.market], c.data)), c.result, c.data);

for (const c of FX.clean_fields) {
  const r = capture(() => JL.cleanFields(c.new, F[c.market]));
  check("clean_fields", c.market, r.ok ? { ok: normKeys(r.ok) } : r, c.result, c.new);
}

for (const c of FX.stats) {
  const entries = FX.stats_sets[c.set];
  check("stats", `${c.group} ${c.start}..${c.end} n=${entries.length}`, capture(() => JL.stats.compute(entries, c.group, c.start, c.end)), c.result, { n: entries.length, group: c.group, start: c.start, end: c.end });
}

for (const c of FX.parse_number) check("parse_number", JSON.stringify(c.v), JL.importer.parseNumber(c.v, c.ratio), c.result, [c.v, c.ratio]);
for (const c of FX.parse_datetime) {
  const p = JL.importer.parseDatetime(c.v, c.day_first);
  check("parse_datetime", JSON.stringify(c.v), p ? [p.day.iso, p.time] : null, c.result, [c.v, c.day_first]);
}
for (const c of FX.norm_tf) check("norm_tf", c.v, JL.importer.normTf(c.v), c.result, c.v);

for (const c of FX.parse_csv) {
  const bytes = new Uint8Array(Buffer.from(c.bytes, "base64"));
  const r = capture(() => { const o = JL.importer.parseCsv(bytes); return { headers: o.headers, rows: o.rows }; });
  check("parse_csv", c.name, r, c.result, c.name);
}

for (const c of FX.guess_mapping) {
  const keys = new Set(F[c.market].map((f) => f.key));
  check("guess_mapping", c.headers.join("|"), JL.importer.guessMapping(c.headers, c.samples, keys), c.result, c.headers);
}

for (const [i, c] of FX.converter.entries()) {
  const conv = new JL.importer.Converter(F[c.market], c.mapping, c.day_first);
  const results = c.rows.map((r) => conv.convert(r));
  results.forEach((r, k) => check("converter", `набір ${i}, рядок ${k}`, r, c.results[k], c.rows[k]));
  check("converter.warnings", `набір ${i}`, Object.fromEntries(conv.warnings), c.warnings, null);
  check("converter.new_options", `набір ${i}`, conv.newOptions, c.new_options, null);
}

for (const c of FX.safe_filename) check("safe_filename", JSON.stringify(c.v), JL.safeFilename(c.v), c.result, c.v);
for (const c of FX.csv_cell) check("csv_cell", JSON.stringify(c.v), JL.csvCell(c.v), c.result, c.v);

// календар новин
for (const [i, c] of FX.news_parse.entries()) check("news_parse", `набір ${i}`, (() => { try { return { ok: JL.news.parseFaireconomy(c.items) }; } catch (e) { return { error: e.message }; } })(), c.result, c.items);
for (const c of FX.news_describe) check("news_describe", `${c.title} / ${c.impact}`, JL.news.describe(c.title, c.impact), c.result, [c.title, c.impact]);
{
  const snap = { events: JL.news.parseFaireconomy(FX.news_view.items), source: "static", error: null, stale: false, fetched_at: FX.news_view.fetched_at * 1000 };
  for (const v of FX.news_view.views) check("news_view", `${v.now} days=${v.days} past=${v.past}`, JL.news.view(snap, Date.parse(v.now), v.days, v.past), v.result, v);
}

console.log(failed ? `\nПровалено ${failed} з ${total}` : `OK: ${total} звірок з Python, усе збігається`);
process.exit(failed ? 1 : 0);
