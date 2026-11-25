import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Worker as NodeWorker } from 'node:worker_threads';
import vm from 'node:vm';
import * as THREE from 'three';
import { DOMParser } from '@xmldom/xmldom';
import { loadModel, disposeModel } from '../src/formats/index.js';
import { meshFromStep, objectFromStep } from '../src/formats/step.js';
import { loadSTL } from '../src/formats/stl.js';
import { inspect3MFArchive, load3MF } from '../src/formats/three-mf.js';
import { arrayBufferOf, checkInput, LIMITS, validateGeometry } from '../src/formats/common.js';
import { HARD_LIMITS } from '../src/formats/preview-memory.js';
import { make3MF, modelXML, meshXML } from './create-format-fixtures.mjs';
import { zipSync, strToU8 } from 'fflate';

globalThis.DOMParser = DOMParser;
const require = createRequire(import.meta.url);
const fixture = (filename) => readFile(new URL(`./fixtures/${filename}`, import.meta.url));
function bounds(object) {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}
function close(actual, expected) { actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 0.001, `${actual} != ${expected}`)); }
function zipMembers(buffer) {
  const entries = [];
  let offset = buffer.readUInt32LE(buffer.length - 22 + 16);
  while (buffer.readUInt32LE(offset) === 0x02014b50) {
    const length = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + length);
    const local = buffer.readUInt32LE(offset + 42);
    const data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    entries.push({ name, central: offset, data });
    offset += 46 + length + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return entries;
}

test('binary STL displays in assumed mm with the original geometry bounds', async () => {
  const result = await loadModel(await fixture('cube-mm.stl'), { filename: 'cube-mm.STL' });
  close(bounds(result.object).getSize(new THREE.Vector3()).toArray(), [20,30,10]);
  assert.equal(result.unit, 'mm');
  assert.match(result.warnings[0], /単位情報/);
  disposeModel(result.object);
});

test('3MF base colors and geometry survive import', async () => {
  const result = await loadModel(await fixture('cube-mm.3mf'), { filename: 'cube-mm.3mf' });
  close(bounds(result.object).getSize(new THREE.Vector3()).toArray(), [20,30,10]);
  let colored = false;
  result.object.traverse((node) => { if (node.isMesh) colored ||= Boolean(node.geometry.attributes.color && node.material.vertexColors); });
  assert.equal(colored, true);
  assert.equal(result.metadata.triangles, 12);
  disposeModel(result.object);
});

test('3MF indices share matching corners and split only color seams', async () => {
  const base = '<basematerials id="2"><base name="Black" displaycolor="#000000"/><base name="Red" displaycolor="#ff0000"/></basematerials>';
  const mesh = meshXML([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [100, 100, 100]], [[0, 1, 2], [0, 2, 3], [0, 2, 3]])
    .replaceAll('<triangle v1="0" v2="2" v3="3"/>', '<triangle v1="0" v2="2" v3="3" pid="2" p1="0" p2="1" p3="0"/>');
  const data = make3MF({ '3D/3dmodel.model': modelXML(`${base}<object id="1">${mesh}</object>`, '<item objectid="1"/>') });
  const result = await loadModel(data, { filename: 'color-seam.3mf' });
  const [object] = result.object.children;
  const { position, color } = object.geometry.attributes;
  assert.equal(position.count, 6);
  assert.deepEqual([...object.geometry.index.array], [0, 1, 2, 4, 5, 3, 4, 5, 3]);
  assert.deepEqual([0, 3, 4, 5].map((i) => new THREE.Color().fromBufferAttribute(color, i).getHexString()), ['a9c9cf', '000000', '000000', 'ff0000']);
  assert.equal(object.material.flatShading, true);
  assert.equal(object.geometry.getAttribute('normal'), undefined);
  close(bounds(result.object).max.toArray(), [1, 1, 1]);
  assert.equal(result.metadata.triangles, 3);
  disposeModel(result.object);
});

test('mesh-free 3MF uses its embedded thumbnail without inventing dimensions', async () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'));
  const data = zipSync({ '3D/3dmodel.model': strToU8(modelXML('', '')), 'Metadata/plate_1.png': png });
  const result = await loadModel(data, { filename: 'image-only.3mf' });
  assert.equal(result.object, null);
  assert.equal(result.metadata.previewOnly, true);
  assert.match(result.previewImage, /^data:image\/png;base64,/);
  assert.equal(result.metadata.dimensions, undefined);
});

