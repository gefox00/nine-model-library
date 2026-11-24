const { randomUUID } = require('node:crypto');
const { abortError } = require('./thumbnail-batch.cjs');

const MAX_DATA_URL_LENGTH = 250000;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/;

class ThumbnailWorker {
  #worker = null;
  #task = null;
  #reading = null;

  constructor({ createWindow, loadWindow, readInput }) {
    this.createWindow = createWindow;
    this.loadWindow = loadWindow;
    this.readInput = readInput;
  }

  registerIpc(ipcMain) {
    ipcMain.handle('nine-thumb:ready', (event) => {
      const worker = this.#authenticate(event);
      worker.ready = true;
      this.#dispatch();
      return true;
    });
    ipcMain.handle('nine-thumb:input', async (event, jobId) => {
      const task = this.#requireTask(event, jobId);
      if (task.inputRequested) throw new Error('モデルはすでに読み込み済みです');
      task.inputRequested = true;
      const input = await this.#read(task);
      task.signal.throwIfAborted();
      if (this.#task !== task) throw abortError();
      task.inputDelivered = true;
      return input;
    });
    ipcMain.handle('nine-thumb:complete', (event, jobId, result) => {
      const task = this.#requireTask(event, jobId);
      const dataUrl = result?.dataUrl;
      if (!task.inputDelivered || typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL_LENGTH || !IMAGE_DATA_URL.test(dataUrl)) {
        throw new Error('生成したサムネイルが不正です');
      }
      this.#finish(task, null, { dataUrl });
      return true;
    });
    ipcMain.handle('nine-thumb:fail', (event, jobId, message, discard) => {
      const task = this.#requireTask(event, jobId);
      const error = new Error(typeof message === 'string' && message ? message.slice(0, 4000) : 'サムネイルを生成できませんでした');
      if (discard === true) this.#discard(error);
      else this.#finish(task, error);
      return true;
    });
  }

  #authenticate(event) {
    const worker = this.#worker;
    if (!worker || worker.window.isDestroyed() || event.sender !== worker.window.webContents ||
        event.senderFrame !== worker.window.webContents.mainFrame) throw new Error('許可されていないサムネイル処理です');
    return worker;
  }

  #requireTask(event, jobId) {
    this.#authenticate(event);
    const task = this.#task;
    if (!task || !task.dispatched || task.id !== jobId || task.signal.aborted) {
      throw new Error('許可されていないサムネイル処理です');
    }
    return task;
  }

  generate(item, { memoryBudgetMiB, signal }) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      if (this.#task) throw new Error('前のサムネイル処理が終了していません');
      const abort = () => this.#discard(signal.reason || abortError());
      const controller = new AbortController();
      this.#task = { id: randomUUID(), item, memoryBudgetMiB, signal: controller.signal, controller, batchSignal: signal,
        abort, resolve, reject };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!this.#worker) this.#open();
        this.#dispatch();
      } catch (error) { this.#discard(error); }
    });
  }

  #open() {
    const window = this.createWindow();
    const worker = { window, ready: false };
    this.#worker = worker;
    const contents = window.webContents;
    window.removeMenu();
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('render-process-gone', (_event, details) => {
      this.#discard(new Error(`生成用プロセスが終了しました（${details.reason}）`), worker);
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.#discard(new Error(`生成画面を読み込めません: ${description}`), worker);
    });
    window.on('closed', () => this.#discard(new Error('生成用ウィンドウが閉じられました'), worker));
    Promise.resolve(this.loadWindow(window)).catch(error => this.#discard(error, worker));
  }

  #dispatch() {
    const worker = this.#worker;
    const task = this.#task;
    if (!worker?.ready || !task || task.dispatched) return;
    task.dispatched = true;
    try {
      worker.window.webContents.send('nine-thumb:job', task.id);
    } catch (error) { this.#discard(error, worker); }
  }

  async #read(task) {
    const previous = this.#reading;
    const pending = (async () => {
      // A crashed window can leave a filesystem syscall in flight. Wait for
      // it to release the previous input before allocating the next one.
      if (previous) await previous.catch(() => {});
      task.signal.throwIfAborted();
      return this.readInput(task.item, { memoryBudgetMiB: task.memoryBudgetMiB, signal: task.signal });
    })();
    this.#reading = pending;
    try {
      return await pending;
    } finally {
      if (this.#reading === pending) this.#reading = null;
    }
  }

  #finish(task, error, result) {
    this.#task = null;
    task.batchSignal.removeEventListener('abort', task.abort);
    if (error) {
      task.controller.abort(error);
      task.reject(error);
    } else task.resolve(result);
  }

  #discard(error, worker = this.#worker) {
    // A late load/crash event from an older window must not affect the next job.
    if (worker !== this.#worker) return;
    this.#worker = null;
    if (this.#task) this.#finish(this.#task, error);
    if (worker && !worker.window.isDestroyed()) worker.window.destroy();
  }

  close() { this.#discard(abortError()); }
}

module.exports = { ThumbnailWorker };
