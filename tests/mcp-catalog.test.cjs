const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LibraryStore } = require('../electron/library-store.cjs');
const { ScadPresets } = require('../electron/scad-presets.cjs');
const { McpCatalog, McpCatalogError, MAX_PAGE_SIZE, MAX_QUERY_LENGTH, MAX_OFFSET } = require('../electron/mcp-catalog.cjs');

const scadId = 'a'.repeat(24);
const legacyStepId = 'b'.repeat(24);
const stlId = 'c'.repeat(24);
const absentId = 'd'.repeat(24);
const presetId = 'f'.repeat(8) + '-0000-4000-8000-000000000000';
const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-mcp-catalog-'));
  const databasePath = path.join(directory, 'library.sqlite3');
  const models = [
    { id: scadId, name: 'Crank.scad', format: 'scad', favorite: true, notes: 'fixture note', tags: ['Cafe\u0301', '折り畳み'] },
    { id: legacyStepId, name: 'Plate_100%.stp', format: 'stp', tags: ['flat'], missing: true },
    { id: stlId, name: 'Plate-ordinary.stl', format: 'stl' },
  ].map(model => ({ size: 123, addedAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z',
    path: path.join(directory, 'models', model.name), ...model }));
  const store = await LibraryStore.open(directory, async () => ({ items: models, folders: [],
    settings: { openscadPath: path.join(directory, 'private-executable') }, excludedPaths: [] }));
  t.after(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, databasePath, store, models, catalog: new McpCatalog(databasePath) };
}

test('search returns bounded pages of metadata and matches literal search across names and tags', async t => {
  const { catalog } = await fixture(t);
  const first = catalog.searchModels({ limit: 1 });
  assert.deepEqual(first.models.map(model => model.id), [scadId]);
  assert.equal(first.nextOffset, 1);
  const second = catalog.searchModels({ offset: first.nextOffset, limit: 2 });
  assert.deepEqual(second.models.map(model => model.id), [legacyStepId, stlId]);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(catalog.searchModels({ offset: 3 }), { models: [], nextOffset: null });
  for (const query of [' crANK ', 'CAFÉ', '折り畳み']) {
    assert.deepEqual(catalog.searchModels({ query }).models.map(model => model.id), [scadId]);
  }
  assert.deepEqual(catalog.searchModels({ query: '_100%' }).models.map(model => model.id), [legacyStepId]);
  assert.deepEqual(catalog.searchModels({ query: "strange'quote" }).models, []);
  const step = catalog.searchModels({ format: 'step', missing: true }).models;
  assert.deepEqual(step.map(model => [model.id, model.format]), [[legacyStepId, 'step']]);
  assert.deepEqual(catalog.searchModels({ format: 'stp' }).models, step);
  assert.deepEqual(catalog.searchModels({ missing: false, favorite: false }).models.map(model => model.id), [stlId]);
  assert.deepEqual(catalog.searchModels({ favorite: true }).models.map(model => model.id), [scadId]);
});

test('model metadata never returns paths, notes or settings unless detail flags explicitly permit them', async t => {
  const { catalog, directory, models } = await fixture(t);
  const result = catalog.getModel(scadId);
  assert.deepEqual(result, { id: scadId, name: 'Crank.scad', format: 'scad', size: 123,
    modifiedAt: '2025-01-02T00:00:00.000Z', addedAt: '2025-01-01T00:00:00.000Z',
    missing: false, favorite: true, tags: ['Cafe\u0301', '折り畳み'], hasThumbnail: false });
  assert.deepEqual(catalog.searchModels({ format: 'scad' }).models, [result]);
  assert.deepEqual(catalog.getModel(scadId, { includeNotes: true }), { ...result, notes: 'fixture note' });
  assert.deepEqual(catalog.getModel(scadId, { includePath: true }), { ...result, path: models[0].path });
  assert.equal(catalog.getModel(absentId), null);
  assert(!JSON.stringify(catalog.searchModels()).includes(directory));
});

