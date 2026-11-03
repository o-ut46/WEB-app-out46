"""Collect market/stock news from credible outlets and have Claude summarise it.

Outputs
  data/research.json  market overview (JP/US), featured stocks, per-stock news briefs, sources, usage
  data/prices/*.json  price history for featured stocks (also listed in data/index.json as kind=featured)

Needs the repository secret ANTHROPIC_API_KEY. Without it the step is skipped (the app still works).
Only headlines from the whitelisted outlets below and pages found by Claude's web search on the
whitelisted domains are used; every summary must cite at least one of them or it is dropped."""
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from common import DATA, ROOT, fetch_stock, http_get, now_iso, previous_published, read_json, save_record, write_json, yahoo_code

API_KEY = os.environ.get('ANTHROPIC_API_KEY', '').strip()
MODEL = os.environ.get('CLAUDE_MODEL', '').strip() or 'claude-sonnet-5-5'
MODEL_LIGHT = os.environ.get('CLAUDE_MODEL_LIGHT', '').strip() or 'claude-haiku-5-5'
GEMINI_KEY = os.environ.get('GEMINI_API_KEY', '').strip()
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', '').strip()
# Claude API (paid) if its key is set; otherwise Google Gemini API free tier (Google Search grounding included)
PROVIDER = 'claude' if API_KEY else 'gemini' if GEMINI_KEY else None
MAX_SEARCHES = int(os.environ.get('MAX_WEB_SEARCHES', '') or 6)
MAX_BRIEFS = int(os.environ.get('MAX_STOCK_BRIEFS', '') or 40)
JST = timezone(timedelta(hours=9))

# Outlets treated as credible: wire services, major business press, exchanges/regulators, securities firms' research.
# Bulletin boards, SNS, personal blogs and crowd-forecast sites are intentionally excluded.
NEWS_SOURCES_JP = ['nikkei.com', 'reuters.com', 'bloomberg.co.jp', 'kabutan.jp', 'toyokeizai.net', 'diamond.jp',
                   'media.rakuten-sec.net', 'nomura.co.jp', 'daiwa.jp', 'smbcnikko.co.jp', 'sbisec.co.jp',
                   'monex.co.jp', 'jpx.co.jp', 'nikkei225jp.com']
# second group (Google News queries get too long with every site in one query)
NEWS_SOURCES_JP2 = ['jiji.com', 'nhk.or.jp', 'fisco.co.jp', 'traders.co.jp', 'quick.co.jp', 'wealthadvisor.co.jp',
                    'mizuho-sc.com', 'okasan.co.jp', 'sbiaxes.com', 'jp.investing.com']
NEWS_SOURCES_US = ['reuters.com', 'apnews.com', 'cnbc.com', 'marketwatch.com', 'bloomberg.com', 'wsj.com', 'barrons.com']
WEB_SEARCH_DOMAINS = sorted(set(NEWS_SOURCES_JP + NEWS_SOURCES_US + ['finance.yahoo.co.jp/news', 'release.tdnet.info',
                                                                     'boj.or.jp', 'federalreserve.gov', 'sec.gov']) - {'nikkei225jp.com'})
NEWS_SOURCES_JP.remove('nikkei225jp.com')


def allowed(host, sources):
    host = host.lower()
    return any(host == s or host.endswith('.' + s) for s in sources)


# ---------------- Google News RSS (free, headlines only) ----------------

def google_news(query, sources, lang='ja', days=7, limit=8):
    sites = ' OR '.join('site:' + s for s in sources)
    q = f'{query} ({sites}) when:{days}d'
    if lang == 'ja':
        url = 'https://news.google.com/rss/search?q=' + urllib.parse.quote(q) + '&hl=ja&gl=JP&ceid=JP:ja'
    else:
        url = 'https://news.google.com/rss/search?q=' + urllib.parse.quote(q) + '&hl=en-US&gl=US&ceid=US:en'
    try:
        root = ET.fromstring(http_get(url, timeout=20, retries=1))
    except Exception as exc:
        print('news failed', query, exc)
        return []
    out, seen, now = [], set(), datetime.now(timezone.utc)
    for item in root.iter('item'):
        src = item.find('source')
        title = (item.findtext('title') or '').strip()
        link = (item.findtext('link') or '').strip()
        if src is None or not title or not link.startswith('https://'):
            continue
        host = urllib.parse.urlparse(src.get('url', '')).hostname or ''
        if not allowed(host, sources):
            continue
        try:
            date = parsedate_to_datetime(item.findtext('pubDate') or '')
        except Exception:
            continue
        if date > now + timedelta(hours=1) or now - date > timedelta(days=days):
            continue
        publisher = (src.text or host).strip()
        clean = re.sub(r'\s*[-－|｜]\s*' + re.escape(publisher) + r'\s*$', '', title)
        key = re.sub(r'[\s\W]+', '', clean).lower()
        if key in seen or re.search(r'噂|うわさ|未確認|rumou?r', clean, re.I):
            continue
        seen.add(key)
        out.append({'title': clean[:200], 'url': link, 'publisher': publisher, 'host': host,
                    'date': date.astimezone(JST).strftime('%Y-%m-%d')})
    out.sort(key=lambda x: x['date'], reverse=True)
    return out[:limit]


def short_name(name):
    name = re.sub(r'(株式会社|ホールディングス|グループ|\(株\)|（株）)', '', name)
    name = re.sub(r'\b(Inc\.?|Corp\.?|Corporation|Co\.?|Ltd\.?|plc|Holdings?|Class [A-C])\b', '', name, flags=re.I)
    return re.sub(r'\s+', ' ', name).strip(' ,.') or name


# ---------------- Claude Messages API ----------------

USAGE = {'input_tokens': 0, 'output_tokens': 0, 'cache_read_input_tokens': 0, 'web_search_requests': 0, 'calls': 0}


