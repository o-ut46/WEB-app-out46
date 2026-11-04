"""Apply changes sent from the app (気になる銘柄・保有株・気になるテーマ) without any GitHub token.

The app publishes a small JSON message to a private ntfy.sh topic (name in sync-topic.txt); this script
reads the messages since the last one it processed, updates favorites/latest.txt, holdings/latest.txt and
topics/*.txt, and writes sync-state.json. Codes are validated against the official symbol list."""
import json, os, re, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOPIC = (ROOT / 'sync-topic.txt').read_text().strip()
STATE = ROOT / 'sync-state.json'


def fetch(since):
    url = f'https://ntfy.sh/{TOPIC}/json?poll=1&since={since}'
    req = urllib.request.Request(url, headers={'User-Agent': 'stockscope-sync/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return [json.loads(l) for l in r.read().decode('utf-8').splitlines() if l.strip()]


def valid_codes(items, master):
    out = []
    for it in items or []:
        code = str(it.get('s') if isinstance(it, dict) else it).strip().upper()[:12]
        mk = 'JP' if re.fullmatch(r'[0-9]{3}[0-9A-Z]', code) else 'US' if re.fullmatch(r'[A-Z][A-Z0-9-]{0,9}', code) else None
        if not mk or (master and (mk, code) not in master) or code in [c for c, _ in out]:
            continue
        out.append((code, master.get((mk, code), '') if master else ''))
    return out[:30]


def current_list(folder):
    files = sorted(p for p in folder.glob('*.txt'))
    latest = folder / 'latest.txt'
    if latest.exists():
        files = [p for p in files if p != latest] + [latest]
    if not files:
        return []
    out = []
    for line in files[-1].read_text(encoding='utf-8', errors='ignore').splitlines():
        parts = line.strip().split(' ', 1)
        if parts and parts[0]:
            out.append((parts[0].upper(), parts[1] if len(parts) > 1 else ''))
    return out


def topic_file(name):
    return re.sub(r'[\\/:*?"<>|#%\x00-\x1f]', ' ', str(name)).strip()[:40]


def main():
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    msgs = [m for m in fetch(state.get('last') or '12h') if m.get('event') == 'message']
    if not msgs:
        print('no new messages')
        return
    mdoc = {}
    try:
        mdoc = json.loads((ROOT / 'data' / 'symbols-master.json').read_text())
    except Exception:
        pass
    master = {(x[1], x[0]): x[2] for x in mdoc.get('items', [])}
    changed = []
    for m in sorted(msgs, key=lambda m: m['time']):
        try:
            body = json.loads(m.get('message') or '{}')
        except ValueError:
            continue
        if body.get('v') != 1:
            continue
        # add / remove operations only — a device that has nothing stored can never wipe the list
        for key, folder in (('fav', 'favorites'), ('hold', 'holdings')):
            add, rem = valid_codes(body.get(key + 'Add'), master), {c for c, _ in valid_codes(body.get(key + 'Del'), {})}
            if not add and not rem:
                continue
            path = ROOT / folder / 'latest.txt'
            path.parent.mkdir(exist_ok=True)
            cur = current_list(ROOT / folder)
            new = [(c, n) for c, n in cur if c not in rem] + [(c, n) for c, n in add if c not in {x for x, _ in cur}]
            text = ''.join(f'{c} {n}\n' for c, n in new[:30])
            if not path.exists() or path.read_text(encoding='utf-8') != text:
                path.write_text(text, encoding='utf-8')
                changed.append(f'{folder}: {len(new)}')
        for name in body.get('delTopic') or []:
            p = ROOT / 'topics' / (topic_file(name) + '.txt')
            if p.exists():
                p.unlink(); changed.append('topic -' + p.stem)
        for name in body.get('addTopic') or []:
            n = topic_file(name)
            p = ROOT / 'topics' / (n + '.txt')
            if n and not p.exists() and len(list((ROOT / 'topics').glob('*.txt'))) < 15:
                p.write_text(n + '\n', encoding='utf-8'); changed.append('topic +' + n)
    state['last'] = msgs[-1]['id']
    STATE.write_text(json.dumps(state))
    print('changes:', changed or 'none (only state updated)')
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f'changed={"yes" if changed else "no"}\n')


if __name__ == '__main__':
    sys.exit(main())