test('Bambu style same-ID components resolve by model path and apply both transforms', async () => {
  const result = await loadModel(await fixture('bambu-components.3mf'), { filename: 'bambu.3mf' });
  const box = bounds(result.object);
  close(box.min.toArray(), [5,2,3]);
  close(box.max.toArray(), [45,32,13]);
  assert.equal(result.metadata.triangles, 24);
  assert.equal(result.metadata.parts, 3);
  disposeModel(result.object);
});

test('inch 3MF converts mesh and translated build item to mm', async () => {
  const data = make3MF({ '3D/3dmodel.model': modelXML(`<object id="1">${meshXML([[0,0,0],[1,0,0],[0,1,1]], [[0,1,2]])}</object>`, '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>', 'inch') });
  const result = await loadModel(data, { filename: 'inch.3mf' });
  close(bounds(result.object).min.toArray(), [50.8,0,0]);
  close(bounds(result.object).getSize(new THREE.Vector3()).toArray(), [25.4,25.4,25.4]);
  disposeModel(result.object);
});

test('cyclic 3MF components fail with an explicit error', async () => {
  const data = make3MF({ '3D/3dmodel.model': modelXML('<object id="1"><components><component objectid="1"/></components></object>', '<item objectid="1"/>') });
  await assert.rejects(() => loadModel(data, { filename: 'cycle.3mf' }), /循環/);
});

test('invalid vertex indices are rejected instead of rendering broken geometry', async () => {
  const data = make3MF({ '3D/3dmodel.model': modelXML(`<object id="1">${meshXML([[0,0,0],[1,0,0],[0,1,0]], [[0,1,9]])}</object>`, '<item objectid="1"/>') });
  await assert.rejects(() => loadModel(data, { filename: 'bad.3mf' }), /範囲外/);
});

test('pre-cancelled imports stop before parsing', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => loadModel(new Uint8Array([1]), { filename: 'a.stl', signal: controller.signal }), { name: 'AbortError' });
});

test('STEP face colors use triangle ranges and preserve default gaps', () => {
  const object = meshFromStep({ name: 'test', attributes: { position: { array: [0,0,0, 1,0,0, 0,1,0, 0,0,1] } }, index: { array: [0,1,2, 0,2,3] }, color: [0.5,0.5,0.5], brep_faces: [{ first: 1, last: 1, color: [1,0,0] }] });
  assert.deepEqual(object.geometry.groups.map(({start,count}) => ({start,count})), [{start:0,count:3}, {start:3,count:3}]);
  assert.equal(object.material[1].color.getHexString(), 'ff0000');
  disposeModel(object);
});

test('bundled OpenCascade actually tessellates the generated STEP cube', { timeout: 30_000 }, async () => {
  const occt = await require('occt-import-js')();
  const parsed = occt.ReadStepFile(await fixture('cube-mm.step'), { linearUnit: 'millimeter' });
  assert.equal(parsed.success, true);
  const result = objectFromStep(parsed);
  close(bounds(result.object).getSize(new THREE.Vector3()).toArray(), [20,30,10]);
  assert.ok(result.metadata.triangles >= 12);
  disposeModel(result.object);
});

test('input byte limit rejects at a low budget and accepts the same data at a higher limit', () => {
  const bytes = new Uint8Array(64);
  assert.throws(() => checkInput(bytes, undefined, { ...LIMITS, fileBytes: 32 }), (error) => error.code === 'PREVIEW_MEMORY_LIMIT' && /64 B/.test(error.message) && /32 B/.test(error.message) && /プレビューメモリ/.test(error.message));
  assert.equal(checkInput(bytes, undefined, { ...LIMITS, fileBytes: 64 }).byteLength, 64);
});

test('STL accepts a larger supplied triangle limit without changing the model', async () => {
  const buffer = arrayBufferOf(await fixture('cube-mm.stl'));
  await assert.rejects(() => loadSTL(buffer, { limits: { ...LIMITS, triangles: 11 } }), (error) => error.code === 'PREVIEW_MEMORY_LIMIT' && /12/.test(error.message) && /11/.test(error.message));
  const result = await loadSTL(buffer, { limits: { ...LIMITS, triangles: 12 } });
  close(bounds(result.object).getSize(new THREE.Vector3()).toArray(), [20,30,10]);
  disposeModel(result.object);
});

test('3MF reports separate XML, expanded archive and triangle budget failures', async () => {
  const buffer = arrayBufferOf(await fixture('cube-mm.3mf'));
  for (const [property, value, label] of [['xmlBytes', 512, /単一モデルXML/], ['archiveBytes', 512, /展開後XML合計/], ['triangles', 11, /三角形数/]]) {
    await assert.rejects(() => load3MF(buffer, { limits: { ...LIMITS, [property]: value } }), (error) => error.code === 'PREVIEW_MEMORY_LIMIT' && label.test(error.message) && /プレビューメモリ/.test(error.message));
  }
  const result = await load3MF(buffer, { limits: LIMITS });
  assert.equal(result.metadata.triangles, 12);
  disposeModel(result.object);
});

