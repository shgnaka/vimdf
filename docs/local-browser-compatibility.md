# ローカル PDF ブラウザの対応方針と Vimium 連携

## 対応環境は機能の条件で決める

対象は Manifest V3 の拡張を実行できるデスクトップの Chromium 系ブラウザ。OS・ブラウザ製品・各過去版の全組み合わせを表で管理したり、その全件確認をリリース条件にしたりしない。OS 別の処理が必要になった場合や再現する不具合が見つかった場合に、該当環境の情報を記録する。

拡張の基本的な互換性と、任意機能の API 利用可否は分ける。フォルダ登録・移動には専用ページでの `showDirectoryPicker()`、native directory handle の読取・権限操作、IndexedDB への保存が必要。ブラウザ名だけで成功と判断せず、API の存在を検出し、呼出し・保存時の例外も扱う。API がない構成ではフォルダ操作を停止し、通常の PDF ファイル選択を案内する。保存 DB の破損や権限失効を、API がない状態と同一視しない。

Chrome の公式資料は File System Access API を多くの Chromium 系ブラウザで利用できるとし、Brave はフラグによる有効化が必要な例として挙げている。したがって「Chromium 系なのでフォルダ機能も常に使える」とは保証しない。VimDF からブラウザ設定を変更せず、実行環境の利用可否を表示する。今回、この任意機能のための一律の最低 Chrome 版は追加しない。`minimum_chrome_version` が必要になったときは拡張全体で必須の API に基づいて決める。

## Vimium-C と Vimium の区別

フォルダ画面と PDF Viewer のキー操作は VimDF 自身が実装する。Vimium-C のインストールは閲覧・登録・移動の必須条件ではなく、Vimium を使用していても VimDF の toolbar action や設定画面から利用できる。

現在の Vomnibar の `vimdf` 起動設定は Vimium-C 専用。Vimium-C の `sendToExtension` で VimDF に exact payload を送信する。通常の Vimium のコマンド定義にはこのコマンドがなく、同じ設定例を適用できない。Vimium の URL を開く `createTab` は別機能であり、非公開の専用ページへの直接起動は今回の確認済み経路に含めない。Vimium 対応のために専用ページを `web_accessible_resources` として公開する変更も行わない。

| 接続に必要な機能 | 上流の導入版 | VimDF での位置付け |
| --- | --- | --- |
| `sendToExtension` | Vimium-C 1.87.0 | 外部メッセージ起動に必要。`id`・`raw`・`data` の契約も確認する |
| `vimium://run/<key>` | Vimium-C 1.93.0 | 現在の Vomnibar 起動設定例に必要 |
| `raw` と検索設定の `blank=` を含む設定例全体 | 実機での確認版は未記録 | 必要機能の版数だけで全体の動作を確認済みとしない |

以上から現設定例には少なくとも Vimium-C 1.93.0 以降が必要、という機能上の下限を明示する。これは 1.93.0 を最低保証版として試験したという意味ではない。MR-03 では使用した Vimium-C の版・配布元・拡張 ID、VimDF commit、ブラウザ版と結果を 1 件の記録に残し、その版を動作確認版として案内する。過去の全版に対する対応表は作らない。

## 最小限の検証と記録

CI は現在の bundled Chromium で回帰試験を継続する。既存の `environment.json` の自動添付は不具合再現の補助として維持するが、OS・ブラウザ版の対応を認定する仕組みとは扱わない。新しい手動の環境一覧や全組み合わせを管理する CI job は追加しない。

実機確認は [MR-01〜08](local-browser-testing.md#実機確認の手順と記録) の機能別手順を代表環境で行い、OS picker、再起動後の handle、権限、実 Vimium-C の設定例など CI の代替できない境界を確認する。Chrome と Brave の両方で全手順を繰り返すことは一律の条件にしない。API の無効化など製品差が問題になった場合は、その差に関係する手順だけを追加する。成功した自動試験・実機で確認した事実・未確認の項目は区別し、未確認を非対応とも確認済みとも表示しない。

通常の登録管理は [フォルダごとの登録管理仕様](local-folder-management.md) に従う。全登録を初期化する操作は今回採用しない。

## 根拠

- [Chrome の File System Access API 解説](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)：Chromium 系での利用、Brave の例外、機能検出。
- [Chrome の minimum_chrome_version](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version)：拡張全体のインストール・更新条件。
- [Vimium-C の release notes](https://github.com/gdh1995/vimium-c/blob/master/RELEASE-NOTES.md)、[inner URLs](https://github.com/gdh1995/vimium-c/wiki/Vimium-inner-URLs)：1.87.0 の `sendToExtension`、1.93.0 の `vimium://run`。
- [Vimium-C の外部メッセージ仕様](https://github.com/gdh1995/vimium-c/wiki/Send-dynamic-messages-to-other-extensions)：`id`・`data`・`raw`。
- [Vimium のコマンド定義](https://github.com/philc/vimium/blob/master/background_scripts/all_commands.js)：通常の Vimium の現行コマンド。`createTab` と Vimium-C の接続コマンドを混同しない。
- [Playwright の拡張テスト](https://playwright.dev/docs/chrome-extensions)：bundled Chromium の persistent context を利用する自動試験。

上流資料の確認日：2026-10-09。上流の API・コマンド調査と、この拡張を実機で確認した結果は別の証拠として扱う。
