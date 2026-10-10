# PDF パスワード保管庫の追加テスト

更新日：2026-10-10。[保管庫の要件と仕様](pdf-password-protection.md) の SEC-01〜24 に対するテストを追加した。本番の暗号化 store、共通 Options と PDF ダイアログを接続した。暗号化の安全性全体を保証する監査とは区別し、ここでは要件に対する検査の範囲と実行結果を記録する。テスト内に保管庫の代替実装を作らず、本番モジュール、本番 Options / Viewer / PDF.js を呼ぶ。未実装の API・DOM は通常の失敗で検出し、skip / todo / 期待失敗にしない。

## ファイルと実行

| ファイル | ケース数 | 内容 |
| --- | --- | --- |
| `tests/password-vault.test.mjs` | 95 | 暗号・保存・解錠・バックアップ・復元・再認証・移行・取消・競合。うち 2 件は独立した Web Crypto oracle の検査 |
| `tests/password-vault-pdfjs.test.mjs` | 6 | 実 RC4-128 / AES-256 PDF の復号、ロック中の手入力、非暗号化 PDF、保存失敗 |
| `tests/browser/password-vault.spec.mjs` | 25 | 本番 Options と一覧・Viewer、実ダウンロード・復元・移行、DOM・入力・フォーカス、解錠取消後の PDF 手入力、native IDB / OPFS の保持 |

`tests/helpers/password-vault-fixtures.mjs` は storage / 排他制御 / 時計 / Web Crypto 境界の観測だけを提供する。暗号化 fixture と復号 oracle は Web Crypto を直接呼び、本番の暗号ヘルパーを使わない。fixture のパスワードや PDF は合成データで、利用者の秘密を使わない。

Node.js 24 以上と既存依存関係を使う。`npm run test:password` の既存 glob は Node 101 ケースと旧 34 ケースを自動収集する。`npm run test:local-browser:browser` の既存 glob は Chromium 25 ケースを追加収集する。CI の失敗条件は変更しない。

```sh
node --test --test-reporter=tap tests/password-vault*.test.mjs
npm run test:password
npm run build
npx playwright test --config=playwright.local.config.mjs password-vault.spec.mjs
```

Node の契約ケースは 10 秒、実 PDF.js は 10〜15 秒、Chromium は既存の 20 秒・操作待ち 5 秒を使う。自動ロック時間をテストで製品の固定値にせず、Node のテスト用時計と 1,000 ms の注入値で境界を検査する。解錠共有の実装方式は固定しないが、マスター変更・復元・初期化で旧セッションが無効になることを要求する。

## 暗号化形式と独立した復号検証

可搬性のため、v2 の暗号化 JSON は次の既知フィールドだけを持つ。追加の未知フィールド、型の不一致、欠落、不正な Base64・長さを拒否する。`ciphertext` は Web Crypto が返す暗号文と 128-bit tag の結合。Base64 は標準アルファベットと必要な padding を使う。

```json
{
  "format": "vimdf-password-vault",
  "version": 2,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "..." },
  "cipher": { "name": "AES-GCM", "length": 256, "tagLength": 128, "iv": "..." },
  "ciphertext": "..."
}
```

鍵はマスターの UTF-8 バイト列から PBKDF2-HMAC-SHA-256 で AES-256-GCM 用に導出する。空白や Unicode を加工しない。salt は少なくとも 16 bytes、IV は書込みごとの 12 bytes。例の反復回数は独立 fixture の値で、製品の最終値を実測したものではない。

AAD は次の配列を `JSON.stringify` した文字列の UTF-8 バイト列とする。JSON オブジェクトのプロパティ順を変更しても、この順序で取り出して同じ AAD を生成する。

```js
[format, version, kdf.name, kdf.hash, kdf.iterations, kdf.salt,
 cipher.name, cipher.length, cipher.tagLength, cipher.iv]
```

復号される論理 payload は既存の `{version:1,autoFill,records,remembered}`。外側の暗号化形式 v2 と区別する。保存済み出力を独立 oracle で復号し、全内容を比較する。マスターから独立に導出した鍵の Base64・hex・数値配列表現も永続データと書込み履歴にないことを検査する。単なる Base64 化や同じ場所への鍵保存では成功しない。

## 本番 API への接続契約

`src/common/password-store.ts` に `EncryptedPasswordStore` と `PASSWORD_VAULT_POLICY` を追加し、`createPasswordStore` を暗号化実装へ接続する。旧 `LocalPasswordStore` の 10 件は v1 の回帰検査として残すが、旧クラスの成功を新方式の検証として数えない。テストを通すため本番が v1 保存へ戻ることを許可しない。

