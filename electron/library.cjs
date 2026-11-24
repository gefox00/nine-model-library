const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { resolvePreviewLimits, normalizeMemoryBudget, assertMemoryBudget, PREVIEW_MEMORY_CONFIG } = require('../shared/preview-memory.cjs');

let formats;
try { formats = require('../shared/formats.json'); }
catch { formats = [{ id: 'stl', extensions: ['stl'] }, { id: 'step', extensions: ['step', 'stp'] }, { id: '3mf', extensions: ['3mf'] }]; }
const formatByExtension = new Map(formats.flatMap(f => f.extensions.map(e => [e.toLowerCase(), f.id])));
const normalize = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
const idFor = value => crypto.createHash('sha256').update(normalize(value)).digest('hex').slice(0, 24);
const isInside = (target, directory) => normalize(target) === normalize(directory) || normalize(target).startsWith(normalize(directory) + path.sep.toLowerCase());
const formatFor = file => formatByExtension.get(path.extname(file).slice(1).toLowerCase());
const freshData = () => ({ schemaVersion: 1, items: [], folders: [], settings: { bambuPath: '', memoryBudgetMiB: normalizeMemoryBudget(undefined) }, excludedPaths: [] });
function assertModelSizeAllowed(size, memoryBudgetMiB) {
  assertMemoryBudget(memoryBudgetMiB);
  const limit = resolvePreviewLimits(memoryBudgetMiB).fileBytes;
  if (size > limit) {
    const hard = limit >= PREVIEW_MEMORY_CONFIG.hardLimits.fileBytes;
    const guidance = hard ? 'この実装上限はメモリ設定では変更できません。Bambu Studioで開いてください。' : '「設定と連携」→「プレビューメモリ」で予算を増やしてください。';
    throw new Error(`入力ファイルは ${Math.ceil(size / 1024 / 1024)} MiB で、${hard ? '実装上' : '現在'}の上限 ${Math.floor(limit / 1024 / 1024)} MiB を超えています。${guidance}`);
  }
  return limit;
}

