const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Library, assertModelSizeAllowed, idFor, normalize } = require('../electron/library.cjs');

const legacy = (settings = {}) => ({ schemaVersion: 1, items: [], folders: [], settings, excludedPaths: [] });

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-library-test-'));
  const models = path.join(root, 'models');
  await fs.mkdir(models);
  const library = await new Library(path.join(root, 'data'), options).init();
  t.after(async () => {
    await library.close();
    const resolvedRoot = path.resolve(root);
    assert.equal(path.dirname(resolvedRoot), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolvedRoot), /^nine-library-test-/);
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  });
  return { root, models, library };
}

async function eventually(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  assert.fail('Timed out waiting for the filesystem watcher');
}

test('imports deduplicate, metadata persists, deletion excludes auto-registration, explicit import restores', async t => {
  const { root, models, library } = await fixture(t, { watch: false });
  const file = path.join(models, '日本語モデル.STL');
  await fs.writeFile(file, 'solid test\nendsolid test');
  await library.addFolder(models);
  await library.importPaths([file, file]);
  assert.equal(library.getState().items.length, 1);
  const id = library.getState().items[0].id;
  await library.updateItem(id, { favorite: true, tags: [' jig ', 'jig', 'PLA'], notes: '部品 A', path: 'invalid' });
  assert.equal(library.item(id).path, file);
  const second = await new Library(path.join(root, 'data'), { watch: false }).init();
  assert.equal(second.item(id).favorite, true);
  assert.deepEqual(second.item(id).tags, ['jig', 'PLA']);
  assert.equal(second.item(id).notes, '部品 A');
  await second.close();
  await library.removeItem(id);
  await library.rescan();
  assert.equal(library.getState().items.length, 0);
  assert.equal(await fs.readFile(file, 'utf8'), 'solid test\nendsolid test');
  await library.importPaths([file]);
  assert.equal(library.getState().items.length, 1);
});

test('watcher handles nested add, write, delete and reappearance; removing folder stops registration', async t => {
  const { models, library } = await fixture(t, { stabilityThreshold: 200 });
  await library.addFolder(models);
  const nested = path.join(models, 'parts');
  await fs.mkdir(nested);
  const file = path.join(nested, 'test.stp');
  await fs.writeFile(file, 'first');
  await eventually(() => library.getState().items.length === 1);
  const id = library.getState().items[0].id;
  await library.updateItem(id, { favorite: true });
  await fs.writeFile(file, 'updated model');
  await eventually(() => library.item(id).size === 13);
  await fs.unlink(file);
  await eventually(() => library.item(id).missing);
  await fs.writeFile(file, 'restored');
  await eventually(() => !library.item(id).missing && library.item(id).size === 8);
  assert.equal(library.item(id).favorite, true);
  await library.removeFolder(library.getState().folders[0].id);
  await fs.writeFile(path.join(models, 'unwatched.stl'), 'new');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(library.getState().items.length, 1);
});

test('concurrent folder registration keeps both watches and shutdown drains writes', async t => {
  const { root, models, library } = await fixture(t, { stabilityThreshold: 100 });
  const second = path.join(root, 'more-models');
  await fs.mkdir(second);
  await Promise.all([library.addFolder(models), library.addFolder(second)]);
  const firstModel = path.join(models, 'first.stl');
  const secondModel = path.join(second, 'second.stl');
  await fs.writeFile(firstModel, 'first example');
  await fs.writeFile(secondModel, 'second example');
  await eventually(() => library.getState().items.length === 2);
  const pendingWrite = library.updateItem(idFor(secondModel), { notes: 'finishes before close' });
  const closing = library.close();
  assert.equal(library.close(), closing);
  await Promise.all([pendingWrite, closing]);
  await assert.rejects(() => library.updateItem(idFor(firstModel), { favorite: true }), /終了処理中/);
  const reopened = await new Library(path.join(root, 'data'), { watch: false }).init();
  try { assert.equal(reopened.item(idFor(secondModel)).notes, 'finishes before close'); }
  finally { await reopened.close(); }
});

