"""東京都内のイベント・催し物・クルーズ情報を各公式サイト等から集めて data/tokyo-events.json に保存する。
各項目: d=開始日, e=終了日, t=タイトル, v=施設名, a=場所（区など）, s=開始時刻, x=終了時刻, c=分類, src=出典, u=URL
"""
import json, os, re, sys, time, html, datetime as dt, urllib.request

OUT = "data/tokyo-events.json"
JST = dt.timezone(dt.timedelta(hours=9))
TODAY = dt.datetime.now(JST).date()
KEEP_FROM = TODAY - dt.timedelta(days=7)
UA = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      "Accept-Language": "ja"}
LOCAL = os.environ.get("EVENTS_LOCAL")  # テスト用：ローカルのHTMLを読む
log = lambda *a: print(*a, flush=True)

def get(u, tries=3):
    if LOCAL:
        p = os.path.join(LOCAL, LOCAL_MAP.get(u, "__none__"))
        return open(p, encoding="utf-8").read() if os.path.exists(p) else ""
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            log("  retry", u, e); time.sleep(3 + i * 3)
    return ""
LOCAL_MAP = {}

def lines(s):
    s = re.sub(r"<(script|style|noscript)\b.*?</\1>", "", s, flags=re.S | re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", "\n", s))
    return [re.sub(r"[ \t　]+", " ", l).strip() for l in s.split("\n") if l.strip()]

def hhmm(h, m="00"): return f"{int(h):02d}:{int(m):02d}"
def iso(y, m, d): return dt.date(int(y), int(m), int(d)).isoformat()
def year_for(m, base=TODAY):
    # 月だけ分かるとき、今日から見て近い年を選ぶ
    y = base.year
    if int(m) < base.month - 6: y += 1
    elif int(m) > base.month + 6: y -= 1
    return y
def months_ahead(n):
    y, m = TODAY.year, TODAY.month
    out = []
    for i in range(n):
        mm = m + i; yy = y + (mm - 1) // 12; mm = (mm - 1) % 12 + 1
        out.append((yy, mm))
    # 過去1週間が前月にかかるとき前月も
    if KEEP_FROM.month != TODAY.month: out.insert(0, (KEEP_FROM.year, KEEP_FROM.month))
    return out

def ev(d, t, v, a="", s="", x="", c="", src="", u="", e=None):
    return {"d": d, "e": e or d, "t": t.strip(), "v": v, "a": a, "s": s, "x": x, "c": c, "src": src, "u": u}

# ---------- 東京ビッグサイト ----------
def bigsight():
    out = []
    for p in range(1, 12):
        L = lines(get(f"https://www.bigsight.jp/visitor/event/search.php?page={p}"))
        if not L: break
        n0 = len(out)
        for i, l in enumerate(L):
            if l != "開催期間" or i + 1 >= len(L): continue
            m = re.findall(r"(\d{4})年(\d{1,2})月(\d{1,2})日", L[i + 1])
            if not m: continue
            d0 = iso(*m[0]); d1 = iso(*m[-1])
            # タイトル：「入場区分」より前の、説明文の前の行
            j = i
            while j > 0 and L[j] != "入場区分": j -= 1
            k = j - 1
            if k >= 0 and L[k] != "新規タブで開きます": k -= 1  # 説明文を飛ばす
            if k >= 0 and L[k] == "新規タブで開きます": k -= 1
            title = L[k] if k >= 0 else ""
            hall = ""
            for q in range(j, i):
                if L[q] == "利用施設": hall = L[q + 1]
            s = x = ""
            for q in range(i, min(i + 6, len(L))):
                if L[q] == "開催時間" and q + 1 < len(L):
                    mt = re.search(r"(\d{1,2}):(\d{2})\s*[-－~〜～]\s*(\d{1,2}):(\d{2})", L[q + 1])
                    if mt: s, x = hhmm(*mt.groups()[:2]), hhmm(*mt.groups()[2:])
            out.append(ev(d0, title, "東京ビッグサイト" + (f"（{hall}）" if hall else ""), "江東区有明", s, x, "展示会", "東京ビッグサイト",
                          "https://www.bigsight.jp/visitor/event/", e=d1))
        if len(out) == n0: break
        if not LOCAL: time.sleep(1.5)
    return out

# ---------- 東京ドーム／後楽園ホール ----------
def dome_like(path, venue, area, src):
    out = []
    for y, m in months_ahead(6):
        L = lines(get(f"https://www.tokyo-dome.co.jp/{path}?date={y}-{m:02d}"))
        cur = None
        for i, l in enumerate(L):
            md = re.fullmatch(r"(\d{1,2})月(\d{1,2})日（.）", l)
            if md:
                cur = iso(year_for(md[1], dt.date(y, m, 1)) if False else (y if int(md[1]) >= m or m - int(md[1]) < 6 else y + 1), md[1], md[2]); continue
            mt = re.search(r"(開演|開始|試合開始)\s*[①]?(\d{1,2}):(\d{2})", l)
            if cur and mt and i >= 1:
                title = L[i - 1]
                cat = L[i - 2] if i >= 2 else ""
                if re.fullmatch(r"\d{1,2}月\d{1,2}日（.）", title): continue
                op = re.search(r"開場\s*(\d{1,2}):(\d{2})", l)
                out.append(ev(cur, title, venue, area, hhmm(mt[2], mt[3]), "", cat if len(cat) <= 8 else "", src,
                              f"https://www.tokyo-dome.co.jp/{path}"))
                if op: out[-1]["o"] = hhmm(*op.groups())
        if not LOCAL: time.sleep(1.5)
    # 同じ日・同じタイトルの重複を除く
    seen, res = set(), []
    for e in out:
        k = (e["d"], e["t"])
        if k not in seen: seen.add(k); res.append(e)
    return res

# ---------- 有明アリーナ ----------
def ariake():
    out = []
    for slug in ["", "next/", "two/", "three/"]:
        L = lines(get(f"https://ariake-arena.tokyo/event/{slug}"))
        for i, l in enumerate(L):
            if l != "公演時間": continue
            title = L[i - 1]; artist = L[i - 2] if i >= 2 else ""
            name = title if artist in title or re.match(r"\d", artist) else f"{artist}　{title}"
            for q in range(i + 1, min(i + 8, len(L))):
                mt = re.match(r"(\d{1,2})\.(\d{1,2})\s*\w*\s*(?:開場\s*(\d{1,2}):(\d{2}))?\s*/?\s*開演\s*(\d{1,2}):(\d{2})", L[q])
                if not mt: 
                    if L[q] in ("料金", "公式サイト"): break
                    continue
                mo, da = int(mt[1]), int(mt[2])
                e = ev(iso(year_for(mo), mo, da), name, "有明アリーナ", "江東区有明", hhmm(mt[5], mt[6]), "", "", "有明アリーナ",
                       "https://ariake-arena.tokyo/event/")
                if mt[3]: e["o"] = hhmm(mt[3], mt[4])
                out.append(e)
        if not LOCAL: time.sleep(1.5)
    return out

# ---------- 東京ガーデンシアター ----------
def garden():
    out = []
    for y, m in months_ahead(5):
        L = lines(get(f"https://www.shopping-sumitomo-rd.com/tokyo_garden_theater/schedule/?date={y}-{m:02d}"))
        try: st = L.index("すべて") + 1
        except ValueError: continue
        i = st
        while i < len(L) - 3:
            if re.fullmatch(r"\d{1,2}", L[i]) and re.fullmatch(r"\d{2}", L[i + 1]) and re.fullmatch(r"[A-Z][a-z]{2}\.", L[i + 2]):
                d0 = (int(L[i]), int(L[i + 1])); i += 3; d1 = d0
                if i < len(L) - 2 and re.fullmatch(r"\d{1,2}", L[i]) and re.fullmatch(r"\d{2}", L[i + 1]) and re.fullmatch(r"[A-Z][a-z]{2}\.", L[i + 2]):
                    d1 = (int(L[i]), int(L[i + 1])); i += 3
                cat = L[i] if i < len(L) else ""
                artist = L[i + 1] if i + 1 < len(L) else ""
                title = L[i + 2] if i + 2 < len(L) else ""
                if re.fullmatch(r"\d{1,2}|\d{4}", title) or title in ("東京ガーデンシアター",): title = artist; artist = ""
                name = title if not artist or artist in title else f"{title}（{artist}）"
                if len(name) > 90: name = title
                y0 = year_for(d0[0], dt.date(y, m, 15)); y1 = year_for(d1[0], dt.date(y, m, 15))
                out.append(ev(iso(y0, *d0), name, "東京ガーデンシアター", "江東区有明", "", "", cat, "東京ガーデンシアター",
                              "https://www.shopping-sumitomo-rd.com/tokyo_garden_theater/schedule/", e=iso(y1, *d1)))
                i += 3
            elif L[i] in ("東京ガーデンシアター",) and i > st + 5:
                break
            else:
                i += 1
        if not LOCAL: time.sleep(1.5)
    seen, res = set(), []
    for e in out:
        k = (e["d"], e["t"])
        if k not in seen: seen.add(k); res.append(e)
    return res

# ---------- 東京国際フォーラム ----------
def forum():
    out = []
    for y, m in months_ahead(4):
        L = lines(get(f"https://www.t-i-forum.co.jp/visitors/event/?year={y}&month={m}"))
        cur = None
        for i, l in enumerate(L):
            md = re.fullmatch(r"(\d{4})年(\d{2})月(\d{2})日（.）", l)
            if md: cur = iso(*md.groups()); continue
            if cur and l in ("一般", "一般&関係者") and i + 1 < len(L):
                t = L[i + 1]
                if i + 2 < len(L) and not re.fullmatch(r"(一般|関係者|一般&関係者|\d{4}年.*)", L[i + 2]) and len(L[i + 2]) < 40 and L[i + 2].startswith(("～", "〜", "【", "(", "（")):
                    t += " " + L[i + 2]
                out.append(ev(cur, t, "東京国際フォーラム", "千代田区丸の内", "", "", "", "東京国際フォーラム",
                              "https://www.t-i-forum.co.jp/visitors/event/"))
            if l in ("ページトップへ", "このページのトップへ"): cur = None
        if not LOCAL: time.sleep(1.5)
    # 連続する日をまとめる
    by = {}
    for e in out: by.setdefault(e["t"], []).append(e["d"])
    res = []
    for t, ds in by.items():
        ds = sorted(set(ds)); start = prev = ds[0]
        for d in ds[1:] + [None]:
            if d and dt.date.fromisoformat(d) - dt.date.fromisoformat(prev) == dt.timedelta(days=1): prev = d; continue
            res.append(ev(start, t, "東京国際フォーラム", "千代田区丸の内", "", "", "", "東京国際フォーラム", "https://www.t-i-forum.co.jp/visitors/event/", e=prev))
            if d: start = prev = d
    return res

# ---------- ウォーカープラス（東京都） ----------
def walker(cache):
    found = {}
    days = [TODAY + dt.timedelta(days=k) for k in range(0, 15)]
    for di, day in enumerate(days):
        pages = 5 if di == 0 else 2
        for p in range(1, pages + 1):
            u = f"https://www.walkerplus.com/event_list/{day:%m%d}/ar0313/" + (f"{p}.html" if p > 1 else "")
            s = get(u, tries=2)
            if not s: break
            for blk in re.findall(r'<li class="m-mainlist__item">(.*?)</li>\s*(?=<li class="m-mainlist__item">|</ul>)', s, re.S):
                m = re.search(r'href="/event/(ar0313e\d+)/">([^<]+)</a>', blk)
                per = re.search(r'm-mainlist-item-event__period">(.*?)</span>\s*</p>', blk, re.S)
                if not m or not per: continue
                pt = re.sub(r"<[^>]+>", " ", per.group(1))
                ds = re.findall(r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日", pt)
                if not ds: continue
                y0 = int(ds[0][0] or TODAY.year)
                d0 = iso(y0, ds[0][1], ds[0][2])
                y1 = int(ds[-1][0] or y0)
                if int(ds[-1][1]) < int(ds[0][1]) and not ds[-1][0]: y1 = y0 + 1
                d1 = iso(y1, ds[-1][1], ds[-1][2])
                wards = re.findall(r'm-mainlist-item-event__maplink"[^>]*>([^<]+)</a>', blk)
                place = re.search(r'm-mainlist-item-event__place">(?:<a[^>]*>)?([^<]+)', blk)
                tags = re.findall(r'm-mainlist-item-event__tagslink"[^>]*>([^<]+)</a>', blk)
                found[m[1]] = ev(d0, html.unescape(m[2]), html.unescape(place[1].strip()) if place else "",
                                 "".join(w for w in wards if w != "東京都"), "", "", tags[0] if tags else "", "ウォーカープラス",
                                 f"https://www.walkerplus.com/event/{m[1]}/", e=d1)
            if not LOCAL: time.sleep(1.2)
    # 時間は詳細ページから（キャッシュして同じイベントは読み直さない）
    n = 0
    for k, e in found.items():
        c = cache.get(k)
        if c is None and n < 120:
            L = lines(get(e["u"], tries=2)); n += 1
            c = ""
            for i, l in enumerate(L):
                if l == "開催時間" and i + 1 < len(L): c = L[i + 1][:120]; break
            if L: cache[k] = c
            if not LOCAL: time.sleep(1.0)
        if c:
            mt = re.search(r"(\d{1,2})[:：](\d{2})\s*[〜～~\-－]\s*(\d{1,2})[:：](\d{2})", c)
            if mt: e["s"], e["x"] = hhmm(mt[1], mt[2]), hhmm(mt[3], mt[4])
            else:
                m1 = re.search(r"(\d{1,2})[:：](\d{2})", c)
                if m1: e["s"] = hhmm(*m1.groups())
            e["h"] = c
    return list(found.values())

# ---------- 東京港の客船（クルーズ）入出港 ----------
def cruise(cache):
    out = []
    arts = []
    for p in range(1, 5):
        u = "https://www.tptc.co.jp/terminal/guide/news" + (f"?cmdarticlesearch=1&posted_sort=d&absolutepage={p}" if p > 1 else "")
        s = get(u)
        if p == 1 and not s: s = get("https://www.tptc.co.jp/terminal/")
        arts += re.findall(r'href="((?:https://www\.tptc\.co\.jp)?/terminal/guide/news/detail/\d+)"[^>]*>\s*([^<]*入出?港[^<]*)', s)
        if not LOCAL: time.sleep(1.2)
    seen = set()
    for h, title in arts:
        u = h if h.startswith("http") else "https://www.tptc.co.jp" + h
        if u in seen: continue
        seen.add(u)
        c = cache.get(u)
        if c is None:
            L = lines(get(u)); c = {}
            for i, l in enumerate(L):
                if l in ("入出港場所", "客船名", "入港予定日時", "出港予定日時") and i + 1 < len(L):
                    c[l] = " ".join(L[i + 1:i + 4]) if "日時" in l else L[i + 1]
            if c: cache[u] = c
            if not LOCAL: time.sleep(1.0)
        if not c.get("入港予定日時"): continue
        a = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2})\s*時\s*(\d{2})\s*分", c.get("入港予定日時", ""))
        b = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2})\s*時\s*(\d{2})\s*分", c.get("出港予定日時", ""))
        if not a: continue
        term = c.get("入出港場所", "")
        out.append(ev(iso(*a.groups()[:3]), f"客船入出港：{c.get('客船名','')}", term or "東京港客船ターミナル",
                      "江東区青海" if "国際" in term else ("中央区晴海" if "晴海" in term else ""), hhmm(a[4], a[5]),
                      hhmm(b[4], b[5]) if b else "", "クルーズ", "東京港客船ターミナル（東京港埠頭）", u,
                      e=iso(*b.groups()[:3]) if b else None))
    return out

