// Модель черги відтворення: впорядкований список із вказівником.
// Усе, що вже грало, лишається позаду вказівника, тому «назад» і знову «далі»
// ведуть тими самими треками, у тому числі у випадковому режимі.
(function (root) {
  'use strict';

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  const MAX = 5000;

  function create() {
    const q = { ids: [], ctx: [], key: 'library', i: -1, shuffle: false, wrap: null };

    const cur = () => (q.i >= 0 && q.i < q.ids.length ? q.ids[q.i] : null);

    function build(ctx, startId, shuffle, key) {
      q.ctx = ctx.slice();
      q.key = key || 'library';
      q.shuffle = !!shuffle;
      q.wrap = null;
      let at = q.ctx.indexOf(startId);
      if (at < 0 && startId != null) { q.ctx.unshift(startId); at = 0; }
      if (q.shuffle) {
        q.ids = [startId].concat(shuffled(q.ctx.filter((id) => id !== startId)));
        q.i = 0;
      } else {
        q.ids = q.ctx.slice();
        q.i = Math.max(0, at);
      }
      if (startId == null) { q.ids = q.shuffle ? shuffled(q.ctx) : q.ctx.slice(); q.i = q.ids.length ? 0 : -1; }
    }

    // Порядок наступного циклу (коли черга дійшла до кінця).
    function planWrap() {
      if (q.wrap) return q.wrap;
      let w = q.shuffle ? shuffled(q.ctx) : q.ctx.slice();
      const last = cur();
      if (q.shuffle && w.length > 1 && w[0] === last) { const t = w[0]; w[0] = w[1]; w[1] = t; }
      q.wrap = w;
      return w;
    }

    // Який трек зіграє далі, не рухаючи вказівник. auto: природне завершення треку.
    function peekNext(repeat, auto) {
      if (!q.ids.length) return null;
      if (repeat === 'one' && auto) return cur();
      if (q.i + 1 < q.ids.length) return q.ids[q.i + 1];
      if (repeat === 'all' || !auto) { const w = planWrap(); return w.length ? w[0] : null; }
      return null;
    }

    // Кілька наступних треків (для завантаження наперед), не рухаючи вказівник.
    function peekAhead(n, repeat) {
      const out = [];
      if (repeat === 'one') return out;
      for (let k = q.i + 1; k < q.ids.length && out.length < n; k++) out.push(q.ids[k]);
      if (out.length < n && repeat === 'all') {
        const w = planWrap();
        for (let k = 0; k < w.length && out.length < n; k++) out.push(w[k]);
      }
      return out;
    }

    function next(repeat, auto) {
      const id = peekNext(repeat, auto);
      if (id == null) return null;
      if (repeat === 'one' && auto) return id;
      if (q.i + 1 < q.ids.length) { q.i++; return q.ids[q.i]; }
      q.ids = q.ids.concat(planWrap());
      q.wrap = null;
      q.i++;
      if (q.ids.length > MAX) { const cut = q.ids.length - MAX; q.ids = q.ids.slice(cut); q.i -= cut; }
      return q.ids[q.i];
    }

    function prev() {
      if (!q.ids.length) return null;
      if (q.i > 0) { q.i--; return q.ids[q.i]; }
      if (q.shuffle) return q.ids[0];
      q.i = q.ids.length - 1;
      return q.ids[q.i];
    }

    function setShuffle(on) {
      on = !!on;
      if (on === q.shuffle) return;
      q.shuffle = on;
      q.wrap = null;
      const c = cur();
      if (on) {
        const played = q.ids.slice(0, q.i + 1);
        const seen = new Set(played);
        q.ids = played.concat(shuffled(q.ctx.filter((id) => !seen.has(id))));
      } else {
        q.ids = q.ctx.slice();
        q.i = Math.max(0, q.ids.indexOf(c));
      }
    }

    // Узгоджує чергу з бібліотекою: прибирає видалені треки, додає нові.
    function sync(validIds) {
      const valid = new Set(validIds);
      let keptBefore = 0;
      let at = -1;
      const ids = [];
      q.ids.forEach((id, k) => {
        if (!valid.has(id)) return;
        if (k === q.i) at = ids.length;
        if (k < q.i) keptBefore++;
        ids.push(id);
      });
      q.i = at >= 0 ? at : Math.min(keptBefore, ids.length - 1);
      q.ids = ids;
      q.ctx = q.ctx.filter((id) => valid.has(id));
      q.wrap = null;
      if (q.key === 'library') {
        const known = new Set(q.ctx);
        const fresh = validIds.filter((id) => !known.has(id));
        if (fresh.length) {
          q.ctx = q.ctx.concat(fresh);
          q.ids = q.ids.concat(q.shuffle ? shuffled(fresh) : fresh);
        }
      }
      if (q.i < 0 && q.ids.length) q.i = 0;
    }

    function serialize() {
      return { ids: q.ids, ctx: q.ctx, key: q.key, i: q.i, shuffle: q.shuffle };
    }

    function restore(o) {
      if (!o || !Array.isArray(o.ids) || !Array.isArray(o.ctx)) return false;
      q.ids = o.ids.slice(0, MAX);
      q.ctx = o.ctx.slice();
      q.key = o.key || 'library';
      q.i = Math.min(Math.max(+o.i || 0, -1), q.ids.length - 1);
      q.shuffle = !!o.shuffle;
      q.wrap = null;
      return true;
    }

    return { state: q, cur, build, peekNext, peekAhead, next, prev, setShuffle, sync, serialize, restore };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Queue = api;
})(typeof window !== 'undefined' ? window : globalThis);
