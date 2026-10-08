/* Game asset explorer — client
 *
 * No framework, no build step. That is a deliberate constraint, not laziness:
 * the whole point of this project is that it deploys to a free static host for
 * $0, so every byte of toolchain is cost with nothing to show for it.
 *
 * Data flow:
 *   manifest.json        which categories exist, how many, where the Drive is
 *   catalog.json.gz      one compact row per resource — the search corpus
 *   index/<cat>.json.gz  full rows for one category — anims / fields / path
 *
 * The catalog is separate from the full records on purpose. Searching needs
 * only id + name + a short description; loading every animation frame list up
 * front would cost tens of megabytes before the user types anything.
 */
'use strict';

const DATA = 'data/';
// The extractor writes media under out/media/ and records paths relative to that
// root, so an index field 'icon/mob/1.png' resolves to data/media/icon/mob/1.png.
const MEDIA = 'data/media/';

const state = {
  manifest: null,
  catalog: [],      // { c, i, n, d, h, a }
  haystack: null,   // parallel lowercase strings, built once after load
  cat: 'all',
  q: '',
  shown: 0,
  hits: [],
  PAGE: 120,
  detailCache: new Map(),
  detailOrder: [],
  DETAIL_MAX: 3,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ utils */

/* Fetch and inflate .json.gz. Static hosts serve .gz as octet-stream, so the
   browser has to inflate it itself — DecompressionStream does that natively. */
async function fetchGz(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status + ' ' + url);
  if (typeof DecompressionStream === 'undefined') return res.json();
  const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

const PLACEHOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="#3d4a63" stroke-width="1.6">' +
  '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function debounce(fn, ms) {
  let t;
  return function () {
    const a = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(self, a); }, ms);
  };
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  bindUi();
  try {
    state.manifest = await (await fetch(DATA + 'manifest.json')).json();
  } catch (e) {
    $('status').innerHTML =
      '⚠ 讀取索引失敗：' + esc(e.message) +
      '<br>請確認已執行擷取，並將 <code>out/</code> 部署為 <code>data/</code>。';
    return;
  }

  const total = Object.values(state.manifest.counts || {}).reduce((a, b) => a + b, 0);
  $('brandSub').textContent =
    total.toLocaleString() + ' 項資源 · ' + state.manifest.categories.length + ' 個分類';

  $('status').textContent = '載入搜尋索引…';

  try {
    const cat = await fetchGz(DATA + 'catalog.json.gz');
    /* Rows are positional tuples [cat, id, name, desc, icon, animCount].
       Six key names repeated across ~100k rows is several megabytes of text,
       and gzip removes it either way — so the key names buy nothing. */
    const rows = cat.rows || cat;
    const N = rows.length;
    state.catalog = new Array(N);
    state.haystack = new Array(N);
    for (let i = 0; i < N; i++) {
      const r = rows[i];
      const o = { c: r[0], i: r[1], n: r[2], d: r[3], h: r[4], a: r[5] };
      state.catalog[i] = o;
      state.haystack[i] = (o.i + ' ' + o.n + ' ' + (o.d || '')).toLowerCase();
    }
  } catch (e) {
    $('status').innerHTML = '⚠ 載入 catalog 失敗：' + esc(e.message);
    return;
  }

  renderCats();
  runSearch();
  $('status').hidden = true;
}

/* ------------------------------------------------------------- categories */

function renderCats() {
  const counts = state.manifest.counts || {};
  const parts = ['<button class="chip" data-c="all" aria-pressed="' + (state.cat === 'all') + '">全部' +
    '<span class="n">' + state.catalog.length.toLocaleString() + '</span></button>'];

  for (const c of state.manifest.categories) {
    const n = counts[c.key] || 0;
    if (!n) continue;
    parts.push('<button class="chip" data-c="' + esc(c.key) + '" aria-pressed="' +
      (state.cat === c.key) + '">' + esc(c.label) +
      '<span class="n">' + n.toLocaleString() + '</span></button>');
  }
  $('cats').innerHTML = parts.join('');
}