def main():
    prev = {}
    if os.path.exists(OUT):
        try: prev = json.load(open(OUT, encoding="utf-8"))
        except Exception: prev = {}
    cache = prev.get("cache", {})
    wcache, ccache = cache.get("walker", {}), cache.get("cruise", {})
    src = {}
    for name, fn in [("bigsight", bigsight), ("dome", lambda: dome_like("dome/event/schedule.html", "東京ドーム", "文京区後楽", "東京ドーム")),
                     ("hall", lambda: dome_like("hall/event", "後楽園ホール", "文京区後楽", "後楽園ホール")),
                     ("ariake", ariake), ("garden", garden), ("forum", forum),
                     ("walker", lambda: walker(wcache)), ("cruise", lambda: cruise(ccache))]:
        try:
            r = fn(); src[name] = r; log(name, len(r), r[:2])
        except Exception as e:
            import traceback; traceback.print_exc(); log(name, "FAILED", e)
    # 取得できなかった情報源は前回分を残す
    old = {}
    for e in prev.get("events", []): old.setdefault(e.get("k"), []).append(e)
    events = []
    for name in ["bigsight", "dome", "hall", "ariake", "garden", "forum", "walker", "cruise"]:
        r = src.get(name)
        if not r: r = old.get(name, [])
        for e in r: e["k"] = name; events.append(e)
    # 過去は1週間前まで（終了日で判定）
    events = [e for e in events if e["e"] >= KEEP_FROM.isoformat() and e["t"]]
    events.sort(key=lambda e: (e["d"], e["s"] or "99", e["t"]))
    data = {"updated": dt.datetime.now(JST).isoformat(timespec="minutes"), "keepFrom": KEEP_FROM.isoformat(),
            "count": len(events), "events": events, "cache": {"walker": wcache, "cruise": ccache}}
    os.makedirs("data", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f: json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log("total", len(events), {k: len(v) for k, v in src.items()})

if __name__ == "__main__":
    main()
