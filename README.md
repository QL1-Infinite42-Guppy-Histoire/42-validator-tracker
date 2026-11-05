# 42チェーン バリデーター リアルタイム追跡ツール（Phase 1）

42 Chain（EVM chainId 421018）のバリデーター23名と、その本人と**直接**やり取りした関連アドレスの動きを、新しいブロックから自動で拾い、時系列フィードで公開するためのツールです。

- 公開サイト： https://ql1-infinite42-guppy-histoire.github.io/42-validator-tracker/
- リポジトリ： https://github.com/QL1-Infinite42-Guppy-Histoire/42-validator-tracker
- アラートは**サイト内だけ**（「注目」欄）。X bot等の外部投稿は行いません
- 維持費 **0円**が前提です（ホスティング案は後述）

## 何が表示されるか

- ライブフィード：時刻（JST）／バリデーター名＋区分バッジ（本人・関連・中核）／アドレス（末尾4文字表示、タップで公式エクスプローラー）／分類（送金・受取／買い／売り／LP追加／LP解除／その他の操作）／銘柄と金額／相手／Txリンク
- 絞り込み：バリデーター別・種類別・銘柄別
- バリデーター一覧（23名、それぞれの直接関連アドレス数つき）
- 「注目」欄（サイト内アラート）：ルールは明示しています —
  ① バリデーター本人の売買、② 1,000 [42] 以上の移動。条件は `collector.mjs` の `NOTABLE_42_THRESHOLD` とサイト上の表記が正です
- ステータス行：最終処理ブロック番号と更新時刻（鮮度が誰にでも分かります）

## 仕組み

```
42 Chain (EVM RPC)
   │  新ブロックを約10秒間隔で確認（collector.mjs、依存パッケージなし）
   ▼
ブロック＋レシートをまとめて取得 → ログを復号
（ERC-20 Transfer / Uniswap V2型 Swap・Mint・Burn）
   ▼
監視アドレスに絡む動きだけを分類して events.jsonl に追記
（txHash+logIndex で重複排除、state.json にチェックポイント）
   ▼
feed.json（最新500件）を再生成 → 静的サイト index.html が30秒ごとに読み直し
```

### 監視リスト（watchlist.json）

`node build-watchlist.mjs` が既存の調査データから生成します（ネットワーク不要）。

| 区分 | 件数 | 出どころ |
|---|---|---|
| バリデーター本人 | 23 | `42-cosmos-scan/validators-snapshot.json`（ステーキング 0x0800 の bonded set、2026-10-31）＋ `validator-balances.json` で照合（不一致なら生成を中止） |
| 直接関連 | 110 | `42-flowmap/data.json` の `validators[].confirmed[]`（確認済みの直接相手のみ。212リンク／重複を除き129件、うち19件はバリデーター同士のため本人区分に統合） |
| 中核（ラベルのみ） | 90 | `data.json` の core ノード＋全ペア＋明示的な仕組み系コントラクト（DEXルーター/工場、Starlight、Guide/Fluke、st42バルト、ブリッジ、ステーキング 0x0800 等） |
| 中核フラグ合計 | 107 | 本人・関連と重なる分を含む（Xenia＝本人かつ配布型中核、残高1位アドレス 0x7a6f…0a25＝関連かつ中核） |

中核アドレスは「人物ウォレット」として扱わず、画面で「中核（仕組み系）」と表示します。イベントの実行者（actor）にも原則なりません（DEXルーターが Swap の宛先になるケースで本人が埋もれるのを防ぐため）。例外はバリデーター本人と残高1位アドレスです。

表示銘柄は Don't Panic 掲載の **17銘柄のみ**（42, USDT, FISH, CAT42, ZAP, FATHER, KET, BABY, QOM, MARVIN, O, PANIC/DONT, OSAK, FOXXEY, BFOXX, HAWK, CAW）。偽CAT42×1・偽ZAP×2などのコピーキャットは含みません。対象外銘柄の動きも保存はしますが `whitelisted=false` の旗を付け、画面では「対象外銘柄を含む」と表示します（表示ルールであり、索引の改変ではありません）。

### 分類ルール（collector.mjs）

- **送金／受取**：ERC-20 Transfer とネイティブ[42]の移動。**金額の下限は一切ありません**（小さな送金も全て記録 — ユーザーの standing rule）。両側が監視対象なら、バリデーター本人を主役にします
- **買い／売り**：V2 Swap を「本人の資産の変換」として記録（人物→人物の線にはしません）。[42]/USDT 側を基準通貨として、非基準通貨を受け取れば「買い」、払えば「売り」。USDT→[42]は[42]の買い、[42]→USDTは[42]の売り。価格はスワップ量そのものから計算します
- **LP追加／LP解除**：Mint／Burn イベント。実行者は Tx送信者とLPトークンの発行・焼却先から特定します
- **その他の操作**：上記に当てはまらない、監視アドレスからのコントラクト実行。ただし同一アドレス・宛先・メソッドの繰り返しは約360ブロック（約30分）に1回まで記録します（キーパー的な関連アドレス 0xbfc5…4f29 の同一コール連打でフィードが埋まるのを防ぐため。送金・売買・LPは一切抑制しません）
- Swap／LP を含む Tx の内部 Transfer は、その変換の一部なので二重に記録しません