def claude(model, system, user, tools=None, max_tokens=8000):
    messages = [{'role': 'user', 'content': user}]
    blocks = []
    for _turn in range(6):  # pause_turn continuation for long web searches
        body = {'model': model, 'max_tokens': max_tokens, 'system': system, 'messages': messages}
        if tools:
            body['tools'] = tools
        data = None
        for attempt in range(4):
            req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=json.dumps(body).encode(),
                                         headers={'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
                                                  'content-type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=300) as res:
                    data = json.loads(res.read())
                break
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode('utf-8', 'replace')[:400]
                if exc.code in (429, 500, 502, 503, 529) and attempt < 3:
                    time.sleep(20 * (attempt + 1))
                    continue
                raise RuntimeError(f'Claude API HTTP {exc.code}: {detail}')
        USAGE['calls'] += 1
        u = data.get('usage', {})
        for k in ('input_tokens', 'output_tokens', 'cache_read_input_tokens'):
            USAGE[k] += u.get(k) or 0
        USAGE['web_search_requests'] += (u.get('server_tool_use') or {}).get('web_search_requests') or 0
        blocks += data.get('content', [])
        if data.get('stop_reason') == 'pause_turn':
            messages = [messages[0], {'role': 'assistant', 'content': data['content']}]
            continue
        break
    return blocks


GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/'


def gemini_http(path, body=None):
    for attempt in range(4):
        req = urllib.request.Request(GEMINI_BASE + path, data=json.dumps(body).encode() if body else None,
                                     headers={'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=240) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', 'replace')[:400]
            quota = exc.code == 429 and 'quota' in detail.lower()
            if quota and 'perday' in detail.lower().replace('_', ''):
                raise RuntimeError(f'Gemini HTTP 429 (daily free quota used up): {detail[:200]}')
            if exc.code in (429, 500, 503) and attempt < (1 if quota else 3):
                time.sleep(30 * (attempt + 1))
                continue
            raise RuntimeError(f'Gemini HTTP {exc.code}: {detail}')


def gemini_model():
    if USAGE.get('model'):
        return USAGE['model']
    if GEMINI_MODEL:
        USAGE['model'] = GEMINI_MODEL
        return GEMINI_MODEL
    names = []
    try:
        doc = gemini_http('models?pageSize=1000')
        names = [m['name'].removeprefix('models/') for m in doc.get('models', [])
                 if 'generateContent' in (m.get('supportedGenerationMethods') or [])]
    except Exception as exc:
        print('model list failed', exc)
    USAGE['allModels'] = names
    pick = 'gemini-flash-latest' if 'gemini-flash-latest' in names or not names else None
    if not pick:
        plain = [n for n in names if 'flash' in n and not re.search(r'lite|image|tts|live|audio|thinking|exp|preview', n)]
        pick = sorted(plain, key=lambda n: [int(x) for x in re.findall(r'\d+', n)] or [0])[-1] if plain else names[0]
    USAGE['model'] = pick
    print('Gemini model:', pick)
    return pick


def gemini(system, user, search=False, max_tokens=8192, model=None):
    body = {'systemInstruction': {'parts': [{'text': system}]}, 'contents': [{'role': 'user', 'parts': [{'text': user}]}],
            'generationConfig': {'temperature': 0.2, 'maxOutputTokens': max_tokens}}
    if search:
        body['tools'] = [{'google_search': {}}]
    data = gemini_http('models/' + (model or gemini_model()) + ':generateContent', body)
    time.sleep(6)  # stay under the free tier's requests-per-minute limit
    USAGE['calls'] += 1
    u = data.get('usageMetadata') or {}
    USAGE['input_tokens'] += u.get('promptTokenCount') or 0
    USAGE['output_tokens'] += u.get('candidatesTokenCount') or 0
    cand = (data.get('candidates') or [{}])[0]
    text = ''.join(p.get('text', '') for p in (cand.get('content') or {}).get('parts', []) if not p.get('thought'))
    meta = cand.get('groundingMetadata') or {}
    if search:
        USAGE['web_search_requests'] += len(meta.get('webSearchQueries') or [])
    return text, meta


# credible outlets for WEB-wide search results (anything else found by the search is dropped)
CREDIBLE_EXTRA = ['jiji.com', 'kyodonews.jp', 'nikkei.co.jp', 'asahi.com', 'yomiuri.co.jp', 'mainichi.jp', 'sankei.com',
                  'finance.yahoo.co.jp', 'finance.yahoo.com', 'ft.com', 'morningstar.com', 'morningstar.co.jp',
                  'investing.com', 'nasdaq.com', 'spglobal.com', 'boj.or.jp', 'mof.go.jp', 'federalreserve.gov',
                  'sec.gov', 'release.tdnet.info', 'smd-am.co.jp', 'am.jpmorgan.com', 'blackrock.com', 'amova-am.com',
                  'ubs.com', 'goldmansachs.com', 'morganstanley.com', 'nissay-am.co.jp', 'nli-research.co.jp',
                  'dir.co.jp', 'nri.com', 'murc.jp', 'mizuho-rt.co.jp', 'itochu-research.com', 'jri.co.jp', 'bloomberg.com']


def gemini_web_notes(today):
    """One Google-Search-grounded call: collect today's market facts and forecasts from the web, keep only credible outlets."""
    prompt = (f'今日は{today}（日本時間）。Google検索で直近3日の株式市場の情報を調べ、次を箇条書きでまとめてください。\n'
              '1) 日本株：相場の動きと理由、証券会社・アナリスト・エコノミストの見通しや予測（誰の見方か明記）、リスク要因\n'
              '2) 米国株：同じ内容\n'
              '3) 決算・業績予想の修正・格付けや目標株価の変更・M&A・大型受注など、具体的な材料が出た個別銘柄（日本株は4桁コード、米国株はティッカー付き）最大8件\n'
              '報道機関・証券会社・取引所・中央銀行などの信頼できる情報だけを使い、掲示板・SNS・個人ブログ・噂・出所不明の予想は使わないこと。数値は情報源にあるものだけ。')
    return grounded_notes(prompt, 'W')


def grounded_notes(prompt, prefix='W'):
    """Google-Search-grounded Gemini call; returns bullet notes citing [W1..] and the credible pages behind them."""
    # Google Search grounding quota can differ per model: try the default, then other stable Flash models
    if USAGE.get('searchOff'):
        raise RuntimeError('Google search grounding unavailable (quota) — skipped')
    first = gemini_model()
    names = USAGE.get('allModels') or []
    alts = [n for n in names if re.fullmatch(r'gemini-[\d.]+-flash(-lite)?', n)]
    alts.sort(key=lambda n: ('lite' in n, [-int(x) for x in re.findall(r'\d+', n)]))
    text, meta, last = '', {}, None
    flash = [a for a in alts if a != first and 'lite' not in a][:2]
    lite = [a for a in alts if 'lite' in a][:2]
    for model in [first] + flash + lite:
        try:
            text, meta = gemini('あなたは正確さを最優先する金融ニュースのリサーチャーです。', prompt, search=True, model=model)
            print('web search model:', model)
            break
        except RuntimeError as exc:
            last = exc
            print('web search failed on', model, str(exc)[:120])
    else:
        USAGE['searchOff'] = True
        raise last or RuntimeError('web search failed')
    chunks = meta.get('groundingChunks') or []
    keep, pages = {}, {}
    for i, c in enumerate(chunks):
        web = c.get('web') or {}
        domain = (web.get('domain') or web.get('title') or '').lower().strip()
        if web.get('uri', '').startswith('https://') and re.fullmatch(r'[a-z0-9.-]+\.[a-z]{2,}', domain) and \
                allowed(domain, NEWS_SOURCES_JP + NEWS_SOURCES_JP2 + NEWS_SOURCES_US + CREDIBLE_EXTRA):
            wid = f'{prefix}{len(keep) + 1}'
            keep[i] = wid
            pages[wid] = {'title': domain + ' の記事', 'url': web['uri'], 'publisher': domain, 'host': domain, 'date': ''}
    lines = []
    for sup in meta.get('groundingSupports') or []:
        ids = sorted({keep[k] for k in sup.get('groundingChunkIndices') or [] if k in keep}, key=lambda x: int(x[1:]))
        seg = ((sup.get('segment') or {}).get('text') or '').strip()
        if ids and seg:
            lines.append(f'- {seg} [{",".join(ids)}]')
    USAGE['pagesRead'] = USAGE.get('pagesRead', 0) + len(pages)
    print('web notes:', len(lines), 'lines from', len(pages), 'credible pages of', len(chunks))
    return '\n'.join(lines)[:9000], pages


def llm(light, system, user, tools=None, max_tokens=8000):
    if PROVIDER == 'claude':
        return claude(MODEL_LIGHT if light else MODEL, system, user, tools=tools, max_tokens=max_tokens)
    if light:  # many small calls -> Flash-Lite (larger free daily allowance), fall back to Flash
        gemini_model()
        for m in [lite_model(), None]:
            try:
                return [{'type': 'text', 'text': gemini(system, user, model=m)[0]}]
            except RuntimeError as exc:
                if m is None or '429' not in str(exc):
                    raise
                print('lite model quota, falling back:', str(exc)[:80])
    return [{'type': 'text', 'text': gemini(system, user)[0]}]


def lite_model():
    names = USAGE.get('allModels') or []
    lites = [n for n in names if re.fullmatch(r'gemini-[\d.]+-flash-lite', n)]
    lites.sort(key=lambda n: [-int(x) for x in re.findall(r'\d+', n)])
    pick = 'gemini-flash-lite-latest' if 'gemini-flash-lite-latest' in names else (lites[0] if lites else None)
    USAGE['liteModel'] = pick
    return pick


def searched_pages(blocks):
    pages = {}
    for b in blocks:
        if b.get('type') == 'web_search_tool_result' and isinstance(b.get('content'), list):
            for r in b['content']:
                if r.get('type') == 'web_search_result' and r.get('url', '').startswith('https://'):
                    host = urllib.parse.urlparse(r['url']).hostname or ''
                    pages[r['url']] = {'title': (r.get('title') or '')[:200], 'url': r['url'], 'publisher': host,
                                       'host': host, 'date': r.get('page_age') or ''}
        if b.get('type') == 'text':
            for c in b.get('citations') or []:
                if c.get('url', '').startswith('https://') and c['url'] not in pages:
                    host = urllib.parse.urlparse(c['url']).hostname or ''
                    pages[c['url']] = {'title': (c.get('title') or '')[:200], 'url': c['url'], 'publisher': host, 'host': host, 'date': ''}
    return pages


def json_from(blocks):
    text = ''.join(b.get('text', '') for b in blocks if b.get('type') == 'text')
    m = re.search(r'<json>\s*(\{[\s\S]*\})\s*</json>', text) or re.search(r'```(?:json)?\s*(\{[\s\S]*\})\s*```', text)
    raw = m.group(1) if m else text[text.find('{'): text.rfind('}') + 1]
    return json.loads(raw)


RULES = """あなたは個人投資家向けのマーケット情報の編集者です。次のルールを厳守してください。
- 根拠となる記事（下に与えた見出しID、またはweb検索で実際に開いたページ）に書かれている事実・見通しだけを使う。記憶や推測で数値・材料を補わない。
- 噂、掲示板、SNS、個人ブログ、出所不明の予想は使わない。
- 見通し・予測は必ず「誰が（証券会社・アナリスト・媒体名）」述べたかを明記し、あなた自身の売買推奨や断定的な予言は書かない。
- 文章は日本語、です・ます調を使わず簡潔な常体（〜した、〜との見方）で書く。
- すべての項目の sources には根拠のID（例 "M3", "H12"）か、web検索で得たページのURLをそのまま入れる。根拠がない項目は出力しない。
- 出力は指定のJSONだけを <json> と </json> の間に書く。"""


def fmt_headlines(items, prefix):
    return '\n'.join(f'{prefix}{i + 1}: [{h["date"]} {h["publisher"]}] {h["title"]}' for i, h in enumerate(items)) or '（該当なし）'


def fmt_tech(t):
    if not t:
        return 'データなし'
    return (f'終値{t["close"]:,.2f}（{t["date"]}） 前日比{t["chg1d"]}% 5日{t["chg5d"]}% 20日{t["chg20d"]}% '
            f'60日{t["chg60d"]}% 25日線比{t["vsMA25"]}% RSI{t["rsi14"]} 52週高値比{t["from52wHigh"]}%')


def resolve(sources, idmap, pages):
    out, seen = [], set()
    for s in sources or []:
        s = str(s).strip()
        ref = idmap.get(s) or pages.get(s)
        if ref and ref['url'] not in seen:
            seen.add(ref['url'])
            out.append({k: ref.get(k, '') for k in ('title', 'url', 'publisher', 'date')})
    return out


def clip(s, n):
    return re.sub(r'\s+', ' ', str(s or '')).strip()[:n]


def clean_outlooks(rows, idmap, pages):
    out = []
    for o in rows or []:
        src = resolve([o.get('source')], idmap, pages)
        if src and o.get('view'):
            out.append({'who': clip(o.get('who'), 40), 'view': clip(o.get('view'), 160), 'source': src[0]})
    return out[:4]


# ---------------- steps ----------------

def market_and_featured(tracked, techs, master):
    today = datetime.now(JST).strftime('%Y-%m-%d (%a)')
    jp_news, us_news = [], []
    for group in (NEWS_SOURCES_JP, NEWS_SOURCES_JP2):
        for q in ('日経平均 見通し', '東京株式市場 相場', '日本株 来週 展望', '決算 上方修正 株価', '目標株価 引き上げ 格上げ'):
            jp_news += google_news(q, group, days=4, limit=6)
        for q in ('米国株 見通し', 'NYダウ S&P500'):
            us_news += google_news(q, group, days=4, limit=5)
    for q in ('stock market outlook', 'analyst upgrade price target'):
        us_news += google_news(q, NEWS_SOURCES_US, lang='en', days=4, limit=8)
    cap = 25

    def dedupe(xs):
        seen, out = set(), []
        for x in xs:
            if x['url'] not in seen and x['title'] not in seen:
                seen.update([x['url'], x['title']])
                out.append(x)
        return out[:cap]
    jp_news, us_news = dedupe(jp_news), dedupe(us_news)
    idmap = {f'J{i + 1}': h for i, h in enumerate(jp_news)} | {f'U{i + 1}': h for i, h in enumerate(us_news)}
    n225 = next((techs.get(k) for k in techs if k.endswith('^N225')), None)
    tracked_txt = '\n'.join(f'- {s["market"]}:{s["symbol"]} {s["name"]}' for s in tracked if s['market'] != 'INDEX')
    user = f"""今日は{today}（日本時間）。
# 日本市場の見出し（直近4日）
{fmt_headlines(jp_news, 'J')}
# 米国市場の見出し（直近4日）
{fmt_headlines(us_news, 'U')}
# 日経平均の値動き（Yahoo Finance）
{fmt_tech(n225)}
# 利用者がすでに追跡中の銘柄
{tracked_txt}

# 作業
1. {'見出しを手がかりに、必要ならweb検索（最大' + str(MAX_SEARCHES) + '回、許可された媒体のみ）で記事を読み' if PROVIDER == 'claude' else '見出しと下の「WEB検索メモ」だけを根拠に（書かれていないことは補わずに）'}、日本市場と米国市場それぞれの「今の相場の要点」「専門家・証券会社の見通し」「リスク要因」をまとめる。
2. 直近のニュースで材料が出ている「注目銘柄」を日本株・米国株あわせて3〜8銘柄選ぶ（追跡中の銘柄でなくてよい）。決算、業績予想の修正、大型受注、M&A、規制、指数採用など、記事で確認できる具体的な材料がある銘柄に限る。銘柄コード（日本株は4桁英数字、米国株はティッカー）が確かな銘柄に限る（コードは公式の銘柄一覧で照合し、合わないものは除外される）。

# 出力JSON
{{"market":{{"jp":{{"title":"20字以内の見出し","summary":"200字以内","points":["要点(各60字以内)"],"outlooks":[{{"who":"発言者・機関","view":"見通し(100字以内)","source":"根拠ID or URL"}}],"risks":["リスク(各50字以内)"],"sources":["J1","https://..."]}},
"us":{{同じ形式。根拠IDはU〜}}}},
"featured":[{{"market":"JP|US","symbol":"7203","name":"会社名","theme":"材料を一言(15字以内)","reason":"注目理由(120字以内)","catalysts":["材料"],"risks":["注意点"],"tone":"positive|negative|mixed","sources":["J3","https://..."]}}]}}"""
    tools = [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': MAX_SEARCHES,
              'allowed_domains': WEB_SEARCH_DOMAINS,
              'user_location': {'type': 'approximate', 'country': 'JP', 'timezone': 'Asia/Tokyo'}}]
    if PROVIDER == 'gemini':
        notes, pages = '', {}
        try:
            notes, pages = gemini_web_notes(today)
        except Exception as exc:
            print('web notes failed', exc)
        user += '\n\n# WEB検索メモ（Google検索。[W番号]が根拠ID）\n' + (notes or '（取得できませんでした）')
        blocks = llm(False, RULES, user)
    else:
        blocks = llm(False, RULES, user, tools=tools, max_tokens=8000)
        pages = searched_pages(blocks)
    data = json_from(blocks)
    market = {}
    for region in ('jp', 'us'):
        m = (data.get('market') or {}).get(region) or {}
        sources = resolve(m.get('sources'), idmap, pages)
        if not sources or not m.get('summary'):
            continue
        market[region] = {'title': clip(m.get('title'), 30), 'summary': clip(m.get('summary'), 320),
                          'points': [clip(x, 90) for x in (m.get('points') or [])][:5],
                          'outlooks': clean_outlooks(m.get('outlooks'), idmap, pages),
                          'risks': [clip(x, 80) for x in (m.get('risks') or [])][:4], 'sources': sources[:8]}
    featured, seen = [], set()
    for f in data.get('featured') or []:
        mk = 'JP' if str(f.get('market')).upper() == 'JP' else 'US'
        sym = str(f.get('symbol') or '').upper().strip().removesuffix('.T')
        sym = sym.replace('.', '-') if mk == 'US' else sym
        valid = re.fullmatch(r'[0-9]{3}[0-9A-Z]', sym) if mk == 'JP' else re.fullmatch(r'[A-Z][A-Z0-9-]{0,9}', sym)
        sources = resolve(f.get('sources'), idmap, pages)
        if not valid or not sources or (mk, sym) in seen:
            continue
        if master and (mk, sym) not in master:
            print('featured symbol not in master list, skipped:', mk, sym, f.get('name'))
            continue
        seen.add((mk, sym))
        featured.append({'market': mk, 'symbol': sym, 'name': (master or {}).get((mk, sym)) or clip(f.get('name'), 40),
                         'theme': clip(f.get('theme'), 20), 'reason': clip(f.get('reason'), 180),
                         'catalysts': [clip(x, 60) for x in (f.get('catalysts') or [])][:4],
                         'risks': [clip(x, 60) for x in (f.get('risks') or [])][:3],
                         'tone': f.get('tone') if f.get('tone') in ('positive', 'negative', 'mixed') else 'mixed',
                         'sources': sources[:5]})
    return market, featured[:8], len(pages)


def stock_briefs(tracked, techs):
    targets = [s for s in tracked if s['market'] != 'INDEX'][:MAX_BRIEFS]

    def news(s):
        name = short_name(s['name'])
        items = google_news(f'"{name}"', NEWS_SOURCES_JP, days=21, limit=6)
        items += google_news(f'"{name}"', NEWS_SOURCES_JP2, days=21, limit=3)
        if s['market'] == 'JP':  # official disclosures (決算短信・株式分割・配当・自社株買いなど) via TDnet / JPX
            items += google_news(f'"{name}" (決算 OR 分割 OR 配当 OR 自己株式 OR 開示)', ['release.tdnet.info', 'jpx.co.jp', 'kabutan.jp'], days=30, limit=3)
        if s['market'] == 'US':
            items += google_news(f'"{name}" stock', NEWS_SOURCES_US, lang='en', days=21, limit=4)
        seen, uniq = set(), []
        for h in items:
            if h['url'] not in seen:
                seen.add(h['url']); uniq.append(h)
        items = sorted(uniq, key=lambda h: h['date'], reverse=True)[:10]
        return s, items
    with ThreadPoolExecutor(max_workers=3) as pool:
        collected = list(pool.map(news, targets))
    briefs = {}
    batch = [c for c in collected if c[1]]
    for s, items in collected:
        if not items:
            briefs[s['key']] = {'status': 'no_news', 'summary': '', 'sources': []}
    step = 8
    for start in range(0, len(batch), step):
        chunk, idmap, parts = batch[start:start + step], {}, []
        for si, (s, items) in enumerate(chunk):
            lines = []
            for hi, h in enumerate(items):
                hid = f'S{si + 1}H{hi + 1}'
                idmap[hid] = h
                lines.append(f'  {hid}: [{h["date"]} {h["publisher"]}] {h["title"]}')
            parts.append(f'## {s["key"]} {s["name"]}\n値動き: {fmt_tech(techs.get(s["key"]))}\n見出し:\n' + '\n'.join(lines))
        user = ('次の各銘柄について、見出しから読み取れる最近の材料を要約してください。銘柄と無関係な見出しは無視し、'
                '関係する見出しが無ければ summary を空文字にしてください。\n\n' + '\n\n'.join(parts) +
                '\n\n# 出力JSON\n{"stocks":[{"key":"JP:7203","summary":"最近の動向(120字以内)","good":["好材料(各30字以内)"],'
                '"bad":["悪材料・懸念"],"outlooks":[{"who":"発言者・機関","view":"見通し","source":"根拠ID"}],'
                '"tone":-2から2の整数(記事の論調。-2=明確に悪い,0=中立,2=明確に良い),"sources":["S1H1"],'
                '"events":[{"date":"見出しの日付YYYY-MM-DD","type":"決算|業績修正|株式分割|配当|自社株買い|M&A・提携|新製品・事業|人事|不祥事・訴訟|その他",'
                '"text":"何があったか(40字以内、事実のみ)","source":"S1H2"}]}]}\n'
                'events は見出しで確認できる具体的な出来事（発表・決定・実施）だけを新しい順に最大5件。株価の上げ下げだけの見出しは入れない。')
        try:
            data = json_from(llm(True, RULES, user, max_tokens=4000))
        except Exception as exc:
            print('brief batch failed', exc)
            for s, _ in chunk:
                briefs[s['key']] = {'status': 'error', 'summary': '', 'sources': []}
            continue
        prefix = {s['key']: f'S{si + 1}H' for si, (s, _) in enumerate(chunk)}
        for b in data.get('stocks') or []:
            if b.get('key') not in prefix:
                continue
            # a stock may only cite its own headlines
            own = [x for x in (b.get('sources') or []) if str(x).startswith(prefix[b['key']])]
            sources = resolve(own, idmap, {})
            if not sources or not b.get('summary'):
                briefs[b['key']] = {'status': 'no_news', 'summary': '', 'sources': []}
                continue
            try:
                tone = max(-2, min(2, int(b.get('tone', 0))))
            except Exception:
                tone = 0
            events, seen_ev = [], set()
            for ev in b.get('events') or []:
                src = str(ev.get('source') or '')
                if not src.startswith(prefix[b['key']]) or src not in idmap or not ev.get('text'):
                    continue
                h = idmap[src]
                typ = clip(ev.get('type'), 10) or 'その他'
                key = (typ, clip(ev.get('text'), 20))
                if key in seen_ev:
                    continue
                seen_ev.add(key)
                date = str(ev.get('date') or '')
                events.append({'date': date if re.fullmatch(r'\d{4}-\d{2}-\d{2}', date) and date <= h['date'] else h['date'],
                               'type': typ, 'text': clip(ev['text'], 60), 'source': resolve([src], idmap, {})[0]})
            events.sort(key=lambda e: e['date'], reverse=True)
            briefs[b['key']] = {'status': 'ok', 'summary': clip(b['summary'], 180), 'events': events[:5],
                                'good': [clip(x, 40) for x in (b.get('good') or [])][:4],
                                'bad': [clip(x, 40) for x in (b.get('bad') or [])][:4],
                                'outlooks': clean_outlooks(b.get('outlooks'), idmap, {}),
                                'tone': tone, 'sources': sources[:5]}
        for s, _ in chunk:
            briefs.setdefault(s['key'], {'status': 'no_news', 'summary': '', 'sources': []})
    return briefs


def add_featured(featured, kind='featured'):
    """Fetch prices for featured stocks that are not tracked and register them in data/index.json."""
    index = read_json(DATA / 'index.json') or {'version': 2, 'stocks': []}
    have = {(e['market'], e['symbol']) for e in index['stocks']}
    errors = []
    for f in featured or []:
        if (f['market'], f['symbol']) in have:
            continue
        config = {'symbol': f['symbol'], 'market': f['market'], 'name': f['name'], 'yahoo': yahoo_code(f['symbol'], f['market'])}
        try:
            index['stocks'].append(save_record(fetch_stock(config, range_='2y', max_rows=520), kind))
            have.add((f['market'], f['symbol']))
        except Exception as exc:
            errors.append(f'株価取得 {config["yahoo"]}: {str(exc)[:150]}')
    write_json(DATA / 'index.json', index)
    return errors


# ---------------- 気になるテーマ (topics/*.txt) ----------------

def load_topics():
    folder = ROOT / 'topics'
    out = []
    for path in sorted(folder.glob('*.txt')) if folder.exists() else []:
        name = re.sub(r'\s+', ' ', path.stem).strip()[:40]
        lines = path.read_text(encoding='utf-8', errors='ignore').strip().splitlines()
        if name:
            out.append({'name': name, 'memo': (lines[0].strip()[:100] if lines else '')})
    return out[:15]


STANCE = {'bullish': '強気寄り', 'neutral': '中立', 'bearish': '弱気寄り', 'mixed': '強弱まちまち'}


def topic_analysis(topics, master):
    """Current trend / outlook / related listed securities for free-text interests (e.g. 金, オールカントリー, スペースX)."""
    if not topics:
        return {}
    today = datetime.now(JST).strftime('%Y-%m-%d (%a)')
    idmap, parts = {}, []
    for ti, t in enumerate(topics):
        items = google_news(f'"{t["name"]}"', NEWS_SOURCES_JP, days=14, limit=4)
        items += google_news(t['name'], NEWS_SOURCES_JP2, days=14, limit=3)
        lines = []
        for hi, h in enumerate(items):
            hid = f'T{ti + 1}H{hi + 1}'
            idmap[hid] = h
            lines.append(f'  {hid}: [{h["date"]} {h["publisher"]}] {h["title"]}')
        parts.append(f'## {t["name"]}' + (f'（利用者のメモ：{t["memo"]}）' if t['memo'] else '') + '\n' + ('\n'.join(lines) or '  （見出しなし）'))
    notes, pages = '', {}
    names = '、'.join(t['name'] for t in topics)
    if PROVIDER == 'gemini':
        try:
            notes, pages = grounded_notes(
                f'今日は{today}（日本時間）。Google検索で次の投資対象・テーマについてそれぞれ調べてください：{names}。\n'
                'それぞれ、(1)何か（資産・投資信託/指数・企業・テーマのどれか）、(2)直近1か月ほどの値動きや出来事、'
                '(3)証券会社・運用会社・アナリスト・エコノミスト・報道機関が示す今後の見通しや予測（誰の見方か明記）、'
                '(4)投資できる関連の上場銘柄やETF（日本株は4桁コード、米国はティッカー。未上場企業なら関連する上場銘柄やファンド）、(5)リスク。'
                '信頼できる報道機関・金融機関・公的機関の情報だけを使い、掲示板・SNS・個人ブログ・噂は使わないこと。', 'W')
        except Exception as exc:
            print('topic web notes failed', exc)
    user = (f'今日は{today}（日本時間）。利用者が気になっている投資対象・テーマ：{names}\n\n# ニュース見出し\n' + '\n\n'.join(parts) +
            ('\n\n# WEB検索メモ（[W番号]が根拠ID）\n' + notes if notes else '') +
            '\n\n# 作業\n各テーマについて、上の見出し' + ('とWEB検索メモ' if notes else '') + ('（必要ならweb検索も）' if PROVIDER == 'claude' else '') +
            'だけを根拠に、現在の動向と今後の見通しをまとめる。見通しは必ず誰の見方かを書き、あなた自身の売買推奨は書かない。'
            '関連銘柄は日本の上場銘柄（4桁コード）か米国の上場銘柄・ETF（ティッカー）だけ。投資信託はそれ自体ではなく同じ指数に連動する上場ETFを挙げる。'
            '根拠が無いテーマは now を空文字にする。\n\n# 出力JSON\n'
            '{"topics":[{"name":"テーマ名（入力のまま）","kind":"資産・商品|投資信託・指数|企業|テーマ","summary":"一言でいうと(60字以内)",'
            '"now":"現在の動向(150字以内)","outlook":"今後の見通しのまとめ(150字以内)","outlooks":[{"who":"発言者・機関","view":"見通し","source":"根拠ID"}],'
            '"stance":"bullish|neutral|bearish|mixed（見通し記事全体の論調）","related":[{"market":"JP|US","symbol":"1540","name":"名称","why":"関係(30字以内)"}],'
            '"risks":["リスク"],"sources":["T1H1","W2"]}]}')
    tools = [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 4, 'allowed_domains': WEB_SEARCH_DOMAINS}] if PROVIDER == 'claude' else None
    blocks = llm(False, RULES, user, tools=tools, max_tokens=8000)
    if PROVIDER == 'claude':
        pages = searched_pages(blocks)
    data = json_from(blocks)
    wanted = {t['name'] for t in topics}
    out = {}
    for t in data.get('topics') or []:
        name = str(t.get('name') or '').strip()
        if name not in wanted:
            continue
        sources = resolve(t.get('sources'), idmap, pages)
        if not sources or not t.get('now'):
            out[name] = {'status': 'no_info', 'analyzedAt': now_iso()}
            continue
        related = []
        for r in t.get('related') or []:
            mk = 'JP' if str(r.get('market')).upper() == 'JP' else 'US'
            sym = str(r.get('symbol') or '').upper().strip().removesuffix('.T')
            sym = sym.replace('.', '-') if mk == 'US' else sym
            if (mk, sym) in master and all(x['symbol'] != sym for x in related):
                related.append({'market': mk, 'symbol': sym, 'name': master[(mk, sym)], 'why': clip(r.get('why'), 40)})
        out[name] = {'status': 'ok', 'analyzedAt': now_iso(), 'kind': clip(t.get('kind'), 12), 'summary': clip(t.get('summary'), 80),
                     'now': clip(t.get('now'), 220), 'outlook': clip(t.get('outlook'), 220),
                     'outlooks': clean_outlooks(t.get('outlooks'), idmap, pages),
                     'stance': t.get('stance') if t.get('stance') in STANCE else 'mixed',
                     'related': related[:4], 'risks': [clip(x, 60) for x in (t.get('risks') or [])][:4], 'sources': sources[:6]}
    for t in topics:
        out.setdefault(t['name'], {'status': 'no_info', 'analyzedAt': now_iso()})
    return out


