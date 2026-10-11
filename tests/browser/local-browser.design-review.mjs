import { writeFile } from 'node:fs/promises';
import { test, expect, filter, openLesson } from './extension-fixture.mjs';

test.use({ actionTimeout: 5000 });
const screen = page => page.getByTestId('local-browser');
async function ready(page) { await expect(screen(page)).toHaveAttribute('data-busy', 'false'); }
async function roots(page) { await ready(page); await page.keyboard.press('r'); await expect(screen(page)).toHaveAttribute('data-view', 'roots'); await ready(page); }
async function prepare(extension, theme, seed = {}) {
  await extension.setupPage.evaluate(theme => chrome.storage.sync.set({ theme }), theme);
  if (seed !== false) await extension.seed(seed);
  const page = await extension.openBrowser(); await page.setViewportSize({ width: 960, height: 540 });
  return page;
}
function captureFor(theme, testInfo) {
  const entries = [];
  return async (page, id, title, note, fullPage = false) => {
    await page.evaluate(() => document.fonts.ready);
    // Wait for actual layout/paint rather than altering DOM, CSS or row data.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const file = `${theme}-${id}.png`;
    await page.screenshot({ path: testInfo.outputPath(file), fullPage, animations: 'disabled' });
    const observed = await page.evaluate(() => ({
      mode: document.querySelector('[data-testid="local-browser"]')?.dataset.mode ?? null,
      view: document.querySelector('[data-testid="local-browser"]')?.dataset.view ?? null,
      busy: document.querySelector('[data-testid="local-browser"]')?.dataset.busy ?? null,
      location: document.querySelector('[data-testid="browser-location"]')?.textContent ?? null,
      status: document.querySelector('#browser-state')?.textContent ?? null,
      dialog: document.querySelector('dialog[open]')?.getAttribute('aria-label') ?? document.querySelector('dialog[open] h2')?.textContent ?? null,
      background: getComputedStyle(document.querySelector('#files') ?? document.body).backgroundColor,
    }));
    entries.push({ file, id, title, note, theme, viewport: page.viewportSize(), observed,
      sourceCommit: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null,
      evidence: 'Production extension in Chromium; synthetic files and controlled native I/O boundaries.' });
    await writeFile(testInfo.outputPath('screens.json'), JSON.stringify(entries, null, 2));
  };
}

