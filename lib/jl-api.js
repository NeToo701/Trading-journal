/* Локальний «сервер» журналу: ті самі запити, що й на сайті (JR.api.get("/journals/1/entries")), але відповідь рахується
   в браузері з даних IndexedDB. Завдяки цьому інтерфейс журналу лишився таким самим, як на сайті. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { ApiError, db, LIMITS: L, MARKETS, LOCKED } = JL;
  const urls = new Map();     // id файлу -> blob:-адреса
  const pendingImports = new Map();
  const listeners = [];
  const notify = () => { for (const f of listeners) { try { f(); } catch (e) { /* підписник не має ламати запит */ } } };
  JL.onChange = (fn) => { listeners.push(fn); };      // підписка на будь-які зміни даних (для синхронізації)
  JL.changed = notify;                                // сповістити підписників (наприклад, після відновлення з копії)

  const nowSec = () => Math.floor(Date.now() / 1000);
  const strip = (j, n) => ({ id: j.id, name: j.name, market: j.market, currency: j.currency, created_at: j.created_at, ...(n != null ? { entries: n } : {}) });
  const CUR_RE = /^[A-Za-zА-Яа-яІіЇїЄє$€₴£]{1,8}$/, CUR_UP_RE = /^[A-ZА-ЯІЇЄ$€₴£]{1,8}$/;

  async function blobUrl(t, id) {
    if (urls.has(id)) return urls.get(id);
    const b = await t.get("blobs", id);
    if (!b) return null;
    const u = URL.createObjectURL(b);
    urls.set(id, u);
    return u;
  }
  const dropUrl = (id) => { const u = urls.get(id); if (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ок */ } urls.delete(id); } };
  async function mediaOf(t, eid) {
    const rows = (await t.by("media", "entry_id", eid)).sort((a, b) => a.id - b.id);
    const out = [];
    for (const m of rows) out.push({ id: m.id, field: m.field, name: m.name, mime: m.mime, size: m.size, url: await blobUrl(t, m.id) });
    return out;
  }
  const entryOut = (e, media) => ({ id: e.id, journal_id: e.journal_id, data: e.data, media, created_at: e.created_at, updated_at: e.updated_at });

  async function ownJournal(t, jid) {
    const j = await t.get("journals", jid);
    if (!j) throw new ApiError("Журнал не знайдено.", 404);
    return j;
  }

  // ---------------------------------------------------------------- сетапи
  function setupCounts(entries) {
    const c = new Map();
    for (const e of entries) { const n = e.data.setup; if (typeof n === "string" && n) c.set(n, (c.get(n) || 0) + 1); }
    return c;
  }
  const squash = (s) => s.split(/\s+/).filter(Boolean).join(" ");
  function canonSetup(counts, clean) {
    const name = clean.setup;
    if (!name) return;
    const byFold = new Map();
    for (const [n] of [...counts].sort((a, b) => b[1] - a[1])) { const k = squash(n).toLowerCase(); if (!byFold.has(k)) byFold.set(k, n); }
    clean.setup = byFold.get(squash(name).toLowerCase()) || squash(name);
  }

  // ---------------------------------------------------------------- довідник і квота
  async function storageQuota() {
    try {
      if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); if (e.quota) return Math.min(e.quota, 8 * 1024 ** 3); }
    } catch (e) { /* ок */ }
    return 1024 ** 3;
  }
  async function usedBytes(t) { return (await t.all("media")).reduce((a, m) => a + m.size, 0); }

  const R = [];     // [метод, регулярний вираз шляху, обробник(t-контекст)]
  const route = (method, re, fn, opts = {}) => R.push({ method, re, fn, ...opts });

  route("GET", /^\/meta$/, async () => {
    const quota = await storageQuota();
    const used = await db.tx(["media"], "readonly", (t) => usedBytes(t));
    return { markets: Object.entries(MARKETS).map(([id, v]) => ({ id, label: v.label, currency: v.currency })),
      types: JL.FIELD_TYPES.map((id) => ({ id, label: JL.TYPE_LABELS[id] })),
      limits: { entries_per_journal: L.MAX_ENTRIES_PER_JOURNAL, media_per_entry: L.MAX_MEDIA_PER_ENTRY, image_mb: L.IMAGE_LIMIT / 2 ** 20,
        video_mb: L.VIDEO_LIMIT / 2 ** 20, quota_mb: Math.round(quota / 2 ** 20), import_mb: L.IMPORT_LIMIT / 2 ** 20, used_bytes: used } };
  });

  // ---------------------------------------------------------------- журнали
  route("GET", /^\/journals$/, () => db.tx(["journals", "entries"], "readonly", async (t) => {
    const js = (await t.all("journals")).sort((a, b) => JL.cmp(a.market, b.market) || (a.id - b.id));
    const out = [];
    for (const j of js) out.push(strip(j, await t.count("entries", "journal_id", j.id)));
    return { journals: out };
  }));

  route("POST", /^\/journals$/, (m, q, body) => {
    const name = JL.cleanName(body.name);
    const market = body.market;
    if (!MARKETS[market]) throw new ApiError("Обери ринок: крипта або форекс.", 422, "market");
    const cur = (body.currency ? JL.cleanText(body.currency, "currency", 8, "Валюта") : "") || MARKETS[market].currency;
    if (!CUR_RE.test(cur)) throw new ApiError("Валюта: до 8 літер, наприклад USD чи USDT.", 422, "currency");
    return db.tx(["journals", "outbox"], "readwrite", async (t) => {
      const all = await t.all("journals");
      if (all.length >= L.MAX_JOURNALS) throw new ApiError(`Журналів забагато: не більше ${L.MAX_JOURNALS}.`, 422);
      if (all.some((j) => j.market === market && j.name.toLowerCase() === name.toLowerCase())) throw new ApiError("Журнал із такою назвою в цьому ринку вже є.", 409, "name");
      const j = { id: db.nextId(), name, market, currency: cur.toUpperCase(), fields: JL.appDefaultFields(market), schema_v: JL.SCHEMA_V, created_at: nowSec(), _u: Date.now() };
      await t.put("journals", j); await t.mark("journals", j.id);
      return { status: 201, journal: strip(j, 0) };
    });
  });

  route("PATCH", /^\/journals\/(\d+)$/, (m, q, body) => {
    const jid = +m[1];
    return db.tx(["journals", "entries", "outbox"], "readwrite", async (t) => {
      const j = await ownJournal(t, jid);
      const name = body.name != null ? JL.cleanName(body.name) : j.name;
      let cur = j.currency;
      if (body.currency != null) {
        cur = JL.cleanText(body.currency, "currency", 8, "Валюта").toUpperCase();
        if (!CUR_UP_RE.test(cur)) throw new ApiError("Валюта: до 8 літер, наприклад USD чи USDT.", 422, "currency");
      }
      const others = (await t.all("journals")).filter((x) => x.id !== jid && x.market === j.market);
      if (others.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new ApiError("Журнал із такою назвою в цьому ринку вже є.", 409, "name");
      Object.assign(j, { name, currency: cur, _u: Date.now() });
      await t.put("journals", j); await t.mark("journals", jid);
      return { journal: strip(j, await t.count("entries", "journal_id", jid)) };
    });
  });

  async function removeEntries(t, entryIds) {
    for (const eid of entryIds) {
      for (const md of await t.by("media", "entry_id", eid)) { await t.del("media", md.id); await t.del("blobs", md.id); await t.mark("media", md.id, "del"); dropUrl(md.id); }
      await t.del("entries", eid); await t.mark("entries", eid, "del");
    }
  }
  route("DELETE", /^\/journals\/(\d+)$/, (m) => {
    const jid = +m[1];
    return db.tx(["journals", "entries", "media", "blobs", "reviews", "outbox"], "readwrite", async (t) => {
      await ownJournal(t, jid);
      await removeEntries(t, (await t.by("entries", "journal_id", jid)).map((e) => e.id));
      for (const r of (await t.all("reviews")).filter((x) => x.journal_id === jid)) { await t.del("reviews", r.key); await t.mark("reviews", r.key, "del"); }
      await t.del("journals", jid); await t.mark("journals", jid, "del");
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- поля
  route("GET", /^\/journals\/(\d+)\/fields$/, (m) => db.tx(["journals"], "readonly", async (t) => ({ fields: (await ownJournal(t, +m[1])).fields })));
  route("PUT", /^\/journals\/(\d+)\/fields$/, (m, q, body) => {
    const jid = +m[1];
    return db.tx(["journals", "entries", "media", "blobs", "outbox"], "readwrite", async (t) => {
      const j = await ownJournal(t, jid);
      const cleaned = JL.cleanFields(body.fields, j.fields);
      const keys = new Set(cleaned.map((f) => f.key)), mediaKeys = new Set(cleaned.filter((f) => f.type === "media").map((f) => f.key));
      j.fields = cleaned; j._u = Date.now();
      await t.put("journals", j); await t.mark("journals", jid);
      for (const e of await t.by("entries", "journal_id", jid)) {
        if (Object.keys(e.data).some((k) => !keys.has(k))) {
          e.data = Object.fromEntries(Object.entries(e.data).filter(([k]) => keys.has(k))); e._u = Date.now();
          await t.put("entries", e); await t.mark("entries", e.id);
        }
        for (const md of await t.by("media", "entry_id", e.id)) {
          if (!mediaKeys.has(md.field)) { await t.del("media", md.id); await t.del("blobs", md.id); await t.mark("media", md.id, "del"); dropUrl(md.id); }
        }
      }
      return { fields: cleaned };
    });
  });

  // ---------------------------------------------------------------- записи
  route("GET", /^\/journals\/(\d+)\/entries$/, (m, q) => {
    const jid = +m[1];
    return db.tx(["journals", "entries", "media", "blobs"], "readonly", async (t) => {
      await ownJournal(t, jid);
      const rows = (await t.by("entries", "journal_id", jid)).sort((a, b) => JL.cmp(b.opened, a.opened) || (b.id - a.id));
      const query = (q.get("q") || "").slice(0, 100).trim().toLowerCase();
      const direction = q.get("direction") || "", outcome = q.get("outcome") || "", start = q.get("from") || "", end = q.get("to") || "";
      const picked = rows.filter((r) => {
        const d = r.data;
        if (query && !JSON.stringify(d).toLowerCase().includes(query)) return false;
        if (direction && String(d.direction || "") !== direction) return false;
        if (outcome && JL.stats.effectiveOutcome(d) !== outcome && JL.stats.OUTCOMES[outcome] !== d.outcome) return false;
        const day = JL.stats.effectiveDay(d);
        if (start && (!day || day.iso < start)) return false;
        if (end && (!day || day.iso > end)) return false;
        return true;
      });
      const limit = parseInt(q.get("limit") || "100", 10), offset = parseInt(q.get("offset") || "0", 10);
      if (Number.isNaN(limit) || Number.isNaN(offset)) throw new ApiError("limit і offset мають бути числами.", 400);
      const page = picked.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(limit, 500)));
      const out = [];
      for (const e of page) out.push(entryOut(e, await mediaOf(t, e.id)));
      return { total: picked.length, entries: out };
    });
  });

  route("POST", /^\/journals\/(\d+)\/entries$/, (m, q, body) => {
    const jid = +m[1];
    return db.tx(["journals", "entries", "outbox"], "readwrite", async (t) => {
      const j = await ownJournal(t, jid);
      const existing = await t.by("entries", "journal_id", jid);
      if (existing.length >= L.MAX_ENTRIES_PER_JOURNAL) throw new ApiError(`У журналі забагато записів: не більше ${L.MAX_ENTRIES_PER_JOURNAL}.`, 422);
      const clean = JL.cleanEntry(j.fields, body.data);
      canonSetup(setupCounts(existing), clean);
      const now = nowSec();
      const e = { id: db.nextId(), journal_id: jid, data: clean, opened: clean.opened_at || "", created_at: now, updated_at: now, _u: Date.now() };
      await t.put("entries", e); await t.mark("entries", e.id);
      return { status: 201, entry: entryOut(e, []) };
    });
  });

  route("GET", /^\/entries\/(\d+)$/, (m) => db.tx(["entries", "media", "blobs"], "readonly", async (t) => {
    const e = await t.get("entries", +m[1]);
    if (!e) throw new ApiError("Запис не знайдено.", 404);
    return { entry: entryOut(e, await mediaOf(t, e.id)) };
  }));

  route("PUT", /^\/entries\/(\d+)$/, (m, q, body) => db.tx(["journals", "entries", "media", "blobs", "outbox"], "readwrite", async (t) => {
    const e = await t.get("entries", +m[1]);
    if (!e) throw new ApiError("Запис не знайдено.", 404);
    const j = await t.get("journals", e.journal_id);
    const clean = JL.cleanEntry(j.fields, body.data);
    canonSetup(setupCounts(await t.by("entries", "journal_id", e.journal_id)), clean);
    Object.assign(e, { data: clean, opened: clean.opened_at || "", updated_at: nowSec(), _u: Date.now() });
    await t.put("entries", e); await t.mark("entries", e.id);
    return { entry: entryOut(e, await mediaOf(t, e.id)) };
  }));

  route("DELETE", /^\/entries\/(\d+)$/, (m) => db.tx(["entries", "media", "blobs", "outbox"], "readwrite", async (t) => {
    if (!(await t.get("entries", +m[1]))) throw new ApiError("Запис не знайдено.", 404);
    await removeEntries(t, [+m[1]]);
    return { ok: true };
  }));

  route("GET", /^\/journals\/(\d+)\/setups$/, (m) => db.tx(["journals", "entries"], "readonly", async (t) => {
    await ownJournal(t, +m[1]);
    const counts = setupCounts(await t.by("entries", "journal_id", +m[1]));
    return { setups: [...counts].sort((a, b) => (b[1] - a[1]) || JL.cmp(a[0].toLowerCase(), b[0].toLowerCase())).map(([name, count]) => ({ name, count })) };
  }));

  // ---------------------------------------------------------------- розбір місяця
  const monthOf = (q) => { const mo = q.get("month") || ""; if (!JL.MONTH_RE.test(mo)) throw new ApiError("Місяць має бути у форматі РРРР-ММ.", 400); return mo; };
  const cfgOf = (j) => JL.reviewCfg.normalize(j.review_cfg, j.fields);
  async function getReview(t, jid, month) {
    const j = await ownJournal(t, jid);
    const row = await t.get("reviews", `${jid}|${month}`);
    const data = row ? row.data : {};
    const out = {};
    for (const f of cfgOf(j).month_fields) out[f.key] = data[f.key] != null ? data[f.key] : (f.type === "longtext" || f.type === "text" ? "" : null);
    return { month, data: out, updated_at: row ? row.updated_at : null };
  }
  route("GET", /^\/journals\/(\d+)\/review$/, (m, q) => { const mo = monthOf(q); return db.tx(["journals", "reviews"], "readonly", (t) => getReview(t, +m[1], mo)); });
  route("PUT", /^\/journals\/(\d+)\/review$/, (m, q, body) => {
    const mo = monthOf(q), jid = +m[1];
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new ApiError("Дані розбору мають бути об'єктом.", 422);
    return db.tx(["journals", "reviews", "outbox"], "readwrite", async (t) => {
      const j = await ownJournal(t, jid);
      const clean = JL.reviewCfg.cleanMonthData(cfgOf(j), body.data);
      const rec = { key: `${jid}|${mo}`, journal_id: jid, month: mo, data: clean, updated_at: nowSec(), _u: Date.now() };
      await t.put("reviews", rec); await t.mark("reviews", rec.key);
      return getReview(t, jid, mo);
    });
  });

  // налаштування сторінки «Розбір місяця» (блоки, статистика, поля): лежать у записі журналу й синхронізуються разом із ним
  route("GET", /^\/journals\/(\d+)\/review-config$/, (m) => db.tx(["journals"], "readonly", async (t) => ({ config: cfgOf(await ownJournal(t, +m[1])) })));
  route("PUT", /^\/journals\/(\d+)\/review-config$/, (m, q, body) => {
    const jid = +m[1];
    return db.tx(["journals", "outbox"], "readwrite", async (t) => {
      const j = await ownJournal(t, jid);
      const cfg = JL.reviewCfg.clean(body.config, j.fields);
      j.review_cfg = cfg; j._u = Date.now();
      await t.put("journals", j); await t.mark("journals", jid);
      return { config: cfg };
    });
  });

  // ---------------------------------------------------------------- файли
  route("POST", /^\/entries\/(\d+)\/media$/, async (m, q, file) => {
    const eid = +m[1], field = (q.get("field") || "media").slice(0, 32), name = q.get("name") || "file";
    if (!(file instanceof Blob)) throw new ApiError("Файл не передано.", 400);
    if (file.size === 0) throw new ApiError("Файл порожній.", 400);
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const info = JL.sniff(head);
    if (!info) throw new ApiError("Підтримуються фото PNG, JPEG, WebP, GIF і відео MP4, WebM, MOV.", 415);
    const [mime, ext, kind] = info;
    if (kind === "image" && file.size > L.IMAGE_LIMIT) throw new ApiError(`Файл завеликий: для фото до ${L.IMAGE_LIMIT / 2 ** 20} МБ.`, 413);
    if (kind === "video" && file.size > L.VIDEO_LIMIT) throw new ApiError(`Файл завеликий: для відео до ${L.VIDEO_LIMIT / 2 ** 20} МБ.`, 413);
    const quota = await storageQuota();
    return db.tx(["journals", "entries", "media", "blobs", "outbox"], "readwrite", async (t) => {
      const e = await t.get("entries", eid);
      if (!e) throw new ApiError("Запис не знайдено.", 404);
      const j = await t.get("journals", e.journal_id);
      if (!j.fields.some((f) => f.key === field && f.type === "media")) throw new ApiError("Це поле не призначене для файлів.", 422, "field");
      if ((await t.count("media", "entry_id", eid)) >= L.MAX_MEDIA_PER_ENTRY) throw new ApiError(`До запису можна додати не більше ${L.MAX_MEDIA_PER_ENTRY} файлів.`, 422);
      if (quota - (await usedBytes(t)) < file.size) throw new ApiError("Місце для файлів закінчилось. Видали зайві файли.", 413);
      const md = { id: db.nextId(), entry_id: eid, journal_id: e.journal_id, field, name: JL.safeFilename(name), mime, size: file.size, created_at: nowSec(), _u: Date.now() };
      await t.put("media", md); await t.put("blobs", file.slice(0, file.size, mime), md.id); await t.mark("media", md.id);
      return { status: 201, media: { id: md.id, field, name: md.name, mime, size: md.size, url: await blobUrl(t, md.id) } };
    });
  });

  route("DELETE", /^\/media\/(\d+)$/, (m) => db.tx(["media", "blobs", "outbox"], "readwrite", async (t) => {
    const id = +m[1];
    if (!(await t.get("media", id))) throw new ApiError("Файл не знайдено.", 404);
    await t.del("media", id); await t.del("blobs", id); await t.mark("media", id, "del"); dropUrl(id);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- статистика й експорт
  async function allEntries(jid) {
    return db.tx(["journals", "entries"], "readonly", async (t) => {
      await ownJournal(t, jid);
      return (await t.by("entries", "journal_id", jid)).sort((a, b) => JL.cmp(a.opened, b.opened) || (a.id - b.id));
    });
  }
  route("GET", /^\/journals\/(\d+)\/stats$/, async (m, q) => {
    const group = q.get("group") || "month";
    if (!JL.stats.GROUPS.includes(group)) throw new ApiError("group має бути одним із: " + JL.stats.GROUPS.join(", "), 400);
    const rows = await allEntries(+m[1]);
    return JL.stats.compute(rows.map((r) => [r.id, r.data]), group, q.get("from") || null, q.get("to") || null);
  });

  /** CSV для Excel: {name, blob}. */
  JL.exportCsv = async function (jid) {
    const { j, rows, counts } = await db.tx(["journals", "entries", "media"], "readonly", async (t) => {
      const jr = await ownJournal(t, jid);
      const es = (await t.by("entries", "journal_id", jid)).sort((a, b) => JL.cmp(a.opened, b.opened) || (a.id - b.id));
      const c = new Map();
      for (const e of es) c.set(e.id, await t.count("media", "entry_id", e.id));
      return { j: jr, rows: es, counts: c };
    });
    const fields = j.fields.filter((f) => f.type !== "media");
    const lines = [[...fields.map((f) => JL.csvCell(f.label)), "Файлів"]];
    for (const e of [...rows].reverse()) {
      lines.push([...fields.map((f) => {
        let v = e.data[f.key];
        if (Array.isArray(v)) v = v.join("; "); else if (typeof v === "boolean") v = v ? "так" : "ні";
        return JL.csvCell(v == null ? "" : v);
      }), counts.get(e.id) || 0]);
    }
    return { name: `${JL.safeFilename(j.name)}.csv`, blob: new Blob(["﻿" + JL.csvWrite(lines)], { type: "text/csv;charset=utf-8" }) };
  };

  // ---------------------------------------------------------------- імпорт
  route("POST", /^\/journals\/(\d+)\/import$/, async (m, q, file) => {
    const jid = +m[1];
    const fields = (await db.tx(["journals"], "readonly", (t) => ownJournal(t, jid))).fields;
    if (!(file instanceof Blob) || file.size === 0) throw new ApiError("Файл порожній.", 400);
    if (file.size > L.IMPORT_LIMIT) throw new ApiError("Файл завеликий: не більше 300 МБ.", 413);
    const src = await JL.importer.readSource(file, (q.get("name") || "").slice(0, 200));
    const keys = new Set(fields.filter((f) => f.type !== "media").map((f) => f.key));
    const samples = {};
    for (const h of src.headers) samples[h] = src.rows.map((r) => r[h]).filter(Boolean).slice(0, 3);
    const mapping = JL.importer.guessMapping(src.headers, samples, keys);
    // заголовок, що дослівно збігається з назвою поля цього журналу (наприклад, власний експорт CSV), зіставляється напряму
    const taken = new Set(Object.values(mapping).filter(Boolean));
    for (const h of src.headers) {
      if (mapping[h]) continue;
      const f = fields.find((x) => x.type !== "media" && !taken.has(x.key) && x.label.trim().toLowerCase() === h.trim().toLowerCase());
      if (f) { mapping[h] = f.key; taken.add(f.key); }
    }
    const token = JL.randomHex(16);
    pendingImports.set(token, { src, jid });
    if (pendingImports.size > 3) pendingImports.delete(pendingImports.keys().next().value);
    return { token, kind: src.kind, csv_name: src.csvName, rows: src.rows.length, images_rows: Object.keys(src.images).length,
      images: Object.values(src.images).reduce((a, v) => a + v.length, 0),
      columns: src.headers.map((h) => ({ name: h, samples: samples[h], target: mapping[h] })) };
  });

  async function importImages(eid, field, src, names) {
    let added = 0;
    for (const name of names.slice(0, L.MAX_MEDIA_PER_ENTRY)) {
      const info = src.zip.entries.find((x) => x.name === name);
      if (!info || info.size > L.IMAGE_LIMIT || info.size === 0) continue;
      const bytes = await src.zip.read(info);
      const kind = JL.sniff(bytes.subarray(0, 32));
      if (!kind || kind[2] !== "image" || bytes.length > L.IMAGE_LIMIT) continue;
      await JL.api.upload(`/entries/${eid}/media?field=${encodeURIComponent(field)}&name=${encodeURIComponent(name.split("/").pop())}`, new Blob([bytes], { type: kind[0] }));
      added++;
    }
    return added;
  }

  route("POST", /^\/journals\/(\d+)\/import\/([0-9a-f]{32})$/, async (m, q, body) => {
    const jid = +m[1], pend = pendingImports.get(m[2]);
    if (!pend || pend.jid !== jid) throw new ApiError("Файл імпорту застарів. Завантаж його ще раз.", 404);
    if (!body.mapping || typeof body.mapping !== "object" || Array.isArray(body.mapping)) throw new ApiError("Невірне зіставлення колонок.", 422);
    const skipDup = body.skip_duplicates !== false, dayFirst = body.day_first !== false;
    const { src } = pend;
    const j = await db.tx(["journals"], "readonly", (t) => ownJournal(t, jid));
    const mapping = {};
    for (const [k, v] of Object.entries(body.mapping)) if (v) mapping[String(k)] = String(v);
    const conv = new JL.importer.Converter(j.fields, mapping, dayFirst);
    if (!Object.keys(conv.mapping).length) throw new ApiError("Обери хоч одну колонку для імпорту.", 422);
    const targets = Object.values(conv.mapping);
    if (!targets.includes("opened_at") && !targets.includes("closed_at")) throw new ApiError("Зістав колонку з датою входу: без неї записи не можна додати.", 422, "opened_at");

    const mediaKey = (j.fields.find((f) => f.type === "media") || {}).key;
    let created = 0, dupes = 0, mediaAdded = 0, mediaNote = null;
    const failed = [], createdRows = [];
    await db.tx(["entries", "outbox"], "readwrite", async (t) => {
      const existingRows = await t.by("entries", "journal_id", jid);
      const sig = (d) => `${d.opened_at}|${String(d.symbol || "").toUpperCase()}|${d.direction}`;
      const existing = new Set(existingRows.map((e) => sig(e.data)));
      const counts = setupCounts(existingRows);
      let total = existingRows.length;
      for (let idx = 0; idx < src.rows.length; idx++) {
        const [data, problems] = conv.convert(src.rows[idx]);
        if (problems.length) { failed.push({ row: idx + 2, message: problems.join(", ") }); continue; }
        const s = sig(data);
        if (skipDup && existing.has(s)) { dupes++; continue; }
        if (total >= L.MAX_ENTRIES_PER_JOURNAL) { failed.push({ row: idx + 2, message: `У журналі забагато записів: не більше ${L.MAX_ENTRIES_PER_JOURNAL}.` }); break; }
        let clean;
        try { clean = JL.cleanEntry(j.fields, data); } catch (e) { if (e instanceof ApiError) { failed.push({ row: idx + 2, message: e.message }); continue; } throw e; }
        canonSetup(counts, clean);
        if (clean.setup) counts.set(clean.setup, (counts.get(clean.setup) || 0) + 1);
        const now = nowSec();
        const e = { id: db.nextId(), journal_id: jid, data: clean, opened: clean.opened_at || "", created_at: now, updated_at: now, _u: Date.now() };
        await t.put("entries", e); await t.mark("entries", e.id);
        existing.add(s); created++; total++;
        createdRows.push([idx, e.id]);
      }
    });
    if (Object.keys(conv.newOptions).length) {
      await db.tx(["journals", "outbox"], "readwrite", async (t) => {
        const cur = await ownJournal(t, jid);
        for (const f of cur.fields) {
          const extra = conv.newOptions[f.key];
          if (extra) f.options = [...(f.options || []), ...extra.filter((o) => !(f.options || []).includes(o))].slice(0, 30);
        }
        cur._u = Date.now(); await t.put("journals", cur); await t.mark("journals", jid);
      });
    }
    if (mediaKey && src.kind === "zip") {
      for (const [idx, eid] of createdRows) {
        if (!src.images[idx] || mediaNote) continue;
        try { mediaAdded += await importImages(eid, mediaKey, src, src.images[idx]); } catch (e) { if (e instanceof ApiError) mediaNote = e.message; else throw e; }
      }
    }
    pendingImports.delete(m[2]);
    const warnings = [...conv.warnings].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([text, count]) => ({ text, count }));
    if (mediaNote) warnings.push({ text: "Фото: " + mediaNote, count: 1 });
    notify();
    return { created, duplicates: dupes, failed: failed.slice(0, 30), failed_total: failed.length, media_added: mediaAdded, warnings, new_options: conv.newOptions };
  });


  // ---------------------------------------------------------------- бектести
  /* Колекції бектестів і їхні угоди. Окремо від журналів: мінімум полів (дата, інструмент, напрямок, сетап, результат у R, нотатка). */
  const colOut = (c, n) => ({ id: c.id, name: c.name, note: c.note || "", risk_pct: c.risk_pct == null ? null : c.risk_pct, created_at: c.created_at, ...(n != null ? { trades: n } : {}) });
  const tradeOut = (r, n, shots) => ({ id: r.id, col_id: r.col_id, date: r.date || "", symbol: r.symbol || "", direction: r.direction || "", setup: r.setup || "", r: r.r, note: r.note || "", ...(n != null ? { n, shots: shots || 0 } : {}) });
  /* Скріншоти угоди лежать у тому самому сховищі media, що й файли записів: entry_id = id угоди, bt = 1. Тому квота, резервна копія й синхронізація працюють без змін. */
  async function dropTradeMedia(t, tid) {
    for (const md of await t.by("media", "entry_id", tid)) { await t.del("media", md.id); await t.del("blobs", md.id); await t.mark("media", md.id, "del"); dropUrl(md.id); }
  }
  async function ownCol(t, id) {
    const c = await t.get("bt_cols", id);
    if (!c) throw new ApiError("Колекцію бектесту не знайдено.", 404);
    return c;
  }
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

  route("GET", /^\/backtests$/, () => db.tx(["bt_cols", "bt_trades"], "readonly", async (t) => {
    const cols = (await t.all("bt_cols")).sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id));
    const out = [];
    for (const c of cols) out.push(colOut(c, await t.count("bt_trades", "col_id", c.id)));
    return { backtests: out };
  }));

  route("POST", /^\/backtests$/, (m, q, body) => {
    const clean = JL.bt.cleanCol(body);
    return db.tx(["bt_cols", "outbox"], "readwrite", async (t) => {
      const all = await t.all("bt_cols");
      if (all.length >= JL.bt.LIM.MAX_COLS) throw new ApiError(`Колекцій забагато: не більше ${JL.bt.LIM.MAX_COLS}.`, 422);
      if (all.some((c) => sameName(c.name, clean.name))) throw new ApiError("Колекція з такою назвою вже є.", 409, "name");
      const c = { id: db.nextId(), ...clean, created_at: nowSec(), _u: Date.now() };
      await t.put("bt_cols", c); await t.mark("bt_cols", c.id);
      return { status: 201, backtest: colOut(c, 0) };
    });
  });

  route("PATCH", /^\/backtests\/(\d+)$/, (m, q, body) => {
    const id = +m[1];
    return db.tx(["bt_cols", "bt_trades", "outbox"], "readwrite", async (t) => {
      const c = await ownCol(t, id);
      const clean = JL.bt.cleanCol({ name: body.name != null ? body.name : c.name, note: body.note != null ? body.note : c.note,
        risk_pct: Object.prototype.hasOwnProperty.call(body, "risk_pct") ? body.risk_pct : c.risk_pct });
      if ((await t.all("bt_cols")).some((x) => x.id !== id && sameName(x.name, clean.name))) throw new ApiError("Колекція з такою назвою вже є.", 409, "name");
      Object.assign(c, clean, { _u: Date.now() });
      await t.put("bt_cols", c); await t.mark("bt_cols", id);
      return { backtest: colOut(c, await t.count("bt_trades", "col_id", id)) };
    });
  });

  route("DELETE", /^\/backtests\/(\d+)$/, (m) => {
    const id = +m[1];
    return db.tx(["bt_cols", "bt_trades", "media", "blobs", "outbox"], "readwrite", async (t) => {
      await ownCol(t, id);
      for (const r of await t.by("bt_trades", "col_id", id)) { await dropTradeMedia(t, r.id); await t.del("bt_trades", r.id); await t.mark("bt_trades", r.id, "del"); }
      await t.del("bt_cols", id); await t.mark("bt_cols", id, "del");
      return { ok: true };
    });
  });

  /** Колекція разом з усіма її угодами (в хронологічному порядку, з номерами) і статистикою: одним запитом. */
  route("GET", /^\/backtests\/(\d+)$/, (m) => db.tx(["bt_cols", "bt_trades", "media"], "readonly", async (t) => {
    const c = await ownCol(t, +m[1]);
    const rows = await t.by("bt_trades", "col_id", c.id);
    const ids = new Set(rows.map((r) => r.id)), shots = new Map();
    for (const md of await t.all("media")) if (ids.has(md.entry_id)) shots.set(md.entry_id, (shots.get(md.entry_id) || 0) + 1);
    const ordered = JL.bt.order(rows);
    return { backtest: colOut(c, rows.length), trades: ordered.map((r, i) => tradeOut(r, i + 1, shots.get(r.id))), stats: JL.bt.compute(rows, c.risk_pct) };
  }));

  route("POST", /^\/backtests\/(\d+)\/trades$/, (m, q, body) => {
    const id = +m[1];
    const clean = JL.bt.cleanTrade(body);
    return db.tx(["bt_cols", "bt_trades", "outbox"], "readwrite", async (t) => {
      await ownCol(t, id);
      const rows = await t.by("bt_trades", "col_id", id);
      if (rows.length >= JL.bt.LIM.MAX_TRADES) throw new ApiError(`У колекції забагато угод: не більше ${JL.bt.LIM.MAX_TRADES}.`, 422);
      clean.setup = JL.bt.canonSetup(rows, clean.setup);
      const r = { id: db.nextId(), col_id: id, ...clean, created_at: nowSec(), _u: Date.now() };
      await t.put("bt_trades", r); await t.mark("bt_trades", r.id);
      return { status: 201, trade: tradeOut(r) };
    });
  });

  route("PUT", /^\/backtest-trades\/(\d+)$/, (m, q, body) => {
    const id = +m[1];
    const clean = JL.bt.cleanTrade(body);
    return db.tx(["bt_trades", "outbox"], "readwrite", async (t) => {
      const r = await t.get("bt_trades", id);
      if (!r) throw new ApiError("Угоду не знайдено.", 404);
      const others = (await t.by("bt_trades", "col_id", r.col_id)).filter((x) => x.id !== id);
      clean.setup = JL.bt.canonSetup(others, clean.setup);
      Object.assign(r, clean, { _u: Date.now() });
      await t.put("bt_trades", r); await t.mark("bt_trades", id);
      return { trade: tradeOut(r) };
    });
  });

  route("DELETE", /^\/backtest-trades\/(\d+)$/, (m) => {
    const id = +m[1];
    return db.tx(["bt_trades", "media", "blobs", "outbox"], "readwrite", async (t) => {
      if (!(await t.get("bt_trades", id))) throw new ApiError("Угоду не знайдено.", 404);
      await dropTradeMedia(t, id);
      await t.del("bt_trades", id); await t.mark("bt_trades", id, "del");
      return { ok: true };
    });
  });

  route("GET", /^\/backtest-trades\/(\d+)\/media$/, (m) => db.tx(["bt_trades", "media", "blobs"], "readonly", async (t) => {
    if (!(await t.get("bt_trades", +m[1]))) throw new ApiError("Угоду не знайдено.", 404);
    return { media: await mediaOf(t, +m[1]) };
  }));

  /** Скріншот до угоди бектесту: лише фото. Перевірки як у файлів запису (тип за вмістом, розмір, ліміт на угоду, місце). */
  route("POST", /^\/backtest-trades\/(\d+)\/media$/, async (m, q, file) => {
    const tid = +m[1], name = q.get("name") || "screenshot";
    if (!(file instanceof Blob)) throw new ApiError("Файл не передано.", 400);
    if (file.size === 0) throw new ApiError("Файл порожній.", 400);
    const info = JL.sniff(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (!info || info[2] !== "image") throw new ApiError("До угод бектесту можна додавати лише фото: PNG, JPEG, WebP або GIF.", 415);
    const [mime] = info;
    if (file.size > L.IMAGE_LIMIT) throw new ApiError(`Файл завеликий: для фото до ${L.IMAGE_LIMIT / 2 ** 20} МБ.`, 413);
    const quota = await storageQuota();
    return db.tx(["bt_trades", "media", "blobs", "outbox"], "readwrite", async (t) => {
      if (!(await t.get("bt_trades", tid))) throw new ApiError("Угоду не знайдено.", 404);
      if ((await t.count("media", "entry_id", tid)) >= L.MAX_MEDIA_PER_ENTRY) throw new ApiError(`До угоди можна додати не більше ${L.MAX_MEDIA_PER_ENTRY} скріншотів.`, 422);
      if (quota - (await usedBytes(t)) < file.size) throw new ApiError("Місце для файлів закінчилось. Видали зайві файли.", 413);
      const md = { id: db.nextId(), entry_id: tid, journal_id: null, bt: 1, field: "shots", name: JL.safeFilename(name), mime, size: file.size, created_at: nowSec(), _u: Date.now() };
      await t.put("media", md); await t.put("blobs", file.slice(0, file.size, mime), md.id); await t.mark("media", md.id);
      return { status: 201, media: { id: md.id, field: md.field, name: md.name, mime, size: md.size, url: await blobUrl(t, md.id) } };
    });
  });

  /** CSV однієї колекції для Excel: {name, blob}. */
  JL.exportBacktestCsv = async function (id) {
    const { c, rows, shots } = await db.tx(["bt_cols", "bt_trades", "media"], "readonly", async (t) => {
      const cc = await ownCol(t, id), rs = await t.by("bt_trades", "col_id", id), counts = new Map();
      for (const r of rs) counts.set(r.id, await t.count("media", "entry_id", r.id));
      return { c: cc, rows: rs, shots: counts };
    });
    const lines = [["№", "Дата", "Інструмент", "Напрямок", "Сетап", "Результат, R", "Нотатка", "Скріншотів"].map(JL.csvCell)];
    JL.bt.order(rows).forEach((r, i) => lines.push([i + 1, r.date || "", r.symbol || "", r.direction || "", r.setup || "", r.r, r.note || ""].map((v) => JL.csvCell(v)).concat([shots.get(r.id) || 0])));
    return { name: `${JL.safeFilename("Бектест " + c.name)}.csv`, blob: new Blob(["\ufeff" + JL.csvWrite(lines)], { type: "text/csv;charset=utf-8" }) };
  };

  // ---------------------------------------------------------------- калькулятори (активи й налаштування)
  /* Записи лежать у сховищі calc: «asset|СИМВОЛ» (змінений вбудований або власний актив) і «prefs» (депозит, ризик, валюта рахунку).
     Вбудовані EURUSD, GBPUSD, XAUUSD лишаються в коді: запис поверх них можна скинути, видалення власного активу прибирає запис. */
  const assetKey = (sym) => `asset|${sym}`;
  /** Записи з бази, що пройшли перевірку (дані з хмари чи копії не мають ламати список). */
  function validAssetRows(rows) {
    const out = [];
    for (const r of rows) {
      if (!r || typeof r.key !== "string" || !r.key.startsWith("asset|")) continue;
      try { const c = JL.calc.cleanAsset(r, r.symbol); if (assetKey(c.symbol) === r.key) out.push({ key: r.key, ...c }); } catch (e) { /* пошкоджений запис ігноруємо */ }
    }
    return out;
  }
  const calcAssets = async (t, all) => JL.calc.mergeAssets(validAssetRows(await t.all("calc")), all);
  const assetOut = (a) => a;

  route("GET", /^\/calc\/assets$/, (m, q) => db.tx(["calc"], "readonly", async (t) => ({ assets: (await calcAssets(t, q.get("all") === "1")).map(assetOut) })));

  route("POST", /^\/calc\/assets$/, (m, q, body) => {
    const clean = JL.calc.cleanAsset(body);
    return db.tx(["calc", "outbox"], "readwrite", async (t) => {
      const all = await calcAssets(t, true);
      if (all.some((a) => a.symbol === clean.symbol)) throw new ApiError("Актив з таким символом уже є. Відкрий його й зміни параметри.", 409, "symbol");
      if (all.length >= JL.calc.LIM.MAX_ASSETS) throw new ApiError(`Активів забагато: не більше ${JL.calc.LIM.MAX_ASSETS}.`, 422);
      clean.hidden = false;
      const row = { key: assetKey(clean.symbol), ...clean, _u: Date.now() };
      await t.put("calc", row); await t.mark("calc", row.key);
      return { status: 201, asset: assetOut({ ...clean, builtin: false, modified: false }) };
    });
  });

  route("PUT", /^\/calc\/assets\/([A-Za-z0-9._-]{1,20})$/, (m, q, body) => {
    const sym = JL.calc.normSymbol(m[1]);
    const clean = JL.calc.cleanAsset(body, sym);
    return db.tx(["calc", "outbox"], "readwrite", async (t) => {
      const cur = (await calcAssets(t, true)).find((a) => a.symbol === sym);
      if (!cur) throw new ApiError("Актив не знайдено.", 404);
      const row = { key: assetKey(sym), ...clean, hidden: body.hidden === undefined ? !!cur.hidden : !!body.hidden, _u: Date.now() };
      await t.put("calc", row); await t.mark("calc", row.key);
      return { asset: assetOut({ ...row, key: undefined, _u: undefined, builtin: cur.builtin, modified: cur.builtin }) };
    });
  });

  // Власний актив видаляється, вбудований скидається до стандартних параметрів (і знову з'являється, якщо був схований).
  route("DELETE", /^\/calc\/assets\/([A-Za-z0-9._-]{1,20})$/, (m) => {
    const sym = JL.calc.normSymbol(m[1]);
    return db.tx(["calc", "outbox"], "readwrite", async (t) => {
      const key = assetKey(sym);
      const row = await t.get("calc", key);
      const builtin = JL.calc.DEFAULT_ASSETS.some((a) => a.symbol === sym);
      if (!row) { if (builtin) return { ok: true }; throw new ApiError("Актив не знайдено.", 404); }
      await t.del("calc", key); await t.mark("calc", key, "del");
      return { ok: true };
    });
  });

  const prefsOf = (row) => { try { return JL.calc.cleanPrefs(row ? { ...row, key: undefined } : {}); } catch (e) { return { ...JL.calc.DEFAULT_PREFS }; } };
  route("GET", /^\/calc\/prefs$/, () => db.tx(["calc"], "readonly", async (t) => ({ prefs: prefsOf(await t.get("calc", "prefs")) })));
  route("PUT", /^\/calc\/prefs$/, (m, q, body) => db.tx(["calc", "outbox"], "readwrite", async (t) => {
    const merged = JL.calc.cleanPrefs({ ...prefsOf(await t.get("calc", "prefs")), ...(body && typeof body === "object" ? body : {}) });
    await t.put("calc", { key: "prefs", ...merged, _u: Date.now() }); await t.mark("calc", "prefs");
    return { prefs: merged };
  }));

  // ---------------------------------------------------------------- міграція журналів до поточної схеми
  /* v2: чотири питання розбору (за правилами / тейк після стопа / зайшов би знову / чому ні) ховаються з форми запису,
     а «Ключові помилки» отримують професійніші назви (у списку варіантів і в уже збережених записах).
     Виконується один раз на журнал: позначка schema_v лежить у самому журналі, тому синхронізується між пристроями. */
  JL.migrateJournals = async function () {
    const done = await db.tx(["journals", "entries", "outbox"], "readwrite", async (t) => {
      let n = 0;
      for (const j of await t.all("journals")) {
        if ((j.schema_v || 1) >= JL.SCHEMA_V) continue;
        for (const f of j.fields) {
          if (f.builtin && JL.REVIEW_ONLY_KEYS.includes(f.key)) f.hidden = true;
          if (f.builtin && f.key === "mistakes" && Array.isArray(f.options)) {
            const mapped = f.options.map((o) => JL.MISTAKE_RENAMES[o] || o);
            f.options = mapped.filter((o, i) => mapped.indexOf(o) === i).slice(0, L.MAX_OPTIONS);
          }
        }
        j.schema_v = JL.SCHEMA_V; j._u = Date.now();
        await t.put("journals", j); await t.mark("journals", j.id);
        for (const e of await t.by("entries", "journal_id", j.id)) {
          const list = e.data && e.data.mistakes;
          if (!Array.isArray(list) || !list.some((o) => JL.MISTAKE_RENAMES[o])) continue;
          const mapped = list.map((o) => JL.MISTAKE_RENAMES[o] || o);
          e.data = { ...e.data, mistakes: mapped.filter((o, i) => mapped.indexOf(o) === i) }; e._u = Date.now();
          await t.put("entries", e); await t.mark("entries", e.id);
        }
        n++;
      }
      return n;
    });
    if (done) notify();
    return done;
  };

  // ---------------------------------------------------------------- вхідна точка
  async function request(method, pathAndQuery, body) {
    const u = new URL(pathAndQuery, "http://local");
    for (const r of R) {
      if (r.method !== method) continue;
      const m = r.re.exec(u.pathname);
      if (!m) continue;
      const out = await r.fn(m, u.searchParams, body === undefined ? {} : body);
      if (method !== "GET") notify();
      return out;
    }
    throw new ApiError("Невідомий запит.", 404);
  }
  JL.api = {
    get: (p) => request("GET", p), post: (p, b) => request("POST", p, b === undefined ? {} : b), put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b), del: (p) => request("DELETE", p, {}), upload: (p, file) => request("POST", p, file),
  };
  JL.mediaUrls = { get: (id) => urls.get(id), drop: dropUrl, dropAll: () => { for (const id of [...urls.keys()]) dropUrl(id); } };
})(typeof window !== "undefined" ? window : globalThis);
