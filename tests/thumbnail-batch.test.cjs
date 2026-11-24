const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ThumbnailBatch } = require('../electron/thumbnail-batch.cjs');
const { Library } = require('../electron/library.cjs');

const image = 'data:image/png;base64,YWJj';
const item = (id, extra = {}) => ({ id, name: `${id}.stl`, path: path.join('models', `${id}.stl`), format: 'stl', size: 42,
  modifiedAt: '2026-01-01T00:00:00.000Z', missing: false, ...extra });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('renders sequentially and waits for each thumbnail save before starting the next model', async () => {
  const events = [];
  let active = 0;
  let maximum = 0;
  const saveGate = deferred();
  const saveEntered = deferred();
  const reports = [];
  const batch = new ThumbnailBatch({
    generate: async source => {
      active += 1; maximum = Math.max(maximum, active); events.push(`generate:${source.id}`);
      await delay(5); active -= 1;
      return { dataUrl: image };
    },
    saveThumbnail: async source => {
      events.push(`saving:${source.id}`);
      if (source.id === 'one') { saveEntered.resolve(); await saveGate.promise; }
      events.push(`saved:${source.id}`);
    },
    persistReport: async report => { await delay(1); reports.push(report); },
  });
  batch.start({ items: [item('one'), item('two')], memoryBudgetMiB: 4096 });
  await saveEntered.promise;
  assert.deepEqual(events, ['generate:one', 'saving:one']);
  assert.equal(batch.getState().processed, 0);
  saveGate.resolve();
  const result = await batch.waitForIdle();
  assert.deepEqual(events, ['generate:one', 'saving:one', 'saved:one', 'generate:two', 'saving:two', 'saved:two']);
  assert.equal(maximum, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.processed, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(reports.at(-1).status, 'completed');
  assert.equal(JSON.stringify(reports).includes('data:image'), false);
  assert(!reports.some(report => Object.hasOwn(report.current ?? {}, 'path')));
});

test('all-library snapshot skips existing thumbnails and missing files, then continues after failure', async () => {
  const generated = [];
  const saved = [];
  const sources = [item('cached', { thumbnail: image }), item('missing', { missing: true }), item('bad'), item('good')];
  const batch = new ThumbnailBatch({
    generate: async (source, options) => {
      generated.push(source.id);
      assert.equal(options.memoryBudgetMiB, 2048);
      if (source.id === 'bad') throw new Error('broken geometry');
      assert.equal(source.size, 42);
      return { dataUrl: image };
    },
    saveThumbnail: async source => saved.push(source.id),
  });
  const initial = batch.start({ items: sources, memoryBudgetMiB: 2048 });
  sources[3].size = 999; sources.push(item('added-later'));
  assert.equal(initial.total, 4);
  assert.equal(initial.skipped, 2);
  assert.equal(initial.processed, 2);
  const result = await batch.waitForIdle();
  assert.deepEqual(generated, ['bad', 'good']);
  assert.deepEqual(saved, ['good']);
  assert.equal(result.total, 4);
  assert.equal(result.processed, 4);
  assert.equal(result.failed, 1);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.failures, [{ id: 'bad', name: 'bad.stl', error: 'broken geometry' }]);
});

test('overwrite regenerates cached images but never reads missing files', async () => {
  const generated = [];
  const batch = new ThumbnailBatch({ generate: async source => { generated.push(source.id); return { dataUrl: image }; }, saveThumbnail: async () => {} });
  batch.start({ items: [item('cached', { thumbnail: image }), item('missing', { missing: true })], memoryBudgetMiB: 512, overwrite: true });
  const result = await batch.waitForIdle();
  assert.deepEqual(generated, ['cached']);
  assert.equal(result.skipped, 1);
  assert.equal(result.processed, 2);
});

test('cancellation immediately aborts the active renderer and never starts the next file', async () => {
  const entered = deferred();
  let aborted = false;
  const generated = [];
  let saves = 0;
  const batch = new ThumbnailBatch({
    generate: (source, { signal }) => {
      generated.push(source.id);
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      entered.resolve();
      return new Promise(() => {});
    },
    saveThumbnail: async () => { saves += 1; },
  });
  batch.start({ items: [item('one'), item('two')], memoryBudgetMiB: 1024 });
  await entered.promise;
  assert.equal(batch.stop().status, 'stopping');
  assert.equal(aborted, true);
  const result = await batch.waitForIdle();
  assert.equal(result.status, 'cancelled');
  assert.equal(result.failed, 0);
  assert.equal(result.processed, 0);
  assert.equal(result.current, null);
  assert.equal(saves, 0);
  assert.deepEqual(generated, ['one']);
});