class Library extends EventEmitter {
  constructor(dataDir, options = {}) {
    super();
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'library.json');
    this.data = freshData();
    this.status = { scanning: false, message: '' };
    this.watchers = [];
    this.queue = Promise.resolve();
    this.options = options;
    this.closed = false;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.items) || !Array.isArray(parsed.folders)) throw new Error('ライブラリの保存形式を読み込めません');
      this.data = { ...freshData(), ...parsed, settings: { ...freshData().settings, ...parsed.settings } };
      this.data.settings.memoryBudgetMiB = normalizeMemoryBudget(this.data.settings.memoryBudgetMiB);
      this.data.excludedPaths = Array.isArray(parsed.excludedPaths) ? parsed.excludedPaths : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`ライブラリを読み込めません。元データは保持しています: ${error.message}`);
    }
    if (!this.data.settings.bambuPath) {
      this.data.settings.bambuPath = await this.detectBambu();
    }
    await this.rescan();
    await this.startWatchers();
    return this;
  }

  getState() {
    return structuredClone({ items: this.data.items, folders: this.data.folders, settings: this.data.settings, status: this.status,
      system: { totalMemoryMiB: Math.floor(os.totalmem() / 1024 / 1024), availableMemoryMiB: Math.floor(os.freemem() / 1024 / 1024) } });
  }

  notify() { if (!this.closed) this.emit('state', this.getState()); }

  enqueue(callback) {
    const result = this.queue.then(callback);
    this.queue = result.catch(() => {});
    return result;
  }

  async persist() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.data, null, 2), 'utf8');
    // Same-directory rename keeps a half-written JSON file from replacing the library.
    await fs.rename(temporary, this.file);
    this.notify();
  }

  async detectBambu() {
    const { ProgramFiles, ProgramW6432, LOCALAPPDATA } = process.env;
    const installRoots = [
      ProgramW6432,
      ProgramFiles,
      LOCALAPPDATA && path.join(LOCALAPPDATA, 'Programs'),
      process.env['ProgramFiles(x86)'],
    ].filter(candidate => candidate && path.isAbsolute(candidate));
    const candidates = [...new Set(installRoots)].map(root => path.join(root, 'Bambu Studio', 'bambu-studio.exe'));
    for (const file of candidates) {
      try { if ((await fs.stat(file)).isFile()) return file; } catch { /* Try the next install location. */ }
    }
    return '';
  }

  ignored(file) {
    return isInside(file, this.dataDir) || /(?:^|[\\/])(?:node_modules|\.git|\.svn)(?:[\\/]|$)/.test(file);
  }

  async upsert(file, { explicit = false } = {}) {
    const absolute = path.resolve(file);
    const format = formatFor(absolute);
    if (!format || this.ignored(absolute)) return false;
    const key = normalize(absolute);
    if (explicit) this.data.excludedPaths = this.data.excludedPaths.filter(p => p !== key);
    else if (this.data.excludedPaths.includes(key)) return false;
    let stat;
    try { stat = await fs.stat(absolute); }
    catch (error) { if (error.code === 'ENOENT') return this.markMissing(absolute); throw error; }
    if (!stat.isFile()) return this.markMissing(absolute);
    const id = idFor(absolute);
    const previous = this.data.items.find(item => item.id === id);
    const modifiedAt = stat.mtime.toISOString();
    if (previous) {
      const changed = previous.modifiedAt !== modifiedAt || previous.size !== stat.size || previous.missing;
      if (changed) {
        Object.assign(previous, { name: path.basename(absolute), path: absolute, format, size: stat.size, modifiedAt, missing: false });
        delete previous.thumbnail;
      }
      return Boolean(changed);
    }
    this.data.items.push({ id, name: path.basename(absolute), path: absolute, format, size: stat.size, modifiedAt,
      addedAt: new Date().toISOString(), missing: false, favorite: false, tags: [], notes: '' });
    return true;
  }

  markMissing(file) {
    const item = this.data.items.find(value => value.id === idFor(file));
    if (item && !item.missing) { item.missing = true; return true; }
    return false;
  }

  async walk(directory) {
    if (this.ignored(directory)) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) {
        this.status.message = `読み取れないフォルダがあります: ${directory}`;
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (this.closed) break;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || this.ignored(file)) continue;
      if (entry.isDirectory()) await this.walk(file);
      else if (entry.isFile() && formatFor(file)) {
        try { await this.upsert(file); }
        catch (error) { this.status.message = `読み取りを保留: ${path.basename(file)} (${error.code || error.message})`; }
      }
    }
  }

  rescan() {
    return this.enqueue(async () => {
      this.status = { scanning: true, message: 'フォルダを確認しています…' };
      this.notify();
      try {
        this.status.message = '';
        for (const item of this.data.items) {
          try { await this.upsert(item.path); }
          catch (error) { this.status.message = `読み取りを保留: ${item.name} (${error.code || error.message})`; }
        }
        for (const folder of this.data.folders) await this.walk(folder.path);
        await this.persist();
      } finally { this.status.scanning = false; this.notify(); }
      return this.getState();
    });
  }

  async startWatchers() {
    await Promise.all(this.watchers.map(watcher => watcher.close()));
    this.watchers = [];
    if (this.closed || !this.data.folders.length || this.options.watch === false) return;
    const { watch } = await import('chokidar');
    const watcher = watch(this.data.folders.map(folder => folder.path), {
      ignoreInitial: true,
      ignored: file => this.ignored(file),
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: this.options.stabilityThreshold ?? 600, pollInterval: 100 },
      atomic: true,
    });
    this.watchers.push(watcher);
    const change = file => {
      if (!formatFor(file) || this.closed) return;
      this.enqueue(async () => { if (await this.upsert(file)) await this.persist(); })
        .catch(error => { this.status.message = `自動登録を保留: ${error.message}`; this.notify(); });
    };
    watcher.on('add', change).on('change', change).on('unlink', file => {
      this.enqueue(async () => { if (this.markMissing(file)) await this.persist(); })
        .catch(error => { this.status.message = error.message; this.notify(); });
    }).on('error', error => { this.status.message = `監視エラー: ${error.message}`; this.notify(); });
    await new Promise((resolve, reject) => { watcher.once('ready', resolve); watcher.once('error', reject); });
    // Reconcile changes that happened between the first scan and watcher readiness.
    await this.rescan();
  }

  async addFolder(directory) {
    const absolute = path.resolve(directory);
    if (!(await fs.stat(absolute)).isDirectory()) throw new Error('フォルダを選んでください');
    if (this.ignored(absolute)) throw new Error('このフォルダは監視対象にできません');
    await this.enqueue(async () => {
      if (!this.data.folders.some(folder => normalize(folder.path) === normalize(absolute))) {
        this.data.folders.push({ id: idFor(absolute), path: absolute });
        await this.persist();
      }
    });
    await this.startWatchers();
    // startWatchers performs a final scan; also scan when watching is disabled in tests.
    if (this.options.watch === false) await this.rescan();
    return this.getState();
  }

  async removeFolder(id) {
    await this.enqueue(async () => {
      this.data.folders = this.data.folders.filter(folder => folder.id !== id);
      await this.persist();
    });
    await this.startWatchers();
    return this.getState();
  }

  async importPaths(paths) {
    if (!Array.isArray(paths) || paths.length > 10000 || paths.some(file => typeof file !== 'string')) throw new Error('ファイル一覧が不正です');
    const directories = [];
    await this.enqueue(async () => {
      for (const file of paths) {
        const stat = await fs.stat(file);
        if (stat.isDirectory()) directories.push(file);
        else if (formatFor(file)) await this.upsert(file, { explicit: true });
      }
      await this.persist();
    });
    for (const directory of directories) await this.addFolder(directory);
    return this.getState();
  }

  item(id) {
    if (typeof id !== 'string') throw new Error('ファイルIDが不正です');
    const item = this.data.items.find(value => value.id === id);
    if (!item) throw new Error('ライブラリにファイルが見つかりません');
    return item;
  }

  updateItem(id, patch) {
    return this.enqueue(async () => {
      const item = this.item(id);
      if (!patch || typeof patch !== 'object') throw new Error('更新内容が不正です');
      if (typeof patch.favorite === 'boolean') item.favorite = patch.favorite;
      if (typeof patch.notes === 'string') item.notes = patch.notes.slice(0, 20000);
      if (Array.isArray(patch.tags)) item.tags = [...new Set(patch.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
      await this.persist();
      return this.getState();
    });
  }

  removeItem(id) {
    return this.enqueue(async () => {
      const item = this.item(id);
      const key = normalize(item.path);
      if (!this.data.excludedPaths.includes(key)) this.data.excludedPaths.push(key);
      this.data.items = this.data.items.filter(value => value.id !== id);
      await this.persist();
      return this.getState();
    });
  }

  async captureFileSource(id) {
    const item = this.item(id);
    if (item.missing) throw new Error('元のファイルが見つかりません。ライブラリを更新してください');
    const source = { id: item.id, name: item.name, path: item.path, size: item.size,
      modifiedAt: item.modifiedAt, addedAt: item.addedAt };
    const stat = await fs.stat(source.path).catch(() => { throw new Error('元のファイルが見つからないか、読み取れません'); });
    source.fileIdentity = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
    await this.assertThumbnailSource(id, source, 'ファイル操作');
    return source;
  }

  async copyModel(id, directory, expectedSource) {
    const source = expectedSource || await this.captureFileSource(id);
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('コピー先のフォルダを選んでください');
    const destinationDirectory = path.resolve(directory);
    const directoryStat = await fs.stat(destinationDirectory).catch(() => { throw new Error('コピー先フォルダが見つからないか、アクセスできません'); });
    if (!directoryStat.isDirectory()) throw new Error('コピー先にはフォルダを選んでください');
    const destination = path.join(destinationDirectory, path.basename(source.path));
    await this.assertThumbnailSource(id, source, 'コピー');
    try {
      // COPYFILE_EXCL is required even after checking for duplicates: another
      // process could create the destination while the folder chooser is open.
      await fs.copyFile(source.path, destination, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`コピー先に同じ名前のファイルがあります。上書きはしていません: ${destination}`);
      if (error.code === 'ENOENT') throw new Error('元ファイルまたはコピー先フォルダが見つかりません');
      if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw new Error('コピーできません。アクセス権、ファイルの使用状況、コピー先を確認してください');
      if (error.code === 'ENOSPC') throw new Error('コピー先の空き容量が不足しています');
      throw new Error(`コピーできませんでした: ${error.message}`);
    }
    return { copied: true, path: destination };
  }

  trashModel(id, expectedSource, trash) {
    return this.enqueue(async () => {
      if (typeof trash !== 'function') throw new Error('ゴミ箱への移動処理を利用できません');
      const item = await this.assertThumbnailSource(id, expectedSource, 'ゴミ箱への移動');
      try { await trash(item.path); }
      catch (error) { throw new Error(`ゴミ箱へ移動できませんでした。ファイルはライブラリに残しています: ${error.message || error}`); }
      this.data.items = this.data.items.filter(value => value.id !== id);
      // Restoring the file into a watched folder must register it again.
      this.data.excludedPaths = this.data.excludedPaths.filter(value => value !== normalize(item.path));
      try { await this.persist(); }
      catch (error) {
        this.notify();
        throw new Error(`ファイルはゴミ箱へ移動済みですが、ライブラリの保存に失敗しました: ${error.message}`);
      }
      return this.getState();
    });
  }

  updateSettings(patch) {
    return this.enqueue(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => key !== 'memoryBudgetMiB')) {
        throw new Error('設定の更新内容が不正です');
      }
      if (Object.hasOwn(patch, 'memoryBudgetMiB')) {
        assertMemoryBudget(patch.memoryBudgetMiB);
        this.data.settings.memoryBudgetMiB = patch.memoryBudgetMiB;
        await this.persist();
      }
      return this.getState();
    });
  }

  async readModel(id, options = {}) {
    const item = this.item(id);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('読み込み設定が不正です');
    const memoryBudgetMiB = options.memoryBudgetMiB ?? this.data.settings.memoryBudgetMiB;
    assertMemoryBudget(memoryBudgetMiB);
    options.signal?.throwIfAborted();
    const handle = await fs.open(item.path, 'r').catch(() => { throw new Error('元のファイルが見つからないか、読み取れません'); });
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('対象がファイルではありません');
      assertModelSizeAllowed(stat.size, memoryBudgetMiB);
      // A bounded buffer prevents a concurrently growing file from bypassing preflight.
      const bytes = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, offset, Math.min(bytes.length - offset, 4 * 1024 * 1024), offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      options.signal?.throwIfAborted();
      assertModelSizeAllowed(after.size, memoryBudgetMiB);
      if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        throw new Error('読み込み中にファイルが更新されました。保存が完了してから再試行してください');
      }
      return bytes;
    } finally { await handle.close(); }
  }

  async assertThumbnailSource(id, expectedSource, operation = 'サムネイル保存') {
    const item = this.item(id);
    if (!expectedSource || typeof expectedSource !== 'object' || typeof expectedSource.path !== 'string' ||
        typeof expectedSource.modifiedAt !== 'string' || !Number.isFinite(expectedSource.size)) {
      throw new Error('元ファイル情報が不正です');
    }
    if (item.missing || normalize(item.path) !== normalize(expectedSource.path) ||
        item.size !== expectedSource.size || item.modifiedAt !== expectedSource.modifiedAt ||
        (expectedSource.addedAt !== undefined && item.addedAt !== expectedSource.addedAt)) {
      throw new Error(`元ファイルまたは登録情報が更新されたため、${operation}を中止しました`);
    }
    const stat = await fs.stat(item.path).catch(() => { throw new Error(`元ファイルが見つからないため、${operation}を中止しました`); });
    if (!stat.isFile() || stat.size !== expectedSource.size || stat.mtime.toISOString() !== expectedSource.modifiedAt) {
      throw new Error(`元ファイルが更新されたため、${operation}を中止しました`);
    }
    const identity = expectedSource.fileIdentity;
    if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.birthtimeMs !== identity.birthtimeMs)) {
      throw new Error(`元ファイルが別のファイルに置き換わったため、${operation}を中止しました`);
    }
    // Re-check registration after the asynchronous stat when called outside the save queue.
    if (this.item(id) !== item) throw new Error('ライブラリの登録が変更されました');
    return item;
  }

  saveThumbnail(id, dataUrl, expectedSource, options = {}) {
    return this.enqueue(async () => {
      options.signal?.throwIfAborted();
      const item = expectedSource ? await this.assertThumbnailSource(id, expectedSource) : this.item(id);
      if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 250000) throw new Error('サムネイル形式またはサイズが不正です');
      options.signal?.throwIfAborted();
      item.thumbnail = dataUrl;
      await this.persist();
      return dataUrl;
    });
  }

  setBambu(file) {
    return this.enqueue(async () => {
      if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.exe' || !(await fs.stat(file)).isFile()) throw new Error('Bambu Studioの実行ファイルを選んでください');
      this.data.settings.bambuPath = path.resolve(file);
      await this.persist();
      return this.getState();
    });
  }

  async close() {
    this.closed = true;
    await Promise.all(this.watchers.map(watcher => watcher.close()));
    this.watchers = [];
    await this.queue;
    this.removeAllListeners();
  }
}

module.exports = { Library, formatFor, normalize, idFor, assertModelSizeAllowed };
