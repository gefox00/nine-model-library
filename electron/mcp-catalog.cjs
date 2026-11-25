const { statSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const formats = require('../shared/formats.json');
const { productName } = require('../package.json');

const MODEL_FORMATS = Object.freeze(formats.map(format => format.id));
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;
const MAX_OFFSET = 1_000_000;
const MAX_THUMBNAIL_BYTES = 187_500;

const MODEL_COLUMNS = `m.id, m.name, m.format, m.size, m.modified_at, m.added_at,
  m.missing, m.favorite, m.tags_json,
  EXISTS (SELECT 1 FROM model_thumbnails AS t WHERE t.model_id = m.id) AS has_thumbnail`;

class McpCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'McpCatalogError';
    this.code = code;
  }
}

function requireModelId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) {
    throw new McpCatalogError('INVALID_ARGUMENT', 'Specify a model ID returned by search_models.');
  }
}

function pageBounds(offset = 0, limit = DEFAULT_PAGE_SIZE) {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET ||
      !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new McpCatalogError('INVALID_ARGUMENT', `Use an offset from 0 to ${MAX_OFFSET} and a limit from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return { offset, limit };
}

function nextPage(rowCount, offset, limit) {
  return rowCount > limit && offset + limit <= MAX_OFFSET ? offset + limit : null;
}

function searchText(value) {
  return typeof value === 'string' ? value.normalize('NFC').toLowerCase() : '';
}

function parseTags(text) {
  try {
    const tags = JSON.parse(text);
    return Array.isArray(tags) ? tags.filter(tag => typeof tag === 'string') : [];
  } catch { return []; }
}

function modelSummary(row) {
  return {
    id: row.id,
    name: row.name,
    format: row.format === 'stp' ? 'step' : row.format,
    size: row.size,
    modifiedAt: row.modified_at,
    addedAt: row.added_at,
    missing: Boolean(row.missing),
    favorite: Boolean(row.favorite),
    tags: parseTags(row.tags_json),
    hasThumbnail: Boolean(row.has_thumbnail),
  };
}

function hasTable(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

class McpCatalog {
  #databasePath;

  constructor(databasePath) {
    if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
      throw new McpCatalogError('INVALID_DATABASE_PATH', `Configure an absolute path to the ${productName} SQLite database.`);
    }
    this.#databasePath = databasePath;
  }

  #read(operation) {
    let database;
    try {
      if (!statSync(this.#databasePath).isFile()) {
        throw new McpCatalogError('INVALID_DATABASE_PATH', `Configure the ${productName} SQLite database file.`);
      }
      database = new DatabaseSync(this.#databasePath, { readOnly: true });
      database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 500;');
      const version = hasTable(database, 'library_meta') &&
        database.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get()?.value;
      if (version !== 1 && version !== 2) {
        throw new McpCatalogError('UNSUPPORTED_DATABASE', `This ${productName} database schema is unsupported.`);
      }
      return operation(database);
    } catch (error) {
      if (error instanceof McpCatalogError) throw error;
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw new McpCatalogError('DATABASE_NOT_FOUND', `Library database not found. Open ${productName} once, or check the configured database.`);
      }
      // Extended SQLite result codes retain the primary code in the lower byte.
      if ([5, 6].includes(error.errcode & 0xff)) {
        throw new McpCatalogError('DATABASE_BUSY', 'The library database is busy. Retry the request.');
      }
      throw new McpCatalogError('DATABASE_UNAVAILABLE', 'The library database could not be read. Check the configured database and try again.');
    } finally { database?.close(); }
  }

  searchModels({ query = '', format, missing, favorite, offset, limit } = {}) {
    const page = pageBounds(offset, limit);
    if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH || query.includes('\0')) {
      throw new McpCatalogError('INVALID_ARGUMENT', `Use a query with at most ${MAX_QUERY_LENGTH} characters.`);
    }
    if (format !== undefined && !MODEL_FORMATS.includes(format) && format !== 'stp') {
      throw new McpCatalogError('INVALID_ARGUMENT', 'Use a supported model format.');
    }
    if ((missing !== undefined && typeof missing !== 'boolean') || (favorite !== undefined && typeof favorite !== 'boolean')) {
      throw new McpCatalogError('INVALID_ARGUMENT', 'Use boolean missing and favorite filters.');
    }
    const predicates = [];
    const parameters = [];
    const term = searchText(query.trim());
    if (term) {
      predicates.push(`(instr(nine_search_text(m.name), ?) > 0 OR EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(m.tags_json) THEN m.tags_json ELSE '[]' END) AS tag
        WHERE tag.type = 'text' AND instr(nine_search_text(tag.value), ?) > 0))`);
      parameters.push(term, term);
    }
    if (format === 'step' || format === 'stp') predicates.push("m.format IN ('step', 'stp')");
    else if (format !== undefined) { predicates.push('m.format = ?'); parameters.push(format); }
    if (missing !== undefined) { predicates.push('m.missing = ?'); parameters.push(Number(missing)); }
    if (favorite !== undefined) { predicates.push('m.favorite = ?'); parameters.push(Number(favorite)); }

    return this.#read(database => {
      if (term) database.function('nine_search_text', { deterministic: true }, searchText);
      const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
      const rows = database.prepare(`SELECT ${MODEL_COLUMNS} FROM models AS m ${where}
        ORDER BY m.modified_at DESC, m.id LIMIT ? OFFSET ?`).all(...parameters, page.limit + 1, page.offset);
      return { models: rows.slice(0, page.limit).map(modelSummary), nextOffset: nextPage(rows.length, page.offset, page.limit) };
    });
  }

  getModel(id, { includeNotes = false, includePath = false } = {}) {
    requireModelId(id);
    return this.#read(database => {
      const detailColumns = [];
      if (includeNotes === true) detailColumns.push('m.notes');
      if (includePath === true) detailColumns.push('m.path');
      const details = detailColumns.length ? ', ' + detailColumns.join(', ') : '';
      const row = database.prepare(`SELECT ${MODEL_COLUMNS}${details} FROM models AS m WHERE m.id = ?`).get(id);
      if (!row) return null;
      const model = modelSummary(row);
      if (includeNotes === true) model.notes = row.notes;
      if (includePath === true) model.path = row.path;
      return model;
    });
  }

  listScadPresets(id, { offset, limit } = {}) {
    requireModelId(id);
    const page = pageBounds(offset, limit);
    return this.#read(database => {
      const model = database.prepare('SELECT format FROM models WHERE id = ?').get(id);
      if (!model) throw new McpCatalogError('MODEL_NOT_FOUND', 'The model is no longer registered in the library.');
      if (model.format !== 'scad') throw new McpCatalogError('WRONG_MODEL_FORMAT', 'Select an OpenSCAD model.');
      if (!hasTable(database, 'scad_presets')) return { presets: [], nextOffset: null };
      const rows = database.prepare(`SELECT id, name, updated_at, values_json FROM scad_presets
        WHERE model_id = ? ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`).all(id, page.limit + 1, page.offset);
      const presets = rows.slice(0, page.limit).map(row => ({
        id: row.id, name: row.name, updatedAt: row.updated_at, values: JSON.parse(row.values_json),
      }));
      return { presets, nextOffset: nextPage(rows.length, page.offset, page.limit) };
    });
  }

  readThumbnail(id) {
    requireModelId(id);
    return this.#read(database => {
      const thumbnail = database.prepare(`SELECT t.mime, t.bytes FROM model_thumbnails AS t
        JOIN models AS m ON m.id = t.model_id
        WHERE t.model_id = ? AND t.mime IN ('image/png', 'image/jpeg', 'image/webp')
        AND length(t.bytes) BETWEEN 1 AND ?`).get(id, MAX_THUMBNAIL_BYTES);
      return thumbnail ? { mime: thumbnail.mime, bytes: thumbnail.bytes } : null;
    });
  }
}

module.exports = { McpCatalog, McpCatalogError, MODEL_FORMATS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_QUERY_LENGTH, MAX_OFFSET };
