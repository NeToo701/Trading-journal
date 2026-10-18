// Інтерфейс і програвач Тембру.
(function () {
  'use strict';

  const C = window.TEMBR_CONFIG || {};
  const fbc = C.firebase || {};
  const Store = window.CloudStore;

  // Повертає опис проблеми з налаштуванням або порожній рядок, якщо все гаразд.
  function setupProblem() {
    if (!window.TEMBR_CONFIG) {
      return 'Файл config.js не завантажився: його немає в репозиторії поруч з index.html, або браузер показує стару копію (спробуйте Ctrl+F5).';
    }
    const need = [];
    if (!fbc.apiKey) need.push('firebase.apiKey');
    if (!fbc.projectId) need.push('firebase.projectId');
    if (!fbc.appId) need.push('firebase.appId');
    if (!C.googleClientId) need.push('googleClientId');
    if (need.length) return 'У config.js не заповнено: ' + need.join(', ') + '.';
    if (!Store) {
      return 'Не завантажився файл js/store-cloud.js: перевірте, що він є в папці js репозиторію, і оновіть сторінку (Ctrl+F5).';
    }
    return '';
  }
  const esc = window.U.esc;
  const fmt = window.U.fmt;
  const hash = window.U.hash;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const body = document.body;
  let audio = null;         // елемент, який зараз грає
  let spare = null;         // елемент із підвантаженим наступним треком

  const PAL = [
    ['#7dd3fc', '#0c4a6e'], ['#94a3b8', '#1e293b'], ['#fbbf77', '#7c2d12'], ['#86efac', '#14532d'],
    ['#f9a8d4', '#701a45'], ['#c4b5fd', '#3b0764'], ['#fca5a5', '#7f1d1d'], ['#5eead4', '#134e4a']
  ];

  let tracks = [];          // у порядку додавання: нові першими
  let playlists = [];
  let settings = { order: [] };
  let me = null;
  let curId = null;
  let loadedId = null;
  let playing = false;
  let loadTok = 0;
  let pos = 0;
  let dur = 0;
  let shuffle = false;
  let repeat = 'off';       // off | all | one
  let query = '';
  let sortMode = 'new';     // new | old | az | za | custom
  let page = 'library';     // library | playlists | stats
  let plId = null;          // відкритий плейлист
  let uploading = false;
  let toastTimer = null;
  let spareId = null;       // id треку, підвантаженого у spare
  let resumeHint = false;   // перемикання не вдалося у фоні: нагадати натиснути ▶
  let pfTok = 0;
  let curAuto = false;      // чи потрібно грати одразу після завантаження
  let fallbackFor = null;   // трек, для якого вже пробували запасне завантаження
  let sharedChecked = false;
  let queueReady = false;
  let volume = 0.85;
  let wakeLock = null;
  let lyrOn = false;
  let lyrShown = null;      // { id, text }
  let lyrRaf = 0;
  let statsCtl = null;

  const Q = window.Queue.create();

  // ---------- допоміжні ----------

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* сховище недоступне */ }
    return null;
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 5500);
  }

  function errText(e) {
    const m = String((e && e.message) || e || '');
    const code = e && e.code ? String(e.code) : '';
    if (code === 'auth/unauthorized-domain') return 'Адресу сайту не додано в Firebase → Authentication → Settings → Authorized domains.';
    if (code === 'auth/operation-not-allowed') return 'У Firebase не ввімкнено вхід через Google (Authentication → Sign-in method).';
    if (code === 'auth/invalid-credential' || code === 'auth/invalid-idp-response' || code === 'auth/internal-error') {
      return 'Firebase не прийняв вхід через Google. Перевірте, що googleClientId у config.js — це «Web client (auto created by Google Service)» того самого проєкту.';
    }
    if (code === 'auth/network-request-failed') return 'Немає з’єднання з мережею.';
    if (code === 'permission-denied') return 'Firestore відхилив запит. Оновіть правила бази (README, крок 1.4).';
    if (/popup_failed_to_open/i.test(m)) return 'Браузер заблокував вікно Google. Дозвольте спливні вікна для цього сайту й натисніть ще раз.';
    if (/popup_closed|user_cancel/i.test(m)) return 'Вікно Google закрито до завершення входу.';
    if (/access_denied/i.test(m)) return 'Доступ до Google Диска не надано.';
    if (/no_token/i.test(m)) return 'Потрібно відновити доступ до Google Диска: натисніть ▶ ще раз.';
    if (e && e.status === 404) return 'Файл не знайдено на Google Диску (можливо, його видалили).';
    if (e && (e.status === 401 || e.status === 403)) {
      return 'Немає доступу до Google Диска' + (e.detail ? ': ' + e.detail : '') + '.';
    }
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Немає з’єднання з мережею.';
    return 'Помилка: ' + m;
  }

  const cur = () => tracks.find((t) => t.id === curId) || null;
  const byId = (id) => tracks.find((t) => t.id === id) || null;

  const artistsOf = (t) => (t.artists && t.artists.length ? t.artists.slice() : String(t.artist || '').split(',').map((s) => s.trim()).filter(Boolean));

  function coverCss(t) {
    if (t.cover) return "center / cover no-repeat url('" + t.cover + "')";
    const i = hash(String(t.id));
    const p = PAL[i % PAL.length];
    return 'linear-gradient(135deg,' + p[0] + ',' + p[1] + ')';
  }

  // ---------- списки: сортування, плейлисти ----------

  function customOrdered() {
    const idx = new Map((settings.order || []).map((id, i) => [id, i]));
    const known = tracks.filter((t) => idx.has(t.id)).sort((a, b) => idx.get(a.id) - idx.get(b.id));
    const fresh = tracks.filter((t) => !idx.has(t.id));
    return fresh.concat(known);
  }

  function sortedTracks() {
    const cmp = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'uk', { numeric: true, sensitivity: 'base' });
    switch (sortMode) {
      case 'old': return tracks.slice().reverse();
      case 'az': return tracks.slice().sort(cmp);
      case 'za': return tracks.slice().sort(cmp).reverse();
      case 'custom': return customOrdered();
      default: return tracks.slice();
    }
  }

  const FAV = 'favorites';

  function favorites() {
    return playlists.find((p) => p.id === FAV) || { id: FAV, name: 'Улюблені', kind: 'favorites', trackIds: [] };
  }

  function plList() {
    const others = playlists.filter((p) => p.id !== FAV).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return [favorites()].concat(others);
  }

  const plById = (id) => plList().find((p) => p.id === id) || null;
  const plTracks = (p) => (p.trackIds || []).map(byId).filter(Boolean);
  const isFav = (id) => (favorites().trackIds || []).indexOf(id) >= 0;

  function savePl(p, ids) {
    return Store.savePlaylist({ id: p.id, name: p.name, kind: p.kind, trackIds: ids });
  }

  // ---------- відображення ----------

  const ICON_MORE = '<svg class="ic"><use href="#i-more"/></svg>';

  function rowHtml(t, i) {
    const act = t.id === curId;
    const id = esc(t.id);
    const title = esc(t.title || 'Без назви');
    return '<div class="row' + (act ? ' active' : '') + '" data-id="' + id + '">' +
      '<button class="grip" data-grip aria-label="Перетягнути" tabindex="-1"><svg class="ic"><use href="#i-grip"/></svg></button>' +
      '<button class="r-main" data-play-id="' + id + '">' +
      '<span class="n"><span class="eq"><i></i><i></i><i></i></span><b>' + (i + 1) + '</b></span>' +
      '<span class="cv" style="background:' + coverCss(t) + '"></span>' +
      '<span class="x"><span class="t">' + title + '</span><span class="a">' + esc(t.artist || 'Невідомий виконавець') + '</span></span>' +
      '<span class="d">' + (t.duration ? fmt(t.duration) : '—:—') + '</span>' +
      '</button>' +
      '<button class="more" data-more="' + id + '" aria-label="Меню «' + title + '»" aria-haspopup="menu">' + ICON_MORE + '</button>' +
      '</div>';
  }

  function blankHtml() {
    return '<div class="blank"><svg class="ic"><use href="#i-music"/></svg><h3>Бібліотека порожня</h3>' +
      '<p>Завантажте музику: файли збережуться на вашому Google Диску, а список треків у Firebase.</p>' +
      '<button class="up" data-upload><svg class="ic"><use href="#i-up"/></svg><span>Завантажити</span></button></div>';
  }

  function covMosaic(list) {
    const c = list.slice(0, 4);
    if (!c.length) return '<div class="pl-cv"></div>';
    if (c.length < 4) return '<div class="pl-cv one"><i style="background:' + coverCss(c[0]) + '"></i></div>';
    return '<div class="pl-cv">' + c.map((t) => '<i style="background:' + coverCss(t) + '"></i>').join('') + '</div>';
  }

  function renderLibrary() {
    const q = query.trim().toLowerCase();
    const sorted = sortedTracks();
    const items = sorted.map((t, i) => ({ t, i })).filter((o) =>
      !q || ((o.t.title || '') + ' ' + (o.t.artist || '') + ' ' + (o.t.album || '')).toLowerCase().includes(q));
    const host = $('[data-list]');
    host.classList.toggle('drag-on', sortMode === 'custom' && !q);
    if (!tracks.length) host.innerHTML = blankHtml();
    else if (!items.length) host.innerHTML = '<div class="blank"><p>Нічого не знайдено</p></div>';
    else host.innerHTML = items.map((o) => rowHtml(o.t, o.i)).join('');
  }

  function plMeta(list) {
    const sec = list.reduce((a, t) => a + (t.duration || 0), 0);
    const mins = Math.round(sec / 60);
    return list.length + ' ' + pluralTr(list.length) + (mins ? ' · ' + (mins >= 60 ? Math.floor(mins / 60) + ' год ' + (mins % 60) + ' хв' : mins + ' хв') : '');
  }

  function pluralTr(n) {
    const a = n % 100;
    const b = n % 10;
    if (a > 10 && a < 20) return 'треків';
    if (b > 1 && b < 5) return 'треки';
    if (b === 1) return 'трек';
    return 'треків';
  }

  function renderPlaylists() {
    const host = $('[data-pls]');
    const cards = plList().map((p) => {
      const list = plTracks(p);
      const cv = p.id === FAV
        ? '<div class="pl-cv fav-cv"><svg class="ic"><use href="#i-heart"/></svg></div>'
        : covMosaic(list);
      return '<button class="pl-card" data-open-pl="' + esc(p.id) + '">' + cv +
        '<span class="pl-name">' + esc(p.name || 'Без назви') + '</span><span class="pl-cnt">' + list.length + ' ' + pluralTr(list.length) + '</span></button>';
    }).join('');
    host.innerHTML = '<div class="pls-h"><h3>Плейлисти</h3><button class="up" data-new-pl><svg class="ic"><use href="#i-plus"/></svg><span>Новий плейлист</span></button></div>' +
      '<div class="pl-grid">' + cards +
      '<button class="pl-card" data-new-pl><div class="pl-cv new-cv"><svg class="ic"><use href="#i-plus"/></svg></div><span class="pl-name">Створити плейлист</span></button></div>';
  }

  function renderPlaylistDetail() {
    const p = plById(plId);
    if (!p) { setPage('playlists'); return; }
    const list = plTracks(p);
    const head = $('[data-plh]');
    head.innerHTML =
      '<button class="ghost alt" data-pl-back aria-label="До плейлистів"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="plh-t"><b>' + esc(p.name) + '</b><small>' + plMeta(list) + '</small></div>' +
      '<button class="up" data-pl-play' + (list.length ? '' : ' disabled') + '><svg class="ic"><use href="#i-play"/></svg><span>Відтворити</span></button>' +
      '<button class="ghost alt" data-pl-shuffle aria-label="Перемішати"' + (list.length ? '' : ' disabled') + '><svg class="ic"><use href="#i-shuffle"/></svg></button>' +
      (p.id === FAV ? '' : '<button class="ghost alt" data-pl-menu aria-label="Меню плейлиста" aria-haspopup="menu">' + ICON_MORE + '</button>');
    const host = $('[data-list]');
    host.classList.remove('drag-on');
    host.innerHTML = list.length
      ? list.map((t, i) => rowHtml(t, i)).join('')
      : '<div class="blank"><svg class="ic"><use href="#i-music"/></svg><h3>У плейлисті поки порожньо</h3><p>Додавайте треки через меню «⋮» біля треку в бібліотеці' + (p.id === FAV ? ' або кнопку ♥ у плеєрі' : '') + '.</p></div>';
  }

  function render() {
    $$('[data-count]').forEach((e) => { e.textContent = tracks.length; });
    if (page === 'library') renderLibrary();
    else if (page === 'playlists') { if (plId) renderPlaylistDetail(); else renderPlaylists(); }
  }

  function setPage(p, id) {
    page = p;
    plId = p === 'playlists' ? (id || null) : null;
    body.dataset.page = p;
    const detail = p === 'playlists' && !!plId;
    $('[data-tools]').hidden = p !== 'library';
    $('[data-plh]').hidden = !detail;
    $('[data-list]').hidden = !(p === 'library' || detail);
    $('[data-pls]').hidden = !(p === 'playlists' && !plId);
    $('[data-stats]').hidden = p !== 'stats';
    $$('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === (p === 'stats' ? '' : p)));
    if (p !== 'stats') statsCtl = null;
    render();
  }

  function meta() {
    const t = cur();
    const title = t ? (t.title || 'Без назви') : 'Немає треків';
    const artist = t ? (t.artist || 'Невідомий виконавець') : 'Додайте музику, щоб почати';
    $$('[data-title]').forEach((e) => { e.textContent = title; });
    $$('[data-artist]').forEach((e) => { e.textContent = artist; });
    $$('[data-cover]').forEach((e) => {
      e.style.background = t ? coverCss(t) : '';
      e.classList.toggle('empty', !t);
    });
    document.title = t && playing ? title + ' — Тембр' : 'Тембр';
    updateFav();
    syncLyrics();
    updateSession();
  }

  function updateFav() {
    const on = !!curId && isFav(curId);
    $$('[data-fav]').forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Прибрати з «Улюблених»' : 'Додати в «Улюблені»');
      b.disabled = !curId;
    });
  }

  function tick() {
    const p = dur ? Math.min(100, (pos / dur) * 100) : 0;
    $$('[data-cur]').forEach((e) => { e.textContent = fmt(pos); });
    $$('[data-dur]').forEach((e) => { e.textContent = dur ? fmt(dur) : '0:00'; });
    $$('[data-fill]').forEach((e) => { e.style.width = p + '%'; });
    $$('[data-seek]').forEach((e) => e.setAttribute('aria-valuenow', String(Math.round(p))));
    if (lyrOn && lyrView) lyrView.update(pos);
  }

  function setPlayState() {
    body.classList.toggle('playing', playing);
    $$('[data-play]').forEach((b) => b.setAttribute('aria-label', playing ? 'Пауза' : 'Відтворити'));
    const t = cur();
    document.title = playing && t ? (t.title || 'Тембр') + ' — Тембр' : 'Тембр';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    lyrLoopSync();
  }

  function setStatus(txt) {
    $$('[data-status]').forEach((e) => { e.textContent = txt; });
  }

  function setLoading(on) {
    body.classList.toggle('loading', on);
    if (!on) setStatus('');
  }

  // ---------- текст пісні ----------

  const lyrView = window.Lyrics.View($('#lyr'), {
    onSeek: (t) => { if (dur && loadedId === curId) seekTo(t / dur); },
    onAdd: () => { if (curId) editLyrics(curId); }
  });

  function syncLyrics() {
    const t = cur();
    const text = t ? (t.lyrics || '') : '';
    const id = t ? t.id : null;
    if (lyrShown && lyrShown.id === id && lyrShown.text === text) return;
    lyrShown = { id, text };
    lyrView.set(text);
    if (lyrOn) lyrView.update(pos);
  }

  function setLyrOn(on) {
    lyrOn = on;
    store('tembr.lyr', on ? '1' : '0');
    body.classList.toggle('lyr-on', on);
    $$('[data-lyrics-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(on)));
    if (on) { syncLyrics(); lyrView.update(pos); setTimeout(() => lyrView.recenter(), 30); }
    lyrLoopSync();
  }

  // Плавне заповнення слів потребує частіших оновлень, ніж timeupdate (~4 рази на секунду).
  function lyrLoopSync() {
    const need = lyrOn && playing && !document.hidden && lyrView.isSynced();
    if (need && !lyrRaf) {
      const step = () => {
        lyrRaf = 0;
        if (!(lyrOn && playing && !document.hidden)) return;
        lyrView.update(audio.currentTime);
        lyrRaf = requestAnimationFrame(step);
      };
      lyrRaf = requestAnimationFrame(step);
    } else if (!need && lyrRaf) {
      cancelAnimationFrame(lyrRaf);
      lyrRaf = 0;
    }
  }

  // ---------- режим вікна: розгорнутий / компактний ----------

  const mq = window.matchMedia('(max-width:860px)');

  function viewKey() { return 'tembr.view.' + (mq.matches ? 'm' : 'd'); }

  function applyView() {
    let v = store(viewKey());
    if (v !== 'expanded' && v !== 'compact') v = mq.matches ? 'compact' : 'expanded';
    body.dataset.view = v;
  }

  function setView(v) {
    body.dataset.view = v;
    store(viewKey(), v);
  }

  // ---------- статистика прослуховувань ----------

  const tr = { id: null, sec: 0, pend: 0, last: null, counted: false };

  function flushStats(count) {
    if (!tr.id || !Store.recordPlay) return Promise.resolve();
    const plays = count ? 1 : 0;
    const sec = tr.pend;
    if (!plays && sec < 3) return Promise.resolve();
    tr.pend = 0;
    return Promise.resolve(Store.recordPlay(window.Stats.keys(new Date()), tr.id, plays, sec)).catch(() => {});
  }

  function trReset(id) {
    flushStats(false);
    tr.id = id;
    tr.sec = 0;
    tr.pend = 0;
    tr.last = null;
    tr.counted = false;
  }

  // Прослуховування зараховується, коли награно 30 секунд (або половину короткого треку).
  function trTick(ct) {
    if (!tr.id || !playing) { tr.last = null; return; }
    if (tr.last != null) {
      const d = ct - tr.last;
      if (d > 0 && d < 2.5) { tr.sec += d; tr.pend += d; }
    }
    tr.last = ct;
    if (!tr.counted && tr.sec >= Math.min(30, (dur || 60) * 0.5)) {
      tr.counted = true;
      flushStats(true);
    }
  }

  // ---------- черга ----------

  const qKey = () => 'tembr.q.' + (me && me.uid ? me.uid : 'x');

  function saveQueue() {
    try { localStorage.setItem(qKey(), JSON.stringify(Q.serialize())); } catch (e) { /* не критично */ }
  }

  function loadQueue() {
    try {
      const raw = localStorage.getItem(qKey());
      return raw ? Q.restore(JSON.parse(raw)) : false;
    } catch (e) { return false; }
  }

  // Будує чергу з контексту (бібліотека, плейлист, статистика) і запускає трек.
  function startContext(id, key, ids) {
    Q.build(ids, id, shuffle, key);
    saveQueue();
    load(id, true);
  }

  function libraryIds() { return sortedTracks().map((t) => t.id); }

  function resetQueue() {
    if (!tracks.length) return;
    const id = curId && byId(curId) ? curId : tracks[0].id;
    Q.build(libraryIds(), id, shuffle, 'library');
    saveQueue();
    prefetchNext();
    toast(shuffle ? 'Чергу скинуто й перемішано заново' : 'Чергу скинуто: тепер вона йде за порядком бібліотеки');
  }

  // ---------- відтворення ----------

  function hardStop() {
    loadTok++;
    pfTok++;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    clearSpare();
    loadedId = null;
    playing = false;
    pos = 0;
    setLoading(false);
    setPlayState();
  }

  function clearSpare() {
    spareId = null;
    if (spare.getAttribute('src')) {
      spare.removeAttribute('src');
      spare.load();
    }
  }

  const isStreamUrl = (u) => String(u || '').indexOf('/__stream/') >= 0;

  function startPlay() {
    if (!curId) return;
    const p = audio.play();
    if (p && p.catch) {
      p.catch((err) => {
        playing = false;
        setPlayState();
        // AbortError: трек змінили; NotSupportedError: про це повідомить подія error самого елемента.
        if (!err || (err.name !== 'AbortError' && err.name !== 'NotSupportedError')) toast('Не вдалося почати відтворення. Натисніть ▶ ще раз.');
      });
    }
  }

  function pausePlay() {
    audio.pause();
    playing = false;
    setPlayState();
  }

  async function load(id, autoplay) {
    const t = byId(id);
    if (!t) return;
    const tok = ++loadTok;
    pfTok++;
    audio.pause();
    playing = false;
    loadedId = null;
    curId = id;
    curAuto = !!autoplay;
    fallbackFor = null;
    store('tembr.last', id);
    pos = 0;
    dur = t.duration || 0;
    trReset(id);
    render();
    meta();
    tick();
    setPlayState();

    // Трек уже підвантажено у запасний елемент: міняємо місцями, грає одразу.
    if (spareId === id && spare.getAttribute('src')) {
      const old = audio;
      audio = spare;
      spare = old;
      clearSpare();
      loadedId = id;
      if (isFinite(audio.duration) && audio.duration > 0) dur = audio.duration;
      tick();
      if (audio.readyState >= 3 || !autoplay) {
        setLoading(false);
      } else {
        setLoading(true);
        setStatus('Буферизація…');
      }
      if (autoplay) startPlay();
      prefetchNext();
      return;
    }

    setLoading(true);
    if (Store.streaming && Store.streaming()) setStatus('Підключення до Диска…');

    let url = null;
    try {
      // Коли екран вимкнено, вікно Google відкрити неможливо: не чекаємо його, а лишаємо трек на паузі.
      url = await Store.getAudioUrl(t, (p) => {
        if (tok === loadTok) setStatus('Завантаження з Диска… ' + Math.round(p * 100) + '%');
      }, { silent: document.visibilityState === 'hidden' });
    } catch (e) {
      if (tok !== loadTok) return;
      setLoading(false);
      if (document.visibilityState === 'hidden' || /no_token|popup/i.test(String((e && e.message) || ''))) resumeHint = true;
      if (document.visibilityState !== 'hidden') toast(errText(e));
      return;
    }
    if (tok !== loadTok) return;
    resumeHint = false;
    loadedId = id;
    audio.src = url;
    if (!autoplay) setLoading(false);
    if (autoplay) startPlay();
    prefetchNext();
  }

  // Підвантажує наступний трек черги у запасний елемент, щоб перемикання було миттєвим.
  async function prefetchNext() {
    const tk = ++pfTok;
    warmTok++;          // черга змінилась: завантаження наперед почнемо заново
    warmFor = null;
    if (repeat === 'one') { clearSpare(); return; }
    const id = Q.peekNext(repeat, true);
    const n = id && id !== curId ? byId(id) : null;
    if (!n) { clearSpare(); return; }
    if (spareId === n.id) return;
    try {
      const url = await Store.getAudioUrl(n, null, { silent: true });
      if (tk !== pfTok) return;
      spare.src = url;
      spare.load();
      spareId = n.id;
    } catch (e) { /* без підвантаження трек просто завантажиться при перемиканні */ }
  }

  // ---------- завантаження наперед ----------
  // Кілька наступних треків качаються цілком і лежать у пам'яті. Тоді черга грає далі навіть зі вимкненим
  // екраном і після завершення години дії токена Google: мережа й вікно входу для цього не потрібні.

  let warmTok = 0;
  let warmFor = null;      // для якого поточного треку вже запущено завантаження наперед

  function aheadCount() {
    const c = navigator.connection;
    return c && c.saveData ? 1 : 3;
  }

  async function warmAhead() {
    const tk = ++warmTok;
    warmFor = curId;
    const ids = Q.peekAhead(aheadCount(), repeat);
    for (let k = 0; k < ids.length; k++) {
      if (tk !== warmTok) return;
      const t = byId(ids[k]);
      if (!t) continue;
      try {
        const url = await Store.getAudioUrl(t, null, { silent: true, blob: true });
        if (tk !== warmTok) return;
        // Якщо цей трек уже стоїть у запасному елементі як потік, підміняємо його на локальну копію.
        if (spareId === t.id && spare.getAttribute('src') !== url) {
          spare.src = url;
          spare.load();
        }
      } catch (e) { return; }   // без токена чи мережі далі не йдемо
    }
  }

  // Починаємо, коли поточний трек уже майже весь у буфері (або награно 25 с), щоб не заважати йому.
  function maybeWarm(a) {
    if (warmFor === curId || !curId || a !== audio || loadedId !== curId) return;
    let buffered = false;
    try {
      const b = a.buffered;
      buffered = b.length > 0 && isFinite(a.duration) && a.duration > 0 && b.end(b.length - 1) >= a.duration - 1.5;
    } catch (e) { /* без буфера */ }
    if (buffered || a.currentTime > 25 || Store.isCached(curId)) warmAhead();
  }

  // Якщо стрімінг не спрацював, завантажуємо файл цілком і продовжуємо з того ж місця.
  async function fallbackToBlob() {
    const t = cur();
    if (!t) return;
    fallbackFor = t.id;
    const tok = ++loadTok;
    const resume = playing || curAuto;
    const at = audio.currentTime || 0;
    playing = false;
    setPlayState();
    setLoading(true);
    try {
      const url = await Store.getAudioUrl(t, (p) => {
        if (tok === loadTok) setStatus('Завантаження з Диска… ' + Math.round(p * 100) + '%');
      }, { blob: true });
      if (tok !== loadTok) return;
      audio.addEventListener('loadedmetadata', () => { if (at > 1) audio.currentTime = at; }, { once: true });
      audio.src = url;
      if (resume) startPlay();
    } catch (e) {
      if (tok !== loadTok) return;
      setLoading(false);
      toast(errText(e));
    }
  }

  function onAudioError(a) {
    if (a === spare) { clearSpare(); return; }
    if (a !== audio || !audio.getAttribute('src')) return;
    if (isStreamUrl(audio.src) && fallbackFor !== curId && Store.getAudioUrl) {
      fallbackToBlob();
      return;
    }
    playing = false;
    setLoading(false);
    setPlayState();
    toast('Не вдалося відтворити цей файл (формат не підтримується браузером?).');
  }

  function mkAudio() {
    const a = new Audio();
    a.preload = 'auto';
    a.volume = volume;
    a.addEventListener('play', () => { if (a === audio) { playing = true; setPlayState(); meta(); } });
    a.addEventListener('pause', () => { if (a === audio) { playing = false; setPlayState(); flushStats(false); } });
    a.addEventListener('timeupdate', () => {
      if (a === audio && loadedId === curId) { pos = a.currentTime; trTick(pos); tick(); maybeWarm(a); }
    });
    a.addEventListener('loadedmetadata', () => {
      if (a === audio && isFinite(a.duration) && a.duration > 0) { dur = a.duration; tick(); }
    });
    const ready = () => { if (a === audio && loadedId === curId && body.classList.contains('loading')) setLoading(false); };
    a.addEventListener('canplay', ready);
    a.addEventListener('playing', ready);
    a.addEventListener('ended', () => { if (a === audio) onEnded(); });
    a.addEventListener('error', () => onAudioError(a));
    return a;
  }

  function next() {
    const id = Q.next(repeat, false);
    if (!id) return;
    saveQueue();
    load(id, true);
  }

  function prev() {
    if (!tracks.length) return;
    if (pos > 3 && loadedId === curId) { seekTo(0); return; }
    const id = Q.prev();
    if (!id) return;
    saveQueue();
    load(id, true);
  }

  function onEnded() {
    flushStats(false);
    if (repeat === 'one') {
      trReset(curId);
      audio.currentTime = 0;
      startPlay();
      return;
    }
    const id = Q.next(repeat, true);
    if (id) {
      saveQueue();
      load(id, true);
    } else {
      pausePlay();
      pos = 0;
      audio.currentTime = 0;
      tick();
    }
  }

  function togglePlay() {
    if (!curId || body.classList.contains('loading')) return;
    if (loadedId !== curId) { load(curId, true); return; }
    if (playing) pausePlay(); else startPlay();
  }

  function seekTo(ratio) {
    if (!dur || loadedId !== curId) return;
    pos = Math.max(0, Math.min(1, ratio)) * dur;
    audio.currentTime = pos;
    tick();
  }

  function bindSeek(el) {
    let drag = false;
    const apply = (e) => {
      const r = el.getBoundingClientRect();
      seekTo((e.clientX - r.left) / r.width);
    };
    el.addEventListener('pointerdown', (e) => {
      drag = true;
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* не критично */ }
      apply(e);
    });
    el.addEventListener('pointermove', (e) => { if (drag) apply(e); });
    const end = () => { drag = false; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      if (!dur) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); seekTo((pos + 5) / dur); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo((pos - 5) / dur); }
    });
  }

  function toggleShuffle() {
    shuffle = !shuffle;
    store('tembr.shuffle', shuffle ? '1' : '0');
    Q.setShuffle(shuffle);
    saveQueue();
    syncModes();
    prefetchNext();
  }

  function cycleRepeat() {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    store('tembr.repeat', repeat);
    syncModes();
    prefetchNext();
  }

  function syncModes() {
    $$('[data-shuffle]').forEach((b) => {
      b.classList.toggle('on', shuffle);
      b.setAttribute('aria-pressed', String(shuffle));
    });
    const label = { off: 'Повтор: вимкнено', all: 'Повтор: усі треки', one: 'Повтор: один трек' }[repeat];
    $$('[data-repeat]').forEach((b) => {
      b.dataset.state = repeat;
      b.setAttribute('aria-label', label);
    });
  }

  // ---------- системні елементи керування (екран блокування, гарнітура) ----------

  function updateSession() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const t = cur();
    if (!t) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title || 'Без назви',
        artist: t.artist || '',
        album: t.album || 'Тембр',
        artwork: t.cover ? [{ src: t.cover, sizes: '256x256', type: 'image/jpeg' }] : []
      });
    } catch (e) { /* не критично */ }
  }

  function bindSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { /* не підтримується */ } };
    set('play', togglePlay);
    set('pause', togglePlay);
    set('previoustrack', prev);
    set('nexttrack', next);
    set('seekto', (d) => { if (dur && d && d.seekTime != null) seekTo(d.seekTime / dur); });
  }

  // ---------- редагування треку ----------

  async function patchTrack(id, patch, okMsg) {
    try {
      await Store.updateTrack(id, patch);
      if (okMsg) toast(okMsg);
    } catch (e) {
      toast(errText(e));
    }
  }

  async function renameTrack(id) {
    const t = byId(id);
    if (!t) return;
    const v = await window.UI.prompt({ title: 'Змінити назву', label: 'Назва треку', value: t.title || '' });
    if (v && v !== t.title) patchTrack(id, { title: v }, 'Назву змінено');
  }

  function editArtists(id) {
    const t = byId(id);
    if (!t) return;
    const names = artistsOf(t);
    if (!names.length) names.push('');
    const m = window.UI.modal({
      title: 'Виконавці',
      body: '<div data-arts></div><button class="art-add" data-art-add type="button"><svg class="ic"><use href="#i-plus"/></svg>Додати ще виконавця</button>',
      actions: []
    });
    const host = $('[data-arts]', m.body);
    const addRow = (v) => {
      const row = document.createElement('div');
      row.className = 'art-row';
      row.innerHTML = '<input type="text" maxlength="100" placeholder="Ім’я виконавця" value="' + esc(v) + '">' +
        '<button class="ghost" type="button" data-art-del aria-label="Прибрати виконавця"><svg class="ic"><use href="#i-close"/></svg></button>';
      host.appendChild(row);
      return row;
    };
    names.forEach(addRow);
    m.body.addEventListener('click', (e) => {
      if (e.target.closest('[data-art-add]')) { addRow('').querySelector('input').focus(); return; }
      const d = e.target.closest('[data-art-del]');
      if (d) {
        if ($$('.art-row', host).length > 1) d.closest('.art-row').remove();
        else d.closest('.art-row').querySelector('input').value = '';
      }
    });
    const save = () => {
      const list = $$('.art-row input', host).map((i) => i.value.trim().replace(/,/g, ' ').replace(/\s+/g, ' ')).filter(Boolean);
      const uniq = list.filter((n, i) => list.indexOf(n) === i);
      m.close();
      patchTrack(id, { artist: uniq.join(', '), artists: uniq }, 'Виконавців збережено');
    };
    m.setActions([
      { label: 'Скасувати', kind: 'ghost', onClick: (mm) => mm.close() },
      { label: 'Зберегти', kind: 'primary', onClick: save }
    ]);
    host.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }

  function pickCover(id) {
    const inp = $('#coverFile');
    inp.dataset.id = id;
    inp.click();
  }

  async function onCoverChosen(file, id) {
    if (!file || !byId(id)) return;
    try {
      const cover = await window.U.resizeImage(file, 256);
      await patchTrack(id, { cover }, 'Обкладинку змінено');
    } catch (e) {
      toast('Не вдалося прочитати зображення.');
    }
  }

  function editLyrics(id) {
    const t = byId(id);
    if (!t) return;
    const m = window.UI.modal({
      title: 'Текст пісні',
      wide: true,
      body: '<div class="lyr-tools"><button class="mdl-btn" type="button" data-lyr-find>Знайти в Інтернеті</button>' +
        '<span class="mdl-p" style="font-size:13px">або вставте свій. Для підсвітки слів потрібен формат із часом: [01:23.45] рядок</span></div>' +
        '<textarea data-lyr-text placeholder="Вставте текст пісні сюди" spellcheck="false"></textarea><div class="lyr-st" data-lyr-st aria-live="polite"></div>',
      actions: []
    });
    const ta = $('[data-lyr-text]', m.body);
    const st = $('[data-lyr-st]', m.body);
    ta.value = t.lyrics || '';
    const status = (txt, good) => { st.textContent = txt; st.classList.toggle('ok', !!good); };
    const hint = () => {
      const p = window.Lyrics.parse(ta.value);
      if (p.lines.length) status(p.synced ? 'Текст із часом: рядки підсвічуватимуться під час відтворення.' : 'Звичайний текст: без підсвітки рядків.', p.synced);
      else status('');
    };
    hint();
    ta.addEventListener('input', hint);
    $('[data-lyr-find]', m.body).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      status('Шукаю текст…');
      try {
        const r = await window.Lyrics.search(t);
        if (!r) status('Нічого не знайдено. Вставте текст вручну.');
        else {
          ta.value = r.text;
          status((r.synced ? 'Знайдено текст із часом: підсвічуватиметься під час відтворення. ' : 'Знайдено лише звичайний текст, без часу. ') +
            (r.approx ? 'Збіг приблизний, перевірте, що це та сама пісня.' : ''), r.synced && !r.approx);
        }
      } catch (err) {
        status('Не вдалося звернутися до сервісу текстів. Перевірте з’єднання або вставте текст вручну.');
      }
      btn.disabled = false;
    });
    m.setActions([
      { label: 'Видалити текст', kind: 'ghost', onClick: (mm) => { mm.close(); patchTrack(id, { lyrics: '' }, 'Текст видалено'); } },
      { label: 'Скасувати', kind: 'ghost', onClick: (mm) => mm.close() },
      { label: 'Зберегти', kind: 'primary', onClick: (mm) => { const v = ta.value.trim(); mm.close(); patchTrack(id, { lyrics: v }, v ? 'Текст збережено' : 'Текст видалено'); } }
    ]);
  }

  function pickPlaylist(id) {
    const t = byId(id);
    if (!t) return;
    const m = window.UI.modal({ title: 'Додати до плейлиста', body: '<ul class="pl-pick" data-pick></ul>', actions: [] });
    const host = $('[data-pick]', m.body);
    const draw = () => {
      host.innerHTML = plList().map((p) => {
        const has = (p.trackIds || []).indexOf(id) >= 0;
        return '<li><label><input type="checkbox" data-pl="' + esc(p.id) + '"' + (has ? ' checked' : '') + '><span>' + esc(p.name) + '</span><small>' + (p.trackIds || []).length + '</small></label></li>';
      }).join('');
    };
    draw();
    host.addEventListener('change', async (e) => {
      const p = plById(e.target.dataset.pl);
      if (!p) return;
      const ids = (p.trackIds || []).filter((x) => x !== id);
      if (e.target.checked) ids.push(id);
      try { await savePl(p, ids); } catch (err) { toast(errText(err)); e.target.checked = !e.target.checked; }
    });
    m.setActions([
      { label: 'Новий плейлист', kind: 'ghost', onClick: async (mm) => {
        const name = await window.UI.prompt({ title: 'Новий плейлист', label: 'Назва плейлиста', ok: 'Створити' });
        if (!name) return;
        try { await Store.savePlaylist({ name, trackIds: [id] }); mm.close(); toast('Плейлист «' + name + '» створено, трек додано'); } catch (err) { toast(errText(err)); }
      } },
      { label: 'Готово', kind: 'primary', onClick: (mm) => mm.close() }
    ]);
    // список оновлюється, коли приходять зміни з Firestore
    const prevHook = onPlaylistsHook;
    onPlaylistsHook = () => { if (document.body.contains(m.el)) draw(); else onPlaylistsHook = prevHook; };
  }

  let onPlaylistsHook = null;

  async function removeTrack(id) {
    const t = byId(id);
    if (!t) return;
    const ok = await window.UI.confirm({
      title: 'Видалити трек?',
      text: '«' + (t.title || 'Без назви') + '» буде видалено з бібліотеки й з Google Диска.',
      ok: 'Видалити',
      danger: true
    });
    if (!ok) return;
    try {
      await Store.removeTrack(t);
      const owners = plList().filter((p) => (p.trackIds || []).indexOf(id) >= 0 && playlists.some((x) => x.id === p.id));
      await Promise.all(owners.map((p) => savePl(p, p.trackIds.filter((x) => x !== id)).catch(() => {})));
      toast('Видалено');
    } catch (e) {
      toast(errText(e));
    }
  }

  async function openRowMenu(id, anchor) {
    const inPl = page === 'playlists' && plId;
    const items = [
      { label: 'Змінити назву', act: 'rename', icon: 'i-edit' },
      { label: 'Змінити виконавця', act: 'artists', icon: 'i-user' },
      { label: 'Додати до плейлиста', act: 'playlist', icon: 'i-pl-add' },
      { label: 'Змінити обкладинку', act: 'cover', icon: 'i-image' },
      { label: 'Текст пісні', act: 'lyrics', icon: 'i-lyrics' }
    ];
    if (inPl) items.push({ label: 'Прибрати з плейлиста', act: 'unpl', icon: 'i-pl-rm' });
    items.push({ sep: true }, { label: 'Видалити', act: 'delete', icon: 'i-trash', danger: true });
    const act = await window.UI.menu(anchor, items);
    if (act === 'rename') renameTrack(id);
    else if (act === 'artists') editArtists(id);
    else if (act === 'playlist') pickPlaylist(id);
    else if (act === 'cover') pickCover(id);
    else if (act === 'lyrics') editLyrics(id);
    else if (act === 'unpl') {
      const p = plById(plId);
      if (p) savePl(p, (p.trackIds || []).filter((x) => x !== id)).then(() => toast('Прибрано з плейлиста'), (e) => toast(errText(e)));
    } else if (act === 'delete') removeTrack(id);
  }

  // ---------- плейлисти ----------

  async function newPlaylist() {
    const name = await window.UI.prompt({ title: 'Новий плейлист', label: 'Назва плейлиста', ok: 'Створити' });
    if (!name) return;
    try {
      const id = await Store.savePlaylist({ name, trackIds: [] });
      toast('Плейлист «' + name + '» створено');
      if (id) setPage('playlists', id);
    } catch (e) {
      toast(errText(e));
    }
  }

  async function playlistMenu(anchor) {
    const p = plById(plId);
    if (!p || p.id === FAV) return;
    const act = await window.UI.menu(anchor, [
      { label: 'Перейменувати', act: 'rename', icon: 'i-edit' },
      { label: 'Видалити плейлист', act: 'delete', icon: 'i-trash', danger: true }
    ]);
    if (act === 'rename') {
      const v = await window.UI.prompt({ title: 'Перейменувати плейлист', label: 'Назва плейлиста', value: p.name });
      if (v && v !== p.name) savePl({ id: p.id, name: v, kind: p.kind }, p.trackIds || []).catch((e) => toast(errText(e)));
    } else if (act === 'delete') {
      const ok = await window.UI.confirm({ title: 'Видалити плейлист?', text: 'Плейлист «' + p.name + '» буде видалено. Самі треки залишаться в бібліотеці.', ok: 'Видалити', danger: true });
      if (ok) {
        try { await Store.deletePlaylist(p.id); setPage('playlists'); toast('Плейлист видалено'); } catch (e) { toast(errText(e)); }
      }
    }
  }

  function playPlaylist(doShuffle) {
    const p = plById(plId);
    if (!p) return;
    const ids = plTracks(p).map((t) => t.id);
    if (!ids.length) return;
    if (doShuffle && !shuffle) { shuffle = true; store('tembr.shuffle', '1'); syncModes(); }
    const start = doShuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
    startContext(start, 'pl:' + p.id, ids);
  }

  async function toggleFav(id) {
    if (!id || !byId(id)) return;
    const p = favorites();
    const ids = (p.trackIds || []).filter((x) => x !== id);
    const adding = ids.length === (p.trackIds || []).length;
    if (adding) ids.push(id);
    try {
      await savePl({ id: FAV, name: 'Улюблені', kind: 'favorites' }, ids);
      toast(adding ? 'Додано в «Улюблені»' : 'Прибрано з «Улюблених»');
    } catch (e) {
      toast(errText(e));
    }
  }

  // ---------- завантаження файлів ----------

  function showUpl(s) {
    const el = $('#upl');
    el.hidden = false;
    const stage = { meta: 'читаю теги', upload: 'завантажую на Диск', save: 'зберігаю', done: 'готово' }[s.stage] || '';
    const pct = s.stage === 'upload' ? ' ' + Math.round(s.progress * 100) + '%' : '';
    $('.upl-t', el).textContent = 'Файл ' + (s.i + 1) + ' з ' + s.n + ' · ' + s.name + ' · ' + stage + pct;
    const frac = s.stage === 'upload' ? s.progress * 0.9 : (s.stage === 'save' || s.stage === 'done') ? 1 : 0;
    $('.upl-b i', el).style.width = Math.round(((s.i + frac) / s.n) * 100) + '%';
  }

  async function keepAwake(on) {
    try {
      if (on && navigator.wakeLock && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* не критично */ }
  }

  const isDuplicate = (f) => tracks.some((t) => t.fileName === f.name && +t.size === f.size);

  // Викликається з діалогу імпорту. Повертає false, якщо завантаження не почалось.
  async function runImport(files, onFileDone) {
    if (uploading) { toast('Зачекайте, поки завершиться поточне завантаження.'); return false; }
    // Це відбувається під час кліку «Додати», тому вікно доступу Google дозволено.
    if (!Store.hasToken()) {
      try {
        await Store.ensureToken();
      } catch (e) {
        toast(errText(e));
        return false;
      }
    }
    uploading = true;
    keepAwake(true);
    (async () => {
      try {
        const res = await Store.addFiles(files, showUpl, onFileDone);
        const left = window.Importer.pending();
        const tail = left ? ' Решта лишилась у списку імпорту («Завантажити»).' : '';
        if (res.added && !res.failed) toast('Додано треків: ' + res.added + '.' + tail);
        else if (res.added) toast('Додано: ' + res.added + ', не вдалося: ' + res.failed + '. ' + (res.errors[0] || '') + tail);
        else toast('Не вдалося додати файли. ' + (res.errors[0] || '') + tail);
      } catch (e) {
        toast(errText(e));
      }
      uploading = false;
      keepAwake(false);
      $('#upl').hidden = true;
    })();
    return true;
  }

  function checkShared() {
    if (sharedChecked) return;
    sharedChecked = true;
    if (/[?&]share=1/.test(location.search)) {
      try { window.history.replaceState(null, '', location.pathname); } catch (e) { /* не критично */ }
    }
    window.Importer.loadShared().then((n) => {
      if (n) {
        window.Importer.open();
        toast('Отримано файлів: ' + n + '. Перевірте список і натисніть «Додати».');
      }
    });
  }

  // ---------- акаунт і бічна панель ----------

  function openDrawer(on) {
    $('#drawer').hidden = !on;
    if (on) $('[data-open-stats]').focus();
  }

  async function openStats() {
    openDrawer(false);
    await Promise.race([flushStats(false), new Promise((r) => setTimeout(r, 1200))]);
    setPage('stats');
    statsCtl = window.Stats.open($('[data-stats]'), {
      tracks: () => tracks,
      getStats: (keys) => Store.getStats(keys),
      coverCss,
      play: (ids, id) => startContext(id, 'stats', ids)
    });
  }

  function setAvatar(u) {
    [['#avatarImg', '#avatarTxt'], ['#drImg', '#drTxt']].forEach((pair) => {
      const img = $(pair[0]);
      const txt = $(pair[1]);
      if (u.photo) { img.src = u.photo; img.hidden = false; txt.hidden = true; }
      else { img.hidden = true; txt.hidden = false; txt.textContent = (u.name || 'Т').trim().charAt(0).toUpperCase(); }
    });
  }

  function onAuth(u) {
    if (!u) {
      hardStop();
      flushStats(false);
      curId = null;
      me = null;
      sharedChecked = false;
      queueReady = false;
      playlists = [];
      settings = { order: [] };
      lyrShown = null;
      openDrawer(false);
      setPage('library');
      body.dataset.auth = 'out';
      $('#authMsg').textContent = '';
      return;
    }
    me = u;
    body.dataset.auth = 'in';
    setAvatar(u);
    $('#muName').textContent = u.name || '';
    $('#muMail').textContent = u.email || '';
  }

  // Узгоджує чергу й поточний трек зі списком треків.
  function settleQueue() {
    const ids = tracks.map((t) => t.id);
    if (!queueReady) {
      queueReady = true;
      if (!loadQueue() || !Q.state.ids.length) Q.build(libraryIds(), null, shuffle, 'library');
      Q.setShuffle(shuffle);
    }
    Q.sync(ids);
    if (!Q.state.ids.length && ids.length) Q.build(libraryIds(), ids[0], shuffle, 'library');
    saveQueue();
  }

  function onTracks(list) {
    tracks = list;
    body.toggleAttribute('data-empty', !tracks.length);
    if (curId && !byId(curId)) { hardStop(); curId = null; }
    if (tracks.length && body.dataset.auth !== 'out') settleQueue();
    if (!curId && tracks.length) {
      const q = Q.cur();
      const last = store('tembr.last');
      const t = (q && byId(q)) || (last && byId(last)) || tracks[0];
      curId = t.id;
      if (Q.cur() !== curId) { Q.build(libraryIds(), curId, shuffle, 'library'); saveQueue(); }
      pos = 0;
      dur = t.duration || 0;
    }
    if (!tracks.length) { dur = 0; pos = 0; }
    render();
    meta();
    tick();
    if (body.dataset.auth === 'in') checkShared();
  }

  function onPlaylists(list) {
    playlists = list;
    if (page === 'playlists') render();
    updateFav();
    if (onPlaylistsHook) onPlaylistsHook();
  }

  function onSettings(s) {
    settings = { order: Array.isArray(s.order) ? s.order : [] };
    if (page === 'library' && sortMode === 'custom') render();
  }

  function onError(msg) {
    if (body.dataset.auth === 'loading') {
      body.dataset.auth = 'out';
      $('[data-signin]').hidden = true;
      $('#authMsg').textContent = msg;
    } else {
      toast(msg);
    }
  }

  async function signIn() {
    const msg = $('#authMsg');
    msg.textContent = '';
    try {
      await Store.signIn();
    } catch (e) {
      msg.textContent = errText(e);
    }
  }

  // ---------- перетягування для власного порядку ----------

  function bindDrag() {
    const list = $('[data-list]');
    list.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('[data-grip]');
      if (!g || !list.classList.contains('drag-on')) return;
      const row = g.closest('.row');
      e.preventDefault();
      row.classList.add('dragging');
      // Рухаємо сусідні рядки, а не сам рядок: тоді події вказівника не губляться.
      const move = (ev) => {
        const y = ev.clientY;
        const lr = list.getBoundingClientRect();
        if (y < lr.top + 36) list.scrollTop -= 14; else if (y > lr.bottom - 36) list.scrollTop += 14;
        let prevEl = row.previousElementSibling;
        while (prevEl) {
          const r = prevEl.getBoundingClientRect();
          if (y < r.top + r.height / 2) { row.after(prevEl); prevEl = row.previousElementSibling; } else break;
        }
        let nextEl = row.nextElementSibling;
        while (nextEl) {
          const r = nextEl.getBoundingClientRect();
          if (y > r.top + r.height / 2) { row.before(nextEl); nextEl = row.nextElementSibling; } else break;
        }
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        row.classList.remove('dragging');
        const ids = $$('.row', list).map((r) => r.dataset.id);
        settings = { order: ids };
        $$('.row .n b', list).forEach((b, i) => { b.textContent = i + 1; });
        Store.saveOrder(ids).catch((err) => toast(errText(err)));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }

  // ---------- свайп вниз згортає великий плеєр ----------

  function bindSwipe() {
    const np = $('.np');
    let sy = null;
    let st = 0;
    let dy = 0;
    let active = false;
    np.addEventListener('touchstart', (e) => {
      if (!mq.matches || body.dataset.view !== 'expanded' || e.touches.length !== 1) { sy = null; return; }
      if (e.target.closest('[data-seek],[data-vol],input,.lyr') || np.scrollTop > 0) { sy = null; return; }
      sy = e.touches[0].clientY;
      st = Date.now();
      dy = 0;
      active = false;
    }, { passive: true });
    np.addEventListener('touchmove', (e) => {
      if (sy == null) return;
      dy = e.touches[0].clientY - sy;
      if (dy > 8 || active) {
        active = true;
        np.classList.add('swiping');
        np.style.transform = 'translateY(' + Math.max(0, dy) + 'px)';
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });
    const end = () => {
      if (sy == null) return;
      sy = null;
      np.classList.remove('swiping');
      const fast = dy / Math.max(1, Date.now() - st) > 0.6;
      if (active && (dy > 120 || (dy > 50 && fast))) {
        np.style.transform = 'translateY(100%)';
        setTimeout(() => { setView('compact'); np.style.transform = ''; }, 280);
      } else {
        np.style.transform = '';
      }
      active = false;
    };
    np.addEventListener('touchend', end);
    np.addEventListener('touchcancel', end);
  }

  // ---------- події ----------

  document.addEventListener('click', (e) => {
    const t = e.target;
    let el = t.closest('[data-more]');
    if (el) { openRowMenu(el.dataset.more, el); return; }
    el = t.closest('[data-play-id]');
    if (el) {
      const id = el.dataset.playId;
      if (id === curId && loadedId === curId) { togglePlay(); return; }
      if (page === 'playlists' && plId) {
        const p = plById(plId);
        startContext(id, 'pl:' + plId, p ? plTracks(p).map((x) => x.id) : [id]);
      } else {
        startContext(id, 'library', libraryIds());
      }
      return;
    }
    el = t.closest('[data-nav]');
    if (el) { setPage(el.dataset.nav); return; }
    el = t.closest('[data-open-pl]');
    if (el) { setPage('playlists', el.dataset.openPl); return; }
    if (t.closest('[data-new-pl]')) { newPlaylist(); return; }
    if (t.closest('[data-pl-back]')) { setPage('playlists'); return; }
    if (t.closest('[data-pl-play]')) { playPlaylist(false); return; }
    if (t.closest('[data-pl-shuffle]')) { playPlaylist(true); return; }
    el = t.closest('[data-pl-menu]');
    if (el) { playlistMenu(el); return; }
    if (t.closest('[data-upload]')) { window.Importer.open(); return; }
    if (t.closest('[data-reset-queue]')) { resetQueue(); return; }
    if (t.closest('[data-fav]')) { toggleFav(curId); return; }
    if (t.closest('[data-lyrics-toggle]')) { setLyrOn(!lyrOn); return; }
    if (t.closest('[data-play]')) { togglePlay(); return; }
    if (t.closest('[data-prev]')) { prev(); return; }
    if (t.closest('[data-next]')) { next(); return; }
    if (t.closest('[data-shuffle]')) { toggleShuffle(); return; }
    if (t.closest('[data-repeat]')) { cycleRepeat(); return; }
    if (t.closest('[data-expand]')) { setView('expanded'); return; }
    if (t.closest('[data-collapse]')) { setView('compact'); return; }
    if (t.closest('[data-signin]')) { signIn(); return; }
    if (t.closest('[data-signout]')) { openDrawer(false); Store.signOut(); return; }
    if (t.closest('[data-open-stats]')) { openStats(); return; }
    if (t.closest('#userBtn')) { openDrawer(true); return; }
    if (t.closest('[data-drawer-close]') || t.id === 'drawer') { openDrawer(false); }
  });

  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable) return;
    if (e.key === 'Escape') {
      if (!$('#drawer').hidden) { openDrawer(false); return; }
      if (mq.matches && body.dataset.view === 'expanded') setView('compact');
      return;
    }
    if (body.dataset.auth !== 'in') return;
    if (e.code === 'Space' && tag !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    else if (e.shiftKey && e.key === 'ArrowRight') next();
    else if (e.shiftKey && e.key === 'ArrowLeft') prev();
  });

  $('#q').addEventListener('input', (e) => { query = e.target.value; render(); });

  $('#sort').addEventListener('change', (e) => {
    sortMode = e.target.value;
    store('tembr.sort', sortMode);
    render();
  });

  $('#coverFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    const id = e.target.dataset.id;
    e.target.value = '';
    onCoverChosen(f, id);
  });

  $$('[data-vol]').forEach((v) => {
    const saved = store('tembr.vol');
    if (saved != null && saved !== '') v.value = saved;
    volume = v.value / 100;
    v.addEventListener('input', () => {
      volume = v.value / 100;
      audio.volume = volume;
      spare.volume = volume;
      store('tembr.vol', v.value);
    });
  });

  $$('[data-seek]').forEach(bindSeek);

  // перетягування файлів і папок у вікно
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0 && body.dataset.auth === 'in') {
      e.preventDefault();
      body.classList.add('drag');
    }
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) body.classList.remove('drag'); });
  document.addEventListener('drop', (e) => {
    if (!body.classList.contains('drag')) return;
    e.preventDefault();
    body.classList.remove('drag');
    window.Importer.addDrop(e.dataTransfer);
  });
  window.addEventListener('beforeunload', (e) => {
    if (uploading) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => {
    if (uploading && document.visibilityState === 'visible') keepAwake(true);
    if (document.visibilityState === 'hidden') flushStats(false);
    if (document.visibilityState === 'visible' && resumeHint && curId && loadedId !== curId) {
      resumeHint = false;
      toast('Наступний трек готовий. Натисніть ▶, щоб продовжити: потрібно відновити доступ до Диска.');
    }
    lyrLoopSync();
  });
  // Токен Google живе ~1 год. Якщо музика грає й токен скоро закінчиться, оновлюємо його при найближчому дотику
  // (вікно Google можна відкрити лише з жесту користувача).
  let tokBusy = false;
  document.addEventListener('click', () => {
    if (tokBusy || !me || !playing || !Store.tokenLeft) return;
    const left = Store.tokenLeft();
    if (left > 8 * 60 * 1000) return;
    tokBusy = true;
    Store.refreshToken().then(() => { warmFor = null; maybeWarm(audio); }).catch(() => {}).finally(() => { tokBusy = false; });
  }, true);
  window.addEventListener('pagehide', () => flushStats(false));

  mq.addEventListener('change', applyView);

  // ---------- старт ----------

  audio = mkAudio();
  spare = mkAudio();
  window.Importer.init({ onImport: runImport, isDuplicate });
  shuffle = store('tembr.shuffle') === '1';
  repeat = ['off', 'all', 'one'].indexOf(store('tembr.repeat')) >= 0 ? store('tembr.repeat') : 'off';
  const savedSort = store('tembr.sort');
  if (['new', 'old', 'az', 'za', 'custom'].indexOf(savedSort) >= 0) sortMode = savedSort;
  $('#sort').value = sortMode;
  body.setAttribute('data-empty', '');
  syncModes();
  applyView();
  bindSession();
  bindDrag();
  bindSwipe();
  setPage('library');
  if (store('tembr.lyr') === '1') setLyrOn(true);
  meta();
  tick();
  setPlayState();

  const problem = setupProblem();
  if (problem) {
    body.dataset.auth = 'out';
    $('[data-signin]').hidden = true;
    $('#authMsg').textContent = problem;
    return;
  }

  Store.init({ onAuth, onTracks, onPlaylists, onSettings, onError });

  setTimeout(() => {
    if (body.dataset.auth === 'loading') {
      onError('Не вдається підключитися до Firebase і Google. Перевірте з’єднання, вимкніть блокувальники реклами й оновіть сторінку.');
    }
  }, 15000);
})();
