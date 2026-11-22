import os, urllib.request
U={
"kw_cruise":"https://www.kouwan.metro.tokyo.lg.jp/kanko/cruise",
"kw_ship":"https://www.kouwan.metro.tokyo.lg.jp/yakuwari/minatomaru/shippingschedule",
"kw_pdf26a":"https://www.kouwan.metro.tokyo.lg.jp/documents/d/kouwan/cruiseschedule_2026_japanese",
"kw_pdf24":"https://www.kouwan.metro.tokyo.lg.jp/documents/d/kouwan/cruiseschedule_2024_japanese",
"walker_day_p2":"https://www.walkerplus.com/event_list/1129/ar0313/2.html",
}
os.makedirs("probe",exist_ok=True)
for k,u in U.items():
    try:
        r=urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1","Accept-Language":"ja"}),timeout=30)
        b=r.read(); ct=r.headers.get("content-type","")
        ext="pdf" if "pdf" in ct else "html"
        open(f"probe/{k}.{ext}","wb").write(b); print(k,r.status,ct,len(b),r.geturl())
    except Exception as e:
        print(k,"ERR",e)