/* ----------------------------------------------------------------- search */

/* Cheapest match wins: exact id, then exact name, then name prefix, then name
   substring, then anything appearing only in the description. Ties keep
   catalog order so results do not shuffle between keystrokes. */
function runSearch() {
  const q = state.q.trim().toLowerCase();
  const cat = state.cat;
  const rows = state.catalog, hay = state.haystack;
  const out = [];

  if (!q) {
    for (let i = 0; i < rows.length; i++) {
      if (cat === 'all' || rows[i].c === cat) out.push(i);
    }
    state.hits = out;
    paint();
    return;
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (cat !== 'all' && r.c !== cat) continue;

    let score = 0;
    const id = String(r.i).toLowerCase();
    const name = r.n ? String(r.n).toLowerCase() : '';
    if (id === q) score = 1000;
    else if (name === q) score = 900;
    else if (id.startsWith(q)) score = 700;
    else if (name.startsWith(q)) score = 600;
    else if (name.includes(q)) score = 400;
    else if (hay[i].includes(q)) score = 120;

    if (score) out.push([i, score]);
  }

  out.sort((a, b) => b[1] - a[1]);
  state.hits = out.map(function (x) { return x[0]; });
  paint();
}

/* ------------------------------------------------------------------ render */

function paint() {
  const hits = state.hits;
  state.shown = 0;
  $('results').innerHTML = '';
  $('empty').hidden = hits.length > 0;
  if (!hits.length) {
    $('more').hidden = true;
    if (state.catalog.length) $('status').hidden = true;
    return;
  }
  appendPage();
}

function appendPage() {
  const hits = state.hits;
  const frag = document.createDocumentFragment();
  const end = Math.min(state.shown + state.PAGE, hits.length);

  for (let k = state.shown; k < end; k++) {
    const r = state.catalog[hits[k]];
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'listitem');
    card.tabIndex = 0;

    const icon = r.h
      ? '<img src="' + MEDIA + r.h + '" alt="" loading="lazy" decoding="async" width="68" height="68">'
      : '<span class="ph">' + PLACEHOLDER + '</span>';

    card.innerHTML =
      (r.a ? '<span class="badge anim">' + r.a + ' 動畫</span>' : '') +
      '<div class="thumb">' + icon + '</div>' +
      '<div class="cname">' + esc(r.n || '（無名稱）') + '</div>' +
      '<div class="cid">' + esc(r.i) + '</div>';

    card.addEventListener('click', function () { openDetail(r.c, r.i); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.c, r.i); }
    });
    frag.appendChild(card);
  }

  $('results').appendChild(frag);
  state.shown = end;
  $('more').hidden = state.shown >= hits.length;

  const label = state.q
    ? '找到 <b>' + hits.length.toLocaleString() + '</b> 筆符合「' + esc(state.q) + '」的資源'
    : '共 <b>' + hits.length.toLocaleString() + '</b> 項資源';
  $('status').hidden = false;
  $('status').innerHTML = label +
    (state.shown < hits.length ? '，已顯示 ' + state.shown.toLocaleString() + ' 筆' : '');
}

/* ------------------------------------------------------------------ detail */

/* data/index/<cat>.json.gz is NEWLINE-delimited JSON written by the extractor -
   one entity per line, not a JSON document. JSON.parse() over the whole text
   throws, which is why every detail panel reported a load error. */
function parseNdjson(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ }
  }
  return rows;
}

/* The shard carries the C# Entity record verbatim (Id, Name, Icon,
   Anims[{Name, Frames}]). The rest of this file speaks the compact shape the
   catalog uses, so translate once here rather than at every call site. */
function toDetail(r) {
  const anims = (r.Anims || []).map(function (a) {
    return { n: a.Name || '', f: a.Frames || [] };
  });
  return {
    i: r.Id,
    c: r.Category,
    n: r.Name || '',
    d: r.Desc || '',
    h: r.Icon || '',
    f: r.Fields || {},
    a_: anims
  };
}

