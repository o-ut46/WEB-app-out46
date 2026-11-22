import os, re, urllib.request
UA={"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1","Accept-Language":"ja"}
def get(u): return urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=30).read().decode("utf-8","replace")
os.makedirs("probe",exist_ok=True)
top=get("https://www.tptc.co.jp/terminal/"); open("probe/tptc_top.html","w").write(top)
links=re.findall(r'href="([^"]+)"[^>]*>\s*([^<]*入出港[^<]*)',top)
print(links[:5])
for i,(h,t) in enumerate(links[:2]):
    u=h if h.startswith("http") else "https://www.tptc.co.jp"+h
    open(f"probe/tptc_art{i}.html","w").write(get(u)); print(u)
open("probe/tptc_event.html","w").write(get("https://www.tptc.co.jp/terminal/event"))
