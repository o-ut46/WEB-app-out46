import os, time, urllib.request
UA={"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1","Accept-Language":"ja"}
os.makedirs("probe",exist_ok=True)
P={}
for c in ["stage","theater","play","musical","engeki","kabuki","drama","2-5d","comedy","owarai","classic"]:
    P["ep_"+c]=f"https://eplus.jp/sf/event/{c}/tokyo"
P.update({"kabukiza":"https://www.kabuki-bito.jp/theaters/kabukiza/","kabukiza2":"https://www.kabuki-za.co.jp/",
"shiki":"https://www.shiki.jp/stage/","toho":"https://www.tohostage.com/schedule/","takarazuka":"https://kageki.hankyu.co.jp/schedule/index.html"})
for k,u in P.items():
    for t in range(3):
        try:
            r=urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=40); b=r.read()
            open(f"probe/{k}.html","wb").write(b); print(k,r.status,len(b),r.geturl()); break
        except Exception as e:
            print(k,"ERR",e)
            if "404" in str(e): break
            time.sleep(3)
    time.sleep(1)