async function categoryRecords(cat) {
  if (state.detailCache.has(cat)) {
    const i = state.detailOrder.indexOf(cat);
    if (i >= 0) state.detailOrder.splice(i, 1);
    state.detailOrder.push(cat);
    return state.detailCache.get(cat);
  }

  const res = await fetch(DATA + 'index/' + cat + '.json.gz');
  if (!res.ok) throw new Error(res.status + ' index/' + cat);
  const text = typeof DecompressionStream === 'undefined'
    ? await res.text()
    : await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();

  const map = new Map();
  for (const raw of parseNdjson(text)) map.set(raw.Id, toDetail(raw));

  state.detailCache.set(cat, map);
  state.detailOrder.push(cat);
  while (state.detailOrder.length > state.DETAIL_MAX) state.detailCache.delete(state.detailOrder.shift());
  return map;
}

const player = {
  frames: [], idx: 0, playing: true, raf: 0, last: 0,
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; this.frames = []; this.idx = 0; },
  load(frames, done) {
    this.stop();
    let left = frames.length;
    this.frames = new Array(frames.length);
    const self = this;
    frames.forEach(function (f, i) {
      const im = new Image();
      im.onload = im.onerror = function () { if (--left === 0) done(); };
      im.src = MEDIA + f;
      self.frames[i] = im;
    });
  },
  start(fps, loop, draw) {
    this.playing = true;
    $('dPlay').textContent = '⏸';
    this.last = 0;
    const self = this;
    this.raf = requestAnimationFrame(function (t) { self.tick(t, fps, loop, draw); });
  },
  tick(t, fps, loop, draw) {
    const interval = 1000 / fps;
    if (!this.last) this.last = t;
    else if (t - this.last >= interval) {
      this.last = t;
      this.idx = loop
        ? (this.idx + 1) % this.frames.length
        : Math.min(this.idx + 1, this.frames.length - 1);
      draw(this.frames[this.idx]);
    }
    if (this.playing) {
      const self = this;
      this.raf = requestAnimationFrame(function (tt) { self.tick(tt, fps, loop, draw); });
    }
  },
};