test('3MF instance budget is adjustable', async () => {
  const buffer = arrayBufferOf(await fixture('bambu-components.3mf'));
  await assert.rejects(() => load3MF(buffer, { limits: { ...LIMITS, instances: 1 } }), (error) => error.code === 'PREVIEW_MEMORY_LIMIT' && /部品配置数|オブジェクト数/.test(error.message));
  const result = await load3MF(buffer, { limits: { ...LIMITS, instances: 100 } });
  assert.equal(result.metadata.triangles, 24);
  disposeModel(result.object);
});

test('3MF hard XML cap rejects a declared huge member before decompressing it', async () => {
  const buffer = Buffer.from(await fixture('cube-mm.3mf'));
  const end = buffer.length - 22;
  let offset = buffer.readUInt32LE(end + 16);
  while (offset < end && buffer.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name.endsWith('.model')) { buffer.writeUInt32LE(HARD_LIMITS.xmlBytes + 1, offset + 24); break; }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  await assert.rejects(() => load3MF(arrayBufferOf(buffer), { limits: { ...LIMITS, xmlBytes: HARD_LIMITS.xmlBytes } }), (error) => error.code === 'PREVIEW_IMPLEMENTATION_LIMIT' && /実装上/.test(error.message) && /メモリ設定では変更できません/.test(error.message));
});

test('invalid geometry is distinct from a memory-budget error', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 0,0,1], 3));
  assert.throws(() => validateGeometry(geometry, { ...LIMITS, triangles: 1 }), (error) => !error.code && /不正/.test(error.message));
  geometry.dispose();
});

test('STEP mesh and worker both honor the supplied triangle budget', async () => {
  const mesh = { attributes: { position: { array: [0,0,0, 1,0,0, 0,1,0, 0,0,1] } }, index: { array: [0,1,2, 0,2,3] } };
  const parsed = { success: true, meshes: [mesh] };
  assert.throws(() => objectFromStep(parsed, { ...LIMITS, triangles: 1 }), (error) => error.code === 'PREVIEW_MEMORY_LIMIT');
  const result = objectFromStep(parsed, { ...LIMITS, triangles: 2 });
  assert.equal(result.metadata.triangles, 2);
  disposeModel(result.object);
  const messages = [];
  const context = vm.createContext({
    importScripts() {},
    occtimportjs: async () => ({ ReadStepFile: () => parsed }),
    self: { location: { href: new URL('../public/occt/step-worker.js', import.meta.url).href }, postMessage: (message) => messages.push(message) },
    URL,
  });
  vm.runInContext(await readFile(new URL('../public/occt/step-worker.js', import.meta.url), 'utf8'), context);
  await context.self.onmessage({ data: { buffer: new ArrayBuffer(1), limits: { triangles: 1 } } });
  assert.match(messages[0].error, /現在の上限 1/);
  await context.self.onmessage({ data: { buffer: new ArrayBuffer(1), limits: { triangles: 2 } } });
  assert.equal(messages[1].result.success, true);
});

test('3MF preflight catches a late oversized member before inflating an earlier corrupt member', async () => {
  const xml = modelXML(`<object id="1">${meshXML()}</object>`, '<item objectid="1"/>');
  const buffer = Buffer.from(make3MF({ '3D/3dmodel.model': xml, '3D/Objects/large.model': xml }));
  const members = zipMembers(buffer);
  const first = members.find((entry) => entry.name === '3D/3dmodel.model');
  const later = members.find((entry) => entry.name.endsWith('large.model'));
  buffer[first.data] = 0x07; // Invalid DEFLATE block type, which must never be read.
  buffer.writeUInt32LE(HARD_LIMITS.xmlBytes + 1, later.central + 24);
  await assert.rejects(() => load3MF(arrayBufferOf(buffer)), (error) => error.code === 'PREVIEW_IMPLEMENTATION_LIMIT' && /large\.model/.test(error.message));
});

test('3MF extracts only referenced models after its metadata preflight', async () => {
  const xml = modelXML(`<object id="1">${meshXML()}</object>`, '<item objectid="1"/>');
  const buffer = Buffer.from(make3MF({ '3D/3dmodel.model': xml, '3D/Objects/unused.model': xml }));
  const unused = zipMembers(buffer).find((entry) => entry.name.endsWith('unused.model'));
  buffer[unused.data] = 0x07;
  const audit = inspect3MFArchive(arrayBufferOf(buffer));
  assert.equal(audit.selected.size, 3);
  const result = await load3MF(arrayBufferOf(buffer));
  assert.equal(result.metadata.triangles, 12);
  disposeModel(result.object);
});