for (const theme of ['dark', 'light']) {
  test(`${theme}: files, roots, search, help and confirmations`, async ({ extension }, testInfo) => {
    const page = await prepare(extension, theme, { emptyFolder: true }); await ready(page);
    const shot = captureFor(theme, testInfo);
    await shot(page, 'D01', 'ファイル選択', '名前・種類アイコン・選択・現在位置を確認。ファイルは試験用データ。');
    await page.keyboard.press('/'); await page.getByTestId('browser-filter').fill('資料');
    await shot(page, 'D06', '名前の絞り込み入力', '入力は一時表示。文字サイズとステータスとの間隔を確認。');
    await page.keyboard.press('Escape'); await filter(page, 'no-matching-name');
    await expect(page.getByRole('option')).toHaveCount(0);
    await shot(page, 'D08', '検索結果なし', '0 件と検索語を表示。空フォルダとの説明の違いを確認。');
    await page.keyboard.press('Escape'); await page.keyboard.press('?');
    const help = page.getByRole('dialog', { name: 'File browser keybindings', exact: true }); await expect(help).toBeVisible();
    await shot(page, 'D15', 'ファイル選択のキーバインド', '一覧専用ヘルプ。文字サイズ・表・スクロール領域を確認。');
    await page.keyboard.press('/'); await help.getByRole('textbox').fill('no-such-command');
    await shot(page, 'D16', 'ヘルプの検索結果なし', '背後の一覧は維持。入力と結果なしの説明を確認。');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await roots(page);
    await shot(page, 'D02', '登録済みフォルダ', '選択カーソルと Default は別。個別の Remove を確認。');
    await page.getByRole('button', { name: 'Unregister University', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Unregister folder?' })).toBeVisible();
    await shot(page, 'D13', 'プライマリーフォルダの登録解除確認', '対象と次の既定を表示。初期フォーカスは Keep folder。');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Unregister Books', exact: true }).click();
    await shot(page, 'D13-other', 'プライマリー以外の登録解除確認', '既定が変わらないことと、ファイル・保存データの保持を表示。');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await ready(page);
    await extension.setupPage.evaluate(() => chrome.storage.sync.set({ showAddFolderButton: false, showRegisteredFoldersButton: false }));
    await expect(page.locator('#files [data-action="add"]')).toBeHidden();
    await expect(page.locator('#files [data-action="roots"]')).toBeHidden();
    await shot(page, 'D01-keys', '上部ボタンを隠した状態', '操作枠も隠れる。r / a / ? は引き続き利用可能。');
    await filter(page, 'empty'); await page.keyboard.press('Enter'); await ready(page);
    await expect(page.getByRole('option')).toHaveCount(0);
    await shot(page, 'D07', '空フォルダ', 'フォルダ登録済みで中に表示対象がない状態。未登録とは別。');
  });

  test(`${theme}: unregistered`, async ({ extension }, testInfo) => {
    const page = await prepare(extension, theme, false); await ready(page);
    await expect(screen(page)).toHaveAttribute('data-view', 'empty');
    await captureFor(theme, testInfo)(page, 'D04', '未登録', '開始時の案内。見出しを大きくせず、追加操作を確認。');
  });

  test(`${theme}: last folder`, async ({ extension }, testInfo) => {
    const page = await prepare(extension, theme, { singleRoot: true }); await ready(page); await roots(page);
    const shot = captureFor(theme, testInfo);
    await page.getByRole('button', { name: 'Unregister University', exact: true }).click();
    await shot(page, 'D14', '最後の登録を解除する確認', '登録が 0 件になることと、再追加可能なことを確認。');
    await page.getByRole('button', { name: 'Unregister folder', exact: true }).click(); await ready(page);
    await expect(screen(page)).toHaveAttribute('data-view', 'empty');
    await shot(page, 'D04-removed', '最後の登録を解除した後', '解除後も同じ追加の案内に戻る。ファイル削除は行わない。');
  });

  test(`${theme}: permission`, async ({ extension }, testInfo) => {
    await extension.setupPage.evaluate(theme => chrome.storage.sync.set({ theme }), theme); await extension.seed();
    await extension.context.addInitScript(() => { window.__permission = 'prompt'; });
    const page = await extension.openBrowser(); await page.setViewportSize({ width: 960, height: 540 }); await ready(page);
    await expect(screen(page)).toHaveAttribute('data-view', 'permission');
    await captureFor(theme, testInfo)(page, 'D05', '読取権限の再確認', '権限 API の境界を制御した本番画面。OS の許可窓自体は含まない。');
  });

  test(`${theme}: folder picker and pending reads`, async ({ extension }, testInfo) => {
    const page = await prepare(extension, theme); await ready(page); const shot = captureFor(theme, testInfo);
    await page.evaluate(() => {
      const pick = window.showDirectoryPicker;
      window.showDirectoryPicker = options => {
        const result = pick(options);
        return new Promise(resolve => { window.__releasePicker = async () => resolve(await result); });
      }; window.__pickerName = 'Work';
    });
    await page.keyboard.press('a'); await expect(screen(page)).toHaveAttribute('data-busy', 'true');
    await shot(page, 'D03', 'フォルダ追加の待機画面', '標準 picker を待つ拡張側の画面。OS の窓は CI で撮影できず、実機確認が必要。');
    await page.evaluate(() => window.__releasePicker()); await ready(page);
    await page.getByRole('option', { name: 'University', exact: true }).dblclick(); await ready(page); await filter(page, 'course');
    await page.evaluate(() => {
      const values = FileSystemDirectoryHandle.prototype.values; let held = false;
      const gate = new Promise(resolve => { window.__releaseFolderRead = resolve; });
      FileSystemDirectoryHandle.prototype.values = async function* (...args) {
        if (this.name === 'course' && !held) { held = true; await gate; }
        yield* values.apply(this, args);
      };
    });
    await page.keyboard.press('Enter'); await expect(screen(page)).toHaveAttribute('data-busy', 'true');
    await expect(page.locator('#browser-state')).toContainText('LOADING');
    await shot(page, 'D09', 'フォルダ読込中', '直前の行・現在位置を保持し、LOADING と操作の無効化を表示。');
    await page.evaluate(() => window.__releaseFolderRead()); await ready(page);
    await page.evaluate(() => {
      const arrayBuffer = File.prototype.arrayBuffer; let held = false;
      const gate = new Promise(resolve => { window.__releasePdfBytes = resolve; });
      File.prototype.arrayBuffer = async function (...args) {
        if (this.name === 'lesson.pdf' && !held) { held = true; await gate; }
        return arrayBuffer.apply(this, args);
      };
    });
    await filter(page, 'lesson'); await page.keyboard.press('Enter');
    await expect(screen(page)).toHaveAttribute('data-mode', 'loading-pdf');
    await shot(page, 'D10', 'PDF 読込中', '本番の読込 overlay と取消。ファイル bytes の読込完了だけを保留。');
    await page.evaluate(() => window.__releasePdfBytes());
    await expect(screen(page)).toHaveAttribute('data-mode', 'pdf');
    await expect(page.locator('#viewer .page canvas').first()).toBeVisible();
    await shot(page, 'R01', 'PDF Viewer の参照', '既存デザインを変更しない参照画面。実際の試験用 PDF を表示。');
    await page.keyboard.press('?'); await expect(page.getByRole('dialog', { name: 'PDF viewer keybindings' })).toBeVisible();
    await shot(page, 'R02', 'Viewer のキーバインドの参照', 'VimDF — Keybindings の既存デザイン。ファイル選択のヘルプとは別。');
  });

  test(`${theme}: failures and another tab`, async ({ extension }, testInfo) => {
    const page = await prepare(extension, theme); await ready(page); const shot = captureFor(theme, testInfo);
    await page.evaluate(() => { window.__pickerError = 'NotAllowedError'; }); await page.keyboard.press('a');
    await expect(page.getByRole('alert')).toBeVisible(); await ready(page);
    await shot(page, 'D11', '追加時の許可拒否', 'picker が NotAllowedError を返す境界を制御。エラー・Retry と元の一覧を確認。');
    await page.evaluate(() => {
      window.__pickerError = null; window.__pickerName = 'Work';
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'registry') throw new DOMException('Folder registration could not be saved', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    await page.keyboard.press('a'); await ready(page); await expect(page.getByRole('alert')).toContainText('could not be saved');
    await shot(page, 'D11-save', '登録保存の失敗', 'native IDB の保存境界を失敗させる。元の登録・一覧を保持する本番画面。');
    await page.reload(); await ready(page);
    const other = await extension.openBrowser(); await ready(other); await roots(other); await other.keyboard.press('j'); await other.keyboard.press('Enter'); await ready(other);
    await expect(page.getByTestId('registry-stale')).toBeVisible();
    await shot(page, 'D12', '別タブで登録が更新された状態', '実際に別の拡張タブで既定を変更。更新通知と Reload folders を確認。');
  });

  for (const guard of ['database', 'api', 'private']) {
    test(`${theme}: ${guard} guard`, async ({ extension }, testInfo) => {
      await extension.setupPage.evaluate(theme => chrome.storage.sync.set({ theme }), theme); await extension.seed();
      await extension.context.addInitScript(guard => {
        if (guard === 'database') IDBFactory.prototype.open = () => { throw new DOMException('storage unavailable', 'SecurityError'); };
        if (guard === 'api') Object.defineProperty(window, 'showDirectoryPicker', { value: undefined });
        if (guard === 'private') Object.defineProperty(chrome.extension, 'inIncognitoContext', { value: true });
      }, guard);
      const page = await extension.openBrowser(); await page.setViewportSize({ width: 960, height: 540 });
      if (guard === 'api') await expect(page.locator('#browser-fallback')).toBeVisible(); else await expect(page.getByRole('alert')).toBeVisible();
      const [id, title, note] = guard === 'database' ? ['D17', '保存 DB の初期化失敗', 'DB open が SecurityError を返す境界を制御。初回登録成功と混同しない。']
        : guard === 'api' ? ['D18', 'フォルダ API 非対応', 'API 不在の境界を制御。利用可能な Open PDF file を確認。']
        : ['D21', 'private 起動の停止', 'incognito API の境界を制御。通常のトップレベルタブへの案内。実 private プロファイルの確認ではない。'];
      await captureFor(theme, testInfo)(page, id, title, note);
    });
  }

  test(`${theme}: narrow viewport and long names`, async ({ extension }, testInfo) => {
    const page = await prepare(extension, theme, { sameNames: true, sameName: 'UnbrokenFolderNameForCourseMaterials' });
    await page.setViewportSize({ width: 320, height: 640 }); await ready(page); await roots(page);
    const shot = captureFor(theme, testInfo);
    await shot(page, 'D20', '狭い幅・長い同名登録', '320 px。長い名前、識別 ID、Default、Remove の折返しを確認。');
    await page.getByRole('button', { name: 'Unregister UnbrokenFolderNameForCourseMaterials', exact: true }).first().click();
    await shot(page, 'D20-confirm', '狭い幅の解除確認', '長い対象名と ID、次の既定、取消・確定ボタンを確認。');
    await page.keyboard.press('Escape'); await page.keyboard.press('?');
    await shot(page, 'D20-help', '狭い幅のヘルプ', '表・説明・入力の横はみ出しを確認。内部スクロールを持つ。');
    await page.keyboard.press('Escape');
    await extension.setupPage.evaluate(() => chrome.storage.local.set({ 'vimdf.customCss.v1': { version: 1, css: '.vimdf-browser { font-size: 17px; }' } }));
    await expect(page.locator('#files')).toHaveCSS('font-size', '17px');
    await shot(page, 'D20-font17', '狭い幅・基準文字サイズ 17 px', 'Custom CSS で文字サイズだけを変更。補助情報も同じサイズ。');
    await page.keyboard.press('/'); await page.getByTestId('browser-filter').fill('unbrokensearchname'.repeat(5));
    await shot(page, 'D20-wrap', '狭い幅・長い検索語', '入力と折返したステータスが重ならず、検索語を読めるか確認。');
  });

  test(`${theme}: discarded PDF history`, async ({ extension }, testInfo) => {
    const page = await prepare(extension, theme); await ready(page); await openLesson(page);
    const discarded = await page.evaluate(() => history.state);
    await page.keyboard.press('H'); await ready(page); await roots(page);
    await page.getByRole('option', { name: 'Books', exact: true }).dblclick();
    await filter(page, 'lesson'); await page.keyboard.press('Enter'); await expect(screen(page)).toHaveAttribute('data-mode', 'pdf');
    await page.keyboard.press('H'); await ready(page);
    await page.evaluate(state => { history.pushState(state, ''); history.back(); }, discarded);
    await expect.poll(() => page.evaluate(() => history.state?.view)).toBe('files'); await page.goForward();
    await expect(page.locator('#browser-message')).toContainText('Select the PDF again');
    await captureFor(theme, testInfo)(page, 'D22', '破棄された PDF の履歴', '別 PDF に切り替えた後の古い履歴。再選択の案内を確認。');
  });

  test(`${theme}: frozen Options and password dialog references`, async ({ extension }, testInfo) => {
    await extension.setupPage.evaluate(theme => chrome.storage.sync.set({ theme }), theme);
    const options = extension.setupPage; await options.reload(); await options.setViewportSize({ width: 960, height: 640 });
    const shot = captureFor(theme, testInfo);
    await expect(options.locator('#showAddFolderButton')).toBeVisible();
    await shot(options, 'R03', 'Options 全体の参照', '既存デザイン。File browser と Custom CSS の配置を含む。全ページの撮影。', true);
    await options.locator('#localBrowserSettings').scrollIntoViewIfNeeded();
    await shot(options, 'R03-browser', 'Options の File browser 節', 'ボタン表示の設定と起動・接続設定を確認。デザインの変更対象外。');
    await options.locator('#passwordCreateVault').click(); await expect(options.getByRole('dialog', { name: 'Create password vault' })).toBeVisible();
    await shot(options, 'R04', '保管庫ダイアログの参照', '既存 Options のダイアログ。秘密値は入力しない。');
    await extension.seed(); const page = await extension.openBrowser(); await page.setViewportSize({ width: 960, height: 540 }); await ready(page);
    await filter(page, 'locked'); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'PDF password', exact: true })).toBeVisible();
    await shot(page, 'R05', 'PDF パスワード入力の参照', '本番 PDF.js の暗号化文書。入力欄は空で撮影。デザインの変更対象外。');
  });
}