test('a timeout aborts one renderer, records the error, and continues the queue', async () => {
  const generated = [];
  let timedOut = false;
  const batch = new ThumbnailBatch({
    timeoutMs: 25,
    generate: (source, { signal }) => {
      generated.push(source.id);
      if (source.id === 'hung') {
        signal.addEventListener('abort', () => { timedOut = signal.reason.name === 'TimeoutError'; }, { once: true });
        return new Promise(() => {});
      }
      return Promise.resolve({ dataUrl: image });
    },
    saveThumbnail: async () => {},
  });
  batch.start({ items: [item('hung'), item('good')], memoryBudgetMiB: 2048 });
  const result = await batch.waitForIdle();
  assert.equal(timedOut, true);
  assert.deepEqual(generated, ['hung', 'good']);
  assert.equal(result.status, 'completed');
  assert.equal(result.failed, 1);
  assert.equal(result.succeeded, 1);
  assert.match(result.failures[0].error, /秒を超え/);
});

test('cancelling during an in-flight save waits for it and does not open another renderer', async () => {
  const saveEntered = deferred();
  const saveGate = deferred();
  const generated = [];
  const batch = new ThumbnailBatch({
    generate: async source => { generated.push(source.id); return { dataUrl: image }; },
    saveThumbnail: async () => { saveEntered.resolve(); await saveGate.promise; },
  });
  batch.start({ items: [item('one'), item('two')], memoryBudgetMiB: 2048 });
  await saveEntered.promise;
  batch.stop();
  assert.equal(batch.getState().status, 'stopping');
  saveGate.resolve();
  const result = await batch.waitForIdle();
  assert.deepEqual(generated, ['one']);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.succeeded, 1);
  assert.equal(result.processed, 1);
});

test('a second start is rejected while running or stopping without replacing the active job', async () => {
  const gate = deferred();
  const batch = new ThumbnailBatch({ generate: async () => { await gate.promise; return { dataUrl: image }; }, saveThumbnail: async () => {} });
  const initial = batch.start({ items: [item('one')], memoryBudgetMiB: 2048 });
  assert.throws(() => batch.start({ items: [item('two')], memoryBudgetMiB: 2048 }), /実行中/);
  batch.stop();
  assert.throws(() => batch.start({ items: [item('two')], memoryBudgetMiB: 2048 }), /実行中/);
  gate.resolve();
  const result = await batch.waitForIdle();
  assert.equal(result.id, initial.id);
  assert.equal(result.status, 'cancelled');
});

test('restoring an interrupted report marks it cancelled and excludes untrusted image payloads', async () => {
  const reports = [];
  const batch = new ThumbnailBatch({ generate: async () => {}, saveThumbnail: async () => {}, persistReport: async report => reports.push(report) });
  const result = await batch.restore({ id: 'old-job', status: 'running', total: 5, processed: 2, succeeded: 1, failed: 1,
    skipped: 0, memoryBudgetMiB: 4096, startedAt: '2026-01-01T00:00:00.000Z', current: item('three'), dataUrl: image,
    failures: [{ id: 'bad', name: 'bad.stl', error: 'failed', dataUrl: image }] });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.processed, 2);
  assert.equal(result.memoryBudgetMiB, 4096);
  assert.equal(result.current, null);
  assert.ok(result.finishedAt);
  assert.equal(JSON.stringify(reports).includes('data:image'), false);
});

test('thumbnail save rejects changed or removed source files and registration changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-thumb-test-'));
  const models = path.join(root, 'models');
  await fs.mkdir(models);
  const library = await new Library(path.join(root, 'data'), { watch: false }).init();
  t.after(async () => {
    await library.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^nine-thumb-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const file = path.join(models, 'source.stl');
  await fs.writeFile(file, 'original');
  await library.importPaths([file]);
  let source = library.getState().items[0];
  await library.saveThumbnail(source.id, image, source);
  assert.equal(library.readThumbnail(source.id), image);
  await fs.writeFile(file, 'changed even before watcher notification');
  await assert.rejects(() => library.saveThumbnail(source.id, image, source), /更新された/);
  await library.rescan();
  assert.equal(library.readThumbnail(source.id), null);
  await assert.rejects(() => library.saveThumbnail(source.id, image, source), /更新された/);
  source = library.getState().items[0];
  await fs.unlink(file);
  await assert.rejects(() => library.saveThumbnail(source.id, image, source), /見つからない/);
  await library.removeItem(source.id);
  await assert.rejects(() => library.saveThumbnail(source.id, image, source), /ライブラリにファイルが見つかりません/);
});

test('a source-staleness save failure is recorded and later files still complete', async () => {
  const saved = [];
  const batch = new ThumbnailBatch({
    generate: async () => ({ dataUrl: image }),
    saveThumbnail: async source => {
      if (source.id === 'stale') throw new Error('生成中に元ファイルが更新された');
      saved.push(source.id);
    },
  });
  batch.start({ items: [item('stale'), item('good')], memoryBudgetMiB: 2048 });
  const result = await batch.waitForIdle();
  assert.deepEqual(saved, ['good']);
  assert.equal(result.failed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.processed, 2);
});

