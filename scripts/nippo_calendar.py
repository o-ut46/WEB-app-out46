"""O-UT 乗務日報リーダー用の祝日・天気データを作る。
- 祝日: 内閣府「国民の祝日」CSV（公式）
- 天気: 気象庁「過去の気象データ」東京(47662) 1時間ごとの値（降水量・気温・日照時間・天気）
出力: data/nippo-calendar.json
"""
import json, os, re, sys, time, datetime as dt, urllib.request, html

OUT = "data/nippo-calendar.json"
START = dt.date(2025, 11, 1)
JST = dt.timezone(dt.timedelta(hours=9))
UA = {"User-Agent": "Mozilla/5.0 (o-ut46 nippo-calendar; GitHub Actions)"}

def get(url, enc="utf-8"):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode(enc, errors="replace")

def holidays():
    txt = get("https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv", "shift_jis")
    out = {}
    for line in txt.splitlines()[1:]:
        p = line.strip().split(",")
        if len(p) >= 2:
            m = re.match(r"(\d{4})/(\d{1,2})/(\d{1,2})", p[0])
            if m:
                out[f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}"] = p[1].strip()
    return out

def num(s):
    s = s.strip().replace(")", "").replace("]", "").replace(" ", "")
    if s in ("--",):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None

def strip(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()

def weather_day(d):
    url = ("https://www.data.jma.go.jp/stats/etrn/view/hourly_s1.php"
           f"?prec_no=44&block_no=47662&year={d.year}&month={d.month}&day={d.day}&view=")
    page = get(url)
    rows = []
    for tr in re.findall(r"<tr class=\"mtx\"[^>]*>(.*?)</tr>", page, re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if len(tds) < 12:
            continue
        hour = strip(tds[0])
        if not hour.isdigit():
            continue
        alt = re.search(r'alt="([^"]*)"', tds[14]) if len(tds) > 14 else None
        rows.append([num(strip(tds[3])), num(strip(tds[4])), num(strip(tds[10])),
                     (alt.group(1) if alt else strip(tds[14]) if len(tds) > 14 else "")])
    return rows

def main():
    data = {}
    if os.path.exists(OUT):
        try:
            data = json.load(open(OUT, encoding="utf-8"))
        except Exception:
            data = {}
    wx = data.get("wx", {})
    try:
        data["holidays"] = holidays()
    except Exception as e:
        print("holiday fetch failed:", e)
    today = dt.datetime.now(JST).date()
    d, n, first_logged = START, 0, False
    while d <= today:
        key = d.isoformat()
        recent = (today - d).days <= 3
        if recent or key not in wx or len(wx.get(key) or []) < 24:
            try:
                rows = weather_day(d)
                if not first_logged:
                    print("sample", key, rows[:2], "rows", len(rows)); first_logged = True
                if rows:
                    wx[key] = rows
                n += 1
                time.sleep(1.0)
            except Exception as e:
                print("weather fetch failed", key, e)
        d += dt.timedelta(days=1)
    data.update({"updated": dt.datetime.now(JST).isoformat(timespec="minutes"),
                 "station": "東京（気象庁）", "wx": dict(sorted(wx.items()))})
    os.makedirs("data", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("fetched days:", n, "total days:", len(wx), "holidays:", len(data.get("holidays", {})))

if __name__ == "__main__":
    main()
