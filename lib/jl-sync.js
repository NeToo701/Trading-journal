/* Синхронізація з хмарою. Локальна база (IndexedDB) завжди головна: застосунок працює без інтернету й без акаунта.
   Хмара — лише дзеркало між пристроями. Правило конфліктів: перемагає змінений пізніше запис (за годинником пристрою).

   Усе, що змінилось локально, потрапляє в чергу outbox. Синхронізація: 1) забрати з хмари нове (за курсором srv),
   2) відправити чергу. Видалення синхронізуються «надгробками» (запис з deleted=true).

   Хмара підключається через JL.cloud (lib/jl-firebase.js): { adapter() -> {push(docs), pull(cursor, limit)} }.
   Формат документа: { kind, rid, deleted, u, data: JSON-рядок | null, blob: base64 | null }. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { db } = JL;
  const STORE = { journals: "journals", entries: "entries", reviews: "reviews", media: "media" };
  const CLOUD_IMG_MAX = 640 * 1024;       // фото більше цього розміру стискаємо перед відправкою (ліміт документа Firestore 1 МБ)
  const BATCH_BYTES = 5 * 1024 * 1024, BATCH_DOCS = 100;

  const listeners = {};
  const emit = (name, arg) => { for (const f of listeners[name] || []) { try { f(arg); } catch (e) { /* ок */ } } };
  const S = { state: "off", last: null, pending: 0, error: "", skipped: 0, localOnly: 0 };
  function setState(state, error = "") { S.state = state; S.error = error; emit("status", { ...S }); }

  const keyOf = (kind, rid) => {
    if (kind === "reviews") return typeof rid === "string" && rid ? rid : null;
    const n = Number(rid);
    return Number.isFinite(n) ? n : null;
  };
  const ridOf = (rec, kind) => String(kind === "reviews" ? rec.key : rec.id);
  const withoutU = (rec) => { const { _u, ...rest } = rec; return rest; };

  // ---------------------------------------------------------------- стискання фото для хмари
  function toBlob(canvas, q) { return new Promise((res) => canvas.toBlob(res, "image/jpeg", q)); }
  async function shrink(blob, maxBytes) {
    if (blob.size <= maxBytes) return blob;
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch (e) { return null; }
    let scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    for (let i = 0; i < 8; i++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
      for (const q of [0.85, 0.7, 0.55]) { const out = await toBlob(c, q); if (out && out.size <= maxBytes) { bmp.close && bmp.close(); return out; } }
      scale *= 0.75;
    }
    bmp.close && bmp.close();
    return null;
  }
  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).slice(String(r.result).indexOf(",") + 1));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64, mime) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // ---------------------------------------------------------------- локальне видалення (за вказівкою з хмари)
  async function removeLocal(t, kind, key) {
    const dropped = [];
    const dropMedia = async (m) => { await t.del("media", m.id); await t.del("blobs", m.id); await t.del("outbox", `media/${m.id}`); dropped.push(m.id); };
    const dropEntry = async (e) => {
      for (const m of await t.by("media", "entry_id", e.id)) await dropMedia(m);
      await t.del("entries", e.id); await t.del("outbox", `entries/${e.id}`);
    };
    if (kind === "media") { const m = await t.get("media", key); if (m) await dropMedia(m); }
    else if (kind === "entries") { const e = await t.get("entries", key); if (e) await dropEntry(e); }
    else if (kind === "reviews") await t.del("reviews", key);
    else if (kind === "journals") {
      for (const e of await t.by("entries", "journal_id", key)) await dropEntry(e);
      for (const r of (await t.all("reviews")).filter((x) => x.journal_id === key)) { await t.del("reviews", r.key); await t.del("outbox", `reviews/${r.key}`); }
      await t.del("journals", key);
    }
    await t.del("outbox", `${kind}/${key}`);
    return dropped;
  }

  /** Застосовує один документ з хмари. Повертає true, якщо локальні дані змінились. */
  async function applyRemote(d) {
    const store = STORE[d.kind];
    const key = store ? keyOf(d.kind, d.rid) : null;
    if (!store || key == null) return false;
    let changed = false, dropped = [];
    await db.tx(["journals", "entries", "reviews", "media", "blobs", "outbox"], "readwrite", async (t) => {
      const cur = await t.get(store, key);
      const ob = await t.get("outbox", `${d.kind}/${key}`);
      if (d.deleted) {
        if (ob && ob.op === "del" && ob.ts > d.u) return;                 // наше видалення новіше: відправимо своє
        if (cur && (cur._u || 0) > d.u) { await t.mark(d.kind, key, "put"); return; }   // після видалення запис змінили: лишаємо й повертаємо в хмару
        if (cur) { dropped = await removeLocal(t, d.kind, key); changed = true; }
        else if (ob) await t.del("outbox", ob.key);
        return;
      }
      if (cur && (cur._u || 0) > d.u) { await t.mark(d.kind, key, "put"); return; }    // у нас новіше: виправляємо хмару
      if (cur && (cur._u || 0) === d.u) return;                                          // те саме (відлуння власної відправки)
      if (!cur && ob && ob.op === "del" && ob.ts >= d.u) return;                         // ми видалили пізніше
      let rec;
      try { rec = JSON.parse(d.data); } catch (e) { return; }
      if (!rec || typeof rec !== "object") return;
      if (d.kind === "reviews") rec.key = String(key); else rec.id = key;
      if (d.kind === "media") {
        if (!d.blob) return;
        const blob = base64ToBlob(d.blob, rec.mime || "application/octet-stream");
        rec.size = blob.size;
        await t.put("blobs", blob, key);
        dropped = [key];
      }
      rec._u = d.u;
      await t.put(store, rec);
      if (ob) await t.del("outbox", ob.key);
      changed = true;
    });
    if (dropped.length && JL.mediaUrls) dropped.forEach((id) => JL.mediaUrls.drop(id));
    return changed;
  }

  async function pull(ad) {
    let cursor = (await db.meta.get("cursor")) || null, any = false;
    for (let guard = 0; guard < 100000; guard++) {
      const page = await ad.pull(cursor, 25);
      for (const d of page.docs) if (await applyRemote(d)) any = true;
      if (page.cursor && page.cursor !== cursor) { cursor = page.cursor; await db.meta.set("cursor", cursor); }
      if (!page.more) break;
    }
    if (any) emit("data");
  }

  // ---------------------------------------------------------------- відправка
  async function buildDoc(t, o) {
    if (o.op === "del") return { doc: { kind: o.kind, rid: String(o.id), deleted: true, u: o.ts, data: null, blob: null } };
    const key = keyOf(o.kind, o.id);
    const rec = await t.get(STORE[o.kind], key);
    if (!rec) return { drop: true };
    if (o.kind !== "media") return { doc: { kind: o.kind, rid: String(o.id), deleted: false, u: rec._u || o.ts, data: JSON.stringify(withoutU(rec)), blob: null } };
    if (!String(rec.mime).startsWith("image/")) return { drop: true, localOnly: true };      // відео лишаються лише на пристрої
    return { media: rec, blob: await t.get("blobs", key) };
  }

  async function push(ad) {
    S.skipped = 0; S.localOnly = 0;
    for (let guard = 0; guard < 100000; guard++) {
      const todo = (await db.tx(["outbox"], "readonly", (t) => t.all("outbox"))).sort((a, b) => a.ts - b.ts);
      S.pending = todo.length; emit("status", { ...S });
      if (!todo.length) return;
      const docs = [], done = []; let bytes = 0;
      for (const o of todo) {
        if (docs.length >= BATCH_DOCS || bytes >= BATCH_BYTES) break;
        const built = await db.tx(["journals", "entries", "reviews", "media", "blobs"], "readonly", (t) => buildDoc(t, o));
        if (built.drop) { if (built.localOnly) S.localOnly++; done.push(o); continue; }
        if (built.doc) { docs.push(built.doc); done.push(o); continue; }
        // фото: стискаємо за потреби й кодуємо в base64
        let blob = built.blob;
        if (!blob) { done.push(o); continue; }
        const small = await shrink(blob, CLOUD_IMG_MAX);
        if (!small) { S.skipped++; done.push(o); continue; }
        const rec = { ...built.media, size: small.size, mime: small === blob ? built.media.mime : "image/jpeg" };
        docs.push({ kind: "media", rid: String(o.id), deleted: false, u: built.media._u || o.ts, data: JSON.stringify(withoutU(rec)), blob: await blobToBase64(small) });
        bytes += small.size; done.push(o);
      }
      if (docs.length) await ad.push(docs);
      await db.tx(["outbox"], "readwrite", async (t) => {      // прибираємо відправлене, якщо запис за цей час не змінювали
        for (const o of done) { const now = await t.get("outbox", o.key); if (now && now.ts === o.ts) await t.del("outbox", o.key); }
      });
      if (!done.length) return;
    }
  }

  // ---------------------------------------------------------------- запуск
  let running = null, again = false, timer = null, retry = null;
  let bound = null;
  const cloud = () => bound || JL.cloud;

  async function run() {
    if (running) { again = true; return running; }
    const c = cloud();
    const user = c && c.user && c.user();
    if (!user) { setState("off"); return; }
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setState("offline"); return; }
    running = (async () => {
      setState("syncing");
      try {
        const ad = c.adapter();
        await pull(ad);
        await push(ad);
        S.last = Date.now(); await db.meta.set("lastSync", S.last);
        S.pending = await db.tx(["outbox"], "readonly", (t) => t.count("outbox"));
        setState("idle");
      } catch (e) {
        setState("error", (e && e.message) || String(e));
        clearTimeout(retry); retry = setTimeout(() => run(), 60000);
      } finally { running = null; if (again) { again = false; schedule(500); } }
    })();
    return running;
  }
  function schedule(ms = 3000) { clearTimeout(timer); timer = setTimeout(() => run(), ms); }

  async function markAll() {
    await db.tx(["journals", "entries", "reviews", "media", "outbox"], "readwrite", async (t) => {
      for (const kind of Object.keys(STORE)) for (const r of await t.all(STORE[kind])) await t.mark(kind, ridOf(r, kind));
    });
  }
  const hasLocalData = () => db.tx(["journals"], "readonly", (t) => t.count("journals")).then((n) => n > 0);

  /** Прив'язує пристрій до акаунта. Якщо тут лежать дані іншого акаунта, повертає {conflict:true} (треба підтвердження). */
  async function attach(uid, opts = {}) {
    const prev = await db.meta.get("cloudUid");
    if (prev && prev !== uid) {
      if (!opts.wipe && (await hasLocalData())) return { conflict: true, prev };
      await db.clearAll(true); if (JL.mediaUrls) JL.mediaUrls.dropAll();
      await db.meta.del("cursor");
      await db.meta.set("cloudUid", uid);
      emit("data");
    } else if (!prev) {
      await db.meta.set("cloudUid", uid);
      await db.meta.del("cursor");
      await markAll();
    }
    schedule(0);
    return { ok: true };
  }

  let globalsOn = false;
  async function listenGlobal() {
    if (globalsOn) return;
    globalsOn = true;
    JL.onChange(() => { const c = cloud(); if (c && c.user && c.user()) schedule(3000); });
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("online", () => schedule(500));
      window.addEventListener("offline", () => { const c = cloud(); if (c && c.user && c.user()) setState("offline"); });
    }
    S.last = (await db.meta.get("lastSync")) || null;
  }
  /** Підписується на вхід/вихід в акаунт. Окремо від start(), щоб у тестах можна було підставити іншу «хмару». */
  function bind(c) {
    bound = c;
    c.onUser(async (user) => {
      if (bound !== c) return;
      if (!user) { setState("off"); return; }
      const r = await attach(user.uid);
      if (r.conflict) emit("conflict", { uid: user.uid });
    });
  }
  async function start() { await listenGlobal(); bind(JL.cloud); }
  async function resolveConflict(uid, wipe) {
    if (!wipe) { await cloud().signOut(); return; }
    await attach(uid, { wipe: true });
  }
  async function pendingCount() { return db.tx(["outbox"], "readonly", (t) => t.count("outbox")); }

  JL.sync = {
    start, bind, run, schedule, attach, resolveConflict, pendingCount, status: () => ({ ...S }),
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    _applyRemote: applyRemote, _shrink: shrink,
  };
})(typeof window !== "undefined" ? window : globalThis);
