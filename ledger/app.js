'use strict';
/* o-UT 投資台帳  — データ形式は旧版と互換（version 1 の台帳 / version 2 の全台帳）。
   追加項目（plan: 毎月の積立額, mode: 入力方式, cum: 評価損益の累計）は省略可能。 */
const $ = id => document.getElementById(id);
const legacyKey = 'out-invest-ledger-v1';
const key = 'out-invest-ledger-v2';
const uiKey = 'out-invest-ledger-ui';
const MODES = ['profit','cum'];
const inArtifact = typeof window.claude?.use === 'function';
const atKey = key + '-saved-at';
const getLocalAt = () => { try { return Number(localStorage.getItem(atKey)) || 0; } catch { return 0; } };
/* 下の欄に固定で並べる4口座（どの台帳にも必ずある） */
/* 下の欄に固定で並べる口座（どの台帳にも必ずある）。NISAは1つにまとめる */
const CORE = [
  {name:'iDeCo',alias:['ideco','イデコ']},
  {name:'NISA',alias:['nisa','ニーサ','nisaつみたて','nisa積立','ニーサ積立','つみたてnisa','nisaつみたて投資枠',
    'nisa成長','ニーサ成長','nisa成長投資枠','一般','nisa一般','ニーサ一般','一般nisa']},
  {name:'保有株式',alias:['保有株','株式','証券','特定口座']}
];
const LINE_TABS = 2;
const FLOW_TYPES = {in:'入金',out:'出金',div:'配当'};
const FLOWS = -2;   // 下のバーの「入出金」   // 上のグラフの折れ線は iDeCo と NISA
const ITEM_KINDS = ['投資信託','ETF','債券','株式（手入力）','その他'];
const CORE_COUNT = CORE.length;
const OLD_NISA = /"name":"(NISA積立|NISA成長|NISA一般|NISA つみたて|NISA 成長|一般)"/;
const squash = s => s.normalize('NFKC').toLowerCase().replace(/[\s・_-]/g,'');
// 同じ口座にあたる複数のタブを1つに合算する（月ごとの投資額・損益を足す）
function mergeTabs(list, name) {
  if (list.length === 1) return {...list[0],name};
  const months = {};
  for (const t of list) for (const [k,r] of Object.entries(t.months)) {
    const m = months[k] || (months[k] = {amount:0,profit:0});
    m.amount += r.amount; m.profit += r.profit;
  }
  const out = {name,months};
  const plan = list.reduce((a,t) => a + (t.plan || 0),0);
  if (plan) out.plan = plan;
  const withExtra = list.find(t => t.schedule || t.evals);
  if (withExtra?.schedule) out.schedule = withExtra.schedule;
  if (withExtra?.evals) out.evals = withExtra.evals;
  return out;
}
function withCore(tabs) {
  const rest = [...tabs];
  const core = CORE.map(c => {
    const keys = [c.name,...c.alias].map(squash);
    const found = [];
    for (let i=0;i<rest.length;) { if (keys.includes(squash(rest[i].name))) found.push(rest.splice(i,1)[0]); else i++; }
    return found.length ? mergeTabs(found,c.name) : {name:c.name,months:{}};
  });
  return [...core,...rest];
}
const fresh = () => ({version:1,tabs:withCore([])});
const dateKey = /^\d{4}-(0[1-9]|1[0-2])$/;
const validMoney = n => Number.isSafeInteger(n) && Math.abs(n) <= 999999999999;

function validate(data) {
  if (data?.version !== 1 || !Array.isArray(data.tabs) || data.tabs.length < 1 || data.tabs.length > 24) throw Error('対応するバックアップ形式ではありません。');
  return {version:1,tabs:withCore(data.tabs.map(tab => {
    if (typeof tab?.name !== 'string' || !tab.name.trim() || tab.name.length > 32 || !tab.months || Array.isArray(tab.months) || typeof tab.months !== 'object') throw Error('口座情報に誤りがあります。');
    const months = {};
    for (const [date,row] of Object.entries(tab.months)) {
      if (!dateKey.test(date) || !validMoney(row?.amount) || row.amount < 0 || !validMoney(row.profit)) throw Error('月別の金額に誤りがあります。');
      months[date] = {amount:row.amount,profit:row.profit};
      if (row.cum !== undefined) {
        if (!validMoney(row.cum)) throw Error('評価損益の金額に誤りがあります。');
        months[date].cum = row.cum;
      }
    }
    const out = {name:tab.name,months};
    if (tab.flows !== undefined) {
      if (!Array.isArray(tab.flows) || tab.flows.length > 5000) throw Error('入出金の記録に誤りがあります。');
      out.flows = tab.flows.map(x => {
        if (typeof x?.id !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(x.date) || !validMoney(x.amount) || x.amount < 0 || !FLOW_TYPES[x.type]) throw Error('入出金の記録に誤りがあります。');
        const f = {id:x.id.slice(0,40),date:x.date,amount:x.amount,type:x.type};
        if (typeof x.note === 'string' && x.note.trim()) f.note = x.note.slice(0,60);
        if (Number.isSafeInteger(x.at)) f.at = x.at;
        return f;
      });
    }
    if (tab.items !== undefined) {
      if (!Array.isArray(tab.items) || tab.items.length > 200) throw Error('証券の記録に誤りがあります。');
      out.items = tab.items.map(x => {
        if (typeof x?.id !== 'string' || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 40 || !ITEM_KINDS.includes(x.kind) ||
            !validMoney(x.value) || x.value < 0 || (x.cost !== undefined && (!validMoney(x.cost) || x.cost < 0))) throw Error('証券の記録に誤りがあります。');
        const it = {id:x.id.slice(0,40),name:x.name,kind:x.kind,value:x.value};
        if (x.cost !== undefined) it.cost = x.cost;
        if (Number.isSafeInteger(x.at)) it.at = x.at;
        return it;
      });
    }
    if (tab.plan !== undefined) {
      if (!validMoney(tab.plan) || tab.plan < 0) throw Error('毎月の投資額に誤りがあります。');
      if (tab.plan > 0) out.plan = tab.plan;
    }
    if (tab.schedule !== undefined) {
      if (!Array.isArray(tab.schedule) || tab.schedule.length > 240) throw Error('拠出金の履歴に誤りがあります。');
      const list = tab.schedule.map(x => {
        if (!dateKey.test(x?.from) || !validMoney(x.amount) || x.amount < 0) throw Error('拠出金の履歴に誤りがあります。');
        return {from:x.from,amount:x.amount};
      }).sort((a,b) => a.from < b.from ? -1 : 1);
      if (list.length) out.schedule = list;
    }
    if (tab.evals !== undefined) {
      if (!Array.isArray(tab.evals) || tab.evals.length > 600) throw Error('評価損益の記録に誤りがあります。');
      const list = tab.evals.map(x => {
        const okV = x?.value === undefined || validMoney(x.value), okT = x?.total === undefined || (validMoney(x.total) && x.total >= 0);
        const okW = x?.worth === undefined || (validMoney(x.worth) && x.worth >= 0);
        if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(x?.date) || !okV || !okT || !okW || (x.value === undefined && x.total === undefined && x.worth === undefined)) throw Error('評価損益の記録に誤りがあります。');
        const e = {date:x.date};
        if (x.worth !== undefined) e.worth = x.worth;
        if (x.value !== undefined) e.value = x.value;
        if (x.total !== undefined) e.total = x.total;
        if (Number.isSafeInteger(x.at) && x.at > 0) e.at = x.at;
        return e;
      }).sort((a,b) => a.date < b.date ? -1 : 1);
      if (list.length) out.evals = list;
    }
    if (tab.mode !== undefined) {
      if (!MODES.includes(tab.mode)) throw Error('入力方式に誤りがあります。');
      if (tab.mode !== 'profit') out.mode = tab.mode;
    }
    return out;
  }))};
}
const defaultTitle = '投資台帳';
const makeLedger = (title = defaultTitle, data = fresh()) => ({title,data});
function validateBook(b) {
  if (b?.version !== 2 || !Array.isArray(b.ledgers) || b.ledgers.length < 1 ||
      !Number.isInteger(b.selected) || b.selected < 0 || b.selected >= b.ledgers.length) {
    throw Error('対応するバックアップ形式ではありません。');
  }
  return {version:2,selected:b.selected,ledgers:b.ledgers.map(ledger => {
    if (typeof ledger?.title !== 'string' || !ledger.title.trim()) throw Error('台帳タイトルに誤りがあります。');
    return makeLedger(ledger.title,validate(ledger.data));
  })};
}

/* ---------- 起動時の読み込み ---------- */
let book = {version:2,selected:0,ledgers:[makeLedger()]};
let loadFailed = false;
try {
  const saved = localStorage.getItem(key);
  if (saved && OLD_NISA.test(saved) && !localStorage.getItem(key+'-before-nisa')) localStorage.setItem(key+'-before-nisa',saved);
  const legacy = saved ? null : localStorage.getItem(legacyKey);
  if (saved) book = validateBook(JSON.parse(saved));
  if (legacy) book.ledgers[0] = makeLedger(defaultTitle,validate(JSON.parse(legacy)));
} catch { loadFailed = true; }
let data = book.ledgers[book.selected].data;

const now = new Date();
const thisYear = now.getFullYear();
let year = thisYear;
let month = String(now.getMonth()+1).padStart(2,'0');
let active = 0;            // -1 = 全体ビュー、-2 = 入出金リスト
let flowTarget = 1;        // 入出金リストの対象（0 = iDeCo、1 = NISA）
let flowSort = 'desc';     // 入出金リストの並び（desc = 新しい順、asc = 古い順）
try {
  const ui = JSON.parse(localStorage.getItem(uiKey) || '{}');
  if (Number.isInteger(ui.active) && ui.active >= -2 && ui.active < data.tabs.length) active = ui.active;
  if (ui.flowTarget === 0 || ui.flowTarget === 1) flowTarget = ui.flowTarget;
  if (ui.flowSort === 'asc' || ui.flowSort === 'desc') flowSort = ui.flowSort;
} catch {}
const rememberUi = () => { try { localStorage.setItem(uiKey,JSON.stringify({active,flowTarget,flowSort})); } catch {} };
let scanRevision = 0;

for (let m=1;m<=12;m++) $('month').add(new Option(m+'月',String(m).padStart(2,'0')));

/* ---------- 共通の部品 ---------- */
const current = () => data.tabs[active];
const monthKey = () => year + '-' + month;
const yen = n => n.toLocaleString('ja-JP') + ' 円';
const format = (n, signed=false) => (signed && n>0 ? '+' : '') + yen(n);
const pct = r => (r>0?'+':'') + (r*100).toFixed(1) + '%';
const sortedKeys = tab => Object.keys(tab.months).sort();

function button(label, action, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.onclick = action;
  return b;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function color(element, number) {
  element.classList.remove('gain','loss');
  if (number > 0) element.classList.add('gain');
  else if (number < 0) element.classList.add('loss');
}
function cell(row, text, number) {
  const c = row.insertCell();
  c.textContent = text;
  if (number !== undefined) color(c,number);
  return c;
}
let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- ポップアップ ---------- */
let modalDone = null;
function openModal(title, build, actions = []) {
  return new Promise(resolve => {
    const d = $('modal');
    if (modalDone) modalDone(null);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      modalDone = null;
      d.onclose = null;
      if (d.open) d.close();
      resolve(value);
    };
    modalDone = finish;
    $('modalTitle').textContent = title;
    const body = build(finish) || [];
    $('modalBody').replaceChildren(...body);
    $('modalActions').replaceChildren(...actions.map(a => button(a.label,() => finish(a.value),a.cls)));
    $('modalActions').hidden = !actions.length;
    d.onclose = () => { if (!d.open) finish(null); };   // 直前のポップアップの閉じる通知で新しい方が閉じないように
    if (!d.open) d.showModal();
    const first = $('modalBody').querySelector('input');
    if (first) setTimeout(() => { first.focus(); first.select?.(); }, 60);
  });
}
async function askText(title, label, value = '', placeholder = '', inputMode = '') {
  let input;
  const result = await openModal(title, finish => {
    const l = el('label',null,label);
    input = document.createElement('input');
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = 32;
    if (inputMode) input.inputMode = inputMode;
    input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish('ok'); } };
    l.append(input);
    return [l];
  }, [{label:'キャンセル',value:null},{label:'決定',value:'ok',cls:'primary'}]);
  return result === 'ok' ? input.value.trim() : null;
}
async function confirmBox(title, message, okLabel = 'OK', danger = false) {
  const r = await openModal(title, () => [el('p',null,message)],
    [{label:'キャンセル',value:null},{label:okLabel,value:'ok',cls:danger ? 'danger' : 'primary'}]);
  return r === 'ok';
}
function alertBox(title, message) {
  return openModal(title, () => [el('p',null,message)], [{label:'閉じる',value:null,cls:'primary'}]);
}
function choiceGroup(options, value) {
  let selected = value;
  const wrap = el('div','choices');
  wrap.setAttribute('role','radiogroup');
  const items = options.map(o => {
    const b = button('',() => { selected = o.value; sync(); });
    b.setAttribute('role','radio');
    b.append(el('b',null,o.label),el('span',null,o.desc));
    return b;
  });
  const sync = () => items.forEach((b,i) => b.setAttribute('aria-checked',String(options[i].value === selected)));
  sync();
  wrap.append(...items);
  return {element:wrap,get value(){return selected;}};
}

/* ---------- 保存 ---------- */
function saveBook(change) {
  try {
    const next = validateBook(change);
    let local = true;
    try { localStorage.setItem(key,JSON.stringify(next)); localStorage.setItem(atKey,String(Date.now())); } catch { local = false; }
    if (!local && !cloud.ref) throw Error('ブラウザの保存領域を使えません。');
    book = next;
    data = book.ledgers[book.selected].data;
    $('status').textContent = cloud.ref ? 'クラウドに保存中…' : '端末に保存済み';
    cloudPush();
    return true;
  } catch (error) {
    alertBox('保存できませんでした',error.message || 'ブラウザの保存領域を使えません。');
    return false;
  }
}
function commit(change) {
  const next = structuredClone(book);
  next.ledgers[next.selected].data = change;
  return saveBook(next);
}
function switchBook(next) {
  if (!saveBook(next)) return false;
  closeScan();
  active = Math.min(active,data.tabs.length-1);
  render();
  return true;
}

/* 評価損益モード: 前の記録の累計から月間損益を計算し直す */
function recalc(tab) {
  const keys = sortedKeys(tab);
  for (let i=1;i<keys.length;i++) {
    const prev = tab.months[keys[i-1]], row = tab.months[keys[i]];
    if (row.cum !== undefined && prev.cum !== undefined) row.profit = row.cum - prev.cum;
  }
}
function previousRecord(tab, k) {
  const keys = sortedKeys(tab).filter(x => x < k);
  return keys.length ? {key:keys.at(-1),row:tab.months[keys.at(-1)]} : null;
}

/* ---------- クラウド同期（Claudeのアーティファクトで開いたとき） ---------- */
const cloud = {ref:null,at:0,busy:false,again:false,timer:null};
function cloudPush() {
  if (!cloud.ref) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(cloudWrite,500);
}
async function cloudWrite() {
  if (!cloud.ref) return;
  if (cloud.busy) { cloud.again = true; return; }
  cloud.busy = true;
  const at = Date.now();
  try {
    await cloud.ref.set({book:JSON.stringify(book),savedAt:at});
    cloud.at = at;
    $('status').textContent = 'クラウドに保存済み';
  } catch (e) {
    $('status').textContent = e?.code === 'quota_exceeded' ? 'クラウドの容量がいっぱいです（端末には保存済み）' : 'クラウドに保存できませんでした（端末には保存済み）';
    if (e?.code === 'unavailable') setTimeout(cloudPush,1500 + Math.random()*1500);
  } finally {
    cloud.busy = false;
    if (cloud.again) { cloud.again = false; cloudPush(); }
  }
}
function adoptRemote(body) {
  try {
    const next = validateBook(JSON.parse(body.book));
    cloud.at = body.savedAt;
    book = next;
    try { localStorage.setItem(key,JSON.stringify(next)); localStorage.setItem(atKey,String(body.savedAt)); } catch {}
    data = book.ledgers[book.selected].data;
    if (active >= data.tabs.length) active = data.tabs.length-1;
    closeScan();
    render();
    return true;
  } catch { return false; }
}
async function cloudInit() {
  if (!inArtifact) return;
  try {
    const [db,user] = await Promise.all([window.claude.use('db'),window.claude.use('user')]);
    const id = db && user ? await user.id() : null;
    if (!id) { $('status').textContent = '端末内に保存（クラウド同期なし）'; return; }
    const ref = db.doc('data/users/' + id + '/ledger');
    const snap = await ref.get();
    cloud.ref = ref;
    const body = snap.exists ? snap.data() : null;
    if (body && typeof body.book === 'string' && OLD_NISA.test(body.book)) {
      // NISAをまとめる前の内容を、念のためクラウドの保存に残す
      try { await ref.collection('backups').doc().set({title:'NISAをまとめる前の自動バックアップ',book:body.book,savedAt:Date.now()}); } catch {}
    }
    if (body && typeof body.book === 'string' && Number(body.savedAt) > getLocalAt()) {
      if (adoptRemote(body)) toast('クラウドの記録を読み込みました');
      $('status').textContent = 'クラウドと同期済み';
    } else {
      $('status').textContent = 'クラウドに保存中…';
      cloudWrite();
    }
    ref.onSnapshot(s => {
      if (!s.exists || s.metadata.hasPendingWrites) return;
      const b = s.data();
      if (typeof b?.book === 'string' && Number(b.savedAt) > cloud.at && Number(b.savedAt) > getLocalAt()) {
        if (adoptRemote(b)) { $('status').textContent = 'クラウドと同期済み'; toast('ほかの端末の変更を反映しました'); }
      }
    }, () => {});
  } catch {
    $('status').textContent = '端末内に保存（クラウド同期なし）';
  }
}