test('single scope replaces only the selected cached thumbnail through the normal save path', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-thumb-single-'));
  const library = await new Library(path.join(root, 'data'), { watch: false }).init();
  t.after(async () => {
    await library.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^nine-thumb-single-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const paths = ['selected.stl', 'untouched.stl'].map(name => path.join(root, name));
  for (const file of paths) await fs.writeFile(file, 'fixture');
  await library.importPaths(paths);
  const [selected, untouched] = library.getState().items;
  for (const source of [selected, untouched]) await library.saveThumbnail(source.id, image, source);
  const replacement = 'data:image/png;base64,bmV3';
  const generated = [];
  const saved = [];
  const reports = [];
  const batch = new ThumbnailBatch({
    generate: async source => { generated.push(source.id); return { dataUrl: replacement }; },
    saveThumbnail: async (source, result, options) => {
      saved.push(source.id);
      return library.saveThumbnail(source.id, result.dataUrl, source, options);
    },
    persistReport: async report => reports.push(report),
  });
  batch.start({ items: [library.item(selected.id)], memoryBudgetMiB: 2048, overwrite: true, scope: 'single' });
  const result = await batch.waitForIdle();
  assert.deepEqual(generated, [selected.id]);
  assert.deepEqual(saved, [selected.id]);
  assert.equal(library.readThumbnail(selected.id), replacement);
  assert.equal(library.readThumbnail(untouched.id), image);
  assert.equal(result.scope, 'single');
  assert.equal(result.status, 'completed');
  assert.equal(result.total, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.skipped, 0);
  assert.equal(reports.at(-1).scope, 'single');
  const restored = new ThumbnailBatch({ generate: async () => {}, saveThumbnail: async () => {} });
  assert.equal((await restored.restore(reports.at(-1))).scope, 'single');
});

test('single scope validates its target and never silently skips a requested cached image', async () => {
  let generated = 0;
  const batch = new ThumbnailBatch({ generate: async () => { generated++; return { dataUrl: image }; }, saveThumbnail: async () => {} });
  assert.throws(() => batch.start({ items: [], memoryBudgetMiB: 2048, scope: 'single' }), /1件指定/);
  assert.throws(() => batch.start({ items: [item('one'), item('two')], memoryBudgetMiB: 2048, scope: 'single' }), /1件指定/);
  assert.throws(() => batch.start({ items: [null], memoryBudgetMiB: 2048, scope: 'single' }), /1件指定/);
  assert.throws(() => batch.start({ items: [item('missing', { missing: true })], memoryBudgetMiB: 2048, scope: 'single' }), /元ファイルが見つからない/);
  assert.throws(() => batch.start({ items: [item('one')], memoryBudgetMiB: 2048, scope: 'unknown' }), /指定が不正/);
  assert.equal(batch.getState().status, 'idle');
  batch.start({ items: [item('cached', { thumbnail: image })], memoryBudgetMiB: 2048, scope: 'single' });
  const result = await batch.waitForIdle();
  assert.equal(generated, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.skipped, 0);
});

test('single and bulk thumbnail requests share one exclusion gate', async () => {
  const gate = deferred();
  const batch = new ThumbnailBatch({ generate: async () => { await gate.promise; return { dataUrl: image }; }, saveThumbnail: async () => {} });
  const single = batch.start({ items: [item('one')], memoryBudgetMiB: 2048, scope: 'single' });
  assert.throws(() => batch.start({ items: [item('two')], memoryBudgetMiB: 2048 }), /実行中/);
  batch.stop();
  assert.throws(() => batch.start({ items: [item('two')], memoryBudgetMiB: 2048, scope: 'single' }), /実行中/);
  gate.resolve();
  assert.equal((await batch.waitForIdle()).id, single.id);
  const bulk = batch.start({ items: [item('one')], memoryBudgetMiB: 2048 });
  assert.throws(() => batch.start({ items: [item('two')], memoryBudgetMiB: 2048, scope: 'single' }), /実行中/);
  assert.equal((await batch.waitForIdle()).id, bulk.id);
  assert.equal(batch.getState().scope, 'all');
});

test('restores single-job scope and treats older reports as all-library jobs', async () => {
  const batch = new ThumbnailBatch({ generate: async () => {}, saveThumbnail: async () => {} });
  const single = await batch.restore({ id: 'single-job', status: 'running', scope: 'single', total: 1, processed: 0 });
  assert.equal(single.scope, 'single');
  assert.equal(single.status, 'cancelled');
  assert.equal((await batch.restore({ id: 'old-job', status: 'completed' })).scope, 'all');
});