test('background startup exposes stored state before a sluggish watcher becomes ready', { timeout: 4000 }, async t => {
  const { root, models, library } = await fixture(t, { watch: false });
  const model = path.join(models, 'saved-model.stl');
  await fs.writeFile(model, 'example');
  await library.importPaths([model]);
  await library.close();
  const reopened = new Library(path.join(root, 'data'), { watch: false });
  let release;
  const delayedWatcher = new Promise(resolve => { release = resolve; });
  t.mock.method(reopened, 'startWatchers', () => delayedWatcher);
  try {
    await reopened.init({ backgroundScan: true });
    assert.equal(reopened.getState().items[0].id, idFor(model));
    assert.equal(reopened.getState().status.scanning, true);
    await fs.unlink(model);
    release();
    await reopened.initialScan;
    assert.equal(reopened.item(idFor(model)).missing, true);
    assert.equal(reopened.getState().status.scanning, false);
  } finally {
    release();
    await reopened.close();
  }
});

test('rescan reconciles missed deletion and modification without losing metadata', async t => {
  const { models, library } = await fixture(t, { watch: false });
  const file = path.join(models, 'part.3mf');
  await fs.writeFile(file, 'model');
  await library.importPaths([file]);
  const id = library.getState().items[0].id;
  await library.updateItem(id, { notes: 'keep' });
  await library.saveThumbnail(id, 'data:image/png;base64,YWJj');
  assert.equal(library.item(id).hasThumbnail, true);
  assert.equal(library.readThumbnail(id), 'data:image/png;base64,YWJj');
  await fs.writeFile(file, 'changed');
  await library.rescan();
  assert.equal(library.item(id).notes, 'keep');
  assert.equal(library.item(id).hasThumbnail, false);
  assert.equal(library.readThumbnail(id), null);
  assert.equal((await library.readModel(id)).length, 7);
  await fs.unlink(file);
  await library.rescan();
  assert.equal(library.item(id).missing, true);
  await assert.rejects(() => library.readModel(id), /見つからない/);
});

test('corrupt legacy library is preserved and reported instead of overwritten', async t => {
  const { root } = await fixture(t, { watch: false });
  const dataDir = path.join(root, 'legacy');
  await fs.mkdir(dataDir);
  const file = path.join(dataDir, 'library.json');
  await fs.writeFile(file, '{ corrupt');
  await assert.rejects(() => new Library(dataDir, { watch: false }).init(), /元データは保持/);
  assert.equal(await fs.readFile(file, 'utf8'), '{ corrupt');
  await fs.writeFile(file, JSON.stringify(legacy({ futureSetting: 'successful retry' })));
  const reopened = await new Library(dataDir, { watch: false }).init();
  try { assert.equal(reopened.getState().settings.futureSetting, 'successful retry'); }
  finally { await reopened.close(); }
});

test('corrupt SQLite does not silently fall back to an older JSON snapshot', async t => {
  const { root } = await fixture(t, { watch: false });
  const dataDir = path.join(root, 'corrupt');
  await fs.mkdir(dataDir);
  const sqlite = path.join(dataDir, 'library.sqlite3');
  const fallback = path.join(dataDir, 'library.json');
  await fs.writeFile(sqlite, 'a damaged SQLite library');
  await fs.writeFile(fallback, JSON.stringify(legacy()));
  await assert.rejects(() => new Library(dataDir, { watch: false }).init(), /元データは保持/);
  assert.equal(await fs.readFile(sqlite, 'utf8'), 'a damaged SQLite library');
  assert.deepEqual(JSON.parse(await fs.readFile(fallback, 'utf8')), legacy());
});