/* ---------- iDeCo 拠出金：設定した月から今月まで自動で反映 ---------- */
const mk = (y,m) => y + '-' + String(m).padStart(2,'0');
const nowKey = mk(thisYear,now.getMonth()+1);
const isIdeco = index => index === 0;
const isNisa = index => index === 1;
const isStocks = index => index === 2;
function scheduled(tab, k) {
  let a = null;
  for (const x of tab.schedule || []) if (x.from <= k) a = x.amount;
  return a;
}
const effCache = new WeakMap();
// 月末になった月だけ拠出金を数える（今日が月末なら今月まで、それ以外は先月まで）
const reachedKey = (() => {
  const t = new Date(now); t.setDate(now.getDate()+1);
  if (t.getMonth() !== now.getMonth()) return nowKey;
  const p = new Date(now.getFullYear(),now.getMonth()-1,1);
  return mk(p.getFullYear(),p.getMonth()+1);
})();
const todayStr = mk(thisYear,now.getMonth()+1) + '-' + String(now.getDate()).padStart(2,'0');
// あとから登録したものを優先（同じ年の中では画面の日付より登録した順番を重視）
const newer = (e, v) => !v || e.date.slice(0,4) > v.date.slice(0,4) || (e.date.slice(0,4) === v.date.slice(0,4) && ((e.at || 0) > (v.at || 0) || ((e.at || 0) === (v.at || 0) && e.date >= v.date)));
function latestEval(tab, upto = '9999-12-31') {
  let v = null;
  for (const e of tab.evals || []) if (e.date <= upto && e.value !== undefined && newer(e,v)) v = e;
  return v;
}
function latestField(tab, field, upto = '9999-12-31') {
  let v = null;
  for (const e of tab.evals || []) if (e.date <= upto && e[field] !== undefined && newer(e,v)) v = e;
  return v;
}
function latestTotal(tab, upto = '9999-12-31') {
  let v = null;
  for (const e of tab.evals || []) if (e.date <= upto && e.total !== undefined && newer(e,v)) v = e;
  return v;
}
function monthsOf(tab) {
  const ideco = tab === data.tabs[0] || tab.name === 'iDeCo';
  const nisaFlows = !ideco && tab.name === 'NISA' && tab.flows?.length;
  if (!ideco && !tab.schedule?.length && !nisaFlows) return tab.months;
  if (effCache.has(tab)) return effCache.get(tab);
  if (!ideco) {
    // NISA など：「毎月」の投資額を今月まで自動で反映（個別に入れた月はそのまま）
    const out = {...tab.months};
    if (tab.schedule?.length) {
      let [y,m] = tab.schedule[0].from.split('-').map(Number);
      for (let i=0;i<1200;i++) {
        const k = mk(y,m);
        if (k > nowKey) break;
        if (!out[k]) { const a = scheduled(tab,k); if (a) out[k] = {amount:a,profit:0,auto:true}; }
        if (++m > 12) { m = 1; y++; }
      }
    }
    if (nisaFlows) {
      // NISA：入出金リストの記録がある月は、その月の「入金 − 出金」を投資額にする（配当は含めない）
      const byMonth = {};
      for (const f of tab.flows) {
        if (f.type === 'div') continue;
        const k = f.date.slice(0,7), b = byMonth[k] || (byMonth[k] = {in:0,out:0,n:0});
        b[f.type] += f.amount; b.n++;
      }
      for (const [k,b] of Object.entries(byMonth)) {
        out[k] = {amount:b.in - b.out,profit:tab.months[k]?.profit ?? 0,fromFlows:b};
      }
    }
    effCache.set(tab,out);
    return out;
  }
  // iDeCo は拠出金だけを月ごとに数える（損益は「◯月時点」として別に表示）
  const out = {};
  for (const [k,r] of Object.entries(tab.months)) {
    if (k > reachedKey) continue;                 // まだ月末になっていない月は数えない
    out[k] = {amount:r.amount,profit:0};
  }
  if (tab.schedule?.length) {
    let [y,m] = tab.schedule[0].from.split('-').map(Number);
    for (let i=0;i<1200;i++) {
      const k = mk(y,m);
      if (k > reachedKey) break;
      if (!out[k]) { const a = scheduled(tab,k); if (a) out[k] = {amount:a,profit:0,auto:true}; }
      if (++m > 12) { m = 1; y++; }
    }
  }
  effCache.set(tab,out);
  return out;
}

/* ---------- 集計 ---------- */
function sumWhere(tabs, test) {
  const t = {amount:0,profit:0,count:0};
  for (const tab of tabs) for (const [k,row] of Object.entries(monthsOf(tab))) {
    if (!test(k)) continue;
    t.amount += row.amount; t.profit += row.profit; t.count++;
  }
  return t;
}
const yearSum = (tabs, y=year) => sumWhere(tabs,k => k.startsWith(y+'-'));
const untilSum = (tabs, k) => sumWhere(tabs,x => x <= k);
const cutoffKey = () => year === thisYear ? thisYear+'-12' : year+'-12';

