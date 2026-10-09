# ローカル PDF ブラウザの対応環境管理案

これは管理方法の提案。最低対応版・対応を保証する OS / ブラウザ / Vimium-C の範囲はまだ確定していない。自動テストの成功を、別 OS、製品 Chrome / Brave、実 Vimium-C の確認結果として扱わない。

## 機能と確認環境を分ける

| 機能 | 必要な確認 | 現在の証拠 |
| --- | --- | --- |
| 通常の PDF 閲覧 | URL / MIME / ファイル選択、共有 Viewer | Chromium CI の通常 URL・File bytes 試験。MIME・印刷・保存は MR-04 |
| 登録フォルダの移動・保存 | 拡張ページの File System Access API、native handle の IDB 保存、OS picker、許可保持 | Chromium CI は OPFS handle と制御した picker / permission 境界。実 OS は MR-01 / 07 |
| Vimium-C 起動 | 対象版の設定例、実 Vomnibar、ID 許可と返信 | Chromium CI の送信元はテスト拡張。実 Vimium-C は MR-03 |
| API 非対応時のファイル選択 | フォルダ操作を表示・実行せず、File bytes で PDF を開ける | API を除いた Chromium の受け入れテスト |

機能ごとに「自動試験済み」「実機確認済み」「未確認」「非対応」を記録する。「最新で動いた」を過去の全バージョンに一般化しない。フォルダ機能が使えなくても通常 PDF 閲覧を止める理由にはしない。

## 記録と更新

Playwright は package-lock と固定された依存版で再現する。各ブラウザテストは `environment.json` を report に添付し、実 browser product / userAgent / revision、OS kernel / architecture、Node、Playwright、拡張 ID、試験 commit / workflow run を記録する。現在の workflow は report と trace を 14 日保存する。リリース時の根拠は期限付き artifact の URL だけにせず、該当 commit と確認結果をこの文書・リリース記録に残す。

実機の候補はまず Windows 11 の Chrome / Brave と実 Vimium-C。次の表は空欄を推測で埋めず、MR-01〜08 の結果を記録してから更新する。

| 確認日 | VimDF commit | OS / 版 | ブラウザ / 完全な版 | Vimium-C 版・配布元 | 機能 / MR ID | 結果・再現手順 | 証拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 未実施 | — | Windows 11 | Chrome：未記録 | 未記録 | MR-01〜08 | 未確認 | — |
| 未実施 | — | Windows 11 | Brave：未記録 | 未記録 | MR-01〜08 | 未確認 | — |

最低対応版を決めたら、その版と更新版の確認結果を別行で保つ。ブラウザ / Vimium-C / Playwright を更新したとき、新しい Web API を必須にしたとき、関連する不具合を修正したときに該当機能を再確認する。CI の bundled Chromium は継続回帰確認、製品ブラウザの実機試験は対応を保証する範囲の根拠とする。

## 最低 Chrome 版を確定する条件

`minimum_chrome_version` は拡張全体のインストール・更新を制限する。任意のフォルダ機能や MIME 経路のためだけに引き上げず、拡張全体で必須となる API の最低版と試験結果から決める。フォルダ機能は実 API の有無・利用可否でも判定する。現段階では manifest に最低版を追加しない。

公式根拠： [Chrome の minimum_chrome_version](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version)、[Playwright の拡張テスト](https://playwright.dev/docs/chrome-extensions)。Playwright の公式手順は bundled Chromium の persistent context を用い、製品 Chrome / Edge と同一の拡張ロード方法を保証しない。

## 登録だけの初期化は別の未決定事項

登録 DB にあるルート ID・directory handle・登録順・primary を空にして再登録できるようにする復旧操作を指す。実フォルダ・実 PDF・一般設定・Vimium-C 接続設定・保存済みのページ位置 / マーク / ハイライト / パスワードを削除する操作ではない。

ただし再登録では新しい UUID を使う既存仕様のため、残った PDF 保存データが新登録へ自動的に結び付くとは限らない。破損時にこの操作を用意するか、表示・確認・他タブの扱い・復旧手順をどうするかは未決定。今回のテスト追加では初期化機能を実装・実行しない。
