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
from common import DATA, fetch_stock, http_get, now_iso, previous_published, read_json, save_record, write_json, yahoo_code

API_KEY = os.environ.get('ANTHROPIC_API_KEY', '').strip()
MODEL = os.environ.get('CLAUDE_MODEL', '').strip() or 'claude-sonnet-5-5'
MODEL_LIGHT = os.environ.get('CLAUDE_MODEL_LIGHT', '').strip() or 'claude-haiku-5-5'
GH_TOKEN = os.environ.get('GITHUB_TOKEN', '').strip()
GH_MODEL = os.environ.get('GH_MODEL', '').strip() or 'openai/gpt-4.1-mini'
GH_FALLBACK = 'openai/gpt-4o-mini'
# Claude API (paid, can read articles via web search) when a key is set; otherwise GitHub Models (free, headlines only)
PROVIDER = 'claude' if API_KEY else 'github' if GH_TOKEN else None
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


def github_chat(system, user, max_tokens=4000):
    """GitHub Models (free tier, rate limited). Uses the workflow's GITHUB_TOKEN with `models: read`."""
    last = None
    for model in dict.fromkeys([GH_MODEL, GH_FALLBACK]):
        body = {'model': model, 'temperature': 0.2, 'max_tokens': min(max_tokens, 4000),
                'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
        for attempt in range(4):
            req = urllib.request.Request('https://models.github.ai/inference/chat/completions', data=json.dumps(body).encode(),
                                         headers={'Authorization': 'Bearer ' + GH_TOKEN, 'Content-Type': 'application/json',
                                                  'Accept': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=180) as res:
                    raw = res.read()
                    status, ctype = res.status, res.headers.get('Content-Type')
                try:
                    data = json.loads(raw)
                except ValueError:
                    last = f'GitHub Models returned non-JSON (HTTP {status}, {ctype}): {raw[:300]!r}'
                    print(last)
                    break
                USAGE['calls'] += 1
                USAGE['model'] = model
                u = data.get('usage') or {}
                USAGE['input_tokens'] += u.get('prompt_tokens') or 0
                USAGE['output_tokens'] += u.get('completion_tokens') or 0
                msg = (data.get('choices') or [{}])[0].get('message') or {}
                text = msg.get('content') or ''
                if '{' not in text:
                    print('GitHub Models reply without JSON:', model, json.dumps(data, ensure_ascii=False)[:600])
                return [{'type': 'text', 'text': text}]
            except urllib.error.HTTPError as exc:
                last = f'GitHub Models HTTP {exc.code}: ' + exc.read().decode('utf-8', 'replace')[:300]
                if exc.code == 429 and attempt < 3:
                    time.sleep(30 * (attempt + 1))
                    continue
                break  # other errors: try the fallback model
    raise RuntimeError(last or 'GitHub Models failed')


def llm(light, system, user, tools=None, max_tokens=8000):
    if PROVIDER == 'claude':
        return claude(MODEL_LIGHT if light else MODEL, system, user, tools=tools, max_tokens=max_tokens)
    return github_chat(system, user, max_tokens)


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
    cap = 25 if PROVIDER == 'claude' else 22  # GitHub Models free tier: about 8k input tokens per request

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
1. {'見出しを手がかりに、必要ならweb検索（最大' + str(MAX_SEARCHES) + '回、許可された媒体のみ）で記事を読み' if PROVIDER == 'claude' else '見出しだけを根拠に（見出しに書かれていないことは補わずに）'}、日本市場と米国市場それぞれの「今の相場の要点」「専門家・証券会社の見通し」「リスク要因」をまとめる。
2. 直近のニュースで材料が出ている「注目銘柄」を日本株・米国株あわせて3〜8銘柄選ぶ（追跡中の銘柄でなくてよい）。決算、業績予想の修正、大型受注、M&A、規制、指数採用など、記事で確認できる具体的な材料がある銘柄に限る。銘柄コード（日本株は4桁英数字、米国株はティッカー）が確かな銘柄に限る（コードは公式の銘柄一覧で照合し、合わないものは除外される）。

# 出力JSON
{{"market":{{"jp":{{"title":"20字以内の見出し","summary":"200字以内","points":["要点(各60字以内)"],"outlooks":[{{"who":"発言者・機関","view":"見通し(100字以内)","source":"根拠ID or URL"}}],"risks":["リスク(各50字以内)"],"sources":["J1","https://..."]}},
"us":{{同じ形式。根拠IDはU〜}}}},
"featured":[{{"market":"JP|US","symbol":"7203","name":"会社名","theme":"材料を一言(15字以内)","reason":"注目理由(120字以内)","catalysts":["材料"],"risks":["注意点"],"tone":"positive|negative|mixed","sources":["J3","https://..."]}}]}}"""
    tools = [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': MAX_SEARCHES,
              'allowed_domains': WEB_SEARCH_DOMAINS,
              'user_location': {'type': 'approximate', 'country': 'JP', 'timezone': 'Asia/Tokyo'}}]
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
        items = google_news(f'"{name}"', NEWS_SOURCES_JP, days=10, limit=5)
        items += google_news(f'"{name}"', NEWS_SOURCES_JP2, days=10, limit=3)
        if s['market'] == 'US':
            items += google_news(f'"{name}" stock', NEWS_SOURCES_US, lang='en', days=10, limit=4)
        return s, items
    with ThreadPoolExecutor(max_workers=3) as pool:
        collected = list(pool.map(news, targets))
    briefs = {}
    batch = [c for c in collected if c[1]]
    for s, items in collected:
        if not items:
            briefs[s['key']] = {'status': 'no_news', 'summary': '', 'sources': []}
    step = 8 if PROVIDER == 'claude' else 5  # free tier allows ~8k input tokens per request
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
                '"tone":-2から2の整数(記事の論調。-2=明確に悪い,0=中立,2=明確に良い),"sources":["S1H1"]}]}')
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
            briefs[b['key']] = {'status': 'ok', 'summary': clip(b['summary'], 180),
                                'good': [clip(x, 40) for x in (b.get('good') or [])][:4],
                                'bad': [clip(x, 40) for x in (b.get('bad') or [])][:4],
                                'outlooks': clean_outlooks(b.get('outlooks'), idmap, {}),
                                'tone': tone, 'sources': sources[:5]}
        for s, _ in chunk:
            briefs.setdefault(s['key'], {'status': 'no_news', 'summary': '', 'sources': []})
    return briefs


def add_featured(featured):
    """Fetch prices for featured stocks that are not tracked and register them in data/index.json."""
    index = read_json(DATA / 'index.json') or {'version': 2, 'stocks': []}
    have = {(e['market'], e['symbol']) for e in index['stocks']}
    errors = []
    for f in featured or []:
        if (f['market'], f['symbol']) in have:
            continue
        config = {'symbol': f['symbol'], 'market': f['market'], 'name': f['name'], 'yahoo': yahoo_code(f['symbol'], f['market'])}
        try:
            index['stocks'].append(save_record(fetch_stock(config, range_='2y', max_rows=520), 'featured'))
            have.add((f['market'], f['symbol']))
        except Exception as exc:
            errors.append(f'株価取得 {config["yahoo"]}: {str(exc)[:150]}')
    write_json(DATA / 'index.json', index)
    return errors


def keep_previous(reason):
    prev = previous_published('research.json')
    if prev:
        if reason:
            prev['notice'] = reason
        add_featured(prev.get('featured'))
        write_json(DATA / 'research.json', prev)
    else:
        write_json(DATA / 'research.json', {'version': 2, 'generatedAt': None, 'status': 'not_configured', 'notice': reason})


def main():
    if not PROVIDER:
        print('No AI available (no ANTHROPIC_API_KEY and no GITHUB_TOKEN); skipping AI research.')
        return keep_previous('AIまとめを作れませんでした（AIの接続設定がありません）。')
    print('AI provider:', PROVIDER)
    prev = previous_published('research.json')
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
    research = {'version': 2, 'status': 'ok', 'generatedAt': now_iso(), 'provider': PROVIDER, 'model': MODEL if PROVIDER == 'claude' else USAGE.get('model', GH_MODEL),
                'modelLight': MODEL_LIGHT if PROVIDER == 'claude' else USAGE.get('model', GH_MODEL),
                'market': market, 'featured': featured, 'briefs': briefs, 'errors': errors,
                'usage': {**USAGE, 'pagesRead': page_count}}
    write_json(DATA / 'research.json', research)
    print('research ok', json.dumps(research['usage']), 'featured', len(featured), 'briefs', len(briefs))


if __name__ == '__main__':
    sys.exit(main())
