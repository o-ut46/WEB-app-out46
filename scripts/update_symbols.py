"""Build data/symbols-master.json: every TSE-listed issue (JPX official list) + US listed stocks/ETFs
(Nasdaq Trader symbol directory). Used by the app's code/name search. Falls back to the published copy."""
import io, re, sys
from common import DATA, http_get, now_iso, previous_published, read_json, write_json

JPX_PAGE = 'https://www.jpx.co.jp/markets/statistics-equities/misc/01.html'
NASDAQ = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt'
OTHER = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'


def jpx():
    html = http_get(JPX_PAGE).decode('utf-8', 'replace')
    m = re.search(r'href="([^"]*data_j\.xlsx?)"', html)
    if not m:
        raise RuntimeError('JPX list link not found')
    link = m.group(1)
    if link.startswith('/'):
        link = 'https://www.jpx.co.jp' + link
    raw = http_get(link, timeout=60)
    if link.endswith('.xlsx'):
        import openpyxl
        ws = openpyxl.load_workbook(io.BytesIO(raw), read_only=True).active
        table = [[c for c in row] for row in ws.iter_rows(values_only=True)]
    else:
        import xlrd
        sh = xlrd.open_workbook(file_contents=raw).sheet_by_index(0)
        table = [sh.row_values(i) for i in range(sh.nrows)]
    head = [str(x or '').strip() for x in table[0]]

    def col(*names):
        for n in names:
            for i, h in enumerate(head):
                if n in h:
                    return i
        raise RuntimeError('JPX column missing: ' + names[0])
    ic, iname, imkt, isec = col('コード'), col('銘柄名'), col('市場・商品区分', '市場'), col('33業種区分')
    out = []
    for row in table[1:]:
        code = str(row[ic] or '').strip()
        if code.endswith('.0'):
            code = code[:-2]
        if not re.fullmatch(r'[0-9]{3}[0-9A-Z]', code):
            continue
        sector = str(row[isec] or '').strip()
        out.append([code, 'JP', str(row[iname] or '').strip(), str(row[imkt] or '').strip(), '' if sector == '-' else sector])
    if len(out) < 3000:
        raise RuntimeError('JPX list unexpectedly short: %d' % len(out))
    return out


SKIP = re.compile(r'\b(Warrants?|Units?|Rights?|Preferred|Depositary Shares? Representing|Notes due|Debentures)\b', re.I)
TRIM = re.compile(r'\s*-\s*(Common Stock|Class [A-Z] Common Stock|Ordinary Shares|Class [A-Z] Ordinary Shares|American Depositary Shares).*$', re.I)


def us():
    out, seen = [], set()
    for url, sym_col, etf_col, test_col, exch in ((NASDAQ, 'Symbol', 'ETF', 'Test Issue', 'NASDAQ'), (OTHER, 'ACT Symbol', 'ETF', 'Test Issue', None)):
        lines = http_get(url).decode('utf-8', 'replace').splitlines()
        head = lines[0].split('|')
        for line in lines[1:]:
            if line.startswith('File Creation Time'):
                continue
            rec = dict(zip(head, line.split('|')))
            sym, name = rec.get(sym_col, '').strip(), rec.get('Security Name', '').strip()
            if rec.get(test_col) == 'Y' or not re.fullmatch(r'[A-Z][A-Z0-9.]{0,9}', sym) or SKIP.search(name):
                continue
            sym = sym.replace('.', '-') if '.' in sym else sym  # Yahoo style (BRK-B)
            if sym in seen:
                continue
            seen.add(sym)
            kind = 'ETF' if rec.get(etf_col) == 'Y' else 'Stock'
            exchange = exch or {'N': 'NYSE', 'A': 'NYSE American', 'P': 'NYSE Arca', 'Z': 'Cboe BZX', 'V': 'IEX'}.get(rec.get('Exchange', ''), 'US')
            out.append([sym, 'US', TRIM.sub('', name)[:80], exchange + (' ETF' if kind == 'ETF' else ''), ''])
    if len(out) < 4000:
        raise RuntimeError('US list unexpectedly short: %d' % len(out))
    return out


def main():
    previous = read_json(DATA / 'symbols-master.json') or previous_published('symbols-master.json') or {}
    old = {'JP': [x for x in previous.get('items', []) if x[1] == 'JP'], 'US': [x for x in previous.get('items', []) if x[1] == 'US']}
    errors, items = [], []
    for label, fn in (('JP', jpx), ('US', us)):
        try:
            got = fn()
            print(label, len(got))
        except Exception as exc:
            errors.append(label + ': ' + str(exc)[:200])
            got = old[label]
            print('FAILED', label, exc, '-> keeping', len(got))
        items += got
    if not items:
        print('No symbol list available; app will use its built-in directory.')
        return
    write_json(DATA / 'symbols-master.json', {'version': 1, 'generatedAt': now_iso(), 'errors': errors,
                                               'columns': ['symbol', 'market', 'name', 'segment', 'sector'], 'items': items})


if __name__ == '__main__':
    sys.exit(main())
