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
let S = { watch: [], hold: {}, owner: '', repo: '', theme: 'auto' };
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
    D.master = (doc.items || []).map(x => ({ symbol: x[0], market: x[1], name: x[2], segment: x[3] || '', sector: x[4] || '', _n: kana(norm(x[2])), _c: norm(x[0]) }));
    if ($('#q').value.trim()) runSearch();
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
function addLink(st) {
  const r = repo(); if (!r) return '';
  const url = 'https://github.com/' + encodeURIComponent(r.owner) + '/' + encodeURIComponent(r.repo) + '/new/main/watchlist?filename=' + encodeURIComponent(st.symbol + '.txt') + '&value=' + encodeURIComponent(st.name);
  return '<a class="btn primary" href="' + esc(url) + '" target="_blank" rel="noopener">毎朝の自動更新に追加</a>';
}
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
        '<p class="grow">' + esc(f.reason) + '</p><div class="chips">' + chips(f.catalysts, 'good') + chips(f.risks, 'bad') + '</div>' + sources(f.sources) +
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
function runSearch() {
  const raw = $('#q').value.trim(), q = kana(norm(raw)), box = $('#results');
  if (!q) { box.innerHTML = ''; return; }
  const pool = D.master || (D.index?.stocks || []).map(e => ({ symbol: e.symbol, market: e.market, name: e.name, segment: '', sector: '', _n: kana(norm(e.name)), _c: norm(e.symbol) }));
  const exact = [], pre = [], named = [];
  for (const x of pool) { if (x._c === q) exact.push(x); else if (x._c.startsWith(q)) pre.push(x); else if (x._n.includes(q)) named.push(x); }
  named.sort((a, b) => (a._n.startsWith(q) ? 0 : 1) - (b._n.startsWith(q) ? 0 : 1) || a._n.length - b._n.length);
  const list = [...exact, ...pre, ...named].slice(0, 30);
  if (!list.length) { box.innerHTML = '<li class="results-empty">「' + esc(raw) + '」に当てはまる銘柄はありません。' + (D.master ? '会社名の一部、4桁のコード、米国株はティッカー（例 AAPL）で試してください。' : '銘柄一覧を読み込み中です。') + '</li>'; return; }
  box.innerHTML = list.map(x => {
    const k = keyOf(x.market, x.symbol), e = entry(k);
    const tag = e?.kind === 'tracked' ? '<span class="badge live">毎朝更新</span>' : e ? '<span class="badge">注目</span>' : '';
    return '<li><button class="row" data-open="' + esc(k) + '" data-name="' + esc(x.name) + '"><span class="nm"><b>' + esc(x.name) + tag + '</b><small>' + esc(x.symbol) + '　' + esc([mkt(x.market), x.segment, x.sector].filter(Boolean).join('／')) + '</small></span>' + spark(e?.spark) +
      '<span class="px num">' + (e?.tech ? fmt(e.tech.close, x.market) + '<small class="' + dir(e.tech.chg1d) + '">' + pct(e.tech.chg1d) + '</small>' : '') + '</span></button></li>';
  }).join('');
}

