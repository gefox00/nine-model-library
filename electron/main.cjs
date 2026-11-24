const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { Library } = require('./library.cjs');
const { ThumbnailBatch, abortError } = require('./thumbnail-batch.cjs');
const scad = require('./scad-engine.cjs');
const formats = require('../shared/formats.json');

app.setName('Nine Model Library');
let library;
let mainWindow;
let thumbnailBatch;
let activeThumbnailWorker = null;
const scadRenders = new Map();
let scadExport = null;
let quitting = false;

if (process.env.NINE_DATA_DIR) app.setPath('userData', path.resolve(process.env.NINE_DATA_DIR));
const hasLock = process.env.NINE_TEST_MODE || app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox('Nine Model Library を起動できません', error.message);
    app.quit();
  });
}

function handle(name, callback) {
  ipcMain.handle(`nine:${name}`, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('許可されていない呼び出しです');
    return callback(...args);
  });
}

async function boot() {
  library = new Library(app.getPath('userData'));
  await library.init();
  library.on('state', state => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nine:state', state);
  });
  const batchReportFile = path.join(app.getPath('userData'), 'thumbnail-batch.json');
  thumbnailBatch = new ThumbnailBatch({
    generate: generateThumbnail,
    saveThumbnail: (item, result, { signal }) => library.saveThumbnail(item.id, result.dataUrl, item, { signal }),
    persistReport: async report => {
      const temporary = `${batchReportFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(report, null, 2), 'utf8');
      await fs.rename(temporary, batchReportFile);
    },
  });
  thumbnailBatch.on('state', state => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nine:thumbnail-batch', state);
  });
  try { await thumbnailBatch.restore(JSON.parse(await fs.readFile(batchReportFile, 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') thumbnailBatch.state.reportError = `前回の生成結果を読み込めません: ${error.message}`;
  }
  registerThumbnailWorkerIpc();
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
  handle('readModel', (id, options) => library.readModel(id, options));
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
  handle('renderScad', async (id, values, requestId) => {
    requireScadItem(id);
    validateScadRequestId(requestId);
    if (scadRenders.has(requestId)) throw new Error('同じOpenSCAD要求がすでに実行中です');
    if (scadRenders.size >= 8) throw new Error('OpenSCADの待機中要求が多すぎます。前の処理を中止してください');
    const controller = new AbortController();
    scadRenders.set(requestId, controller);
    try {
      const source = await library.captureFileSource(id);
      const result = await scad.renderScad({ executable: library.data.settings.openscadPath,
        sourcePath: source.path, values: values ?? {}, memoryBudgetMiB: library.data.settings.memoryBudgetMiB, signal: controller.signal });
      controller.signal.throwIfAborted();
      await library.assertThumbnailSource(id, source, 'プレビュー生成');
      return result;
    } finally { scadRenders.delete(requestId); }
  });
  handle('cancelScadRender', requestId => {
    validateScadRequestId(requestId);
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
    if (item.missing) throw new Error('元ファイルが見つからないため、サムネイルを生成できません');
    const stat = await fs.stat(item.path).catch(() => { throw new Error('元ファイルが見つからないか、読み取れないため、サムネイルを生成できません'); });
    if (!stat.isFile()) throw new Error('対象がファイルではないため、サムネイルを生成できません');
    if (library.item(id) !== item) throw new Error('ライブラリの登録が変更されました。ファイルを選び直してください');
    return thumbnailBatch.start({ items: [item], memoryBudgetMiB: library.data.settings.memoryBudgetMiB, overwrite: true, scope: 'single' });
  });
  handle('startThumbnailBatch', options => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'overwrite') ||
        (options.overwrite !== undefined && typeof options.overwrite !== 'boolean')) throw new Error('サムネイル生成の指定が不正です');
    return thumbnailBatch.start({ items: library.data.items, memoryBudgetMiB: library.data.settings.memoryBudgetMiB, overwrite: options.overwrite ?? false });
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
    return result.canceled ? library.getState() : library.setBambu(result.filePaths[0]);
  });
  handle('openBambu', async id => {
    const item = library.item(id);
    if (item.format === 'scad') throw new Error('OpenSCADソースはBambu Studioで開けません。STLに書き出してから開いてください');
    const executable = library.data.settings.bambuPath;
    if (!executable) throw new Error('設定でBambu Studioの実行ファイルを選んでください');
    await fs.access(executable).catch(() => { throw new Error('Bambu Studioが見つかりません。設定で実行ファイルを選び直してください'); });
    await fs.access(item.path).catch(() => { throw new Error('元の3Dファイルが見つかりません'); });
    // Keep the original project, including Bambu print profiles and plate settings.
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [item.path], { detached: true, stdio: 'ignore', shell: false });
      child.once('error', error => reject(new Error(`Bambu Studioを開けません: ${error.message}`)));
      child.once('spawn', () => { child.unref(); resolve({ opened: true }); });
    });
  });
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}

function requireScadItem(id) {
  const item = library.item(id);
  if (item.format !== 'scad' || path.extname(item.path).toLowerCase() !== '.scad') throw new Error('OpenSCADファイルを選んでください');
  return item;
}

function validateScadRequestId(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw new Error('OpenSCADの要求IDが不正です');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Nine Model Library', width: 1520, height: 960, minWidth: 1100, minHeight: 720,
    backgroundColor: '#0b1015', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
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

function authenticateThumbnailWorker(event) {
  const task = activeThumbnailWorker;
  if (!task || !task.window || task.window.isDestroyed() || event.sender !== task.window.webContents ||
      event.senderFrame !== task.window.webContents.mainFrame || task.signal.aborted ||
      thumbnailBatch.getState().status !== 'running') throw new Error('許可されていないサムネイル処理です');
  return task;
}

function registerThumbnailWorkerIpc() {
  ipcMain.handle('nine-thumb:input', async event => {
    const task = authenticateThumbnailWorker(event);
    if (task.inputRequested) throw new Error('モデルはすでに読み込み済みです');
    task.inputRequested = true;
    await library.assertThumbnailSource(task.item.id, task.item);
    let bytes;
    let displayItem = task.item;
    if (task.item.format === 'scad') {
      const rendered = await scad.renderScad({ executable: library.data.settings.openscadPath, sourcePath: task.item.path,
        values: {}, memoryBudgetMiB: task.memoryBudgetMiB, signal: task.signal });
      bytes = rendered.bytes;
      displayItem = { ...task.item, format: 'stl', name: `${path.basename(task.item.name, path.extname(task.item.name))}.stl` };
    } else bytes = await library.readModel(task.item.id, { memoryBudgetMiB: task.memoryBudgetMiB, signal: task.signal });
    task.signal.throwIfAborted();
    if (activeThumbnailWorker !== task) throw abortError();
    return { item: displayItem, bytes, memoryBudgetMiB: task.memoryBudgetMiB };
  });
  ipcMain.handle('nine-thumb:complete', (event, result) => {
    const task = authenticateThumbnailWorker(event);
    if (!task.inputRequested || !result || typeof result.dataUrl !== 'string' || result.dataUrl.length > 250000 ||
        !/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(result.dataUrl)) {
      throw new Error('生成したサムネイルが不正です');
    }
    task.finish(null, { dataUrl: result.dataUrl });
    return true;
  });
  ipcMain.handle('nine-thumb:fail', (event, message) => {
    const task = authenticateThumbnailWorker(event);
    task.finish(new Error(String(message || 'サムネイルを生成できませんでした').slice(0, 4000)));
    return true;
  });
}

function generateThumbnail(item, { memoryBudgetMiB, signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason || abortError()); return; }
    if (activeThumbnailWorker) { reject(new Error('前のサムネイル処理が終了していません')); return; }
    let settled = false;
    const task = { item, memoryBudgetMiB, signal, window: null, inputRequested: false };
    const abort = () => task.finish(signal.reason || abortError());
    task.finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (activeThumbnailWorker === task) activeThumbnailWorker = null;
      if (task.window && !task.window.isDestroyed()) task.window.destroy();
      if (error) reject(error); else resolve(result);
    };
    activeThumbnailWorker = task;
    signal.addEventListener('abort', abort, { once: true });
    try {
      const worker = new BrowserWindow({
        width: 512, height: 512, show: false, skipTaskbar: true, focusable: false,
        backgroundColor: '#101820', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'thumbnail-preload.cjs'), nodeIntegration: false,
          contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
      });
      task.window = worker;
      worker.removeMenu();
      worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      worker.webContents.on('will-navigate', event => event.preventDefault());
      worker.webContents.on('render-process-gone', (_event, details) => {
        task.finish(new Error(`生成用プロセスが終了しました（${details.reason}）`));
      });
      worker.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) task.finish(new Error(`生成画面を読み込めません: ${description}`));
      });
      worker.on('closed', () => task.finish(new Error('生成用ウィンドウが閉じられました')));
      const load = process.env.VITE_DEV_SERVER_URL && !app.isPackaged
        ? worker.loadURL(new URL('thumbnail.html', process.env.VITE_DEV_SERVER_URL.endsWith('/') ? process.env.VITE_DEV_SERVER_URL : `${process.env.VITE_DEV_SERVER_URL}/`).href)
        : worker.loadFile(path.join(__dirname, '../dist/thumbnail.html'));
      load.catch(error => task.finish(error));
    } catch (error) { task.finish(error); }
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (library && !quitting) {
    event.preventDefault(); quitting = true;
    for (const controller of scadRenders.values()) controller.abort(abortError('アプリを終了しています'));
    scadExport?.abort(abortError('アプリを終了しています'));
    Promise.resolve(thumbnailBatch?.close()).then(() => scad.waitForScadIdle()).then(() => library.close()).finally(() => app.quit());
  }
});
