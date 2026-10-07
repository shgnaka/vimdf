# PDF パスワード登録・自動入力仕様

## 利用者の操作

設定に「PDF パスワード」を追加する。名前とパスワードを登録・編集・削除でき、全削除も提供する。パスワードは既定で伏字、明示操作で表示できる。空文字の登録は禁止するが、空白だけの文字列は有効とし、前後の空白・Unicode を加工しない。同じ秘密文字列の重複登録は拒否する。名前の重複は許す。登録時の「他の PDF でも自動入力する」は既定でオン、適用範囲を文言で明示する。各登録は無効化・並べ替えできる。

暗号化 PDF を開くと、その文書で最後に成功した有効な登録を先頭にし、次に他の文書への自動入力を許可した登録を設定順に試す。文書との関連付けがなく、共有も許可されていない登録は試さない。全体の自動入力をオフにすると保存済み候補は一切試さない。全候補が失敗したらパスワードダイアログにフォーカスする。手入力には「成功したら保存する」（既定オフ）と登録名・共有範囲を用意する。既存候補と同じパスワードなら重複登録せず、その登録へ関連付ける。

間違った手入力では同じダイアログにエラーを表示して再入力できる。Enter で送信、Esc またはキャンセルで読み込みを中止する。入力中は Vim キー操作を停止する。パスワード不要の PDF ではダイアログも候補の読み込みも行わない。保存失敗は「開けましたが保存できませんでした」と表示し、開いた PDF を閉じない。保存済み候補の失敗だけで削除・上書きしない。

## 保存と適用範囲

chrome.storage.local にバージョン付きの登録レコードを保存する。chrome.storage.sync、URL、ログ、解析イベント、ページ側 DOM、postMessage に秘密を載せない。初版は平文保存であり暗号化保管を保証しない旨を登録画面に示す。保存しない手入力は読み込み終了後に参照を解放する。storage.local のアクセス範囲は TRUSTED_CONTEXTS に制限する。インコグニートでは既存の通常プロファイルの登録を読み書きしない。

文書キーは取得用の一時ストリーム URL ではなく PdfSource.identity を使う。HTTP(S) / file URL はフラグメントだけ除去し、クエリは残す（別ファイルや署名 URL を勝手に同一扱いしない）。名前しか分からない選択・ドロップファイルは、暗号化ファイルの全バイトの SHA-256 を文書キーにする。ファイル名単独では関連付けない。同じ URL のファイルが差し替わっても保存候補を試せるが、失敗時は手入力へ戻る。名前やドメインでパスワードを推測しない。

全候補は拡張機能内の PDF.js にだけ渡す。PDF 配信元へ送信するフォーム自動入力ではない。登録数は最大 100 件とし、登録済み候補を読み込みごとに各 1 回まで試す。手入力の再試行回数には制限を設けない。

## PDF.js との接続

getDocument が返す loadingTask.onPassword を loadingTask.promise の await より前に設定する。NEED_PASSWORD=1 / INCORRECT_PASSWORD=2 で次の候補を updatePassword に渡す。候補の成功判定は callback の理由ではなく loadingTask.promise の解決で行う。成功後だけ文書の関連付け、または保存を実行する。通常のネットワーク・PDF 解析エラーは元の読み込みエラーとして返し、パスワードエラーへ変換しない。

キャンセルは loadingTask.destroy() を呼び出し、AbortError で終了する。AbortSignal による文書切り替えも同じ扱い。キャンセル済みのダイアログ結果や遅れた storage 応答を無視し、古い文書への保存・表示更新を防ぐ。コールバック内の非同期例外は捕捉し、読み込み待ちを放置しない。読み取り失敗時は空候補として手入力へ進む。

## テストが要求する境界 API

src/viewer/passwords.ts に以下を実装している。viewer.load、設定画面、Chrome ローカル保存に接続済み。

実行環境は Node.js 24 以上。npm ci の後 npm run test:password で契約テスト、保存処理テスト、実 PDF.js 結合テストを実行する。合計 34 件。RC4-128 と AES-256 の合成 PDF フィクスチャは pypdf で作成した空白 1 ページの文書で、実ユーザーの文書やパスワードを含まない。PDF.js 結合テストのタイムアウトは 10 秒、その他の読み込み契約テストは 2 秒。npm run build は型チェックも行う。GitHub Actions でもテストとビルドを実行する。

- documentKey(identity: string): string — URL のフラグメント除去。HTTP(S)/file 以外は関連付け不可として例外。ファイルバイトのハッシュは呼び出し側が生成する。
- selectCandidates(records, rememberedId, enabled): Record[] — 有効・適用範囲・順序・秘密文字列の重複排除。
- validateRegistration(records, draft): void — 非空パスワード、上限、重複を検証。失敗は例外。
- openWithPasswords({task, documentKey, store, prompt, autoFill, signal?, onSaveError?}): Promise<Document> — task は PDF.js の loadingTask と同じ onPassword / promise / destroy を持つ。
- Record = {id, name, password, enabled, shared}; store.read(key) は {records, rememberedId} を返す。store.remember(key,id) と store.save(key,{name,password,shared}) は成功後のみ呼ぶ。store.save は既存秘密の再利用も行う。通常モード・インコグニートの store の選択は呼び出し側の責任。
- prompt({incorrect,signal?}) は {name,password,remember,shared} またはキャンセルを表す null を返す。onSaveError に秘密や元の例外を渡さない。

## 実ブラウザでの受け入れ確認

契約・保存テストのモックだけでは Chrome UI を検証しない。実 PDF.js による RC4-128 / AES-256 の復号は結合テストで確認済み。実ブラウザでは、暗号化 PDF（URL、file、ドロップ、MIME ストリーム）と非暗号化 PDF を用意し、再起動後の自動入力、登録の編集・削除、伏字、Enter/Esc、Vim キーとの競合、インコグニート分離、TRUSTED_CONTEXTS 設定、保存容量エラーを確認する。環境にブラウザ実行ファイルがないため、これらの画面操作は未確認。

パスワードは OS キーチェーンやマスターパスワードで暗号化していない。保存済み候補は文書を開くたびに読み出す。設定変更は次回の読み込みに反映される。文書切り替えは前の読み込みを中止し、待機中のダイアログ結果やストレージ読み取り結果を破棄する。Chrome にすでに送信済みの storage.set 自体はキャンセルできない。
