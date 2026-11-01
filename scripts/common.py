"""Shared helpers for the GitHub Actions data pipeline (no API keys needed here)."""
import json, math, os, re, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
UA = 'Mozilla/5.0 (compatible; StockScope-Personal/2.0; +https://github.com)'


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def http_get(url, timeout=25, retries=2, accept='*/*'):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': accept})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except Exception as exc:  # network errors are retried, then raised
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f'{url}: {last}')


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return default


def write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    tmp.replace(path)


def previous_published(name):
    """Fetch the copy currently live on GitHub Pages (data is not committed back to the repo)."""
    base = os.environ.get('PAGES_BASE_URL', '').rstrip('/')
    if not base:
        return None
    try:
        return json.loads(http_get(base + '/data/' + name + '?t=' + str(int(time.time())), timeout=30, retries=1))
    except Exception as exc:
        print('previous', name, 'unavailable:', exc)
        return None


# ---------- Yahoo Finance chart endpoint ----------

def positive(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0


def yahoo_code(symbol, market):
    if market == 'JP':
        return symbol + '.T'
    return symbol.replace('.', '-') if market == 'US' else symbol


def market_of(yahoo):
    if yahoo.startswith('^'):
        return 'INDEX'
    return 'JP' if yahoo.endswith('.T') else 'US'


def parse_chart(payload, config, max_rows=1600):
    chart = payload.get('chart', {})
    if chart.get('error') or not chart.get('result'):
        raise ValueError(str(chart.get('error') or 'No chart result'))
    result = chart['result'][0]
    meta = result['meta']
    if meta.get('symbol', '').upper() != config['yahoo'].upper():
        raise ValueError('Returned symbol does not match request')
    expected = 'USD' if config['market'] == 'US' else 'JPY'
    if meta.get('currency') != expected:
        raise ValueError('Unexpected currency ' + str(meta.get('currency')))
    quote = result['indicators']['quote'][0]
    tz = ZoneInfo(meta.get('exchangeTimezoneName', 'Asia/Tokyo'))
    rows = {}
    for i, ts in enumerate(result.get('timestamp', []) or []):
        def val(key):
            a = quote.get(key) or []
            return a[i] if i < len(a) else None
        close = val('close')
        if not positive(close):
            continue
        day = datetime.fromtimestamp(ts, tz).strftime('%Y-%m-%d')
        row = {'date': day, 'close': round(close, 6)}
        o, h, l = val('open'), val('high'), val('low')
        if all(positive(v) for v in (o, h, l)) and l <= min(o, close) and h >= max(o, close):
            row.update(open=round(o, 6), high=round(h, 6), low=round(l, 6))
        volume = val('volume')
        if isinstance(volume, (int, float)) and math.isfinite(volume) and volume >= 0:
            row['volume'] = volume
        rows[day] = row
    rows = [rows[k] for k in sorted(rows)][-max_rows:]
    if len(rows) < 21:
        raise ValueError('Less than 21 valid trading days')
    name = config.get('name') or meta.get('longName') or meta.get('shortName') or config['symbol']
    return {**config, 'name': name, 'providerName': meta.get('longName') or meta.get('shortName') or '',
            'currency': expected, 'rows': rows, 'fetchedAt': now_iso(),
            'source': 'Yahoo Finance / chart endpoint（非公式取得・配当調整なし、分割調整は配信元依存）',
            'sourceUrl': 'https://finance.yahoo.com/quote/' + urllib.parse.quote(config['yahoo'], safe='') + '/history/'}


def fetch_stock(config, range_='10y', max_rows=1600):
    last = None
    for host in ('query1.finance.yahoo.com', 'query2.finance.yahoo.com'):
        url = ('https://' + host + '/v8/finance/chart/' + urllib.parse.quote(config['yahoo'], safe='')
               + '?interval=1d&range=' + range_)
        try:
            payload = json.loads(http_get(url, accept='application/json', retries=1))
            return parse_chart(payload, config, max_rows)
        except Exception as exc:
            last = exc
            time.sleep(1)
    raise RuntimeError(str(last))


# ---------- technical summary passed to the AI and shown in the app ----------

def technicals(rows):
    cl = [r['close'] for r in rows]
    if len(cl) < 21:
        return None

    def chg(n):
        return round((cl[-1] / cl[-1 - n] - 1) * 100, 2) if len(cl) > n else None

    def ma(n):
        return sum(cl[-n:]) / n if len(cl) >= n else None
    gains = losses = 0.0
    for i in range(len(cl) - 14, len(cl)):
        d = cl[i] - cl[i - 1]
        gains += max(0, d)
        losses += max(0, -d)
    rsi = 100.0 if losses == 0 and gains > 0 else 50.0 if losses == 0 else 100 - 100 / (1 + gains / losses)
    year = cl[-250:]
    m25, m75 = ma(25), ma(75)
    return {
        'date': rows[-1]['date'], 'close': cl[-1],
        'chg1d': chg(1), 'chg5d': chg(5), 'chg20d': chg(20), 'chg60d': chg(60),
        'vsMA25': round((cl[-1] / m25 - 1) * 100, 2) if m25 else None,
        'vsMA75': round((cl[-1] / m75 - 1) * 100, 2) if m75 else None,
        'rsi14': round(rsi, 1),
        'from52wHigh': round((cl[-1] / max(year) - 1) * 100, 2),
        'from52wLow': round((cl[-1] / min(year) - 1) * 100, 2),
    }


# ---------- per-stock price files (data/prices/*.json) + data/index.json ----------

def file_id(market, symbol):
    return market + '_' + re.sub(r'[^A-Za-z0-9-]', '', symbol)


def to_file(record):
    rows = [[r['date'], r.get('open'), r.get('high'), r.get('low'), r['close'], r.get('volume')] for r in record['rows']]
    return {'version': 2, 'symbol': record['symbol'], 'market': record['market'], 'name': record.get('name') or record['symbol'],
            'yahoo': record['yahoo'], 'currency': record.get('currency'), 'fetchedAt': record.get('fetchedAt'),
            'source': record.get('source', ''), 'sourceUrl': record.get('sourceUrl', ''), 'rows': rows}


def from_file(doc):
    keys = ('date', 'open', 'high', 'low', 'close', 'volume')
    return {**doc, 'rows': [{k: v for k, v in zip(keys, r) if v is not None} for r in doc.get('rows', [])]}


def index_entry(record, kind):
    fid = file_id(record['market'], record['symbol'])
    closes = [r['close'] for r in record['rows'][-60:]]
    return {'symbol': record['symbol'], 'market': record['market'], 'name': record.get('name') or record['symbol'],
            'yahoo': record['yahoo'], 'kind': kind, 'file': 'prices/' + fid + '.json',
            'tech': technicals(record['rows']), 'spark': [round(c, 4) for c in closes]}


def save_record(record, kind):
    write_json(DATA / 'prices' / (file_id(record['market'], record['symbol']) + '.json'), to_file(record))
    return index_entry(record, kind)


def load_record(entry):
    doc = read_json(DATA / entry['file'])
    return from_file(doc) if doc else None
