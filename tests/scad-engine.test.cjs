const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { detectOpenScad, resolveExecutable, readScadParameters, renderScad, prepareScadExport, exportScad, waitForScadIdle } = require('../electron/scad-engine.cjs');

const SOURCE = `/* [Parameters] */
width = 10; // [1:1:100]
part = "base"; // [base, cap, empty]
label = "example";
include <geometry.scad>;
if (part == "base") body(width);
else if (part == "cap") cube([width, 2, 3]);
`;

async function fixture(t, source = SOURCE) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-scad-test-'));
  const temporaryRoot = path.join(root, 'temporary');
  const directory = path.join(root, 'exports');
  await fs.mkdir(temporaryRoot);
  await fs.mkdir(directory);
  const sourcePath = path.join(root, 'モデル.scad');
  await fs.writeFile(sourcePath, source);
  await fs.writeFile(path.join(root, 'geometry.scad'), 'module body(w) { cube([w, 5, 6]); }\n');
  t.after(async () => {
    await waitForScadIdle();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^nine-scad-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, sourcePath, temporaryRoot, directory, executable: process.execPath };
}

function binaryTriangle() {
  const bytes = Buffer.alloc(134);
  bytes.writeUInt32LE(1, 80);
  const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  vertices.forEach((vertex, index) => vertex.forEach((value, axis) => bytes.writeFloatLE(value, 96 + index * 12 + axis * 4)));
  return bytes;
}

function mockSpawn({ hang = false, delay = 5, writeOutput, onSpawn = () => {}, onClose = () => {}, stderr = '' } = {}) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    let closed = false;
    let timer;
    const finish = code => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      onClose();
      child.emit('close', code);
    };
    child.kill = () => { child.killed = true; setImmediate(() => finish(null)); return true; };
    onSpawn({ executable, args, options, child });
    if (!hang) timer = setTimeout(async () => {
      try {
        const output = args[args.indexOf('-o') + 1];
        if (writeOutput) await writeOutput(output, args);
        else await fs.writeFile(output, binaryTriangle());
        if (stderr) child.stderr.write(stderr);
        finish(0);
      } catch (error) { child.stderr.write(String(error)); finish(1); }
    }, delay);
    return child;
  };
}

function stlDimensions(input) {
  const bytes = Buffer.from(input);
  const triangles = bytes.readUInt32LE(80);
  assert.equal(bytes.length, 84 + triangles * 50);
  assert.ok(triangles > 0);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triangles; i++) for (let vertex = 0; vertex < 3; vertex++) for (let axis = 0; axis < 3; axis++) {
    const value = bytes.readFloatLE(84 + i * 50 + 12 + vertex * 12 + axis * 4);
    minimum[axis] = Math.min(minimum[axis], value);
    maximum[axis] = Math.max(maximum[axis], value);
  }
  return maximum.map((value, axis) => value - minimum[axis]);
}

test('parameter discovery and export plans use declared values and stable part filenames', async t => {
  const options = await fixture(t);
  const info = await readScadParameters(options.sourcePath);
  assert.equal(info.supported, true);
  assert.equal(info.selector, 'part');
  assert.deepEqual(info.parameters.find(p => p.name === 'part').options.map(p => p.value), ['base', 'cap', 'empty']);
  const all = await prepareScadExport(options.sourcePath, { values: { width: 15 }, selector: 'part', parts: ['base', 'cap', 'empty'] });
  const selected = await prepareScadExport(options.sourcePath, { values: { width: 15 }, selector: 'part', parts: ['cap'] });
  assert.equal(selected.jobs[0].name, all.jobs[1].name);
  assert.equal(selected.jobs[0].values.part, 'cap');
  assert.equal(selected.jobs[0].values.width, 15);
  assert.match(selected.jobs[0].name, /002-cap\.stl$/);
  await assert.rejects(() => prepareScadExport(options.sourcePath, { selector: 'part', parts: ['undeclared'] }), /選択肢/);
  await assert.rejects(() => prepareScadExport(options.sourcePath, { selector: 'part', parts: ['base', 'base'] }), /重複/);
  await assert.rejects(() => prepareScadExport(options.sourcePath, { selector: 'width', parts: [10] }), /選択肢/);
  await assert.rejects(() => prepareScadExport(options.sourcePath, { selector: 'part', parts: Array(257).fill('base') }), /256/);
});