test('stored ZIP members cannot evade their allocation budget using a false original size', () => {
  const buffer = Buffer.from(zipSync({ '3D/3dmodel.model': strToU8(modelXML('', '')) }, { level: 0 }));
  const member = zipMembers(buffer)[0];
  buffer.writeUInt32LE(1, member.central + 24);
  assert.throws(() => inspect3MFArchive(arrayBufferOf(buffer)), /無圧縮ZIPサイズが一致しません/);
});

test('3MF cached instances survive releasing their original object DOM', async () => {
  const data = make3MF({ '3D/3dmodel.model': modelXML(`<object id="1">${meshXML()}</object>`, '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>') });
  const result = await load3MF(arrayBufferOf(data));
  close(bounds(result.object).getSize(new THREE.Vector3()).toArray(), [50,30,10]);
  assert.equal(result.metadata.triangles, 24);
  result.object.traverse((node) => { if (node.isMesh) assert.equal(node.geometry.getAttribute('color'), undefined); });
  disposeModel(result.object);
});

test('on-demand mesh workers transfer owned data, preserve instances, and cancel', async () => {
  const workers = [];
  class BrowserWorker extends NodeWorker {
    constructor(url) {
      super(`
        const { parentPort } = require('node:worker_threads');
        globalThis.self = { postMessage: (...args) => parentPort.postMessage(...args) };
        import(${JSON.stringify(url.href)}).then(() => {
          parentPort.on('message', (data) => self.onmessage({ data }));
        });
      `, { eval: true });
      this.on('message', (data) => this.onmessage?.({ data }));
      this.on('error', (error) => this.onerror?.(error));
      workers.push(this);
    }

    terminate() {
      this.exit = super.terminate();
      return this.exit;
    }
  }

  const previousWorker = globalThis.Worker;
  globalThis.Worker = BrowserWorker;
  try {
    const stl = await fixture('cube-mm.stl');
    const small = await loadModel(stl, { filename: 'small.stl', offThread: true });
    assert.equal(workers.length, 0);
    disposeModel(small.object);

    const facets = 12 * 500;
    const bytes = new Uint8Array(84 + facets * 50);
    new DataView(bytes.buffer).setUint32(80, facets, true);
    for (let offset = 84; offset < bytes.byteLength; offset += 600) bytes.set(stl.subarray(84), offset);
    const large = await loadModel(bytes, { filename: 'large.stl', offThread: true, consumeInput: true });
    assert.equal(bytes.byteLength, 0);
    assert.equal(large.object.geometry.attributes.position.array.byteLength, facets * 9 * Float32Array.BYTES_PER_ELEMENT);
    close(bounds(large.object).getSize(new THREE.Vector3()).toArray(), [20,30,10]);
    disposeModel(large.object);

    const colorResource = '<basematerials id="2"><base name="Red" displaycolor="#cc3311"/></basematerials>';
    const xml = modelXML(`${colorResource}<object id="1" pid="2" pindex="0">${meshXML()}</object>`, '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>');
    const data = make3MF({ '3D/3dmodel.model': xml });
    const originalSize = data.byteLength;
    const model = await loadModel(data, { filename: 'shared.3mf', offThread: true });
    assert.equal(data.byteLength, originalSize);
    const [first, second] = model.object.children;
    assert.strictEqual(first.geometry, second.geometry);
    assert.strictEqual(first.material, second.material);
    assert.equal(first.material.vertexColors, true);
    assert.equal(first.material.flatShading, true);
    assert.equal(first.geometry.getAttribute('color').count, 8);
    assert.equal(first.geometry.getAttribute('position').count, 8);
    assert.equal(first.geometry.index.count, 36);
    assert.equal(model.metadata.triangles, 24);
    close(bounds(model.object).getSize(new THREE.Vector3()).toArray(), [50,30,10]);
    disposeModel(model.object);

    const invalid = make3MF({ '3D/3dmodel.model': '<model><resources></model>' });
    await assert.rejects(() => loadModel(invalid, { filename: 'invalid.3mf', offThread: true }), /XMLが壊れています/);

    const controller = new AbortController();
    const aborted = loadModel(data, { filename: 'cancel.3mf', offThread: true, signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted, { name: 'AbortError' });
    assert.equal(workers.length, 4);
    assert.ok(workers.every((worker) => worker.exit instanceof Promise));
  } finally {
    globalThis.Worker = previousWorker;
    await Promise.all(workers.map((worker) => worker.exit || worker.terminate()));
  }
});