コンストラクターは `{storage,incognito,withLock,crypto,now,idleTimeoutMs,signal?}` を受ける。storage は既存の get / set / setAccessLevel と remove、withLock は画面間の排他操作、crypto は実 Web Crypto、now は時刻関数。製品からは通常の実装を注入し、テストでは I/O 障害・時刻だけを制御する。

| API | 意味 |
| --- | --- |
| `status()` | `{state}`。uninitialized / legacy / migration-pending / locked / unlocked / incognito。秘密を含めない |
| `create(master, confirmation)` / `unlock(master)` / `lock()` | 明示的な作成・解錠・失効 |
| `vault()` / `read(key)` | 解錠中の論理 payload / 既存候補 API。ロック中の vault は拒否、read は空候補 |
| `register` / `update` / `remove` / `move` / `setAutoFill` / `save` / `remember` / `clear` | 既存の登録操作を暗号化保存へ接続。clear は登録だけを消し、マスターは保持 |
| `noteActivity()` / `checkIdle()` | 製品側の活動通知・タイマーから呼ぶ期限管理。テスト時計で検査 |
| `exportBackup({signal?}?)` | `{filename,mimeType,text}`。保存済み暗号化 JSON。秘密を復号しない |
| `authorizePlaintext(master)` | 現在の保存世代を再認証する不透明な 1 回用許可。通常の解錠状態を変更しない |
| `exportPlaintext(token,{confirmed,signal?})` | 明示確認された同じ世代だけを汎用 JSON へ出力。取消・失敗・期限切れでも許可を再利用しない |
| `prepareRestore(text,backupMaster)` | `{token,preview:{recordCount,replacesExisting}}`。検証後も保存しない |
| `restore(token,{confirmed})` / `discardPrepared(token)` | 世代確認後の復元 / 準備結果の取消。成功後ロックし、失敗時は旧保管庫を保持 |
| `changeMasterPassword(old,new,confirmation)` / `migrate(master,confirmation)` / `reset({confirmed})` | マスター変更 / v1 移行 / 保管庫だけの初期化 |

政策値は `idleTimeoutMs,minMasterLength,maxImportBytes,maxPlaintextBytes,minKdfIterations,maxKdfIterations`。正の安全な整数、KDF は 600,000 回以上の下限と有限の上限を要求する。初版の政策値は 15 分、12 文字、入力 2 MiB・復号内容 1 MiB、KDF 600,000〜2,000,000 回。変更してもテストが固定候補値を強制しない。

公開メソッドの非同期結果はロック・取消・世代変更の影響を受ける。準備結果は生成した実行コンテキストと検証済み世代に結び付け、別コンテキストでの流用・再実行を拒否する。テストは保管庫の代替クラスを提供しないため、本番 API の接続・内容・失敗処理を直接検査する。

## 本番画面への接続契約

Options の `#passwordSettings` に `data-vault-state`、秘密を含まない状態・エラーに `#passwordVaultStatus` を付ける。既存 `.password-form` / `.password-record` と登録編集を維持し、ロック・移行待ちでは秘密の入力値を DOM から除く。

操作 ID は `passwordCreateVault,passwordUnlockVault,passwordLockVault,passwordBackup,passwordRestore,passwordExportPlaintext,passwordChangeMaster,passwordResetVault,passwordMigrate`。インコグニートでは存在する操作を無効にし、通常の保管庫を読まない。

dialog の accessible name は `Create password vault` / `Unlock password vault` / `Export plaintext passwords` / `Restore password vault` / `Change master password` / `Reset password vault` / `Migrate password vault`。通常のラベルは `Master password` / `Confirm master password`、変更は `Current master password` / `New master password` / `Confirm new master password`、復元は `Backup master password`。表示切替は `Show master password`。復元 dialog のファイル入力は `passwordRestoreFile`、検証と確定を分ける。

PDF の手入力 dialog に `Unlock vault` を用意し、解錠成功後は実際の登録済み候補で読込みを再開できる。マスター入力中の r / a / ? / j / gg を文字として扱い、一覧の移動・picker・help へ渡さない。ダウンロードは本番の出力処理を使い、実ファイル内容を検査する。Blob / URL は後片付けし、出力失敗後の再試行は入力を空にして再認証する。

## 要件との対応

