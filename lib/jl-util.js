/* Спільні дрібниці автономного журналу: числа як у Python (округлення, сума), дати, CSV, ZIP.
   Працює і в браузері, і в Node (для тестів): все кладеться в globalThis.JL. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});

  class ApiError extends Error {
    constructor(message, status, field) { super(message); this.status = status || 400; if (field) this.field = field; }
  }
  JL.ApiError = ApiError;

  // ---------------------------------------------------------------- числа
  /** Як round(x, nd) у Python: точні «половинки» округлюються до парного, решта до найближчого. */
  function pyRound(x, nd = 0) {
    if (x == null || !Number.isFinite(x)) return x;
    const neg = x < 0 || Object.is(x, -0);
    const a = Math.abs(x);
    const s = a.toFixed(Math.min(100, nd + 60));          // точний десятковий запис числа
    const dot = s.indexOf(".");
    const cut = dot + 1 + nd;
    const kept = nd === 0 ? s.slice(0, dot) : s.slice(0, cut);
    let out;
    if (/^50*$/.test(s.slice(cut))) {                     // рівно посередині: до парної останньої цифри
      out = Number(kept[kept.length - 1]) % 2 === 0 ? Number(kept) : Number((Number(kept) + Math.pow(10, -nd)).toFixed(nd));
    } else {
      out = Number(a.toFixed(nd));
    }
    return neg ? -out : out;
  }
  JL.pyRound = pyRound;

  /** sum() з Python 3.12+: компенсована (Neumaier) сума чисел з рухомою комою. */
  function pySum(values) {
    let f = 0, c = 0;
    for (const x of values) {
      const t = f + x;
      if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x; else c += (x - t) + f;
      f = t;
    }
    if (c && Number.isFinite(c)) f += c;
    return f;
  }
  JL.pySum = pySum;

  // ---------------------------------------------------------------- дати (лише календарні, без поясів)
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  JL.pad = pad;
  function validDate(y, m, d) {
    if (!(y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1)) return false;
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  JL.validDate = validDate;
  function mkDay(y, m, d) { return { y, m, d, iso: `${pad(y, 4)}-${pad(m)}-${pad(d)}` }; }
  JL.mkDay = mkDay;
  /** "2026-01-05..." -> {y,m,d,iso} або null. Дивиться лише на перші 10 символів. */
  JL.parseDay = function (v) {
    if (typeof v !== "string" || v.length < 10) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    return validDate(y, mo, d) ? mkDay(y, mo, d) : null;
  };
  const utc = (day) => Date.UTC(day.y, day.m - 1, day.d);
  JL.weekday = (day) => (new Date(utc(day)).getUTCDay() + 6) % 7;     // 0 = понеділок
  JL.addDays = (day, n) => { const t = new Date(utc(day) + n * 86400000); return mkDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
  /** ISO-тиждень: [рік, номер тижня]. */
  JL.isoWeek = function (day) {
    const wd = JL.weekday(day);
    const thursday = JL.addDays(day, 3 - wd);
    const jan1 = mkDay(thursday.y, 1, 1);
    const week = Math.floor((utc(thursday) - utc(jan1)) / 86400000 / 7) + 1;
    return [thursday.y, week];
  };
  JL.isoMonday = (y, w) => { const jan4 = mkDay(y, 1, 4); return JL.addDays(jan4, -JL.weekday(jan4) + (w - 1) * 7); };
  JL.todayIso = () => { const d = new Date(); return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  // ---------------------------------------------------------------- текст
  JL.fold = (s) => String(s).toLowerCase();                           // casefold для наших даних
  JL.cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  JL.safeFilename = function (name) {
    name = String(name || "").replace(/\\/g, "/").split("/").pop();
    name = Array.from(name).filter((c) => c.codePointAt(0) >= 32 && c.codePointAt(0) !== 127 && !'<>:"|?*'.includes(c)).join("");
    name = name.replace(/^[. ]+|[. ]+$/g, "");
    return (name || "file").slice(0, 100);
  };
  JL.csvCell = (v) => (typeof v === "string" && ["=", "+", "-", "@", "\t", "\r"].includes(v[0]) ? "'" + v : v);

  // ---------------------------------------------------------------- CSV
  /** Аналог csv.reader: роздільник, лапки, подвоєні лапки, переноси рядків усередині клітинок. */
  JL.csvRead = function (text, delim) {
    const rows = [];
    let row = [], cell = "", q = false, i = 0, any = false;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell === "") { q = true; any = true; i++; continue; }
      if (ch === delim) { row.push(cell); cell = ""; any = true; i++; continue; }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        i++;
        if (any || cell !== "" || row.length) { row.push(cell); rows.push(row); }
        row = []; cell = ""; any = false;
        continue;
      }
      cell += ch; any = true; i++;
    }
    if (any || cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };
  JL.csvWrite = function (rows) {
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
  };

  // ---------------------------------------------------------------- float() як у Python
  let ND = null;      // кодова точка десяткової цифри Unicode -> значення 0..9
  function ndTable() {
    if (ND) return ND;
    ND = new Map();
    let runStart = -2, prev = -2;
    for (let cp = 0x30; cp < 0x1f000; cp++) {
      if (!/^\p{Nd}$/u.test(String.fromCodePoint(cp))) continue;
      if (cp !== prev + 1) runStart = cp;
      ND.set(cp, (cp - runStart) % 10);
      prev = cp;
    }
    return ND;
  }
  /** Число з рядка за правилами Python float(): пробіли, +/-, inf/nan, підкреслення між цифрами, цифри інших писемностей. Інакше null. */
  JL.pyFloat = function (str) {
    const t = String(str).trim();
    if (!t) return null;
    if (/^[+-]?(inf(inity)?|nan)$/i.test(t)) { const sign = t[0] === "-" ? -1 : 1; return /nan$/i.test(t) ? NaN : sign * Infinity; }
    let ascii = "";
    for (const ch of t) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) { ascii += ch; continue; }
      const d = ndTable().get(cp);
      if (d === undefined) return null;
      ascii += String(d);
    }
    const D = "\\d+(?:_\\d+)*";
    if (!new RegExp(`^[+-]?(?:${D}(?:\\.(?:${D})?)?|\\.${D})(?:[eE][+-]?${D})?$`).test(ascii)) return null;
    return Number(ascii.replace(/_/g, ""));
  };

  // ---------------------------------------------------------------- CRC32 і ZIP
  let CRC_TABLE = null;
  JL.crc32 = function (bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const u16 = (v, o) => v[o] | (v[o + 1] << 8);
  const u32 = (v, o) => (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0;

  /** Читає ZIP із Blob без завантаження всього в пам'ять. Повертає {entries, read(entry) -> Uint8Array}. */
  JL.zipOpen = async function (blob) {
    const size = blob.size;
    if (size < 22) throw new ApiError("Архів пошкоджений або це не ZIP.", 422);
    const tailLen = Math.min(size, 22 + 65535);
    const tail = new Uint8Array(await blob.slice(size - tailLen, size).arrayBuffer());
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new ApiError("Архів пошкоджений або це не ZIP.", 422);
    const count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
    if (count === 0xffff || cdOff === 0xffffffff) throw new ApiError("Завеликий архів (ZIP64) не підтримується.", 422);
    const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const entries = [];
    let p = 0;
    const dec8 = new TextDecoder("utf-8");
    while (p + 46 <= cd.length && u32(cd, p) === 0x02014b50) {
      const flags = u16(cd, p + 8), method = u16(cd, p + 10), csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      const nlen = u16(cd, p + 28), elen = u16(cd, p + 30), clen = u16(cd, p + 32), off = u32(cd, p + 42);
      const rawName = cd.subarray(p + 46, p + 46 + nlen);
      let name;
      try { name = new TextDecoder("utf-8", { fatal: true }).decode(rawName); } catch (e) { name = dec8.decode(rawName); }
      entries.push({ name, method, csize, size: usize, off, dir: name.endsWith("/"), flags });
      p += 46 + nlen + elen + clen;
    }
    async function read(entry) {
      const head = new Uint8Array(await blob.slice(entry.off, entry.off + 30).arrayBuffer());
      if (u32(head, 0) !== 0x04034b50) throw new ApiError("Архів пошкоджений.", 422);
      const start = entry.off + 30 + u16(head, 26) + u16(head, 28);
      const data = blob.slice(start, start + entry.csize);
      if (entry.method === 0) return new Uint8Array(await data.arrayBuffer());
      if (entry.method !== 8) throw new ApiError("Архів стиснутий непідтримуваним способом.", 422);
      if (typeof DecompressionStream === "undefined") throw new ApiError("Цей браузер не вміє розпаковувати ZIP. Онови його.", 422);
      const stream = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return { entries, read };
  };

  /** Створює ZIP без стиснення (достатньо для фото; текст маленький). files: [{name, data: Uint8Array|Blob}]. */
  JL.zipCreate = async function (files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const dt = new Date();
    const dosTime = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
    const dosDate = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
    for (const f of files) {
      const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(await f.data.arrayBuffer());
      const name = enc.encode(f.name);
      const crc = JL.crc32(bytes);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, bytes.length, true); lh.setUint32(22, bytes.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, bytes);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, bytes.length, true); ch.setUint32(24, bytes.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + bytes.length;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  };

  // ---------------------------------------------------------------- розпізнавання файлів за вмістом
  JL.sniff = function (head) {
    const eq = (o, s) => s.every((b, i) => head[o + i] === b);
    const ascii = (o, str) => eq(o, Array.from(str).map((c) => c.charCodeAt(0)));
    if (eq(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ["image/png", "png", "image"];
    if (eq(0, [0xff, 0xd8, 0xff])) return ["image/jpeg", "jpg", "image"];
    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return ["image/gif", "gif", "image"];
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) return ["image/webp", "webp", "image"];
    if (ascii(4, "ftyp")) {
      const brand = String.fromCharCode(...head.slice(8, 12));
      if (brand.startsWith("qt")) return ["video/quicktime", "mov", "video"];
      if (["heic", "heix", "mif1", "avif"].includes(brand)) return null;
      return ["video/mp4", "mp4", "video"];
    }
    if (eq(0, [0x1a, 0x45, 0xdf, 0xa3])) return ["video/webm", "webm", "video"];
    return null;
  };

  JL.randomHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
})(typeof window !== "undefined" ? window : globalThis);
