const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ThumbnailBatch } = require('../electron/thumbnail-batch.cjs');
const { ThumbnailBatchStore } = require('../electron/thumbnail-batch-store.cjs');

async function createBatch(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-thumb-report-'));
  const database = new DatabaseSync(path.join(dataDir, 'library.sqlite3'));
  t.after(async () => {
    database.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const store = new ThumbnailBatchStore(database, dataDir);
  const batch = new ThumbnailBatch({
    generate: async () => {},
    saveThumbnail: async () => {},
    persistReport: report => store.save(report),
  });
  return { batch, store, database, legacyFile: path.join(dataDir, 'thumbnail-batch.json') };
}

test('uses legacy reports only until SQLite holds the latest normalized report', async t => {
  const { batch, store, legacyFile } = await createBatch(t);
  const legacy = JSON.stringify({ id: 'legacy-batch', status: 'running', total: 2, processed: 1, succeeded: 1 });
  await fs.writeFile(legacyFile, legacy);

  await batch.restoreFrom(() => store.load());
  assert.equal(batch.getState().status, 'cancelled');
  assert.deepEqual(await store.load(), batch.getState());

  store.save({ id: 'new-batch', status: 'completed', total: 1, processed: 1 });
  await batch.restoreFrom(() => store.load());
  assert.equal(batch.getState().id, 'new-batch');
  assert.equal(batch.getState().status, 'completed');
  assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
});

test('missing saved results leave a fresh batch idle', async t => {
  const { batch, store, database } = await createBatch(t);
  await batch.restoreFrom(() => store.load());
  assert.equal(batch.getState().status, 'idle');
  assert.equal(batch.getState().reportError, undefined);
  assert.equal(database.prepare('SELECT count(*) AS total FROM thumbnail_batch_report').get().total, 0);
});

test('a damaged SQLite report surfaces a recovery error and does not restore the old JSON', async t => {
  const { batch, store, database, legacyFile } = await createBatch(t);
  const corruption = '{ invalid';
  database.prepare('INSERT INTO thumbnail_batch_report VALUES (1, ?)').run(corruption);
  await fs.writeFile(legacyFile, JSON.stringify({ id: 'legacy-batch', status: 'completed' }));

  await batch.restoreFrom(() => store.load());
  assert.equal(batch.getState().status, 'idle');
  assert.match(batch.getState().reportError, /^前回の生成結果を読み込めません:/);
  assert.equal(database.prepare('SELECT report_json FROM thumbnail_batch_report').get().report_json, corruption);
});
