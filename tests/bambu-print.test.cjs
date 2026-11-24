const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { BambuPrint, STAGE_RETENTION_MS, MAX_PRINT_STL_BYTES } = require('../electron/bambu-print.cjs');
const { detectOpenScad, writeScadPrintStl } = require('../electron/scad-engine.cjs');

const versionInfo = { version: '02.09.01.70', productName: 'BambuStudio', originalFilename: 'bambu-studio.exe' };

async function fixture(t, { format = '3mf', ...overrides } = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'nine-bambu-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert(path.basename(root).startsWith('nine-bambu-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, 'Example Installation', 'bambu-studio.exe');
  const model = path.join(root, `Example model.${format}`);
  const stagingRoot = path.join(root, 'print-cache');
  const item = { id: 'example-model', path: model, format };
  await fs.mkdir(path.dirname(executable));
  await fs.writeFile(executable, 'test executable stand-in');
  await fs.writeFile(model, format === 'scad' ? 'width = 10;\ncube([width, 8, 6]);\n' : 'synthetic model stand-in');
  const launches = [];
  const print = new BambuPrint({
    platform: 'win32', stagingRoot,
    getExecutable: () => executable,
    getOpenScad: () => 'test openscad',
    getItem: id => { assert.equal(id, item.id); return item; },
    captureSource: async id => { assert.equal(id, item.id); return { path: model }; },
    validateSource: async (id, source) => { assert.equal(id, item.id); assert.equal(source.path, model); },
    probeVersion: async () => versionInfo,
    spawnProcess: (...args) => {
      launches.push(args);
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    ...overrides,
  });
  return { executable, item, launches, model, print, root, stagingRoot };
}

test('Bambu Studio version probe is reused until the executable changes', async t => {
  let calls = 0;
  const { executable, print } = await fixture(t, { probeVersion: async () => { calls += 1; return versionInfo; } });
  const [first, second] = await Promise.all([print.getStatus(), print.getStatus()]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, { available: true, version: versionInfo.version, reason: null,
    capabilities: { studioGui: true, printerConfirmationInStudio: true } });
  assert.equal(calls, 1);
  await fs.appendFile(executable, '-changed');
  assert.equal((await print.getStatus()).available, true);
  assert.equal(calls, 2);
});

test('unverified executable is rejected without revealing its path or spawning it', async t => {
  const { executable, item, launches, print } = await fixture(t, { probeVersion: async () => ({ version: '10.00.00.01', productName: 'Example' }) });
  const status = await print.getStatus();
  assert.equal(status.available, false);
  assert(!JSON.stringify(status).includes(executable));
  await assert.rejects(print.prepare(item.id), /公式版/);
  assert.equal(launches.length, 0);
});

test('original 3MF is handed off by path without a copy, preview, or printer action', async t => {
  const { executable, item, launches, model, print, stagingRoot } = await fixture(t);
  const result = await print.prepare(item.id);
  assert.equal(result.status, 'opened');
  assert.equal(result.source, 'original');
  assert.equal(result.studioVersion, versionInfo.version);
  assert.equal(result.steps.length, 3);
  assert.deepEqual(launches, [[executable, [model], { cwd: path.dirname(executable), detached: true, stdio: 'ignore', shell: false }]]);
  await assert.rejects(fs.access(stagingRoot), { code: 'ENOENT' });
  assert.equal(await fs.readFile(model, 'utf8'), 'synthetic model stand-in');
});

test('real OpenSCAD stages edited STL without loading the mesh or starting Studio', async t => {
  const executable = await detectOpenScad();
  if (!executable) { t.skip('OpenSCAD executable unavailable'); return; }
  const { item, launches, model, print, stagingRoot } = await fixture(t, {
    format: 'scad', getOpenScad: () => executable, renderScad: writeScadPrintStl,
  });
  const result = await print.prepare(item.id, { width: 25 });
  assert.equal(result.source, 'scad-stl');
  assert.equal(launches.length, 1);
  const file = launches[0][1][0];
  assert.equal(path.dirname(path.dirname(file)), await fs.realpath(stagingRoot));
  const bytes = await fs.readFile(file);
  const verticesX = [];
  const triangles = bytes.readUInt32LE(80);
  for (let triangle = 0; triangle < triangles; triangle++) {
    const vertices = 84 + triangle * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex++) verticesX.push(bytes.readFloatLE(vertices + vertex * 12));
  }
  assert.equal(Math.max(...verticesX), 25);
  assert.match(await fs.readFile(model, 'utf8'), /width = 10/);
  assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
});

test('cancellation and overlapping requests do not launch Studio or leave a staged directory', async t => {
  const events = new EventEmitter();
  const { item, launches, print, stagingRoot } = await fixture(t, { format: 'scad', renderScad: async ({ signal, maxOutputBytes }) => {
    assert.equal(maxOutputBytes, MAX_PRINT_STL_BYTES);
    const aborted = once(signal, 'abort');
    events.emit('started');
    await aborted;
    signal.throwIfAborted();
  } });
  const started = once(events, 'started');
  const pending = print.prepare(item.id);
  await started;
  assert.throws(() => print.prepare(item.id), /進行中/);
  assert.equal(print.cancel(), true);
  assert.deepEqual(await pending, { status: 'cancelled', opened: false });
  assert.equal(print.cancel(), false);
  assert.equal(launches.length, 0);
  assert.deepEqual(await fs.readdir(stagingRoot), []);
});

test('modified source after SCAD rendering is refused and staged file is removed', async t => {
  const { item, launches, print, stagingRoot } = await fixture(t, {
    format: 'scad', validateSource: async () => { throw new Error('source changed'); },
    renderScad: async ({ directory }) => {
      const file = path.join(directory, 'model.stl');
      await fs.writeFile(file, 'synthetic staged model');
      return file;
    },
  });
  await assert.rejects(print.prepare(item.id), /source changed/);
  assert.equal(launches.length, 0);
  assert.deepEqual(await fs.readdir(stagingRoot), []);
});

test('expired print stages are removed before a new stage and unrelated data is preserved', async t => {
  const now = Date.now();
  const { item, print, stagingRoot } = await fixture(t, { format: 'scad', now: () => now,
    renderScad: async ({ directory }) => {
      const file = path.join(directory, 'model.stl');
      await fs.writeFile(file, 'synthetic staged model');
      return file;
    },
  });
  await fs.mkdir(stagingRoot);
  const expired = path.join(stagingRoot, 'print-abc123');
  const unrelated = path.join(stagingRoot, 'other-directory');
  for (const directory of [expired, unrelated]) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'model.stl'), 'synthetic');
    const old = new Date(now - STAGE_RETENTION_MS - 60_000);
    await fs.utimes(directory, old, old);
  }
  await print.prepare(item.id);
  const entries = await fs.readdir(stagingRoot);
  assert(!entries.includes('print-abc123'));
  assert(entries.includes('other-directory'));
  assert.equal(entries.length, 2);
});
