const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session } = require('electron');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const fs = require('node:fs/promises');
const { Library } = require('./library.cjs');
const { chooseRelinkModel } = require('./model-relink-dialog.cjs');
const { BambuPrint } = require('./bambu-print.cjs');
const { ThumbnailBatch, abortError } = require('./thumbnail-batch.cjs');
const { ThumbnailBatchStore } = require('./thumbnail-batch-store.cjs');
const { ThumbnailWorker } = require('./thumbnail-worker.cjs');
const scad = require('./scad-engine.cjs');
const { ScadPresets, readCustomizerJson, writeCustomizerJson } = require('./scad-presets.cjs');
const formats = require('../shared/formats.json');
const { assertMemoryBudget, effectivePreviewBudget } = require('../shared/preview-memory.cjs');
const { THUMBNAIL_SCHEME, LIBRARY_SESSION, thumbnailRequestHandler } = require('./thumbnail-protocol.cjs');
const { libraryDataDirectory } = require('../shared/app-profile.cjs');
const { productName } = require('../package.json');

app.setName(productName);
protocol.registerSchemesAsPrivileged([{ scheme: THUMBNAIL_SCHEME, privileges: { standard: true } }]);
let library;
let mainWindow;
let thumbnailBatch;
let bambuPrint;
let activeModelRead = null;
const scadRenders = new Map();
let scadExport = null;
let quitting = false;

function previewBudget(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'memoryBudgetMiB' && key !== 'detailed') ||
      (options.detailed !== undefined && typeof options.detailed !== 'boolean')) {
    throw new Error('読み込み設定が不正です');
  }
  const settings = library.data.settings;
  const configured = options.detailed ? settings.memoryBudgetMiB : effectivePreviewBudget(settings);
  return options.memoryBudgetMiB === undefined ? configured : Math.min(configured, assertMemoryBudget(options.memoryBudgetMiB));
}

function assertPreviewAvailable() {
  if (library.data.settings.lightweightPreview && (thumbnailBatch.isRunning() || bambuPrint.isPreparing())) {
    throw new Error('サムネイル生成または印刷準備が終わってからプレビューしてください');
  }
}

function runModelRead(requestId, read) {
  if (requestId !== undefined) validateRequestId(requestId);
  const previous = activeModelRead;
  previous?.controller.abort(abortError('別のモデルを選択しました'));
  const operation = { requestId, controller: new AbortController(), promise: null };
  activeModelRead = operation;
  operation.promise = (async () => {
    try {
      await previous?.promise.catch(() => {});
      operation.controller.signal.throwIfAborted();
      return await read(operation.controller.signal);
    } finally { if (activeModelRead === operation) activeModelRead = null; }
  })();
  return operation.promise;
}

async function startApp() {
  const profile = libraryDataDirectory(app.getPath('appData'), process.env.NINE_DATA_DIR);
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  if (!process.env.NINE_TEST_MODE && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  await app.whenReady();
  await boot();
}

startApp().catch(error => {
  dialog.showErrorBox(`${productName} を起動できません`, error.message);
  app.quit();
});

function handle(name, callback) {
  ipcMain.handle(`nine:${name}`, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('許可されていない呼び出しです');
    return callback(...args);
  });
}

