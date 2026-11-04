/* Stock Scope — personal stock dashboard.
   All data is static JSON built every morning by GitHub Actions (see scripts/). */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = u => /^https:\/\//i.test(String(u || '')) ? String(u) : '#';
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const kana = s => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
const keyOf = (m, s) => m + ':' + s;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

/* ---------- local state (this device only) ---------- */
const STORE = 'stockscope2';
let S = { watch: [], hold: {}, topics: [], owner: '', repo: '', theme: 'auto' };
try { S = { ...S, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (e) {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {} };
const applyTheme = () => { if (S.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = S.theme; };
applyTheme();

/* ---------- data ---------- */
const D = { index: null, research: null, master: null, masterP: null, files: new Map() };
const getJSON = (path, fresh) => fetch('./data/' + path + (fresh ? '?t=' + Date.now() : ''), { cache: fresh ? 'no-store' : 'no-cache' })
  .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
const entry = k => D.index?.stocks.find(e => keyOf(e.market, e.symbol) === k);
const tracked = k => entry(k)?.kind === 'tracked';
function loadMaster() {
  if (D.master || D.masterP) return D.masterP;
  D.masterP = getJSON('symbols-master.json').then(doc => {
    D.master = (doc.items || []).map(x => SearchEngine.prepare({ symbol: x[0], market: x[1], name: x[2], segment: x[3] || '', sector: x[4] || '', en: x[5] || '' }));
    if ($('#q').value.trim()) runSearch();
    if ($('#hs')?.value.trim()) $('#hs').dispatchEvent(new Event('input', { bubbles: true }));
  }).catch(() => { D.masterP = null; });
  return D.masterP;
}
function info(k) {
  const [market, symbol] = k.split(':');
  const e = entry(k), m = D.master?.find(x => x.market === market && x.symbol === symbol);
  const w = S.watch.find(x => x.key === k);
  return { key: k, market, symbol, name: e?.name || m?.name || w?.name || symbol, segment: m?.segment || '', sector: m?.sector || '' };
}
async function rowsOf(k) {
  const e = entry(k); if (!e) return null;
  if (!D.files.has(e.file)) D.files.set(e.file, getJSON(e.file).then(doc => doc.rows.map(r => ({ date: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))).catch(() => null));
  return D.files.get(e.file);
}

/* ---------- formatting ---------- */
const unit = m => m === 'US' ? 'ドル' : m === 'INDEX' ? '' : '円';
function fmt(v, m) {
  if (!Number.isFinite(v)) return '—';
  const d = m === 'US' ? 2 : v >= 1000 ? 0 : 1;
  return v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const pct = v => Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1) + '%' : '—';
const dir = v => !Number.isFinite(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down';
const mkt = m => m === 'JP' ? '日本株' : m === 'US' ? '米国株' : '指数';
function dateJP(iso, withTime) {
  const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleString('ja-JP', withTime ? { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' } : { month: 'long', day: 'numeric', weekday: 'short' });
}

/* ---------- GitHub links ---------- */
function repo() {
  if (S.owner && S.repo) return { owner: S.owner, repo: S.repo };
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i); if (!m) return null;
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg && !seg.includes('.') ? seg : m[1] + '.github.io' };
}
/* GitHubへの自動登録：この端末にだけ保存したトークンで、アプリから直接ファイルを書き込む */
const ghToken = () => { try { return localStorage.getItem('stockscope2-ghtoken') || ''; } catch (e) { return ''; } };
const b64 = t => btoa(unescape(encodeURIComponent(t)));
function toast(msg) {
  let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 4200);
}
async function ghApi(path, opt = {}) {
  const r = repo(), tk = ghToken(); if (!r || !tk) throw new Error('GitHub連携が未設定です（設定タブ）');
  const res = await fetch('https://api.github.com/repos/' + encodeURIComponent(r.owner) + '/' + encodeURIComponent(r.repo) + path, {
    ...opt, headers: { Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (res.status === 404 && opt.allow404) return null;
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(res.status === 401 ? 'トークンが無効か期限切れです' : res.status === 403 || res.status === 404 ? 'このリポジトリへの書き込み権限がありません（トークンの設定を確認）' : (j.message || 'HTTP ' + res.status)); }
  return res.status === 204 ? {} : res.json();
}
async function ghPut(file, text, message) {
  const cur = await ghApi('/contents/' + file.split('/').map(encodeURIComponent).join('/') + '?ref=main', { allow404: true });
  return ghApi('/contents/' + file.split('/').map(encodeURIComponent).join('/'), { method: 'PUT', body: JSON.stringify({ message, content: b64(text), branch: 'main', ...(cur?.sha ? { sha: cur.sha } : {}) }) });
}
async function ghDelete(file, message) {
  const p = '/contents/' + file.split('/').map(encodeURIComponent).join('/');
  const cur = await ghApi(p + '?ref=main', { allow404: true }); if (!cur?.sha) return;
  return ghApi(p, { method: 'DELETE', body: JSON.stringify({ message, sha: cur.sha, branch: 'main' }) });
}
async function ghDo(job, doneMsg) {
  try { await job(); toast(doneMsg + ' 数分後に反映されます。'); return true; }
  catch (e) { toast('GitHubに登録できませんでした：' + e.message); return false; }
}
const holdingsText = () => Object.entries(S.hold).map(([k, h]) => k.split(':')[1] + ' ' + (h.name || info(k).name)).join('\n') + '\n';
let holdSyncTimer;
function autoSyncHoldings() {
  if (!ghToken()) return;
  clearTimeout(holdSyncTimer);
  holdSyncTimer = setTimeout(() => ghDo(() => ghPut('holdings/latest.txt', holdingsText(), '保有株リストを更新（アプリから自動）'), '保有株を自動分析に送りました。'), 1500);
}
function ghUrl(kind, dir, file, value) {
  const r = repo(); if (!r) return '';
  const base = 'https://github.com/' + encodeURIComponent(r.owner) + '/' + encodeURIComponent(r.repo);
  return kind === 'new' ? base + '/new/main/' + dir + '?filename=' + encodeURIComponent(file) + '&value=' + encodeURIComponent(value || '')
    : base + '/delete/main/' + dir + '/' + encodeURIComponent(file);
}
function addLink(st, label) {
  if (ghToken()) return '<button class="btn primary" data-ghadd="' + esc(keyOf(st.market, st.symbol)) + '" data-name="' + esc(st.name) + '">' + (label || '毎朝の自動更新に追加') + '</button>';
  const url = ghUrl('new', 'watchlist', st.symbol + '.txt', st.name); if (!url) return '';
  return '<a class="btn primary" href="' + esc(url) + '" target="_blank" rel="noopener">' + (label || '毎朝の自動更新に追加') + '</a>';
}
const topicFile = n => n.replace(/[\\/:*?"<>|#%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const yahooLink = st => '<a class="btn" href="https://finance.yahoo.co.jp/quote/' + encodeURIComponent(st.market === 'JP' ? st.symbol + '.T' : st.market === 'INDEX' ? '998407.O' : st.symbol) + '" target="_blank" rel="noopener">Yahoo!ファイナンスで見る</a>';

/* ---------- small charts ---------- */
function spark(closes) {
  if (!closes || closes.length < 2) return '<svg class="spark" viewBox="0 0 64 28"></svg>';
  const lo = Math.min(...closes), hi = Math.max(...closes), x = i => i * 64 / (closes.length - 1), y = v => 25 - (v - lo) / (hi - lo || 1) * 22;
  const c = closes.at(-1) >= closes[0] ? 'var(--up)' : 'var(--down)';
  return '<svg class="spark" viewBox="0 0 64 28" aria-hidden="true"><path d="' + closes.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('') + '" stroke="' + c + '" stroke-width="1.6"/></svg>';
}
function maSeries(all, n, from) { return all.slice(from).map((_, i) => { const j = from + i; return j >= n - 1 ? mean(all.slice(j - n + 1, j + 1).map(r => r.close)) : NaN; }); }
function miniCandles(rows) {
  if (!rows || rows.length < 21) return '<p class="empty">チャートデータを読み込めませんでした。</p>';
  const from = Math.max(0, rows.length - 60), view = rows.slice(from), ma = maSeries(rows, 25, from);
  const W = 320, H = 110, ok = view.every(r => r.open && r.high && r.low);
  const lo = Math.min(...view.map(r => ok ? r.low : r.close), ...ma.filter(Number.isFinite)), hi = Math.max(...view.map(r => ok ? r.high : r.close), ...ma.filter(Number.isFinite));
  const x = i => 3 + i * (W - 6) / (view.length - 1), y = v => 6 + (hi - v) / (hi - lo || 1) * (H - 12), bw = Math.max(1.4, (W - 6) / view.length * .62);
  let g = '';
  view.forEach((r, i) => {
    const c = r.close >= (ok ? r.open : view[i - 1]?.close ?? r.close) ? 'var(--up)' : 'var(--down)';
    if (ok) { const t = y(Math.max(r.open, r.close)), b = y(Math.min(r.open, r.close)); g += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + y(r.high).toFixed(1) + '" y2="' + y(r.low).toFixed(1) + '" stroke="' + c + '" stroke-width=".9"/><rect x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + t.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(.9, b - t).toFixed(1) + '" fill="' + c + '" stroke="none"/>'; }
  });
  if (!ok) g = '<path d="' + view.map((r, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(r.close).toFixed(1)).join('') + '" stroke="var(--ink)" stroke-width="1.5"/>';
  const mp = ma.map((v, i) => Number.isFinite(v) ? (i && Number.isFinite(ma[i - 1]) ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1) : '').join('');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="直近60営業日のローソク足" style="width:100%;height:auto;margin:10px 0 4px">' + g + '<path d="' + mp + '" stroke="var(--ma1)" stroke-width="1.3"/></svg>';
}

/* ---------- shared bits ---------- */
const TONE = { positive: ['好材料が中心', 'pos'], negative: ['悪材料が中心', 'neg'], mixed: ['強弱まちまち', 'mix'] };
function tone(t) { if (typeof t === 'number') t = t > 0 ? 'positive' : t < 0 ? 'negative' : 'mixed'; const v = TONE[t] || TONE.mixed; return '<span class="tone ' + v[1] + '">' + v[0] + '</span>'; }
const chips = (a, k) => (a || []).map(x => '<span class="chip ' + k + '">' + esc(x) + '</span>').join('');
function sources(list) {
  if (!list?.length) return '';
  return '<details class="src"><summary>出典 ' + list.length + '件</summary><ol>' + list.map(s => '<li><a href="' + esc(safeUrl(s.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title || s.url) + '</a><small>' + esc([s.publisher, s.date].filter(Boolean).join('　')) + '</small></li>').join('') + '</ol></details>';
}
function outlooks(list) {
  if (!list?.length) return '';
  return '<h3>見通し</h3>' + list.map(o => '<div class="quote"><b>' + esc(o.who) + '</b>　' + esc(o.view) + ' <a href="' + esc(safeUrl(o.source?.url)) + '" target="_blank" rel="noopener noreferrer">（' + esc(o.source?.publisher || '出典') + '）</a></div>').join('');
}
function row(k, extra) {
  const e = entry(k), st = info(k), t = e?.tech;
  return '<li><button class="row" data-open="' + esc(k) + '"><span class="nm"><b>' + esc(st.name) + '</b><small>' + esc(st.symbol) + '　' + mkt(st.market) + (extra || '') + '</small></span>' + spark(e?.spark) +
    '<span class="px num">' + (t ? fmt(t.close, st.market) + '<small class="' + dir(t.chg1d) + '">' + pct(t.chg1d) + '</small>' : '<small class="flat">データなし</small>') + '</span></button></li>';
}

/* ---------- 注目 ---------- */
function renderToday() {
  const r = D.research, ok = r?.status === 'ok';
  const when = r?.generatedAt || D.index?.generatedAt;
  let h = '<div class="lead"><div class="date">' + (when ? esc(dateJP(when)) : '') + '</div><h1>' + (ok ? '今朝のマーケット' : '今日の値動き') + '</h1></div>';
  if (!ok) h += '<div class="notice"><b>ニュースのAIまとめはまだありません</b>' + esc(r?.notice || 'GitHubにClaudeのAPIキーを登録すると、毎朝ここに相場のまとめと注目銘柄が表示されます。') + ' 手順は「設定」タブにあります。</div>';
  else if (r.notice) h += '<p class="hint">' + esc(r.notice) + '</p>';
  if (ok) for (const [code, label] of [['jp', '日本株'], ['us', '米国株']]) {
    const m = r.market?.[code]; if (!m) continue;
    h += '<article class="group"><span class="mkt-flag">' + label + '　<span class="ai-mark">AIまとめ</span></span><h2 class="mkt-title">' + esc(m.title) + '</h2><p>' + esc(m.summary) + '</p>' +
      (m.points?.length ? '<ul class="mkt-points">' + m.points.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' : '') + outlooks(m.outlooks) +
      (m.risks?.length ? '<h3>気をつけたい点</h3><div class="chips">' + chips(m.risks, 'bad') + '</div>' : '') + sources(m.sources) + '</article>';
  }
  if (ok && r.featured?.length) {
    h += '<div class="section-head"><h2>注目チャート</h2><p>ニュースで材料が出た銘柄</p></div><div class="rail">' + r.featured.map(f => {
      const k = keyOf(f.market, f.symbol), t = entry(k)?.tech;
      return '<article class="feat"><div class="feat-head"><button class="feat-name" data-open="' + esc(k) + '">' + esc(f.name) + '<span class="code">' + esc(f.symbol) + '</span></button>' + tone(f.tone) + '</div>' +
        (f.theme ? '<p class="theme">' + esc(f.theme) + '</p>' : '') + '<div data-mini="' + esc(k) + '"></div>' +
        (t ? '<div class="figs num"><span><b>' + fmt(t.close, f.market) + '</b> ' + unit(f.market) + '</span><span class="' + dir(t.chg1d) + '">前日 ' + pct(t.chg1d) + '</span><span class="' + dir(t.chg20d) + '">20日 ' + pct(t.chg20d) + '</span></div>' : '') +
        '<details class="explain grow"><summary>解説を読む</summary><p>' + esc(f.reason) + '</p><div class="chips">' + chips(f.catalysts, 'good') + chips(f.risks, 'bad') + '</div>' + sources(f.sources) + '</details>' +
        '<div class="btns"><button class="btn" data-open="' + esc(k) + '">チャートを詳しく見る</button></div></article>';
    }).join('') + '</div>';
  }
  const movers = (D.index?.stocks || []).filter(e => e.kind === 'tracked' && e.market !== 'INDEX' && Number.isFinite(e.tech?.chg5d))
    .sort((a, b) => Math.abs(b.tech.chg5d) - Math.abs(a.tech.chg5d)).slice(0, 6);
  if (movers.length) h += '<div class="section-head"><h2>大きく動いた銘柄</h2><p>自動更新リスト・5営業日</p></div><div class="group flush"><ul class="list">' +
    movers.map(e => row(keyOf(e.market, e.symbol), '　<span class="' + dir(e.tech.chg5d) + '">5日 ' + pct(e.tech.chg5d) + '</span>')).join('') + '</ul></div>';
  const briefs = ok ? Object.entries(r.briefs || {}).filter(([, b]) => b.status === 'ok').sort((a, b) => Math.abs(b[1].tone) - Math.abs(a[1].tone)) : [];
  if (briefs.length) h += '<div class="section-head"><h2>銘柄ニュース</h2><p>直近10日の記事を要約</p></div>' + briefs.map(([k, b]) => {
    const st = info(k);
    return '<article class="group"><div class="feat-head"><button class="feat-name" data-open="' + esc(k) + '">' + esc(st.name) + '<span class="code">' + esc(st.symbol) + '</span></button>' + tone(b.tone) + '</div><p>' + esc(b.summary) + '</p><div class="chips">' + chips(b.good, 'good') + chips(b.bad, 'bad') + '</div>' + outlooks(b.outlooks) + sources(b.sources) + '</article>';
  }).join('');
  if (ok) h += '<p class="foot">AIまとめは日経・ロイター・株探・証券会社・取引所などの記事だけを根拠に作り、出典のない内容は表示していません。要約の誤りもありうるため、判断の前に出典を確認してください。売買の推奨ではありません。</p>';
  $('#today').innerHTML = h;
  document.querySelectorAll('[data-mini]').forEach(async el => { el.innerHTML = miniCandles(await rowsOf(el.dataset.mini)); });
}

/* ---------- 探す ---------- */
function fallbackPool() {
  if (!D._fb) D._fb = (D.index?.stocks || []).map(e => SearchEngine.prepare({ symbol: e.symbol, market: e.market, name: e.name, segment: '', sector: '' }));
  return D._fb;
}
function runSearch() {
  const raw = $('#q').value.trim(), box = $('#results');
  if (!raw) { box.innerHTML = ''; return; }
  const list = SearchEngine.query(raw, D.master || fallbackPool(), 30);
  if (!list.length) { box.innerHTML = '<li class="results-empty">「' + esc(raw) + '」に当てはまる銘柄はありません。' + (D.master ? '会社名の一部（ひらがな・カタカナ・漢字・ローマ字どれでも）、4桁のコード、ティッカーで試してください。' : '銘柄一覧を読み込み中です。') + '</li>'; return; }
  box.innerHTML = list.map(x => {
    const k = keyOf(x.market, x.symbol), e = entry(k);
    const tag = e?.kind === 'tracked' ? '<span class="badge live">毎朝更新</span>' : e ? '<span class="badge">注目</span>' : '';
    return '<li><button class="row" data-choose="' + esc(k) + '" data-name="' + esc(x.name) + '"><span class="nm"><b>' + esc(x.name) + tag + '</b><small>' + esc(x.symbol) + '　' + esc([mkt(x.market), x.segment, x.sector].filter(Boolean).join('／')) + '</small></span>' + spark(e?.spark) +
      '<span class="px num">' + (e?.tech ? fmt(e.tech.close, x.market) + '<small class="' + dir(e.tech.chg1d) + '">' + pct(e.tech.chg1d) + '</small>' : '') + '</span></button></li>';
  }).join('');
}

/* ---------- できごと（株式分割・配当・発表など） ---------- */
const EV_ICON = { 決算: '📊', 業績修正: '📈', 株式分割: '✂️', 配当: '💴', 自社株買い: '🔁', 'M&A・提携': '🤝', '新製品・事業': '🚀', 人事: '👤', '不祥事・訴訟': '⚠️', その他: '📰' };
function eventsOf(k) {
  const out = [], m = k.split(':')[0];
  for (const e of entry(k)?.events || []) {
    if (e.type === 'split') out.push({ date: e.date, type: '株式分割', text: '株式分割（' + e.ratio + '）を実施', fact: true });
    else if (e.type === 'dividend') out.push({ date: e.date, type: '配当', text: '配当の権利落ち（1株 ' + (m === 'US' ? e.amount + 'ドル' : e.amount + '円') + '）', fact: true });
  }
  for (const e of D.research?.briefs?.[k]?.events || []) out.push({ ...e, fact: false });
  const seen = new Set();
  return out.filter(e => { const key = e.date + e.type + (e.fact ? '' : e.text); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => b.date.localeCompare(a.date));
}
function eventRow(e, k) {
  const st = k ? info(k) : null;
  return '<li class="ev"><span class="ev-date num">' + esc(e.date.slice(5).replace('-', '/')) + '</span><span class="ev-body">' +
    (st ? '<button class="ev-name" data-open="' + esc(k) + '">' + esc(S.hold[k]?.name || st.name) + '</button>' : '') +
    '<span class="ev-type">' + (EV_ICON[e.type] || '📰') + ' ' + esc(e.type) + '</span>' + esc(e.text) +
    (e.source ? ' <a href="' + esc(safeUrl(e.source.url)) + '" target="_blank" rel="noopener noreferrer">（' + esc(e.source.publisher || '出典') + '）</a>' : e.fact ? ' <small>（Yahoo Finance）</small>' : '') +
    '</span></li>';
}

/* ---------- 保有株 ---------- */
const ACCOUNTS = ['NISA（成長投資枠）', 'NISA（つみたて投資枠）', '特定口座', '一般口座'];
const usdjpy = () => entry('INDEX:USDJPY')?.tech?.close;
const yen = v => (v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('ja-JP') + '円';
const signedYen = v => (v > 0 ? '+' : '') + yen(v);
let picked = null;
function holdRows() {
  const fx = usdjpy();
  return Object.entries(S.hold).map(([k, h]) => {
    const t = entry(k)?.tech, m = k.split(':')[0], rate = m === 'US' ? fx : 1;
    const price = t?.close, value = price && rate ? price * h.qty * rate : NaN, cost = rate ? h.cost * h.qty * rate : NaN;
    const day = t && Number.isFinite(t.chg1d) ? value - value / (1 + t.chg1d / 100) : NaN;
    return { k, h, m, t, value, cost, pl: value - cost, day };
  });
}
function renderHold() {
  const rows = holdRows(), ok = rows.filter(r => Number.isFinite(r.value));
  const total = ok.reduce((a, r) => a + r.value, 0), cost = ok.reduce((a, r) => a + r.cost, 0), day = ok.reduce((a, r) => a + (Number.isFinite(r.day) ? r.day : 0), 0);
  let h = '';
  if (rows.length) {
    h += '<article class="group hold-sum"><div class="d-meta">評価額の合計（円）</div><div class="board"><span class="price">' + Math.round(total).toLocaleString('ja-JP') + '</span><span class="unit">円</span></div>' +
      '<div class="figs num"><span>損益 <b class="' + dir(total - cost) + '">' + signedYen(total - cost) + '</b>（' + pct(cost ? (total / cost - 1) * 100 : NaN) + '）</span><span>前日比 <b class="' + dir(day) + '">' + signedYen(day) + '</b></span></div>' +
      '<p class="hint">' + (usdjpy() ? '米国株は 1ドル＝' + usdjpy().toFixed(2) + '円 で換算。' : '') + '直近の株価で計算（手数料・税金は含みません）。' + (ok.length < rows.length ? '価格データのない銘柄は合計に含めていません。' : '') + '</p></article>';
    h += '<div class="group flush"><ul class="list">' + rows.sort((a, b) => (b.value || 0) - (a.value || 0)).map(r => {
      const st = info(r.k), b = D.research?.briefs?.[r.k];
      return '<li><button class="row" data-open="' + esc(r.k) + '"><span class="nm"><b>' + esc(r.h.name || st.name) + '</b><small>' + esc(st.symbol) + '　' + r.h.qty.toLocaleString('ja-JP') + '株　' + esc(r.h.account || '') + (b?.status === 'ok' ? '　' + (b.tone > 0 ? '好材料' : b.tone < 0 ? '悪材料' : 'ニュースあり') : '') + '</small></span>' + spark(entry(r.k)?.spark) +
        '<span class="px num">' + (Number.isFinite(r.value) ? yen(r.value) + '<small class="' + dir(r.pl) + '">' + signedYen(r.pl) + '</small>' : '<small class="flat">価格データなし</small>') + '</span></button></li>';
    }).join('') + '</ul></div>';
    const since = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const evs = rows.flatMap(r => eventsOf(r.k).filter(e => e.date >= since).map(e => [e, r.k])).sort((a, b) => b[0].date.localeCompare(a[0].date)).slice(0, 25);
    h += '<div class="section-head"><h2>保有株のトピック</h2><p>直近45日のできごと</p></div>';
    h += evs.length ? '<div class="group"><ul class="evlist">' + evs.map(([e, k]) => eventRow(e, k)).join('') + '</ul></div>' +
      '<p class="hint">株式分割・配当はYahoo Financeの記録、それ以外は信頼できる媒体の記事見出しからAIがまとめた出来事です（出典つき）。</p>'
      : '<p class="empty">直近45日、保有株について記録されたできごとはありません。</p>';
    h += '<div class="section-head"><h2>保有株の分析</h2><p>毎朝自動で更新</p></div>' + rows.map(r => holdingCard(r)).join('');
    const notSent = rows.filter(r => !entry(r.k)?.holding);
    h = syncCard(rows, notSent) + h;
    const missing = [];
    if (missing.length) h += '<p class="hint">毎朝の自動更新に入っていない銘柄：' + missing.map(r => esc(r.h.name || r.k)).join('、') + '。銘柄を開いて「毎朝の自動更新に追加」を押すと、株価・ニュース・トピックが入ります。</p>';
  } else h += '<p class="empty">まだ登録がありません。下で銘柄を探して、株数と取得単価を入れてください。登録内容はこの端末だけに保存されます。</p>';
  h += '<div class="btns" style="margin-top:20px"><button class="btn primary" data-goto="search">＋ 銘柄を探して保有株に登録</button></div>';
  $('#hold').innerHTML = h;
  if (picked) drawHoldForm();
}
function trendText(t) {
  if (!t) return '';
  const parts = [];
  if (Number.isFinite(t.chg20d)) parts.push('20日で ' + pct(t.chg20d));
  if (Number.isFinite(t.vsMA25) && Number.isFinite(t.vsMA75)) parts.push(t.vsMA25 > 0 && t.vsMA75 > 0 ? '25日・75日平均より上（上向き）' : t.vsMA25 < 0 && t.vsMA75 < 0 ? '25日・75日平均より下（下向き）' : '平均線の近く（方向感なし）');
  if (Number.isFinite(t.rsi14)) parts.push('RSI ' + t.rsi14.toFixed(0) + (t.rsi14 >= 70 ? '（買われすぎ気味）' : t.rsi14 <= 30 ? '（売られすぎ気味）' : ''));
  return parts.join('、');
}
function holdingCard(r) {
  const k = r.k, st = info(k), a = D.research?.holdings?.[k], b = D.research?.briefs?.[k], t = entry(k)?.tech;
  const evs = eventsOf(k).slice(0, 3), stc = { bullish: ['強気寄り', 'pos'], bearish: ['弱気寄り', 'neg'], neutral: ['中立', 'mix'], mixed: ['強弱まちまち', 'mix'] }[a?.stance] || null;
  let h = '<article class="group hold-card"><div class="feat-head"><button class="feat-name" data-open="' + esc(k) + '">' + esc(r.h.name || st.name) + '<span class="code">' + esc(st.symbol) + '</span></button>' +
    (stc ? '<span class="tone ' + stc[1] + '">見通し：' + stc[0] + '</span>' : b?.status === 'ok' ? tone(b.tone) : '') + '</div>';
  if (a?.status === 'ok' || b?.status === 'ok') h += '<h3>現在の動向</h3><p>' + esc(a?.now || b.summary) + '</p>';
  if (t) h += '<p class="hint num">値動き：' + esc(trendText(t)) + '</p>';
  if (evs.length) h += '<h3>最近のトピック</h3><ul class="evlist">' + evs.map(e => eventRow(e)).join('') + '</ul>';
  if (a?.status === 'ok') {
    h += '<h3>今後の動向予想 <span class="ai-mark">AIまとめ</span></h3><p>' + esc(a.outlook) + '</p>' + (a.trend ? '<p class="hint">値動きから：' + esc(a.trend) + '</p>' : '') +
      outlooks(a.outlooks).replace('<h3>見通し</h3>', '') +
      (a.watch?.length ? '<div class="chips">' + chips(a.watch, '') + '</div>' : '') + (a.risks?.length ? '<div class="chips">' + chips(a.risks, 'bad') + '</div>' : '') + sources(a.sources);
  } else if (b?.status === 'ok' && b.outlooks?.length) h += '<h3>今後の動向予想</h3>' + outlooks(b.outlooks).replace('<h3>見通し</h3>', '');
  else if (!entry(k)?.holding && !entry(k)?.favorite) h += '<p class="hint">' + (r.fav ? '上の「気になる銘柄を自動分析に送る」' : '上の「保有株を自動分析に送る」') + 'で送ると、数分後から分析が入ります。</p>';
  else h += '<p class="hint">' + (a ? '信頼できる媒体で、今後の見通しに関する記事は見つかりませんでした。' : '次の自動更新で分析が入ります。') + '</p>';
  return h + '</article>';
}
const favText = () => S.watch.map(w => w.symbol + ' ' + (w.name || info(w.key).name)).join('\n') + '\n';
let favSyncTimer;
function autoSyncFavorites() {
  if (!ghToken()) return;
  clearTimeout(favSyncTimer);
  favSyncTimer = setTimeout(() => ghDo(() => ghPut('favorites/latest.txt', favText(), '気になる銘柄リストを更新（アプリから自動）'), '気になる銘柄を自動分析に送りました。'), 1500);
}
function favSyncCard() {
  const notSent = S.watch.filter(w => w.market !== 'INDEX' && !entry(w.key)?.favorite && !entry(w.key)?.holding);
  const removed = (D.index?.stocks || []).filter(e => e.favorite && !S.watch.some(w => w.key === keyOf(e.market, e.symbol)));
  if (!notSent.length && !removed.length) return '';
  if (ghToken()) return '<div class="notice"><b>気になる銘柄は自動で送られます</b>' + (notSent.length ? 'まだ反映されていない銘柄：' + notSent.map(w => esc(w.name)).join('、') + '。数分で反映されます。' : '') + '<div class="btns"><button class="btn" id="syncFav">今すぐ送り直す</button></div></div>';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14), url = ghUrl('new', 'favorites', stamp + '.txt', favText());
  return '<div class="notice"><b>気になる銘柄を自動分析に送る</b>' + (notSent.length ? '分析に入っていない銘柄：' + notSent.map(w => esc(w.name)).join('、') + '。' : '☆を外した銘柄があります。') +
    'ボタンでGitHubが開くので、緑の「Commit changes」を押してください（設定タブでGitHub連携をすると、これも自動になります）。' +
    (url ? '<div class="btns"><a class="btn primary" href="' + esc(url) + '" target="_blank" rel="noopener">気になる銘柄を自動分析に送る</a></div>' : '') + '</div>';
}
function syncCard(rows, notSent) {
  const list = rows.map(r => r.k.split(':')[1] + ' ' + (r.h.name || info(r.k).name)).join('\n');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const url = ghUrl('new', 'holdings', stamp + '.txt', list);
  if (!notSent.length && Object.keys(S.hold).length === (D.index?.stocks || []).filter(e => e.holding).length) return '';
  if (ghToken()) return '<div class="notice"><b>保有株は自動で送られます</b>' + (notSent.length ? '自動分析にまだ反映されていない保有株：' + notSent.map(r => esc(r.h.name || r.k)).join('、') + '。送ってから数分で反映されます。' : '') +
    '<div class="btns"><button class="btn" id="syncHold">今すぐ送り直す</button></div></div>';
  return '<div class="notice"><b>保有株を自動分析に送る</b>' + (notSent.length ? '自動分析に入っていない保有株：' + notSent.map(r => esc(r.h.name || r.k)).join('、') + '。' : '保有株の登録内容が、自動分析の対象と違っています。') +
    '下のボタンでGitHubが開くので、緑の「Commit changes」を押してください。数分後から毎朝、自動で分析されます。<br><small>送るのは銘柄コードと名前だけで、株数・取得単価は送りません。GitHubのリポジトリが公開設定の場合、銘柄名は誰でも見られる状態になります。</small>' +
    (url ? '<div class="btns"><a class="btn primary" href="' + esc(url) + '" target="_blank" rel="noopener">保有株を自動分析に送る</a></div>' : '') + '</div>';
}
function searchPool(raw, limit) { return raw ? SearchEngine.query(raw, D.master || fallbackPool(), limit) : []; }
function drawHoldForm() {
  const st = picked, m = st.market, h = S.hold[st.key] || {};
  $('#holdForm').innerHTML = '<article class="group" style="margin-top:12px"><h2>' + esc(st.name) + '<span class="code">' + esc(st.symbol) + '</span></h2>' +
    '<div class="field"><div><label for="nq">株数</label><input id="nq" class="input num" inputmode="decimal" value="' + esc(h.qty ?? '') + '"></div><div><label for="nc">取得単価（' + unit(m) + '）</label><input id="nc" class="input num" inputmode="decimal" value="' + esc(h.cost ?? '') + '"></div></div>' +
    '<label class="lbl" for="na">口座</label><select id="na" class="input">' + ACCOUNTS.map(a => '<option' + (a === h.account ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>' +
    '<div class="btns"><button class="btn primary" id="addHold">保有株に登録</button><button class="btn" id="cancelHold">やめる</button></div></article>';
}
function saveHolding(st, qty, cost, account) {
  if (!(qty > 0) || !(cost >= 0)) { alert('株数と取得単価を数字で入れてください。'); return false; }
  const isNew = !S.hold[st.key];
  S.hold[st.key] = { qty, cost, account, name: st.name, market: st.market, symbol: st.symbol }; save();
  if (isNew) autoSyncHoldings();
  return true;
}

/* ---------- 気になる ---------- */
const STANCE = { bullish: ['強気寄り', 'pos'], neutral: ['中立', 'mix'], bearish: ['弱気寄り', 'neg'], mixed: ['強弱まちまち', 'mix'] };
const stars = n => '<span class="stars" aria-label="5段階中' + n + '">' + '★'.repeat(n) + '<span>' + '★'.repeat(5 - n) + '</span></span>';
function topicCard(name, t) {
  const del = '<button class="btn small" data-deltopic="' + esc(name) + '">外す</button>';
  if (t?.status === 'pending' || (!t && ghToken())) {
    // すでに登録済み（サーバー側にある）→ ボタン不要。次の自動更新で分析される
    return '<article class="group topic"><div class="feat-head"><h2>' + esc(name) + '</h2>' + del + '</div><p class="hint">登録済みです。次の自動更新（毎朝7:23頃）で分析が入ります。</p></article>';
  }
  if (!t) {
    if (ghToken()) return '<article class="group topic"><div class="feat-head"><h2>' + esc(name) + '</h2>' + del + '</div><p class="hint">分析待ちです。登録は自動で済んでいるので、数分〜次の朝の自動更新で分析が入ります。</p></article>';
    const url = ghUrl('new', 'topics', topicFile(name) + '.txt', '');
    return '<article class="group topic"><div class="feat-head"><h2>' + esc(name) + '</h2>' + del + '</div><p class="hint">分析待ちです。下のボタンでGitHubを開き、緑の <b>Commit changes</b> を押すと、数分後にここに分析が出ます。</p>' + (url ? '<div class="btns"><a class="btn primary" href="' + esc(url) + '" target="_blank" rel="noopener">分析を始める（GitHub）</a></div>' : '') + '</article>';
  }
  if (t.status !== 'ok') return '<article class="group topic"><div class="feat-head"><h2>' + esc(name) + '</h2>' + del + '</div><p class="hint">信頼できる媒体で、この言葉についての情報が見つかりませんでした。書き方を変えると見つかることがあります（例：スペースX → SpaceX、宇宙関係 → 宇宙関連株）。</p></article>';
  const st = STANCE[t.stance] || STANCE.mixed, first = t.related?.[0];
  return '<article class="group topic"><div class="feat-head"><div><h2>' + esc(name) + '</h2><span class="d-meta">' + esc(t.kind || '') + '　' + esc(dateJP(t.analyzedAt, true)) + ' 分析</span></div>' + del + '</div>' +
    '<div class="rating"><div><span class="d-meta">おすすめ度（参考）</span>' + stars(t.rating || 3) + '</div><span class="tone ' + st[1] + '">見通し：' + st[0] + '</span></div>' +
    '<p class="hint">' + esc(t.ratingWhy || '') + '。売買の推奨ではなく、記事の論調と値動きから機械的に出した目安です。</p>' +
    (t.summary ? '<p class="mkt-title">' + esc(t.summary) + '</p>' : '') +
    '<h3>現在の動向</h3><p>' + esc(t.now) + '</p><h3>今後の見通し</h3><p>' + esc(t.outlook || '') + '</p>' + outlooks(t.outlooks).replace('<h3>見通し</h3>', '') +
    (first ? '<h3>関連する銘柄・ETF</h3><div data-mini="' + esc(keyOf(first.market, first.symbol)) + '"></div><ul class="list">' + t.related.map(r => row(keyOf(r.market, r.symbol), r.why ? '　' + esc(r.why) : '')).join('') + '</ul>' : '') +
    (t.risks?.length ? '<h3>気をつけたい点</h3><div class="chips">' + chips(t.risks, 'bad') + '</div>' : '') + sources(t.sources) + '</article>';
}
function drawTopicSuggest() {
  const box = $('#tps'); if (!box) return;
  const raw = $('#tp').value.trim();
  if (!raw) { box.innerHTML = ''; return; }
  const list = searchPool(raw, 8).filter(x => x.market !== 'INDEX');
  box.innerHTML = list.map(x => { const k = keyOf(x.market, x.symbol), on = S.watch.some(w => w.key === k);
    return '<li><button class="row" data-fav="' + esc(k) + '" data-name="' + esc(x.name) + '"><span class="nm"><b>' + esc(x.name) + '</b><small>' + esc(x.symbol) + '　' + esc([mkt(x.market), x.segment].filter(Boolean).join('／')) + '</small></span><span></span><span class="px">' + (on ? '★ 追加済み' : '☆ 銘柄を追加') + '</span></button></li>'; }).join('') +
    '<li><button class="row" id="tpAsTheme"><span class="nm"><b>「' + esc(raw) + '」をテーマとして追加</b><small>金・オールカントリー・宇宙関係のような、銘柄以外の対象</small></span><span></span><span class="px">＋ テーマ</span></button></li>';
}
/* 探すで選んだ銘柄：お気に入り／保有株に登録するポップアップ */
let chooseKey = null;
function openChooser(k, name) {
  const [market, symbol] = k.split(':'), st = { ...info(k), name: name || info(k).name, key: k, market, symbol };
  chooseKey = st;
  const fav = S.watch.some(w => w.key === k), hd = S.hold[k], e = entry(k);
  let box = $('#chooser');
  if (!box) { box = document.createElement('div'); box.id = 'chooser'; box.className = 'sheet-wrap'; document.body.appendChild(box); }
  box.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ch-name"><div class="sheet-grip"></div>' +
    '<h2 id="ch-name">' + esc(st.name) + '<span class="code">' + esc(symbol) + '</span></h2><p class="d-meta">' + esc([mkt(market), st.segment, st.sector].filter(Boolean).join('／')) +
    (e?.tech ? '　<span class="num">' + fmt(e.tech.close, market) + unit(market) + '</span> <span class="' + dir(e.tech.chg1d) + '">' + pct(e.tech.chg1d) + '</span>' : '') + '</p>' +
    '<div class="sheet-actions">' +
    '<button class="btn ' + (fav ? '' : 'primary') + '" id="chFav">' + (fav ? '★ 気になるに追加済み（外す）' : '☆ 気になるに追加') + '</button>' +
    '<button class="btn ' + (hd ? '' : 'primary') + '" id="chHoldOpen">' + (hd ? '保有株の内容を変える' : '保有株に登録') + '</button>' +
    '<button class="btn" id="chView">チャート・分析を見る</button></div>' +
    '<div id="chHoldForm" hidden><div class="field"><div><label for="cq">株数</label><input id="cq" class="input num" inputmode="decimal" value="' + esc(hd?.qty ?? '') + '"></div>' +
    '<div><label for="cc">取得単価（' + unit(market) + '）</label><input id="cc" class="input num" inputmode="decimal" value="' + esc(hd?.cost ?? '') + '"></div></div>' +
    '<label class="lbl" for="ca">口座</label><select id="ca" class="input">' + ACCOUNTS.map(a => '<option' + (a === hd?.account ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>' +
    '<div class="btns"><button class="btn primary" id="chHoldSave">保有株に登録する</button></div></div>' +
    '<p class="hint">追加した銘柄は「気になる」「保有株」タブに並び、毎朝自動で分析されます。</p>' +
    '<div class="btns"><button class="btn" id="chClose">閉じる</button></div></div>';
  box.hidden = false; requestAnimationFrame(() => box.classList.add('open'));
}
function closeChooser() { const b = $('#chooser'); if (b) { b.classList.remove('open'); b.hidden = true; } chooseKey = null; }
function renderInterest() {
  const res = D.research?.topics || {}, names = [...new Set([...S.topics, ...Object.keys(res)])];
  let h = '<p class="hint">金、オールカントリー、スペースX、宇宙関係など、気になるものを自由に書いて追加できます。毎朝、WEBの信頼できる情報から「現在の動向」「今後の見通し」「関連銘柄」をまとめます。</p>' +
    '<div class="addrow"><input id="tp" class="input" maxlength="40" placeholder="テーマ（例：金、オールカントリー、宇宙関係）" autocomplete="off" aria-label="気になるテーマ"><button class="btn primary" id="addTopic">追加</button></div>' +
    '<div class="btns" style="margin:-6px 0 18px"><button class="btn" data-goto="search">☆ 銘柄を探して気になるに追加</button></div>';
  h += names.length ? names.map(n => topicCard(n, res[n])).join('') : '<p class="empty">まだありません。上の欄に書いて「追加」を押してください。</p>';
  const favs = S.watch.filter(w => w.market !== 'INDEX');
  h += '<div class="section-head"><h2>気になる銘柄</h2><p>☆を押した銘柄・毎朝自動で分析</p></div>' + favSyncCard() +
    (favs.length ? favs.map(w => holdingCard({ k: w.key, h: { name: w.name }, fav: true })).join('') : '<p class="empty">銘柄の画面で「☆ 気になる」を押すと、ここに並び、毎朝自動で分析されます。</p>');
  const list = (D.index?.stocks || []).filter(e => e.kind === 'tracked');
  h += '<details class="group flush more"><summary>毎朝の自動更新リスト（' + list.length + '銘柄）</summary><ul class="list">' + list.map(e => row(keyOf(e.market, e.symbol))).join('') + '</ul></details>';
  $('#interest').innerHTML = h;
  document.querySelectorAll('#interest [data-mini]').forEach(async el => { el.innerHTML = miniCandles(await rowsOf(el.dataset.mini)); });
}

/* ---------- 設定 ---------- */
function renderSettings() {
  const r = D.research, ix = D.index, rp = repo();
  const u = r?.usage;
  let h = '<article class="group"><h2>データの状態</h2>' +
    '<p>株価：' + (ix?.generatedAt ? esc(dateJP(ix.generatedAt, true)) + ' に更新／' + ix.stocks.filter(e => e.kind === 'tracked').length + '銘柄' : '未取得') + '<br>' +
    'AIまとめ：' + (r?.status === 'ok' ? esc(dateJP(r.generatedAt, true)) + ' に作成（' + esc(r.provider === 'claude' ? 'Claude' : 'Gemini 無料枠') + '／' + esc(r.model || '') + '）' : '未設定') + '<br>' +
    '銘柄一覧：' + (D.master ? D.master.length.toLocaleString() + '銘柄' : '検索時に読み込み') + '</p>' +
    (ix?.errors?.length ? '<p class="hint">前回、取得できなかった銘柄：' + esc(ix.errors.map(e => e.symbol).join('、')) + '（前のデータを表示中）</p>' : '') +
    (u ? '<p class="hint num">前回のAI使用量：入力 ' + (u.input_tokens || 0).toLocaleString() + '／出力 ' + (u.output_tokens || 0).toLocaleString() + ' トークン、Web検索 ' + (u.web_search_requests || 0) + '回</p>' : '') + '</article>';
  if (r?.status !== 'ok') h += '<article class="group"><h2>AIまとめを使えるようにする（無料）</h2><ol class="mkt-points"><li>Safariで <b>aistudio.google.com</b> を開き、Googleアカウントでログイン</li><li>「Get API key」→「Create API key」でキーを作ってコピー（カード登録は不要）</li><li>GitHubで <b>github.com/' + esc(rp?.owner || 'o-ut46') + '/' + esc(rp?.repo || 'WEB-app-out46') + '/settings/secrets/actions</b> を開き、「New repository secret」</li><li>Name に <b>GEMINI_API_KEY</b>、Secret にキーを貼り付けて「Add secret」</li></ol><p class="hint">翌朝から自動でまとめが入ります。無料枠では、送った内容がGoogleのサービス改善に使われることがあります（ここで送るのは公開ニュースの見出しだけです）。</p></article>';
  h += '<article class="group"><h2>GitHubへの自動登録</h2>' + (ghToken() ? '<p><b>連携中です。</b>銘柄・気になるテーマ・保有株の登録は、ボタンを押すだけで自動でGitHubに送られます（Commit changes は不要）。</p>' :
    '<p>一度だけ設定すると、銘柄やテーマの追加、保有株の送信が、GitHubの画面を開かずに自動で済みます。</p><ol class="mkt-points">' +
    '<li>Safariで <b>github.com/settings/personal-access-tokens/new</b> を開く</li><li>Token name に「株アプリ」など、Expiration は好きな期限（最長1年）</li>' +
    '<li>Repository access で <b>Only select repositories</b> →「' + esc(rp?.repo || 'WEB-app-out46') + '」だけを選ぶ</li><li>Permissions の Repository permissions で <b>Contents</b> を「Read and write」にする</li>' +
    '<li>下の「Generate token」を押し、表示された <b>github_pat_</b> で始まる文字をコピーして、下の欄に貼り付ける</li></ol>') +
    '<label class="lbl" for="ghtk">トークン（この端末にだけ保存。外部へは送りません）</label><input id="ghtk" class="input" type="password" autocomplete="off" placeholder="' + (ghToken() ? '設定済み（変えるときだけ入力）' : 'github_pat_…') + '">' +
    '<div class="btns"><button class="btn primary" id="saveToken">' + (ghToken() ? '保存し直す（空なら解除）' : '保存してつなぐ') + '</button></div>' +
    '<p class="hint">このリポジトリのファイル書き込みだけを許可したトークンを使います。端末をなくしたときは github.com/settings/personal-access-tokens で削除してください。</p></article>';
  h += '<article class="group"><h2>銘柄の追加と削除</h2><p>銘柄の画面で「毎朝の自動更新に追加」を押すとGitHubが開きます。緑の <b>Commit changes</b> を押せば完了で、数分後に株価が、翌朝からニュースのまとめが入ります。</p><p>外すときは、GitHubの <b>watchlist</b> フォルダにある銘柄のファイル（例 7203.txt）を削除します。</p>' +
    '<div class="field"><div><label for="ow">GitHubのユーザー名</label><input id="ow" class="input" placeholder="' + esc(rp?.owner || 'o-ut46') + '" value="' + esc(S.owner) + '"></div><div><label for="rp">リポジトリ名</label><input id="rp" class="input" placeholder="' + esc(rp?.repo || 'WEB-app-out46') + '" value="' + esc(S.repo) + '"></div></div>' +
    '<p class="hint">GitHub Pagesで開いている場合は自動で判別するので、空欄のままで構いません。</p><div class="btns"><button class="btn" id="saveRepo">保存する</button></div></article>';
  h += '<article class="group"><h2>表示</h2><div class="btns" role="group" aria-label="配色">' + [['auto', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']].map(([v, l]) => '<button class="btn' + (S.theme === v ? ' primary' : '') + '" data-theme-set="' + v + '">' + l + '</button>').join('') + '</div></article>';
  h += '<article class="group"><h2>バックアップ</h2><p>保有株・ウォッチ・気になるテーマの記録はこの端末だけに保存されます。機種変更の前に書き出してください。</p><div class="btns"><button class="btn" id="exportBtn">書き出す</button><label class="btn" for="importFile">読み込む</label><input id="importFile" type="file" accept="application/json" hidden></div></article>';
  h += '<p class="foot">株価はYahoo Financeの日足データ（遅延・非公式取得）で、リアルタイムではありません。統計的な参考レンジやAIまとめは売買の推奨ではありません。</p>';
  $('#settings').innerHTML = h;
}

/* ---------- 銘柄の詳細 ---------- */
let current = null, range = 126;
const RANGES = [['1か月', 21], ['3か月', 63], ['6か月', 126], ['1年', 250], ['3年', 750], ['5年', 1250]];
function stats(rows) {
  const c = rows.map(r => r.close), n = c.length, last = c[n - 1];
  const ch = k => n > k ? (last / c[n - 1 - k] - 1) * 100 : NaN;
  const ma = k => n >= k ? mean(c.slice(-k)) : NaN;
  let g = 0, l = 0; for (let i = Math.max(1, n - 14); i < n; i++) { const d = c[i] - c[i - 1]; g += Math.max(0, d); l += Math.max(0, -d); }
  const rsi = l === 0 ? (g ? 100 : 50) : 100 - 100 / (1 + g / l);
  const rets = c.slice(-61).map((v, i, a) => i ? Math.log(v / a[i - 1]) : null).slice(1), mu = mean(rets);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / (rets.length - 1));
  const yr = c.slice(-250);
  return { last, d1: ch(1), d5: ch(5), d20: ch(20), d250: ch(250), hi: Math.max(...yr), lo: Math.min(...yr), rsi, dev25: (last / ma(25) - 1) * 100, vol: sd * Math.sqrt(250) * 100, band: [last * Math.exp(-sd * Math.sqrt(20)), last * Math.exp(sd * Math.sqrt(20))] };
}
function bigChart(rows, n, m) {
  const box = $('#chart'); if (!box) return;
  const W = Math.max(320, Math.round(box.clientWidth || 360)), H = 300, padR = 52, top = 8, ph = 196, vt = 226, vh = 46;
  const from = Math.max(0, rows.length - n), view = rows.slice(from), ma25 = maSeries(rows, 25, from), ma75 = maSeries(rows, 75, from);
  const ok = view.every(r => r.open && r.high && r.low), lines = view.length > 160 || !ok;
  const vals = view.flatMap(r => lines ? [r.close] : [r.low, r.high]).concat(ma25.filter(Number.isFinite), ma75.filter(Number.isFinite));
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * .04, L = lo - pad, Hh = hi + pad;
  const x = i => 10 + i * (W - padR - 14) / Math.max(1, view.length - 1), y = v => top + (Hh - v) / (Hh - L || 1) * ph;
  const vmax = Math.max(...view.map(r => r.volume || 0)) || 1, bw = Math.max(1, (W - padR - 14) / view.length * .62);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = Hh - (Hh - L) * i / 4, yy = y(v); g += '<line x1="0" x2="' + (W - padR + 4) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/><text x="' + (W - padR + 8) + '" y="' + (yy + 4).toFixed(1) + '" fill="var(--faint)" stroke="none" font-size="11" font-family="IBM Plex Sans, sans-serif">' + fmt(v, m) + '</text>'; }
  const ticks = Math.min(4, view.length - 1);
  for (let i = 0; i <= ticks; i++) { const j = Math.round(i * (view.length - 1) / ticks), d = view[j].date; g += '<text x="' + Math.min(W - padR - 30, Math.max(0, x(j) - 18)).toFixed(1) + '" y="' + (H - 2) + '" fill="var(--faint)" stroke="none" font-size="11" font-family="IBM Plex Sans, sans-serif">' + (n > 300 ? d.slice(0, 7).replace('-', '/') : d.slice(5).replace('-', '/')) + '</text>'; }
  view.forEach((r, i) => { if (r.volume) { const hgt = r.volume / vmax * vh; g += '<rect x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + (vt + vh - hgt).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hgt.toFixed(1) + '" fill="var(--vol)" stroke="none"/>'; } });
  if (lines) g += '<path d="' + view.map((r, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(r.close).toFixed(1)).join('') + '" stroke="var(--ink)" stroke-width="1.6"/>';
  else view.forEach((r, i) => { const c = r.close >= r.open ? 'var(--up)' : 'var(--down)', t = y(Math.max(r.open, r.close)), b = y(Math.min(r.open, r.close)); g += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + y(r.high).toFixed(1) + '" y2="' + y(r.low).toFixed(1) + '" stroke="' + c + '" stroke-width="1"/><rect x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + t.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, b - t).toFixed(1) + '" fill="' + c + '" stroke="none"/>'; });
  const path = a => a.map((v, i) => Number.isFinite(v) ? (i && Number.isFinite(a[i - 1]) ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1) : '').join('');
  g += '<path d="' + path(ma25) + '" stroke="var(--ma1)" stroke-width="1.4"/><path d="' + path(ma75) + '" stroke="var(--ma2)" stroke-width="1.4"/>';
  g += '<g id="xh" visibility="hidden"><line id="xhl" y1="' + top + '" y2="' + (vt + vh) + '" stroke="var(--sub)" stroke-dasharray="3 3"/><circle id="xhc" r="3.5" fill="var(--ink)" stroke="var(--paper)" stroke-width="1.5"/></g>';
  box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="株価チャート ' + view[0].date + 'から' + view.at(-1).date + '">' + g + '</svg>';
  const svg = box.firstChild, ro = $('#readout');
  const show = ev => {
    const rect = svg.getBoundingClientRect(), px = (ev.clientX - rect.left) * W / rect.width;
    const i = Math.max(0, Math.min(view.length - 1, Math.round((px - 10) / ((W - padR - 14) / Math.max(1, view.length - 1))))), r = view[i];
    svg.querySelector('#xh').setAttribute('visibility', 'visible');
    svg.querySelector('#xhl').setAttribute('x1', x(i)); svg.querySelector('#xhl').setAttribute('x2', x(i));
    svg.querySelector('#xhc').setAttribute('cx', x(i)); svg.querySelector('#xhc').setAttribute('cy', y(r.close));
    ro.textContent = r.date.replace(/-/g, '/') + '　' + (r.open ? '始 ' + fmt(r.open, m) + '　高 ' + fmt(r.high, m) + '　安 ' + fmt(r.low, m) + '　' : '') + '終 ' + fmt(r.close, m) + (r.volume ? '　出来高 ' + Math.round(r.volume).toLocaleString('ja-JP') : '');
  };
  const hide = () => { svg.querySelector('#xh').setAttribute('visibility', 'hidden'); ro.textContent = '指でなぞると日ごとの値が出ます'; };
  svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show); svg.addEventListener('pointerleave', hide); hide();
}
async function openDetail(k, hint) {
  const st = info(k); if (hint && st.name === st.symbol) st.name = hint;
  current = st;
  const body = $('#detailBody'), sheet = $('#detail');
  sheet.hidden = false; sheet.classList.remove('opening'); void sheet.offsetWidth; sheet.classList.add('opening'); sheet.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  updateStar();
  const meta = [st.symbol, mkt(st.market), st.segment, st.sector].filter(Boolean).join('／');
  body.innerHTML = '<div class="d-wrap"><h2 class="d-name" id="d-name">' + esc(st.name) + '</h2><div class="d-meta">' + esc(meta) + '</div><div id="dmain"><p class="empty">読み込み中…</p></div></div>';
  const rows = await rowsOf(k);
  if (current !== st) return;
  const brief = D.research?.briefs?.[k], feat = D.research?.featured?.find(f => keyOf(f.market, f.symbol) === k);
  let h = '';
  if (!rows || rows.length < 21) {
    h += '<div class="notice"><b>この銘柄の株価データはまだありません</b>「毎朝の自動更新に追加」を押してGitHubで <b>Commit changes</b> を押すと、数分後にチャートが表示されます。</div><div class="btns">' + addLink(st) + yahooLink(st) + '</div>';
    if (st.market === 'US') h += '<div class="tv" id="tv"></div><p class="hint">仮表示：TradingViewのチャート（遅延あり）。東証の銘柄はTradingViewの埋め込みに対応していないため表示できません。</p>';
    $('#dmain').innerHTML = h;
    if (st.market === 'US') { const s = document.createElement('script'); s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'; s.async = true; s.text = JSON.stringify({ autosize: true, symbol: (st.segment.startsWith('NASDAQ') ? 'NASDAQ:' : st.segment.startsWith('NYSE') && !st.segment.includes('Arca') ? 'NYSE:' : '') + st.symbol.replace('-', '.'), interval: 'D', timezone: 'Asia/Tokyo', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', locale: 'ja', hide_side_toolbar: true, allow_symbol_change: false }); const w = document.createElement('div'); w.style.height = '100%'; $('#tv').append(w, s); }
    return;
  }
  const s = stats(rows), m = st.market, last = rows.at(-1);
  h += '<div class="board"><span class="price">' + fmt(s.last, m) + '</span><span class="unit">' + unit(m) + '</span><span class="chg ' + dir(s.d1) + '">' + pct(s.d1) + '</span></div><div class="asof">' + esc(last.date.replace(/-/g, '/')) + (last.date === new Date().toLocaleDateString('sv-SE', { timeZone: m === 'US' ? 'America/New_York' : 'Asia/Tokyo' }) ? ' の値（取引中は約20分遅れ・取得時点）' : ' の終値') + (entry(k)?.kind === 'featured' ? '（注目銘柄として一時的に取得）' : '') + '</div>';
  h += '<div class="ranges" role="group" aria-label="表示期間">' + RANGES.filter(([, n]) => n <= rows.length + 60).map(([l, n]) => '<button data-range="' + n + '" aria-pressed="' + (n === range) + '">' + l + '</button>').join('') + '</div>';
  h += '<div class="readout" id="readout" aria-live="polite"></div><div class="chartbox" id="chart"></div><div class="legend"><span><i style="background:var(--ma1)"></i>25日平均</span><span><i style="background:var(--ma2)"></i>75日平均</span><span>下段：出来高</span></div>';
  h += '<dl class="stats">' + [['5日', pct(s.d5), dir(s.d5)], ['20日', pct(s.d20), dir(s.d20)], ['1年', pct(s.d250), dir(s.d250)], ['RSI(14日)', s.rsi.toFixed(0), ''], ['25日平均との差', pct(s.dev25), dir(s.dev25)], ['52週高値', fmt(s.hi, m), ''], ['52週安値', fmt(s.lo, m), ''], ['値動きの大きさ(年率)', s.vol.toFixed(0) + '%', '']].map(([a, b, c]) => '<div><dt>' + a + '</dt><dd class="' + c + '">' + b + '</dd></div>').join('') + '</dl>';
  h += '<p class="hint">ここ60日の値動きの大きさから見た、20営業日後の参考レンジ（およそ3回に2回は収まる幅）：<span class="num">' + fmt(s.band[0], m) + '〜' + fmt(s.band[1], m) + '</span>。予想や目標株価ではありません。</p>';
  if (feat) h += '<article class="group" style="margin-top:16px"><div class="feat-head"><h2>注目の理由 <span class="ai-mark">AIまとめ</span></h2>' + tone(feat.tone) + '</div><p>' + esc(feat.reason) + '</p><div class="chips">' + chips(feat.catalysts, 'good') + chips(feat.risks, 'bad') + '</div>' + sources(feat.sources) + '</article>';
  if (brief?.status === 'ok') h += '<article class="group" style="margin-top:16px"><div class="feat-head"><h2>最近のニュース <span class="ai-mark">AIまとめ</span></h2>' + tone(brief.tone) + '</div><p>' + esc(brief.summary) + '</p><div class="chips">' + chips(brief.good, 'good') + chips(brief.bad, 'bad') + '</div>' + outlooks(brief.outlooks) + sources(brief.sources) + '</article>';
  else if (brief?.status === 'no_news') h += '<p class="hint">直近3週間、信頼できる媒体にこの銘柄の記事は見つかりませんでした。</p>';
  const evs = eventsOf(k).slice(0, 8);
  if (evs.length) h += '<article class="group" style="margin-top:16px"><h2>最近のできごと</h2><ul class="evlist">' + evs.map(e => eventRow(e)).join('') + '</ul></article>';
  const hd = S.hold[k] || {};
  if (m !== 'INDEX') h += '<article class="group" style="margin-top:16px"><h2>保有の記録</h2><div class="field"><div><label for="hq">株数</label><input id="hq" class="input num" inputmode="decimal" value="' + esc(hd.qty ?? '') + '"></div><div><label for="hc">取得単価（' + unit(m) + '）</label><input id="hc" class="input num" inputmode="decimal" value="' + esc(hd.cost ?? '') + '"></div></div>' +
    '<label class="lbl" for="ha">口座</label><select id="ha" class="input">' + ACCOUNTS.map(a => '<option' + (a === hd.account ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>' +
    '<p class="hint" id="pl">' + plText(k, s.last) + '</p><div class="btns"><button class="btn" id="saveHold">保存する</button>' + (S.hold[k] ? '<button class="btn" id="delHold">保有から外す</button>' : '') + '</div></article>';
  h += '<div class="btns">' + (tracked(k) ? '' : addLink(st)) + yahooLink(st) + '</div>';
  $('#dmain').innerHTML = h;
  bigChart(rows, range, m);
  $('#dmain').onclick = ev => {
    const b = ev.target.closest('[data-range]'); if (b) { range = +b.dataset.range; document.querySelectorAll('[data-range]').forEach(x => x.setAttribute('aria-pressed', x === b)); bigChart(rows, range, m); }
    if (ev.target.id === 'saveHold' && saveHolding(st, parseFloat($('#hq').value), parseFloat($('#hc').value), $('#ha').value)) $('#pl').textContent = plText(k, s.last) + '　保存しました。';
    if (ev.target.id === 'delHold' && confirm('保有の記録を消しますか？')) { delete S.hold[k]; save(); autoSyncHoldings(); $('#pl').textContent = '記録を消しました。'; ev.target.remove(); }
  };
}
function plText(k, last) {
  const hd = S.hold[k]; if (!hd) return '';
  const pl = (last - hd.cost) * hd.qty, m = k.split(':')[0];
  return '評価損益 ' + (pl >= 0 ? '+' : '−') + (m === 'US' ? Math.abs(pl).toFixed(2) + 'ドル' : Math.abs(Math.round(pl)).toLocaleString('ja-JP') + '円') + '（' + pct((last / hd.cost - 1) * 100) + '）';
}
function updateStar() {
  const on = current && S.watch.some(w => w.key === current.key);
  $('#star').setAttribute('aria-pressed', !!on); $('#star').textContent = on ? '★ 気になる' : '☆ 気になる';
}
function closeDetail() { $('#detail').hidden = true; document.body.style.overflow = ''; current = null; renderActive(); }

/* ---------- navigation ---------- */
let active = 'today';
function renderActive() { ({ today: renderToday, search: runSearch, hold: renderHold, interest: renderInterest, settings: renderSettings })[active](); }
function showTab(t) {
  active = t;
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('is-active', s.id === 'tab-' + t));
  document.querySelectorAll('.tabs button').forEach(b => { b.classList.toggle('is-active', b.dataset.tab === t); b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'); });
  renderActive(); window.scrollTo(0, 0);
  if (t === 'search') { loadMaster(); setTimeout(() => $('#q').focus(), 50); }
}
function route() {
  const p = new URLSearchParams(location.hash.slice(1)), k = p.get('s') || '';
  if (/^(JP|US|INDEX):[\^A-Z0-9.-]{1,12}$/.test(k)) openDetail(k, p.get('n') || ''); else if (!$('#detail').hidden) closeDetail();
}
document.addEventListener('click', ev => {
  const o = ev.target.closest('[data-open]');
  if (o && !ev.target.closest('a,summary')) { location.hash = 's=' + encodeURIComponent(o.dataset.open) + (o.dataset.name ? '&n=' + encodeURIComponent(o.dataset.name) : ''); return; }
  const t = ev.target.closest('.tabs button'); if (t) { if (!$('#detail').hidden) history.back(); showTab(t.dataset.tab); return; }
  const th = ev.target.closest('[data-theme-set]'); if (th) { S.theme = th.dataset.themeSet; save(); applyTheme(); renderSettings(); return; }
  if (ev.target.id === 'saveRepo') { S.owner = $('#ow').value.trim(); S.repo = $('#rp').value.trim(); save(); ev.target.textContent = '保存しました'; }
  const pk = ev.target.closest('[data-pick]');
  if (pk) { const [k, name] = [pk.dataset.pick, pk.dataset.name]; const [market, symbol] = k.split(':'); picked = { key: k, market, symbol, name }; $('#hsr').innerHTML = ''; $('#hs').value = ''; drawHoldForm(); $('#nq').focus(); return; }
  if (ev.target.id === 'cancelHold') { picked = null; $('#holdForm').innerHTML = ''; return; }
  if (ev.target.id === 'addHold') { if (saveHolding(picked, parseFloat($('#nq').value), parseFloat($('#nc').value), $('#na').value)) { picked = null; renderHold(); window.scrollTo(0, 0); } return; }
  const ch = ev.target.closest('[data-choose]');
  if (ch) { openChooser(ch.dataset.choose, ch.dataset.name); return; }
  const gt = ev.target.closest('[data-goto]');
  if (gt) { showTab(gt.dataset.goto); return; }
  if (chooseKey) {
    const st = chooseKey;
    if (ev.target.id === 'chClose' || ev.target.id === 'chooser') { closeChooser(); return; }
    if (ev.target.id === 'chView') { closeChooser(); location.hash = 's=' + encodeURIComponent(st.key) + '&n=' + encodeURIComponent(st.name); return; }
    if (ev.target.id === 'chFav') {
      const i = S.watch.findIndex(w => w.key === st.key);
      if (i >= 0) { S.watch.splice(i, 1); toast('「' + st.name + '」を気になるから外しました。'); }
      else { S.watch.push({ key: st.key, market: st.market, symbol: st.symbol, name: st.name }); toast('「' + st.name + '」を気になるに追加しました。'); }
      save(); autoSyncFavorites(); closeChooser(); runSearch(); return;
    }
    if (ev.target.id === 'chHoldOpen') { $('#chHoldForm').hidden = false; $('#cq').focus(); return; }
    if (ev.target.id === 'chHoldSave') {
      if (saveHolding(st, parseFloat($('#cq').value), parseFloat($('#cc').value), $('#ca').value)) { toast('「' + st.name + '」を保有株に登録しました。'); closeChooser(); runSearch(); }
      return;
    }
  }
  const fv = ev.target.closest('[data-fav]');
  if (fv) { const k = fv.dataset.fav, [market, symbol] = k.split(':');
    if (!S.watch.some(w => w.key === k)) { S.watch.push({ key: k, market, symbol, name: fv.dataset.name }); save(); autoSyncFavorites(); toast('「' + fv.dataset.name + '」を気になる銘柄に追加しました。'); }
    $('#tp').value = ''; renderInterest(); return; }
  if (ev.target.closest('#tpAsTheme')) { $('#addTopic').click(); return; }
  if (ev.target.id === 'addTopic') {
    const n = topicFile($('#tp').value); if (!n) return;
    if (!S.topics.includes(n)) S.topics.push(n); save();
    $('#tp').value = ''; renderInterest();
    if (ghToken()) ghDo(() => ghPut('topics/' + n + '.txt', n + '\n', '気になるテーマ「' + n + '」を追加（アプリから自動）'), '「' + n + '」を分析対象に登録しました。');
    else { const url = ghUrl('new', 'topics', n + '.txt', ''); if (url) window.open(url, '_blank', 'noopener'); }
    return;
  }
  const dt = ev.target.closest('[data-deltopic]');
  if (dt) {
    const n = dt.dataset.deltopic, onServer = !!D.research?.topics?.[n];
    if (!confirm('「' + n + '」を外しますか？' + (onServer && !ghToken() ? '\nGitHubが開くので、緑の「Commit changes」を押すと分析も止まります。' : ''))) return;
    S.topics = S.topics.filter(x => x !== n); save();
    if (onServer) { delete D.research.topics[n]; if (ghToken()) ghDo(() => ghDelete('topics/' + n + '.txt', '気になるテーマ「' + n + '」を削除（アプリから自動）'), '「' + n + '」を外しました。'); else { const u = ghUrl('del', 'topics', n + '.txt'); if (u) window.open(u, '_blank', 'noopener'); } }
    renderInterest(); return;
  }
  const ga = ev.target.closest('[data-ghadd]');
  if (ga) { const [m, sym] = ga.dataset.ghadd.split(':'); ga.disabled = true; ga.textContent = '登録中…';
    ghDo(() => ghPut('watchlist/' + sym + '.txt', ga.dataset.name || sym, '「' + (ga.dataset.name || sym) + '」を自動更新リストに追加（アプリから自動）'), '「' + (ga.dataset.name || sym) + '」を毎朝の自動更新に追加しました。')
      .then(ok => { ga.textContent = ok ? '追加しました' : '毎朝の自動更新に追加'; ga.disabled = ok; }); return; }
  if (ev.target.id === 'syncFav') { ghDo(() => ghPut('favorites/latest.txt', favText(), '気になる銘柄リストを更新（アプリから自動）'), '気になる銘柄を自動分析に送りました。'); return; }
  if (ev.target.id === 'syncHold') { ghDo(() => ghPut('holdings/latest.txt', holdingsText(), '保有株リストを更新（アプリから自動）'), '保有株を自動分析に送りました。'); return; }
  if (ev.target.id === 'saveToken') {
    const v = $('#ghtk').value.trim(); try { v ? localStorage.setItem('stockscope2-ghtoken', v) : localStorage.removeItem('stockscope2-ghtoken'); } catch (e) {}
    $('#ghtk').value = ''; if (!v) { toast('GitHub連携を解除しました。'); renderSettings(); return; }
    ghApi('').then(j => { toast(j.permissions?.push ? 'GitHubとつながりました。登録は自動になります。' : '接続はできましたが、書き込み権限がありません。'); renderSettings(); })
      .catch(e => { toast('確認できませんでした：' + e.message); renderSettings(); });
    return;
  }
  if (ev.target.id === 'exportBtn') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' })); a.download = 'stockscope-backup.json'; a.click(); }
});
document.addEventListener('change', async ev => {
  if (ev.target.id !== 'importFile' || !ev.target.files[0]) return;
  try { const d = JSON.parse(await ev.target.files[0].text()); if (!Array.isArray(d.watch)) throw new Error(); S = { ...S, ...d }; save(); applyTheme(); renderSettings(); alert('読み込みました。'); } catch (e) { alert('このファイルは読み込めません。書き出したバックアップを選んでください。'); }
});
$('#back').onclick = () => { if (location.hash) history.back(); else closeDetail(); };
$('#star').onclick = () => {
  if (!current) return; const i = S.watch.findIndex(w => w.key === current.key);
  if (i >= 0) S.watch.splice(i, 1); else S.watch.push({ key: current.key, market: current.market, symbol: current.symbol, name: current.name });
  save(); updateStar(); autoSyncFavorites();
};
let qt; $('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(runSearch, 120); });
document.addEventListener('input', ev => {
  if (ev.target.id !== 'hs') return; loadMaster();
  const list = searchPool(ev.target.value.trim(), 12);
  $('#hsr').innerHTML = list.map(x => '<li><button class="row" data-pick="' + esc(keyOf(x.market, x.symbol)) + '" data-name="' + esc(x.name) + '"><span class="nm"><b>' + esc(x.name) + '</b><small>' + esc(x.symbol) + '　' + esc([mkt(x.market), x.segment].filter(Boolean).join('／')) + '</small></span><span></span><span class="px">選ぶ</span></button></li>').join('');
});
document.addEventListener('keydown', ev => { if (ev.target.id === 'tp' && ev.key === 'Enter') { ev.preventDefault(); $('#addTopic').click(); } });
$('#q').addEventListener('focus', loadMaster);
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (current && $('#chart')?.firstChild) rowsOf(current.key).then(r => r && bigChart(r, range, current.market)); });

/* ---------- boot ---------- */
(async function boot() {
  renderToday();
  const [ix, rs] = await Promise.all([getJSON('index.json', true).catch(() => null), getJSON('research.json', true).catch(() => null)]);
  D.index = ix; D.research = rs;
  $('#stamp').textContent = ix?.generatedAt ? dateJP(ix.generatedAt, true) + ' 更新' : 'データ未取得';
  renderActive(); route(); loadMaster();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