def rate_topics(results):
    """おすすめ度（参考）1〜5: 見通し記事の論調 ±1 と、関連銘柄の値動き ±1。売買推奨ではない。"""
    index = read_json(DATA / 'index.json') or {'stocks': []}
    tech = {(e['market'], e['symbol']): e.get('tech') for e in index['stocks']}
    for name, r in results.items():
        if r.get('status') != 'ok':
            continue
        score, why = 3, []
        sv = {'bullish': 1, 'bearish': -1}.get(r['stance'], 0)
        score += sv
        why.append('見通し記事の論調：' + STANCE[r['stance']])
        t = next((tech.get((x['market'], x['symbol'])) for x in r['related'] if tech.get((x['market'], x['symbol']))), None)
        if t and t.get('chg60d') is not None and t.get('vsMA75') is not None:
            if t['chg60d'] > 0 and t['vsMA75'] > 0:
                score += 1
                why.append(f'値動き：上昇基調（60日 {t["chg60d"]:+.1f}%、75日平均より上）')
            elif t['chg60d'] < 0 and t['vsMA75'] < 0:
                score -= 1
                why.append(f'値動き：下落基調（60日 {t["chg60d"]:+.1f}%、75日平均より下）')
            else:
                why.append(f'値動き：方向感なし（60日 {t["chg60d"]:+.1f}%）')
        r['rating'] = max(1, min(5, score))
        r['ratingWhy'] = '／'.join(why)
    return results