async function boot() {
  library = new Library(app.getPath('userData'));
  await library.init({ backgroundScan: true });
  session.fromPartition(LIBRARY_SESSION).protocol.handle(THUMBNAIL_SCHEME,
    thumbnailRequestHandler((id, revision) => library.readThumbnailImage(id, revision)));
  bambuPrint = new BambuPrint({
    getExecutable: () => library.data.settings.bambuPath,
    getOpenScad: () => library.data.settings.openscadPath,
    getItem: id => library.item(id),
    captureSource: id => library.captureFileSource(id),
    validateSource: (id, source) => library.assertThumbnailSource(id, source, '印刷準備'),
    renderScad: scad.writeScadPrintStl,
    stagingRoot: path.join(app.getPath('temp'), 'nine-model-library-print'),
  });
  registerScadPresetIpc(new ScadPresets(library.database));
  library.on('state', state => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nine:state', state);
  });
  const batchStore = new ThumbnailBatchStore(library.database, app.getPath('userData'));
  const thumbnailWorker = new ThumbnailWorker({
    createWindow: () => new BrowserWindow({
      width: 512, height: 512, show: false, skipTaskbar: true, focusable: false,
      backgroundColor: '#101820', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'thumbnail-preload.cjs'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
    }),
    loadWindow: worker => {
      const devUrl = process.env.VITE_DEV_SERVER_URL;
      return devUrl && !app.isPackaged
        ? worker.loadURL(new URL('thumbnail.html', devUrl.endsWith('/') ? devUrl : `${devUrl}/`).href)
        : worker.loadFile(path.join(__dirname, '../dist/thumbnail.html'));
    },
    readInput: readThumbnailInput,
  });
  thumbnailWorker.registerIpc(ipcMain);
  thumbnailBatch = new ThumbnailBatch({
    generate: (item, options) => thumbnailWorker.generate(item, options),
    saveThumbnail: (item, result, { signal }) => library.saveThumbnail(item.id, result.dataUrl, item, { signal }),
    persistReport: report => batchStore.save(report),
  });
  thumbnailBatch.on('state', state => {
    if (state.status !== 'running') thumbnailWorker.close();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nine:thumbnail-batch', state);
  });
  await thumbnailBatch.restoreFrom(() => batchStore.load());
  handle('getState', () => library.getState());
  handle('addFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '3Dファイルを登録', properties: ['openFile', 'multiSelections'], filters: [
      { name: '3Dモデル', extensions: formats.flatMap(format => format.extensions) },
      ...formats.map(format => ({ name: format.label || format.id.toUpperCase(), extensions: format.extensions })),
    ] });
    return result.canceled ? library.getState() : library.importPaths(result.filePaths);
  });
  handle('addFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '自動登録するフォルダを選択', properties: ['openDirectory'] });
    return result.canceled ? library.getState() : library.addFolder(result.filePaths[0]);
  });
  handle('removeFolder', id => library.removeFolder(id));
  handle('rescan', () => library.rescan());
  handle('updateItem', (id, patch) => library.updateItem(id, patch));
  handle('removeItem', id => library.removeItem(id));
  handle('relinkModel', id => chooseRelinkModel(library, dialog, mainWindow, id));
  handle('copyModel', async id => {
    const source = await library.captureFileSource(id);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `「${source.name}」のコピー先`, properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return library.copyModel(id, result.filePaths[0], source);
  });
  handle('trashModel', async id => {
    const source = await library.captureFileSource(id);
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'ファイルをゴミ箱に移す',
      message: `「${source.name}」をゴミ箱に移しますか？`,
      detail: `対象ファイル:\n${source.path}\n\nライブラリからも削除されます。戻す場合はWindowsのゴミ箱から復元してください。`,
      buttons: ['キャンセル', 'ゴミ箱に移す'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return null;
    return library.trashModel(id, source, file => shell.trashItem(file));
  });
  handle('readModel', (id, options = {}, requestId) => {
    assertPreviewAvailable();
    const memoryBudgetMiB = previewBudget(options);
    return runModelRead(requestId, signal => library.readModel(id, { memoryBudgetMiB, signal }));
  });
  handle('readEmbedded3mfImage', (id, requestId) => {
    assertPreviewAvailable();
    return runModelRead(requestId, async signal => {
      if (library.item(id).format !== '3mf') return null;
      const source = await library.captureFileSource(id);
      const { readEmbedded3mfImage } = require('./three-mf-thumbnail.cjs');
      const image = await readEmbedded3mfImage(source.path, signal);
      signal.throwIfAborted();
      await library.assertThumbnailSource(id, source, 'プレビュー画像の読み込み');
      return image;
    });
  });
  handle('cancelModelRead', requestId => {
    validateRequestId(requestId);
    if (!activeModelRead || activeModelRead.requestId !== requestId) return false;
    activeModelRead.controller.abort(abortError('読み込みを中止しました'));
    return true;
  });
  handle('updateSettings', patch => library.updateSettings(patch));
  handle('chooseOpenScad', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'OpenSCADの実行ファイル', defaultPath: library.data.settings.openscadPath || await scad.detectOpenScad() || undefined,
      properties: ['openFile'], filters: [{ name: 'OpenSCAD', extensions: ['exe', 'com'] }],
    });
    if (result.canceled || !result.filePaths.length) return library.getState();
    return library.setOpenScadPath(await scad.resolveExecutable(result.filePaths[0]));
  });
  handle('getScadParameters', async id => {
    requireScadItem(id);
    const source = await library.captureFileSource(id);
    const result = await scad.readScadParameters(source.path);
    await library.assertThumbnailSource(id, source, 'パラメータ読み取り');
    return result;
  });
  handle('renderScad', async (id, values, requestId, options = {}) => {
    requireScadItem(id);
    assertPreviewAvailable();
    validateRequestId(requestId);
    const memoryBudgetMiB = previewBudget(options);
    if (scadRenders.has(requestId)) throw new Error('同じOpenSCAD要求がすでに実行中です');
    if (scadRenders.size >= 8) throw new Error('OpenSCADの待機中要求が多すぎます。前の処理を中止してください');
    const controller = new AbortController();
    scadRenders.set(requestId, controller);
    try {
      const source = await library.captureFileSource(id);
      const result = await scad.renderScad({ executable: library.data.settings.openscadPath,
        sourcePath: source.path, values: values ?? {}, memoryBudgetMiB, signal: controller.signal });
      controller.signal.throwIfAborted();
      await library.assertThumbnailSource(id, source, 'プレビュー生成');
      return result;
    } finally { scadRenders.delete(requestId); }
  });
  handle('cancelScadRender', requestId => {
    validateRequestId(requestId);
    const controller = scadRenders.get(requestId);
    if (!controller) return false;
    controller.abort(abortError('OpenSCADのプレビューを中止しました'));
    return true;
  });
  handle('exportScad', async (id, options) => {
    requireScadItem(id);
    if (scadExport) throw new Error('OpenSCADの書き出しはすでに実行中です');
    const controller = new AbortController();
    scadExport = controller;
    try {
      const source = await library.captureFileSource(id);
      await scad.prepareScadExport(source.path, options);
      const choice = await dialog.showOpenDialog(mainWindow, { title: 'STLの書き出し先', properties: ['openDirectory'] });
      if (choice.canceled || !choice.filePaths.length) return null;
      return await scad.exportScad({ executable: library.data.settings.openscadPath, sourcePath: source.path,
        directory: choice.filePaths[0], values: options?.values, selector: options?.selector, parts: options?.parts,
        signal: controller.signal, validateSource: () => library.assertThumbnailSource(id, source, 'STL書き出し'),
        onProgress: state => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nine:scad-export', state);
        } });
    } finally { scadExport = null; }
  });
  handle('cancelScadExport', () => {
    if (!scadExport) return false;
    scadExport.abort(abortError('STL書き出しを中止しました'));
    return true;
  });
  handle('saveThumbnail', (id, dataUrl, expectedSource) => library.saveThumbnail(id, dataUrl, expectedSource));
  handle('getThumbnailBatch', () => thumbnailBatch.getState());
  handle('generateThumbnail', async id => {
    const item = library.item(id);
    if (thumbnailBatch.isRunning()) throw new Error('サムネイル生成はすでに実行中です');
    if (library.data.settings.lightweightPreview && bambuPrint.isPreparing()) throw new Error('印刷準備が終わってからサムネイルを生成してください');
    if (item.missing) throw new Error('元ファイルが見つからないため、サムネイルを生成できません');
    const stat = await fs.stat(item.path).catch(() => { throw new Error('元ファイルが見つからないか、読み取れないため、サムネイルを生成できません'); });
    if (!stat.isFile()) throw new Error('対象がファイルではないため、サムネイルを生成できません');
    if (library.item(id) !== item) throw new Error('ライブラリの登録が変更されました。ファイルを選び直してください');
    if (library.data.settings.lightweightPreview && bambuPrint.isPreparing()) throw new Error('印刷準備が終わってからサムネイルを生成してください');
    return thumbnailBatch.start({ items: [item], memoryBudgetMiB: effectivePreviewBudget(library.data.settings), overwrite: true, scope: 'single' });
  });
  handle('startThumbnailBatch', options => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'overwrite') ||
        (options.overwrite !== undefined && typeof options.overwrite !== 'boolean')) throw new Error('サムネイル生成の指定が不正です');
    if (library.data.settings.lightweightPreview && bambuPrint.isPreparing()) throw new Error('印刷準備が終わってからサムネイルを生成してください');
    return thumbnailBatch.start({ items: library.data.items, memoryBudgetMiB: effectivePreviewBudget(library.data.settings), overwrite: options.overwrite ?? false });
  });
  handle('stopThumbnailBatch', () => thumbnailBatch.stop());
  handle('importPaths', paths => library.importPaths(paths));
  handle('revealItem', id => { shell.showItemInFolder(library.item(id).path); return true; });
  handle('chooseBambu', async () => {
    const defaultPath = library.data.settings.bambuPath || await library.detectBambu() || undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Bambu Studioの実行ファイル',
      defaultPath,
      properties: ['openFile'],
      filters: [{ name: '実行ファイル', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths.length) return library.getState();
    await bambuPrint.requireExecutable(result.filePaths[0]);
    return library.setBambu(result.filePaths[0]);
  });
  handle('getBambuPrintStatus', () => bambuPrint.getStatus());
  const prepareBambuPrint = (id, values) => {
    if (library.data.settings.lightweightPreview && thumbnailBatch.isRunning()) {
      throw new Error('サムネイル生成が終わってから印刷準備を開始してください');
    }
    return bambuPrint.prepare(id, values);
  };
  handle('prepareBambuPrint', prepareBambuPrint);
  handle('cancelBambuPrintPreparation', () => bambuPrint.cancel());
  handle('openBambu', id => prepareBambuPrint(id));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}

