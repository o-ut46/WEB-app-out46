# Stock Scope（作り直し版）

自分用の株の動向チェックアプリです。サーバーやCloudflareは使わず、**GitHubだけで毎朝ひとりでに更新**されます。

## できること
- **注目**：毎朝のAIまとめ（日本株・米国株の相場の要点、証券会社などの見通し、リスク）、ニュースで材料が出た注目銘柄のチャート、大きく動いた銘柄、銘柄ごとのニュース要約。すべて出典リンク付き。
- **探す**：東証の全上場銘柄と米国の上場銘柄を、会社名（ひらがな可）・4桁コード・ティッカーで検索。
- **銘柄の画面**：ローソク足（1か月〜5年）、25日・75日平均、出来高。指でなぞると日ごとの値。騰落率・RSI・52週高安・参考レンジ・ニュース要約・保有損益。
- **ウォッチ**：自分のウォッチと保有株の損益（端末に保存）、毎朝の自動更新リスト。
- 株価の上昇は赤、下落は青（日本の慣習）。ダークモード対応。iPhoneのホーム画面に追加するとアプリのように使えます。

## 毎朝の自動処理（GitHub Actions、日本時間 月〜土 7:23頃）
1. JPX公式の上場銘柄一覧と、Nasdaq Traderの米国銘柄一覧を取得（検索用）
2. 自動更新リストの株価をYahoo Financeから取得
3. 信頼できる媒体（日経・ロイター・ブルームバーグ・株探・東洋経済・ダイヤモンド・各証券会社・JPX・TDnetなど）の記事をGoogleニュースとClaudeのWeb検索で集め、Claudeが要約。掲示板・SNS・個人ブログは使いません。出典を示せない内容と、実在しない銘柄コードは自動で除外します。
4. 注目銘柄の株価を取得して公開

## 設定手順（初回だけ）

### 1. ファイルを置く
`o-ut46/WEB-app-out46` に、ZIPの中身をすべて上書きアップロードします（公開URLは今までどおり）。
- **`.github/workflows/update-stocks.yml` が一番大事です。** ドットで始まるフォルダはアップロードから漏れやすいので、アップロード後にGitHub上で `.github/workflows/update-stocks.yml` の中身が新しくなっているか確認してください。漏れていたら「Add file → Create new file」でファイル名に `.github/workflows/update-stocks.yml` と入力し、中身を貼り付けて保存します。
- ChatGPT版の古いファイル（`ranking-engine.js`、`ranking-ui.js`、`worker/`、`data/stocks.json`、`data/snapshot.js`）は使わないので、削除して構いません（残っていても動作に影響はありません）。

### 2. ClaudeのAPIキーを作る
https://console.anthropic.com → **Billing** でクレジット購入 → **Limits** で月の上限を設定（例 $10） → **API Keys** でキーを作成してコピー。

### 3. キーをGitHubに登録
リポジトリの **Settings → Secrets and variables → Actions → New repository secret**
名前 `ANTHROPIC_API_KEY`、値にコピーしたキー。キーは公開ページには含まれません。

### 4. 実行
**Settings → Pages → Source** が「GitHub Actions」になっていることを確認し、**Actions → Update stock data and publish → Run workflow**。5〜10分で完了します。

※ APIキーを登録しなくても、検索・チャート・ウォッチは動きます（AIまとめだけが出ません）。

## 銘柄の追加・削除
- 追加：銘柄の画面で「毎朝の自動更新に追加」→ GitHubが開く → 緑の **Commit changes**。数分後に株価、翌朝からニュース要約が入ります。
- 削除：GitHubの `watchlist` フォルダから銘柄のファイル（例 `7203.txt`）を削除。最初から入っている37銘柄は `symbols.json` で管理しています。

## 費用
Claude APIの分だけです（GitHub・各種一覧・Googleニュースは無料）。1回の実行で入力5〜8万・出力1万トークン前後、Web検索最大6回を想定しています。実際の使用量は「設定」タブに表示されます。最新の単価は https://www.anthropic.com/pricing で確認してください。

節約したいときは **Settings → Secrets and variables → Actions → Variables** に追加：
| 名前 | 例 | 効果 |
|---|---|---|
| `MAX_WEB_SEARCHES` | `3` | Web検索の回数上限（標準6） |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | 相場まとめも軽量モデルで作る |
| `MAX_STOCK_BRIEFS` | `20` | ニュース要約する銘柄数の上限（標準40） |

銘柄の追加（Commit）のたびにAIが動かないよう、前回のまとめが18時間以内なら再利用します。すぐ作り直したいときは Actions → Run workflow。

## ファイル構成
- `index.html` / `app.js` / `style.css` / `sw.js` / `manifest.webmanifest` / アイコン：アプリ本体
- `scripts/update_symbols.py`：銘柄一覧 → `data/symbols-master.json`
- `scripts/update_prices.py`：株価 → `data/prices/*.json`, `data/index.json`
- `scripts/research.py`：ニュース収集とClaudeの要約 → `data/research.json`
- `symbols.json`、`watchlist/`：自動更新リスト
- `data/`：初期データ（10月28日までの37銘柄）。初回実行で最新になります。

## 注意
- 株価はYahoo Financeの日足（遅延・非公式の取得方法）で、リアルタイムではありません。取得先の仕様が変わると止まる可能性があります。その場合も前回のデータを表示し続けます。
- AIまとめ・参考レンジは売買の推奨ではありません。要約の誤りもありうるので、出典を確認してください。
