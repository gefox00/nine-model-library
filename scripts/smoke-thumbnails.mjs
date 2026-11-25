import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const releaseDirectory = process.argv.find(arg => arg.startsWith('--release-dir='))?.slice('--release-dir='.length) || 'release';
const executablePath = packaged ? path.resolve(root, releaseDirectory, 'win-unpacked', `${manifest.productName}.exe`)
  : path.join(root, 'node_modules/electron/dist/electron.exe');
const out = path.join(root, 'output', 'playwright');
await fs.mkdir(out, { recursive: true });
const testDir = await fs.mkdtemp(path.join(out, 'thumb-smoke-'));
const modelDir = path.join(testDir, 'models');
await fs.mkdir(modelDir);
const fixtureNames = ['cube-mm.stl', 'cube-mm.step', 'cube-mm.3mf', 'bambu-components.3mf'];
for (const name of fixtureNames) await fs.copyFile(path.join(root, 'tests', 'fixtures', name), path.join(modelDir, name));
await fs.writeFile(path.join(modelDir, 'bad.stl'), 'This is deliberately not an STL model.');
await fs.copyFile(path.join(modelDir, 'cube-mm.stl'), path.join(modelDir, 'missing.stl'));
const knownThumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
const env = { ...process.env, NINE_DATA_DIR: path.join(testDir, 'data'), NINE_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.VITE_DEV_SERVER_URL;
const findings = [];
const pageErrors = [];
let application;
let page;
let finalBatch;
let concurrency;
let succeeded = false;

async function launch() {
  application = await electron.launch({ executablePath, args: packaged ? [] : ['.'], cwd: root, env, timeout: 40000 });
  page = await application.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => typeof window.nine?.getThumbnailBatch === 'function');
  await page.getByRole('button', { name: 'サムネイル生成', exact: true }).waitFor();
}

async function waitForBatch(status, timeout = 180000) {
  await page.locator(`[data-testid="thumbnail-batch"][data-status="${status}"]`).waitFor({ timeout });
  const state = await page.evaluate(() => window.nine.getThumbnailBatch());
  assert.equal(state.status, status);
  return state;
}

const thumbnailUrl = item => `nine-thumb://library/${item.id}/${item.thumbnailRevision}`;

