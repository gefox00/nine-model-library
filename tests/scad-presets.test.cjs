const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { promisify } = require('node:util');
const { detectOpenScad } = require('../electron/scad-engine.cjs');
const { parseScadParameters } = require('../electron/scad-parameters.cjs');
const { ScadPresets, readCustomizerJson, writeCustomizerJson } = require('../electron/scad-presets.cjs');

const SOURCE = `width = 12; // [8:2:32]
enabled = false;
label = "Default";
size = [1, 2, 3];
/* [Hidden] */
internal = true;
cube([width, enabled ? size[1] : 1, size[2]]);
echo(width, enabled, label, size);
`;
const PARAMETERS = parseScadParameters(SOURCE);
const DATA = { width: 24, enabled: true, label: 'Case, "A"', size: [1, 3, 5] };

function memoryStore(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  return new ScadPresets(database);
}

test('presets persist in SQLite across restarts and are scoped to the model', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-scad-presets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'library.sqlite');
  let database = new DatabaseSync(file);
  let presets = new ScadPresets(database);
  const id = presets.save('model-a', null, ' Repeatable ', DATA, PARAMETERS);
  const saved = presets.list('model-a')[0];
  assert.equal(saved.name, 'Repeatable');
  assert.equal(saved.id, id);
  assert.deepEqual(presets.list('model-b'), []);
  assert.throws(() => presets.apply('model-b', id, PARAMETERS), /見つかりません/);
  database.close();

  database = new DatabaseSync(file);
  try {
    presets = new ScadPresets(database);
    assert.deepEqual(presets.apply('model-a', id, PARAMETERS), DATA);
    assert.equal(database.prepare('SELECT count(*) AS rows FROM scad_presets').get().rows, 1);
  } finally { database.close(); }
});

test('duplicate names and stale removal cannot overwrite a newer preset', t => {
  const presets = memoryStore(t);
  const id = presets.save('model-a', null, 'Config', { width: 20 }, PARAMETERS);
  const previous = presets.get('model-a', id);
  assert.throws(() => presets.save('model-a', null, 'config', {}, PARAMETERS), /同じ名前/);
  assert.equal(presets.save('model-a', id, 'Config revised', { width: 22 }, PARAMETERS), id);
  assert.throws(() => presets.remove('model-a', previous), /更新または削除/);
  assert.deepEqual(presets.apply('model-a', id, PARAMETERS), { width: 22 });
  presets.remove('model-a', presets.get('model-a', id));
  assert.deepEqual(presets.list('model-a'), []);
});

test('saving and applying validate publicly configurable values against the current SCAD', t => {
  const presets = memoryStore(t);
  assert.throws(() => presets.save('model-a', null, 'Hidden', { internal: true }, PARAMETERS), /公開されていない/);
  assert.throws(() => presets.save('model-a', null, 'Invalid', { width: 21 }, PARAMETERS), /指定刻み/);
  const id = presets.save('model-a', null, 'Before model edit', { width: 22 }, PARAMETERS);
  const changed = parseScadParameters(SOURCE.replace('[8:2:32]', '[8:2:20]'));
  assert.throws(() => presets.apply('model-a', id, changed), /指定範囲/);
  assert.deepEqual(presets.apply('model-a', id, PARAMETERS), { width: 22 });
});

test('OpenSCAD JSON includes only named used parameter overrides and round trips their types', t => {
  const presets = memoryStore(t);
  presets.save('model-a', null, 'Japanese 日本語', DATA, PARAMETERS);
  presets.save('model-a', null, 'SCAD defaults', {}, PARAMETERS);
  const json = presets.toCustomizerJson('model-a');
  assert.deepEqual(JSON.parse(json), {
    parameterSets: {
      'Japanese 日本語': { width: '24', enabled: 'true', label: 'Case, "A"', size: '[1, 3, 5]' },
      'SCAD defaults': {},
    },
    fileFormatVersion: '1',
  });
  assert.equal(presets.fromCustomizerJson('model-b', '\uFEFF' + json, PARAMETERS), 2);
  const copied = presets.list('model-b').find(preset => preset.name === 'Japanese 日本語');
  assert.deepEqual(presets.apply('model-b', copied.id, PARAMETERS), DATA);
});

test('import is all-or-none on duplicates or invalid parameter payloads', t => {
  const presets = memoryStore(t);
  const existing = presets.save('model-a', null, 'Existing', { width: 20 }, PARAMETERS);
  const build = parameterSets => JSON.stringify({ parameterSets, fileFormatVersion: '1' });
  assert.throws(() => presets.fromCustomizerJson('model-a', build({ New: { width: '28' }, existing: { width: '24' } }), PARAMETERS), /同じ名前/);
  assert.throws(() => presets.fromCustomizerJson('model-a', build({ New: { width: '28' }, Bad: { width: '2+2' } }), PARAMETERS), /数値が不正/);
  assert.throws(() => presets.fromCustomizerJson('model-a', build({ Bad: { internal: 'true' } }), PARAMETERS), /公開されていない/);
  assert.deepEqual(presets.list('model-a').map(row => row.id), [existing]);
});

test('JSON file reading rejects an unrelated or oversized input before loading bytes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-scad-preset-json-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'large.json');
  await fs.writeFile(file, '');
  await fs.truncate(file, 4 * 1024 * 1024 + 1);
  await assert.rejects(readCustomizerJson(file), /4 MiB/);
});

test('JSON file writing never replaces an existing sidecar', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-scad-preset-write-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json');
  await writeCustomizerJson(file, 'first preset file');
  await assert.rejects(writeCustomizerJson(file, 'replacement'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), 'first preset file');
  assert.deepEqual(await fs.readdir(directory), ['fixture.json']);
});

test('an exported preset sets typed parameters in the installed OpenSCAD CLI', async t => {
  const executable = await detectOpenScad();
  if (!executable) return t.skip('OpenSCAD was not found');
  const presets = memoryStore(t);
  presets.save('model-a', null, 'Production.01', DATA, PARAMETERS);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-scad-preset-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'fixture.scad');
  const json = path.join(directory, 'fixture.json');
  const output = path.join(directory, 'fixture.echo');
  await Promise.all([fs.writeFile(source, SOURCE), fs.writeFile(json, presets.toCustomizerJson('model-a'))]);
  await promisify(execFile)(executable, ['-o', output, '-p', json, '-P', 'Production.01', source], { timeout: 20000, windowsHide: true });
  const result = await fs.readFile(output, 'utf8');
  assert.match(result, /ECHO: 24, true, .+Case, .+A/, result);
  assert.match(result, /\[1, 3, 5\]/, result);
});
