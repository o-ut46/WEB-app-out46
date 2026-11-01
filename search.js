/* 銘柄検索：カタカナ・ひらがな・漢字・ローマ字・英字・コードのどれで入力しても候補を予測して並べる。
   入力が1文字増えるたびに予測し直す（app.js から呼ぶ）。 */
'use strict';
const SearchEngine = (() => {
  const nfkc = s => String(s || '').normalize('NFKC').toLowerCase();
  const hira2kata = s => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));

  // ---- かな → ローマ字（ヘボン式寄り）----
  const K = { ア:'a',イ:'i',ウ:'u',エ:'e',オ:'o',カ:'ka',キ:'ki',ク:'ku',ケ:'ke',コ:'ko',サ:'sa',シ:'shi',ス:'su',セ:'se',ソ:'so',
    タ:'ta',チ:'chi',ツ:'tsu',テ:'te',ト:'to',ナ:'na',ニ:'ni',ヌ:'nu',ネ:'ne',ノ:'no',ハ:'ha',ヒ:'hi',フ:'fu',ヘ:'he',ホ:'ho',
    マ:'ma',ミ:'mi',ム:'mu',メ:'me',モ:'mo',ヤ:'ya',ユ:'yu',ヨ:'yo',ラ:'ra',リ:'ri',ル:'ru',レ:'re',ロ:'ro',ワ:'wa',ヲ:'o',ン:'n',
    ガ:'ga',ギ:'gi',グ:'gu',ゲ:'ge',ゴ:'go',ザ:'za',ジ:'ji',ズ:'zu',ゼ:'ze',ゾ:'zo',ダ:'da',ヂ:'ji',ヅ:'zu',デ:'de',ド:'do',
    バ:'ba',ビ:'bi',ブ:'bu',ベ:'be',ボ:'bo',パ:'pa',ピ:'pi',プ:'pu',ペ:'pe',ポ:'po',ヴ:'vu',
    ァ:'a',ィ:'i',ゥ:'u',ェ:'e',ォ:'o',ャ:'ya',ュ:'yu',ョ:'yo',ヮ:'wa' };
  const Y = { ャ:'a', ュ:'u', ョ:'o' };
  function kanaToRomaji(s) {
    s = hira2kata(s); let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i], n = s[i + 1];
      if (c === 'ッ') { const r = K[n] || ''; out += r ? (r.startsWith('ch') ? 't' : r[0]) : ''; continue; }
      if (c === 'ー') { const v = out.match(/[aiueo]$/); out += v ? v[0] : ''; continue; }
      let r = K[c];
      if (r === undefined) { out += c; continue; }
      if (n && Y[n] && /i$/.test(r) && r.length > 1) { r = (/(shi|chi|ji)$/.test(r) ? r.slice(0, -1) : r.slice(0, -1) + 'y') + Y[n]; i++; }
      else if (n && 'ァィゥェォ'.includes(n) && r.length > 1) { r = r.replace(/[aiueo]$/, '') + K[n]; if (c === 'フ') r = 'f' + K[n]; i++; }
      out += r;
    }
    return out;
  }
  // 綴りの揺れをそろえる（toukyou=tokyo, si=shi, tu=tsu など）
  const romajiNorm = s => s.replace(/[^a-z0-9]/g, '')
    .replace(/sy/g, 'sh').replace(/ty/g, 'ch').replace(/zy|jy/g, 'j').replace(/tu/g, 'tsu').replace(/tsusu/g, 'tsu')
    .replace(/hu/g, 'fu').replace(/si/g, 'shi').replace(/shhi/g, 'shi').replace(/ti/g, 'chi').replace(/cchi|chhi/g, 'chi')
    .replace(/ou|oo|oh(?![aiueo])/g, 'o').replace(/uu/g, 'u').replace(/ei/g, 'e').replace(/ii/g, 'i').replace(/aa/g, 'a')
    .replace(/m(?=[bmp])/g, 'n');
  // 子音の骨組み（アップル≒apple、マイクロソフト≒microsoft のような外来語の読みを拾う）
  const skeleton = s => s.replace(/[^a-z]/g, '').replace(/ph/g, 'f').replace(/th/g, 's').replace(/ck/g, 'k').replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks').replace(/v/g, 'b').replace(/l/g, 'r').replace(/sh|ch|ts/g, 's').replace(/j/g, 'z').replace(/w/g, '')
    .replace(/[aeiouyh]/g, '').replace(/(.)\1+/g, '$1');

  const STOP = new Set(['inc', 'corp', 'corporation', 'co', 'ltd', 'company', 'holdings', 'holding', 'group', 'the', 'plc', 'class', 'common', 'stock', 'shares', 'trust', 'etf', 'fund', 'and']);
  function prepare(x) {
    const jp = hira2kata(nfkc(x.name)).replace(/\s+/g, '');
    const en = nfkc([x.en, x.market === 'US' ? x.name : ''].filter(Boolean).join(' '));
    const words = en.split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w));
    const kanaRoman = /[゠-ヿ]/.test(jp) ? romajiNorm(kanaToRomaji(jp.replace(/[^゠-ヿー]/g, ''))) : '';
    return { ...x, _c: nfkc(x.symbol), _jp: jp, _en: romajiNorm(words.join('')), _w: words.map(romajiNorm), _kr: kanaRoman,
      _sk: words.map(skeleton).filter(Boolean), _ska: skeleton(words.join('')), _ksk: kanaRoman ? skeleton(kanaRoman) : '' };
  }

  function query(raw, pool, limit) {
    const q0 = nfkc(raw).replace(/\s+/g, '');
    if (!q0) return [];
    const qJp = hira2kata(q0);
    const hasKana = /[゠-ヿ]/.test(qJp), ascii = /^[a-z0-9.\-^]+$/.test(q0);
    const qRo = romajiNorm(hasKana ? kanaToRomaji(qJp) : ascii ? q0 : '');
    const qSk = qRo ? skeleton(qRo) : '';
    const scored = [];
    for (const x of pool) {
      let s = 0;
      if (x._c === q0) s = 1000;
      else if (x._c.startsWith(q0)) s = 900 - x._c.length;
      if (x._jp.startsWith(qJp)) s = Math.max(s, 820 - x._jp.length);
      else if (x._jp.includes(qJp)) s = Math.max(s, 640 - x._jp.length);
      if (qRo.length >= 2) {
        if (x._w.some(w => w.startsWith(qRo)) || x._en.startsWith(qRo)) s = Math.max(s, (x._en.startsWith(qRo) ? 780 : 720) - x._en.length / 4);
        else if (x._kr && x._kr.startsWith(qRo)) s = Math.max(s, 760 - x._kr.length / 4);
        else if (qRo.length >= 4 && (x._en.includes(qRo) || x._kr.includes(qRo))) s = Math.max(s, 520);
      }
      if (!s && qSk.length >= 2 && (hasKana || qRo.length >= 4)) {
        if (x._sk[0] && x._sk[0].startsWith(qSk)) s = 400 - Math.abs(x._sk[0].length - qSk.length) * 8;
        else if (x._ska && (qSk.length >= 3 || qRo.length >= 6) && x._ska.startsWith(qSk)) s = 390;
        else if (x._ksk && x._ksk.startsWith(qSk)) s = 380;
        else if (qSk.length >= 3 && x._sk.some(w => w.startsWith(qSk))) s = 300;
      }
      if (s) scored.push([s + (x.market === 'JP' ? 2 : 0) + (x.segment && /プライム|NASDAQ$|NYSE$/.test(x.segment) ? 3 : 0), x]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(v => v[1]);
  }
  return { prepare, query, kanaToRomaji };
})();