def refresh_topics(research, master, only_new):
    topics = load_topics()
    old = research.get('topics') or {}
    todo = [t for t in topics if not only_new or t['name'] not in old]
    errors = []
    new = {}
    if todo:
        try:
            new = topic_analysis(todo, master)
        except Exception as exc:
            errors.append('気になるテーマ: ' + str(exc)[:300])
            print('topic step failed', exc)
    merged = {t['name']: new.get(t['name']) or old.get(t['name']) or {'status': 'pending'} for t in topics}
    related = [x for r in merged.values() for x in (r.get('related') or [])]
    errors += add_featured(related, 'topic')
    research['topics'] = rate_topics(merged)
    return errors


# ---------------- 保有株の分析（現在の動向・最近のトピック・今後の動向予想） ----------------

def holding_analysis(held, techs, briefs):
    if not held:
        return {}
    today = datetime.now(JST).strftime('%Y-%m-%d (%a)')
    idmap, parts = {}, []
    for si, s in enumerate(held):
        name = short_name(s['name'])
        items = google_news(f'"{name}" (見通し OR 目標株価 OR 業績 OR 予想 OR 決算)', NEWS_SOURCES_JP + NEWS_SOURCES_JP2[:4], days=30, limit=6)
        if s['market'] == 'US':
            items += google_news(f'"{name}" (outlook OR "price target" OR earnings OR forecast)', NEWS_SOURCES_US, lang='en', days=30, limit=4)
        for h in (briefs.get(s['key']) or {}).get('sources') or []:
            if all(h['url'] != x['url'] for x in items):
                items.append({**h, 'host': ''})
        lines = []
        for hi, h in enumerate(items[:10]):
            hid = f'P{si + 1}H{hi + 1}'
            idmap[hid] = h
            lines.append(f'  {hid}: [{h["date"]} {h["publisher"]}] {h["title"]}')
        parts.append(f'## {s["key"]} {s["name"]}\n値動き: {fmt_tech(techs.get(s["key"]))}\n見出し:\n' + ('\n'.join(lines) or '  （見出しなし）'))
    notes, pages = '', {}
    if PROVIDER == 'gemini':
        try:
            notes, pages = grounded_notes(
                f'今日は{today}（日本時間）。Google検索で次の銘柄それぞれについて、直近1か月の出来事と、証券会社・アナリスト・報道機関が示す今後の見通し（業績予想、目標株価、レーティングなど。誰の見方か明記）を調べてください：'
                + '、'.join(f'{s["name"]}（{s["symbol"]}）' for s in held) + '。信頼できる報道機関・金融機関・取引所・会社の公式発表だけを使い、掲示板・SNS・個人ブログ・噂は使わないこと。数値は情報源にあるものだけ。', 'W')
        except Exception as exc:
            print('holding web notes failed', exc)
    user = (f'今日は{today}（日本時間）。利用者が保有している銘柄の分析をしてください。\n\n' + '\n\n'.join(parts) +
            ('\n\n# WEB検索メモ（[W番号]が根拠ID）\n' + notes if notes else '') +
            '\n\n# 作業\n各銘柄について、上の見出し' + ('とWEB検索メモ' if notes else '') + 'と値動きだけを根拠に、'
            '「現在の動向」と「今後の動向予想」をまとめる。今後の動向予想は、記事にある会社や証券会社・アナリストの見通し（誰の見方か明記）と、'
            '値動きの傾向（移動平均やRSIなど上の数値）から言えることを分けて書く。あなた自身の売買推奨や断定的な予言は書かない。'
            '根拠になる見出しが無い銘柄は now を空文字にする。\n\n# 出力JSON\n'
            '{"holdings":[{"key":"JP:7203","now":"現在の動向(120字以内)","outlook":"今後の動向予想のまとめ(150字以内)",'
            '"trend":"値動きから見た傾向(60字以内)","outlooks":[{"who":"発言者・機関","view":"見通し・目標株価など","source":"根拠ID"}],'
            '"stance":"bullish|neutral|bearish|mixed（見通し記事全体の論調）","watch":["今後の注目点（決算日など、記事にあるもの）"],"risks":["リスク"],"sources":["P1H1","W2"]}]}')
    tools = [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 4, 'allowed_domains': WEB_SEARCH_DOMAINS}] if PROVIDER == 'claude' else None
    blocks = llm(False, RULES, user, tools=tools, max_tokens=8000)
    if PROVIDER == 'claude':
        pages = searched_pages(blocks)
    data = json_from(blocks)
    prefix = {s['key']: f'P{si + 1}H' for si, s in enumerate(held)}
    out = {}
    for h in data.get('holdings') or []:
        k = h.get('key')
        if k not in prefix:
            continue
        own = [x for x in (h.get('sources') or []) if str(x).startswith(prefix[k]) or str(x).startswith('W') or str(x).startswith('http')]
        sources = resolve(own, idmap, pages)
        if not sources or not h.get('now'):
            out[k] = {'status': 'no_info', 'analyzedAt': now_iso()}
            continue
        out[k] = {'status': 'ok', 'analyzedAt': now_iso(), 'now': clip(h.get('now'), 180), 'outlook': clip(h.get('outlook'), 220),
                  'trend': clip(h.get('trend'), 90), 'outlooks': clean_outlooks(h.get('outlooks'), idmap, pages),
                  'stance': h.get('stance') if h.get('stance') in STANCE else 'mixed',
                  'watch': [clip(x, 60) for x in (h.get('watch') or [])][:3], 'risks': [clip(x, 60) for x in (h.get('risks') or [])][:3],
                  'sources': sources[:6]}
    for s in held:
        out.setdefault(s['key'], {'status': 'no_info', 'analyzedAt': now_iso()})
    return out