test('sources without editable parameters still support their default model', async t => {
  const options = await fixture(t, 'cube([1, 2, 3]);\n');
  const info = await readScadParameters(options.sourcePath);
  assert.equal(info.supported, false);
  assert.equal(info.selector, null);
  const result = await renderScad({ ...options, values: {}, spawnProcess: mockSpawn() });
  assert.equal(result.bytes.length, 134);
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('preview uses literal argv, original source directory, binary STL, and bounded warnings', async t => {
  const options = await fixture(t);
  let launch;
  const label = '"; malicious_module(); //';
  const result = await renderScad({ ...options, values: { width: 12, label },
    spawnProcess: mockSpawn({ onSpawn: value => { launch = value; }, stderr: 'WARNING: test warning\nWARNING: test warning\nGeometry cache size: 10\n' }) });
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.cwd, path.dirname(options.sourcePath));
  assert.equal(launch.args.at(-1), options.sourcePath);
  assert.deepEqual(launch.args.slice(0, 2), ['--export-format', 'binstl']);
  assert.ok(launch.args.includes('width=12'));
  assert.ok(launch.args.includes('label="\\"; malicious_module(); //"'));
  assert.deepEqual(result.warnings, ['WARNING: test warning']);
  assert.equal(result.bytes.byteLength, 134);
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('preview rejects over-budget generated files before loading them and cleans temporary output', async t => {
  const options = await fixture(t);
  const spawnProcess = mockSpawn({ writeOutput: async output => {
    const handle = await fs.open(output, 'w');
    try { await handle.truncate(65 * 1024 * 1024); } finally { await handle.close(); }
  } });
  await assert.rejects(() => renderScad({ ...options, memoryBudgetMiB: 512, spawnProcess }), /上限 64 MiB/);
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('preview timeout kills its process and releases the slot for a subsequent render', async t => {
  const options = await fixture(t);
  let child;
  await assert.rejects(() => renderScad({ ...options, timeoutMs: 20, spawnProcess: mockSpawn({ hang: true, onSpawn: value => { child = value.child; } }) }), { name: 'TimeoutError' });
  assert.equal(child.killed, true);
  const result = await renderScad({ ...options, spawnProcess: mockSpawn() });
  assert.equal(result.bytes.length, 134);
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('cancelling queued and active previews is prompt and never launches the cancelled waiter', async t => {
  const options = await fixture(t);
  const first = new AbortController();
  const second = new AbortController();
  let launched = 0;
  let ready;
  const active = new Promise(resolve => { ready = resolve; });
  const spawnProcess = mockSpawn({ hang: true, onSpawn: () => { launched += 1; ready(); } });
  const one = renderScad({ ...options, signal: first.signal, spawnProcess });
  const oneRejected = assert.rejects(one, { name: 'AbortError' });
  await active;
  const two = renderScad({ ...options, signal: second.signal, spawnProcess });
  const twoRejected = assert.rejects(two, { name: 'AbortError' });
  second.abort();
  await twoRejected;
  assert.equal(launched, 1);
  first.abort();
  await oneRejected;
  await waitForScadIdle();
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('concurrent callers share one native process slot', async t => {
  const options = await fixture(t);
  let active = 0;
  let maximum = 0;
  const spawnProcess = mockSpawn({ delay: 10, onSpawn: () => { active += 1; maximum = Math.max(maximum, active); }, onClose: () => { active -= 1; } });
  await Promise.all([1, 2, 3].map(width => renderScad({ ...options, values: { width }, spawnProcess })));
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('part export skips existing destinations, keeps processing, and reports completed files', async t => {
  const options = await fixture(t);
  const request = { values: {}, selector: 'part', parts: ['base', 'cap'] };
  const plan = await prepareScadExport(options.sourcePath, request);
  const existing = path.join(options.directory, plan.jobs[0].name);
  await fs.writeFile(existing, 'existing destination');
  const progress = [];
  const result = await exportScad({ ...options, ...request, spawnProcess: mockSpawn(), onProgress: state => progress.push(state) });
  assert.equal(result.cancelled, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].part, 'base');
  assert.match(result.failures[0].error, /上書きしません/);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].part, 'cap');
  assert.equal(await fs.readFile(existing, 'utf8'), 'existing destination');
  assert.deepEqual(progress.at(-1), { processed: 2, total: 2, current: null });
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('cancelling export preserves completed files and starts no further part', async t => {
  const options = await fixture(t);
  const controller = new AbortController();
  let launched = 0;
  const result = await exportScad({ ...options, values: {}, selector: 'part', parts: ['base', 'cap'], signal: controller.signal,
    spawnProcess: mockSpawn({ onSpawn: () => { launched += 1; } }),
    onProgress: state => { if (state.processed === 1) controller.abort(); } });
  assert.equal(result.cancelled, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(launched, 1);
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('source changes after rendering prevent committing an exported file', async t => {
  const options = await fixture(t);
  let validations = 0;
  const result = await exportScad({ ...options, values: {}, parts: null, spawnProcess: mockSpawn(), validateSource: async () => {
    validations += 1;
    if (validations === 2) throw new Error('source replaced during rendering');
  } });
  assert.equal(result.files.length, 0);
  assert.match(result.failures[0].error, /source replaced/);
  assert.deepEqual(await fs.readdir(options.directory), []);
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
});

test('installed OpenSCAD CLI renders relative includes, applies parameters, and exports independent parts', async t => {
  const executable = await detectOpenScad();
  if (!executable) { t.skip('OpenSCAD is not installed on this machine'); return; }
  const options = await fixture(t);
  const result = await renderScad({ ...options, executable, values: { width: 17 }, timeoutMs: 30000 });
  assert.deepEqual(stlDimensions(result.bytes), [17, 5, 6]);
  const exported = await exportScad({ ...options, executable, values: { width: 19 }, selector: 'part', parts: ['empty', 'cap', 'base'], timeoutMs: 30000 });
  assert.equal(exported.cancelled, false);
  assert.equal(exported.failures.length, 1);
  assert.equal(exported.failures[0].part, 'empty');
  assert.equal(exported.files.length, 2);
  const cap = exported.files.find(file => file.part === 'cap');
  const base = exported.files.find(file => file.part === 'base');
  assert.deepEqual(stlDimensions(await fs.readFile(cap.path)), [19, 2, 3]);
  assert.deepEqual(stlDimensions(await fs.readFile(base.path)), [19, 5, 6]);
  assert.equal(await fs.readFile(options.sourcePath, 'utf8'), SOURCE);
  assert.deepEqual(await fs.readdir(options.temporaryRoot), []);
  if (process.platform === 'win32') {
    const wrapper = path.join(path.dirname(executable), 'openscad.com');
    if (await fs.stat(wrapper).catch(() => null)) assert.equal(await resolveExecutable(wrapper), executable);
  }
});
