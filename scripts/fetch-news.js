#!/usr/bin/env node
/* Завантажує економічний календар (неофіційний фід Forex Factory через nfs.faireconomy.media) і записує data/news.json.
   Запускається GitHub Actions за розкладом (див. .github/workflows/pages.yml). Потрібен Node 18+, залежностей немає.

   Якщо фід недоступний, скрипт НЕ валить збірку: бере попередній news.json з уже опублікованого сайту (PREV_URL)
   або лишає файл із репозиторію. Застосунок сам покаже «не оновлювався понад 6 годин», якщо дані застаріли.

   Змінні: OUT (шлях виходу, типово data/news.json), PREV_URL (адреса попереднього news.json), FEED_URLS (через кому). */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = process.env.OUT || path.join(__dirname, "..", "data", "news.json");
const PREV_URL = process.env.PREV_URL || "";
const FEEDS = (process.env.FEED_URLS || "https://nfs.faireconomy.media/ff_calendar_thisweek.json,https://nfs.faireconomy.media/ff_calendar_nextweek.json")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BYTES = 2_000_000;
const warn = (msg) => console.log(`::warning::${msg}`);

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "journal-app-calendar/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error("відповідь завелика");
      return JSON.parse(text);
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

const clean = (it) => it && typeof it === "object" && !Array.isArray(it)
  ? { title: String(it.title ?? ""), country: String(it.country ?? ""), date: String(it.date ?? ""), impact: String(it.impact ?? ""), forecast: String(it.forecast ?? ""), previous: String(it.previous ?? "") }
  : null;

async function main() {
  const events = [], seen = new Set();
  let ok = 0;
  for (const [i, url] of FEEDS.entries()) {
    try {
      const j = await getJson(url);
      if (!Array.isArray(j)) throw new Error("очікувався список");
      ok++;
      for (const raw of j) {
        const it = clean(raw);
        if (!it || !it.title || !it.date) continue;
        const key = `${it.title}|${it.country}|${it.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(it);
      }
    } catch (e) {
      // наступний тиждень фід публікує не одразу, тому його відсутність не вважаємо проблемою
      (i === 0 ? warn : console.log)(`Фід ${url}: ${e.message}`);
    }
  }
  if (ok > 0 && events.length > 0) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ fetched_at: new Date().toISOString(), source: "faireconomy", events }) + "\n");
    console.log(`Записано ${events.length} подій у ${OUT}`);
    return;
  }
  warn("Не вдалося отримати свіжий календар. Лишаю попередні дані.");
  if (PREV_URL) {
    try {
      const prev = await getJson(PREV_URL, 2);
      if (prev && Array.isArray(prev.events) && prev.events.length) {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(prev) + "\n");
        console.log(`Взято попередній news.json (${prev.events.length} подій, fetched_at=${prev.fetched_at}).`);
        return;
      }
    } catch (e) { console.log(`Попередній news.json недоступний: ${e.message}`); }
  }
  console.log("Лишається файл із репозиторію.");
}

main().catch((e) => { warn(`Скрипт календаря завершився помилкою: ${e.message}`); }).finally(() => { process.exitCode = 0; });