def held_list():
    index = read_json(DATA / 'index.json') or {'stocks': []}
    return [{'key': e['market'] + ':' + e['symbol'], 'symbol': e['symbol'], 'market': e['market'], 'name': e.get('name') or e['symbol']}
            for e in index['stocks'] if e.get('holding')][:12], {e['market'] + ':' + e['symbol']: e.get('tech') for e in index['stocks']}


def keep_previous(reason):
    prev = previous_published('research.json')
    if prev:
        if reason:
            prev['notice'] = reason
        add_featured(prev.get('featured'))
        if reason is None and os.environ.get('LIGHT_RUN') != 'true' and PROVIDER:
            master = {(x[1], x[0]): x[2] for x in (read_json(DATA / 'symbols-master.json') or {}).get('items', [])}
            refresh_topics(prev, master, only_new=True)  # a newly added topic is analysed right away
            held, techs = held_list()
            new = [h for h in held if (prev.get('holdings') or {}).get(h['key'], {}).get('status') != 'ok']
            if new:
                try:
                    prev['holdings'] = {**(prev.get('holdings') or {}), **holding_analysis(new, techs, prev.get('briefs') or {})}
                except Exception as exc:
                    print('holding step failed', exc)
        else:
            add_featured([x for r in (prev.get('topics') or {}).values() for x in (r.get('related') or [])], 'topic')
        write_json(DATA / 'research.json', prev)
    else:
        write_json(DATA / 'research.json', {'version': 2, 'generatedAt': None, 'status': 'not_configured', 'notice': reason})


