const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const schemaVersion = 2;
const aliasSchema = `
  CREATE TABLE model_path_aliases (path_key TEXT PRIMARY KEY, model_id TEXT NOT NULL UNIQUE) STRICT;
`;
const schema = `
  CREATE TABLE library_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
  CREATE TABLE models (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, format TEXT NOT NULL,
    size INTEGER NOT NULL, modified_at TEXT NOT NULL, added_at TEXT NOT NULL,
    missing INTEGER NOT NULL, favorite INTEGER NOT NULL, notes TEXT NOT NULL,
    tags_json TEXT NOT NULL, extra_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE model_thumbnails (
    model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
    mime TEXT NOT NULL, bytes BLOB NOT NULL, revision TEXT NOT NULL
  ) STRICT;
  CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT NOT NULL, extra_json TEXT NOT NULL) STRICT;
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT;
  CREATE TABLE excluded_paths (path TEXT PRIMARY KEY) STRICT;
`;

function parseThumbnail(dataUrl) {
  const match = typeof dataUrl === 'string' && /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!match || dataUrl.length > 250000) throw new Error('サムネイル形式またはサイズが不正です');
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') };
}

function transaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* SQLite may have already rolled back. */ }
    throw error;
  }
}

function existingTables(database) {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
}

class LibraryStore {
  constructor(database) {
    this.database = database;
    this.statements = {
      model: database.prepare(`INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name, format = excluded.format,
        size = excluded.size, modified_at = excluded.modified_at, added_at = excluded.added_at,
        missing = excluded.missing, favorite = excluded.favorite, notes = excluded.notes,
        tags_json = excluded.tags_json, extra_json = excluded.extra_json`),
      folder: database.prepare(`INSERT INTO folders VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET path = excluded.path, extra_json = excluded.extra_json`),
      setting: database.prepare(`INSERT INTO settings VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`),
      exclude: database.prepare('INSERT OR IGNORE INTO excluded_paths VALUES (?)'),
      thumbnail: database.prepare(`INSERT INTO model_thumbnails VALUES (?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, revision = excluded.revision`),
      removeModel: database.prepare('DELETE FROM models WHERE id = ?'),
      removeFolder: database.prepare('DELETE FROM folders WHERE id = ?'),
      removeExclusion: database.prepare('DELETE FROM excluded_paths WHERE path = ?'),
      removeThumbnail: database.prepare('DELETE FROM model_thumbnails WHERE model_id = ?'),
      readThumbnailImage: database.prepare('SELECT mime, bytes FROM model_thumbnails WHERE model_id = ? AND revision = ?'),
      alias: database.prepare(`INSERT INTO model_path_aliases VALUES (?, ?)
        ON CONFLICT(path_key) DO UPDATE SET model_id = excluded.model_id`),
      removeAlias: database.prepare('DELETE FROM model_path_aliases WHERE path_key = ?'),
      relinkTarget: database.prepare('SELECT favorite, notes, tags_json, extra_json FROM models WHERE id = ?'),
      presetTable: database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'scad_presets'"),
    };
  }