test('OpenSCAD presets and current thumbnails remain usable with schema v1 and v2', async t => {
  const { catalog, store } = await fixture(t);
  assert.deepEqual(catalog.listScadPresets(scadId), { presets: [], nextOffset: null });
  new ScadPresets(store.database);
  const insert = store.database.prepare('INSERT INTO scad_presets VALUES (?, ?, ?, ?, ?)');
  insert.run(scadId, presetId, 'Print', JSON.stringify({ enabled: true, length: 42, axis: [1, 0, 0], label: 'Rig' }), 123);
  insert.run(scadId, presetId.replace('f','e'), 'Secondary', '{}', 456);
  store.putThumbnail(scadId, { mime: 'image/png', bytes: icon, revision: 'fixture' });
  store.putThumbnail(stlId, { mime: 'image/png', bytes: Buffer.alloc(187_501), revision: 'fixture' });
  store.database.exec('DROP TABLE model_path_aliases');
  store.database.prepare("UPDATE library_meta SET value = 1 WHERE key = 'schema_version'").run();
  const first = catalog.listScadPresets(scadId, { limit: 1 });
  assert.deepEqual(first, { presets: [{ id: presetId, name: 'Print', updatedAt: 123,
    values: { enabled: true, length: 42, axis: [1, 0, 0], label: 'Rig' } }], nextOffset: 1 });
  assert.deepEqual(catalog.listScadPresets(scadId, { offset: first.nextOffset, limit: 1 }), {
    presets: [{ id: presetId.replace('f','e'), name: 'Secondary', updatedAt: 456, values: {} }], nextOffset: null,
  });
  assert.throws(() => catalog.listScadPresets(legacyStepId), { code: 'WRONG_MODEL_FORMAT' });
  assert.throws(() => catalog.listScadPresets(absentId), { code: 'MODEL_NOT_FOUND' });
  assert.equal(catalog.getModel(scadId).hasThumbnail, true);
  assert.deepEqual(catalog.readThumbnail(scadId), { mime: 'image/png', bytes: Uint8Array.from(icon) });
  assert.equal(catalog.readThumbnail(legacyStepId), null);
  assert.equal(catalog.readThumbnail(stlId), null, 'Oversized BLOB should be skipped');
  assert.equal(store.database.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get().value, 1);
  assert.equal(store.database.prepare("SELECT name FROM sqlite_schema WHERE name = 'model_path_aliases'").get(), undefined);
});

test('catalog readers see committed GUI changes while leaving uncommitted WAL changes private', async t => {
  const { catalog, store } = await fixture(t);
  const initial = catalog.getModel(scadId);
  store.database.exec('BEGIN IMMEDIATE');
  try {
    store.database.prepare('UPDATE models SET name = ? WHERE id = ?').run('Latest.scad', scadId);
    assert.equal(catalog.getModel(scadId).name, initial.name);
  } finally { store.database.exec('COMMIT'); }
  assert.equal(catalog.getModel(scadId).name, 'Latest.scad');
});

test('metadata validation and database errors do not disclose rejected values or leave new databases', async t => {
  const { catalog, directory, store } = await fixture(t);
  for (const options of [{ query: 'x'.repeat(MAX_QUERY_LENGTH + 1) }, { query: 'x\0y' }, { format: '../secret' },
    { missing: 'true' }, { favorite: 1 }, { limit: 0 }, { limit: MAX_PAGE_SIZE + 1 }, { offset: -1 }, { offset: MAX_OFFSET + 1 }]) {
    assert.throws(() => catalog.searchModels(options), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => catalog.getModel(path.join(directory, 'unregistered')), { code: 'INVALID_ARGUMENT' });
  const missingFile = path.join(directory, 'missing.sqlite3');
  const missing = new McpCatalog(missingFile);
  assert.throws(() => missing.searchModels(), error => error instanceof McpCatalogError &&
    error.code === 'DATABASE_NOT_FOUND' && !error.message.includes(directory));
  await assert.rejects(fs.stat(missingFile), { code: 'ENOENT' });
  const damaged = path.join(directory, 'damaged.sqlite3');
  await fs.writeFile(damaged, 'Not a database.');
  assert.throws(() => new McpCatalog(damaged).searchModels(), error => error instanceof McpCatalogError && !error.message.includes(directory));
  store.database.prepare("UPDATE library_meta SET value = 99 WHERE key = 'schema_version'").run();
  assert.throws(() => catalog.searchModels(), { code: 'UNSUPPORTED_DATABASE' });
});
