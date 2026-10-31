/* Резервна копія: один ZIP-файл з усім журналом (записи, налаштування полів, розбори місяців, бектести, активи калькуляторів і всі фото/відео).
   Відновлення додає й оновлює дані за правилом «новіше перемагає», нічого не стирає. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const { ApiError, db } = JL;
  const FORMAT = "journal-app-backup";

  /** Збирає ZIP: {name, blob, counts}. */
  JL.backupCreate = async function () {
    const snap = await db.tx(["journals", "entries", "reviews", "media", "bt_cols", "bt_trades", "calc"], "readonly", async (t) => ({
      journals: await t.all("journals"), entries: await t.all("entries"), reviews: await t.all("reviews"), media: await t.all("media"),
      bt_cols: await t.all("bt_cols"), bt_trades: await t.all("bt_trades"), calc: await t.all("calc"),
    }));
    const files = [];
    const meta = { format: FORMAT, version: 1, exported_at: new Date().toISOString(), ...snap };
    files.push({ name: "data.json", data: new TextEncoder().encode(JSON.stringify(meta)) });
    for (const m of snap.media) {
      const blob = await db.tx(["blobs"], "readonly", (t) => t.get("blobs", m.id));
      if (blob) files.push({ name: `media/${m.id}`, data: blob });
    }
    const d = JL.todayIso();
    return { name: `zhurnal-kopiya-${d}.zip`, blob: await JL.zipCreate(files),
      counts: { journals: snap.journals.length, entries: snap.entries.length, media: snap.media.length, backtests: snap.bt_cols.length, bt_trades: snap.bt_trades.length, calc: snap.calc.length } };
  };

  const newer = (a, b) => (a._u || 0) > (b._u || 0);

  /** Відновлення з ZIP. Повертає лічильники доданого/оновленого. */
  JL.backupRestore = async function (file) {
    let zip;
    try { zip = await JL.zipOpen(file); } catch (e) { throw e instanceof ApiError ? e : new ApiError("Це не схоже на копію журналу.", 422); }
    const dataEntry = zip.entries.find((x) => x.name === "data.json");
    if (!dataEntry) throw new ApiError("У файлі немає data.json: це не копія цього журналу.", 422);
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await zip.read(dataEntry))); } catch (e) { throw new ApiError("Копія пошкоджена: data.json не читається.", 422); }
    if (!data || data.format !== FORMAT || !Array.isArray(data.journals) || !Array.isArray(data.entries)) throw new ApiError("Це не копія цього журналу.", 422);
    if (data.version > 1) throw new ApiError("Копію зроблено новішою версією журналу. Онови застосунок.", 422);
    const res = { journals: 0, entries: 0, reviews: 0, media: 0, backtests: 0, bt_trades: 0, calc: 0, skipped: 0 };
    const media = Array.isArray(data.media) ? data.media : [];

    // 1) журнали, записи, розбори: звичайні маленькі записи в одній транзакції
    await db.tx(["journals", "entries", "reviews", "bt_cols", "bt_trades", "calc", "outbox"], "readwrite", async (t) => {
      const apply = async (store, kind, rows, keyOf, counter) => {
        for (const r of rows) {
          const key = r && typeof r === "object" ? keyOf(r) : null;
          if (key == null) { res.skipped++; continue; }
          const cur = await t.get(store, key);
          if (cur && !newer(r, cur)) continue;
          await t.put(store, r); await t.mark(kind, key); res[counter]++;
        }
      };
      await apply("journals", "journals", data.journals, (r) => (Number.isFinite(r.id) && Array.isArray(r.fields) ? r.id : null), "journals");
      await apply("entries", "entries", data.entries, (r) => (Number.isFinite(r.id) && Number.isFinite(r.journal_id) && r.data ? r.id : null), "entries");
      await apply("reviews", "reviews", Array.isArray(data.reviews) ? data.reviews : [], (r) => (typeof r.key === "string" ? r.key : null), "reviews");
      // бектести (у копіях, зроблених до їхньої появи, цих масивів немає)
      const list = (x) => (Array.isArray(x) ? x : []);
      await apply("bt_cols", "bt_cols", list(data.bt_cols), (r) => (Number.isFinite(r.id) && typeof r.name === "string" ? r.id : null), "backtests");
      await apply("bt_trades", "bt_trades", list(data.bt_trades), (r) => (Number.isFinite(r.id) && Number.isFinite(r.col_id) && Number.isFinite(r.r) ? r.id : null), "bt_trades");
      // активи й налаштування калькуляторів (ключ рядком: «asset|EURUSD» або «prefs»)
      await apply("calc", "calc", list(data.calc), (r) => (typeof r.key === "string" && (r.key === "prefs" || /^asset\|[A-Z0-9._-]{1,20}$/.test(r.key)) ? r.key : null), "calc");
    });

    // 2) файли по одному: розпаковка асинхронна, тому окрема маленька транзакція на файл
    for (const m of media) {
      if (!Number.isFinite(m.id) || !Number.isFinite(m.entry_id)) { res.skipped++; continue; }
      const cur = await db.tx(["media"], "readonly", (t) => t.get("media", m.id));
      if (cur && !newer(m, cur)) continue;
      const info = zip.entries.find((x) => x.name === `media/${m.id}`);
      if (!info) { res.skipped++; continue; }
      const bytes = await zip.read(info);
      const kind = JL.sniff(bytes.subarray(0, 32));
      if (!kind) { res.skipped++; continue; }
      const blob = new Blob([bytes], { type: kind[0] });
      await db.tx(["media", "blobs", "outbox"], "readwrite", async (t) => {
        await t.put("media", { ...m, mime: kind[0], size: blob.size }); await t.put("blobs", blob, m.id); await t.mark("media", m.id);
      });
      JL.mediaUrls.drop && JL.mediaUrls.drop(m.id);
      res.media++;
    }
    JL.changed();
    return res;
  };
})(typeof window !== "undefined" ? window : globalThis);
