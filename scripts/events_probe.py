import os, urllib.request
U={
"walker_p2":"https://www.walkerplus.com/event_list/ar0313/2.html",
"walker_all":"https://www.walkerplus.com/event_list/ar0313/",
"walker_day":"https://www.walkerplus.com/event_list/1129/ar0313/",
"walker_detail":"https://www.walkerplus.com/event/ar0313e614246/",
"dome_dec":"https://www.tokyo-dome.co.jp/dome/event/schedule.html?date=2026-12",
"forum_dec":"https://www.t-i-forum.co.jp/visitors/event/?year=2026&month=12",
"ariake_next":"https://ariake-arena.tokyo/event/next/",
"garden_dec":"https://www.shopping-sumitomo-rd.com/tokyo_garden_theater/schedule/?date=2026-12",
"bigsight_p2":"https://www.bigsight.jp/visitor/event/search.php?page=2",
"kouwan_top":"https://www.kouwan.metro.tokyo.lg.jp/",
"kouwan_kanko":"https://www.kouwan.metro.tokyo.lg.jp/kanko/",
"cruiseterminal":"https://www.tokyo-cruise-terminal.jp/",
"budokan_sched":"https://www.nipponbudokan.or.jp/schedule",
"kokugikan_s":"https://ryogoku-kokugikan.jp/schedule/",
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
