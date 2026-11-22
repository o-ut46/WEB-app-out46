import os, urllib.request
U={
"bigsight":"https://www.bigsight.jp/visitor/event/",
"dome":"https://www.tokyo-dome.co.jp/dome/event/schedule.html",
"budokan":"https://www.nipponbudokan.or.jp/schedule/",
"forum":"https://www.t-i-forum.co.jp/visitors/event/",
"ariake":"https://ariake-arena.tokyo/event/",
"gardentheater":"https://www.shopping-sumitomo-rd.com/tokyo_garden_theater/schedule/",
"kokugikan":"https://www.ryogoku-kokugikan.jp/schedule/",
"kouwan_cruise":"https://www.kouwan.metro.tokyo.lg.jp/kanko/kyakusen",
"kouwan_pdf26":"https://www.kouwan.metro.tokyo.lg.jp/documents/d/kouwan/cruiseschedule_2026_japanese",
"gotokyo":"https://www.gotokyo.org/jp/event/index.html",
"walker":"https://www.walkerplus.com/event_list/today/ar0313/",
"jorudan":"https://www.jorudan.co.jp/eventinfo/tokyo/",
"tokyodome_city_hall":"https://www.tokyo-dome.co.jp/hall/event/",
"ntt_budokan_alt":"https://www.nipponbudokan.or.jp/schedule/2026/12",
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
