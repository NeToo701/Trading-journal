/* Сервіс-воркер журналу: щоб застосунок можна було встановити і відкрити без інтернету.
   Кешується лише оболонка (сторінка, скрипти, стилі, шрифти, іконки) і SDK Firebase. Дані журналу тут не проходять:
   вони лежать у IndexedDB браузера, а до хмари йдуть прямо з коду застосунку. Онлайн завжди береться свіжа версія файлів. */
const CACHE = "journal-shell-v4";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "firebase-config.js",
  "assets/style.css", "assets/journal.css", "assets/icon-192.png", "assets/icon-512.png", "assets/apple-touch-icon.png",
  "assets/fonts/inter-400.woff", "assets/fonts/inter-500.woff", "assets/fonts/inter-600.woff", "assets/fonts/inter-700.woff",
  "js/theme.js", "js/ui.js", "js/jr-core.js", "js/jr-fields.js", "js/jr-entries.js", "js/jr-stats.js", "js/jr-schema.js",
  "js/jr-review.js", "js/jr-review-cfg.js", "js/jr-import.js", "js/jr-account.js", "js/journal.js", "js/jr-calendar.js",
  "lib/jl-util.js", "lib/jl-schema.js", "lib/jl-stats.js", "lib/jl-formula.js", "lib/jl-review.js", "lib/jl-import.js", "lib/jl-news.js", "lib/jl-db.js", "lib/jl-api.js",
  "lib/jl-backup.js", "lib/jl-sync.js", "lib/jl-firebase.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const sdk = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!sameOrigin && !sdk) return;                                        // все інше (Firebase API) йде напряму в мережу
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