function drawFrame(im) {
  const cv = $('dCanvas'), ctx = cv.getContext('2d');
  if (!im || !im.naturalWidth) return;
  const s = Math.min(cv.width / im.naturalWidth, cv.height / im.naturalHeight, 3);
  const w = im.naturalWidth * s, h = im.naturalHeight * s;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(im, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}

let currentAnims = [];

function selectSeq(i) {
  const a = currentAnims[i];
  if (!a || !a.f || a.f.length < 2) return;
  const fps = Math.max(1, Math.min(60, +$('dFps').value || 12));
  player.load(a.f, function () {
    player.idx = 0;
    drawFrame(player.frames[0]);
    player.start(fps, $('dLoop').checked, drawFrame);
  });
}

async function openDetail(cat, id) {
  $('scrim').hidden = false;
  $('detail').hidden = false;
  document.body.style.overflow = 'hidden';

  $('dName').textContent = '載入中…';
  $('dIcon').innerHTML = '';
  ['dDescSec', 'dFieldsSec', 'dAnimsSec', 'dAnim'].forEach(function (s) { $(s).hidden = true; });

  let r;
  try {
    r = (await categoryRecords(cat)).get(id);
  } catch (e) {
    $('dName').textContent = '載入失敗：' + e.message;
    return;
  }
  if (!r) { $('dName').textContent = '找不到資料'; return; }

  const meta = state.manifest.categories.find(function (c) { return c.key === cat; }) || { label: cat };
  $('dCat').textContent = meta.label;
  $('dName').textContent = r.n || '（無名稱）';
  $('dId').textContent = 'ID ' + r.i;
  $('dIcon').innerHTML = r.h
    ? '<img src="' + MEDIA + r.h + '" alt="" width="76" height="76">'
    : '<span class="ph" style="width:40px;height:40px">' + PLACEHOLDER + '</span>';

  if (r.d) { $('dDesc').textContent = r.d; $('dDescSec').hidden = false; }

  const keys = Object.keys(r.f || {});
  if (keys.length) {
    $('dFields').innerHTML = keys
      .map(function (k) { return '<dt>' + esc(k) + '</dt><dd>' + esc(r.f[k]) + '</dd>'; }).join('');
    $('dFieldsSec').hidden = false;
  }

  currentAnims = r.a_ || [];
  if (currentAnims.length) {
    $('dAnim').hidden = false;
    $('dAnimCount').textContent = '(' + currentAnims.length + ')';
    $('dSeq').innerHTML = currentAnims
      .map(function (a, i) {
        return '<option value="' + i + '">' + esc(a.n || 'seq ' + i) + ' · ' + a.f.length + '格</option>';
      }).join('');
    $('dAnimList').innerHTML = currentAnims
      .map(function (a, i) {
        return '<button data-i="' + i + '" aria-pressed="' + (i === 0) + '">' + esc(a.n || i) + '</button>';
      }).join('');
    $('dAnimList').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        $('dAnimList').querySelectorAll('button')
          .forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        $('dSeq').value = b.dataset.i;
        selectSeq(+b.dataset.i);
      });
    });
    selectSeq(0);
  }

  // No source path is published at all, so this section stays hidden.
  $('dPath').textContent = '';
  $('dPath').parentNode.hidden = true;
  const link = driveLinkFor(cat);
  const dl = $('dDrive');
  dl.style.display = link ? '' : 'none';
  if (link) dl.href = link;
  $('dDriveHint').textContent = state.manifest.driveNote || '';

  $('detail').scrollTop = 0;
}

function driveLinkFor(cat) {
  const d = state.manifest.drive || {};
  return (d.perCategory && d.perCategory[cat]) || d.folder || '';
}

function closeDetail() {
  player.stop();
  currentAnims = [];
  $('detail').hidden = true;
  $('scrim').hidden = true;
  document.body.style.overflow = '';
}

/* ---------------------------------------------------------------------- ui */

function bindUi() {
  $('q').addEventListener('input', debounce(function (e) {
    $('qClear').hidden = !e.target.value;
    state.q = e.target.value;
    runSearch();
  }, 110));

  $('qClear').addEventListener('click', function () {
    $('q').value = ''; $('qClear').hidden = true;
    state.q = ''; runSearch(); $('q').focus();
  });

  $('cats').addEventListener('click', function (e) {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.cat = b.dataset.c;
    $('cats').querySelectorAll('.chip').forEach(function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.c === state.cat));
    });
    runSearch();
  });

  $('more').addEventListener('click', appendPage);

  $('dClose').addEventListener('click', closeDetail);
  $('scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  $('dSeq').addEventListener('change', function (e) {
    const i = +e.target.value;
    $('dAnimList').querySelectorAll('button').forEach(function (b, bi) {
      b.setAttribute('aria-pressed', String(bi === i));
    });
    selectSeq(i);
  });

  $('dPlay').addEventListener('click', function () {
    player.playing = !player.playing;
    $('dPlay').textContent = player.playing ? '⏸' : '▶';
    if (player.playing) player.start(+$('dFps').value || 12, $('dLoop').checked, drawFrame);
  });

  $('dFps').addEventListener('change', function () { selectSeq(+$('dSeq').value || 0); });
  $('dLoop').addEventListener('change', function () { selectSeq(+$('dSeq').value || 0); });

  $('aboutBtn').addEventListener('click', function () { $('about').hidden = false; });
  $('aboutClose').addEventListener('click', function () { $('about').hidden = true; });
  $('about').addEventListener('click', function (e) {
    if (e.target === $('about')) $('about').hidden = true;
  });
}

boot();