def main():
    if not PROVIDER:
        print('No AI key (GEMINI_API_KEY or ANTHROPIC_API_KEY); skipping AI research.')
        return keep_previous('AIまとめは未設定です。無料のGemini APIキーをGitHubに登録すると、毎朝ここに表示されます（手順は「設定」タブ）。')
    print('AI provider:', PROVIDER)
    if PROVIDER == 'gemini':  # non-secret diagnostics only: length, first 4 chars, stray characters
        raw = os.environ.get('GEMINI_API_KEY', '')
        print('key check: length', len(GEMINI_KEY), 'starts', GEMINI_KEY[:4], 'had spaces/newlines', raw != raw.strip() or ' ' in GEMINI_KEY,
              'non-ascii', any(ord(ch) > 126 for ch in GEMINI_KEY))
    prev = previous_published('research.json')
    if os.environ.get('LIGHT_RUN') == 'true' and prev and prev.get('status') == 'ok':
        print('Hourly price-only run: keeping the latest AI summary.')
        return keep_previous(None)
    if os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('FORCE_RESEARCH') != 'true' and prev and prev.get('generatedAt'):
        age = datetime.now(timezone.utc) - datetime.fromisoformat(prev['generatedAt'])
        if age < timedelta(hours=18):
            print('Recent research exists; push run reuses it to save API cost.')
            return keep_previous(None)
    index = read_json(DATA / 'index.json') or {'stocks': []}
    master_doc = read_json(DATA / 'symbols-master.json') or {}
    master = {(x[1], x[0]): x[2] for x in master_doc.get('items', [])}
    tracked, techs = [], {}
    for e in index['stocks']:
        key = e['market'] + ':' + e['symbol']
        tracked.append({'key': key, 'symbol': e['symbol'], 'market': e['market'], 'name': e.get('name') or e['symbol']})
        techs[key] = e.get('tech')
    errors = []
    market, featured, page_count = {}, [], 0
    try:
        market, featured, page_count = market_and_featured(tracked, techs, master)
    except Exception as exc:
        errors.append('市場まとめ: ' + str(exc)[:300])
        print('market step failed', exc)
    briefs = {}
    try:
        briefs = stock_briefs(tracked, techs)
    except Exception as exc:
        errors.append('銘柄ニュース: ' + str(exc)[:300])
        print('brief step failed', exc)
    if not market and not featured and not any(b.get('status') == 'ok' for b in briefs.values()):
        return keep_previous('今回のAIまとめに失敗したため、前回の内容を表示しています：' + '; '.join(errors)[:300])
    errors += add_featured(featured)
    holder = {}
    errors += refresh_topics(holder, master, only_new=False)
    holdings = {}
    try:
        held, _ = held_list()
        holdings = holding_analysis(held, techs, briefs)
    except Exception as exc:
        errors.append('保有株の分析: ' + str(exc)[:300])
        print('holding step failed', exc)
    USAGE.pop('allModels', None)
    search_off = USAGE.pop('searchOff', False)
    research = {'version': 2, 'status': 'ok', 'generatedAt': now_iso(), 'provider': PROVIDER, 'model': MODEL if PROVIDER == 'claude' else USAGE.get('model', ''),
                'modelLight': MODEL_LIGHT if PROVIDER == 'claude' else USAGE.get('model', ''),
                'market': market, 'featured': featured, 'briefs': briefs, 'topics': holder.get('topics', {}), 'holdings': holdings, 'errors': errors,
                'usage': {**USAGE, 'pagesRead': page_count or USAGE.get('pagesRead', 0)}, 'searchOff': search_off}
    write_json(DATA / 'research.json', research)
    print('research ok', json.dumps(research['usage']), 'featured', len(featured), 'briefs', len(briefs))


if __name__ == '__main__':
    sys.exit(main())
