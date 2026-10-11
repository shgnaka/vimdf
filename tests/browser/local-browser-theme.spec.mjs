import { test, expect, openLesson } from './extension-fixture.mjs';

// Classify rendered surface and text polarity, without fixing palette values,
// stylesheet selectors, theme classes or how settings reach the page.
async function appearance(surface) {
  return surface.evaluate(el => {
    const style = getComputedStyle(el);
    const tone = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number);
      return rgb.reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0) < 128 ? 'dark' : 'light';
    };
    return { background: tone(style.backgroundColor), text: tone(style.color) };
  });
}
async function expectTheme(surface, theme) {
  await expect(surface).toBeVisible();
  await expect.poll(() => appearance(surface)).toEqual({ background: theme, text: theme === 'dark' ? 'light' : 'dark' });
}
async function setTheme(options, theme) {
  await options.locator('#theme').selectOption(theme);
  await expect.poll(async () => (await options.evaluate(() => chrome.storage.sync.get('theme'))).theme).toBe(theme);
}

for (const system of ['light', 'dark']) {
  for (const preference of ['dark', 'light', 'auto']) {
    test(`system ${system}, VimDF ${preference}: each page and modal uses its documented theme owner after reload`, async ({ extension }) => {
      const options = extension.setupPage;
      await options.emulateMedia({ colorScheme: system });
      await expect(options.locator('#theme')).toHaveValue('auto');
      await setTheme(options, preference); await options.reload();
      await expect(options.locator('#theme')).toHaveValue(preference);
      await expectTheme(options.locator('body'), system);
      await options.getByRole('button', { name: 'Create vault', exact: true }).click();
      const vault = options.getByRole('dialog', { name: 'Create password vault', exact: true });
      await expectTheme(vault, system);
      await vault.getByRole('button', { name: 'Cancel', exact: true }).click();

      await extension.seed(); const page = await extension.openBrowser();
      await page.emulateMedia({ colorScheme: system }); await page.reload();
      const expected = preference === 'auto' ? system : preference;
      const files = page.getByTestId('local-browser');
      await expect(files).toHaveAttribute('data-busy', 'false');
      await expectTheme(page.locator('#files'), expected);
      await page.keyboard.press('?');
      await expectTheme(page.getByRole('dialog', { name: 'File browser keybindings', exact: true }), expected);
      await page.keyboard.press('Escape'); await openLesson(page);
      await expectTheme(page.locator('body'), expected);
      await page.keyboard.press('?');
      await expectTheme(page.getByRole('dialog', { name: 'PDF viewer keybindings', exact: true }), expected);
    });
  }
}

test('a live VimDF preference change updates files and PDF viewing while an Options vault keeps system appearance and input', async ({ extension }) => {
  const options = extension.setupPage; await options.emulateMedia({ colorScheme: 'light' });
  await setTheme(options, 'light'); await extension.seed();
  const files = await extension.openBrowser(); const pdf = await extension.openBrowser(); await openLesson(pdf);
  await expect(files.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
  await expectTheme(files.locator('#files'), 'light'); await expectTheme(pdf.locator('body'), 'light');
  await setTheme(options, 'dark');
  await expectTheme(files.locator('#files'), 'dark'); await expectTheme(pdf.locator('body'), 'dark');
  await expectTheme(options.locator('body'), 'light');
  await options.getByRole('button', { name: 'Create vault', exact: true }).click();
  const vault = options.getByRole('dialog', { name: 'Create password vault', exact: true });
  const master = vault.getByLabel('Master password', { exact: true });
  await master.fill('synthetic-unsaved-master');
  await options.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(options.locator('body'), 'dark'); await expectTheme(vault, 'dark');
  await expect(master).toHaveValue('synthetic-unsaved-master'); await expect(master).toBeFocused();
  await options.emulateMedia({ colorScheme: 'light' });
  await expectTheme(vault, 'light'); await expect(master).toHaveValue('synthetic-unsaved-master');
  await vault.getByRole('button', { name: 'Cancel', exact: true }).click();
  await setTheme(options, 'light');
  await expectTheme(files.locator('#files'), 'light'); await expectTheme(pdf.locator('body'), 'light');
});

test('Auto follows live native system changes in files, PDF and an open help without losing PDF position', async ({ extension }) => {
  const options = extension.setupPage; await setTheme(options, 'auto'); await extension.seed();
  const files = await extension.openBrowser(); const pdf = await extension.openBrowser(); await openLesson(pdf);
  await pdf.keyboard.press('G'); await expect(pdf.locator('#statusLeft')).toHaveText('Page 2 / 2');
  await files.keyboard.press('?'); const help = files.getByRole('dialog', { name: 'File browser keybindings', exact: true });
  for (const system of ['dark', 'light', 'dark']) {
    await files.emulateMedia({ colorScheme: system }); await pdf.emulateMedia({ colorScheme: system });
    await expectTheme(files.locator('#files'), system); await expectTheme(help, system);
    await expectTheme(pdf.locator('body'), system);
    await expect(pdf.locator('#statusLeft')).toHaveText('Page 2 / 2');
  }
});
