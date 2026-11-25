const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { Library } = require('../electron/library.cjs');
const { ScadPresets } = require('../electron/scad-presets.cjs');
const { readScadParameters } = require('../electron/scad-engine.cjs');
const { libraryDatabasePath } = require('../electron/mcp-server.cjs');
const { productName, version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const packagedDirectory = process.env.NINE_MCP_PACKAGED_DIR;
const sourceEntry = path.join(root, 'electron', 'mcp-server.cjs');
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nine-mcp-stdio-'));
  const profile = path.join(directory, 'profile');
  const database = path.join(profile, 'library.sqlite3');
  const source = path.join(directory, 'fixture-box.scad');
  const library = new Library(profile, { watch: false });
  const close = async () => {
    await library.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    await fs.writeFile(source, 'width = 10;\ncube(width);\n');
    await library.init();
    const { items: [item] } = await library.importPaths([source]);
    await library.updateItem(item.id, { favorite: true, tags: ['fixture'], notes: 'Synthetic private note' });
    await library.saveThumbnail(item.id, `data:image/png;base64,${imageData}`);
    const { parameters } = await readScadParameters(source);
    new ScadPresets(library.database).save(item.id, undefined, 'Fixture size', { width: 16 }, parameters);
    return { database, source, library, id: item.id, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function connect(database, { allowPrivateMetadata = false, mode = 'legacy' } = {}) {
  const directory = packagedDirectory ? path.resolve(root, packagedDirectory) : null;
  const command = directory ? path.join(directory, `${productName}.exe`) : process.execPath;
  const entry = directory ? path.join(directory, 'resources', 'app.asar', 'electron', 'mcp-server.cjs') : sourceEntry;
  const args = [entry, '--database', database];
  if (allowPrivateMetadata) args.push('--allow-private-metadata');
  const transport = new StdioClientTransport({ command, args, stderr: 'inherit',
    env: directory ? { ELECTRON_RUN_AS_NODE: '1' } : undefined });
  const client = new Client({ name: 'nine-fixture-client', version: '1.0.0' }, { versionNegotiation: { mode } });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

const call = (client, name, args) => client.callTool({ name, arguments: args }, { timeout: 5000 });

test('legacy MCP client discovers and calls the four read-only tools while the writer stays open', { timeout: 20000 }, async () => {
  const data = await fixture();
  let client;
  try {
    client = await connect(data.database);
    assert.equal(client.getServerVersion().version, version);
    assert.match(client.getNegotiatedProtocolVersion(), /^2025-/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_model', 'get_thumbnail', 'list_scad_presets', 'search_models']);
    assert(tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));

    const search = await call(client, 'search_models', { query: 'fixture', format: 'scad', favorite: true, limit: 1 });
    assert.equal(search.isError, undefined);
    assert.deepEqual(JSON.parse(search.content[0].text), search.structuredContent);
    const { models, nextOffset } = search.structuredContent;
    assert.deepEqual(models.map(model => model.id), [data.id]);
    assert.equal(nextOffset, null);
    assert(!Object.hasOwn(models[0], 'notes') && !Object.hasOwn(models[0], 'path'));
    assert.deepEqual((await call(client, 'get_model', { id: data.id })).structuredContent.model, models[0]);
    assert.equal((await call(client, 'get_model', { id: data.id, includeNotes: true })).isError, true);
    assert.equal((await call(client, 'get_model', { id: data.id, includePath: true })).isError, true);

    const { presets } = (await call(client, 'list_scad_presets', { id: data.id })).structuredContent;
    assert.equal(presets[0].name, 'Fixture size');
    assert.deepEqual(presets[0].values, { width: 16 });
    assert.deepEqual((await call(client, 'get_thumbnail', { id: data.id })).content,
      [{ type: 'image', mimeType: 'image/png', data: imageData }]);

    await data.library.updateItem(data.id, { tags: ['new-tag'] });
    assert.deepEqual((await call(client, 'get_model', { id: data.id })).structuredContent.model.tags, ['new-tag']);
    await fs.unlink(data.source);
    assert.equal((await call(client, 'list_scad_presets', { id: data.id })).structuredContent.presets.length, 1);
  } finally { try { await client?.close(); } finally { await data.close(); } }
});

test('current MCP client can request opted-in metadata explicitly and rejects unbounded arguments', { timeout: 20000 }, async () => {
  const data = await fixture();
  let client;
  try {
    client = await connect(data.database, { allowPrivateMetadata: true, mode: 'auto' });
    assert.equal(client.getServerVersion().name, 'nine-model-library');
    assert.equal(client.getServerVersion().title, productName);
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    const get = (args = {}) => call(client, 'get_model', { id: data.id, ...args });
    assert(!Object.hasOwn((await get()).structuredContent.model, 'notes'));
    const { model } = (await get({ includeNotes: true, includePath: true })).structuredContent;
    assert.equal(model.notes, 'Synthetic private note');
    assert.equal(model.path, data.source);
    assert.equal((await call(client, 'search_models', { limit: 51 })).isError, true);
    assert.equal((await get({ id: '../not-a-model' })).isError, true);
  } finally { try { await client?.close(); } finally { await data.close(); } }
});

test('MCP on an absent database gives a safe tool error without creating a file', { timeout: 20000 }, async () => {
  const data = await fixture();
  const missing = path.join(path.dirname(data.database), 'absent.sqlite3');
  let client;
  try {
    client = await connect(missing);
    assert.equal((await client.listTools()).tools.length, 4);
    const result = await call(client, 'search_models', {});
    assert.equal(result.isError, true);
    assert(!JSON.stringify(result).includes('absent.sqlite3'));
    await assert.rejects(fs.access(missing), { code: 'ENOENT' });
  } finally { try { await client?.close(); } finally { await data.close(); } }
});

test('MCP database resolution honors an explicit path, application override, then Windows app data', () => {
  const profile = path.join(root, 'synthetic-profile');
  const env = { APPDATA: profile, NINE_DATA_DIR: path.join(profile, 'isolated') };
  assert.equal(libraryDatabasePath('selected.sqlite3', env), path.resolve('selected.sqlite3'));
  assert.equal(libraryDatabasePath(undefined, env), path.join(env.NINE_DATA_DIR, 'library.sqlite3'));
  assert.equal(libraryDatabasePath(undefined, { APPDATA: profile }), path.join(profile, 'Nine Model Library', 'library.sqlite3'));
  assert.throws(() => libraryDatabasePath(undefined, {}));
});
