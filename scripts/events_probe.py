import os, re, time, urllib.request, datetime as dt
UA={"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1","Accept-Language":"ja"}
def get(u):
    for i in range(3):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=40).read().decode("utf-8","replace")
        except Exception as e: print("retry",u,e); time.sleep(3)
    return ""
os.makedirs("probe",exist_ok=True)
P={"bigsight1":"https://www.bigsight.jp/visitor/event/search.php?page=1",
"dome":"https://www.tokyo-dome.co.jp/dome/event/schedule.html?date=2026-12",
"hall":"https://www.tokyo-dome.co.jp/hall/event?date=2026-12",
"ariake":"https://ariake-arena.tokyo/event/next/",
"garden":"https://www.shopping-sumitomo-rd.com/tokyo_garden_theater/schedule/?date=2026-12",
"forum":"https://www.t-i-forum.co.jp/visitors/event/?year=2026&month=12",
"walker":"https://www.walkerplus.com/event_list/1129/ar0313/",
"walker_detail":"https://www.walkerplus.com/event/ar0313e614246/",
"tptc_list":"https://www.tptc.co.jp/terminal/guide/news?cmdarticlesearch=1&posted_sort=d&absolutepage=2",
"tptc_art":"https://www.tptc.co.jp/terminal/guide/news/detail/1568"}
for k,u in P.items():
    s=get(u); open(f"probe/{k}.html","w").write(s); print(k,len(s)); time.sleep(1)
