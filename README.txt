Stock Scope Webアプリ版（iPhone対応）

【無料でWeb公開する手順】
1. GitHubで「stock-scope」などの公開リポジトリを作成。
2. ZIPを解凍し、index.html / manifest.webmanifest / sw.js / icon-192.png / icon-512.png の5ファイルを同じ場所（リポジトリのルート）にアップロード。
3. GitHubの Settings → Pages → Build and deployment → Deploy from a branch → main / (root) → Save。
4. 発行された https://ユーザー名.github.io/stock-scope/ をSafariで開く。
5. Safariの「共有」→「ホーム画面に追加」でアプリアイコンから起動できます。

【動作チェック】
「保有株」タブ→銘柄コード7203・保有株数1・平均取得単価1000を入力→「保有株を追加」をタップ。
画面が反応して「登録済み保有株」に表示されればボタンは正常動作です。

【主な機能】
保有銘柄の登録、手動CSV株価取込、移動平均・RSI、候補の点数表示、チャート、JSONバックアップと復元、米国株のAlpha Vantage APIによる手動取得。
※日米全銘柄の自動スクリーニング、毎日自動更新、SBI証券との自動連携は未実装。株価データの精度と更新日は自身で確認してください。
※ネット未接続でもキャッシュ済の画面は開けますが、APIで株価を取得するにはネット接続が必要です。

【データの取り扱い】
登録した保有情報はブラウザ内に保存。ブラウザデータ消去・端末切替で失われる場合があります。定期的にJSONバックアップを保存してください。
GitHubの公開リポジトリには取引口座情報、APIキー、バックアップJSONをアップロードしないでください。