/* ---------- グラフ（SVG） ---------- */
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, text) {
  const e = document.createElementNS(NS,tag);
  for (const [k,v] of Object.entries(attrs)) e.setAttribute(k,v);
  if (text !== undefined) e.textContent = text;
  return e;
}
function shortYen(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return +(v/1e8).toFixed(2) + '億';
  if (a >= 1e4) return +(v/1e4).toFixed(a >= 1e6 ? 0 : 1) + '万';
  return String(v);
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function drawChart(tabs, width) {
  const pts = [];
  let last = -1;
  for (let m=1;m<=12;m++) {
    const k = year+'-'+String(m).padStart(2,'0');
    const s = untilSum(tabs,k);
    if (tabs.some(t => monthsOf(t)[k])) last = m-1;
    pts.push({base:s.amount,value:s.amount+s.profit});
  }
  return plotChart(pts,last,width);
}
function plotChart(pts, last, width) {
  if (last < 0) return [el('p','empty-chart',year+'年の記録はまだありません。')];
  const shown = pts.slice(0,last+1);
  const vals = shown.flatMap(p => [p.base,p.value]).filter(v => v !== null && v !== undefined);
  let lo = Math.min(0,...vals), hi = Math.max(...vals);
  if (hi === lo) hi = lo + 10000;
  const step = niceStep((hi-lo)/4);
  lo = Math.floor(lo/step)*step; hi = Math.ceil(hi/step)*step;
  const W=Math.round(Math.min(960,Math.max(300,width||640))),H=Math.round(W<480?150:190),L=44,R=12,T=14,B=22;
  const narrow = W < 480;
  const x = i => L + (W-L-R)*i/11;
  const y = v => T + (H-T-B)*(1-(v-lo)/(hi-lo));
  const g = svg('svg',{viewBox:`0 0 ${W} ${H}`,class:'chart',role:'img',
    'aria-label':`${year}年の推移（元本と評価）`});
  for (let v=lo; v<=hi+step/2; v+=step) {
    g.append(svg('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),class:v===0?'zero':'grid'}));
    g.append(svg('text',{x:L-6,y:y(v)+4,'text-anchor':'end',class:'axis'},shortYen(Math.round(v))));
  }
  for (let i=0;i<12;i++) if (!narrow || i%2===0) g.append(svg('text',{x:x(i),y:H-6,'text-anchor':'middle',class:'axis'},(i+1)+'月'));
  // 値がない月は飛ばしてつなぐ
  const line = key => { let first = true; return shown.map((p,i) => { if (p[key] === null || p[key] === undefined) return ''; const c = `${first?'M':'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`; first = false; return c; }).join(''); };
  const full = shown.every(p => p.value !== null && p.value !== undefined && p.base !== null && p.base !== undefined);
  if (full) {
    const area = line('value') + shown.slice().reverse().map((p,i) => `L${x(shown.length-1-i).toFixed(1)},${y(p.base).toFixed(1)}`).join('') + 'Z';
    g.append(svg('path',{d:area,class:'area'}));
  }
  g.append(svg('path',{d:line('base'),class:'base'}));
  g.append(svg('path',{d:line('value'),class:'value'}));
  shown.forEach((p,i) => {
    if (p.value === null || p.value === undefined) return;
    const c = svg('circle',{cx:x(i),cy:y(p.value),r:3.2,class:'dot'});
    if (p.tip) c.append(svg('title',{},p.tip));
    g.append(c);
  });
  let li = shown.length-1;
  while (li >= 0 && (shown[li].value === null || shown[li].value === undefined)) li--;
  if (li >= 0) g.append(svg('text',{x:Math.min(x(li),W-R-4),y:Math.max(y(shown[li].value)-9,12),'text-anchor':li>8?'end':'middle',class:'now'},shortYen(shown[li].value)));
  return [g];
}

// iDeCo：月ごとの取り込み（その月で最後に取り込んだもの）
function monthEval(tab, k) {
  let v = null;
  for (const e of tab.evals || []) if (e.date.startsWith(k) && newer(e,v)) v = e;
  return v;
}
function monthEvalField(tab, k, field) {
  let v = null;
  for (const e of tab.evals || []) if (e.date.startsWith(k) && e[field] !== undefined && newer(e,v)) v = e;
  return v ? v[field] : null;
}
// 拠出金累計：取り込んだ月の値から、月の拠出金リストで前後の月を逆算・積み上げ
function idecoCumAt(tab, k) {
  const eff = monthsOf(tab);
  const contrib = key => eff[key]?.amount || 0;
  const anchors = [...new Set((tab.evals || []).filter(e => e.total !== undefined).map(e => e.date.slice(0,7)))].sort();
  if (!anchors.length) return null;
  const step = (key, d) => { let [y,m] = key.split('-').map(Number); m += d; if (m > 12) { m = 1; y++; } if (m < 1) { m = 12; y--; } return mk(y,m); };
  const before = anchors.filter(a => a <= k).at(-1);
  if (before) {
    let cum = monthEvalField(tab,before,'total');
    for (let key = step(before,1), i = 0; key <= k && i < 1200; key = step(key,1), i++) cum += contrib(key);
    return cum;
  }
  const after = anchors[0];
  let cum = monthEvalField(tab,after,'total');
  for (let key = after, i = 0; key > k && i < 1200; key = step(key,-1), i++) cum -= contrib(key);
  return cum;
}
function drawIdecoChart(tab, width) {
  const lastIdx = year < thisYear ? 11 : year === thisYear ? now.getMonth() : -1;
  const pts = [];
  for (let m=1;m<=12;m++) {
    const k = mk(year,m);
    if (m-1 > lastIdx) { pts.push({base:null,value:null}); continue; }
    const read = monthEvalField(tab,k,'total');
    const base = read ?? idecoCumAt(tab,k) ?? untilSum([tab],k).amount;
    const pl = monthEvalField(tab,k,'value');
    pts.push({base:base > 0 ? base : null,value:pl !== null && base > 0 ? base + pl : null,
      tip:pl !== null ? `${m}月 資産合計 ${yen(base+pl)}（拠出金累計 ${yen(base)}・損益 ${format(pl,true)}）` : ''});
  }
  let last = -1;
  pts.forEach((p,i) => { if (p.base !== null || p.value !== null) last = i; });
  return plotChart(pts,last,width);
}

const LINE_COLORS = ['c0','c1','c2','c3'];
const hiddenLines = new Set();
function renderLegend() {
  const wrap = $('yearLegend');
  const bars = el('span','sw bars','合計');
  wrap.replaceChildren(bars,...data.tabs.slice(0,LINE_TABS).map((t,i) => {
    const b = button(t.name,() => { hiddenLines.has(i) ? hiddenLines.delete(i) : hiddenLines.add(i); render(); },'line-key '+LINE_COLORS[i]);
    b.setAttribute('aria-pressed',String(!hiddenLines.has(i)));
    b.title = hiddenLines.has(i) ? 'タップで表示' : 'タップで非表示';
    return b;
  }));
}
function drawMonthly(tabs, width) {
  const months = [];
  for (let m=1;m<=12;m++) {
    const k = year+'-'+String(m).padStart(2,'0');
    months.push(sumWhere(tabs,x => x === k));
  }
  const any = months.some(m => m.count);
  const W = Math.round(Math.min(960,Math.max(300,width||640))), narrow = W < 480;
  const L = 40, R = 6, T = 14, gap = 18, H1 = narrow ? 72 : 96, H2 = narrow ? 50 : 64, B = 18;
  const H = T + H1 + gap + H2 + B;
  const g = svg('svg',{viewBox:`0 0 ${W} ${H}`,class:'chart monthly',role:'img'});
  const slot = (W-L-R)/12, bw = Math.max(6,Math.min(26,slot*0.56));
  const cx = i => L + slot*i + slot/2;
  const maxA = Math.max(...months.map(m => m.amount),0);
  const stepA = niceStep(Math.max(maxA,10000)/2), topA = Math.ceil(Math.max(maxA,1)/stepA)*stepA;
  const per = tabs.slice(0,LINE_TABS).map(t => {
    const mo = monthsOf(t);
    return Array.from({length:12},(_,i) => mo[year+'-'+String(i+1).padStart(2,'0')] || null);
  });
  let last = -1;
  months.forEach((m,i) => { if (m.count) last = i; });
  const shownPer = per.filter((_,i) => !hiddenLines.has(i));
  const maxP = Math.max(...months.map(m => Math.abs(m.profit)),...shownPer.flat().map(r => r ? Math.abs(r.profit) : 0),0);
  const topP = niceStep(Math.max(maxP,1000));
  const yA = v => T + H1*(1-v/topA);
  const p0 = T + H1 + gap + H2/2;
  const yP = v => p0 - (H2/2)*(v/topP);
  // 見出し
  g.append(svg('text',{x:L,y:11,class:'cap'},'投資額'));
  g.append(svg('text',{x:L,y:T+H1+gap-6,class:'cap'},'運用損益'));
  // 目盛り
  for (let v=0; v<=topA+1; v+=stepA) {
    g.append(svg('line',{x1:L,x2:W-R,y1:yA(v),y2:yA(v),class:v===0?'zero':'grid'}));
    g.append(svg('text',{x:L-5,y:yA(v)+4,'text-anchor':'end',class:'axis'},shortYen(v)));
  }
  for (const v of [topP,0,-topP]) {
    g.append(svg('line',{x1:L,x2:W-R,y1:yP(v),y2:yP(v),class:v===0?'zero':'grid'}));
    g.append(svg('text',{x:L-5,y:yP(v)+4,'text-anchor':'end',class:'axis'},(v>0?'+':'')+shortYen(v)));
  }
  const nowIdx = year === thisYear ? now.getMonth() : -1;
  months.forEach((m,i) => {
    const x = cx(i);
    if (i === nowIdx) g.append(svg('rect',{x:x-slot/2,y:T-4,width:slot,height:H-T-B+4,class:'today',rx:4}));
    if (m.count) {
      const r = svg('rect',{x:x-bw/2,y:yA(m.amount),width:bw,height:Math.max(0,yA(0)-yA(m.amount)),rx:2,class:'bar-amount'});
      r.append(svg('title',{},`${i+1}月 投資額 ${yen(m.amount)}`));
      g.append(r);
      const top = Math.min(yP(m.profit),p0), h = Math.max(1.5,Math.abs(yP(m.profit)-p0));
      const q = svg('rect',{x:x-bw/2,y:m.profit<0?p0:top,width:bw,height:h,rx:2,class:m.profit<0?'bar-loss':'bar-gain'});
      q.append(svg('title',{},`${i+1}月 運用損益 ${format(m.profit,true)}`));
      g.append(q);
    }
    if (!narrow || i%2===0) g.append(svg('text',{x,y:H-5,'text-anchor':'middle',class:'axis'},(i+1)+'月'));
  });
  // 口座別の折れ線
  per.forEach((series,ai) => {
    if (hiddenLines.has(ai) || last < 0) return;
    const pts = series.slice(0,last+1);
    if (!pts.some(Boolean)) return;
    const path = f => pts.map((r,i) => `${i?'L':'M'}${cx(i).toFixed(1)},${f(r).toFixed(1)}`).join('');
    const cls = 'line '+LINE_COLORS[ai];
    g.append(svg('path',{d:path(r => yA(r ? r.amount : 0)),class:cls}));
    g.append(svg('path',{d:path(r => yP(r ? r.profit : 0)),class:cls}));
    pts.forEach((r,i) => {
      if (!r) return;
      const d1 = svg('circle',{cx:cx(i),cy:yA(r.amount),r:2.6,class:'pt '+LINE_COLORS[ai]});
      d1.append(svg('title',{},`${i+1}月 ${tabs[ai].name} ${yen(r.amount)}`));
      const d2 = svg('circle',{cx:cx(i),cy:yP(r.profit),r:2.6,class:'pt '+LINE_COLORS[ai]});
      d2.append(svg('title',{},`${i+1}月 ${tabs[ai].name} 損益 ${format(r.profit,true)}`));
      g.append(d1,d2);
    });
  });
  if (!any) g.append(svg('text',{x:(L+W-R)/2,y:T+H1/2+4,'text-anchor':'middle',class:'none'},year+'年の記録はありません'));
  const ys = yearSum(tabs);
  g.setAttribute('aria-label',`${year}年の月別グラフ。年間の投資額 ${yen(ys.amount)}、運用損益 ${format(ys.profit,true)}`);
  return g;
}

/* ---------- 画面の描画 ---------- */
function renderTitle() {
  const title = book.ledgers[book.selected].title;
  const dots = $('ledgerDots');
  dots.hidden = book.ledgers.length < 2;
  dots.replaceChildren(...book.ledgers.map((l,i) => {
    const d = button('',() => { if (i !== book.selected) slideLedger(i - book.selected); },'dot'+(i === book.selected ? ' on' : ''));
    d.setAttribute('aria-label',l.title);
    return d;
  }));
  dots.setAttribute('aria-label',`台帳 ${book.selected+1} / ${book.ledgers.length}（左右にスライドで切り替え）`);
  $('ledgerTitle').textContent = title;
  document.title = title + ' | o-UT 投資台帳';
}
function renderTabs() {
  const fb = button('入出金リスト',() => go(FLOWS));
  fb.setAttribute('aria-pressed',String(active === FLOWS));
  $('tabs').replaceChildren(...data.tabs.slice(0,CORE_COUNT).map((tab,index) => {
    const b = button(tab.name,() => go(index));
    b.setAttribute('aria-pressed',String(index === active));
    return b;
  }),fb);
}
function go(index) {
  closeScan();
  active = index;
  rememberUi();
  render();
  window.scrollTo({top:0});
}
function renderSummary() {
  const ys = yearSum(data.tabs), all = untilSum(data.tabs,cutoffKey());
  // iDeCo の損益は写真から読み取った最新の値を足す
  const ie = latestEval(data.tabs[0],year+'-12-31');
  const it = latestTotal(data.tabs[0],year+'-12-31');
  if (it) all.amount += it.total - untilSum([data.tabs[0]],cutoffKey()).amount;   // iDeCoの元本は読み取った拠出金累計を使う
  const nisaTab = data.tabs[1], nw = nisaTab && latestField(nisaTab,'worth',year+'-12-31');
  if (nw) {
    // NISA は読み取った評価額と台帳の投資元本の差を累計損益にする
    const ns = untilSum([nisaTab],nw.date.slice(0,7));
    all.profit += (nw.worth - ns.amount) - untilSum([nisaTab],cutoffKey()).profit;
  }
  const stTab = data.tabs[2], sw = stTab && latestField(stTab,'worth',year+'-12-31');
  if (sw) { all.amount += sw.total ?? 0; all.profit += sw.worth - (sw.total ?? sw.worth); }
  if (ie) { all.profit += ie.value; if (ie.date.startsWith(year+'-')) ys.profit += ie.value - (latestEval(data.tabs[0],(year-1)+'-12-31')?.value || 0); }
  $('yearLabel').textContent = year + '年';
  $('yearLabel').disabled = year === thisYear;
  $('yearAmount').textContent = yen(ys.amount);
  $('yearProfit').textContent = format(ys.profit,true);
  color($('yearProfit'),ys.profit);
  $('principalLabel').textContent = year === thisYear ? '累計元本' : year+'年末元本';
  $('principal').textContent = yen(all.amount);
  $('allProfit').textContent = format(all.profit,true);
  color($('allProfit'),all.profit);
  $('allRate').textContent = all.amount > 0 ? pct(all.profit/all.amount) : '';
  fitSummary();
}
// 集計カードの数字が枠からはみ出さないよう、文字の大きさを自動で縮める
function fitSummary() {
  for (const id of ['yearAmount','yearProfit','principal','allProfit']) {
    const e = $(id);
    e.style.fontSize = '';
    let size = parseFloat(getComputedStyle(e).fontSize);
    for (let i=0; i<20 && e.scrollWidth > e.clientWidth + 0.5 && size > 9; i++) {
      size -= 0.5;
      e.style.fontSize = size + 'px';
    }
  }
}
function renderOverview() {
  $('overviewChart').replaceChildren(...drawChart(data.tabs,$('overviewChart').clientWidth));
  const body = $('accountRows');
  body.replaceChildren();
  data.tabs.forEach((tab,i) => {
    const ys = yearSum([tab]), all = untilSum([tab],cutoffKey());
    const r = body.insertRow();
    r.className = 'clickable';
    r.onclick = () => go(i);
    cell(r,tab.name);
    cell(r,yen(ys.amount));
    cell(r,format(ys.profit,true),ys.profit);
    cell(r,yen(all.amount));
    const c = cell(r,format(all.profit,true),all.profit);
    if (all.amount > 0) c.title = '元本比 '+pct(all.profit/all.amount);
  });
  const mb = $('monthRows');
  mb.replaceChildren();
  for (let m=1;m<=12;m++) {
    const k = year+'-'+String(m).padStart(2,'0');
    const s = sumWhere(data.tabs,x => x === k);
    const r = mb.insertRow();
    cell(r,m+'月');
    if (s.count) {
      cell(r,yen(s.amount));
      cell(r,format(s.profit,true),s.profit);
    } else { cell(r,'—').className='empty'; cell(r,'—').className='empty'; }
    const c = cell(r,s.count+' / '+data.tabs.length);
    if (!s.count) c.className = 'empty';
  }
}
function renderAccount() {
  const tab = current(), mode = tab.mode || 'profit', k = monthKey();
  const ys = yearSum([tab]), all = untilSum([tab],cutoffKey());
  $('accountName').textContent = tab.name;
  const schNow = isIdeco(active) ? scheduled(tab,nowKey) : null;
  $('accountMeta').textContent = (schNow ? '拠出金 毎月 '+yen(schNow)+' ・ ' : tab.plan ? '毎月 '+yen(tab.plan)+' ・ ' : '') +
    (isIdeco(active) ? '損益は写真から' : mode === 'cum' ? '評価損益から計算' : '月間損益を直接入力');
  $('subtotal').textContent = `${year}年：投資 ${yen(ys.amount)} ／ 損益 ${format(ys.profit,true)}　｜　累計元本 ${yen(all.amount)}`;
  // NISA・iDeCo は対象月に「毎月」（その年の1月から毎月同じ額）を選べる
  const nisa = isNisa(active) || isIdeco(active), sel = $('month'), hasAll = sel.options[0]?.value === 'all';
  if (nisa && !hasAll) sel.add(new Option('毎月','all'),0);
  if (!nisa && hasAll) sel.remove(0);
  if (!nisa && month === 'all') month = String(now.getMonth()+1).padStart(2,'0');
  const every = month === 'all';
  $('month').value = month;
  const record = tab.months[k];
  const ideco = isIdeco(active);
  $('amountLabel').textContent = ideco ? '拠出金（円）' : '投資額（円）';
  $('changeBox').hidden = true;   // 「変更」のチェックは使わない（「毎月」で代わりに設定）
  $('amountHead').textContent = ideco ? '拠出金' : '投資額';
  $('change').checked = false;
  $('month').disabled = false;   // iDeCoもNISAと同じく、いつでも月を選べる
  $('entry').classList.toggle('changing',ideco && $('change').checked);

  // 投資額（未入力なら積立額を仮入力）
  const amount = $('amount');
  if (ideco && every) {
    const sch = scheduled(tab,year+'-12');
    amount.value = sch ? sch.toLocaleString('ja-JP') : '';
    amount.classList.remove('prefill');
    $('amountHint').textContent = `${year}年1月から毎月この金額（個別に変えた月はそのまま）`;
  } else if (ideco) {
    const sch = scheduled(tab,k);
    amount.value = $('change').checked ? (sch ? sch.toLocaleString('ja-JP') : '') : record ? record.amount.toLocaleString('ja-JP') : sch ? sch.toLocaleString('ja-JP') : '';
    amount.classList.toggle('prefill',!record && !!sch && !$('change').checked);
    $('amountHint').textContent = $('change').checked
      ? `${year}年${Number(month)}月から、この金額に変わります`
      : sch ? `毎月 ${yen(sch)}（自動で反映・変えるとこの月だけ変更）` : '月を選んで拠出金を入力（対象月で「毎月」を選ぶと、毎月の額をまとめて設定）';
  } else if (every) {
    const sch = scheduled(tab,year+'-12') ?? tab.plan;
    amount.value = sch ? sch.toLocaleString('ja-JP') : '';
    amount.classList.remove('prefill');
    $('amountHint').textContent = `${year}年1月から毎月この金額（個別に変えた月はそのまま）`;
  } else if (record) { amount.value = record.amount.toLocaleString('ja-JP'); amount.classList.remove('prefill'); $('amountHint').textContent = ''; }
  else if (scheduled(tab,k)) { amount.value = scheduled(tab,k).toLocaleString('ja-JP'); amount.classList.add('prefill'); $('amountHint').textContent = '毎月の投資額（変えるとこの月だけ変更）'; }
  else if (tab.plan) { amount.value = tab.plan.toLocaleString('ja-JP'); amount.classList.add('prefill'); $('amountHint').textContent = '毎月の投資額を仮入力'; }
  else { amount.value = ''; amount.classList.remove('prefill'); $('amountHint').textContent = ''; }

  $('profitField').hidden = mode !== 'profit';
  $('cumField').hidden = mode !== 'cum';
  $('cumHead').hidden = mode !== 'cum' && !Object.values(tab.months).some(r => r.cum !== undefined);
  if (mode === 'profit') {
    $('profit').value = record ? record.profit.toLocaleString('ja-JP') : '';
    $('baseField').hidden = true;
  } else {
    $('cum').value = record?.cum !== undefined ? record.cum.toLocaleString('ja-JP') : '';
    const prev = previousRecord(tab,k);
    const hasBase = prev && prev.row.cum !== undefined;
    $('baseField').hidden = hasBase;
    if (!hasBase) $('base').value = record && record.cum !== undefined ? (record.cum - record.profit).toLocaleString('ja-JP') : '';
    $('cumHint').textContent = hasBase ? `前回（${Number(prev.key.slice(5))}月）は ${format(prev.row.cum,true)}` : '';
  }
  updateCalc();

  $('removeEntry').disabled = !record || every;
  if (every) { $('profitField').hidden = $('cumField').hidden = $('baseField').hidden = true; $('calc').hidden = true; }
  $('fillPlan').hidden = !tab.plan || isIdeco(active);

  $('profitHead').textContent = ideco ? '損益（取込）' : '月間損益';
  $('evalBtn').hidden = !ideco && !isNisa(active);
  $('evalBtn').textContent = ideco ? '損益・累計を入力' : '評価額を入力';
  if (ideco) {
    $('profitField').hidden = $('cumField').hidden = $('baseField').hidden = true;
    $('cumHead').hidden = true;
    $('legValue').textContent = '資産合計（取込月）'; $('legBase').textContent = '拠出金累計（逆算）';
    renderIdecoTable(tab);
    $('accountChart').replaceChildren(...drawIdecoChart(tab,$('accountChart').clientWidth));
    return;
  }
  $('rows').parentElement.deleteTFoot();
  $('idecoBox').hidden = true;
  const nisaWorth = isNisa(active);
  if (nisaWorth) renderNisaBox(tab);
  $('worthHead').hidden = !nisaWorth;
  $('legValue').textContent = '評価（元本＋損益）'; $('legBase').textContent = '投資元本';
  const rows = $('rows');
  rows.replaceChildren();
  const showCum = !$('cumHead').hidden;
  for (let m=1;m<=12;m++) {
    const mm = String(m).padStart(2,'0');
    const key = year+'-'+mm;
    const saved = monthsOf(tab)[key];
    const planned = !saved && (isIdeco(active) || tab.schedule) && key > nowKey ? scheduled(tab,key) : null;
    const r = rows.insertRow();
    if (mm === month) r.className = 'selected';
    r.tabIndex = 0;
    r.setAttribute('aria-label',m+'月を編集');
    const pick = () => { closeScan(); month = mm; render(); $('amount').focus({preventScroll:true}); $('entry').scrollIntoView({block:'nearest',behavior:'smooth'}); };
    r.onclick = pick;
    r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    cell(r,m+'月');
    const tapAmount = c => { c.classList.add('tap-amount'); c.title = 'タップで金額を変更'; c.onclick = e => { e.stopPropagation(); editAmount(key); }; return c; };
    if (planned) {
      tapAmount(cell(r,yen(planned))).classList.add('empty');
      cell(r,'予定').className = 'empty';
      if (showCum) cell(r,'—').className='empty';
    } else if (saved?.fromFlows) {
      const c = cell(r,'');
      c.append(el('span',null,yen(saved.amount)),el('small','code',`入出金 ${saved.fromFlows.n}件`));
      c.title = `入金 ${yen(saved.fromFlows.in)} − 出金 ${yen(saved.fromFlows.out)}（入出金リストから）`;
      c.classList.add('tap-amount');
      c.onclick = e => { e.stopPropagation(); flowTarget = 1; rememberUi(); $('flowFrom').value = key + '-01'; $('flowTo').value = key + '-' + String(new Date(+key.slice(0,4),+key.slice(5),0).getDate()).padStart(2,'0'); go(FLOWS); };
      if (saved.profit || tab.months[key]) cell(r,format(saved.profit,true),saved.profit); else cell(r,'未入力').className = 'empty';
      if (showCum) cell(r,'—').className='empty';
    } else if (saved) {
      tapAmount(cell(r,yen(saved.amount)));
      if (saved.auto) cell(r,'未入力').className = 'empty';
      else cell(r,format(saved.profit,true),saved.profit);
      if (showCum) saved.cum !== undefined ? cell(r,format(saved.cum,true),saved.cum) : (cell(r,'—').className='empty');
    } else {
      tapAmount(cell(r,'—')).classList.add('empty'); cell(r,'—').className='empty';
      if (showCum) cell(r,'—').className='empty';
    }
    if (nisaWorth) {
      const w = monthEvalField(tab,key,'worth');   // その月に読み取った最新の評価額（なければ空白）
      cell(r,w !== null ? yen(w) : '');
    }
  }
  const hasWorth = nisaWorth && tab.evals?.some(e => e.worth !== undefined);
  $('legValue').textContent = hasWorth ? '評価額（読み取った月）' : '評価（元本＋損益）';
  $('accountChart').replaceChildren(...(hasWorth ? drawWorthChart(tab,$('accountChart').clientWidth) : drawChart([tab],$('accountChart').clientWidth)));
}
function renderNisaBox(tab) {
  const box = $('idecoBox');
  box.hidden = false;
  const w = latestField(tab,'worth',year+'-12-31');
  const md = d => `${Number(d.slice(5,7))}/${Number(d.slice(8))}`;
  const when = d => d.slice(0,4) < String(year) ? `${d.slice(0,4)}年から繰越` : `${md(d)} 時点`;
  const line = (label, node, note, cls) => {
    const d = el('div','ib-row'+(cls ? ' '+cls : ''));
    const v = el('div','ib-val'); v.append(node); if (note) v.append(el('small',null,note));
    d.append(el('span','ib-label',label),v); return d;
  };
  const head = el('div','ib-head');
  head.append(el('b',null,'NISAの評価額'),button(w ? '修正' : '手で入力',editNisaWorth,'ib-edit'));
  if (!w) { box.replaceChildren(head,line('評価額',el('b','ib-none','未読取'),'証券会社の画面を写真から読み取り')); return; }
  const principal = untilSum([tab],w.date.slice(0,7)).amount;
  const diff = w.worth - principal;
  const db = el('b',null,format(diff,true)); color(db,diff);
  box.replaceChildren(head,
    line('評価額',el('b',null,yen(w.worth)),when(w.date),'ib-sum'),
    line('投資元本（台帳）',el('b',null,yen(principal)),`${Number(w.date.slice(5,7))}月までの投資額の合計`),
    line('評価額 − 元本',db,principal > 0 ? pct(diff/principal) : ''));
}
function drawWorthChart(tab, width) {
  const lastIdx = year < thisYear ? 11 : year === thisYear ? now.getMonth() : -1;
  const pts = [];
  for (let m=1;m<=12;m++) {
    const k = mk(year,m);
    if (m-1 > lastIdx) { pts.push({base:null,value:null}); continue; }
    const base = untilSum([tab],k).amount, w = monthEvalField(tab,k,'worth');
    pts.push({base:base > 0 ? base : null,value:w,tip:w !== null ? `${m}月 評価額 ${yen(w)}（投資元本 ${yen(base)}）` : ''});
  }
  let last = -1;
  pts.forEach((p,i) => { if (p.base !== null || p.value !== null) last = i; });
  return plotChart(pts,last,width);
}
async function editAmount(key) {
  const tab = current(), label = isIdeco(active) ? '拠出金' : '投資額';
  const cur = tab.months[key]?.amount ?? monthsOf(tab)[key]?.amount ?? scheduled(tab,key);
  const v = await askText(`${Number(key.slice(0,4))}年${Number(key.slice(5))}月の${label}`,`${label}（円）`,cur ? cur.toLocaleString('ja-JP') : '','例 40,000','numeric');
  if (v === null) return;
  const n = v.trim() === '' ? 0 : money(v);
  if (!validMoney(n) || n < 0) { alertBox(label+'を確認してください','0以上の整数で入力してください。'); return; }
  const next = structuredClone(data);
  const t = next.tabs[active];
  t.months[key] = {...(t.months[key] || {profit:0}),amount:n};
  recalc(t);
  if (commit(next)) { if (key.startsWith(year+'-')) month = key.slice(5); render(); toast(`${Number(key.slice(5))}月の${label}を ${yen(n)} にしました`); }
}
function renderIdecoTable(tab) {
  const rows = $('rows'), eff = monthsOf(tab);
  rows.replaceChildren();
  let total = 0;
  for (let m=1;m<=12;m++) {
    const mm = String(m).padStart(2,'0'), key = year+'-'+mm;
    const r = rows.insertRow();
    if (mm === month) r.className = 'selected';
    r.tabIndex = 0;
    r.setAttribute('aria-label',m+'月を選ぶ');
    const pick = () => { closeScan(); month = mm; render(); };
    r.onclick = pick;
    r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    cell(r,m+'月');
    const v = key <= reachedKey ? eff[key] : null;   // 月末前の月は空白
    const ac = v && v.amount ? cell(r,yen(v.amount)) : cell(r,'');
    if (v && v.amount) total += v.amount;
    ac.classList.add('tap-amount');
    ac.onclick = e => { e.stopPropagation(); editAmount(key); };
    const pl = monthEvalField(tab,key,'value');   // その月に取り込んだ最新の損益（なければ空白）
    if (pl !== null) cell(r,format(pl,true),pl); else cell(r,'');
  }
  const t = rows.parentElement;
  t.deleteTFoot();
  const foot = t.createTFoot();
  const md = d => `${Number(d.slice(5,7))}/${Number(d.slice(8))}`;
  const when = d => d.slice(0,4) < String(year) ? `${d.slice(0,4)}年から繰越` : `${md(d)} 時点`;
  const f = foot.insertRow();
  cell(f,year+'年の拠出金');
  const c0 = f.insertCell(); c0.colSpan = 2; c0.append(el('b',null,yen(total)));
  // 読み取った拠出金累計と損益（翌年は前年の値を繰り越して表示）
  const tt = latestTotal(tab,year+'-12-31'), ev = latestEval(tab,year+'-12-31');
  const box = $('idecoBox');
  box.hidden = false;
  const line = (label, valueNode, note, cls) => {
    const d = el('div','ib-row'+(cls ? ' '+cls : ''));
    const v = el('div','ib-val');
    v.append(valueNode);
    if (note) v.append(el('small',null,note));
    d.append(el('span','ib-label',label),v);
    return d;
  };
  const dash = () => el('b','ib-none','未読取');
  let pv = dash();
  if (ev) { pv = el('b',null,format(ev.value,true)); color(pv,ev.value); }
  const head = el('div','ib-head');
  head.append(el('b',null,'iDeCoの資産状況'),button(tt || ev ? '修正' : '手で入力',() => $('evalBtn').click(),'ib-edit'));
  box.replaceChildren(head,
    line('拠出金累計', tt ? el('b',null,yen(tt.total)) : dash(), tt ? when(tt.date) : ''),
    line('損益', pv, ev ? when(ev.date) : ''),
    line('資産合計', tt && ev ? el('b',null,yen(tt.total + ev.value)) : dash(), tt && ev && tt.total > 0 ? '損益率 '+pct(ev.value/tt.total) : '', 'ib-sum'));
  $('subtotal').textContent = `${year}年の拠出金 ${yen(total)}` + (tt ? `　｜　拠出金累計 ${yen(tt.total)}` : '') + (ev ? `　｜　損益 ${format(ev.value,true)}` : '') + (tt && ev ? `　｜　資産合計 ${yen(tt.total+ev.value)}` : '');
}
// iDeCo：読み取った損益・拠出金累計を今日の記録として反映（確認なし）
function registerEval({value, total, worth, date = todayStr}, index = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayStr) date = todayStr;
  const next = structuredClone(data);
  const t = next.tabs[index];
  const both = validMoney(value) && validMoney(total);
  const old = both || worth !== undefined ? {date} : ((t.evals || []).find(e => e.date === date) || {date});
  const e = {...old,date,at:Date.now()};
  if (validMoney(value)) e.value = value;
  if (validMoney(total) && total >= 0) e.total = total;
  if (validMoney(worth) && worth >= 0) e.worth = worth;
  if (e.value === undefined && e.total === undefined && e.worth === undefined) return false;
  t.evals = [...(t.evals || []).filter(x => x.date !== date),e];
  if (!commit(next)) return false;
  render();
  return true;
}
async function editNisaWorth() {
  const tab = data.tabs[1], w = latestField(tab,'worth');
  const v = await askText('NISAの評価額','証券会社の画面の「資産残高（評価額）」（円）',w ? w.worth.toLocaleString('ja-JP') : '','例 1,823,205','numeric');
  if (v === null) return;
  const n = money(v);
  if (!validMoney(n) || n < 0) { alertBox('金額を確認してください','0以上の整数で入力してください。'); return; }
  if (registerEval({worth:n},1)) toast('評価額を反映しました');
}
$('evalBtn').onclick = async () => {
  if (isNisa(active)) return editNisaWorth();
  let pIn, tIn;
  const r = await openModal('iDeCoの拠出金累計と損益', finish => {
    const tab = data.tabs[0], ev = latestEval(tab), tt = latestTotal(tab);
    const l2 = el('label',null,'拠出金累計'); tIn = document.createElement('input'); tIn.inputMode = 'numeric'; tIn.placeholder = '例 1,863,000'; tIn.value = tt ? tt.total.toLocaleString('ja-JP') : ''; l2.append(tIn);
    const l1 = el('label',null,'損益'); pIn = document.createElement('input'); pIn.inputMode = 'decimal'; pIn.placeholder = '例 870,943 / -3,000'; pIn.value = ev ? ev.value.toLocaleString('ja-JP') : ''; l1.append(pIn);
    const sum = el('p');
    const upd = () => { const a = money(tIn.value), b = money(pIn.value); sum.textContent = validMoney(a) && validMoney(b) ? `資産合計 ${yen(a+b)}` : '証券会社の画面の「拠出金累計」と「損益」を入れてください。'; };
    tIn.oninput = pIn.oninput = upd; upd();
    return [l2,l1,sum];
  }, [{label:'キャンセル',value:null},{label:'反映',value:'ok',cls:'primary'}]);
  if (r !== 'ok') return;
  const value = pIn.value.trim() ? money(pIn.value) : undefined, total = tIn.value.trim() ? money(tIn.value) : undefined;
  if ((value !== undefined && !validMoney(value)) || (total !== undefined && (!validMoney(total) || total < 0))) { alertBox('金額を確認してください','整数で入力してください。マイナスは「-」や「△」で入力できます。'); return; }
  if (registerEval({value,total})) toast('反映しました');
};
function render() {
  if (typeof renderHeadBtns === 'function') renderHeadBtns();
  renderTitle();
  renderTabs();
  renderSummary();
  renderLegend();
  $('yearChart').replaceChildren(drawMonthly(data.tabs,$('yearChart').clientWidth));
  $('overview').hidden = active !== -1;
  $('account').hidden = active < 0 || isStocks(active);
  $('stocks').hidden = !isStocks(active);
  $('flows').hidden = active !== FLOWS;
  if (active !== FLOWS) document.body.classList.remove('flow-ideco','flow-nisa');
  if (active === -1) renderOverview(); else if (active === FLOWS) renderFlows(); else if (isStocks(active)) renderStocks(); else renderAccount();
}

/* ---------- 入出金リスト（iDeCo / NISA） ---------- */
const flowTab = () => data.tabs[flowTarget];
const flowId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const ymd = d => `${d.slice(0,4)}/${d.slice(5,7)}/${d.slice(8)}`;
// 入出金リストの上：読み取った資産の最新と、これまでの読み取り（新しい順）
function renderFlowAsset(tab) {
  const box = $('flowAsset');
  const order = (a,b) => (b.at || 0) - (a.at || 0) || (a.date < b.date ? 1 : -1);
  const line = (label, node, note, cls) => {
    const d = el('div','ib-row'+(cls ? ' '+cls : ''));
    const v = el('div','ib-val'); v.append(node); if (note) v.append(el('small',null,note));
    d.append(el('span','ib-label',label),v); return d;
  };
  const md = d => d.replaceAll('-','/');
  const head = el('div','ib-head');
  const parts = [head];
  const table = (cols, rows) => {
    const wrap = el('div','table asset-hist');
    const t = document.createElement('table');
    const hr = t.createTHead().insertRow();
    cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; hr.append(th); });
    const tb = t.createTBody();
    rows.forEach(r => { const tr = tb.insertRow(); r.forEach(([txt,n]) => cell(tr,txt,n)); });
    wrap.append(t); return wrap;
  };
  if (flowTarget === 0) {
    const tt = latestTotal(tab), ev = latestEval(tab);
    head.append(el('b',null,'iDeCo：読み取った最新の資産状況'),el('small',null,tt || ev ? md((tt && ev ? (newer(tt,ev) ? tt : ev) : tt || ev).date) + ' 時点' : ''));
    if (!tt && !ev) { parts.push(el('p','sub','まだ読み取っていません。iDeCoの「資産状況」の画面（拠出金累計・損益が写っているもの）を下の枠から読み取ると、ここに最新が表示されます。')); }
    else {
      let pb = el('b',null,ev ? format(ev.value,true) : '—'); if (ev) color(pb,ev.value);
      parts.push(line('拠出金累計',el('b',null,tt ? yen(tt.total) : '—')),line('損益',pb),
        line('資産合計',el('b',null,tt && ev ? yen(tt.total + ev.value) : '—'),tt && ev && tt.total ? '損益率 ' + pct(ev.value/tt.total) : '','ib-sum'));
      const hist = [...(tab.evals || [])].sort(order);
      if (hist.length > 1) parts.push(el('small','sub','これまでの読み取り'),table(['日付','拠出金累計','損益','合計'],hist.map(e => [[e.date.slice(2).replaceAll('-','/')],[e.total !== undefined ? yen(e.total) : '—'],[e.value !== undefined ? format(e.value,true) : '—',e.value],[e.total !== undefined && e.value !== undefined ? yen(e.total + e.value) : '—']])));
    }
  } else {
    const w = latestField(tab,'worth');
    head.append(el('b',null,'NISA：読み取った最新の評価額'),el('small',null,w ? md(w.date) + ' 時点' : ''));
    if (!w) parts.push(el('p','sub','まだ読み取っていません。証券会社の資産（評価額）の画面を下の枠から読み取ると、ここに最新が表示されます。'));
    else {
      parts.push(line('評価額',el('b',null,yen(w.worth)),'','ib-sum'));
      const hist = (tab.evals || []).filter(e => e.worth !== undefined).sort(order);
      if (hist.length > 1) parts.push(el('small','sub','これまでの読み取り'),table(['日付','評価額'],hist.map(e => [[md(e.date)],[yen(e.worth)]])));
    }
  }
  box.replaceChildren(...parts);
}
function renderFlows() {
  const tab = flowTab();
  renderFlowAsset(tab);
  document.querySelectorAll('#flowSeg button').forEach(b => { const on = Number(b.dataset.ft) === flowTarget; b.setAttribute('aria-selected',String(on)); b.classList.toggle('on',on); });
  // iDeCo はブルー系、NISA は白系を背景に混ぜる
  document.body.classList.toggle('flow-ideco',flowTarget === 0);
  document.body.classList.toggle('flow-nisa',flowTarget === 1);
  // 日付で探しているときは年に関係なく、その期間を表示
  let from = $('flowFrom').value, to = $('flowTo').value;
  if (from && to && from > to) [from,to] = [to,from];
  const searching = !!(from || to);
  const allYears = $('fyAll').checked && !searching;
  const dir = flowSort === 'asc' ? 1 : -1;
  const list = (tab.flows || [])
    .filter(f => searching ? (!from || f.date >= from) && (!to || f.date <= to) : allYears || f.date.startsWith(year+'-'))
    .sort((a,b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || 0) - (b.at || 0)) * dir);
  $('flowSort').textContent = `並び：${flowSort === 'asc' ? '古い順' : '新しい順'} ▾`;
  $('flowClear').hidden = !searching;
  const sumOf = (arr, t) => arr.filter(f => f.type === t).reduce((a,f) => a + f.amount,0);
  const sum = t => sumOf(list,t);
  const inn = sum('in'), out = sum('out'), div = sum('div');
  // 年のタブ（記録のある年と今年）
  const ys = new Set((tab.flows || []).map(f => +f.date.slice(0,4))); ys.add(thisYear); ys.add(year);
  const yList = [...ys].sort((a,b) => a - b);
  $('fyTabs').replaceChildren(...yList.map(y => {
    const b = button(`${y}年`,() => { year = y; $('fyAll').checked = false; render(); });
    b.setAttribute('role','tab');
    const on = !allYears && !searching && y === year;
    b.setAttribute('aria-selected',String(on)); b.classList.toggle('on',on);
    b.disabled = searching;
    return b;
  }));
  $('fyAll').disabled = searching;
  requestAnimationFrame(() => $('fyTabs').querySelector('.on')?.scrollIntoView({inline:'nearest',block:'nearest'}));
  const line = (label, node, note, cls) => {
    const d = el('div','ib-row'+(cls ? ' '+cls : ''));
    const v = el('div','ib-val'); v.append(node); if (note) v.append(el('small',null,note));
    d.append(el('span','ib-label',label),v); return d;
  };
  const head = el('div','ib-head');
  const range = searching ? `${from ? ymd(from) : '最初'} 〜 ${to ? ymd(to) : '最新'}` : allYears ? 'すべての年' : `${year}年`;
  head.append(el('b',null,`${tab.name}・${range}の入出金`),el('small',null,`${list.length}件`));
  const net = inn - out, nb = el('b',null,format(net,true)); color(nb,net);
  $('flowBox').replaceChildren(head,
    line('入金',el('b',null,yen(inn))),
    line('出金',el('b',null,yen(out))),
    line('配当・分配金',el('b',null,yen(div))),
    line('入金 − 出金',nb,'','ib-sum'));
  const rows = $('flowRows');
  rows.replaceChildren();
  if (!list.length) {
    const r = rows.insertRow(), c = r.insertCell(); c.colSpan = 3; c.className = 'empty';
    c.textContent = searching ? 'この期間の記録はありません。' : allYears ? 'まだ記録がありません。下の枠から写真やデータを読み取るか、手で追加してください。' : `${year}年の記録はありません。下の枠から写真やデータを読み取るか、手で追加してください。`;
  }
  for (const f of list) {
    const r = rows.insertRow(); r.className = 'clickable';
    r.onclick = () => editFlow(f.id);
    const dc = r.insertCell(); dc.append(el('span',null,ymd(f.date)));
    if (f.note) dc.append(el('small','code',f.note));
    const tc = r.insertCell(); tc.append(el('span','ftype '+f.type,FLOW_TYPES[f.type]));
    cell(r,(f.type === 'out' ? '−' : '') + yen(f.amount),f.type === 'out' ? -1 : 0);
  }
}
// iDeCo / NISA の切り替えタブ
document.querySelectorAll('#flowSeg button').forEach(b => b.onclick = () => { flowTarget = Number(b.dataset.ft); rememberUi(); render(); });
$('flowSort').onclick = async () => {
  let ch;
  const r = await openModal('並び順', () => {
    ch = choiceGroup([
      {value:'desc',label:'新しい順（日付の降順）',desc:'最近の入出金が上に来ます'},
      {value:'asc',label:'古い順（日付の昇順）',desc:'古い入出金から順に並びます'}],flowSort);
    return [ch.element];
  }, [{label:'キャンセル',value:null},{label:'決定',value:'ok',cls:'primary'}]);
  if (r !== 'ok') return;
  flowSort = ch.value; rememberUi(); render();
};
$('flowFrom').onchange = $('flowTo').onchange = () => render();
$('fyAll').onchange = () => render();
$('flowClear').onclick = () => { $('flowFrom').value = ''; $('flowTo').value = ''; render(); };
// 読み取る写真・ファイルをためておき、まとめて読み取る
let flowQueue = [];
const fileKey = f => f.name + '|' + f.size + '|' + f.lastModified;
function queueAdd(files) {
  let n = 0;
  for (const f of files) if (!flowQueue.some(q => fileKey(q) === fileKey(f))) { flowQueue.push(f); n++; }
  renderQueue();
  if (n) toast(`${n}件を追加しました（全${flowQueue.length}件）`);
  else if (files.length) toast('同じファイルはすでに入っています');
}
function renderQueue() {
  const box = $('flowQueue');
  box.hidden = !flowQueue.length;
  $('queueCount').textContent = `読み取り待ち ${flowQueue.length}件`;
  $('queueRun').textContent = `まとめて読み取る（${flowQueue.length}件）`;
  const list = $('queueList');
  list.querySelectorAll('img').forEach(i => URL.revokeObjectURL(i.src));
  list.replaceChildren(...flowQueue.map((f,i) => {
    const it = el('div','q-item');
    if (/^image\//.test(f.type)) { const im = document.createElement('img'); im.src = URL.createObjectURL(f); im.alt = ''; it.append(im); }
    else it.append(el('span','q-icon',/\.csv$/i.test(f.name) ? 'CSV' : 'TXT'));
    it.append(el('small',null,f.name));
    const x = button('×',() => { flowQueue.splice(i,1); renderQueue(); },'q-x');
    x.setAttribute('aria-label',f.name + ' を外す');
    it.append(x);
    return it;
  }));
}
$('flowPick').onclick = () => $('flowImages').click();
$('flowPhoto').onclick = () => $('flowFile').click();
$('flowCamera').onclick = () => $('cameraFile').click();
for (const id of ['flowFile','flowImages']) $(id).onchange = e => { const files = [...e.target.files]; e.target.value = ''; queueAdd(files); };
$('queueClear').onclick = () => { flowQueue = []; renderQueue(); };
$('queueRun').onclick = () => { const files = flowQueue; flowQueue = []; renderQueue(); handleFlowFiles(files); };
// 写真とデータ（CSV）を振り分けて読み取る
async function handleFlowFiles(files) {
  if (!files.length) return;
  const isData = f => /\.(csv|txt)$/i.test(f.name) || /csv|text\/plain/.test(f.type);
  const data = files.filter(isData), images = files.filter(f => !isData(f) && /^image\//.test(f.type || 'image/'));
  let entries = [];
  for (const f of data) {
    try { entries.push(...parseCsvFlows(await readTextFile(f))); }
    catch { toast(`${f.name} を読めませんでした`); }
  }
  if (data.length && !entries.length && !images.length) {
    const st = $('flowStatus'); st.hidden = false;
    st.textContent = 'ファイルから日付と金額の行を見つけられませんでした。証券会社の「入出金明細」のCSVを選んでください。';
    return;
  }
  if (images.length) return scanFiles(images,entries);
  const st = $('flowStatus'); st.hidden = false; st.textContent = `${data.length}件のファイルを読み取りました。内容を確認してください。`;
  importFlows([],[],entries);
}
// 文字コードは UTF-8 か Shift_JIS（証券会社のCSVに多い）
async function readTextFile(f) {
  const buf = await f.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(buf);
  if (t.includes('\uFFFD')) { try { t = new TextDecoder('shift_jis').decode(buf); } catch {} }
  return t;
}
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim());
}
function parseCsvFlows(text) {
  const rows = text.replace(/^\uFEFF/,'').split(/\r?\n/).map(splitCsv).filter(r => r.some(Boolean));
  const dateRe = /(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/;
  const num = v => { const n = Number(String(v ?? '').normalize('NFKC').replace(/[,円\s+]/g,'')); return Number.isFinite(n) ? Math.round(Math.abs(n)) : 0; };
  let col = null;
  const out = [];
  for (const r of rows) {
    const joined = r.join(' ').normalize('NFKC');
    const dm = joined.match(dateRe);
    if (!dm) {
      // 見出し行：入金額・出金額・金額の列を探す
      if (/金額|入金|出金/.test(joined)) {
        col = {};
        r.forEach((h,i) => {
          const x = h.normalize('NFKC');
          if (/入金/.test(x) && !/出金/.test(x) && /額|金額/.test(x) && col.in === undefined) col.in = i;
          else if (/出金/.test(x) && !/入金/.test(x) && /額|金額/.test(x) && col.out === undefined) col.out = i;
          else if (/金額/.test(x) && col.amt === undefined) col.amt = i;
        });
      }
      continue;
    }
    if (+dm[2] < 1 || +dm[2] > 12 || +dm[3] < 1 || +dm[3] > 31) continue;
    const date = `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}`;
    let amount = 0, type = 'in';
    if (col && (col.in !== undefined || col.out !== undefined)) {
      const a = num(r[col.in]), b = num(r[col.out]);
      if (a > 0) { amount = a; type = 'in'; } else if (b > 0) { amount = b; type = 'out'; } else continue;
    } else {
      if (col?.amt !== undefined) amount = num(r[col.amt]);
      if (!amount) { const cells = r.filter(c => /^[\d,.\-+円\s"]+$/.test(c) && !dateRe.test(c)); amount = cells.length ? num(cells.at(-1)) : 0; }
      if (!amount) continue;
      type = /出金|引落|引出|振込出|払出/.test(joined) ? 'out' : 'in';
    }
    if (type === 'in' && /配当|分配|利金|dividend/i.test(joined)) type = 'div';
    const note = r.filter(c => c && !dateRe.test(c) && !/^[\d,.\-+円\s]+$/.test(c)).join(' ').slice(0,60);
    out.push({date,amount,type,...(note ? {note} : {})});
  }
  return out;
}
// ドラッグ＆ドロップ
const drop = $('flowDrop');
drop.addEventListener('dragover',e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave',() => drop.classList.remove('over'));
drop.addEventListener('drop',e => { e.preventDefault(); drop.classList.remove('over'); queueAdd([...(e.dataTransfer?.files || [])]); });
$('flowAdd').onclick = () => editFlow(null);
$('flowReset').onclick = async () => {
  let ch;
  const cnt = i => (data.tabs[i].flows || []).length;
  const r = await openModal('入出金リストをリセット', () => {
    ch = choiceGroup([
      {value:'both',label:'iDeCoとNISAの両方',desc:`iDeCo ${cnt(0)}件・NISA ${cnt(1)}件をすべて消します`},
      {value:'0',label:'iDeCoだけ',desc:`iDeCoの入出金 ${cnt(0)}件を消します`},
      {value:'1',label:'NISAだけ',desc:`NISAの入出金 ${cnt(1)}件を消します`}],'both');
    return [ch.element,el('p',null,'iDeCo・NISAの拠出金や評価額などの記録は消えません。消した入出金は元に戻せないので、心配なときは先に「メニュー → データの保存・読み込み → 保存」でバックアップしてください。')];
  }, [{label:'キャンセル',value:null},{label:'リセットする',value:'ok',cls:'danger'}]);
  if (r !== 'ok') return;
  const next = structuredClone(data);
  for (const i of ch.value === 'both' ? [0,1] : [Number(ch.value)]) delete next.tabs[i].flows;
  if (commit(next)) { render(); toast('入出金リストをリセットしました'); }
};
// OCR の文字から「日付 → 金額」の組を順番に取り出す（日付の行ごとに区切る）
// head：日付より前にある金額（上で切れた明細）、tail：金額のない最後の日付（下で切れた明細）
// 区分：写真の色ラベルから付けた [[OUT]] / [[IN]] を優先。配当は「NISA」「配当」の文字で判断
const flowType = t => /\[\[OUT\]\]/.test(t) ? 'out' : /nisa|配当|分配|dividend/i.test(t) ? 'div' : 'in';
// 明細の写真で、日付の下にある「入金」「出金」ラベルの色を見て区分を付ける
// （証券会社の画面は 入金＝水色、出金＝ピンク のラベル）
async function annotateFlowText(file, data) {
  const lines = (data.blocks || []).flatMap(b => b.paragraphs || []).flatMap(p => p.lines || []);
  if (!lines.length) return data.text;
  let img;
  try {
    const bmp = await createImageBitmap(file);
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d',{willReadFrequently:true}); ctx.drawImage(bmp,0,0);
    img = ctx.getImageData(0,0,cv.width,cv.height);
  } catch { return lines.map(l => l.text.replace(/\n$/,'')).join('\n'); }
  const W = img.width, H = img.height, px = img.data;
  const dateRe = /(\d{4})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})/;
  const isDate = l => dateRe.test(l.text.normalize('NFKC'));
  const out = lines.map(l => l.text.replace(/\n$/,''));
  lines.forEach((l,i) => {
    if (!isDate(l)) return;
    const next = lines.slice(i+1).find(isDate);
    const y0 = Math.max(0,l.bbox.y1), y1 = Math.min(H,next ? next.bbox.y0 : l.bbox.y1 + (l.bbox.y1 - l.bbox.y0) * 6);
    const yEnd = Math.min(y1,y0 + Math.max(20,(y1 - y0) * 0.55));
    const x1 = Math.min(W,Math.round(W * 0.25));
    let pink = 0, blue = 0;
    for (let y = Math.round(y0); y < yEnd; y += 2) for (let x = 0; x < x1; x += 2) {
      const k = (y * W + x) * 4, r = px[k], g = px[k+1], b = px[k+2];
      if (r > 190 && r - g > 22 && r - b > 18) pink++;
      else if (b > 190 && b - r > 18 && g >= r) blue++;
    }
    if (pink > 30 && pink > blue * 1.5) out[i] += ' [[OUT]]';
    else if (blue > 30 && blue > pink * 1.5) out[i] += ' [[IN]]';
  });
  return out.join('\n');
}
function parseFlows(text) {
  const lines = text.normalize('NFKC').split(/\n+/);
  const items = [];
  let cur = null, head = null, headText = '';
  const dateRe = /(\d{4})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})/;
  const amountIn = ln => { const n = ln.replace(/(\d)[.](\d{3})/g,'$1,$2').match(/\d{1,3}(?:,\d{3})+|\d{3,}/g); return n ? Number(n.at(-1).replaceAll(',','')) : null; };
  for (const ln of lines) {
    const dm = ln.match(dateRe);
    if (dm && +dm[2] >= 1 && +dm[2] <= 12 && +dm[3] >= 1 && +dm[3] <= 31) {
      if (cur && cur.amount === null && cur.small !== null) cur.amount = cur.small;
      if (cur && cur.amount !== null) items.push(cur);
      let y = +dm[1];
      if (y < 2000 || y > thisYear) y = thisYear;   // 年の読み違い
      cur = {date:`${y}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}`,amount:null,small:null,text:ln};
      continue;
    }
    const a = amountIn(ln);
    if (!cur) { headText += ' ' + ln; if (a !== null) head = a; continue; }
    cur.text += ' ' + ln;
    if (a !== null) { if (cur.amount === null) cur.amount = a; }   // 日付のあとで最初に出てくる金額（後ろの注意書きなどの数字は使わない）
    else if (cur.amount === null) { const sm = ln.normalize('NFKC').match(/[^\d,]\s(\d{1,2})\s*\S{0,3}\s*$/); if (sm) cur.small = Number(sm[1]); }   // 6円・33円などの小さい金額
  }
  let tail = null;
  if (cur && cur.amount === null && cur.small !== null) cur.amount = cur.small;
  if (cur && cur.amount !== null) items.push(cur); else if (cur) tail = cur;
  return {items:items.map(f => ({date:f.date,amount:f.amount,type:flowType(f.text)})),head,headText,tail};
}
// 同じ日付・金額・区分は1件だけ残す
const flowKey = f => f.date + '|' + f.amount + '|' + f.type;
function uniqueFlows(list) {
  const seen = new Set(), out = [];
  for (const f of list) { const k = flowKey(f); if (!seen.has(k)) { seen.add(k); out.push(f); } }
  return out;
}
// 入出金リストでの読み取り：明細の画面は入出金に、資産の画面は iDeCo / NISA の値として反映する
const textValues = text => [...new Set((text.normalize('NFKC').replace(/[−–]/g,'-').match(/[+\-△▲]?\d[\d,]*/g) ?? []).map(money).filter(validMoney))].filter(v => Math.abs(v) >= 10).slice(0,40);
function screenDate(text) {
  const dm = text.normalize('NFKC').match(/(20\d{2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})/);
  let d = dm && +dm[2] >= 1 && +dm[2] <= 12 && +dm[3] >= 1 && +dm[3] <= 31 ? `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}` : todayStr;
  if (d !== todayStr && !d.startsWith(thisYear+'-')) { const fix = thisYear + d.slice(4); d = fix <= todayStr ? fix : todayStr; }
  return d;
}
// iDeCo：資産残高 = 拠出金累計 + 損益 となる組（画面では 資産残高 → 拠出金累計 → 損益 の順）
function idecoTriple(values) {
  let best = null;
  const pos = v => { const i = values.indexOf(v); return i < 0 ? values.indexOf(-v) : i; };
  for (const a of values) if (a > 0) for (const t of values) {
    if (t <= 0 || t === a) continue;
    const p = a - t;
    if (p === 0 || p === a || pos(p) < 0 || pos(p) === values.indexOf(t)) continue;
    const score = (values.indexOf(a) < values.indexOf(t) ? 1 : 0) + (values.indexOf(t) < pos(p) ? 2 : 0);
    if (!best || score > best.score || (score === best.score && a > best.a)) best = {a,t,p,score};
  }
  return best;
}
async function importScans(texts, status, extra = []) {
  const statements = [], assets = [], msgs = [];
  for (const t of texts) (parseFlows(t).items.length >= 2 ? statements : assets).push({text:t,date:screenDate(t)});
  assets.sort((x,y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
  for (const a of assets) {
    const values = textValues(a.text), d = a.date.replaceAll('-','/');
    const tri = idecoTriple(values);
    if (tri) {
      registerEval({value:tri.p,total:tri.t,date:a.date},0);
      msgs.push(`iDeCo（${d}時点）：拠出金累計 ${yen(tri.t)}・損益 ${format(tri.p,true)} を反映`);
    } else if (flowTarget === 1) {
      const pool = values.filter(v => v >= 100 && !(v >= 1990 && v <= 2100));
      if (pool.length) { const w = Math.max(...pool); registerEval({worth:w,date:a.date},1); msgs.push(`NISA（${d}時点）：評価額 ${yen(w)} を反映`); }
      else msgs.push(`${d}の画面：金額を見つけられませんでした`);
    } else {
      msgs.push(`${d}の画面：iDeCoの拠出金累計と損益を見つけられませんでした（iDeCoの画面の「修正」から入力できます）`);
    }
  }
  status.textContent = msgs.length ? msgs.join(' ／ ') + (statements.length ? ' ／ 入出金明細を確認してください。' : '。') : '読み取りました。内容を確認してください。';
  if (statements.length || extra.length) await importFlows(statements.map(x => x.text),msgs,extra);
}
async function importFlows(texts, prior = [], extra = []) {
  let raw = [...extra], joined = 0, cut = 0, tail = null;
  for (const t of texts) {
    const r = parseFlows(t);
    if (tail && r.head !== null) {          // 前の写真の下で切れた日付 ＋ 次の写真の上の金額 → 1件にする
      raw.push({date:tail.date,amount:r.head,type:flowType(tail.text + r.headText)}); joined++;
    } else if (r.head !== null) cut++;
    if (tail && r.head === null) cut++;
    raw.push(...r.items);
    tail = r.tail;
  }
  if (tail) cut++;
  const found = uniqueFlows(raw), dupInBatch = raw.length - found.length;
  if (!found.length) { $('flowStatus').textContent = '日付と金額の組を見つけられませんでした。明細の部分を大きめに撮り直すか、手で追加してください。'; return; }
  const notes = [];
  if (dupInBatch) notes.push(`写真どうしで重なっていた${dupInBatch}件は1件にまとめました`);
  if (joined) notes.push(`写真の境目で切れていた${joined}件はつなぎ合わせました`);
  if (cut) notes.push(`日付か金額が切れていた${cut}件は除きました`);
  const tab = flowTab(), have = tab.flows || [];
  const isDup = f => have.some(h => h.date === f.date && h.amount === f.amount && h.type === f.type);
  const rows = [];
  let dest = null;
  const r = await openModal('入出金を取り込む', () => {
    // 取り込み先（iDeCo / NISA）。NISAの明細はNISAに、iDeCoの明細はiDeCoに分けて記録する
    dest = choiceGroup([
      {value:0,label:'iDeCoに取り込む',desc:'iDeCoの入出金として記録'},
      {value:1,label:'NISAに取り込む',desc:'NISA・証券口座の入出金として記録'}],flowTarget);
    const wrap = el('div','import-list');
    for (const f of found) {
      const dup = isDup(f);
      const row = el('div','import-row' + (dup ? ' dup' : ''));
      const ck = document.createElement('input'); ck.type = 'checkbox'; ck.checked = !dup;
      const main = el('div','ir-main');
      const l1 = el('div','ir-line');
      const dIn = document.createElement('input'); dIn.type = 'date'; dIn.value = f.date;
      const aIn = document.createElement('input'); aIn.inputMode = 'numeric'; aIn.value = f.amount.toLocaleString('ja-JP');
      const sel = document.createElement('select');
      for (const [k,v] of Object.entries(FLOW_TYPES)) sel.add(new Option(v,k));
      sel.value = f.type;
      const l2 = el('div','ir-line');
      l2.append(aIn,el('span','yen-unit','円'));
      l1.append(dIn,sel);
      main.append(l1,l2);
      if (dup) main.append(el('small',null,'すでに登録済み（重複）'));
      row.append(ck,main);
      wrap.append(row);
      rows.push({ck,dIn,aIn,sel,note:f.note});
    }
    return [el('label',null,'取り込み先'),dest.element,
      el('p',null,`${found.length}件見つかりました。入金・出金・配当の区分と金額を確かめて、取り込む行にチェックを入れてください。`),
      ...(notes.length ? [el('p','save-scope',notes.join('。') + '。')] : []),wrap];
  }, [{label:'キャンセル',value:null},{label:'取り込む',value:'ok',cls:'primary'}]);
  if (r !== 'ok') { $('flowStatus').textContent = '取り込みをやめました。'; return; }
  if (dest.value !== flowTarget) { flowTarget = dest.value; rememberUi(); }
  const next = structuredClone(data), t = next.tabs[flowTarget];
  t.flows = t.flows || [];
  let added = 0, skipped = 0, bad = 0;
  const at = Date.now();
  for (const x of rows) {
    if (!x.ck.checked) continue;
    const amount = money(x.aIn.value), date = x.dIn.value;
    if (!validMoney(amount) || amount < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { bad++; continue; }
    const f = {id:flowId(),date,amount,type:x.sel.value,at};
    if (x.note) f.note = String(x.note).slice(0,60);
    if (t.flows.some(h => h.date === f.date && h.amount === f.amount && h.type === f.type)) { skipped++; continue; }
    t.flows.push(f); added++;
  }
  const before = t.flows.length;
  t.flows = uniqueFlows(t.flows);
  skipped += before - t.flows.length;
  added = Math.min(added,t.flows.length);
  if (!added) { $('flowStatus').textContent = skipped ? 'すべて登録済みでした。' : '取り込む行がありませんでした。'; return; }
  if (commit(next)) {
    render();
    $('flowStatus').textContent = [...prior,`入出金 ${added}件を取り込みました` + (skipped ? `（重複${skipped}件は除外）` : '') + (bad ? `・金額や日付が読めない${bad}件は除外` : '')].join(' ／ ') + '。';
    toast(`${added}件を取り込みました`);
  }
}
async function editFlow(id) {
  const tab = flowTab(), cur = id ? (tab.flows || []).find(f => f.id === id) : null;
  let dIn, aIn, nIn, ch;
  const r = await openModal(cur ? '入出金を修正' : '入出金を追加', () => {
    const f = (label, node) => { const l = el('label',null,label); l.append(node); return l; };
    dIn = document.createElement('input'); dIn.type = 'date'; dIn.value = cur?.date || todayStr;
    aIn = document.createElement('input'); aIn.inputMode = 'numeric'; aIn.placeholder = '例 50,000'; aIn.value = cur ? cur.amount.toLocaleString('ja-JP') : '';
    nIn = document.createElement('input'); nIn.maxLength = 60; nIn.placeholder = '例 ゆうちょ銀行から入金・○○の配当'; nIn.value = cur?.note || '';
    ch = choiceGroup(Object.entries(FLOW_TYPES).map(([k,v]) => ({value:k,label:v,desc:''})),cur?.type || 'in');
    return [f('日付',dIn),el('label',null,'区分'),ch.element,f('金額（円）',aIn),f('メモ（任意）',nIn)];
  }, [...(cur ? [{label:'削除',value:'del',cls:'danger'}] : []),{label:'キャンセル',value:null},{label:'保存',value:'save',cls:'primary'}]);
  const next = structuredClone(data), t = next.tabs[flowTarget];
  if (r === 'del') {
    if (!await confirmBox('入出金を削除',`${ymd(cur.date)} の ${FLOW_TYPES[cur.type]} ${yen(cur.amount)} を削除します。`,'削除する',true)) return;
    t.flows = t.flows.filter(f => f.id !== id);
    if (commit(next)) { render(); toast('削除しました'); }
    return;
  }
  if (r !== 'save') return;
  const amount = money(aIn.value), date = dIn.value;
  if (!validMoney(amount) || amount < 0) { alertBox('金額を確認してください','0以上の整数で入力してください。'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alertBox('日付を確認してください','日付を選んでください。'); return; }
  const f = {id:cur?.id || flowId(),date,amount,type:ch.value,at:Date.now()};
  if (nIn.value.trim()) f.note = nIn.value.trim();
  t.flows = cur ? t.flows.map(x => x.id === id ? f : x) : [...(t.flows || []),f];
  if (t.flows.filter(x => flowKey(x) === flowKey(f)).length > 1) { alertBox('同じ記録があります','同じ日付・区分・金額の記録がすでにあるため、1件だけ残します。'); t.flows = uniqueFlows(t.flows); }
  if (commit(next)) { if (!date.startsWith(year+'-')) year = Number(date.slice(0,4)); render(); toast('保存しました'); }
}

/* ---------- 保有株式（株式解析アプリと共有） ---------- */
// 株式解析（同じサイトの ../）は保有株を localStorage の "stockscope2" に保存している。
// 台帳からも同じ場所を読み書きして、どちらで変えても両方に反映されるようにする。
const SCOPE_KEY = 'stockscope2';
const scopeState = () => { try { return JSON.parse(localStorage.getItem(SCOPE_KEY) || '{}') || {}; } catch { return {}; } };
function scopeWrite(fn) {
  const st = scopeState();
  st.hold = st.hold || {};
  fn(st);
  try { localStorage.setItem(SCOPE_KEY,JSON.stringify(st)); return true; } catch { alertBox('保存できませんでした','ブラウザの保存領域を使えません。'); return false; }
}
let priceIndex = null;
fetch('../data/index.json?t=' + Date.now(),{cache:'no-store'}).then(r => r.ok ? r.json() : null).then(d => { if (d) { priceIndex = d; render(); } }).catch(() => {});
const priceOf = k => priceIndex?.stocks?.find(e => e.market + ':' + e.symbol === k)?.tech || null;
function stockRows() {
  const hold = scopeState().hold || {}, fx = priceOf('INDEX:USDJPY')?.close;
  return Object.entries(hold).map(([k,h]) => {
    const [market,symbol] = k.split(':'), rate = market === 'US' ? fx : 1, t = priceOf(k);
    const qty = Number(h.qty) || 0, unitCost = Number(h.cost) || 0;
    const value = t?.close && rate ? Math.round(t.close * qty * rate) : null;
    const cost = rate ? Math.round(unitCost * qty * rate) : null;
    return {k,market,symbol,name:h.name || symbol,qty,unitCost,account:h.account || '',value,cost,date:t?.date};
  }).sort((a,b) => (b.value || 0) - (a.value || 0));
}
function stockTotals(tab) {
  const rows = stockRows(), items = tab.items || [];
  const sv = rows.reduce((a,r) => a + (r.value ?? 0),0), sc = rows.reduce((a,r) => a + (r.value !== null ? r.cost ?? 0 : 0),0);
  const iv = items.reduce((a,x) => a + x.value,0), ic = items.reduce((a,x) => a + (x.cost ?? x.value),0);
  return {rows,items,worth:sv + iv,cost:sc + ic,stockValue:sv,itemValue:iv,missing:rows.filter(r => r.value === null).length};
}
// その月の最新として評価額・取得額を記録（値が変わったときだけ）
function snapshotStocks(tab, tot) {
  if (!priceIndex && tot.rows.length) return;
  if (!tot.rows.length && !tot.items.length) return;
  const mon = todayStr.slice(0,7);
  const last = [...(tab.evals || [])].filter(e => e.date.startsWith(mon)).sort((a,b) => (a.at || 0) - (b.at || 0)).at(-1);
  if (last && last.worth === tot.worth && last.total === tot.cost) return;
  const next = structuredClone(data);
  const t = next.tabs[2];
  t.evals = [...(t.evals || []).filter(e => e.date !== todayStr),{date:todayStr,worth:tot.worth,total:tot.cost,at:Date.now()}];
  if (commit(next)) renderSummary();
}
function renderStocks() {
  const tab = data.tabs[2], tot = stockTotals(tab);
  snapshotStocks(data.tabs[2],tot);
  const box = $('stockBox');
  const line = (label, node, note, cls) => {
    const d = el('div','ib-row'+(cls ? ' '+cls : ''));
    const v = el('div','ib-val'); v.append(node); if (note) v.append(el('small',null,note));
    d.append(el('span','ib-label',label),v); return d;
  };
  const pl = tot.worth - tot.cost, pb = el('b',null,format(pl,true)); color(pb,pl);
  const head = el('div','ib-head');
  head.append(el('b',null,'保有株式の合計'),el('small',null,priceIndex?.generatedAt ? '株価 ' + new Date(priceIndex.generatedAt).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) + ' 時点' : '株価を読み込み中…'));
  box.replaceChildren(head,
    line('評価額',el('b',null,yen(tot.worth)),`株式 ${yen(tot.stockValue)} ・ 証券など ${yen(tot.itemValue)}`,'ib-sum'),
    line('取得額',el('b',null,yen(tot.cost)),tot.missing ? `価格データのない ${tot.missing} 銘柄は含めていません` : ''),
    line('損益',pb,tot.cost > 0 ? pct(pl/tot.cost) : ''));
  // 株式
  const sr = $('stockRows'); sr.replaceChildren();
  if (!tot.rows.length) { const r = sr.insertRow(); const c = r.insertCell(); c.colSpan = 4; c.className = 'empty'; c.textContent = '株式解析に登録した保有株はまだありません。'; }
  for (const x of tot.rows) {
    const r = sr.insertRow(); r.className = 'clickable';
    r.onclick = () => editStock(x.k);
    const c = r.insertCell(); c.append(el('span',null,x.name),el('small','code',`${x.symbol}${x.account ? '・' + x.account : ''}`));
    cell(r,x.qty.toLocaleString('ja-JP') + '株');
    if (x.value !== null) { cell(r,yen(x.value)); cell(r,format(x.value - x.cost,true),x.value - x.cost); }
    else { cell(r,'価格なし').className = 'empty'; cell(r,''); }
  }
  // 証券など
  const ir = $('itemRows'); ir.replaceChildren();
  if (!tot.items.length) { const r = ir.insertRow(); const c = r.insertCell(); c.colSpan = 3; c.className = 'empty'; c.textContent = '投資信託・ETF・債券などをここに追加できます。'; }
  for (const x of tot.items) {
    const r = ir.insertRow(); r.className = 'clickable';
    r.onclick = () => editItem(x.id);
    const nc = r.insertCell(); nc.append(el('span',null,x.name),el('small','code',x.kind)); cell(r,yen(x.value));
    if (x.cost !== undefined) cell(r,format(x.value - x.cost,true),x.value - x.cost); else cell(r,'');
  }
  // 月ごと（その月の最新）
  const nr = $('snapRows'); nr.replaceChildren();
  for (let m=1;m<=12;m++) {
    const k = mk(year,m), w = monthEvalField(tab,k,'worth'), c0 = monthEvalField(tab,k,'total');
    const r = nr.insertRow();
    cell(r,m+'月');
    if (w !== null) { cell(r,yen(w)); cell(r,c0 !== null ? yen(c0) : ''); const d = w - (c0 ?? w); cell(r,c0 !== null ? format(d,true) : '',d); }
    else { cell(r,''); cell(r,''); cell(r,''); }
  }
  const lastIdx = year < thisYear ? 11 : year === thisYear ? now.getMonth() : -1, pts = [];
  for (let m=1;m<=12;m++) {
    const k = mk(year,m);
    pts.push(m-1 > lastIdx ? {base:null,value:null} : {base:monthEvalField(tab,k,'total'),value:monthEvalField(tab,k,'worth')});
  }
  let last = -1; pts.forEach((p,i) => { if (p.value !== null) last = i; });
  $('stockChart').replaceChildren(...plotChart(pts,last,$('stockChart').clientWidth));
}
async function editStock(k) {
  const h = (scopeState().hold || {})[k];
  if (!h) return;
  let qIn, cIn, aIn;
  const r = await openModal(h.name || k, () => {
    const f = (label, value, mode) => { const l = el('label',null,label); const i = document.createElement('input'); i.value = value; i.inputMode = mode; l.append(i); return [l,i]; };
    const [l1,a] = f('株数',String(h.qty ?? ''),'decimal'); qIn = a;
    const [l2,b] = f(k.startsWith('US:') ? '取得単価（ドル）' : '取得単価（円）',String(h.cost ?? ''),'decimal'); cIn = b;
    const [l3,c] = f('口座（任意）',h.account || '','text'); aIn = c;
    return [el('p',null,`${k.split(':')[1]}・株式解析と共有しています。ここで変えると株式解析にも反映されます。`),l1,l2,l3];
  }, [{label:'保有から外す',value:'del',cls:'danger'},{label:'キャンセル',value:null},{label:'保存',value:'save',cls:'primary'}]);
  if (r === 'del') {
    if (!await confirmBox('保有から外す',`「${h.name || k}」を保有株から外します。株式解析からも外れます。`,'外す',true)) return;
    if (scopeWrite(st => { delete st.hold[k]; st.removed = st.removed || {fav:[],hold:[]}; st.removed.hold = st.removed.hold || []; const code = k.split(':')[1]; if (!st.removed.hold.includes(code)) st.removed.hold.push(code); })) { render(); toast('保有から外しました'); }
    return;
  }
  if (r !== 'save') return;
  const qty = parseFloat(qIn.value.normalize('NFKC').replace(/,/g,'')), cost = parseFloat(cIn.value.normalize('NFKC').replace(/,/g,''));
  if (!(qty > 0) || !(cost >= 0)) { alertBox('数字を確認してください','株数は0より大きい数、取得単価は0以上の数で入力してください。'); return; }
  if (scopeWrite(st => { st.hold[k] = {...st.hold[k],qty,cost,account:aIn.value.trim()}; })) { render(); toast('保存しました（株式解析にも反映）'); }
}
async function editItem(id) {
  const tab = data.tabs[2], cur = id ? (tab.items || []).find(x => x.id === id) : null;
  let nIn, vIn, cIn, kind;
  const r = await openModal(cur ? '証券・投資信託など' : '証券・投資信託などを追加', () => {
    const f = (label, value, mode, ph) => { const l = el('label',null,label); const i = document.createElement('input'); i.value = value; i.inputMode = mode; i.placeholder = ph; l.append(i); return [l,i]; };
    const [l1,a] = f('名前',cur?.name || '','text','例 eMAXIS Slim 全世界株式'); nIn = a; a.maxLength = 40;
    kind = choiceGroup(ITEM_KINDS.map(k => ({value:k,label:k,desc:''})),cur?.kind || '投資信託');
    const [l2,b] = f('いまの評価額（円）',cur ? cur.value.toLocaleString('ja-JP') : '','numeric','例 500,000'); vIn = b;
    const [l3,c] = f('取得額（円・任意）',cur?.cost !== undefined ? cur.cost.toLocaleString('ja-JP') : '','numeric','買ったときの合計'); cIn = c;
    return [l1,el('label',null,'種類'),kind.element,l2,l3];
  }, [...(cur ? [{label:'削除',value:'del',cls:'danger'}] : []),{label:'キャンセル',value:null},{label:'保存',value:'save',cls:'primary'}]);
  const next = structuredClone(data), t = next.tabs[2];
  if (r === 'del') {
    if (!await confirmBox('削除',`「${cur.name}」を削除します。`,'削除する',true)) return;
    t.items = (t.items || []).filter(x => x.id !== id);
    if (commit(next)) { render(); toast('削除しました'); }
    return;
  }
  if (r !== 'save') return;
  const name = nIn.value.trim(), value = money(vIn.value), cost = cIn.value.trim() ? money(cIn.value) : undefined;
  if (!name) { alertBox('名前を入力してください','名前は空欄にできません。'); return; }
  if (!validMoney(value) || value < 0 || (cost !== undefined && (!validMoney(cost) || cost < 0))) { alertBox('金額を確認してください','0以上の整数で入力してください。'); return; }
  const item = {id:cur?.id || 'i' + Date.now().toString(36),name,kind:kind.value,value,at:Date.now()};
  if (cost !== undefined) item.cost = cost;
  t.items = cur ? t.items.map(x => x.id === id ? item : x) : [...(t.items || []),item];
  if (commit(next)) { render(); toast('保存しました'); }
}
$('addItem').onclick = () => editItem(null);
// 株式解析で保有株を変えたら（別のタブで開いていても）すぐ反映
addEventListener('storage',e => { if (e.key === SCOPE_KEY && isStocks(active)) render(); });

/* ---------- 入力 ---------- */
function money(text) {
  const normalized = String(text).normalize('NFKC').trim().replace(/\s|円/g,'').replace(/[−–ー‐]/g,'-').replace(/^[△▲]/,'-');
  return /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(normalized) ? Number(normalized.replaceAll(',','')) : NaN;
}
const readMoney = (id, emptyAs) => { const v = $(id).value.trim(); return v === '' && emptyAs !== undefined ? emptyAs : money(v); };
function updateCalc() {
  const calc = $('calc');
  if (active === -1 || isIdeco(active) || (current().mode || 'profit') !== 'cum') { calc.hidden = true; return; }
  const tab = current(), prev = previousRecord(tab,monthKey());
  const base = prev && prev.row.cum !== undefined ? prev.row.cum : readMoney('base',0);
  const cum = readMoney('cum');
  calc.hidden = false;
  calc.replaceChildren();
  if (!validMoney(cum) || !validMoney(base)) { calc.textContent = '証券会社の画面にある「評価損益」をそのまま入力すると、月間損益を自動で計算します。'; return; }
  const p = cum - base;
  const b = el('b',null,format(p,true));
  color(b,p);
  calc.append(`月間損益 = ${format(cum,true)} − ${format(base,true)} → `,b);
}
for (const id of ['cum','base']) $(id).addEventListener('input',updateCalc);
$('amount').addEventListener('input',() => { $('amount').classList.remove('prefill'); $('amountHint').textContent = ''; });
for (const id of ['amount','profit','cum','base']) $(id).addEventListener('blur',() => {
  const v = money($(id).value);
  if (validMoney(v)) $(id).value = v.toLocaleString('ja-JP');
});
document.querySelectorAll('.sign').forEach(b => b.onclick = () => {
  const input = $(b.dataset.for), v = money(input.value);
  if (validMoney(v) && v !== 0) input.value = (-v).toLocaleString('ja-JP');
  else if (!input.value.trim().startsWith('-')) input.value = '-' + input.value.trim();
  else input.value = input.value.trim().slice(1);
  updateCalc();
  input.focus();
});

$('entry').onsubmit = event => {
  event.preventDefault();
  const tab = current(), mode = tab.mode || 'profit', k = monthKey();
  const ideco = isIdeco(active), changing = ideco && $('change').checked;
  const amount = readMoney('amount',changing ? NaN : 0);
  if (month === 'all') {
    if (!validMoney(amount) || amount <= 0 || $('amount').value.trim() === '') { alertBox('毎月の投資額を確認してください','毎月の投資額を、1以上の整数で入力してください（例 40,000）。'); return; }
    const next = structuredClone(data);
    const t = next.tabs[active], from = year + '-01';
    t.schedule = [...(t.schedule || []).filter(x => x.from < from),{from,amount}];
    delete t.plan;
    if (commit(next)) {
      month = year === thisYear ? String(now.getMonth()+1).padStart(2,'0') : '01';
      render();
      toast(`${year}年1月から毎月 ${yen(amount)} にしました`);
    }
    return;
  }
  if (changing && (!validMoney(amount) || amount < 0)) { alertBox('拠出金を確認してください','変更後の毎月の拠出金を、0以上の整数で入力してください（例 23,000）。'); return; }
  if (!validMoney(amount) || amount < 0) { alertBox(ideco ? '拠出金を確認してください' : '投資額を確認してください','投資額は0以上の整数で入力してください（例 30,000）。投資がない月は空欄か0にします。'); return; }
  let row;
  if (ideco) {
    row = null;
  } else if (mode === 'profit') {
    const profit = readMoney('profit',0);
    if (!validMoney(profit)) { alertBox('損益を確認してください','月間運用損益は整数で入力してください。マイナスは「±」ボタンか「-」「△」で入力できます。'); return; }
    row = {amount,profit};
  } else {
    const cum = readMoney('cum');
    const prev = previousRecord(tab,k);
    const base = prev && prev.row.cum !== undefined ? prev.row.cum : readMoney('base',0);
    if (!validMoney(cum)) { alertBox('評価損益を確認してください','証券会社の画面にある評価損益（累計）を整数で入力してください。'); return; }
    if (!validMoney(base)) { alertBox('前月末の評価損益を確認してください','前月末の評価損益を整数で入力してください。初めて記録する口座なら0です。'); return; }
    row = {amount,profit:cum-base,cum};
  }
  if (ideco) {
    const next = structuredClone(data);
    const t = next.tabs[0];
    const setting = changing;
    if (setting) {
      t.schedule = [...(t.schedule || []).filter(x => x.from < k),{from:k,amount}];
      for (const key of Object.keys(t.months)) if (key >= k) t.months[key].amount = amount;
    } else if (amount !== scheduled(tab,k) || t.months[k]) {
      t.months[k] = {...(t.months[k] || {profit:0}),amount};
    }
    if (commit(next)) {
      closeScan();
      if (changing) $('change').checked = false;
      render();
      toast(setting ? `${year}年${Number(k.slice(5))}月から拠出金を ${yen(amount)} にしました` : `${year}年${Number(k.slice(5))}月の拠出金を保存しました`);
    }
    return;
  }
  const next = structuredClone(data);
  const t = next.tabs[active];
  if (ideco && (changing || !tab.schedule?.length)) {
    // 選んだ月から拠出金を変更：それ以降の記録の拠出金も書き換える
    t.schedule = [...(t.schedule || []).filter(x => x.from < k),{from:k,amount}];
    for (const key of Object.keys(t.months)) if (key >= k) t.months[key].amount = amount;
    const typed = mode === 'profit' ? $('profit').value.trim() !== '' : $('cum').value.trim() !== '';
    if (typed || t.months[k]) t.months[k] = row;
  } else {
    t.months[k] = row;
  }
  recalc(t);
  if (commit(next)) {
    closeScan();
    if (changing) $('change').checked = false;
    render();
    toast(ideco && (changing || !tab.schedule?.length) ? `${year}年${Number(month)}月から拠出金を ${yen(amount)} にしました` : `${year}年${Number(month)}月を保存しました`);
  }
};
$('change').onchange = () => {
  render();
  if ($('change').checked) $('month').focus();
};
$('month').onchange = () => { month = $('month').value; closeScan(); render(); };
$('prevYear').onclick = () => { if (year > 1900) { year--; closeScan(); render(); } };
$('nextYear').onclick = () => { if (year < 9999) { year++; closeScan(); render(); } };
$('yearLabel').onclick = () => { year = thisYear; closeScan(); render(); };

$('removeEntry').onclick = async () => {
  if (!await confirmBox('この月の記録を削除',`${current().name} の ${year}年${Number(month)}月の記録を削除しますか？`,'削除する',true)) return;
  const next = structuredClone(data);
  delete next.tabs[active].months[monthKey()];
  recalc(next.tabs[active]);
  if (commit(next)) { closeScan(); render(); toast('削除しました'); }
};
$('fillPlan').onclick = async () => {
  const tab = current();
  const lastMonth = year === thisYear ? now.getMonth()+1 : year < thisYear ? 12 : 0;
  const targets = [];
  for (let m=1;m<=lastMonth;m++) {
    const k = year+'-'+String(m).padStart(2,'0');
    if (!tab.months[k]) targets.push(k);
  }
  if (!targets.length) { alertBox('まとめて入力','この年の今月までに、未入力の月はありません。'); return; }
  const list = targets.map(k => Number(k.slice(5))+'月').join('・');
  if (!await confirmBox('毎月の額をまとめて入力',`${year}年の未入力の月（${list}）に、投資額 ${yen(tab.plan)}・損益 0 円で記録します。損益はあとで各月を開いて入力してください。`,'入力する')) return;
  const next = structuredClone(data);
  const t = next.tabs[active];
  for (const k of targets) {
    const row = {amount:tab.plan,profit:0};
    const prev = t.mode === 'cum' ? previousRecord(t,k) : null;
    if (prev && prev.row.cum !== undefined) row.cum = prev.row.cum; // 評価損益は前回と同じ値で仮置き
    t.months[k] = row;
  }
  recalc(next.tabs[active]);
  if (commit(next)) { render(); toast(targets.length+'か月分を入力しました'); }
};

/* ---------- 口座 ---------- */
async function addAccount() {
  if (data.tabs.length >= 24) { alertBox('追加できません','口座は24個までです。'); return; }
  const name = await askText('口座を追加','口座名','','例 特定口座・子ども');
  if (!name) return;
  const next = structuredClone(data);
  next.tabs.push({name,months:{}});
  if (commit(next)) { go(data.tabs.length-1); openAccountSettings(); }
}
async function openAccountSettings() {
  const tab = current();
  let nameInput, planInput, modeChoice;
  const result = await openModal('口座の設定', () => {
    const fixed = active < CORE_COUNT;
    const n = el('label',null,fixed ? '口座名（固定）' : '口座名');
    nameInput = document.createElement('input');
    nameInput.value = tab.name; nameInput.maxLength = 32;
    nameInput.disabled = fixed;
    n.append(nameInput);
    const p = el('label',null,'毎月の投資額（円・任意）');
    planInput = document.createElement('input');
    planInput.inputMode = 'numeric';
    planInput.placeholder = '例 40,000';
    planInput.value = tab.plan ? tab.plan.toLocaleString('ja-JP') : '';
    p.append(planInput);
    const ml = el('label',null,'損益の入力方式');
    modeChoice = choiceGroup([
      {value:'profit',label:'月間損益をそのまま入力',desc:'その月に増えた・減った金額を自分で入力します。'},
      {value:'cum',label:'評価損益（累計）から自動計算',desc:'証券会社の画面の「評価損益」を写すだけ。前月との差を月間損益として計算します。'}
    ], tab.mode || 'profit');
    if (isIdeco(active)) {
      const hist = el('div','history');
      hist.append(el('b',null,'拠出金の履歴'));
      const list = tab.schedule || [];
      if (!list.length) hist.append(el('span',null,'まだ設定されていません。入力画面で「変更」にチェックして設定します。'));
      list.forEach(x => hist.append(el('span',null,`${x.from.replace('-','年').replace(/^(\d+年)0?/,'$1')}月から　${yen(x.amount)}`)));
      if (list.length) hist.append(button('最後の変更を取り消す',() => { finish('undo'); },'danger-text'));
      const ev = el('div','history');
      ev.append(el('b',null,'損益・拠出金累計の記録'));
      const evs = tab.evals || [];
      if (!evs.length) ev.append(el('span',null,'まだありません。写真から読み取るか「損益・累計を入力」で記録します。'));
      evs.slice(-6).forEach(x => ev.append(el('span',null,`${x.date.replaceAll('-','/')}　` + [x.value !== undefined ? '損益 '+format(x.value,true) : '', x.total !== undefined ? '拠出金累計 '+yen(x.total) : ''].filter(Boolean).join(' ・ '))));
      if (evs.length) ev.append(button('最新の登録を取り消す',() => { finish('undoEval'); },'danger-text'));
      return [n,hist,ev];
    }
    if (isNisa(active)) {
      const ev = el('div','history');
      ev.append(el('b',null,'評価額の記録'));
      const evs = (tab.evals || []).filter(x => x.worth !== undefined);
      if (!evs.length) ev.append(el('span',null,'まだありません。写真から読み取るか「評価額を入力」で記録します。'));
      evs.slice(-6).forEach(x => ev.append(el('span',null,`${x.date.replaceAll('-','/')}　評価額 ${yen(x.worth)}`)));
      if (evs.length) ev.append(button('最新の記録を取り消す',() => { finish('undoEval'); },'danger-text'));
      return [n,p,ml,modeChoice.element,ev];
    }
    return [n,p,ml,modeChoice.element];
  }, [
    ...(active < CORE_COUNT ? [] : [{label:'口座を削除',value:'delete',cls:'danger'}]),
    {label:'キャンセル',value:null},
    {label:'保存',value:'save',cls:'primary'}
  ]);
  if (result === 'delete') return removeAccount();
  if (result === 'undoEval') {
    const sorted = [...tab.evals].sort((a,b) => (a.at || 0) - (b.at || 0) || (a.date < b.date ? -1 : 1));
    const last = sorted.at(-1);
    if (!await confirmBox('記録を取り消す',`${last.date.replaceAll('-','/')} の記録を取り消します。`,'取り消す',true)) return openAccountSettings();
    const next = structuredClone(data);
    const t = next.tabs[active];
    t.evals = t.evals.filter(x => !(x.date === last.date && (x.at || 0) === (last.at || 0)));
    if (!t.evals.length) delete t.evals;
    if (commit(next)) { render(); toast('取り消しました'); }
    return;
  }
  if (result === 'undo') {
    const last = tab.schedule.at(-1);
    if (!await confirmBox('拠出金の変更を取り消す',`${last.from.slice(0,4)}年${Number(last.from.slice(5))}月からの ${yen(last.amount)} を取り消します。すでに保存した月の金額はそのまま残ります。`,'取り消す',true)) return openAccountSettings();
    const next = structuredClone(data);
    next.tabs[active].schedule = next.tabs[active].schedule.slice(0,-1);
    if (!next.tabs[active].schedule.length) delete next.tabs[active].schedule;
    if (commit(next)) { render(); toast('取り消しました'); }
    return;
  }
  if (result !== 'save') return;
  const name = nameInput.value.trim();
  const plan = isIdeco(active) || planInput.value.trim() === '' ? (isIdeco(active) ? (tab.plan || 0) : 0) : money(planInput.value);
  if (!name) { await alertBox('口座名を入力してください','口座名は空欄にできません。'); return openAccountSettings(); }
  if (!validMoney(plan) || plan < 0) { await alertBox('毎月の投資額を確認してください','毎月の投資額は0以上の整数で入力してください。'); return openAccountSettings(); }
  const next = structuredClone(data);
  const t = next.tabs[active];
  if (active >= CORE_COUNT) t.name = name;
  if (plan) t.plan = plan; else delete t.plan;
  if (!isIdeco(active)) { if (modeChoice.value === 'cum') t.mode = 'cum'; else delete t.mode; }
  if (commit(next)) { render(); toast('口座の設定を保存しました'); }
}
async function removeAccount() {
  if (active < CORE_COUNT) return;
  if (!await confirmBox('口座を削除',`「${current().name}」と、この口座の全期間の記録を削除します。元に戻せません。`,'削除する',true)) return;
  const next = structuredClone(data);
  next.tabs.splice(active,1);
  if (commit(next)) { go(Math.min(active,data.tabs.length-1)); toast('口座を削除しました'); }
}
$('accountSettings').onclick = openAccountSettings;

/* ---------- 台帳 ---------- */
$('ledgerTitle').onclick = renameLedger;
async function renameLedger() {
  const title = await askText('台帳の名前','台帳の名前',book.ledgers[book.selected].title);
  if (!title) return;
  const next = structuredClone(book);
  next.ledgers[next.selected].title = title;
  if (saveBook(next)) renderTitle();
}
async function openLedgers() {
  const r = await openModal('台帳の切り替え', finish => {
    const menu = el('div','menu');
    book.ledgers.forEach((ledger,index) => {
      const s = untilSum(ledger.data.tabs,'9999-12');
      const b = button('',() => finish({pick:index}));
      b.setAttribute('aria-pressed',String(index === book.selected));
      b.append(el('b',null,ledger.title),el('span',null,`口座 ${ledger.data.tabs.length} ・ 元本 ${yen(s.amount)} ・ 損益 ${format(s.profit,true)}`));
      menu.append(b);
    });
    return [menu];
  }, [
    ...(book.ledgers.length > 1 ? [{label:'この台帳を削除',value:'delete',cls:'danger'}] : []),
    {label:'名前を変更',value:'rename'},
    {label:'＋ 台帳を追加',value:'new',cls:'primary'}
  ]);
  if (r?.pick !== undefined) { if (r.pick !== book.selected) { active = Math.min(active,book.ledgers[r.pick].data.tabs.length-1); switchBook({...book,selected:r.pick}); } }
  else if (r === 'rename') renameLedger();
  else if (r === 'new') {
    const title = await askText('台帳を追加','新しい台帳の名前','台帳 '+(book.ledgers.length+1));
    if (title) { active = 0; switchBook({...book,selected:book.ledgers.length,ledgers:[...book.ledgers,makeLedger(title)]}); }
  } else if (r === 'delete') {
    const t = book.ledgers[book.selected].title;
    if (!await confirmBox('台帳を削除',`「${t}」と、その中のすべての口座・記録を削除します。元に戻せません。心配なときは先に「データ → 全台帳を保存」でバックアップしてください。`,'削除する',true)) return;
    const ledgers = book.ledgers.filter((_,i) => i !== book.selected);
    active = 0;
    if (switchBook({version:2,selected:0,ledgers})) toast('台帳を削除しました');
  }
}

/* ---------- データ（保存・読み込み・CSV） ---------- */
async function download(name, content, type) {
  if (inArtifact) {
    try {
      const dl = await window.claude.use('downloads');
      if (dl) { await dl.save({filename:name,data:content}); return true; }
    } catch (e) { if (e?.code !== 'unavailable') return false; }
    alertBox('ファイルを保存できません','この画面ではファイルの保存が使えません。');
    return false;
  }
  const url = URL.createObjectURL(new Blob([content],{type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),30000);
  return true;
}
const downloadBackup = snapshot => download('out-invest-ledger.json',snapshot,'application/json');
const supportsLinkedFile = !inArtifact && typeof window.showSaveFilePicker === 'function';
let linkedFile;
let fileBusy = false;
function fileLink(mode, value) {
  return new Promise((resolve,reject) => {
    const open = indexedDB.open('out-invest-ledger-file',1);
    open.onupgradeneeded = () => open.result.createObjectStore('settings');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('settings',mode);
      const store = transaction.objectStore('settings');
      const request = mode === 'readonly' ? store.get('last-file') : store.put(value,'last-file');
      transaction.oncomplete = () => { db.close(); resolve(request.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}
/* ---------- フォルダに保存・前回の保存先から読み込み ----------
   ・パソコンのChrome/Edge：保存するフォルダを選び、次回の起動時にその保存先から自動で読み込む
   ・iPhone/iPad：共有メニューの「"ファイル"に保存」でフォルダを選ぶ（iCloud Drive を選ぶと Mac とも共有できる）
     起動時の自動読み込みはブラウザの決まりでできないため、前回の保存先のファイルを選び直してもらう */
const lastSaveKey = 'out-invest-ledger-lastsave';
const getLastSave = () => { try { return JSON.parse(localStorage.getItem(lastSaveKey) || 'null'); } catch { return null; } };
const setLastSave = v => { try { localStorage.setItem(lastSaveKey,JSON.stringify(v)); } catch {} };
const fmtTime = t => { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
const isTouchApple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const fullBackupText = () => JSON.stringify({...book,savedAt:Date.now()},null,2);
// 1つのファイルを、選んだフォルダへ保存する
async function saveToFolder(name, content, type, remember) {
  const blob = new Blob([content],{type});
  if (supportsLinkedFile) {
    try {
      const ext = name.split('.').pop();
      const handle = await window.showSaveFilePicker({suggestedName:name,types:[{description:ext === 'csv' ? '表（CSV）' : '台帳データ',accept:{[type]:['.'+ext]}}]});
      const w = await handle.createWritable(); await w.write(blob); await w.close();
      if (remember) { linkedFile = {handle}; try { await fileLink('readwrite',linkedFile); } catch {} }
      return 'folder';
    } catch (e) { if (e.name === 'AbortError') return null; }
  }
  if (navigator.share && navigator.canShare) {
    // iPhone/iPad：共有メニューの「"ファイル"に保存」でフォルダを選ぶ。
    // 共有メニューはボタンを押したその場でしか開けないため、専用のボタンを出して押してもらう
    let file = new File([blob],name,{type});
    if (!navigator.canShare({files:[file]})) file = new File([blob],name,{type:'text/plain'});
    if (navigator.canShare({files:[file]})) return await pickFolderByShare(file,name,content,type);
  }
  return await download(name,content,type) ? 'download' : null;
}
function pickFolderByShare(file, name, content, type) {
  return new Promise(res => {
    let done = false;
    const resolve = v => { if (!done) { done = true; res(v); } };
    openModal('保存先を選ぶ', finish => {
      const go = button('保存先を選ぶ',() => {
        // ここで直接共有メニューを開く（押した瞬間に呼ぶ必要がある）
        navigator.share({files:[file]}).then(() => { finish(null); resolve('share'); })
          .catch(e => { if (e.name !== 'AbortError') { toast('共有メニューを開けませんでした。ダウンロードで保存します'); finish(null); download(name,content,type).then(ok => resolve(ok ? 'download' : null)); } });
      },'primary big');
      const dl = button('ダウンロードフォルダに保存',() => { finish(null); download(name,content,type).then(ok => resolve(ok ? 'download' : null)); });
      return [el('p',null,`「${name}」を保存します。`),
        el('p','save-scope',isTouchApple
          ? '「保存先を選ぶ」を押すと共有メニューが開きます。一覧の下の方にある「"ファイル"に保存」を選び、保存するフォルダ（iCloud Drive の中のフォルダなど）を選んで「保存」を押してください。'
          : '「保存先を選ぶ」で共有メニューが開きます。フォルダを選んで保存したいときは「ダウンロードフォルダに保存」を選び、ブラウザの設定で保存場所を「毎回確認」にしてください。'),
        go,dl];
    }, [{label:'キャンセル',value:'cancel'}]).then(v => { if (v === 'cancel') resolve(null); else setTimeout(() => resolve(null),60000); });
  });
}
function showSyncBanner(kind, text) {
  const bn = $('syncBanner');
  bn.hidden = false;
  bn.dataset.kind = kind;
  $('syncText').textContent = text;
  $('syncPick').textContent = kind === 'permit' ? '保存先から読み込む' : '保存先のファイルを選ぶ';
}
const hideSyncBanner = () => { $('syncBanner').hidden = true; };
// 保存ファイルの内容を反映（全台帳＝置き換え、1台帳＝同じ名前を置き換えか追加）
async function applySavedFile(text, label, auto) {
  const imported = JSON.parse(text);
  if (imported?.version === 1) {
    const ledger = makeLedger(imported.title || label.replace(/\.json$/i,'') || defaultTitle,validate(imported));
    const i = book.ledgers.findIndex(l => l.title === ledger.title);
    if (i >= 0) {
      if (!auto && !await confirmBox('台帳を置き換え',`「${ledger.title}」を保存ファイルの内容で置き換えます。`,'置き換える',true)) return false;
      const ledgers = book.ledgers.map((l,j) => j === i ? ledger : l);
      return switchBook({...book,selected:i,ledgers});
    }
    active = 0;
    return switchBook({...book,selected:book.ledgers.length,ledgers:[...book.ledgers,ledger]});
  }
  const next = validateBook(imported);
  const fileAt = Number(imported.savedAt) || 0, localAt = getLocalAt();
  if (!auto && fileAt && localAt > fileAt + 1000 &&
      !await confirmBox('端末のデータの方が新しいです',`保存ファイル（${fmtTime(fileAt)}）より、この端末のデータ（${fmtTime(localAt)}）の方が新しいです。保存ファイルの内容で置き換えますか？`,'置き換える',true)) return false;
  if (auto && fileAt && localAt >= fileAt) return 'same';
  active = Math.min(Math.max(active,0),next.ledgers[next.selected].data.tabs.length-1);
  return switchBook(next);
}
// 起動時：前回の保存先から読み込む
async function restoreLinkedFile(interactive = false) {
  if (fileBusy) return;
  const last = getLastSave();
  if (!supportsLinkedFile) {
    if (last?.scope === 'all' && !interactive) showSyncBanner('pick',`前回の保存：「${last.name}」（${fmtTime(last.at)}）。最新を反映するには、保存したフォルダのファイルを選んでください。いまは端末に残っているデータを表示しています。`);
    return;
  }
  fileBusy = true;
  try {
    if (!interactive) linkedFile = await fileLink('readonly');
    if (!linkedFile?.handle) { if (last?.scope === 'all') showSyncBanner('pick',`前回の保存先が分かりません。保存したファイルを選び直してください。いまは端末に残っている以前のデータを表示しています。`); return; }
    const {handle} = linkedFile;
    const permission = interactive ? await handle.requestPermission({mode:'read'}) : await handle.queryPermission({mode:'read'});
    if (permission !== 'granted') { showSyncBanner('permit',`前回の保存先「${handle.name}」から読み込むには、ボタンを押して許可してください。いまは端末に残っているデータを表示しています。`); return; }
    let file;
    try { file = await handle.getFile(); }
    catch { showSyncBanner('pick',`前回の保存先に「${handle.name}」が見つかりません。読み取るファイルを指定し直してください。いまは端末に残っている以前のデータを表示しています。`); return; }
    if (file.size > 50000000) throw Error('ファイルが大きすぎます。');
    const r = await applySavedFile(await file.text(),file.name,true);
    hideSyncBanner();
    $('status').textContent = r === 'same' ? `保存先と同じ（${handle.name}）` : `保存先から読み込みました（${handle.name}）`;
    if (r === true) toast('前回の保存先から読み込みました');
  } catch {
    showSyncBanner('pick','保存先のファイルを読み込めませんでした。読み取るファイルを指定し直してください。いまは端末に残っている以前のデータを表示しています。');
  } finally {
    fileBusy = false;
  }
}
$('reconnect').onclick = () => restoreLinkedFile(true);
$('syncPick').onclick = () => { if ($('syncBanner').dataset.kind === 'permit') restoreLinkedFile(true); else $('backup').click(); };
$('syncClose').onclick = hideSyncBanner;
function csvText() {
  const q = v => /[",\n]/.test(String(v)) ? '"' + String(v).replaceAll('"','""') + '"' : String(v);
  const lines = [['台帳','口座','年月','投資額','月間運用損益','評価損益（累計）'].join(',')];
  for (const ledger of book.ledgers) for (const tab of ledger.data.tabs) for (const k of Object.keys(monthsOf(tab)).sort()) {
    const r = monthsOf(tab)[k];
    lines.push([ledger.title,tab.name,k,r.amount,r.profit,r.cum ?? ''].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n');
}
const safeName = t => t.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/\s+/g,' ').trim().slice(0,80);
const backups = () => cloud.ref ? cloud.ref.collection('backups') : null;
async function writeFile(name, content, type) {
  // パソコンのブラウザ（ZIP版）は保存先フォルダを選ぶ画面を出す
  if (supportsLinkedFile) {
    try {
      const ext = name.split('.').pop();
      const handle = await window.showSaveFilePicker({suggestedName:name,types:[{description:ext === 'csv' ? '表（CSV）' : '台帳バックアップ',accept:{[type]:['.'+ext]}}]});
      const w = await handle.createWritable(); await w.write(content); await w.close();
      return true;
    } catch (e) { if (e.name === 'AbortError') return false; }
  }
  return download(name,content,type);
}
function flowsCsvText() {
  const q = v => /[",\n]/.test(String(v)) ? '"' + String(v).replaceAll('"','""') + '"' : String(v);
  const lines = [['台帳','口座','日付','区分','金額','メモ'].join(',')];
  for (const ledger of book.ledgers) for (const i of [0,1]) for (const f of [...(ledger.data.tabs[i]?.flows || [])].sort((a,b) => a.date < b.date ? -1 : 1))
    lines.push([ledger.title,ledger.data.tabs[i].name,ymd(f.date),FLOW_TYPES[f.type],f.amount,f.note || ''].map(q).join(','));
  return '﻿' + lines.join('\r\n');
}
async function openSave() {
  const cur = book.ledgers[book.selected];
  let tIn, scope, fmt;
  const r = await openModal('フォルダに保存', () => {
    scope = choiceGroup([
      {value:'all',label:'すべてまとめて',desc:`全${book.ledgers.length}台帳（${book.ledgers.map(x => x.title).join('・')}）のiDeCo・NISA・保有株式・入出金リストを1つのファイルに。次回の起動時にここから読み込みます。`},
      {value:'ledger',label:`この台帳だけ（${cur.title}）`,desc:'いま開いている台帳だけを保存します。'},
      {value:'flows',label:'入出金リストだけ',desc:'iDeCo・NISAの入出金を表（CSV）に。ExcelやNumbersで開けます。'}],'all');
    fmt = choiceGroup([
      {value:'json',label:'データ（JSON）',desc:'アプリで読み込んで元に戻せる形式'},
      {value:'csv',label:'表（CSV）',desc:'ExcelやNumbersで開ける一覧（読み込みには使えません）'}],'json');
    const l = el('label',null,'ファイル名（任意）');
    tIn = document.createElement('input'); tIn.id = 'saveTitle'; tIn.maxLength = 60; tIn.placeholder = '空欄なら自動で付けます';
    l.append(tIn);
    const how = el('p','save-scope', supportsLinkedFile
      ? '次の画面で保存するフォルダを選びます。'
      : isTouchApple ? '次に出る共有メニューで「"ファイル"に保存」を選び、フォルダを選んでください。iCloud Drive のフォルダにすると、iPhone・iPad・Mac で同じファイルを使えます。'
      : 'ダウンロードフォルダに保存されます。');
    return [el('label',null,'保存する内容'),scope.element,el('label',null,'形式'),fmt.element,l,how];
  }, [{label:'キャンセル',value:null},{label:'保存',value:'save',cls:'primary'}]);
  if (r !== 'save') return;
  const sc = scope.value, csv = sc === 'flows' || fmt.value === 'csv';
  const base = sc === 'all' ? `投資台帳_全台帳` : sc === 'ledger' ? `投資台帳_${cur.title}` : '投資台帳_入出金リスト';
  const name = (safeName(tIn.value) || `${base}_${todayStr}`) + (csv ? '.csv' : '.json');
  let content;
  if (sc === 'flows') content = flowsCsvText();
  else if (csv) content = sc === 'all' ? csvText() : (() => { const keep = book; book = {...book,ledgers:[cur]}; const t = csvText(); book = keep; return t; })();
  else content = sc === 'all' ? fullBackupText() : JSON.stringify({...cur.data,title:cur.title,savedAt:Date.now()},null,2);
  const how = await saveToFolder(name,content,csv ? 'text/csv' : 'application/json',sc === 'all' && !csv);
  if (!how) return;
  if (sc === 'all' && !csv) {
    try { localStorage.setItem(atKey,String(Date.now())); } catch {}
    setLastSave({name,at:Date.now(),scope:'all',how});
    hideSyncBanner();
  }
  toast(how === 'download' ? `「${name}」をダウンロードしました` : `「${name}」を保存しました`);
}
async function restoreFrom(text, label) {
  try {
    const next = validateBook(JSON.parse(text));
    if (!await confirmBox('この保存から復元',`いまのすべての台帳（${book.ledgers.length}件）を「${label}」の内容（${next.ledgers.length}件）で置き換えます。`,'置き換える',true)) return;
    active = 0;
    if (switchBook(next)) toast('復元しました');
  } catch (e) { alertBox('読み込めませんでした',e.message || '保存の形式を確認してください。'); }
}
async function openLoad() {
  let list = [];
  if (backups()) {
    try { list = (await backups().orderBy('savedAt','desc').limit(50).get()).docs.map(d => ({id:d.id,...d.data()})); } catch {}
  }
  const r = await openModal('読み込む', finish => {
    const menu = el('div','menu');
    const fb = button('',() => finish('file'));
    fb.append(el('b',null,'フォルダのファイルから読み込む'),el('span',null,'保存したJSON（すべて・台帳ごと）を選びます。台帳ごとのファイルは同じ名前の台帳を置き換えます。'));
    menu.append(fb);
    if (backups()) {
      menu.append(el('p',null,list.length ? 'アプリ内のクラウドの保存' : 'アプリ内のクラウドには、まだ保存がありません。'));
      for (const b of list) {
        const row = el('div','backup-row');
        const d = new Date(b.savedAt);
        const pick = button('',() => finish({restore:b}));
        let cnt = '';
        try { cnt = `・${JSON.parse(b.book).ledgers.length}台帳`; } catch {}
        pick.append(el('b',null,String(b.title || '無題')),el('span',null,`${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}${cnt}`));
        row.append(pick,button('削除',() => finish({remove:b}),'danger'));
        menu.append(row);
      }
    }
    return [menu];
  }, [{label:'閉じる',value:null}]);
  if (r === 'file') $('backup').click();
  else if (r?.restore) restoreFrom(r.restore.book,r.restore.title || '無題');
  else if (r?.remove) {
    if (!await confirmBox('クラウドの保存を削除',`「${r.remove.title || '無題'}」を削除します。元に戻せません。`,'削除する',true)) return openLoad();
    try { await backups().doc(r.remove.id).delete(); toast('削除しました'); } catch { alertBox('削除できませんでした','通信状態を確認して、もう一度お試しください。'); }
    openLoad();
  }
}
const openData = () => openModal('データ', finish => {
  const menu = el('div','menu');
  const item = (label, desc, action) => {
    const b = button('',() => { finish(null); action(); });
    b.append(el('b',null,label),el('span',null,desc));
    return b;
  };
  menu.append(
    item('フォルダに保存','すべてまとめて／この台帳だけ／入出金リストだけ を選んで、iPhone・iPad・Macのフォルダに保存',openSave),
    item('読み込む','ファイルや、アプリ内のクラウドの保存から復元します。',openLoad));
  return [menu, el('p',null, cloud.ref
    ? 'ふだんの記録はクラウドに自動で保存され、同じアカウントで開いた端末どうしで同期します。'
    : '記録はこのブラウザの中に保存されています。ときどき「保存」でバックアップしてください。')];
}, [{label:'閉じる',value:null}]);
/* ---------- 表示テーマ（端末に合わせる／ライト／ダーク） ---------- */
const themeKey = 'out-invest-ledger-theme';
const getTheme = () => { try { const t = localStorage.getItem(themeKey); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; } };
const THEME_NAMES = {auto:'端末に合わせる',light:'ライト',dark:'ダーク'};
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { if (t === 'auto') localStorage.removeItem(themeKey); else localStorage.setItem(themeKey,t); } catch {}
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.content = dark ? '#1f1d19' : '#f4eee2'; m.removeAttribute('media'); });
  render();
}
async function openTheme() {
  let ch;
  const r = await openModal('表示の色', () => {
    ch = choiceGroup([
      {value:'auto',label:'端末に合わせる',desc:'iPhoneの外観（ライト／ダーク）に合わせて切り替えます'},
      {value:'light',label:'ライト',desc:'少しベージュがかったノート紙'},
      {value:'dark',label:'ダーク',desc:'トーンを落としたノート紙'}],getTheme());
    return [ch.element];
  }, [{label:'キャンセル',value:null},{label:'決定',value:'ok',cls:'primary'}]);
  if (r === 'ok') { applyTheme(ch.value); toast('表示の色：' + THEME_NAMES[ch.value]); }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',() => { if (getTheme() === 'auto') applyTheme('auto'); });
const THEME_ICON = {auto:'◐ 自動',light:'☀ ライト',dark:'☾ ダーク'};
/* 文字の大きさ */
const fontKey = 'out-invest-ledger-font';
const FONT_NAMES = {s:'小',m:'中',l:'大',xl:'特大'};
const getFont = () => { try { const f = localStorage.getItem(fontKey); return FONT_NAMES[f] && f !== 'm' ? f : 'm'; } catch { return 'm'; } };
function applyFont(f) {
  if (f === 'm') delete document.documentElement.dataset.font; else document.documentElement.dataset.font = f;
  try { if (f === 'm') localStorage.removeItem(fontKey); else localStorage.setItem(fontKey,f); } catch {}
  render();
}
async function openFont() {
  let ch;
  const r = await openModal('文字の大きさ', () => {
    ch = choiceGroup([
      {value:'s',label:'小',desc:'たくさん表示したいとき'},
      {value:'m',label:'中',desc:'ふつうの大きさ'},
      {value:'l',label:'大',desc:'少し大きく読みやすく'},
      {value:'xl',label:'特大',desc:'いちばん大きく'}],getFont());
    return [ch.element];
  }, [{label:'キャンセル',value:null},{label:'決定',value:'ok',cls:'primary'}]);
  if (r === 'ok') { applyFont(ch.value); toast('文字の大きさ：' + FONT_NAMES[ch.value]); }
}
$('themeBtn').onclick = openTheme;
$('fontBtn').onclick = openFont;
function renderHeadBtns() {
  $('themeBtn').textContent = THEME_ICON[getTheme()];
  $('fontBtn').textContent = 'Aa ' + FONT_NAMES[getFont()];
}

$('menu').onclick = () => openModal('メニュー', finish => {
  const menu = el('div','menu');
  const item = (label, desc, action, pressed) => {
    const b = button('',() => { finish(null); action(); });
    b.append(el('b',null,label),el('span',null,desc));
    if (pressed) b.setAttribute('aria-pressed','true');
    return b;
  };
  menu.append(item('全体のようす','口座ごとの内訳と、元本・評価の推移',() => go(-1),active === -1));
  data.tabs.slice(CORE_COUNT).forEach((tab,i) => {
    const s = yearSum([tab]);
    menu.append(item(tab.name,`${year}年 投資 ${yen(s.amount)} ・ 損益 ${format(s.profit,true)}`,() => go(CORE_COUNT+i),active === CORE_COUNT+i));
  });
  menu.append(
    item('＋ 口座を追加','下の4口座のほかに口座をつくります',addAccount),
    item('台帳の切り替え',`いまの台帳：${book.ledgers[book.selected].title}`,openLedgers),
    item('データの保存・読み込み','バックアップ、復元、CSV書き出し',openData),
    item('株式解析を開く ↗','o-utのなんちゃって株式解析（保有株を共有）',() => { location.href = '../'; }));
  return [menu];
}, [{label:'閉じる',value:null}]);
const backupInput = document.createElement('input');
backupInput.type = 'file'; backupInput.accept = '.json,application/json'; backupInput.hidden = true; backupInput.id = 'backup';
document.body.append(backupInput);
backupInput.onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 50000000) throw Error('ファイルが大きすぎます。');
    const r = await applySavedFile(await file.text(),file.name,false);
    if (r) { hideSyncBanner(); toast('読み込みました'); $('status').textContent = `「${file.name}」を読み込みました`; }
  } catch (error) { alertBox('読み込めませんでした',error.message || 'ファイルの形式を確認してください。'); }
};

/* ---------- 写真から数字を読み取る（OCR） ---------- */
let loader;
function loadOcr() {
  loader ??= new Promise((resolve,reject) => {
    const script = document.createElement('script');
    script.src = 'ocr/tesseract.min.js';
    script.onload = resolve;
    script.onerror = () => { loader = undefined; reject(Error('OCRを準備できませんでした。')); };
    document.head.append(script);
  });
  return loader;
}
function closeScan() {
  scanRevision++;
  $('ocr').hidden = true;
  $('ocrStatus').textContent = '';
  $('candidates').replaceChildren();
}
function candidates(values) {
  const cum = (current().mode || 'profit') === 'cum';
  if (isNisa(active)) {
    // 評価額（資産残高）は画面でいちばん大きい金額
    const pool = values.filter(v => v >= 100 && !(v >= 1990 && v <= 2100));
    const best = pool.length ? Math.max(...pool) : null;
    const list = () => { for (const value of pool) {
      const row = document.createElement('div');
      row.append(el('span',null,yen(value)),button('評価額',() => { if (registerEval({worth:value,date:scanDate},1)) toast('評価額を反映しました'); }));
      $('candidates').append(row);
    } };
    if (best !== null && registerEval({worth:best,date:scanDate},1)) {
      $('ocrStatus').textContent = `${scanDate.replaceAll('-','/')}時点の評価額 ${yen(best)} を反映しました。`;
      const redo = button('違うときは数字を選び直す',() => { redo.remove(); list(); });
      $('candidates').append(redo);
    } else {
      $('ocrStatus').textContent = '評価額（資産残高）にあたる数字を選んでください。';
      list();
    }
    return;
  }
  if (isIdeco(active)) {
    // 評価額 = 拠出金累計 + 損益 になる組を探して自動で反映
    // 資産残高 = 拠出金累計 + 損益 となる組。画面では拠出金累計が損益より先に並ぶ
    let best = null;
    const pos = v => { const i = values.indexOf(v); return i < 0 ? values.indexOf(-v) : i; };
    for (const a of values) if (a > 0) for (const t of values) {
      if (t <= 0 || t === a) continue;
      const p = a - t;
      if (p === 0 || p === a || pos(p) < 0 || pos(p) === values.indexOf(t)) continue;
      const ia = values.indexOf(a), it = values.indexOf(t), ip = pos(p);
      const score = (ia < it ? 1 : 0) + (it < ip ? 2 : 0);
      if (!best || score > best.score || (score === best.score && a > best.a)) best = {a,t,p,score};
    }
    if (best && registerEval({value:best.p,total:best.t,date:scanDate})) {
      $('ocrStatus').textContent = `${scanDate.replaceAll('-','/')}時点：拠出金累計 ${yen(best.t)}・損益 ${format(best.p,true)} を反映しました（資産合計 ${yen(best.a)} と一致）。`;
      const redo = button('違うときは数字を選び直す',() => { redo.remove(); list(); });
      $('candidates').append(redo);
      return;
    } else {
      $('ocrStatus').textContent = '損益と拠出金累計にあたる数字を選んでください。選ぶとすぐ反映します。';
    }
    function list() { for (const value of values.filter(v => Math.abs(v) >= 100 && !(v >= 1990 && v <= 2100))) {
      const row = document.createElement('div');
      const asP = button('損益',() => { if (registerEval({value,date:scanDate})) toast('損益を反映しました'); });
      const asT = button('拠出金累計',() => { if (registerEval({total:value,date:scanDate})) toast('拠出金累計を反映しました'); });
      asT.disabled = value < 0;
      row.append(el('span',null,format(value,true)),asP,asT);
      $('candidates').append(row);
    } }
    list();
    return;
  }
  for (const value of values) {
    const row = document.createElement('div');
    const label = el('span',null,format(value,true));
    const assign = id => { $(id).value = value.toLocaleString('ja-JP'); $(id).classList.remove('prefill'); updateCalc(); toast((id === 'amount' ? '投資額' : cum ? '評価損益' : '損益')+'に入れました'); };
    const toAmount = button('投資額に入れる',() => assign('amount'));
    toAmount.disabled = value < 0;
    row.append(label,toAmount,button(cum ? '評価損益に入れる' : '損益に入れる',() => assign(cum ? 'cum' : 'profit')));
    $('candidates').append(row);
  }
}
let scanning = false;
let scanDate = todayStr;
async function scan(event) {
  const files = [...event.target.files];
  event.target.value = '';
  return scanFiles(files);
}
async function scanFiles(files, extra = []) {
  let file = files[0];
  if (!file || scanning) return;
  closeScan();
  const revision = scanRevision;
  const flowMode = active === FLOWS;
  const status = flowMode ? $('flowStatus') : $('ocrStatus');
  if (flowMode) status.hidden = false; else $('ocr').hidden = false;
  status.textContent = '写真から数字を読み取っています…';
  let worker;
  scanning = true;
  $('camera').disabled = $('photo').disabled = $('flowCamera').disabled = $('flowPhoto').disabled = true;
  try {
    await loadOcr();
    if (revision !== scanRevision) return;
    const root = new URL('ocr/',location.href);
    // 言語データは配信できる拡張子(.wasm)で置き、クエリ文字列でOCRに渡す
    worker = await Tesseract.createWorker('eng',1,{
      workerPath:new URL('worker.min.js',root).href,
      corePath:new URL('tesseract-core-lstm.wasm.js',root).href,
      langPath:new URL('eng-traineddata-gz.wasm?lang=',root).href,
      workerBlobURL:false, cacheMethod:'none'
    });
    if (revision !== scanRevision) return;
    if (flowMode) {
      // 入出金：複数枚をまとめて読み、写真の境目で切れた明細はつなぎ合わせる
      const texts = [];
      for (let i=0;i<files.length;i++) {
        status.textContent = `写真を読み取っています…（${i+1} / ${files.length}枚）`;
        const res = await worker.recognize(files[i],{},{text:true,blocks:true});
        texts.push(await annotateFlowText(files[i],res.data));
        if (revision !== scanRevision) return;
      }
      importScans(texts,status,extra);
      return;
    }
    // 何枚選んでも順に読む。画面の日付が古い順に反映し、いちばん新しいものが最新になるようにする
    const reads = [];
    for (let i=0;i<files.length;i++) {
      if (files.length > 1) status.textContent = `写真を読み取っています…（${i+1} / ${files.length}枚）`;
      const text = (await worker.recognize(files[i])).data.text;
      if (revision !== scanRevision) return;
      const dm = text.normalize('NFKC').match(/(20\d{2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})/);
      let d = dm && +dm[2] >= 1 && +dm[2] <= 12 && +dm[3] >= 1 && +dm[3] <= 31 ? `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}` : todayStr;
      // 年の数字は読み違えやすいので、今年の同じ月日が今日以前なら今年とみなす
      if (d !== todayStr && !d.startsWith(thisYear+'-')) { const fix = thisYear + d.slice(4); d = fix <= todayStr ? fix : todayStr; }
      const matches = text.normalize('NFKC').replace(/[−–]/g,'-').match(/[+\-△▲]?\d[\d,]*/g) ?? [];
      reads.push({date:d,values:[...new Set(matches.map(money).filter(validMoney))].filter(v => Math.abs(v) >= 10).slice(0,40)});
    }
    reads.sort((x,y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    const msgs = [];
    for (const r of reads) {
      scanDate = r.date;
      if (files.length > 1) $('candidates').append(el('p','scan-head',`${r.date.replaceAll('-','/')} の画面`));
      if (!r.values.length) { msgs.push(`${r.date.replaceAll('-','/')}：数字を検出できませんでした`); continue; }
      status.textContent = '原本の金額・符号と照らし合わせて、使う数字を選んでください。';
      candidates(r.values);
      msgs.push(status.textContent);
    }
    status.textContent = files.length > 1 ? `${files.length}枚を読み取りました。` + msgs.join(' ／ ') : (msgs[0] || '数字を検出できませんでした。撮り直すか、金額を手入力してください。');
  } catch {
    if (revision === scanRevision) status.textContent = inArtifact
      ? 'この画面では写真の読み取りを使えませんでした。金額を手入力してください。'
      : location.protocol === 'file:'
      ? '写真の読み取りは、README の手順でサーバーを起動して開いたときに使えます。'
      : '写真を読み取れませんでした。JPEG・PNGで再度お試しください。';
  } finally {
    file = null;
    try { if (worker) await worker.terminate(); }
    finally { scanning = false; $('camera').disabled = $('photo').disabled = $('flowCamera').disabled = $('flowPhoto').disabled = false; }
  }
}
$('clearOcr').onclick = closeScan;
$('toReader').onclick = () => { if (active === 0 || active === 1) { flowTarget = active; } go(FLOWS); };
for (const id of ['camera','photo']) {
  $(id).onclick = () => $(id+'File').click();
  $(id+'File').onchange = e => {
    // 入出金リストでは撮った写真も読み取り待ちにためる
    if (active === FLOWS) { const files = [...e.target.files]; e.target.value = ''; queueAdd(files); return; }
    return scan(e);
  };
}

/* ---------- 左右スライドで台帳を切り替え ---------- */
function slideLedger(dir) {
  const n = book.ledgers.length;
  if (n < 2) return;
  const to = ((book.selected + dir) % n + n) % n;   // 端まで来たら反対側へループ
  dir = Math.sign(dir);
  if (active >= 0) active = Math.min(active,book.ledgers[to].data.tabs.length-1);
  if (!switchBook({...book,selected:to})) return;
  const m = document.querySelector('main');
  m.classList.remove('slide-l','slide-r'); void m.offsetWidth;
  m.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
  toast(`${to+1} / ${book.ledgers.length}　${book.ledgers[to].title}`);
}
let touch = null;
document.addEventListener('touchstart',e => {
  if (e.touches.length !== 1 || $('modal').open) { touch = null; return; }
  if (e.target.closest('input,select,textarea')) { touch = null; return; }
  for (let n = e.target; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) { touch = null; return; }
  }
  touch = {x:e.touches[0].clientX,y:e.touches[0].clientY,t:Date.now()};
},{passive:true});
document.addEventListener('touchcancel',() => { touch = null; },{passive:true});
document.addEventListener('touchend',e => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y, dt = Date.now() - touch.t;
  touch = null;
  if (dt < 700 && Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) * 0.5) slideLedger(dx < 0 ? 1 : -1);
},{passive:true});

/* ---------- 起動 ---------- */
render();
let lastWidth = innerWidth, resizeTimer;
addEventListener('resize',() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (Math.abs(innerWidth-lastWidth) > 40) { lastWidth = innerWidth; render(); } },200); });
if (loadFailed) { $('status').textContent = '保存データを読み込めません'; alertBox('保存データを読み込めません','端末内のデータが壊れているか、形式が合いません。バックアップのJSONがあれば「データ → 読み込む」で復元してください。'); }
restoreLinkedFile();
cloudInit();