## ローカルでの動かし方

```bash
node build-watchlist.mjs          # watchlist.json / registries.json を生成（初回のみ）
node collector.mjs --backfill 300 # 直近300ブロックを処理して feed.json を作る
node collector.mjs --once         # チェックポイントから先端まで1回処理
node collector.mjs                # 常駐モード（約10秒間隔、POLL_MS で変更可）
node server.mjs                   # http://localhost:8787/ でサイト表示
node test-decoder.mjs             # 既知の過去フロー2件（スワップ／送金）で復号を照合
```

ファイル構成：`collector.mjs`（収集・分類）／`build-watchlist.mjs`（監視リスト生成）／`watchlist.json`・`registries.json`（生成物）／`events.jsonl`（全イベント追記）／`feed.json`（最新500件）／`state.json`（チェックポイント）／`pairs-cache.json`（新規ペアの token0/token1 キャッシュ）／`index.html`（サイト本体、外部CDNなし）／`server.mjs`（ローカル確認用）／`test-decoder.mjs`（検証）

RPCの注意：42 Chain の RPC はブラウザ風 User-Agent を付けないと接続を切ることがあります（実測済み）。`collector.mjs` は最初から付けており、ホスト2系統（infinitepanda → mschihuahua）の切替＋リトライも入っています。ブロック間隔は実測で約5.4秒と安定しています。

## ホスティング案（維持費0円が前提）

### 第一候補：GitHub Actions ＋ GitHub Pages（同梱テンプレートあり）

公開リポジトリなら GitHub Actions は無料・無制限です。`.github/workflows/collect.yml`（同梱・運用中）が次を行います：

1. 5分間隔（Actions の cron 最短間隔。混雑時は遅延あり）に起動
2. `node collector.mjs --once` でチェックポイント以降のブロック（約55ブロック分）を処理
3. 更新された `feed.json`／`events.jsonl`／`state.json` をリポジトリにコミットして戻す
4. サイト配信は GitHub Pages（main ブランチ直下を有効化するだけ、無料）

遅延してもチェックポイント方式なので取りこぼしはなく、次回にまとめて追いつきます。鮮度はサイトのステータス行で常に確認できます。
注意：スケジュール実行はデフォルトブランチでのみ有効で、リポジトリが60日間無活動だと GitHub が自動で止める場合があります（このワークフローのデータコミット自体が活動になります）。監視リストの再生成は Actions 内では行いません（生成元データはローカルの調査フォルダにあるため、ローカルで生成してコミットします）。

### 第二候補：Cloudflare Workers Cron ＋ Pages

無料枠は Cron 1分間隔・リクエスト100,000回/日と余裕がありますが、Cron の CPU 時間制限が厳しく、数百ブロック分のレシート復号を1回の実行に詰める今の作りとは相性が要検証です（実行を小分けにする改修が前提）。Pages への配信自体は無料で問題ありません。

### 任意（有料）：小さな VPS

常駐モード（約10秒間隔ポーリング）をそのまま動かせて最もリアルタイムに近いですが、月額がかかるため **0円前提では採りません**。必要になった場合の選択肢としてだけ挙げておきます。

## Phase 1 の範囲と限界（正直な表記）

- EVM側のみです。**Cosmos側は Phase 2**（未実装）
- **推定リンクは含みません**（プール経由などの推定は Phase 3。本人→直接関連の確認済みデータのみ）
- X bot などの外部アラートは行いません（サイト内「注目」だけ）
- バリデーター集合は 2026-10-31 のスナップショットが元です。新規バリデーターの自動取り込みは今後の課題です
- 未知のペアで Swap が起きた場合、その場で token0/token1 を問い合わせてキャッシュします。取得できなかった Swap は記録されません（次回以降の課題）
- 価格はプールのスワップ量からの計算値です。流動性の薄いプールでは実勢とずれることがあります
- 公開済みです：リポジトリ https://github.com/QL1-Infinite42-Guppy-Histoire/42-validator-tracker ／ サイト https://ql1-infinite42-guppy-histoire.github.io/42-validator-tracker/ （GitHub Actions が5分間隔で収集し、GitHub Pages で配信）