test('JSON migration imports SQLite metadata and thumbnail bytes once and retains the JSON backup', async t => {
  const { root, models } = await fixture(t, { watch: false });
  const dataDir = path.join(root, 'migration');
  await fs.mkdir(dataDir);
  const modelPath = path.join(models, 'model.stl');
  const excludedPath = path.join(models, 'skip.stl');
  const legacyFile = path.join(dataDir, 'library.json');
  const image = 'data:image/webp;base64,YWJj';
  const seed = legacy({ memoryBudgetMiB: 4096, lightweightPreview: false, futureSetting: { preserved: true } });
  await fs.writeFile(modelPath, 'kept');
  await fs.writeFile(excludedPath, 'excluded');
  const stat = await fs.stat(modelPath);
  seed.items.push({ id: idFor(modelPath), name: 'model.stl', path: modelPath, format: 'stl', size: stat.size,
    modifiedAt: stat.mtime.toISOString(), addedAt: stat.ctime.toISOString(), missing: false, favorite: true,
    tags: ['reference'], notes: 'preserve', thumbnail: image, futureAttribute: 'separate metadata' });
  seed.folders.push({ id: idFor(models), path: models });
  seed.excludedPaths.push(normalize(excludedPath));
  const original = JSON.stringify(seed);
  await fs.writeFile(legacyFile, original);
  const library = await new Library(dataDir, { watch: false }).init();
  const id = seed.items[0].id;
  try {
    const state = library.getState();
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].favorite, true);
    assert.equal(state.items[0].notes, 'preserve');
    assert.deepEqual(state.items[0].tags, ['reference']);
    assert.equal(state.items[0].futureAttribute, 'separate metadata');
    assert.equal(state.items[0].hasThumbnail, true);
    assert.equal(state.items[0].thumbnail, undefined);
    assert.deepEqual(state.folders, seed.folders);
    assert.deepEqual(library.data.excludedPaths, seed.excludedPaths);
    assert.equal(state.settings.memoryBudgetMiB, 4096);
    assert.equal(state.settings.lightweightPreview, false);
    assert.deepEqual(state.settings.futureSetting, { preserved: true });
    assert.equal(library.readThumbnail(id, state.items[0].thumbnailRevision), image);
    assert.equal(library.readThumbnail(id, 'stale'), null);
    assert.deepEqual([...library.database.prepare('SELECT bytes FROM model_thumbnails WHERE model_id = ?').get(id).bytes], [97, 98, 99]);
    await library.updateItem(id, { notes: 'SQLite current value' });
  } finally { await library.close(); }
  assert.equal(await fs.readFile(legacyFile, 'utf8'), original);
  const reopened = await new Library(dataDir, { watch: false }).init();
  try {
    assert.equal(reopened.item(id).notes, 'SQLite current value');
    assert.equal(reopened.readThumbnail(id), image);
  } finally { await reopened.close(); }
});

test('memory settings persist across restart and preserve Bambu path and model metadata', async t => {
  const { root, models, library } = await fixture(t, { watch: false });
  assert.equal(library.getState().settings.memoryBudgetMiB, 2048);
  assert.ok(library.getState().system.totalMemoryMiB > 0);
  assert.ok(Number.isInteger(library.getState().system.availableMemoryMiB));
  const file = path.join(models, 'part.stl');
  const executable = path.join(root, 'bambu-studio.exe');
  await fs.writeFile(file, 'solid part\nendsolid part');
  await fs.writeFile(executable, 'not executed by this test');
  await library.importPaths([file]);
  const id = library.getState().items[0].id;
  await library.setBambu(executable);
  await library.updateItem(id, { favorite: true, tags: ['fit-test'], notes: 'keep this note' });
  await library.updateSettings({ memoryBudgetMiB: 4096 });
  await library.close();
  const reopened = await new Library(path.join(root, 'data'), { watch: false }).init();
  try {
    assert.equal(reopened.getState().settings.memoryBudgetMiB, 4096);
    assert.equal(reopened.getState().settings.bambuPath, executable);
    assert.equal(reopened.item(id).favorite, true);
    assert.deepEqual(reopened.item(id).tags, ['fit-test']);
    assert.equal(reopened.item(id).notes, 'keep this note');
  } finally { await reopened.close(); }
});

test('legacy and invalid saved memory settings migrate to the default without losing other settings', async t => {
  const { root } = await fixture(t, { watch: false });
  const fixtureBambuPath = path.join(root, 'apps', 'bambu-studio.exe');
  const values = [undefined, null, 128, 32769, 1024.5, '4096'];
  for (const [index, value] of values.entries()) {
    const dataDir = path.join(root, `legacy-${index}`);
    await fs.mkdir(dataDir);
    const file = path.join(dataDir, 'library.json');
    const text = JSON.stringify(legacy({ bambuPath: fixtureBambuPath, futureSetting: 'preserve', memoryBudgetMiB: value, lightweightPreview: 'invalid' }));
    await fs.writeFile(file, text);
    const reopened = await new Library(dataDir, { watch: false }).init();
    try {
      assert.equal(reopened.getState().settings.memoryBudgetMiB, 2048);
      assert.equal(reopened.getState().settings.lightweightPreview, true);
      assert.equal(reopened.getState().settings.bambuPath, fixtureBambuPath);
      assert.equal(reopened.getState().settings.futureSetting, 'preserve');
    } finally { await reopened.close(); }
    assert.equal(await fs.readFile(file, 'utf8'), text);
  }
});

