# Vimium-C から起動する複数フォルダ対応のローカル PDF 選択

## 目的と範囲

Vimium-C の Vomnibar で `vimdf` を確定すると、VimDF 専用タブで登録済みフォルダの PDF を Vim キー操作で選ぶ。複数のフォルダを登録し、そのうち 1 つをプライマリーフォルダとして保存する。起動時はプライマリーのルートを表示し、登録フォルダ一覧で別のフォルダを確定すると、プライマリーを変更して開く。

この PR は専用画面、複数登録モデル、IndexedDB 保存、共有 Viewer、外部起動の許可設定を実装する。ツールバーと設定画面から通常タブを開き、フォルダを登録・選択して PDF を同じタブ内で表示できる。旧 `RootAccess` は未公開・未実装の契約だったため、そのデータ移行は前提にしない。

[統合仕様](local-browser-integration.md) に同一タブ内の一覧 / PDF 切り替え、IDB の revision 比較、Viewer の文書交換、外部起動と実機の受け入れ条件を定義する。

Vomnibar の候補にローカルファイルを追加しない。VimDF は `omnibox.keyword` を登録せず、既存のアドレスバーや他の検索エンジンの設定を変更しない。アーカイブされた別の omnibar プロジェクトには依存しない。対象は File System Access API を利用できるデスクトップブラウザの拡張専用タブ。Chrome と Brave の対応状況・権限保持は実機確認を必要とする。

この画面の「検索」は、現在のフォルダのフォルダ名・PDF 名、または登録フォルダ名の絞り込み。全登録フォルダの再帰検索や PDF 本文の横断検索は含めない。PDF を開いた後の本文検索は既存 Viewer の機能を利用する。

## 起動契約

VimDF background は `runtime.onMessageExternal` で、接続が有効かつ設定で明示許可した Vimium-C 拡張 ID からの `{type:"vimdf.openLocalBrowser",version:1}` だけを受け付ける。`sender.id` を検証し、メッセージ内の `from` 文字列を認証に使わない。初期値は接続無効・許可 ID 空。別ストア版・開発版の ID も利用者が登録できる。通常の内部 `onMessage` 処理とは分離する。

メッセージのキーは `type` と `version` に限定する。URL、絶対パス、コード、`rootId`、`primaryId` を受信しない。不正型・追加フィールド・未対応バージョン・未許可送信元・識別できる incognito 起点は副作用なしで拒否し、シークレットのウィンドウを起動対象にしない。実 sender の正規化と元タブ不明時の対象 window は統合仕様に従う。許可メッセージは専用タブを開くだけで、フォルダ選択・権限要求・列挙・プライマリー変更を実行しない。

Vimium-C 設定例（`ADDONID` を VimDF の拡張 ID に置換）：

```text
# Custom key mappings
map <v-vimdf> sendToExtension id="ADDONID" raw data={"type":"vimdf.openLocalBrowser","version":1}
# Custom search engines
vimdf: vimium://run/<v-vimdf> blank=vimium://run/<v-vimdf> VimDF local PDFs
```

設定は利用者が追加する。bare keyword の確定と ID の差し替えは対象 Vimium-C バージョンで検証し、動作しない場合は設定例を修正する。

## 登録とプライマリー

登録フォルダは `{id,handle}` の組で、登録順を保持する。`id` は登録時に生成する UUID、`handle` は読取用 `FileSystemDirectoryHandle`。表示名や絶対パスを識別子にしない。モデルの State は `{version:1,roots:[{id,handle}],primaryId}`。実 IndexedDB アダプターは統合仕様に従い `{revision,state:State}` の envelope で保存する。空の場合は `roots:[]` と `primaryId:null`、登録がある場合は `primaryId` が必ず登録済みの 1 件を指す。

- 初回登録を自動でプライマリーにする。追加登録では現在のプライマリーを維持する。
- 起動時にプライマリーのルートを開く。直前に開いていた子フォルダや、別の開始位置を保存する設定は今回含めない。
- 登録フォルダ一覧で選択を動かすだけでは変更しない。`Enter` または `l` の確定で保存し、そのルートを開く。
- 同じ実フォルダは `isSameEntry()` で重複判定し、既存 ID を再利用する。重複登録で ID・順序・プライマリーを変更しない。同名の別フォルダはそれぞれ登録できる。
- 標準の `showDirectoryPicker()` は 1 回につき 1 フォルダを選ぶ。複数登録は「フォルダを追加」を繰り返す操作で実現する。
- 取消・権限拒否・比較失敗・保存失敗で、登録やプライマリーを途中まで変更しない。保存完了後にメモリー上の状態を公開する。
- 専用画面の登録一覧から登録を解除できる。設定画面からもこの一覧へ移動できる。非プライマリーの解除では現在値を維持し、プライマリーの解除では登録順で最初の残存フォルダを選ぶ。最後の解除で空にする。残存フォルダの権限が失効していても、勝手に別のフォルダへ置き換えない。解除は保存ハンドルを除く操作で、実ファイルを削除しない。

