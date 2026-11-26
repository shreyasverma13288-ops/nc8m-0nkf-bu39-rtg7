/* Country Intelligence: read-only copy (21 Nov 2026). There is no server: every reader request for /api/... is answered
   in the browser from the published snapshot (data/reader-data.json.gz; the overlay page's answers load on first use
   from data/compare-series.json.gz). Nothing can be written; owner, review and decision records are not in the copy.
   Built by scripts/ops/readonly_site.py; the answers are the local site's own reader answers, taken on the snapshot day. */
(() => {
  'use strict';
  const CFG = window.CI_READER || { base: '' };
  const BASE = CFG.base;
  const realFetch = window.fetch.bind(window);
  const misses = (window.__CI_MISSES = []);
  try { localStorage.removeItem('ci-owner'); } catch (e) { /* storage unavailable */ }

  const gunzipJson = async (url) => {
    const r = await realFetch(url);
    if (!r.ok) throw new Error('Snapshot unavailable: ' + url);
    const b = new Uint8Array(await r.arrayBuffer());
    const text = b[0] === 0x1f && b[1] === 0x8b
      ? await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(b);
    return JSON.parse(text);
  };
  const DATA = gunzipJson(BASE + '/data/reader-data.json.gz');
  let OVERLAYS = null;
  const overlays = () => (OVERLAYS = OVERLAYS || gunzipJson(BASE + '/data/compare-series.json.gz'));

  const enc = (s) => encodeURIComponent(s);
  /** The snapshot key: path plus the non-empty query parameters sorted by name (as readonly_crawl.key builds it). */
  const keyOf = (path, q) => {
    const pairs = [...q.entries()].filter(([, v]) => v !== '').sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return path + (pairs.length ? '?' + pairs.map(([k, v]) => enc(k) + '=' + enc(v)).join('&') : '');
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
  const text = (t, type) => new Response(t, { status: 200, headers: { 'Content-Type': type } });
  const absent = (k, why) => { misses.push(k); console.warn('[read-only copy] not in the snapshot:', k); return json({ detail: why || 'Not part of the read-only copy.' }, 404); };

  // ---------------------------------------------------------------- The Web: the server's filter (web/query.graph)
  function webGraph(R, q) {
    const g = R['/api/web'];
    const list = (k) => (q.get(k) || '').split(',').filter(Boolean);
    const fam = list('family'), types = list('type'), conf = list('confidence');
    const maxTier = Number(q.get('max_tier') || 2), country = q.get('country'), node = q.get('node');
    const nature = q.get('nature'), status = q.get('status');
    const cnode = country ? (g.nodes.find((n) => n.type === 'country' && n.cid === country) || {}).id : null;
    const keep = g.links.filter((lk) => lk.tier <= maxTier
      && (!fam.length || fam.includes(lk.family)) && (!types.length || types.includes(lk.type))
      && (!conf.length || conf.includes(lk.confidence)) && (!nature || lk.nature === nature)
      && !(status === 'activated' && (lk.status || {}).state === 'normal')
      && !(cnode && cnode !== lk.from && cnode !== lk.to && lk.origin !== country)
      && !(node && node !== lk.from && node !== lk.to && !(lk.named || []).some((n) => n.node === node)));
    const deg = {};
    keep.forEach((lk) => [lk.from, lk.to].forEach((x) => { deg[x] = (deg[x] || 0) + (4 - lk.tier); }));
    const ids = [...new Set(keep.flatMap((lk) => [lk.from, lk.to]))].sort();
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    return { nodes: ids.filter((i) => byId[i]).map((i) => ({ ...byId[i], weight: deg[i] || 0 })), links: keep, vocab: g.vocab };
  }

  // ---------------------------------------------------------------- search: a port of backend/app/search.py
  const NUMW = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', twenty: '20', thirty: '30' };
  const STOP = new Set('the a an of and or in on for to by with at from is are was were be as that this it its into than also s do does did what how'.split(' '));
  const TOK = /[0-9]+(?:[.,][0-9]+)*%?|[\p{L}\p{M}]+/gu;
  const stem = (w) => (w.length > 3 && w.endsWith('ies') && !w.endsWith('eies') ? w.slice(0, -3) + 'y'
    : w.length > 3 && w.endsWith('s') && !/(ss|us|is|ys)$/.test(w) ? w.slice(0, -1) : w);
  const normWord = (w) => { w = w.toLowerCase().replace(/,/g, ''); w = NUMW[w] || w; return ['yr', 'yrs', 'y', 'years'].includes(w) ? 'year' : stem(w); };
  function tokens(t) {
    const out = [];
    for (const m of (t || '').matchAll(TOK)) {
      const s = m[0], mm = /^([0-9]+)(y|yr|yrs|m|bp)$/i.exec(s);
      if (mm) { out.push([mm[1], m.index, m.index + mm[1].length]); out.push([{ y: 'year', yr: 'year', yrs: 'year', m: 'month', bp: 'bp' }[mm[2].toLowerCase()], m.index, m.index + s.length]); continue; }
      out.push([normWord(s), m.index, m.index + s.length]);
    }
    return out;
  }
  const normWords = (t) => tokens(t).map((x) => x[0]);
  const positions = (ws) => { const d = {}; ws.forEach((w, i) => (d[w] = d[w] || []).push(i)); return d; };
  let INDEX = null;
  function index(S) {
    if (INDEX) return INDEX;
    INDEX = S.items.map((it) => {
      const text = (it.text || '').replace(/\s+/g, ' ').trim(), xt = tokens(text), xs = xt.map((x) => x[0]), tt = normWords(it.label || '');
      return { ...it, text, xt, xs, tt, tpos: positions(tt), xpos: positions(xs), ctx: (it.ctx || '').split(' ') };
    });
    return INDEX;
  }
  const find = (seq, pos, ph) => (pos[ph[0]] || []).filter((p) => ph.every((w, k) => seq[p + k] === w));
  const prefix = (ws, w) => w.length >= 4 && ws.some((x) => x.startsWith(w) && x !== w);
  function units(q, aliases) {
    const words = normWords(q), content = words.filter((w) => !STOP.has(w));
    const c = content.length ? content : words, out = [];
    for (let i = 0; i < c.length;) {
      let hit = null;
      for (let n = Math.min(5, c.length - i); n > 1 && !hit; n--) {
        const ph = c.slice(i, i + n).join(' ');
        const g = aliases.find((g) => g.includes(ph));
        if (g) hit = [n, g];
      }
      if (hit) { out.push(hit[1].map((x) => x.split(' '))); i += hit[0]; continue; }
      const w = c[i], alts = [[w]];
      aliases.forEach((g) => { if (g.includes(w)) g.forEach((x) => { if (x !== w) alts.push(x.split(' ')); }); });
      out.push(alts); i += 1;
    }
    return out;
  }
  function score(it, us, qwords, ucountry) {
    let matched = 0, sc = 0; const hits = [], per = [];
    for (const alts of us) {
      let best = 0, upos = [];
      for (const ph of alts) {
        if (find(it.tt, it.tpos, ph).length) best = Math.max(best, 3);
        const ps = find(it.xs, it.xpos, ph);
        if (ps.length) { best = Math.max(best, 2); ps.forEach((p) => ph.forEach((_, k) => upos.push(p + k))); }
        if (!best && ph.length === 1 && it.ctx.includes(ph[0])) best = Math.max(best, 1.2);
      }
      if (!best) for (const ph of alts) {
        if (ph.length === 1 && (prefix(it.tt, ph[0]) || prefix(it.xs, ph[0]))) {
          best = 0.4; it.xs.forEach((x, i) => { if (x.startsWith(ph[0]) && upos.length < 20) upos.push(i); }); break;
        }
      }
      if (best) { matched += 1; sc += best; }
      per.push(upos); hits.push(...upos);
    }
    if (!matched) return null;
    if (qwords.length > 1) {
      if (find(it.tt, it.tpos, qwords).length) sc += 6; else if (find(it.xs, it.xpos, qwords).length) sc += 4;
      for (let i = 0; i + 1 < qwords.length; i++) if (find(it.xs, it.xpos, [qwords[i], qwords[i + 1]]).length || find(it.tt, it.tpos, [qwords[i], qwords[i + 1]]).length) sc += 0.8;
    }
    if (us.length > 1) { const f = per.filter((p) => p.length).map((p) => Math.min(...p)); if (f.length > 1 && Math.max(...f) - Math.min(...f) <= 14) sc += 1.5; }
    ucountry.forEach((c) => { if (c && it.country) sc += it.country === c ? 2 : -2; });
    if (it.kind === 'Article passage' || it.kind === 'Calendar event') sc -= 0.3;
    return [matched / us.length, sc, hits];
  }
  function excerpt(it, hits) {
    if (!it.text) return ['', []];
    if (!hits.length) return [it.text.slice(0, 200) + (it.text.length > 200 ? '…' : ''), []];
    const hs = [...new Set(hits)].sort((a, b) => a - b);
    let best = -1, bi = hs[0];
    for (const h of hs) { const c = hs.filter((x) => Math.abs(x - h) <= 14).length; if (c > best) { best = c; bi = h; } }
    const win = hs.filter((x) => Math.abs(x - bi) <= 14);
    const at = Math.max(0, win[0] - 10), bt = Math.min(it.xt.length - 1, win[win.length - 1] + 14);
    let a = it.xt[at][1], b = it.xt[bt][2];
    if (b - a < 160) b = Math.min(it.text.length, a + 220);
    const snip = (a > 0 ? '…' : '') + it.text.slice(a, b).trim() + (b < it.text.length ? '…' : '');
    const marks = [...new Set(win.map((x) => it.text.slice(it.xt[x][1], it.xt[x][2])))].sort((m, n) => n.length - m.length || (m < n ? -1 : m > n ? 1 : 0));
    return [snip, marks];
  }
  function search(S, q) {
    const raw = (q.get('q') || '').trim(), country = q.get('country'), limit = Math.min(Math.max(Number(q.get('limit') || 40), 1), 100);
    const none = { q: raw, results: [], counts: {}, total: 0, mode: 'none' };
    if (raw.length < 2) return none;
    const us = units(raw, S.aliases || []);
    if (!us.length) return none;
    const cmap = S.countries || {};
    const ucountry = us.map((u) => { const ph = u.find((p) => cmap[p.join(' ')]); return ph ? cmap[ph.join(' ')] : null; });
    const qw = normWords(raw).filter((w) => !STOP.has(w)), qwords = qw.length ? qw : normWords(raw);
    const full = [], partial = [];
    for (const it of index(S)) {
      if (country && it.country !== country && it.country !== null) continue;
      const r = score(it, us, qwords, ucountry);
      if (!r) continue;
      (r[0] >= 0.999 ? full : partial).push([r[1], r[0], it, r[2]]);
    }
    let mode = 'all', pool = full;
    if (!full.length) { const need = us.length > 2 ? 0.5 : 0.99; pool = partial.filter((x) => x[1] >= need); mode = pool.length ? 'partial' : 'none'; }
    pool.sort((x, y) => y[1] - x[1] || y[0] - x[0] || (x[2].label < y[2].label ? -1 : x[2].label > y[2].label ? 1 : 0));
    const counts = {}; pool.forEach(([, , it]) => { counts[it.kind] = (counts[it.kind] || 0) + 1; });
    const res = [], seen = new Set();
    for (const [, cov, it, hits] of pool) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      const [snippet, marks] = excerpt(it, hits);
      res.push({ kind: it.kind, label: it.label, url: it.url, country: it.country, where: it.where, snippet, marks, partial: cov < 0.999 });
      if (res.length >= limit) break;
    }
    return { q: raw, results: res, counts, total: pool.length, mode };
  }

  // ---------------------------------------------------------------- CSV downloads (main.py _csv)
  function csv(R, sids, q) {
    const cell = (x) => { const s = x === null || x === undefined ? '' : String(x); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = [['series_id', 'label', 'period', 'value', 'unit', 'status', 'partial_through', 'vintage', 'measure', 'source_publisher', 'source_title', 'source_url', 'retrieved_at']];
    for (const sid of sids) {
      const b = R['/api/series/' + sid];
      if (!b) return null;
      const m = b.meta, src = R['/api/sources/' + m.source_id] || {};
      for (const o of b.observations) {
        if ((q.get('start') && o.period < q.get('start')) || (q.get('end') && o.period > q.get('end'))) continue;
        rows.push([sid, m.label, o.period, o.value, m.unit, o.status, o.partial_through || '', o.vintage, m.measure, src.publisher || '', src.title || '', src.url || '', m.retrieved_at]);
      }
    }
    return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
  }

  const PRIVATE = /^\/api\/(admin|owner|decisions|pipeline|handbook|refresh|consistency|source-audit)(\/|$)|\/(research|source|evidence)$|\/revisions(\/|$)/;

  async function answer(url, method) {
    if (method !== 'GET' && method !== 'HEAD') return json({ detail: 'This is a read-only copy; nothing can be changed here.' }, 403);
    const path = decodeURIComponent(url.pathname), q = url.searchParams;
    if (PRIVATE.test(path)) return absent(path, 'Not part of the read-only copy.');
    const R = await DATA;
    if (path === '/api/web') return json(webGraph(R, q));          // the stored graph is the whole Web (tier 3); filter as the server does
    if (path === '/api/search') return json(search(R.__search__, q));
    if (path === '/api/compare-series') { const O = await overlays(); const k = keyOf(path, q); return O[k] ? json(clone(O[k])) : absent(k); }
    if (path === '/api/changes') {
      const d = R['/api/changes'], since = q.get('since') || new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10), c = q.get('country');
      const items = d.items.filter((i) => i.date >= since && (!c || !i.country || i.country === c));
      const counts = {}; items.forEach((i) => { counts[i.kind] = (counts[i.kind] || 0) + 1; });
      return json({ since, items: clone(items), counts });
    }
    const one = /^\/api\/series\/([^/]+)\/export\.csv$/.exec(path);
    if (one || path === '/api/export.csv') {
      const sids = one ? [one[1]] : (q.get('ids') || '').split(',').filter(Boolean).slice(0, 12);
      const body = csv(R, sids, q);
      return body === null ? absent(path, 'This series is not included in the read-only copy.') : text(body, 'text/csv; charset=utf-8');
    }
    const k = keyOf(path, q);
    const v = k in R ? R[k] : path in R && ![...q.keys()].some((x) => x !== 'limit') ? R[path] : undefined;
    if (v === undefined) return absent(k, path.startsWith('/api/series/') ? 'This series is not included in the read-only copy.' : undefined);
    if (v && typeof v === 'object' && typeof v.__text__ === 'string') return text(v.__text__, v.__type__ || 'text/plain');
    return json(clone(v));
  }

  window.fetch = (input, init) => {
    const u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), location.href);
    if (u.origin === location.origin && u.pathname.startsWith('/api/')) {
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return answer(u, method);
    }
    return realFetch(input, init);
  };

  // downloads (CSV, article exports) and figures address /api/... directly: answer them from the snapshot too
  document.addEventListener('click', async (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const u = new URL(a.getAttribute('href'), location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return;
    e.preventDefault(); e.stopPropagation();
    const r = await answer(u, 'GET');
    if (!r.ok) return;
    const blob = await r.blob(), link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = u.pathname.endsWith('.csv') ? (u.searchParams.get('name') || u.pathname.split('/').slice(-2, -1)[0] || 'chart-data') + '.csv'
      : u.pathname.split('/').slice(-3).join('-');
    if (/\.html$/.test(u.pathname) && !a.hasAttribute('download')) { link.removeAttribute('download'); link.target = '_blank'; }
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  }, true);
  const fixImages = async () => {
    const imgs = document.querySelectorAll('img[src^="/api/"]');
    if (!imgs.length) return;
    const R = await DATA;
    imgs.forEach((img) => {
      const v = R[decodeURIComponent(new URL(img.getAttribute('src'), location.href).pathname)];
      img.src = v && v.__text__ ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(v.__text__) : '';
    });
  };
  new MutationObserver(fixImages).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
})();
