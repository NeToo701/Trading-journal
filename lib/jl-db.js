/* Локальне сховище на IndexedDB. Усі дані журналу лежать у браузері; черга змін (outbox) потрібна для синхронізації з хмарою.
   Таблиці: meta, journals, entries, reviews, media (опис файлу), blobs (сам файл), outbox (що ще не відправлено). */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const STORES = ["meta", "journals", "entries", "reviews", "media", "blobs", "outbox"];
  let dbp = null, lastId = 0;

  function open(name = "journal-app-v1") {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open(name, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        db.createObjectStore("meta");
        db.createObjectStore("journals", { keyPath: "id" });
        db.createObjectStore("entries", { keyPath: "id" }).createIndex("journal_id", "journal_id");
        db.createObjectStore("reviews", { keyPath: "key" });
        db.createObjectStore("media", { keyPath: "id" }).createIndex("entry_id", "entry_id");
        db.createObjectStore("blobs");
        db.createObjectStore("outbox", { keyPath: "key" });
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(new JL.ApiError("Браузер не дозволяє зберігати дані (IndexedDB). Вимкни приватний режим або дозволь сховище для цього сайту.", 500));
      rq.onblocked = () => reject(new JL.ApiError("Закрий інші вкладки з журналом і онови сторінку.", 500));
    });
    return dbp;
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  /** Транзакція: fn отримує {store(name)} з обгортками get/put/delete/all/byIndex. Усередині можна чекати лише на ці виклики. */
  async function tx(names, mode, fn) {
    const db = await open();
    const t = db.transaction(names, mode);
    const done = new Promise((res, rej) => { t.oncomplete = () => res(); t.onabort = () => rej(t.error || new Error("abort")); t.onerror = () => rej(t.error); });
    const api = {
      get: (s, k) => req(t.objectStore(s).get(k)),
      all: (s) => req(t.objectStore(s).getAll()),
      keys: (s) => req(t.objectStore(s).getAllKeys()),
      by: (s, idx, k) => req(t.objectStore(s).index(idx).getAll(k)),
      count: (s, idx, k) => req(idx ? t.objectStore(s).index(idx).count(k) : t.objectStore(s).count()),
      put: (s, v, k) => req(k === undefined ? t.objectStore(s).put(v) : t.objectStore(s).put(v, k)),
      del: (s, k) => req(t.objectStore(s).delete(k)),
      /** Позначає запис для відправки в хмару (або видалення). */
      mark(kind, id, op = "put") {
        return req(t.objectStore("outbox").put({ key: `${kind}/${id}`, kind, id, op, ts: Date.now() }));
      },
    };
    let out;
    try { out = await fn(api); } catch (e) { try { t.abort(); } catch (x) { /* вже закрита */ } await done.catch(() => {}); throw e; }
    await done;
    return out;
  }

  function nextId() {
    lastId = Math.max(lastId + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000));
    return lastId;
  }

  const meta = {
    get: (k) => tx(["meta"], "readonly", (t) => t.get("meta", k)),
    set: (k, v) => tx(["meta"], "readwrite", (t) => t.put("meta", v, k)),
    del: (k) => tx(["meta"], "readwrite", (t) => t.del("meta", k)),
  };

  async function clearAll(keepMeta = true) {
    const db = await open();
    await new Promise((res, rej) => {
      const t = db.transaction(STORES.filter((s) => !(keepMeta && s === "meta")), "readwrite");
      for (const s of STORES) if (!(keepMeta && s === "meta")) t.objectStore(s).clear();
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }

  JL.db = { open, tx, req, nextId, meta, clearAll, STORES, reset() { dbp = null; } };
})(typeof window !== "undefined" ? window : globalThis);