登録ルートを越えて OS 上の親を発見・列挙しない。`h` で戻れる最上部は、VimDF が作る仮想的な登録フォルダ一覧。追加・切り替えにより、離れた場所にある複数フォルダを扱える。登録ルートの子孫も別途登録できるが、それぞれの登録 ID は独立する。

## 画面とキー操作

画面は未登録・フォルダ内一覧・登録フォルダ一覧・権限確認の 4 状態。登録フォルダ一覧は登録順で表示し、プライマリーを印で示す。フォルダ内一覧から戻ったときは現在のプライマリーを選択する。

| 場面 | 操作 | 結果 |
| --- | --- | --- |
| 未登録 | `Enter` / 「フォルダを追加」 | 標準ダイアログを開き、初回登録を保存して開く。取消は未登録のまま |
| フォルダ内・登録一覧 | `j` / `k`、上下矢印 | 選択を移動。端で止まり、循環しない |
| フォルダ内・登録一覧 | `g` を 2 回 / `G` | 先頭 / 末尾へ移動 |
| フォルダ内 | `Enter` / `l` | 子フォルダへ移動、または PDF を開く |
| フォルダ内 | `h` | 子フォルダから親へ。登録ルートでは登録フォルダ一覧へ |
| 登録一覧 | `Enter` / `l` | 選択した登録をプライマリーとして保存し、ルートを開く |
| 登録一覧 | `a` / 「フォルダを追加」 | 登録を追加し、その行を選択。既存プライマリーは維持 |
| 登録一覧 | `h` | その場に留まる |
| フォルダ内・登録一覧 | `/` | 名前の絞り込み入力へ |
| 絞り込み入力 | `Enter` | 入力モードを終了するだけ。開くにはもう一度確定 |
| 絞り込み中 | `Esc` | 入力モードを終了し、絞り込みを解除 |
| 絞り込みのない登録一覧 | `Esc` | 切り替えを取消。直前のフォルダ内の絞り込み・選択を復元 |
| 権限確認 | `Enter` / 「読取を許可」 | 明示操作から再許可を要求。許可・保存成功後に開く |
| 権限確認 | `Esc` | 登録一覧へ戻る。プライマリーは維持 |

フォルダ内一覧はディレクトリ優先、各種類の中は名前のコードポイント順。ファイルは拡張子 `.pdf` のみを大文字小文字を区別せず表示する。現在のディレクトリだけを列挙し、子孫を事前走査しない。フォルダ移動・プライマリー切り替え後は絞り込みを空にして先頭を選択する。空一覧の選択は `-1`、確定は何もしない。名前は `textContent` で表示する。

絞り込みは大文字小文字を区別しない名前の部分一致。変更時に先頭を選択する。入力中の `j` / `k` / `h` / `l` / `g` / `G` は文字であり、移動コマンドを発火しない。文字列は DOM の `input` イベントから渡し、日本語 IME の合成中のキーは処理しない。Ctrl・Alt・Meta を伴うショートカットも処理しない。`gg` は独立した 2 回のキー押下で成立し、キーリピートや間に入った別コマンドで誤成立させない。`Enter` / `l` / `a` / `Esc` のリピートで開く・許可・追加・取消を繰り返さない。

追加・切り替え・列挙中は処理中を表示し、次の移動・確定を消費して重複処理を起こさない。エラー時も処理中状態を解除して再試行できる。登録一覧の取消はプライマリーを変更しない。起動時の権限確認から一覧へ戻った場合は、取消で戻れるフォルダ内画面がないため一覧に留まる。

## 権限とブラウザの制約

追加は明示的なキー・ボタン操作から `showDirectoryPicker({mode:"read"})` を呼ぶ。外部メッセージやページ起動から自動では開かない。取消の `AbortError` は正常な取消として扱い、その他の例外は画面で説明する。

起動時は保存プライマリーの `queryPermission({mode:"read"})` だけを確認する。他の登録フォルダに対する権限要求や列挙は行わない。切り替え時もまず選択フォルダの権限を確認する。`prompt` / `denied` の場合は列挙もプライマリー変更もせず権限確認画面に移る。次の明示的な `Enter` / ボタン操作から `requestPermission({mode:"read"})` を呼ぶ。許可拒否ではその画面に留まり、`Esc` で登録一覧へ戻れる。

権限付与後の保存失敗でも元のプライマリーを維持する。許可そのものはブラウザ側の状態なので取り消せるとは仮定しない。保存成功後に列挙・ファイル読取が失敗した場合は、新しいプライマリーを保持してエラーと再試行を提示する。保存が成功した状態を黙って巻き戻さない。権限失効と登録解除は別操作であり、失効だけで登録 ID を削除しない。