| 条件 | Node / 実 PDF.js | Chromium |
| --- | --- | --- |
| SEC-01 | 本番 factory、永続データ・書込み履歴・鍵、独立復号 | 作成必須、登録後の実 storage |
| SEC-02 | 空白・Unicode・改行・NFC 非変換、JSON の危険そうな文字列も保持 | paste イベント非禁止、文字入力・伏字 |
| SEC-03 | 正誤マスター、破損・改ざん、上書き禁止 | 誤解錠と再試行・フォーカス |
| SEC-04 | IV 更新、12 種類のヘッダー・暗号文・tag 改変 | 独立検証した実 storage を使う |
| SEC-05 | KDF/形式/型/未知フィールド/サイズ/復号 payload、負荷前拒否 | 復元時の検証を本番へ接続 |
| SEC-06 | 再起動・手動・期限・活動・遅い解錠 | 再読込、DOM の除去、開いた PDF の維持 |
| SEC-07 | 暗号化後の個別管理・候補・成功後保存、実 2 種類の PDF | 通常操作の再入力なし、解錠後の実 PDF 自動入力 |
| SEC-08 | ロック中の実 PDF 手入力、非暗号化 PDF の保管庫非アクセス | 解錠の選択肢、保存なし・非暗号化 PDF |
| SEC-09 | ロック後の秘密アクセス、非公開エラー | IME・Enter/Esc・呼出元フォーカス、マスター入力と一覧キー。既存 UX-09/12 の所有・Options CSS 非適用も併用 |
| SEC-10 | ロック前後の同一暗号文、復号なし・世代スナップショット | 実ファイルの同一暗号文 |
| SEC-11 | 未作成・旧平文・壊れた形式・移行未完了 | 作成前・移行未完了の操作禁止 |
| SEC-12 | backup 読込み失敗・abort、秘密なしの filename | ダウンロード内容・URL 解放、read 障害で出力なし |
| SEC-13 | 新規復元の全内容、成功後ロック | 確定前の preview、実保存・ロック |
| SEC-14 | 正誤値・壊れた内容・取消・確認なし・quota・競合・replay | 誤入力・置換取消・quota |
| SEC-15 | 異なるマスター、旧 backup、root ID は文字列のまま | フォルダ registry と権限の維持 |
| SEC-16 | 解錠状態だけでは出力不可、毎回の再認証 | 初期入力空、毎回の入力、取消時 Blob なし |
| SEC-17 | 1 回・同一世代・コンテキスト、6 種類の失効、期限・遅い結果 | 毎回の出力 dialog。競合は Node の実 store で検査 |
| SEC-18 | 全登録・無効な登録・順序・文字列保持、除外データ | ダウンロードした JSON を完全比較 |
| SEC-19 | locked から出力しても通常解錠しない、abort・再利用禁止 | 取消・誤入力・URL 解放・出力失敗と再入力 |
| SEC-20 | 新 salt / IV、旧値失効、失敗、旧 backup | 2 画面の失効と旧 backup の案内 |
| SEC-21 | 書込み・readback・削除の順、各失敗・残存・再起動再試行・破損 | 明示移行、削除失敗の表示と操作禁止 |
| SEC-22 | 同時追加、quota、取消した待機書込み、実 PDF の保存失敗 | 実 storage 境界の失敗 |
| SEC-23 | マスター不要の reset、取消・失敗、登録 clear との区別 | 実 IDB / OPFS のフォルダ・PDF bytes、CSS・閲覧データ保持 |
| SEC-24 | 通常保管庫への全操作を無効・I/O なし | incognito API の制御境界、表示・無効・通常 vault 非読取り |

実 incognito プロファイル、パスワードマネージャーからの native clipboard 貼り付け、ダウンロードの native UI・ブラウザ再起動は代表実機確認も必要。自動化は clipboard の paste イベントと文字列挿入、incognito API 境界を制御した検査であり、実機確認済みとはしない。

## 検証記録

実装の初回コミット `ebe955d0f6b2140799ebe032eca0ae075e53c43f` で、[Node CI](https://github.com/shgnaka/vimdf/actions/runs/38056291118) と [統合契約 CI](https://github.com/shgnaka/vimdf/actions/runs/38056291149) が成功。パスワード 135（新規 101・既存 34）、フォルダモデル 111（新規 27・既存 84）、スクロール 14、統合契約 50、型検査・build を確認した。Chromium 111 ケースの最終結果は後続の記録に追記する。

以前のテスト追加時点 `3eae5f26d0fa6e948bdbef338fa7ef5c2fbe4c69` は新規 126 が 4 成功・122 失敗で、暗号化 store と画面不足を通常の失敗として検出していた。この実装でテストを skip / todo / 期待失敗へ変更していない。独立 oracle 2 件、実非暗号化 PDF 2 件だけの成功を暗号化の実装成功として数えない。

ローカルの Chromium ダウンロードは失敗したため、構文・収集・Node・build の確認と CI の実画面試験を区別する。CI は本番 DOM / Chrome storage / native IDB / OPFS / PDF.js を使用し、picker・incognito・I/O 障害等の境界だけを制御する。native clipboard、実 incognito プロファイル、OS picker 等は上記の実機確認範囲。
