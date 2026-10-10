# ローカル PDF ブラウザの統合テスト契約と実機確認

2026-10-10 の [一覧 UI・キー・ヘルプ・CSS 改訂](local-browser-ui.md#受け入れ条件とテスト化する項目) に UX-01〜13 の追加受け入れ条件を定義した。追加テストと実装は未対応。以下の既存テスト成功は新しい r、一覧全状態の a、一覧ヘルプ、CSS 編集・反映、常設 UI の除去を検証した記録ではない。

## 状態と実行方法

[統合仕様](local-browser-integration.md) の 21 条件と [個別のフォルダ管理](local-folder-management.md) の FM-01〜08 を、モデル、統合契約、実ブラウザのテスト、実機確認へ分ける。専用画面はテストと同じ本番モデル・アダプター・Viewer runtime を使用する。`skip` / `todo` / `continue-on-error` による未実装の成功扱いは行わない。

| 層 | テスト数 | 現在の確認状態 |
| --- | --- | --- |
| モデル | 84 | 成功。既存 78 件と新規 FM 6 件。フェイクの handle / I/O でモデル契約を検証 |
| 既存パスワード / スクロール | 34 / 14 | 成功。既存機能の回帰確認 |
| Node の統合契約 | 50 | 成功。保存の commit / abort、競合、起動、PDF controller と配布 build を検証 |
| Chromium の拡張・DOM・native IDB | 45 | 全件成功。個別管理の新規 18 件、画面の受け入れ 9 件、既存 18 件を検証 |
| 代表環境での実 Vimium-C / OS picker | 8 手順 | 未実施。後述の MR-01〜08 を確認する。全 OS・全ブラウザ版の組み合わせは要求しない |

確認日：2026-10-10。実装コミット `a11383472beb2fbcea2040dd0a006e151afbe459` に対する [統合契約・ブラウザ CI](https://github.com/shgnaka/vimdf/actions/runs/38011984668) と [モデル・パスワード・スクロール・build CI](https://github.com/shgnaka/vimdf/actions/runs/38011984609) は成功。ログの checkout と合計を確認し、Node 182 件、Chromium 45 件、型検査・production build の成功を記録する。テストの削除や期待失敗への変更は行っていない。自動試験と実 Vimium-C / OS picker の実機確認を区別する。

### 受け入れテストが検出した画面の不足と修正

`local-browser-acceptance.spec.mjs` に追加した 9 件は、既存モデル・controller の戻り値だけでなく本番 DOM と実際の利用者操作を検査する。[追加後の CI 記録](https://github.com/shgnaka/vimdf/actions/runs/37927907805)（`31211cc2868ff2f94de75f9cb974a9d72b5f5c43`）は 19 成功・8 失敗。Node 176 件と build は成功。追加した 8 件の失敗は下表の未実装によるものであり、既存 18 件と file fallback の正の対照 1 件は成功。未実装を `skip` / `todo` / `test.fail` や固定の失敗で隠さず、通常の失敗として返す。

追加時の失敗理由は、2 種類の一覧で選択行の可視率が 0、履歴の再選択案内が存在しない、通常 Viewer の導線が 0 件、空フォルダと検索結果なしの文が同一、登録一覧の検索結果なしでも確定案内が残る、非対応でも登録ボタンが見える、非対応画面の Enter で `showDirectoryPicker is not a function` が表示される、の 8 件だった。実装側で選択行のスクロール追従、履歴の再選択案内、共有 launcher を使う Viewer の起動ボタン、空一覧と検索結果なしの区別を追加した。空の Viewer では通知を文書開封まで保留し、起動ボタンを覆わない。API 不在時はフォルダの操作・キー案内を隠し、DB の store 初期化後に接続を閉じ、保存ハンドルの復元とフォルダ読取を始めず、通常ファイル選択で PDF を開ける。

| 仕様の不足していた検査 | 追加テスト |
| --- | --- |
| 選択行を表示範囲へ追従 | PDF 一覧と登録一覧の長いリスト。G / gg / j / k / 矢印で選択し、scroll ancestor の clipping を含む可視領域に行の 99% 以上が収まる。選択だけでは保存値が変わらない |
| 破棄された PDF 履歴の再選択案内 | 本番 Viewer で A → B と交換後、A の token を持つ履歴境界へ進む。再選択案内が見え、一覧・filter・選択を保持し、identity を fetch しない |
| 通常 Viewer 空画面の起動導線 | 利用者が導線を押すと通常の専用タブを 1 件だけ作り、旧 Viewer を置き換えず picker を自動表示しない |
| 空フォルダと検索結果なしを区別 | 空フォルダの絞り込み前後で案内を変え、解除後に元へ戻す。登録一覧の検索結果なしでは存在しない行の確定を案内しない |
| API 非対応時のフォルダ操作 | フォルダのボタン・検索欄・一覧・キー案内を隠す。キーでも登録やエラーを生まない。正の対照として通常ファイル選択の bytes で PDF を開ける |

履歴テストは古い native history state を準備する境界注入だけを行い、controller・popstate・案内文を代替実装しない。長い一覧は native OPFS にデータを作り、スクロール API や CSS を指定せず結果を検査する。表示文は意味を検査し、全文の固定や Figma の配置・色には依存しない。

[対応方針](local-browser-compatibility.md) に従い、既存の `environment.json` の report 添付は再現の補助として維持する。全環境の対応認定や確認表の管理を目的としない。新しい [FM 要件の自動検査対応表](local-folder-management.md#受け入れ条件と既存の証拠) はモデル 6 件とブラウザ 18 件を追加した内容を示す。

### 個別のフォルダ管理を検査する追加テスト

2026-10-10 に `tests/local-browser-folder-management.test.mjs` と `tests/browser/local-folder-management.spec.mjs` を追加した。[初回の CI](https://github.com/shgnaka/vimdf/actions/runs/37952708950)（`07c8475fe305c624507692cf0f1717ad644a671c`）では全 45 件が 33 成功・12 失敗となり、既存 8 件に加えて新規 18 件中の 4 件が不足を検出した。下表の実装修正後は同じテストが全件成功し、既存の成功ケースも保持した。

| 検出した条件 | 実装修正 |
| --- | --- |
| FM-04 / FM-08：`Esc` で解除取消後の一覧フォーカス | native dialog の close を処理し、取消対象を消して一覧へ戻す |
| FM-04 / FM-05：プライマリー解除前の次の既定の説明 | 絞り込み前の全登録から、登録順で次に既定になる名前を確認画面へ表示 |
| FM-04 / FM-05：最後の登録を解除した後の説明 | 登録が 0 件になることと、改めて追加できることを確認前に説明 |
| FM-07：native commit 失敗の通知 | save の AbortError を alert に表示。picker の取消は Registry、PDF の取消は PDF 開封処理で扱い、登録保存の失敗と混同しない |

個別解除の確認・取消とフォーカス、同名登録の識別、次の既定と最後の登録の説明、native transaction の保留と put 成功後の abort、別タブの変更、実ファイル bytes と全保存先の保持、読み込み済み PDF の保持と再登録後の新 identity を検査する。実 Vimium-C を導入していない構成の設定ボタン・フォルダ画面・PDF 検索も実行する。この結果を通常の Vimium 自体の起動連携や、特定の Vimium-C 版の動作確認には一般化しない。

fixture の追加は、別々の親にある同名の native フォルダ、単独の登録、選択対象を変えられる picker 境界だけ。アプリの解除処理・公開状態・確認文・フォーカスをテスト側で修正しない。API 不在、保存 DB の不正、単なる権限失効も別のシナリオとして扱う。失敗は通常の assertion として返し、`skip` / `todo` / `test.fail` に変更しない。

初回結果の確認後、保持の検査を解除対象と残る登録の両方の PDF 保存データへ拡張し、絞り込み後の index 0 から元の 2 件目を解除する。取消・最後の解除にも保存データ保持を検査する。native abort の検査は先に rollback・元の一覧への復帰・新たな解除の成功を確認し、その後に完了時点のエラー通知を検査する。通知の欠落で他の検査が到達不能になることを避ける。

```sh
npm ci
npm run test:local-browser
npm run test:password
npm run test:scroll
npm run test:local-integration
npx playwright install chromium
npm run test:local-browser:browser
```

統合契約とブラウザのコマンドは、それぞれ最初に production build を行う。Node は build artifact、Session の追加操作、IDB アダプター、PDF controller、起動リスナーを検証する。Node 内の `fake-indexeddb` に入れる handle は clone 可能な opaque 値であり、native ハンドルの保存・復元を証明しない。

ブラウザテストは Playwright の Chromium を persistent context で起動し、実 `dist/` とテスト専用の送信拡張を読み込む。製品の DOM、Viewer、IndexedDB、拡張メッセージを利用し、picker / permission の境界だけを制御する。OPFS の native `FileSystemDirectoryHandle` を保存するため、native clone を確認できる。ただし OS の実ディレクトリの picker と権限保持は MR-01 が必要。合成した IME イベントと本物の日本語 IME、送信拡張と本物の Vomnibar も区別する。

`.github/workflows/test.yml` はモデル・パスワード・スクロールの 132 件と build、`.github/workflows/local-integration.yml` は統合契約と Chromium の両 job を push / PR で実行する。両 suite とも失敗をそのまま返す。ブラウザ失敗時の trace と screenshot は fixture が保存する。ローカル環境では Chromium の取得が失敗したため、実ブラウザの結果は GitHub Actions の実行を根拠とする。

## 本番実装の接続契約

自動テストが import する API を固定する。以下は本番ページからも使用する実装境界。テストだけの代替製品は用いない。

| 接点 | API と意味 |
| --- | --- |
| `LocalBrowserSession` | `select(index)`、`openRoots()`、`removeRoot(id)`、`registeredFolders`。行クリックは filter 後の index を選ぶだけ。不正 index と busy 中の選択は無視。子フォルダから登録一覧へ直接移り、解除成功後だけ取消 snapshot を無効化。確認文の次の既定は filter 前の全登録から求める |
| `src/local-browser/indexeddb.ts` | `createFolderStorage(options):Promise<Storage>`。初期化は DB open、状態復元は `load()`。`load` / `save` / `pick` / `newId` は既存 `FolderStorage` と同じ。`checkRevision():Promise<boolean>` は変更の有無を返し、期待 revision を更新しない。`close()` は接続・通知 listener を解放 |
| storage options | `indexedDB`、`BroadcastChannel`、`pick`、`newId`、任意の `onChanged` / `onBlocked` / `onVersionChange`。DB 名と store 名は統合仕様の固定値。通知 payload は `{revision}` だけ。bootstrap 中に picker を呼ばない |
| `src/local-browser/pdf-controller.ts` | `createLocalPdfController(options)`。`openPdf(File,identity)`、`back()`、`forward(token):Promise<boolean>`、`cancel()`、冪等な `dispose()`。公開状態は `mode` と `documentToken`。mode は `files` / `loading-pdf` / `pdf` |
| PDF controller options | `createRuntime`、同一 document の `history`、`onMode`。共有 runtime は `load({data,identity},{signal})`、`snapshot()`、`save(snapshot)`、`suspend()`、`resume()`、`resetTransient()`、`dispose()` を提供。snapshot は `{identity,page,scroll}`。`scroll` は container の `scrollTop`。旧状態を await 前に capture し、load で使う store の交換や generation は共有 Viewer 側でも保証 |
| `src/background/local-browser-launcher.ts` | `installLocalBrowserLauncher(chrome):dispose`。実 background が呼び、独立した external listener と action listener を登録。受信時に起動先を capture し、local 設定と exact command を検証。literal `true` で非同期 channel を保持し、作成後に boolean の返信を 1 回だけ返す |

同じ primary の明示確定にも `save()` による競合検出が必要。重複フォルダの追加は既存契約どおり保存を省略する。保存成功を返す時点、失敗後の State、再読込前の禁止事項をテストで区別する。

### DOM の安定した識別子

Figma でレイアウトや色・余白を変更してもテストが壊れないよう、ピクセル位置や CSS class を検査しない。次の識別子と accessible な選択状態を接続契約にする。

| 要素 | 識別子・状態 |
| --- | --- |
| 画面ルート | `data-testid="local-browser"`、`data-mode`、`data-view`、`data-busy="true\|false"` |
| 一覧・行 | `role="listbox"` / `role="option"`、`aria-selected`。名前は文字として表示し、primary と選択を分離 |
| 名前検索 / 相対位置 / 更新通知 | `data-testid="browser-filter"` / `browser-location` / `registry-stale` |
| 操作ボタン | `data-action="add"` / `roots` / `pick-file` / `reload-registry`。関連処理を開始できないときは disabled |
| エラー | `role="alert"`。DB 失敗・API 非対応・権限確認を未登録成功と混同しない |
| PDF 表示 | 既存の `viewer`、`viewerContainer`、`searchInput`、`searchStatus`、`statusCenter` とパスワード dialog を共用 |

フォルダ移動後の次の検索は画面の `data-busy="false"` を待って開始する。busy 中の入力を無視する契約を、テストのキー連打で破らない。マーク復帰は一度 1 ページ目へ移動したことを確認してから、既存のページ表示 `statusLeft` が 2 ページ目に戻ることを検証する。成功時に通知欄 `statusCenter` へページ番号が出るとは仮定しない。

Node の controller テストは runtime の呼び出しを検証する。実際の PDF.js、MarksStore、SearchController、遅い outline / highlight などの安全性は、この controller のフェイクだけでは保証しない。ブラウザテストと MR-04 / 05 / 08 も完了させる。

## 受け入れ条件との対応

各自動テストの名前に条件 ID を入れる。1 条件に複数のシナリオを割り当て、一覧の 21 行をそのまま 21 件のテストとは数えない。`EXT-03` は実 Vomnibar の手動確認が必須であり、送信拡張の成功で代替しない。

| 条件 | 自動テスト | 追加の実機確認 |
| --- | --- | --- |
| UI-01 | `local-integration-build.test.mjs`：配布 HTML / JS / CSS、公開範囲、既存 MIME | MR-01：未パッケージ拡張を実際に導入 |
| UI-02 | build / Session / browser / acceptance：初回・最後の解除・空一覧の案内・API 非対応時の操作停止と file fallback・DB 失敗・通常 Viewer の導線 | MR-01：非対応構成の案内 |
| UI-03 | Session / browser：busy 中の選択、検索入力・リピート・合成 IME | MR-02：代表環境の日本語 IME |
| UI-04 | Session / browser / acceptance：クリック、filtered index、解除 snapshot、HTML 名、native button の Enter、長い一覧の選択行追従 | MR-02：focus と画面の見分け |
| UI-05 | browser：picker / 再許可の activation、取消・失敗後の再試行 | MR-01 / 07：OS dialog と実権限 |
| UI-06 | controller / Session / browser / acceptance：H、戻り先、filter・選択、履歴 token、破棄文書の再選択案内、再読込 | MR-02：ブラウザの戻る・進む |
| DB-01 | storage / browser：envelope、ID / 順序 / primary、native handle の clone・再読込 | MR-01：ブラウザ・拡張の再起動 |
| DB-02 | storage：put 成功後の abort、commit 後の別 transaction による読取 | MR-07：実保存障害からの回復 |
| DB-03 | storage：同一 revision の競合・敗者の再保存禁止・明示 load 後の再試行 | MR-07：複数通常タブ |
| DB-04 | Session / Registry：同じ primary の古い no-op 判定で競合を見逃さない | MR-07：実タブで同じ登録を再確定 |
| DB-05 | storage / browser：revision 通知、foreground check、勝手に切り替えない、reload | MR-07：背景・前面の切替 |
| DB-06 | storage / browser：不正 envelope・将来 schema・quota・open error・versionchange・blocked・revision 上限 | MR-07 / 08：native blocked / quota |
| PDF-01 | controller / browser：File bytes、read error、synthetic identity の fetch がない | MR-04：通常 URL / MIME の回帰 |
| PDF-02 | controller / browser：root identity の分離、マークの保存と復帰 | MR-04 / 05：ページ・ハイライト・パスワードの全保存先 |
| PDF-03 | controller / browser：パスワード取消・再試行、File / runtime の遅い取消 | MR-05：自動候補と保存 |
| PDF-04 | controller / browser：旧 snapshot の capture / flush、遅い結果、二重 open | MR-08：実 outline / highlight / restore の遅延 |
| PDF-05 | controller / browser：停止・再開・一時モード解除・dispose・マーク | MR-04 / 08：印刷・保存・通常起動・資源解放 |
| EXT-01 | launcher / build / browser：設定・native sender・exact payload・action・実 external listener | MR-03：接続設定 UI とコピー例 |
| EXT-02 | launcher / browser：boolean 返信、channel、元タブ・focus 変更・closed window、実 runtime | MR-03：Vimium-C 側の成功・失敗 |
| EXT-03 | 自動で代替しない | MR-03：実 Vomnibar で bare keyword |
| EXT-04 | launcher / browser：incognito guard、local 設定の再読取、page reload | MR-03 / 06：実 worker 再起動と private window |

テストファイルは [Node](../tests/local-integration-session.test.mjs)、[storage](../tests/local-integration-storage.test.mjs)、[controller](../tests/local-integration-viewer.test.mjs)、[launcher](../tests/local-integration-launcher.test.mjs)、[build](../tests/local-integration-build.test.mjs)、[browser](../tests/browser/local-browser.spec.mjs)。補助コードは I/O 境界とデータ生成だけを担い、期待する製品動作を代わりに実装しない。

## 実機確認の手順と記録

代表環境で実行した確認に、使用 OS、ブラウザと Vimium-C の version・配布元、拡張 ID、VimDF commit、実行日時、期待値と実際の結果を残す。全 OS・全 Chromium 系製品・全過去版の確認表を維持しない。現時点は全項目が未確認。実 PDF はテスト用データを使い、成功・失敗を項目ごとに残す。Vimium-C の必要機能の下限と実際の確認版を混同しない。

| ID | 操作 | 合格条件 |
| --- | --- | --- |
| MR-01 | 代表環境で `dist/` を未パッケージで導入。明示操作で OS の 2 フォルダを登録し、primary を変更。拡張再読込・ブラウザ再起動。失効後は再許可 | 起動で dialog が出ず、ID / 順序 / primary を復元。失効で登録を削除せず、許可後に開く。Brave 等の API 差は該当手順を追加確認 |
| MR-02 | `/` で日本語 IME、`j` / `k` の文字入力、button の Enter、マウス選択、子フォルダから登録一覧、個別解除の確認・取消、PDF の `H` / ブラウザ戻る・進む | 二重操作・focus 奪取・IME 確定による開封がない。選択と primary が区別でき、一覧位置と検索を復元。解除対象と次の既定が分かり、取消は副作用なし |
| MR-03 | 設定 UI に実 Vimium-C ID を登録。コピー例を Vimium-C に追加。Vomnibar で `vimdf` → Enter。接続無効・未許可・worker 再起動も確認 | bare keyword が 1 回だけ専用タブを開く。失敗は boolean false。omnibox / 他の検索に影響せず、勝手な picker / 登録変更がない |
| MR-04 | 通常・暗号化・同名別 root・特殊文字 PDF を開き、本文検索・ページ位置・マーク・ハイライト・印刷・保存。従来の URL / MIME 起動も確認 | 同じ identity に復元し、別 root と混線しない。保存名が正しく、出力が開ける。synthetic identity を取得しない |
| MR-05 | wrong / correct な登録済み候補と手入力を試す。パスワード dialog で Enter・取消・保存。再開封 | 既存の候補と登録が動き、busy 処理が dialog のキーを奪わない。取消後の遅い結果で文書や保存先を変えない |
| MR-06 | 実 private window と normal window を用意。識別できる private 起点、元タブ不明で private が最前面、専用ページの直接起動を確認 | private 対象を拒否し、DB / 保存 handle に触れない。既存一般 PDF の private 方針を変更しない。元タブ不明の起点を完全識別できるとは主張しない |
| MR-07 | 2 タブで primary・追加・解除を変更し、片方を背景にする。実ファイルの削除・権限取消・保存失敗から再試行 | 古い全 State が上書きせず、明示 reload が必要。失敗を成功表示せず、旧登録を維持。実ファイルを削除しない |
| MR-08 | 開封・outline / highlight / restore・保存を遅延させて文書交換 / 取消。多数回の一覧往復と閉鎖。複数接続を保った schema upgrade / quota 障害 | 古い非同期処理が新文書を変更せず、別 identity へ保存しない。listener / timer / PDFDocument が増え続けず、blocked / versionchange を案内 |

Playwright の構成は [公式の拡張テスト手順](https://playwright.dev/docs/chrome-extensions) に基づく。`fake-indexeddb` の範囲は [公式 README](https://github.com/dumbmatter/fakeIndexedDB)、native handle の clone は [File System Standard](https://fs.spec.whatwg.org/#serialization) を参照。これらの資料は本機能のテスト成功を示すものではない。
