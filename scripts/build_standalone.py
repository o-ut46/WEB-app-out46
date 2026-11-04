"""Build public/stockscope-standalone.html: one self-contained file (app + latest data) that works offline,
e.g. downloaded to a PC and opened by double-click. Data is a snapshot as of the build."""
import base64, json, sys
from pathlib import Path

PUB = Path(sys.argv[1] if len(sys.argv) > 1 else 'public')


def main():
    embed = {}
    for name in ('index.json', 'research.json', 'symbols-master.json'):
        p = PUB / 'data' / name
        if p.exists():
            embed[name] = json.loads(p.read_text(encoding='utf-8'))
    for e in embed.get('index.json', {}).get('stocks', []):
        p = PUB / 'data' / e['file']
        if p.exists():
            doc = json.loads(p.read_text(encoding='utf-8'))
            doc['rows'] = doc['rows'][-750:]  # about 3 years per stock keeps the file small
            embed[e['file']] = doc
    topic = PUB / 'sync-topic.txt'
    if topic.exists():
        embed['sync-topic.txt'] = topic.read_text().strip()
    html = (PUB / 'index.html').read_text(encoding='utf-8')
    css = (PUB / 'style.css').read_text(encoding='utf-8')
    logo = 'data:image/png;base64,' + base64.b64encode((PUB / 'logo-mark.png').read_bytes()).decode()
    data_js = 'window.STOCKSCOPE_EMBED=' + json.dumps(embed, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/') + ';'
    scripts = ''.join('<script>' + (PUB / n).read_text(encoding='utf-8').replace('</script', '<\\/script') + '</script>' for n in ('search.js', 'app.js'))
    html = html.replace('<link rel="stylesheet" href="./style.css">', '<style>' + css + '</style>')
    html = html.replace('<script src="./search.js"></script>\n<script src="./app.js"></script>', '<script>' + data_js + '</script>' + scripts)
    html = html.replace('./logo-mark.png', logo)
    for tag in ('<link rel="manifest" href="./manifest.webmanifest">', '<link rel="apple-touch-icon" href="./apple-touch-icon.png">'):
        html = html.replace(tag, '')
    out = PUB / 'stockscope-standalone.html'
    out.write_text(html, encoding='utf-8')
    print('standalone', out, round(out.stat().st_size / 1e6, 2), 'MB')


if __name__ == '__main__':
    main()
