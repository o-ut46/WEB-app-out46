import os, urllib.request
U={"tptc_guide":"https://www.tptc.co.jp/terminal/guide"}
os.makedirs("probe",exist_ok=True)
for k,u in U.items():
    try:
        r=urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1","Accept-Language":"ja"}),timeout=30)
        b=r.read(); ct=r.headers.get("content-type","")
        ext="pdf" if "pdf" in ct else "html"
        open(f"probe/{k}.{ext}","wb").write(b); print(k,r.status,ct,len(b),r.geturl())
    except Exception as e:
        print(k,"ERR",e)
