# Vimium-C から起動するローカル PDF 選択

## 目的と対象

Vimium-C の Vomnibar で `vimdf` を確定すると、VimDF 専用タブでローカル PDF を Vim キー操作で選ぶ。Vomnibar の候補へファイルを追加しない。VimDF は omnibox.keyword を登録せず、既存の Vimium-C とアドレスバーの設定を変更しない。アーカイブされた別の omnibar プロジェクトへの依存やコピーは追加しない。対象は File System Access API を利用できるデスクトップ Chromium。ブラウザごとの拡張ページでの API 利用・権限保持は実機検証が必要。

この変更は仕様と実装前の受け入れテスト。機能本体はまだ実装しない。

## 起動契約

VimDF background は runtime.onMessageExternal で、設定で明示許可した Vimium-C 拡張 ID からの `{type:"vimdf.openLocalBrowser",version:1}` のみ受け付ける。メッセージ内の from 文字列は認証に使わず sender.id を検証する。許可 ID の初期値は空。別ストア版・開発版も利用者が ID を登録できる。通常の内部 onMessage 処理とは分離する。URL・絶対パス・コードは受信契約に含めない。不正型・未対応 version・未許可送信元・incognito は副作用なしで拒否する。許可メッセージは専用タブを開く。候補検索やファイル読み込みを background で実行しない。

Vimium-C 設定例（ADDONID を VimDF の拡張 ID に置換）：

```text
# Custom key mappings
map <v-vimdf> sendToExtension id="ADDONID" raw data={"type":"vimdf.openLocalBrowser","version":1}
# Custom search engines
vimdf: vimium://run/<v-vimdf> VimDF local PDFs
```

設定は利用者が追加する。上記の bare keyword 確定と拡張 ID の差し替えは対象 Vimium-C バージョンで確認し、動作しない場合は正しい設定例へ修正する。既存の他の検索エンジン定義を上書きしない。

## フォルダと操作

初回は専用ページの「フォルダを選ぶ」ボタンまたは Enter によるユーザー操作で showDirectoryPicker({mode:"read"}) を呼ぶ。外部メッセージから自動で標準ダイアログを開かない。選択のキャンセルは正常な取消として扱う。読取専用 directory handle を IndexedDB に保存し、再起動時は queryPermission を確認する。未許可ならユーザー操作から requestPermission を呼ぶ。権限拒否・失効時は列挙を行わない。保存と権限確認の例外は画面で説明し、再選択できる。絶対パスを復元できるとは仮定しない。アクセス対象は登録した1フォルダとその子孫のみ。親への移動は登録ルートまで。

一覧はディレクトリ優先、次に名前順（比較規則はコードポイント順で固定）。通常ファイルは拡張子 .pdf のみ、大文字小文字を区別しない。名前は textContent で表示する。現在のディレクトリだけを列挙し、再帰的全ディスク検索はしない。j/k または矢印で選択、gg/G で先頭/末尾、l/Enter でディレクトリへ移動または PDF を開く、h で親へ。移動後は先頭を選択する。/ で名前の部分一致フィルタに入り、入力中の j/k は文字として扱う。Enter で入力モードを抜け、Esc はフィルタ解除。空一覧は選択なし。選択範囲は端で止まり循環しない。

PDF は file handle.getFile() のバイト列を既存 PDF.js Viewer に渡す。blob URL は輸送に使えても永続 identity に使わない。登録ルート UUID と相対パスを元に安定した専用 identity を生成し、ページ位置・マーク・パスワードの既存保存処理と接続する。異なる登録ルートの同名 PDF は別文書。改名・移動後は別文書として扱う。ルート解除で handle を消去する。API 非対応時は既存の通常ファイル選択へフォールバックし、Vim 操作できると表示しない。

## 実装契約と検証

tests/local-browser.test.mjs は、将来の src/local-browser/model.ts が export する acceptExternalOpen(message,sender,allowedIds) と LocalBrowser を検証する。LocalBrowser は列挙・read/open を依存注入し、entries,selectedIndex,filter を公開する。constructor(root,{openPdf,rootId})、refresh()、key(key)、setFilter(text)、enter()、parent() が非 DOM の契約。enter は選択ファイルの File と stable identity を openPdf に渡す。フォルダ handle は標準の kind/name/values/getFile を利用する。

エンジンの自動テストに加えて、実装時は外部メッセージ受信の配線、設定例、IndexedDB でのハンドル再利用、ユーザージェスチャ必須の権限再要求、権限拒否・取消、遅い列挙結果の競合、フォルダ変更時の選択、検索入力へのキー配送、HTML 名の安全な描画、既存 PDF 保存機能への identity 接続を統合テストする。専用ページは Vimium-C の content script に頼らずキーを自前処理する。

実機確認：Vomnibar 起動 → 初回許可 → フォルダ移動 → PDF 表示、ブラウザ再起動後の復元・再許可、既存 omnibox 動作、Brave/Chrome の差、API 非対応フォールバック。実機未確認の項目を「検証済み」と扱わない。

RootAccess は同じ model.ts から export し、{load,save,clear,pick,newId} を注入する。保存値は {id,handle}。restore() は許可済みのみ返し、authorize() は明示操作から再許可し、choose() は新規フォルダを保存、forget() は保存ハンドルを削除する。読取権限は常に mode:"read"。非許可なら null、I/O 例外は呼び出し側が表示できるよう伝播する。自動テストの対象は純粋なモデル・起動検証・保存/権限制御までで、DOM・実ブラウザ統合は実装後の追加対象。
