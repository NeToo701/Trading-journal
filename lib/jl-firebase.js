/* Підключення до Firebase: вхід за поштою й паролем (Authentication) та хмарна база (Firestore).
   SDK завантажується з серверів Google лише тоді, коли задано налаштування Firebase. Без них застосунок працює повністю локально.
   Налаштування беруться з файлу firebase-config.js (window.JOURNAL_FIREBASE) або з поля «Налаштування Firebase» у застосунку. */
(function (root) {
  "use strict";
  const JL = (root.JL = root.JL || {});
  const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
  const LS_KEY = "journal.firebase.v1";
  const NEED = ["apiKey", "authDomain", "projectId", "appId"];
  let sdk = null, auth = null, fs = null, loading = null, current = null, lastSnap = null, lastCursor = null;
  const subs = [];

  const lsGet = () => { try { return localStorage.getItem(LS_KEY); } catch (e) { return null; } };
  const lsSet = (v) => { try { if (v == null) localStorage.removeItem(LS_KEY); else localStorage.setItem(LS_KEY, v); } catch (e) { /* ок */ } };

  function validConfig(c) { return !!c && typeof c === "object" && NEED.every((k) => typeof c[k] === "string" && c[k].trim()); }
  function config() {
    const saved = lsGet();
    if (saved) { try { const c = JSON.parse(saved); if (validConfig(c)) return c; } catch (e) { /* ок */ } }
    const f = root.JOURNAL_FIREBASE;
    return validConfig(f) ? f : null;
  }
  /** Розбирає текст із консолі Firebase (JSON або фрагмент JavaScript) без виконання коду. */
  function parseConfig(text) {
    const out = {};
    const re = /["']?([A-Za-z]\w*)["']?\s*:\s*["']([^"']*)["']/g;
    let m;
    while ((m = re.exec(String(text || "")))) out[m[1]] = m[2].trim();
    const c = {};
    for (const k of [...NEED, "storageBucket", "messagingSenderId", "measurementId"]) if (out[k]) c[k] = out[k];
    const miss = NEED.filter((k) => !c[k]);
    if (miss.length) throw new JL.ApiError("У налаштуваннях бракує: " + miss.join(", ") + ". Скопіюй весь блок firebaseConfig з консолі Firebase.", 422);
    return c;
  }
  function setConfig(c) {
    if (c == null) { lsSet(null); return; }
    if (!validConfig(c)) throw new JL.ApiError("Невірні налаштування Firebase.", 422);
    lsSet(JSON.stringify(c));
  }

  const MSG = {
    "auth/invalid-email": "Невірна адреса пошти.",
    "auth/user-not-found": "Невірна пошта або пароль.", "auth/wrong-password": "Невірна пошта або пароль.",
    "auth/invalid-credential": "Невірна пошта або пароль.", "auth/invalid-login-credentials": "Невірна пошта або пароль.",
    "auth/email-already-in-use": "Акаунт із такою поштою вже є. Натисни «Увійти».",
    "auth/weak-password": "Пароль надто простий: потрібно щонайменше 6 символів.",
    "auth/missing-password": "Введи пароль.", "auth/missing-email": "Введи пошту.",
    "auth/too-many-requests": "Забагато спроб. Зачекай кілька хвилин і спробуй ще раз.",
    "auth/network-request-failed": "Немає зв'язку з інтернетом.",
    "auth/operation-not-allowed": "У проєкті Firebase не ввімкнено вхід за поштою й паролем (Authentication → Sign-in method → Email/Password).",
    "auth/invalid-api-key": "Невірні налаштування Firebase (apiKey). Перевір їх у розділі «Налаштування Firebase».",
    "auth/api-key-not-valid": "Невірні налаштування Firebase (apiKey). Перевір їх у розділі «Налаштування Firebase».",
    "auth/configuration-not-found": "У проєкті Firebase не підключено Authentication. Відкрий Authentication → Get started.",
    "auth/unauthorized-domain": "Цю адресу сайту не додано в Firebase: Authentication → Settings → Authorized domains.",
    "permission-denied": "Firestore не дозволяє доступ. Встав правила з файлу firestore.rules (Firestore → Rules → Publish) і переконайся, що ти увійшов.",
    "unavailable": "Немає зв'язку з Firebase. Спробуй пізніше.",
    "resource-exhausted": "Вичерпано безкоштовну добову квоту Firebase. Синхронізація відновиться завтра, дані на пристрої не постраждали.",
    "failed-precondition": "Firestore ще не створено в проєкті (Firestore Database → Create database).",
    "not-found": "Firestore не знайдено в проєкті (Firestore Database → Create database).",
  };
  function wrap(e) {
    if (e instanceof JL.ApiError) return e;
    const code = e && e.code ? String(e.code).replace(/^firestore\//, "") : "";
    return new JL.ApiError(MSG[code] || (e && e.message) || "Помилка Firebase.", 500);
  }

  async function load() {
    if (sdk) return sdk;
    if (loading) return loading;
    const cfg = config();
    if (!cfg) throw new JL.ApiError("Firebase не налаштовано.", 400);
    loading = (async () => {
      try {
        const [app, a, f] = await Promise.all([import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js"), import(SDK + "firebase-firestore.js")]);
        const application = app.initializeApp(cfg);
        auth = a.getAuth(application);
        fs = f.initializeFirestore(application, { experimentalAutoDetectLongPolling: true });
        sdk = { a, f };
        a.onAuthStateChanged(auth, (u) => {
          current = u ? { uid: u.uid, email: u.email || "" } : null;
          for (const fn of subs) { try { fn(current); } catch (e) { /* ок */ } }
        });
        return sdk;
      } catch (e) {
        loading = null;
        throw new JL.ApiError("Не вдалося завантажити Firebase (потрібен інтернет). " + ((e && e.message) || ""), 500);
      }
    })();
    return loading;
  }

  const col = () => sdk.f.collection(fs, "users", current.uid, "items");
  const cursorOf = (ts) => `${ts.seconds}.${String(ts.nanoseconds).padStart(9, "0")}`;
  const tsOf = (c) => { const [s, n] = c.split("."); return new sdk.f.Timestamp(Number(s), Number(n)); };

  const adapter = {
    async push(docs) {
      const { f } = sdk;
      for (let i = 0; i < docs.length;) {
        const batch = f.writeBatch(fs);
        let bytes = 0, n = 0;
        while (i < docs.length && n < 400 && bytes < 6 * 1024 * 1024) {
          const d = docs[i++];
          bytes += (d.blob ? d.blob.length : 0) + (d.data ? d.data.length : 0) + 200; n++;
          batch.set(f.doc(col(), `${d.kind}_${d.rid}`), { kind: d.kind, rid: d.rid, deleted: !!d.deleted, u: d.u, data: d.data, blob: d.blob, srv: f.serverTimestamp() });
        }
        try { await batch.commit(); } catch (e) { throw wrap(e); }
      }
    },
    async pull(cursor, limit) {
      const { f } = sdk;
      const parts = [col(), f.orderBy("srv")];
      if (cursor && cursor === lastCursor && lastSnap) parts.push(f.startAfter(lastSnap));
      else if (cursor) parts.push(f.where("srv", ">=", tsOf(cursor)));
      parts.push(f.limit(limit));
      let snap;
      try { snap = await f.getDocs(f.query(...parts)); } catch (e) { throw wrap(e); }
      const docs = snap.docs.map((s) => { const v = s.data(); return { kind: v.kind, rid: v.rid, deleted: !!v.deleted, u: v.u, data: v.data || null, blob: v.blob || null }; });
      const lastDoc = snap.docs[snap.docs.length - 1];
      let next = cursor;
      if (lastDoc && lastDoc.data().srv) { next = cursorOf(lastDoc.data().srv); lastSnap = lastDoc; lastCursor = next; }
      return { docs, cursor: next, more: snap.docs.length >= limit };
    },
  };

  JL.cloud = {
    configured: () => !!config(),
    config, setConfig, parseConfig, validConfig,
    fromFile: () => validConfig(root.JOURNAL_FIREBASE),
    user: () => current,
    onUser(fn) { subs.push(fn); if (current) fn(current); },
    async init() { if (!config()) return null; await load(); return current; },
    async signIn(email, password) { await load(); try { await sdk.a.signInWithEmailAndPassword(auth, email, password); } catch (e) { throw wrap(e); } },
    async signUp(email, password) { await load(); try { await sdk.a.createUserWithEmailAndPassword(auth, email, password); } catch (e) { throw wrap(e); } },
    async reset(email) { await load(); try { await sdk.a.sendPasswordResetEmail(auth, email); } catch (e) { throw wrap(e); } },
    async signOut() { if (!sdk) return; lastSnap = null; lastCursor = null; try { await sdk.a.signOut(auth); } catch (e) { throw wrap(e); } },
    adapter: () => (sdk && current ? adapter : null),
  };
})(typeof window !== "undefined" ? window : globalThis);
