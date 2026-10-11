# 本番画面の見た目確認

2026-10-11 に現行の production build を Chromium の拡張ページとして撮影した。会話内では画面と撮影時の暗色 / 明色設定を切り替えられる。以前の Figma や手描き見本ではなく、本番 DOM / CSS のスクリーンショットを使う。ユーザーの最終確認・承認はまだ行われていない。

## 撮影と検証の根拠

- 対象ブランチの head：`ab4839daad2e3297c9c516f498da9b152b6d821b`。CI がチェックアウトした PR merge：`15fbb83c7b7e35d3e992a9ce154c670d761a3b04`。
- [Design review screenshots CI](https://github.com/shgnaka/vimdf/actions/runs/38111782415)：production build と 24 撮影ケースが成功し、暗色 / 明色各 35 枚、合計 70 枚を保存した。
- Artifact：`vimdf-design-review`、ID `11692141495`。ZIP SHA-256：`86b1413f6bbcdd31a81e15bc01d689e892c47ecdf270b26307c93266f8b3d994`。生 PNG と各ケースの `screens.json` に撮影条件・観測状態・CI commit と実際の systemColorScheme を記録する。CI artifact は 14 日で期限切れになるため、撮影手順から再生成する。
- [Node / build CI](https://github.com/shgnaka/vimdf/actions/runs/38111782450) と [Chromium / contracts CI](https://github.com/shgnaka/vimdf/actions/runs/38111782417) も成功した。回帰検査 467 ケースと撮影 24 ケースは別に数える。
- 一覧・通常状態・例外・テーマ・狭い幅を撮影後に確認し、狭い幅のヘルプと 17 px 表示は原寸でも確認した。会話内の表示用 WebP は lossless とし、PNG と RGB ピクセルが一致することを確認した。画像自体の修整は行っていない。

今回の再撮影は、許可対象名・停止表示・ヘルプ検索 0 件の説明を本番で修正した後のもの。Viewer / Options のデザインと CSS は変更していない。70 枚は確認用の証拠であり、ユーザー承認済みの画像基準や `toHaveScreenshot` の golden ではない。撮影成功だけで表示仕様をすべて満たしたとは扱わない。

## 撮影対象

| 画面 ID | 実画面で確認できる状態 |
| --- | --- |
| D01 / D01-keys | 通常一覧、両ボタン非表示 |
| D02 / D03 | 登録一覧、native picker の応答待ちの拡張画面 |
| D04 / D04-removed | 初回未登録、最後の登録解除後 |
| D05 / D06 / D07 / D08 | 読取許可、名前の絞り込み、空フォルダ、検索 0 件 |
| D09 / D10 | ディレクトリ読込中、PDF 読込中 |
| D11 / D11-save / D12 | picker 失敗、保存失敗、別タブによる登録更新 |
| D13 / D13-other / D14 | 既定・非既定・最後の登録の解除確認 |
| D15 / D16 | 一覧ヘルプ、ヘルプ検索 0 件 |
| D17 / D18 / D21 | DB open 失敗、ディレクトリ API なし、private 起動停止 |
| D20 / D20-confirm / D20-help | 320 × 640 px の長い同名登録・ID、解除確認、ヘルプ |
| D20-font17 / D20-wrap | 狭い幅で 17 px にした登録一覧、長い検索語と折返したステータス |
| D22 | 破棄された PDF 履歴から一覧へ戻った状態 |
| R01 / R02 | 既存 Viewer の PDF 表示、Viewer ヘルプ |
| R03 / R03-browser / R04 / R05 | Options 全体・File browser 節・保管庫作成、PDF パスワード入力 |

D19 の明色確認は全ケースの明色撮影に含める。Options と保管庫ダイアログは VimDF の Theme ではなく native のシステム配色に従う。以前の撮影ではシステム明色のまま VimDF の設定だけを変えていたため、R03 / R03-browser / R04 の「暗色設定時」も明色だった。現在はこれらの撮影時にシステム配色も切り替え、暗色と明色の実画面を使う。Options が明色固定という説明は採用しない。D21 は設定を読む前に停止するため、明色設定時の撮影も既定の暗色となる。PDF パスワード・マスターパスワードの入力欄は空で、ファイル名・登録名・ID は合成データを使う。

## 確認で見つかった表示上の不足と修正

初回撮影で見つかった以下の不足は、利用者の操作と表示結果を検査する 4 ケースを先に追加して再現し、本番実装で修正した。最新の 70 枚は修正後の画面であり、画像の側だけを変更したものではない。失敗から成功への記録は [テスト記録](local-browser-testing.md) に残す。

| 対象 | 初回に観測した内容 | 現在の結果 |
| --- | --- | --- |
| D05 | 許可の対象が University でも、画面の説明・現在位置に対象名が出ない | 許可の対象名を表示する。非既定フォルダの確認・取消・許可も検査済み |
| D17 / D21 | DB 初期化失敗・起動停止後も Loading saved folders… が残る。D17 では API 非対応時と同じ案内も出る | 停止後の読込中表示を消す。DB 復元と API 非対応の説明を分け、DB 失敗後も PDF 選択を使える |
| D16 | 検索語は表示されるが、0 件の説明がなく操作表が空になる | 検索 0 件の説明を status で表示し、検索解除で操作表へ戻れる |

配色の好み・余白・一覧の密度・アイコンの見た目はユーザー確認待ち。スクリーンショットだけでコントラストやスクリーンリーダーの適合性を保証したとは扱わない。キーボード・フォーカス・表示情報の機能検査は [テスト記録](local-browser-testing.md) に分けて残す。

## 境界と再撮影

本番ページ・IndexedDB・OPFS handle・列挙・PDF.js を使い、OS picker、権限応答、失敗、遅延など再現に必要な I/O 境界を制御している。OS 標準のフォルダ選択ウィンドウそのもの、実プロファイルの private 起動、iframe 起動、実 OS の権限保持はこの撮影で確認していない。実機確認の範囲は従来の [確認項目](local-browser-testing.md) を使う。

再撮影は `npm ci`、`npx playwright install --with-deps chromium`、`npm run build` の後に `npx playwright test --config=playwright.design-review.config.mjs` を実行する。CI では Design review screenshots の workflow_dispatch から実行できる。出力先は `test-results/design-review/`。通常の回帰テスト glob とは分け、撮影が基準画像を自動承認する仕組みは設けない。
