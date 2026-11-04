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
    # 保有株：holdings/ の一番新しいファイルが今の保有リスト（銘柄コードのみ。株数・単価は送らない）
    # 気になる銘柄（☆）：favorites/ も同じ形式
    for flag, folder in (('holding', 'holdings'), ('favorite', 'favorites')):
        for code, market in load_holdings(folder):
            yahoo = yahoo_code(code, market)
            hit = next((t for t in targets if t['yahoo'] == yahoo), None)
            if hit:
                hit[flag] = True
            else:
                seen.add(yahoo)
                targets.append({'symbol': code, 'market': market, 'name': names.get((market, code), ''), 'yahoo': yahoo, flag: True})
    return targets


def load_holdings(name='holdings'):
    folder = ROOT / name
    files = sorted(folder.glob('*.txt')) if folder.exists() else []
    latest = folder / 'latest.txt'
    if latest.exists():  # written by the app automatically (GitHub連携) — always the current list
        files = [p for p in files if p != latest] + [latest]
    if not files:
        return []
    out = []
    for line in files[-1].read_text(encoding='utf-8', errors='ignore').splitlines():
        tok = line.strip().split(' ')[0].upper() if line.strip() else ''
        if re.fullmatch(r'[0-9]{3}[0-9A-Z]', tok):
            out.append((tok, 'JP'))
        elif re.fullmatch(r'[A-Z][A-Z0-9.-]{0,9}', tok):
            out.append((tok.replace('.', '-'), 'US'))
    print(name, 'list', files[-1].name, len(out))
    return out[:30]


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
            entry = save_record(record, 'tracked')
            for flag in ('holding', 'favorite'):
                if config.get(flag):
                    entry[flag] = True
            entries.append(entry)
    if not entries:
        raise RuntimeError('No price data at all; aborting so the live site is not replaced')
    write_json(DATA / 'index.json', {'version': 2, 'generatedAt': now_iso(), 'errors': errors, 'stocks': entries})
    print('Saved', len(entries), 'stocks;', len(errors), 'errors')


if __name__ == '__main__':
    main()