test('invalid memory updates cannot change persisted settings or inject executable paths', async t => {
  const { root, library } = await fixture(t, { watch: false });
  await library.updateSettings({ memoryBudgetMiB: 1024 });
  const before = library.database.prepare('SELECT * FROM settings ORDER BY key').all();
  for (const value of [undefined, null, 0, 511, 32769, 1024.5, '1024', NaN, Infinity]) {
    await assert.rejects(() => library.updateSettings({ memoryBudgetMiB: value }));
  }
  await assert.rejects(() => library.updateSettings({ memoryBudgetMiB: 4096, bambuPath: path.join(root, 'bad.exe') }));
  await assert.rejects(() => library.updateSettings({ memoryBudgetMiB: 4096, lightweightPreview: 0 }));
  assert.equal(library.getState().settings.memoryBudgetMiB, 1024);
  assert.equal(library.getState().settings.lightweightPreview, true);
  assert.deepEqual(library.database.prepare('SELECT * FROM settings ORDER BY key').all(), before);
});

test('a failed write rolls back row deletion, its thumbnail and the in-memory state together', async t => {
  const { models, library } = await fixture(t, { watch: false });
  const model = path.join(models, 'part.stl');
  await fs.writeFile(model, 'example part');
  await library.importPaths([model]);
  const id = idFor(model);
  const image = 'data:image/png;base64,YWJj';
  await library.saveThumbnail(id, image);
  library.database.exec(`CREATE TEMP TRIGGER reject_exclusion BEFORE INSERT ON excluded_paths
    BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
  await assert.rejects(() => library.removeItem(id), /synthetic write failure/);
  assert.equal(library.item(id).hasThumbnail, true);
  assert.equal(library.readThumbnail(id), image);
  assert.equal(library.database.prepare('SELECT count(*) AS count FROM models').get().count, 1);
  assert.equal(library.database.prepare('SELECT count(*) AS count FROM excluded_paths').get().count, 0);
  library.database.exec('DROP TRIGGER reject_exclusion');
  await library.removeItem(id);
  assert.equal(library.database.prepare('SELECT count(*) AS count FROM model_thumbnails').get().count, 0);
  assert.equal(library.readThumbnail(id), null);
});

test('file preflight follows the selected memory budget and hard ceiling before reading', async t => {
  const { models, library } = await fixture(t, { watch: false });
  const file = path.join(models, 'large.stl');
  const handle = await fs.open(file, 'w');
  try { await handle.truncate(65 * 1024 * 1024); } finally { await handle.close(); }
  await library.importPaths([file]);
  const id = library.getState().items[0].id;
  await library.updateSettings({ memoryBudgetMiB: 512 });
  await assert.rejects(() => library.readModel(id), /64 MiB/);
  assert.doesNotThrow(() => assertModelSizeAllowed(65 * 1024 * 1024, 1024));
  assert.throws(() => assertModelSizeAllowed(1024 * 1024 * 1024 + 1, 32768), /1024 MiB/);
  await fs.writeFile(file, 'small model');
  assert.equal(Buffer.from(await library.readModel(id, { memoryBudgetMiB: 1024 })).toString(), 'small model');
});

test('a file growing during a read is rejected against the same limit and its handle closes', async t => {
  const { models, library } = await fixture(t, { watch: false });
  const file = path.join(models, 'changing.stl');
  await fs.writeFile(file, 'small');
  await library.importPaths([file]);
  const id = library.getState().items[0].id;
  let statCalls = 0;
  let closed = false;
  const originalOpen = fs.open;
  const mock = t.mock.method(fs, 'open', async (requested, ...args) => {
    if (requested !== file) return originalOpen(requested, ...args);
    return {
      stat: async () => ({ isFile: () => true, size: ++statCalls === 1 ? 5 : 70 * 1024 * 1024, mtimeMs: statCalls }),
      read: async bytes => { bytes.set(Buffer.from('small')); return { bytesRead: 5 }; },
      close: async () => { closed = true; },
    };
  });
  try { await assert.rejects(() => library.readModel(id, { memoryBudgetMiB: 512 }), /64 MiB/); }
  finally { mock.mock.restore(); }
  assert.equal(closed, true);
});

test('copy preserves original bytes and refuses existing targets or the original path', async t => {
  const { root, models, library } = await fixture(t, { watch: false });
  const file = path.join(models, '日本語 project.3mf');
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255, 123, 45]);
  await fs.writeFile(file, bytes);
  await library.importPaths([file]);
  const id = library.getState().items[0].id;
  const destination = path.join(root, 'copies');
  await fs.mkdir(destination);
  const copied = await library.copyModel(id, destination);
  assert.deepEqual(copied, { copied: true, path: path.join(destination, path.basename(file)) });
  assert.deepEqual(await fs.readFile(copied.path), bytes);
  assert.deepEqual(await fs.readFile(file), bytes);
  await fs.writeFile(copied.path, 'existing destination must survive');
  await assert.rejects(() => library.copyModel(id, destination), /上書きはしていません/);
  assert.equal(await fs.readFile(copied.path, 'utf8'), 'existing destination must survive');
  await assert.rejects(() => library.copyModel(id, models), /上書きはしていません/);
  assert.deepEqual(await fs.readFile(file), bytes);
  const nonexistent = path.join(root, 'does-not-exist');
  await assert.rejects(() => library.copyModel(id, nonexistent), /コピー先フォルダ/);
  await assert.rejects(() => fs.stat(nonexistent), { code: 'ENOENT' });
});

test('copy rejects a source that changed while the destination chooser was open', async t => {
  const { root, models, library } = await fixture(t, { watch: false });
  const file = path.join(models, 'part.stl');
  await fs.writeFile(file, 'old bytes');
  await library.importPaths([file]);
  const id = library.getState().items[0].id;
  const source = await library.captureFileSource(id);
  const destination = path.join(root, 'copies');
  await fs.mkdir(destination);
  await fs.writeFile(file, 'new different bytes');
  await assert.rejects(() => library.copyModel(id, destination, source), /更新された/);
  assert.deepEqual(await fs.readdir(destination), []);
});

test('trash success removes the entry without exclusion, and a restored file registers again', async t => {
  const { root, models, library } = await fixture(t, { stabilityThreshold: 200 });
  const file = path.join(models, 'part.stl');
  await fs.writeFile(file, 'original model');
  await library.addFolder(models);
  const id = library.getState().items[0].id;
  const source = await library.captureFileSource(id);
  const fakeTrash = path.join(root, 'recycle-test-only.stl');
  let calls = 0;
  const result = await library.trashModel(id, source, async requested => {
    calls += 1;
    assert.equal(requested, file);
    await fs.rename(requested, fakeTrash);
  });
  assert.equal(calls, 1);
  assert.equal(result.items.length, 0);
  assert.equal(library.data.excludedPaths.length, 0);
  assert.equal(library.database.prepare('SELECT count(*) AS count FROM models').get().count, 0);
  await fs.rename(fakeTrash, file);
  await eventually(() => library.getState().items.length === 1 && !library.getState().items[0].missing);
  assert.equal(library.getState().items[0].id, id);
  assert.equal(await fs.readFile(file, 'utf8'), 'original model');
});

test('trash failure preserves the original file and library entry without permanent-delete fallback', async t => {
  const { models, library } = await fixture(t, { watch: false });
  const file = path.join(models, 'part.stl');
  await fs.writeFile(file, 'keep this file');
  await library.importPaths([file]);
  const id = library.getState().items[0].id;
  await library.updateItem(id, { notes: 'keep this entry' });
  const source = await library.captureFileSource(id);
  await assert.rejects(() => library.trashModel(id, source, async () => { throw new Error('trash unavailable'); }), /ゴミ箱へ移動できません/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep this file');
  assert.equal(library.item(id).notes, 'keep this entry');
  assert.equal(library.data.excludedPaths.length, 0);
});

test('trash rejects modified or replaced files and re-registered entries after confirmation snapshot', async t => {
  const { models, library } = await fixture(t, { watch: false });
  const file = path.join(models, 'part.stl');
  await fs.writeFile(file, 'first');
  await library.importPaths([file]);
  const id = library.getState().items[0].id;
  let source = await library.captureFileSource(id);
  let calls = 0;
  const forbiddenTrash = async () => { calls += 1; };
  await fs.writeFile(file, 'different length');
  await assert.rejects(() => library.trashModel(id, source, forbiddenTrash), /更新された/);
  await library.rescan();
  source = await library.captureFileSource(id);
  const stat = await fs.stat(file);
  await fs.rename(file, path.join(models, 'old.stl'));
  await fs.writeFile(file, 'different length');
  await fs.utimes(file, stat.atime, stat.mtime);
  await assert.rejects(() => library.trashModel(id, source, forbiddenTrash), /置き換わった|更新された/);
  await library.rescan();
  source = await library.captureFileSource(id);
  await library.removeItem(id);
  await new Promise(resolve => setTimeout(resolve, 5));
  await library.importPaths([file]);
  await assert.rejects(() => library.trashModel(id, source, forbiddenTrash), /更新された/);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(file, 'utf8'), 'different length');
});