  static async open(dataDir, readLegacy) {
    const database = new DatabaseSync(path.join(dataDir, 'library.sqlite3'));
    try {
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 500; PRAGMA synchronous = FULL;');
      const tables = existingTables(database);
      if (tables.length === 0) {
        // Read the pre-existing JSON before starting the write transaction. It is retained untouched.
        const legacy = await readLegacy(path.join(dataDir, 'library.json'));
        transaction(database, () => {
          if (existingTables(database).length) return; // Another opener completed migration first.
          database.exec(schema);
          database.exec(aliasSchema);
          const store = new LibraryStore(database);
          for (const model of legacy.items) {
            store.putModel(model);
            if (model.thumbnail) store.putThumbnail(model.id, { ...parseThumbnail(model.thumbnail), revision: 'legacy' });
          }
          for (const folder of legacy.folders) store.putFolder(folder);
          for (const [key, value] of Object.entries(legacy.settings)) store.putSetting(key, value);
          for (const key of legacy.excludedPaths) store.statements.exclude.run(key);
          database.prepare('INSERT INTO library_meta VALUES (?, ?)').run('schema_version', schemaVersion);
        });
      }
      if (!existingTables(database).some(table => table.name === 'library_meta')) {
        throw new Error('対応していないSQLiteライブラリ形式です');
      }
      const version = database.prepare('SELECT value FROM library_meta WHERE key = ?');
      if (version.get('schema_version')?.value === 1) {
        transaction(database, () => {
          if (version.get('schema_version')?.value !== 1) return;
          database.exec(aliasSchema);
          database.prepare('UPDATE library_meta SET value = ? WHERE key = ?').run(schemaVersion, 'schema_version');
        });
      }
      if (version.get('schema_version')?.value !== schemaVersion) throw new Error('対応していないSQLiteライブラリ形式です');
      database.exec('PRAGMA journal_mode = WAL;');
      return new LibraryStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  load() {
    const items = this.database.prepare(`SELECT models.*, model_thumbnails.revision AS thumbnail_revision
      FROM models LEFT JOIN model_thumbnails ON model_id = models.id ORDER BY models.rowid`).all().map(row => ({
      ...JSON.parse(row.extra_json), id: row.id, path: row.path, name: row.name, format: row.format,
      size: row.size, modifiedAt: row.modified_at, addedAt: row.added_at, missing: Boolean(row.missing),
      favorite: Boolean(row.favorite), notes: row.notes, tags: JSON.parse(row.tags_json),
      hasThumbnail: Boolean(row.thumbnail_revision), thumbnailRevision: row.thumbnail_revision,
    }));
    const folders = this.database.prepare('SELECT * FROM folders ORDER BY rowid').all()
      .map(row => ({ ...JSON.parse(row.extra_json), id: row.id, path: row.path }));
    const settings = Object.fromEntries(this.database.prepare('SELECT * FROM settings').all()
      .map(row => [row.key, JSON.parse(row.value_json)]));
    const excludedPaths = this.database.prepare('SELECT path FROM excluded_paths ORDER BY rowid').all().map(row => row.path);
    return { items, folders, settings, excludedPaths };
  }

  putModel(model) {
    const { id, path: modelPath, name, format, size, modifiedAt, addedAt, missing, favorite, notes, tags,
      thumbnail, hasThumbnail, thumbnailRevision, ...extra } = model;
    this.statements.model.run(id, modelPath, name, format, size, modifiedAt, addedAt, Number(Boolean(missing)),
      Number(Boolean(favorite)), notes ?? '', JSON.stringify(tags ?? []), JSON.stringify(extra));
  }

  putFolder({ id, path: folderPath, ...extra }) { this.statements.folder.run(id, folderPath, JSON.stringify(extra)); }
  putSetting(key, value) { this.statements.setting.run(key, JSON.stringify(value)); }
  putThumbnail(id, { mime, bytes, revision }) { this.statements.thumbnail.run(id, mime, bytes, revision); }

  readPathAliases() {
    return new Map(this.database.prepare('SELECT path_key, model_id FROM model_path_aliases').all()
      .map(({ path_key, model_id }) => [path_key, model_id]));
  }

  assertRelinkTargetReusable(id) {
    const row = this.statements.relinkTarget.get(id);
    if (row && (row.favorite || row.notes || JSON.parse(row.tags_json).length || Object.keys(JSON.parse(row.extra_json)).length)) {
      throw new Error('移動先の登録にお気に入り、タグ、メモ、または追加データがあります。再紐付けは中止しました');
    }
    if (this.statements.presetTable.get() &&
        this.database.prepare('SELECT 1 FROM scad_presets WHERE model_id = ? LIMIT 1').get(id)) {
      throw new Error('移動先には別のOpenSCADプリセットが保存されています。再紐付けは中止しました');
    }
  }

  apply({ models, folders, settings, excludedPaths, thumbnails, pathAliases }, { relinkTargetId } = {}) {
    if (!models.size && !folders.size && !settings.size && !excludedPaths.size && !thumbnails.size && !pathAliases.size) return;
    transaction(this.database, () => {
      if (relinkTargetId) this.assertRelinkTargetReusable(relinkTargetId);
      for (const [key, id] of pathAliases) if (!id) this.statements.removeAlias.run(key);
      for (const [key, id] of pathAliases) if (id) this.statements.alias.run(key, id);
      for (const [id, model] of models) {
        if (model) this.putModel(model);
        else this.statements.removeModel.run(id);
      }
      for (const [id, folder] of folders) {
        if (folder) this.putFolder(folder);
        else this.statements.removeFolder.run(id);
      }
      for (const [key, value] of settings) this.putSetting(key, value);
      for (const [key, excluded] of excludedPaths) {
        (excluded ? this.statements.exclude : this.statements.removeExclusion).run(key);
      }
      for (const [id, image] of thumbnails) {
        if (image) this.putThumbnail(id, image);
        else this.statements.removeThumbnail.run(id);
      }
    });
  }

  readThumbnailImage(id, revision) {
    const row = this.statements.readThumbnailImage.get(id, revision);
    return row ? { mime: row.mime, bytes: row.bytes } : null;
  }

  close() { this.database.close(); }
}

module.exports = { LibraryStore, parseThumbnail };
