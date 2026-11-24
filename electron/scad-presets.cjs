const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { validateScadOverrides } = require('./scad-parameters.cjs');

const MAX_PRESETS = 64;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function presetName(value) {
  if (typeof value !== 'string') throw new Error('プリセット名を入力してください');
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(name)) throw new Error('プリセット名は1〜80文字で入力してください');
  return name;
}

function requireRecord(value) {
  if (!value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    throw new Error('プリセットJSONの形式が不正です');
  }
  return value;
}

function decodeNumber(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!NUMBER_TEXT.test(text)) throw new Error('プリセットJSONの数値が不正です');
  return Number(text);
}

function decodeValue(value, type) {
  if (type === 'number') return decodeNumber(value);
  if (type === 'boolean' && typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (type === 'vector' && typeof value === 'string') {
    const text = value.trim();
    if (text.length > 4096 || !text.startsWith('[') || !text.endsWith(']')) throw new Error('プリセットJSONのベクトルが不正です');
    return text.slice(1, -1).split(',').map(decodeNumber);
  }
  return value;
}

function decodeCustomizerJson(text, parameters) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error('プリセットJSONは4 MiB以下で指定してください');
  let document;
  try { document = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('有効なJSONファイルを選んでください'); }
  requireRecord(document);
  if (document.fileFormatVersion !== '1' && document.fileFormatVersion !== 1) throw new Error('OpenSCAD CustomizerのJSON形式（バージョン1）を選んでください');
  const entries = Object.entries(requireRecord(document.parameterSets));
  if (!entries.length || entries.length > MAX_PRESETS) throw new Error(`1〜${MAX_PRESETS}件のプリセットを指定してください`);
  const definitions = new Map(parameters.map(parameter => [parameter.name, parameter]));
  return entries.map(([name, preset]) => {
    const values = Object.fromEntries(Object.entries(requireRecord(preset)).map(([key, value]) => [key, decodeValue(value, definitions.get(key)?.type)]));
    return { name: presetName(name), values: validateScadOverrides(parameters, values) };
  });
}

function encodeCustomizerJson(presets) {
  const parameterSets = Object.fromEntries(presets.map(preset => [preset.name,
    Object.fromEntries(Object.entries(preset.values).map(([name, value]) => [name, Array.isArray(value) ? `[${value.join(', ')}]` : String(value)])),
  ]));
  return JSON.stringify({ parameterSets, fileFormatVersion: '1' }, null, 2) + '\n';
}

async function readCustomizerJson(file) {
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_JSON_BYTES) throw new Error('プリセットJSONは4 MiB以下のファイルを選んでください');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('読み込み中にプリセットJSONが変更されました。再試行してください');
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function writeCustomizerJson(file, text) {
  const temporary = path.join(path.dirname(file), `.nine-scad-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.copyFile(temporary, file, constants.COPYFILE_EXCL);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function requirePresetId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('プリセットIDが不正です');
}

class ScadPresets {
  constructor(database) {
    this.database = database;
    // Keep presets when a model is unregistered and later added at the same path.
    database.exec(`CREATE TABLE IF NOT EXISTS scad_presets (
      model_id TEXT NOT NULL,
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      values_json TEXT NOT NULL CHECK (json_valid(values_json) AND json_type(values_json) = 'object'),
      updated_at INTEGER NOT NULL,
      UNIQUE (model_id, name)
    ) STRICT`);
    this.listRows = database.prepare('SELECT id, name, updated_at AS updatedAt FROM scad_presets WHERE model_id = ? ORDER BY name, id');
    this.readRows = database.prepare('SELECT name, values_json AS valuesJson FROM scad_presets WHERE model_id = ? ORDER BY name, id');
    this.findRow = database.prepare('SELECT id, name, values_json AS valuesJson, updated_at AS updatedAt FROM scad_presets WHERE model_id = ? AND id = ?');
    this.findName = database.prepare('SELECT id FROM scad_presets WHERE model_id = ? AND name = ?');
    this.countRows = database.prepare('SELECT count(*) AS count FROM scad_presets WHERE model_id = ?');
    this.insertRow = database.prepare('INSERT INTO scad_presets (model_id, id, name, values_json, updated_at) VALUES (?, ?, ?, ?, ?)');
    this.updateRow = database.prepare('UPDATE scad_presets SET name = ?, values_json = ?, updated_at = ? WHERE model_id = ? AND id = ?');
    this.deleteRow = database.prepare('DELETE FROM scad_presets WHERE model_id = ? AND id = ? AND updated_at = ?');
  }

  list(modelId) { return this.listRows.all(modelId).map(row => ({ ...row })); }

  get(modelId, id) {
    requirePresetId(id);
    const row = this.findRow.get(modelId, id);
    if (!row) throw new Error('このモデルのプリセットが見つかりません');
    return { id: row.id, name: row.name, updatedAt: row.updatedAt, values: JSON.parse(row.valuesJson) };
  }

  save(modelId, id, name, values, parameters) {
    const label = presetName(name);
    const serialized = JSON.stringify(validateScadOverrides(parameters, values));
    if (id == null) {
      const createdId = randomUUID();
      this.addRows(modelId, [{ id: createdId, name: label, serialized }]);
      return createdId;
    }
    const previous = this.get(modelId, id);
    const duplicate = this.findName.get(modelId, label);
    if (duplicate && duplicate.id !== id) throw new Error('同じ名前のプリセットがすでにあります');
    this.updateRow.run(label, serialized, Math.max(Date.now(), previous.updatedAt + 1), modelId, id);
    return id;
  }

  addRows(modelId, rows) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.countRows.get(modelId).count + rows.length > MAX_PRESETS) throw new Error(`1モデルに保存できるプリセットは${MAX_PRESETS}件までです`);
      for (const row of rows) {
        if (this.findName.get(modelId, row.name)) throw new Error('同じ名前のプリセットがすでにあります');
        this.insertRow.run(modelId, row.id, row.name, row.serialized, Date.now());
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  apply(modelId, id, parameters) {
    return validateScadOverrides(parameters, this.get(modelId, id).values);
  }

  remove(modelId, { id, updatedAt }) {
    requirePresetId(id);
    const result = this.deleteRow.run(modelId, id, updatedAt);
    if (!result.changes) throw new Error('プリセットが更新または削除されました。一覧を開き直してください');
  }

  toCustomizerJson(modelId) {
    const rows = this.readRows.all(modelId);
    if (!rows.length) throw new Error('出力するプリセットがありません');
    return encodeCustomizerJson(rows.map(row => ({ name: row.name, values: JSON.parse(row.valuesJson) })));
  }

  fromCustomizerJson(modelId, text, parameters) {
    const entries = decodeCustomizerJson(text, parameters);
    this.addRows(modelId, entries.map(({ name, values }) => ({ id: randomUUID(), name, serialized: JSON.stringify(values) })));
    return entries.length;
  }
}

module.exports = { ScadPresets, readCustomizerJson, writeCustomizerJson };
