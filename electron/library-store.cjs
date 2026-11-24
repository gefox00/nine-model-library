const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const schemaVersion = 1;
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
      readThumbnail: database.prepare('SELECT mime, bytes, revision FROM model_thumbnails WHERE model_id = ?'),
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
      if (!existingTables(database).some(table => table.name === 'library_meta') ||
        database.prepare('SELECT value FROM library_meta WHERE key = ?').get('schema_version')?.value !== schemaVersion) {
        throw new Error('対応していないSQLiteライブラリ形式です');
      }
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

  apply({ models, folders, settings, excludedPaths, thumbnails }) {
    if (!models.size && !folders.size && !settings.size && !excludedPaths.size && !thumbnails.size) return;
    transaction(this.database, () => {
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

  readThumbnail(id, revision) {
    const row = this.statements.readThumbnail.get(id);
    if (!row || (revision !== undefined && revision !== row.revision)) return null;
    return `data:${row.mime};base64,${Buffer.from(row.bytes).toString('base64')}`;
  }

  close() { this.database.close(); }
}

module.exports = { LibraryStore, parseThumbnail };