Chrome / Chromium は保護対象の広いフォルダの選択を制限する。標準のホーム・Documents・Desktop・Downloads のフォルダ自体を登録できるとは保証せず、許可される子フォルダなどを選ぶ。`startIn` は標準ダイアログの初期位置で、VimDF のプライマリー設定やアクセス範囲ではない。`<all_urls>` などの拡張権限からファイルシステム全体への権限を推測しない。Native Messaging による全ディスク対応は今回の範囲外。

専用タブで API の有無を検出し、非対応・無効の場合は理由を表示して既存の通常ファイル選択へ戻れるようにする。その場合にフォルダ登録やキー操作の対応を表示しない。Brave では API が無効な構成も考慮し、ブラウザ名だけで対応判定しない。保存ハンドルの復元、ユーザー操作からの許可要求、拡張専用ページでの API 利用を対象ブラウザで確認する。

API の根拠： [File System Access 仕様](https://wicg.github.io/file-system-access/)（単一フォルダ選択、ユーザー操作、権限）、[Chrome の解説](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)（ハンドルの IndexedDB 保存）、[Chromium の権限実装](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc)（保護パス）。これらは API の実現可能性の根拠であり、この拡張の実機検証結果ではない。

## PDF の識別と表示

PDF は `fileHandle.getFile()` の `File` からバイト列を読み、同じ専用タブ内の共有 PDF.js Viewer へ直接渡す。登録ルート UUID とルートからの相対パスから安定した専用 identity を生成し、ページ位置・マーク・ハイライト・パスワードの既存保存処理と接続する。文書交換と一覧への復帰は統合仕様に従う。

同じルートの同じ相対パスは、プライマリーを往復しても同じ identity。異なるルートや異なる子フォルダの同名 PDF は別文書。改名・移動後は別文書として扱う。登録を解除して登録し直した場合も新 UUID のため別文書になる。通常のプライマリー変更では UUID を再生成しない。ファイル読取に失敗した場合は Viewer を開かない。モデルの identity は `https://local-pdf.vimdf.invalid/<登録 ID>/<相対パス>` とし、各パス要素を個別に URL エンコードする。既存のパスワード保存用 `documentKey()` が受け付ける形式だが、ネットワークから PDF を取得する URL ではない。

## 非 DOM モデルの実装契約

`src/local-browser/model.ts` から次を export する。保存値の handle は IndexedDB で保存し、JSON 化しない。モデルの I/O 例外は画面側で表示・再試行できるよう伝播する。

| Export | 契約 |
| --- | --- |
| `acceptExternalOpen(message,sender,allowedIds)` | 正確な外部起動契約だけに `true` を返す |
| `LocalBrowser(root,{openPdf,rootId})` | `refresh()`、`key(key)`、`setFilter(text)`、`enter()`、`parent()`。公開状態は `entries`、`selectedIndex`、`filter`、`atRoot`。低レベルの `key('gg')` は先頭移動。`parent()` は登録ルートで止まり、仮想一覧はセッションが扱う。`enter()` は `openPdf(File,identity)` を呼ぶ |
| `FolderRegistry({load,save,pick,newId})` | `roots`、`primaryId` を公開し、下記の非同期操作を提供する |
| `LocalBrowserSession({registry,openPdf})` | `start()`、`key(event)`、`setFilter(text)`。公開状態は `view`（`empty` / `browse` / `roots` / `permission`）、`activeRootId`、`pendingRootId`、`entries`、`selectedIndex`、`filter`、`inputMode`（`normal` / `filter`）、`busy` |

`FolderRegistry` の注入関数は `load():Promise<State|null>`、`save(State):Promise<void>`、`pick({mode:"read"}):Promise<DirectoryHandle>`、`newId():string`。`save` は 1 トランザクションで登録リストとプライマリーを保存する。`restore()` 前の初期状態は空。保存の必要な操作は、成功まで既存の状態を維持する。復元時に保存形式・ハンドル・ID の重複・プライマリー参照を検証し、読み込み失敗や不正データを空の設定で上書きしない。失敗後の変更は、再度の復元成功まで拒否する。同一 Registry 内の操作の重複も拒否し、許可要求を非同期キューへ遅延させない。複数タブ間の更新制御は実ストレージアダプターの責務。

| Registry 操作 | 結果 |
| --- | --- |
| `restore()` | 保存された全登録を復元し、許可済みプライマリーの `{id,handle}` を返す。未登録・未許可は `null`。自動再許可や代替選択をしない |
| `add()` | picker から取得し、重複比較・読取権限確認・必要な保存を経て登録を返す。取消・未許可は `null`。追加時に列挙はしない |
| `activate(id)` | 登録済み ID の権限を問い合わせ、許可済みならプライマリーを保存して登録を返す。未許可は `null`。再許可要求はしない |
| `authorize(id)` | 明示操作から読取再許可を要求し、許可と保存成功後に登録を返す。拒否は `null` |
| `remove(id)` | 登録解除と次のプライマリーを一緒に保存する。ローカルファイルを変更しない |

未知の ID の `activate()` / `authorize()` は例外にする。登録一覧の `entries` は `{id,name,isPrimary}` を公開する。画面表示名は `handle.name` を使用する。同名の登録の識別は ID で行い、実装時は登録時刻や短い ID などで区別できる表示を用意する。

Session の `key(event)` は `{key,repeat?,ctrlKey?,altKey?,metaKey?,isComposing?}` を受け取る。同期コマンドは `true`、非同期コマンドは処理完了時に `true` となる Promise、入力文字・IME・修飾キー・未対応キーは同期的な `false` を返す。DOM 側は呼び出しの直後に戻り値が `false` でなければ `preventDefault()` し、Promise を待つ前に既定動作を抑える。非同期のエラーは画面で表示する。`g` の連続押下の解釈、入力モード、権限画面、処理中の重複防止を Session が担う。`setFilter()` は DOM の入力イベントからテキストを更新する操作で、呼ぶだけでは入力モードへ移らない。`refresh()` は保存プライマリーを変えずに現在の一覧を再取得し、列挙失敗からの再試行に使う。

## 受け入れテストと実装後の確認

`npm run test:local-browser` は `tests/local-browser*.test.mjs` をすべて実行する。

画面・IndexedDB・共有 Viewer・外部起動の追加テストは、別の `npm run test:local-integration` と `npm run test:local-browser:browser` で実行する。[テスト契約と対応表](local-browser-testing.md) を参照。既存モデル 78 件、統合契約 50 件、既存回帰 48 件をそれぞれ検証する。Chromium の拡張・DOM 試験と実 Chrome / Brave / Vimium C の手動確認は別に記録する。

| テストファイル | 確認する要件 |
| --- | --- |
| `tests/local-browser.test.mjs` | 外部起動の制限、一覧・名前検索、ルート境界、PDF 読取と identity、列挙失敗、非再帰走査 |
| `tests/local-browser-registry.test.mjs` | 複数登録、プライマリー、不変 ID、重複、保存・復元、取消、権限拒否と明示再許可、I/O 失敗時の整合性、登録解除 |
| `tests/local-browser-session.test.mjs` | 起動画面、`h` で登録一覧、確定と取消、再起動後の既定値、キーイベント・入力・IME、権限画面、追加、切り替え後の identity、非同期中の重複操作 |
| `tests/local-browser-edge.test.mjs` | 入力中のキーリピート、picker・再許可の同期呼び出し、列挙失敗と再試行、遅い列挙の競合、不正な保存値、重複操作、Unicode 順序、既存パスワード保存との identity 互換性 |
| `tests/helpers/local-browser-fixtures.mjs` | handle・保存・picker・PDF 表示の注入用フェイク。権限と I/O 呼出しを記録し、実ブラウザの代わりにモデル契約を検証する |

当初の 67 件の受け入れテストに、実装時の境界条件 11 件を追加した 78 件で実モデルを検証する。`skip` や仮のモデルで成功扱いにしない。GitHub Actions でも `test:local-browser` を実行する。機能全体の実装完了条件はモデルテストの成功に加え、以下の統合・実機確認を満たすこと。

- Vimium-C の設定例から専用タブへ起動し、外部メッセージによる勝手な登録・切り替えがない。
- 実 IndexedDB で複数 handle を保存し、拡張・ブラウザ再起動後も登録 ID とプライマリーを復元する。同一 transaction 内の revision 比較で複数タブの保存競合を検出し、古い状態で登録を消さない。通知・再読み込みまで統合仕様に従う。
- 標準 picker と `requestPermission()` を実際のユーザー操作内で呼ぶ。途中の非同期処理でユーザー操作の効力を失わせない。拒否・取消・失効・読取中の削除・保存失敗を画面で回復できる。
- DOM の入力・keydown・IME を接続し、二重処理を防ぐ。権限画面・登録一覧でフォーカスを適切に移し、選択とプライマリーを画面と支援技術に伝える。
- 遅い列挙結果が切り替え後の一覧を上書きしない。HTML を含むファイル名を安全に表示する。
- Viewer への identity 接続で既存のページ位置・マーク・パスワードを保持し、PDF 本文検索が動作する。登録解除は既存 PDF 保存データの一括削除を兼ねない。
- Chrome / Brave の対象バージョン、保護フォルダ、API 無効時の通常ファイル選択、既存 omnibox の動作を確認する。

モデルテストだけで DOM・権限保持・実ブラウザ対応を検証済みとは扱わない。
