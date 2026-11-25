import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const releaseDirectory = process.argv.find(arg => arg.startsWith('--release-dir='))?.slice('--release-dir='.length) || 'release';
const executablePath = packaged ? path.resolve(root, releaseDirectory, 'win-unpacked', `${manifest.productName}.exe`)
  : path.join(root, 'node_modules/electron/dist/electron.exe');
const output = path.join(root, 'output', 'playwright');
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(output, 'context-menu-'));
const data = path.join(directory, 'data');
const copies = path.join(directory, 'copies');
const trash = path.join(directory, 'trash');
await Promise.all([data, copies, trash].map(dir => fs.mkdir(dir)));
const stl = path.join(directory, 'テストモデル.stl');
const step = path.join(directory, 'テストモデル.step');
await fs.copyFile(path.join(root, 'tests/fixtures/cube-mm.stl'), stl);
await fs.copyFile(path.join(root, 'tests/fixtures/cube-mm.step'), step);
await fs.writeFile(path.join(data, 'library.json'), JSON.stringify({
  schemaVersion: 1, items: [], folders: [], settings: { bambuPath: path.join(directory, 'unavailable-bambu.exe') }, excludedPaths: [],
}));

const env = { ...process.env, NINE_DATA_DIR: data, NINE_TEST_MODE: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VITE_DEV_SERVER_URL']) delete env[key];
const app = await electron.launch({ executablePath, args: packaged ? [] : ['.'], cwd: root, env, timeout: 40000 });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.nine?.trashModel && window.nine.generateThumbnail);
  await page.evaluate(paths => window.nine.importPaths(paths), [stl, step]);

  // Exercise actual IPC and copy I/O without opening native dialogs. Move the
  // disposable test fixture aside to stand in for the OS Recycle Bin.
  await app.evaluate(({ dialog, shell }, { copies, trash, directory }) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const path = process.getBuiltinModule('node:path');
    globalThis.contextTest = { copyCancelled: false, trashConfirmed: false, confirmations: [], trashed: [] };
    dialog.showOpenDialog = async () => ({
      canceled: globalThis.contextTest.copyCancelled,
      filePaths: globalThis.contextTest.copyCancelled ? [] : [copies],
    });
    dialog.showMessageBox = async (_window, options) => {
      globalThis.contextTest.confirmations.push(options);
      const confirm = options.buttons.findIndex(label => /ゴミ箱/.test(label));
      return { response: globalThis.contextTest.trashConfirmed ? confirm : options.cancelId };
    };
    shell.trashItem = async file => {
      const relative = path.relative(directory, path.resolve(file));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Test trash operation escaped its isolated model directory');
      globalThis.contextTest.trashed.push(file);
      await fs.rename(file, path.join(trash, path.basename(file)));
    };
  }, { copies, trash, directory });

  const names = ['プレビュー', 'サムネイル生成', '指定先へコピー', 'バンブースタジオで開く', '削除'];
  const card = file => page.getByRole('button', { name: `モデル ${path.basename(file)}`, exact: true });
  const menu = page.getByRole('menu');
  async function choose(file, name) {
    await card(file).click({ button: 'right' });
    await menu.getByRole('menuitem', { name, exact: true }).click();
    await menu.waitFor({ state: 'hidden' });
  }

  await card(step).click({ button: 'right' });
  assert.deepEqual((await menu.getByRole('menuitem').allTextContents()).map(label => label.trim()), names);
  assert.equal(await page.getByTestId('model-viewer').count(), 0);
  await page.screenshot({ path: path.join(output, 'model-context-menu.png') });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert(await card(step).evaluate(el => document.activeElement === el));
  await page.keyboard.press('Shift+F10');
  await menu.waitFor();
  await page.keyboard.press('End');
  assert(await menu.getByRole('menuitem', { name: '削除', exact: true }).evaluate(el => document.activeElement === el));
  await page.keyboard.press('Escape');

  await choose(step, 'サムネイル生成');
  await page.locator('[data-testid="thumbnail-batch"][data-status="completed"]').waitFor({ timeout: 30000 });
  const result = await page.evaluate(() => window.nine.getThumbnailBatch());
  assert.deepEqual([result.scope, result.total, result.succeeded], ['single', 1, 1]);
  const registered = await page.evaluate(() => window.nine.getState());
  const stepped = registered.items.find(item => item.name === path.basename(step));
  assert.equal(stepped.hasThumbnail, true);
  const stepImage = card(step).locator(`img[src="nine-thumb://library/${stepped.id}/${stepped.thumbnailRevision}"]`);
  assert.equal(await stepImage.evaluate(async image => { await image.decode(); return image.naturalWidth; }), 480);
  assert.equal(registered.items.find(item => item.name === path.basename(stl)).hasThumbnail, false);
  assert(registered.items.every(item => !Object.hasOwn(item, 'thumbnail')));

  await choose(stl, 'プレビュー');
  await page.locator('[data-phase="ready"]').waitFor();
  assert.match(await page.locator('.preview-heading').innerText(), /テストモデル\.stl/);

  await app.evaluate(() => { globalThis.contextTest.copyCancelled = true; });
  await choose(step, '指定先へコピー');
  assert.deepEqual(await fs.readdir(copies), []);
  await app.evaluate(() => { globalThis.contextTest.copyCancelled = false; });
  await choose(step, '指定先へコピー');
  await page.getByRole('status').filter({ hasText: 'テストモデル.step をコピーした' }).waitFor();
  const copied = path.join(copies, path.basename(step));
  assert.deepEqual(await fs.readFile(copied), await fs.readFile(step));
  await fs.writeFile(copied, 'existing destination');
  await choose(step, '指定先へコピー');
  await page.locator('.toast.error').filter({ hasText: /同じ名前/ }).waitFor();
  assert.equal(await fs.readFile(copied, 'utf8'), 'existing destination');

  await choose(step, 'バンブースタジオで開く');
  await page.locator('.toast.error').filter({ hasText: /Bambu Studioが見つかりません/ }).waitFor();

  await choose(stl, '削除');
  await page.waitForFunction(() => !document.querySelector('.header .primary-button')?.disabled);
  assert(await fs.stat(stl));
  assert.equal((await app.evaluate(() => globalThis.contextTest.trashed)).length, 0);
  const prompt = await app.evaluate(() => globalThis.contextTest.confirmations.at(-1));
  assert.equal(prompt.defaultId, prompt.cancelId);
  assert(`${prompt.message} ${prompt.detail}`.includes(path.basename(stl)));
  await app.evaluate(() => { globalThis.contextTest.trashConfirmed = true; });
  await choose(stl, '削除');
  await card(stl).waitFor({ state: 'hidden' });
  await assert.rejects(fs.stat(stl), { code: 'ENOENT' });
  assert(await fs.stat(path.join(trash, path.basename(stl))));
  assert(await fs.stat(step));
  const saved = await page.evaluate(() => window.nine.getState());
  assert.deepEqual(saved.items.map(item => item.name), [path.basename(step)]);
  assert(await fs.stat(path.join(data, 'library.sqlite3')));
  console.log('Context menu: five actions, keyboard, single STEP thumbnail, preview, copy/cancel/no overwrite, Bambu routing, and delete/cancel passed.');
} finally {
  await app.close();
}
