const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { crc32 } = require('node:zlib');
const { zipSync } = require('fflate');
const { readEmbedded3mfImage } = require('../electron/three-mf-thumbnail.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from('/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAJgABAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwA//9k=', 'base64');

async function archiveFile(t, bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-3mf-image-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'model.3mf');
  await fs.writeFile(source, bytes);
  return source;
}

function observation(t) {
  const reads = [];
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    const read = file.read.bind(file);
    file.read = (...params) => {
      reads.push({ length: params[2], offset: params[3] });
      return read(...params);
    };
    return file;
  });
  return reads;
}

test('3MF image fallback reads header ranges and skips model data and alternate previews', async (t) => {
  const source = await archiveFile(t, zipSync({
    '3D/3dmodel.model': [Buffer.alloc(1024 * 1024), { level: 0 }],
    'Metadata/thumbnail.png': Buffer.from('a lower-ranked preview'),
    'Metadata/plate_1.png': png,
  }));
  const reads = observation(t);
  assert.deepEqual(await readEmbedded3mfImage(source), { mime: 'image/png', bytes: png });
  assert(reads.length > 0);
  assert(reads.every(({ offset }) => offset > 1024 * 1024));
  assert(reads.reduce((sum, { length }) => sum + length, 0) < 512);
});

test('3MF image fallback supports stored previews and a ZIP comment', async (t) => {
  const archive = Buffer.from(zipSync({ 'Metadata/plate_1.png': png }, { level: 0 }));
  const comment = Buffer.from('Fixture ZIP comment');
  archive.writeUInt16LE(comment.length, archive.length - 2);
  const source = await archiveFile(t, Buffer.concat([archive, comment]));
  assert.deepEqual(await readEmbedded3mfImage(source), { mime: 'image/png', bytes: png });
});

test('3MF image fallback detects a valid JPEG preview', async (t) => {
  const source = await archiveFile(t, zipSync({ 'Metadata/thumbnail.jpeg': jpeg }));
  assert.deepEqual(await readEmbedded3mfImage(source), { mime: 'image/jpeg', bytes: jpeg });
});

test('3MF image fallback skips images outside expected paths or size bounds', async (t) => {
  const widePng = Buffer.from(png);
  widePng.writeUInt32BE(4097, 16);
  widePng.writeUInt32BE(crc32(widePng.subarray(12, 29)), 29);
  const wrongPath = await archiveFile(t, zipSync({ '../Metadata/plate_1.png': png }));
  const oversized = await archiveFile(t, zipSync({ 'Metadata/plate_1.png': widePng }));
  const unrelated = await archiveFile(t, zipSync({ 'Metadata/illustration.png': png }));
  assert.equal(await readEmbedded3mfImage(wrongPath), null);
  assert.equal(await readEmbedded3mfImage(oversized), null);
  assert.equal(await readEmbedded3mfImage(unrelated), null);
});

test('3MF image fallback skips damaged ZIP or image data', async (t) => {
  const archive = Buffer.from(zipSync({ 'Metadata/plate_1.png': png }, { level: 0 }));
  const contentOffset = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28);
  archive[contentOffset] = 0;
  const corrupt = await archiveFile(t, archive);
  const truncated = await archiveFile(t, archive.subarray(0, -10));
  const mismatched = await archiveFile(t, zipSync({ 'Metadata/thumbnail.jpg': png }));
  assert.equal(await readEmbedded3mfImage(corrupt), null);
  assert.equal(await readEmbedded3mfImage(truncated), null);
  assert.equal(await readEmbedded3mfImage(mismatched), null);
});

test('3MF image fallback closes the input and propagates cancellation during a range read', async (t) => {
  const source = await archiveFile(t, zipSync({ 'Metadata/plate_1.png': png }));
  const controller = new AbortController();
  const open = fs.open;
  let closed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.read = async (...params) => {
      const result = await read(...params);
      controller.abort();
      return result;
    };
    file.close = async () => {
      await close();
      closed = true;
    };
    return file;
  });
  await assert.rejects(readEmbedded3mfImage(source, controller.signal), { name: 'AbortError' });
  assert.equal(closed, true);
});
