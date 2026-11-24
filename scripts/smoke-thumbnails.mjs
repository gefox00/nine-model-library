import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const releaseDirectory = process.argv.find(arg => arg.startsWith('--release-dir='))?.slice('--release-dir='.length) || 'release';
const executablePath = packaged ? path.resolve(root, releaseDirectory, 'win-unpacked/Nine Model Library.exe')
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
  findings.push('Default batch: 3 generated, 1 invalid STL failed, 2 skipped; processed 6/6');

  const generated = await page.evaluate(() => window.nine.getState());
  assert.equal(await page.evaluate(id => window.nine.getThumbnail(id), existing.id), knownThumbnail);
  assert(generated.items.every(item => !Object.hasOwn(item, 'thumbnail')));
  const imageChecks = [];
  for (const name of ['cube-mm.stl', 'cube-mm.step', 'cube-mm.3mf']) {
    const item = generated.items.find(candidate => candidate.name === name);
    const thumbnail = await page.evaluate(id => window.nine.getThumbnail(id), item.id);
    assert(item.hasThumbnail && thumbnail && thumbnail.length <= 250000, `${name}: thumbnail missing or too large`);
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
    }, thumbnail);
    assert.deepEqual([check.width, check.height], [480, 360]);
    assert(check.brightPixels > 300, `${name}: model surface is not visible`);
    const [, mime, content] = thumbnail.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    await fs.writeFile(path.join(out, `thumb-${name.replaceAll('.', '-')}${packaged ? '-packaged' : ''}.${mime === 'jpeg' ? 'jpg' : mime}`), Buffer.from(content, 'base64'));
    imageChecks.push({ name, ...check, dataUrlLength: thumbnail.length });
  }
  findings.push('STL, STEP/WASM via file://, and 3MF produced nonblank 480x360 images; existing Bambu thumbnail was preserved');
  await page.screenshot({ path: path.join(out, `thumbnails-done${packaged ? '-packaged' : ''}.png`) });
  await page.getByRole('button', { name: /失敗 1 件の詳細/ }).click();
  await page.getByText('bad.stl', { exact: true }).last().waitFor();
  await page.screenshot({ path: path.join(out, `thumbnails-error-details${packaged ? '-packaged' : ''}.png`) });
  findings.push('Failure details expose the invalid STL filename and explanation in the UI');

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
  assert(concurrency.distinctWorkerWindows >= 4, 'Each model should use a fresh renderer');
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
  assert.equal(await page.evaluate(id => window.nine.getThumbnail(id), existing.id), knownThumbnail);
  findings.push('Saved thumbnails and last batch result survived a complete app restart');
  assert.deepEqual(pageErrors, []);
  succeeded = true;
  const report = { passed: true, packaged, findings, imageChecks, concurrency, initial, cancelled, finalBatch, pageErrors, testDir };
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