async function readThumbnail(url) {
  return application.evaluate(async ({ session }, resource) => {
    const response = await session.fromPartition('nine-library-ui').fetch(resource, { cache: 'no-store' });
    return { status: response.status, mime: response.headers.get('content-type'), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  }, url);
}

async function monitorWorkers() {
  await application.evaluate(({ BrowserWindow }) => {
    const monitor = { max: 0, samples: 0, samplesWithWorker: 0, ids: new Set(), timer: null };
    const sample = () => {
      const workers = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && /(?:\/|\\)thumbnail\.html(?:[?#]|$)/.test(win.webContents.getURL()));
      monitor.max = Math.max(monitor.max, workers.length);
      monitor.samples++;
      if (workers.length) monitor.samplesWithWorker++;
      workers.forEach(win => monitor.ids.add(win.id));
    };
    monitor.timer = setInterval(sample, 10);
    globalThis.__nineThumbnailSmokeMonitor = monitor;
    sample();
  });
}

async function stopMonitor() {
  return application.evaluate(() => {
    const monitor = globalThis.__nineThumbnailSmokeMonitor;
    clearInterval(monitor.timer);
    return { max: monitor.max, samples: monitor.samples, samplesWithWorker: monitor.samplesWithWorker, distinctWorkerWindows: monitor.ids.size };
  });
}

try {
  await launch();
  const imported = await page.evaluate(paths => window.nine.importPaths(paths), [...fixtureNames, 'bad.stl', 'missing.stl'].map(name => path.join(modelDir, name)));
  assert.equal(imported.items.length, 6);
  const existing = imported.items.find(item => item.name === 'bambu-components.3mf');
  await page.evaluate(({ id, dataUrl }) => window.nine.saveThumbnail(id, dataUrl), { id: existing.id, dataUrl: knownThumbnail });
  await fs.unlink(path.join(modelDir, 'missing.stl'));
  const refreshed = await page.evaluate(() => window.nine.rescan());
  assert.equal(refreshed.items.find(item => item.name === 'missing.stl').missing, true);
  assert.equal(await page.getByLabel('サムネイル生成対象').inputValue(), 'missing');

  await monitorWorkers();
  await page.getByRole('button', { name: 'サムネイル生成', exact: true }).click();
  const initial = await waitForBatch('completed');
  assert.deepEqual(
    { succeeded: initial.succeeded, failed: initial.failed, skipped: initial.skipped, processed: initial.processed, total: initial.total },
    { succeeded: 3, failed: 1, skipped: 2, processed: 6, total: 6 },
  );
  assert.equal(initial.failures.length, 1);
  assert.equal(initial.failures[0].name, 'bad.stl');
  assert(initial.failures[0].error.length > 0);
  const initialReuse = await stopMonitor();
  assert.equal(initialReuse.max, 1);
  assert.equal(initialReuse.distinctWorkerWindows, 1, 'A healthy batch should reuse one renderer even when one model fails');
  findings.push('One renderer generated three images and handled a malformed model in the same batch');
  findings.push('Default batch: 3 generated, 1 invalid STL failed, 2 skipped; processed 6/6');

  const generated = await page.evaluate(() => window.nine.getState());
  let existingImage = generated.items.find(item => item.id === existing.id);
  const originalUrl = thumbnailUrl(existingImage);
  const keptImage = await readThumbnail(originalUrl);
  assert.equal(keptImage.status, 200);
  assert.deepEqual(Buffer.from(keptImage.bytes), Buffer.from(knownThumbnail.split(',')[1], 'base64'));
  assert.equal(await page.evaluate(() => typeof window.nine.getThumbnail), 'undefined');
  assert(generated.items.every(item => !Object.hasOwn(item, 'thumbnail')));
  const imageChecks = [];
  for (const name of ['cube-mm.stl', 'cube-mm.step', 'cube-mm.3mf']) {
    const item = generated.items.find(candidate => candidate.name === name);
    const imageUrl = thumbnailUrl(item);
    const image = page.getByRole('button', { name: `モデル ${name}`, exact: true }).locator(`img[src="${imageUrl}"]`);
    await image.scrollIntoViewIfNeeded();
    assert.equal(await image.evaluate(async element => { await element.decode(); return element.naturalWidth; }), 480);
    const { status, mime, bytes } = await readThumbnail(imageUrl);
    assert(item.hasThumbnail && status === 200 && bytes.length > 0 && bytes.length <= 187500, `${name}: invalid binary thumbnail`);
    const check = await page.evaluate(async dataUrl => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let brightPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 80 && pixels[i + 1] > 90 && pixels[i + 2] > 90) brightPixels++;
      return { width: image.naturalWidth, height: image.naturalHeight, brightPixels };
    }, `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
    assert.deepEqual([check.width, check.height], [480, 360]);
    assert(check.brightPixels > 300, `${name}: model surface is not visible`);
    const format = mime.split('/')[1];
    await fs.writeFile(path.join(out, `thumb-${name.replaceAll('.', '-')}${packaged ? '-packaged' : ''}.${format === 'jpeg' ? 'jpg' : format}`), Buffer.from(bytes));
    imageChecks.push({ name, ...check, bytes: bytes.length });
  }
  await page.evaluate(({ id, dataUrl }) => window.nine.saveThumbnail(id, dataUrl), { id: existing.id, dataUrl: knownThumbnail });
  existingImage = (await page.evaluate(() => window.nine.getState())).items.find(item => item.id === existing.id);
  assert.notEqual(thumbnailUrl(existingImage), originalUrl);
  assert.equal((await readThumbnail(originalUrl)).status, 404, 'An obsolete revision should no longer be served');
  findings.push('Binary protocol served nonblank 480x360 images in the library and rejected an obsolete revision');
  await page.screenshot({ path: path.join(out, `thumbnails-done${packaged ? '-packaged' : ''}.png`) });
  await page.getByRole('button', { name: /失敗 1 件の詳細/ }).click();
  await page.getByText('bad.stl', { exact: true }).last().waitFor();
  await page.screenshot({ path: path.join(out, `thumbnails-error-details${packaged ? '-packaged' : ''}.png`) });
  findings.push('Failure details expose the invalid STL filename and explanation in the UI');

  await monitorWorkers();
  await page.getByLabel('サムネイル生成対象').selectOption('all');
  await page.getByRole('button', { name: 'サムネイル生成', exact: true }).click();
  await page.getByRole('button', { name: '生成を中止', exact: true }).click();
  const cancelled = await waitForBatch('cancelled', 30000);
  assert(cancelled.processed < cancelled.total, 'Cancellation should stop before finishing every item');
  findings.push(`Overwrite batch cancelled after ${cancelled.processed}/${cancelled.total} processed`);
  await page.screenshot({ path: path.join(out, `thumbnails-cancelled${packaged ? '-packaged' : ''}.png`) });

  await page.getByLabel('サムネイル生成対象').selectOption('missing');
  await page.getByRole('button', { name: 'サムネイル生成', exact: true }).click();
  finalBatch = await waitForBatch('completed');
  assert.equal(finalBatch.total, 6);
  assert.equal(finalBatch.processed, 6);
  assert.equal(finalBatch.failed, 1);
  assert.equal(finalBatch.skipped, 5);
  assert.equal(finalBatch.succeeded, 0);
  findings.push('Restarting missing-only generation after cancellation skipped all existing thumbnails and retried the invalid file');
  concurrency = await stopMonitor();
  assert.equal(concurrency.max, 1, 'At most one thumbnail renderer may be alive');
  assert(concurrency.distinctWorkerWindows <= 2, 'Only cancellation or batch boundaries may replace a renderer');
  findings.push(`10 ms main-process monitor observed ${concurrency.distinctWorkerWindows} separate worker windows, maximum concurrency ${concurrency.max}`);

  const beforeRestart = await page.evaluate(() => window.nine.getState());
  await application.close(); application = null;
  await launch();
  const restoredBatch = await page.evaluate(() => window.nine.getThumbnailBatch());
  const restoredLibrary = await page.evaluate(() => window.nine.getState());
  assert.equal(restoredBatch.id, finalBatch.id);
  assert.equal(restoredBatch.status, 'completed');
  assert.deepEqual(restoredBatch.failures, finalBatch.failures);
  assert.equal(restoredBatch.processed, finalBatch.processed);
  for (const item of beforeRestart.items) assert.equal(restoredLibrary.items.find(candidate => candidate.id === item.id)?.thumbnailRevision, item.thumbnailRevision);
  const restoredImage = await readThumbnail(thumbnailUrl(restoredLibrary.items.find(item => item.id === existing.id)));
  assert.equal(restoredImage.status, 200);
  assert.deepEqual(Buffer.from(restoredImage.bytes), Buffer.from(knownThumbnail.split(',')[1], 'base64'));
  findings.push('Saved thumbnails and last batch result survived a complete app restart');
  assert.deepEqual(pageErrors, []);
  succeeded = true;
  const report = { passed: true, packaged, findings, imageChecks, initialReuse, concurrency, initial, cancelled, finalBatch, pageErrors, testDir };
  await fs.writeFile(path.join(out, `thumbnails-smoke${packaged ? '-packaged' : ''}-result.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, `thumbnails-failure${packaged ? '-packaged' : ''}.png`) }).catch(e => console.error('Failure screenshot:', e));
  await fs.writeFile(path.join(out, `thumbnails-smoke${packaged ? '-packaged' : ''}-result.json`), JSON.stringify({ passed: false, packaged, error: error.stack || String(error), findings, finalBatch, concurrency, pageErrors, testDir }, null, 2));
  process.exitCode = 1;
} finally {
  if (application) await application.close();
  if (!succeeded) console.log(`Isolated test data retained at ${testDir}`);
}
