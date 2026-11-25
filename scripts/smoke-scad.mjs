import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const releaseDirectory = process.argv.find(arg => arg.startsWith('--release-dir='))?.slice('--release-dir='.length) || 'release';
const exe = packaged ? path.resolve(root, releaseDirectory, 'win-unpacked', `${manifest.productName}.exe`)
  : path.join(root, 'node_modules/electron/dist/electron.exe');
const out = path.join(root, 'output', 'playwright');
await fs.mkdir(out, { recursive: true });
const temp = await fs.mkdtemp(path.join(out, 'scad-'));
const data = path.join(temp, 'data');
const models = path.join(temp, 'models');
const outputs = ['current', 'specified', 'selected', 'all'].map(name => path.join(temp, name));
await Promise.all([data, models, ...outputs].map(directory => fs.mkdir(directory)));
const original = await fs.readFile(path.join(root, 'tests/fixtures/customizable-parts.scad'));
const source = path.join(models, 'customizable-parts.scad');
const movedSource = path.join(models, 'relocated-parts.scad');
const presetJson = path.join(temp, 'customizable-parts.json');
const importJson = path.join(temp, 'additional-presets.json');
await fs.writeFile(source, original);
const env = { ...process.env, NINE_DATA_DIR: data, NINE_TEST_MODE: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VITE_DEV_SERVER_URL']) delete env[key];

function stlDimensions(stl) {
  const facets = stl.readUInt32LE(80);
  assert(facets > 0);
  assert.equal(stl.length, 84 + 50 * facets);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let face = 0; face < facets; face++) {
    for (let position = 0; position < 3; position++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = stl.readFloatLE(84 + face * 50 + 12 + position * 12 + axis * 4);
        assert(Number.isFinite(value));
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
  }
  return max.map((value, index) => value - min[index]);
}

const app = await electron.launch({ executablePath: exe, args: packaged ? [] : ['.'], cwd: root, env, timeout: 40000 });
try {
  const page = await app.firstWindow();
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), manifest.version, exe);
  assert.equal(await app.evaluate(({ app }) => app.getName()), manifest.productName);
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), data);
  await page.waitForFunction(() => window.nine?.getScadParameters);
  assert.equal(await page.title(), manifest.productName);
  await app.evaluate(({ dialog }, { folders, presetJson, importJson, movedSource }) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (options.title === 'OpenSCADプリセットJSONを読み込む') return { canceled: false, filePaths: [importJson] };
      if (options.title.includes('移動先のファイルを選択')) return { canceled: false, filePaths: [movedSource] };
      if (!options.properties.includes('openDirectory') || !folders.length) throw new Error('Unexpected folder dialog');
      return { canceled: false, filePaths: [folders.shift()] };
    };
    dialog.showSaveDialog = async (_window, options) => {
      if (options.title !== 'OpenSCADプリセットJSONの保存先') throw new Error('Unexpected save dialog');
      return { canceled: false, filePath: presetJson };
    };
    dialog.showMessageBox = async (_window, options) => {
      if (options.title !== '登録済みの移動先に再紐付け' || options.defaultId !== 0) throw new Error('Unexpected confirmation');
      return { response: 1 };
    };
  }, { folders: outputs, presetJson, importJson, movedSource });
  const state = await page.evaluate(directory => window.nine.importPaths([directory]), models);
  assert(state.settings.openscadPath, 'Smoke test requires an installed OpenSCAD executable');
  assert.equal(state.items.find(item => item.name === 'customizable-parts.scad')?.format, 'scad');
  const card = page.getByRole('button', { name: 'モデル customizable-parts.scad', exact: true });
  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'サムネイル生成', exact: true }).click();
  await page.locator('[data-testid="thumbnail-batch"][data-status="completed"]').waitFor({ timeout: 30000 });
  assert.equal((await page.evaluate(() => window.nine.getThumbnailBatch())).succeeded, 1);
  await card.click();
  await page.getByRole('button', { name: '3Dプレビューを読み込む', exact: true }).click();
  await page.locator('[data-phase="ready"]').waitFor({ timeout: 30000 });
  const panel = page.getByTestId('scad-panel');
  const width = panel.getByRole('textbox', { name: /base.width/i });
  await width.waitFor();
  assert.equal(await width.inputValue(), '20');
  assert(!/internal_dimension/.test(await panel.innerText()));
  const dimensions = () => page.locator('.dimensions b').allTextContents();
  assert.equal((await dimensions())[0], '20.00');

  await width.fill('26');
  const savedPreset = panel.getByLabel('保存したプリセット', { exact: true });
  await panel.getByLabel('プリセット名', { exact: true }).fill('Fixture Wide');
  await panel.getByRole('button', { name: '新規保存', exact: true }).click();
  await panel.getByText('プリセットを保存しました', { exact: true }).waitFor();
  assert.equal(await savedPreset.locator('option:checked').textContent(), 'Fixture Wide');
  await width.fill('30');
  await panel.getByRole('button', { name: '適用', exact: true }).click();
  await panel.getByText(/編集欄に反映しました/).waitFor();
  assert.equal(await width.inputValue(), '26');
  assert.equal((await dimensions())[0], '20.00', 'Applying a preset must not start a render');

  await panel.getByRole('button', { name: 'JSONに書き出す', exact: true }).click();
  await panel.getByText('プリセットをJSONに書き出しました', { exact: true }).waitFor();
  const exportedPreset = JSON.parse(await fs.readFile(presetJson, 'utf8'));
  assert.deepEqual(exportedPreset, { parameterSets: { 'Fixture Wide': { base_width: '26' } }, fileFormatVersion: '1' });
  await fs.writeFile(importJson, JSON.stringify({ parameterSets: { Reimported: { base_width: '28' } }, fileFormatVersion: '1' }));
  await panel.getByRole('button', { name: 'JSONを読み込む', exact: true }).click();
  await panel.getByText('1件のプリセットを追加しました', { exact: true }).waitFor();
  await savedPreset.selectOption({ label: 'Reimported' });
  await panel.getByRole('button', { name: '適用', exact: true }).click();
  await panel.getByText(/編集欄に反映しました/).waitFor();
  assert.equal(await width.inputValue(), '28');
  await savedPreset.selectOption({ label: 'Fixture Wide' });
  await panel.getByRole('button', { name: '適用', exact: true }).click();
  await panel.getByText(/編集欄に反映しました/).waitFor();
  assert.equal(await width.inputValue(), '26');
  await panel.getByRole('button', { name: 'プレビューを更新' }).click();
  await page.waitForFunction(() => document.querySelector('.dimensions b')?.textContent === '26.00', null, { timeout: 30000 });
  await page.screenshot({ path: path.join(out, 'openscad-preview.png') });

  const info = panel.getByRole('region', { name: 'STL出力結果' });
  async function runExport(button, folder, count) {
    await panel.getByRole('button', { name: button, exact: true }).click();
    await info.getByText(count + ' 件を保存', { exact: true }).waitFor({ timeout: 30000 });
    const files = await fs.readdir(folder);
    assert.equal(files.length, count, folder);
    const geometry = new Map();
    for (const name of files) geometry.set(name, stlDimensions(await fs.readFile(path.join(folder, name))));
    return geometry;
  }

  const full = await runExport('STLを書き出す', outputs[0], 1);
  assert.deepEqual([...full.values()][0], [26, 12, 14]);

  await panel.getByRole('radio', { name: '指定したパーツを出力' }).check();
  await panel.getByLabel('出力するパーツ', { exact: true }).selectOption({ label: 'Cap' });
  const specified = await runExport('1 パーツを書き出す', outputs[1], 1);
  assert.deepEqual([...specified.values()][0], [24, 10, 3]);

  await panel.getByRole('radio', { name: '選択したパーツを出力' }).check();
  await panel.getByRole('checkbox', { name: 'Base', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Peg', exact: true }).check();
  const selected = await runExport('2 パーツを書き出す', outputs[2], 2);
  assert.deepEqual([...selected.values()].sort((a, b) => a[0] - b[0]), [[5, 5, 7], [26, 12, 4]]);

  await panel.getByRole('radio', { name: '全パーツを一括出力' }).check();
  const all = await runExport('3 パーツを書き出す', outputs[3], 3);
  assert.deepEqual([...all.values()].sort((a, b) => a[0] - b[0]), [[5, 5, 7], [24, 10, 3], [26, 12, 4]]);
  for (const [name, size] of [...specified, ...selected]) assert.deepEqual(all.get(name), size);
  assert(![...all.keys()].some(name => name.includes('assembly')));
  assert.deepEqual(await fs.readFile(source), original);
  await info.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'openscad-export.png') });

  const id = state.items.find(item => item.name === 'customizable-parts.scad').id;
  await page.evaluate(modelId => window.nine.updateItem(modelId, { notes: 'Preserve this note', favorite: true, tags: ['fixture'] }), id);
  await fs.rename(source, movedSource);
  const afterMove = await page.evaluate(() => window.nine.rescan());
  assert(afterMove.items.find(item => item.id === id).missing);
  const duplicate = afterMove.items.find(item => item.name === 'relocated-parts.scad');
  assert(duplicate && duplicate.id !== id, 'The watched folder should already have registered the new path');
  await page.getByRole('button', { name: /^ファイル不在/ }).click();
  await card.locator('.missing-badge').waitFor();
  assert.equal(await page.getByRole('button', { name: 'モデル relocated-parts.scad', exact: true }).count(), 0);
  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '元ファイルを再指定', exact: true }).click();
  await page.getByText('元ファイルを再指定した。タグ・メモ・プリセットを引き継いだ。', { exact: true }).waitFor({ timeout: 10000 });
  const relinked = await page.evaluate(() => window.nine.getState());
  const item = relinked.items.find(entry => entry.id === id);
  assert.equal(item.path, movedSource);
  assert.equal(item.missing, false);
  assert.equal(item.favorite, true);
  assert.deepEqual(item.tags, ['fixture']);
  assert.equal(item.notes, 'Preserve this note');
  assert(!relinked.items.some(entry => entry.id === duplicate.id));
  assert.deepEqual(await fs.readFile(movedSource), original);
  await savedPreset.selectOption({ label: 'Fixture Wide' });
  await panel.getByRole('button', { name: '適用', exact: true }).click();
  await panel.getByText(/編集欄に反映しました/).waitFor();
  assert.equal(await width.inputValue(), '26');
  console.log(JSON.stringify({ passed: true, packaged, previewWidth: 26, thumbnail: true, presets: 2, jsonRoundTrip: true, current: full.size, specified: specified.size, selected: selected.size, all: all.size, originalPreserved: true, watchedPathRelinked: true }));
} finally {
  await app.close();
}