function requireScadItem(id) {
  const item = library.item(id);
  if (item.format !== 'scad' || path.extname(item.path).toLowerCase() !== '.scad') throw new Error('OpenSCADファイルを選んでください');
  return item;
}

function registerScadPresetIpc(presets) {
  async function currentParameters(id, action) {
    requireScadItem(id);
    const source = await library.captureFileSource(id);
    const { parameters } = await scad.readScadParameters(source.path);
    if (!parameters.length) throw new Error('現在のSCADにはプリセットに使える公開パラメータがありません');
    await library.assertThumbnailSource(id, source, action);
    return { parameters, source };
  }

  handle('listScadPresets', id => {
    requireScadItem(id);
    return presets.list(id);
  });
  handle('saveScadPreset', async (id, presetId, name, values) => {
    const { parameters, source } = await currentParameters(id, 'プリセット保存');
    return library.enqueue(async () => {
      await library.assertThumbnailSource(id, source, 'プリセット保存');
      const savedId = presets.save(id, presetId, name, values, parameters);
      return { id: savedId, presets: presets.list(id) };
    });
  });
  handle('applyScadPreset', async (id, presetId) => {
    const { parameters } = await currentParameters(id, 'プリセット適用');
    return { values: presets.apply(id, presetId, parameters) };
  });
  handle('removeScadPreset', async (id, presetId) => {
    requireScadItem(id);
    const preset = presets.get(id, presetId);
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'プリセットを削除', message: `「${preset.name}」を削除しますか？`,
      buttons: ['キャンセル', '削除'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return null;
    return library.enqueue(() => {
      requireScadItem(id);
      presets.remove(id, preset);
      return { presets: presets.list(id) };
    });
  });
  handle('exportScadPresets', async id => {
    const item = requireScadItem(id);
    const json = presets.toCustomizerJson(id);
    const base = path.basename(item.name, path.extname(item.name));
    const choice = await dialog.showSaveDialog(mainWindow, { title: 'OpenSCADプリセットJSONの保存先',
      defaultPath: `${base}.json`, filters: [{ name: 'OpenSCAD Customizer JSON', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return null;
    const destination = path.extname(choice.filePath) ? choice.filePath : `${choice.filePath}.json`;
    if (path.extname(destination).toLowerCase() !== '.json') throw new Error('保存先の拡張子は.jsonにしてください');
    try { await writeCustomizerJson(destination, json); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('同じ名前のJSONがすでにあります。別の名前で保存してください');
      throw new Error('プリセットJSONを保存できません。保存先の権限と空き容量を確認してください');
    }
    return { saved: true };
  });
  handle('importScadPresets', async id => {
    requireScadItem(id);
    const choice = await dialog.showOpenDialog(mainWindow, { title: 'OpenSCADプリセットJSONを読み込む',
      properties: ['openFile'], filters: [{ name: 'OpenSCAD Customizer JSON', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePaths.length) return null;
    const json = await readCustomizerJson(choice.filePaths[0]);
    const { parameters, source } = await currentParameters(id, 'プリセット読み込み');
    return library.enqueue(async () => {
      await library.assertThumbnailSource(id, source, 'プリセット読み込み');
      const count = presets.fromCustomizerJson(id, json, parameters);
      return { count, presets: presets.list(id) };
    });
  });
}

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw new Error('要求IDが不正です');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: productName, width: 1520, height: 960, minWidth: 1100, minHeight: 720,
    backgroundColor: '#0b1015', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), partition: LIBRARY_SESSION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { if (process.platform !== 'darwin') app.quit(); });
  if (process.env.VITE_DEV_SERVER_URL && !app.isPackaged) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

async function readThumbnailInput(item, { memoryBudgetMiB, signal }) {
  await library.assertThumbnailSource(item.id, item);
  if (item.format === 'scad') {
    const { bytes } = await scad.renderScad({ executable: library.data.settings.openscadPath, sourcePath: item.path,
      values: {}, memoryBudgetMiB, signal });
    const name = `${path.basename(item.name, path.extname(item.name))}.stl`;
    return { name, bytes, memoryBudgetMiB };
  }
  const bytes = await library.readModel(item.id, { memoryBudgetMiB, signal });
  return { name: item.name, bytes, memoryBudgetMiB };
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (library && !quitting) {
    event.preventDefault(); quitting = true;
    const pendingRead = activeModelRead;
    pendingRead?.controller.abort(abortError('アプリを終了しています'));
    for (const controller of scadRenders.values()) controller.abort(abortError('アプリを終了しています'));
    scadExport?.abort(abortError('アプリを終了しています'));
    bambuPrint?.cancel();
    Promise.allSettled([pendingRead?.promise, thumbnailBatch?.close(), bambuPrint?.waitForIdle(), scad.waitForScadIdle()])
      .then(() => library.close()).catch(error => console.error('Library close failed:', error.message)).finally(() => app.quit());
  }
});