/* ---------- ウォッチ ---------- */
function renderWatch() {
  let h = '<div class="section-head"><h2>マイウォッチ</h2><p>この端末に保存</p></div>';
  if (!S.watch.length) h += '<p class="empty">銘柄を開いて「☆ ウォッチ」を押すと、ここに並びます。保有株数と取得単価を入れると損益も出ます。</p>';
  else {
    let total = 0, cost = 0, counted = 0;
    h += '<div class="group flush"><ul class="list">' + S.watch.map(w => {
      const hd = S.hold[w.key], t = entry(w.key)?.tech;
      let extra = '';
      if (hd && t && w.market !== 'US') { const pl = (t.close - hd.cost) * hd.qty; total += t.close * hd.qty; cost += hd.cost * hd.qty; counted++; extra = '　<span class="' + dir(pl) + '">損益 ' + (pl >= 0 ? '+' : '−') + Math.abs(Math.round(pl)).toLocaleString('ja-JP') + '円</span>'; }
      else if (hd && t) { const pl = (t.close - hd.cost) * hd.qty; extra = '　<span class="' + dir(pl) + '">損益 ' + (pl >= 0 ? '+' : '−') + Math.abs(pl).toFixed(2) + 'ドル</span>'; }
      return row(w.key, extra);
    }).join('') + '</ul></div>';
    if (counted) h += '<p class="hint num">日本株の評価額 ' + Math.round(total).toLocaleString('ja-JP') + '円／損益 <span class="' + dir(total - cost) + '">' + (total - cost >= 0 ? '+' : '−') + Math.abs(Math.round(total - cost)).toLocaleString('ja-JP') + '円</span>（直近の終値で計算）</p>';
  }
  const list = (D.index?.stocks || []).filter(e => e.kind === 'tracked');
  h += '<div class="section-head"><h2>毎朝の自動更新リスト</h2><p>' + list.length + '銘柄</p></div><div class="group flush"><ul class="list">' + list.map(e => row(keyOf(e.market, e.symbol))).join('') + '</ul></div>';
  $('#watch').innerHTML = h;
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
  h += '<article class="group"><h2>銘柄の追加と削除</h2><p>銘柄の画面で「毎朝の自動更新に追加」を押すとGitHubが開きます。緑の <b>Commit changes</b> を押せば完了で、数分後に株価が、翌朝からニュースのまとめが入ります。</p><p>外すときは、GitHubの <b>watchlist</b> フォルダにある銘柄のファイル（例 7203.txt）を削除します。</p>' +
    '<div class="field"><div><label for="ow">GitHubのユーザー名</label><input id="ow" class="input" placeholder="' + esc(rp?.owner || 'o-ut46') + '" value="' + esc(S.owner) + '"></div><div><label for="rp">リポジトリ名</label><input id="rp" class="input" placeholder="' + esc(rp?.repo || 'WEB-app-out46') + '" value="' + esc(S.repo) + '"></div></div>' +
    '<p class="hint">GitHub Pagesで開いている場合は自動で判別するので、空欄のままで構いません。</p><div class="btns"><button class="btn" id="saveRepo">保存する</button></div></article>';
  h += '<article class="group"><h2>表示</h2><div class="btns" role="group" aria-label="配色">' + [['auto', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']].map(([v, l]) => '<button class="btn' + (S.theme === v ? ' primary' : '') + '" data-theme-set="' + v + '">' + l + '</button>').join('') + '</div></article>';
  h += '<article class="group"><h2>バックアップ</h2><p>マイウォッチと保有株の記録はこの端末だけに保存されます。機種変更の前に書き出してください。</p><div class="btns"><button class="btn" id="exportBtn">書き出す</button><label class="btn" for="importFile">読み込む</label><input id="importFile" type="file" accept="application/json" hidden></div></article>';
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
  h += '<div class="board"><span class="price">' + fmt(s.last, m) + '</span><span class="unit">' + unit(m) + '</span><span class="chg ' + dir(s.d1) + '">' + pct(s.d1) + '</span></div><div class="asof">' + esc(last.date.replace(/-/g, '/')) + ' の終値' + (entry(k)?.kind === 'featured' ? '（注目銘柄として一時的に取得）' : '') + '</div>';
  h += '<div class="ranges" role="group" aria-label="表示期間">' + RANGES.filter(([, n]) => n <= rows.length + 60).map(([l, n]) => '<button data-range="' + n + '" aria-pressed="' + (n === range) + '">' + l + '</button>').join('') + '</div>';
  h += '<div class="readout" id="readout" aria-live="polite"></div><div class="chartbox" id="chart"></div><div class="legend"><span><i style="background:var(--ma1)"></i>25日平均</span><span><i style="background:var(--ma2)"></i>75日平均</span><span>下段：出来高</span></div>';
  h += '<dl class="stats">' + [['5日', pct(s.d5), dir(s.d5)], ['20日', pct(s.d20), dir(s.d20)], ['1年', pct(s.d250), dir(s.d250)], ['RSI(14日)', s.rsi.toFixed(0), ''], ['25日平均との差', pct(s.dev25), dir(s.dev25)], ['52週高値', fmt(s.hi, m), ''], ['52週安値', fmt(s.lo, m), ''], ['値動きの大きさ(年率)', s.vol.toFixed(0) + '%', '']].map(([a, b, c]) => '<div><dt>' + a + '</dt><dd class="' + c + '">' + b + '</dd></div>').join('') + '</dl>';
  h += '<p class="hint">ここ60日の値動きの大きさから見た、20営業日後の参考レンジ（およそ3回に2回は収まる幅）：<span class="num">' + fmt(s.band[0], m) + '〜' + fmt(s.band[1], m) + '</span>。予想や目標株価ではありません。</p>';
  if (feat) h += '<article class="group" style="margin-top:16px"><div class="feat-head"><h2>注目の理由 <span class="ai-mark">AIまとめ</span></h2>' + tone(feat.tone) + '</div><p>' + esc(feat.reason) + '</p><div class="chips">' + chips(feat.catalysts, 'good') + chips(feat.risks, 'bad') + '</div>' + sources(feat.sources) + '</article>';
  if (brief?.status === 'ok') h += '<article class="group" style="margin-top:16px"><div class="feat-head"><h2>最近のニュース <span class="ai-mark">AIまとめ</span></h2>' + tone(brief.tone) + '</div><p>' + esc(brief.summary) + '</p><div class="chips">' + chips(brief.good, 'good') + chips(brief.bad, 'bad') + '</div>' + outlooks(brief.outlooks) + sources(brief.sources) + '</article>';
  else if (brief?.status === 'no_news') h += '<p class="hint">直近10日、信頼できる媒体にこの銘柄の記事は見つかりませんでした。</p>';
  const hd = S.hold[k] || {};
  if (m !== 'INDEX') h += '<article class="group" style="margin-top:16px"><h2>保有の記録</h2><div class="field"><div><label for="hq">株数</label><input id="hq" class="input num" inputmode="decimal" value="' + esc(hd.qty ?? '') + '"></div><div><label for="hc">取得単価（' + unit(m) + '）</label><input id="hc" class="input num" inputmode="decimal" value="' + esc(hd.cost ?? '') + '"></div></div><p class="hint" id="pl">' + plText(k, s.last) + '</p><div class="btns"><button class="btn" id="saveHold">保存する</button></div></article>';
  h += '<div class="btns">' + (tracked(k) ? '' : addLink(st)) + yahooLink(st) + '</div>';
  $('#dmain').innerHTML = h;
  bigChart(rows, range, m);
  $('#dmain').onclick = ev => {
    const b = ev.target.closest('[data-range]'); if (b) { range = +b.dataset.range; document.querySelectorAll('[data-range]').forEach(x => x.setAttribute('aria-pressed', x === b)); bigChart(rows, range, m); }
    if (ev.target.id === 'saveHold') {
      const q = parseFloat($('#hq').value), c = parseFloat($('#hc').value);
      if (q > 0 && c >= 0) { S.hold[k] = { qty: q, cost: c }; if (!S.watch.some(w => w.key === k)) S.watch.push({ key: k, market: st.market, symbol: st.symbol, name: st.name }); }
      else delete S.hold[k];
      save(); updateStar(); $('#pl').textContent = plText(k, s.last) || '記録を消しました。';
    }
  };
}
function plText(k, last) {
  const hd = S.hold[k]; if (!hd) return '';
  const pl = (last - hd.cost) * hd.qty, m = k.split(':')[0];
  return '評価損益 ' + (pl >= 0 ? '+' : '−') + (m === 'US' ? Math.abs(pl).toFixed(2) + 'ドル' : Math.abs(Math.round(pl)).toLocaleString('ja-JP') + '円') + '（' + pct((last / hd.cost - 1) * 100) + '）';
}
function updateStar() {
  const on = current && S.watch.some(w => w.key === current.key);
  $('#star').setAttribute('aria-pressed', !!on); $('#star').textContent = on ? '★ ウォッチ中' : '☆ ウォッチ';
}
function closeDetail() { $('#detail').hidden = true; document.body.style.overflow = ''; current = null; renderActive(); }

/* ---------- navigation ---------- */
let active = 'today';
function renderActive() { ({ today: renderToday, search: runSearch, watch: renderWatch, settings: renderSettings })[active](); }
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
  save(); updateStar();
};
let qt; $('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(runSearch, 120); });
$('#q').addEventListener('focus', loadMaster);
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (current && $('#chart')?.firstChild) rowsOf(current.key).then(r => r && bigChart(r, range, current.market)); });

/* ---------- boot ---------- */
(async function boot() {
  renderToday();
  const [ix, rs] = await Promise.all([getJSON('index.json', true).catch(() => null), getJSON('research.json', true).catch(() => null)]);
  D.index = ix; D.research = rs;
  $('#stamp').textContent = ix?.generatedAt ? dateJP(ix.generatedAt, true) + ' 更新' : 'データ未取得';
  renderActive(); route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
