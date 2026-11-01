"""Daily price history for the tracked list (symbols.json + one file per code in watchlist/).
Writes data/prices/<MARKET>_<CODE>.json for each stock and data/index.json (latest figures + sparkline).
If a download fails, the copy already in the repo or on GitHub Pages is kept."""
import re
from concurrent.futures import ThreadPoolExecutor
from common import (DATA, ROOT, fetch_stock, file_id, from_file, now_iso, previous_published, read_json,
                    save_record, write_json, yahoo_code)


def load_targets():
    master = read_json(DATA / 'symbols-master.json') or {}
    names = {(x[1], x[0]): x[2] for x in master.get('items', [])}
    targets, seen = [], set()
    for c in read_json(ROOT / 'symbols.json', []) or []:
        if c['yahoo'] not in seen:
            seen.add(c['yahoo'])
            targets.append({k: c[k] for k in ('symbol', 'market', 'name', 'yahoo')})
    folder = ROOT / 'watchlist'
    for path in sorted(folder.glob('*.txt')) if folder.exists() else []:
        code = path.stem.strip().upper()
        if re.fullmatch(r'[0-9]{3}[0-9A-Z]', code):
            market = 'JP'
        elif re.fullmatch(r'[A-Z][A-Z0-9.-]{0,9}', code):
            market, code = 'US', code.replace('.', '-')
        else:
            print('skip watchlist file', path.name)
            continue
        yahoo = yahoo_code(code, market)
        if yahoo in seen:
            continue
        seen.add(yahoo)
        lines = path.read_text(encoding='utf-8', errors='ignore').strip().splitlines()
        name = names.get((market, code)) or (lines[0].strip()[:60] if lines else '')
        targets.append({'symbol': code, 'market': market, 'name': name, 'yahoo': yahoo})
    return targets


def fallback(config):
    name = 'prices/' + file_id(config['market'], config['symbol']) + '.json'
    doc = read_json(DATA / name) or previous_published(name)
    return from_file(doc) if doc and doc.get('rows') else None


def main():
    configs = load_targets()
    entries, errors = [], []

    def job(config):
        try:
            return config, fetch_stock(config), None
        except Exception as exc:
            return config, None, str(exc)[:250]
    with ThreadPoolExecutor(max_workers=3) as pool:
        for config, record, error in pool.map(job, configs):
            if not record:
                errors.append({'symbol': config['yahoo'], 'message': error})
                print('FAILED', config['yahoo'], error, flush=True)
                record = fallback(config)
                if not record:
                    continue
                record['name'] = config.get('name') or record.get('name')
            else:
                print(config['yahoo'], len(record['rows']), record['rows'][-1]['date'], flush=True)
            entries.append(save_record(record, 'tracked'))
    if not entries:
        raise RuntimeError('No price data at all; aborting so the live site is not replaced')
    write_json(DATA / 'index.json', {'version': 2, 'generatedAt': now_iso(), 'errors': errors, 'stocks': entries})
    print('Saved', len(entries), 'stocks;', len(errors), 'errors')


if __name__ == '__main__':
    main()
