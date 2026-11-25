const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { LibraryStore, parseThumbnail } = require('./library-store.cjs');
const { detectOpenScad } = require('./scad-engine.cjs');
const { resolvePreviewLimits, normalizeMemoryBudget, assertMemoryBudget, PREVIEW_MEMORY_CONFIG } = require('../shared/preview-memory.cjs');

let formats;
try { formats = require('../shared/formats.json'); }
catch { formats = [{ id: 'stl', extensions: ['stl'] }, { id: 'step', extensions: ['step', 'stp'] }, { id: '3mf', extensions: ['3mf'] }, { id: 'scad', extensions: ['scad'] }]; }
const formatByExtension = new Map(formats.flatMap(f => f.extensions.map(e => [e.toLowerCase(), f.id])));
const normalize = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
const idFor = value => crypto.createHash('sha256').update(normalize(value)).digest('hex').slice(0, 24);
const isInside = (target, directory) => normalize(target) === normalize(directory) || normalize(target).startsWith(normalize(directory) + path.sep.toLowerCase());
const formatFor = file => formatByExtension.get(path.extname(file).slice(1).toLowerCase());
const freshData = () => ({ items: [], folders: [], settings: { bambuPath: '', openscadPath: '',
  memoryBudgetMiB: normalizeMemoryBudget(undefined), lightweightPreview: true }, excludedPaths: [] });
const newChanges = () => ({ models: new Map(), folders: new Map(), settings: new Map(), excludedPaths: new Map(),
  thumbnails: new Map(), pathAliases: new Map(), newIdsByPath: new Map() });

function normalizedSettings(settings) {
  const result = { ...freshData().settings, ...settings };
  result.memoryBudgetMiB = normalizeMemoryBudget(result.memoryBudgetMiB);
  if (typeof result.lightweightPreview !== 'boolean') result.lightweightPreview = true;
  return result;
}

async function legacyData(file) {
  let contents;
  try { contents = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return freshData(); throw error; }
  const parsed = JSON.parse(contents);
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.items) || !Array.isArray(parsed.folders)) {
    throw new Error('ライブラリの保存形式を読み込めません');
  }
  return { items: parsed.items, folders: parsed.folders, settings: normalizedSettings(parsed.settings),
    excludedPaths: Array.isArray(parsed.excludedPaths) ? parsed.excludedPaths : [] };
}
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
    this.file = path.join(this.dataDir, 'library.sqlite3');
    this.data = freshData();
    this.itemsById = new Map();
    this.itemIdsByPath = new Map();
    this.pathAliases = new Map();
    this.aliasPathsById = new Map();
    this.excluded = new Set();
    this.status = { scanning: false, message: '' };
    this.watcher = null;
    this.watchedRoots = null;
    this.queue = Promise.resolve();
    this.watcherQueue = Promise.resolve();
    this.watcherLifetime = new AbortController();
    this.notificationTimer = null;
    this.options = options;
    this.closed = false;
  }

  async init({ backgroundScan = false } = {}) {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const store = await LibraryStore.open(this.dataDir, legacyData);
      if (this.closed) {
        store.close();
        throw new Error('ライブラリは終了処理中です');
      }
      this.store = store;
      this.data = this.store.load();
      this.itemsById = new Map(this.data.items.map(item => [item.id, item]));
      this.itemIdsByPath = new Map(this.data.items.map(item => [normalize(item.path), item.id]));
      this.pathAliases = this.store.readPathAliases();
      this.aliasPathsById = new Map([...this.pathAliases].map(([key, id]) => [id, key]));
      if (this.itemIdsByPath.size !== this.data.items.length ||
          [...this.pathAliases].some(([key, id]) => {
            const activeId = this.itemIdsByPath.get(key);
            const activePath = this.itemsById.get(id)?.path;
            return (activeId && activeId !== id) || (activePath && normalize(activePath) !== key);
          })) {
        throw new Error('ライブラリに重複または矛盾するパス登録があります');
      }
      this.excluded = new Set(this.data.excludedPaths);
      const changes = newChanges();
      const settings = normalizedSettings(this.data.settings);
      if (!settings.bambuPath) settings.bambuPath = await this.detectBambu();
      if (!settings.openscadPath) settings.openscadPath = (await detectOpenScad()) || '';
      if (this.closed) throw new Error('ライブラリは終了処理中です');
      for (const [key, value] of Object.entries(settings)) {
        if (!Object.is(value, this.data.settings[key])) changes.settings.set(key, value);
      }
      this.apply(changes);
      if (backgroundScan) {
        // A disconnected or slow watch folder must not prevent the window opening.
        this.status = { scanning: true, message: '監視フォルダを準備しています…' };
        this.initialScan = this.syncFiles().catch(error => {
          if (this.closed) return;
          this.status = { scanning: false, message: `初回のフォルダ確認を保留: ${error.message}` };
          this.notify();
        });
      } else {
        await this.syncFiles();
      }
      return this;
    } catch (error) {
      await this.close().catch(() => {});
      throw new Error(`ライブラリを読み込めません。元データは保持しています: ${error.message}`, { cause: error });
    }
  }

  async syncFiles() {
    // Reconcile only once, after the watcher is ready, so initial changes cannot be lost.
    await this.startWatchers();
    if (!this.closed && !this.watcher) await this.reconcile();
  }

  get database() { return this.store?.database; }

  getState() {
    return structuredClone({ items: this.data.items, folders: this.data.folders, settings: this.data.settings, status: this.status,
      system: { totalMemoryMiB: Math.floor(os.totalmem() / 1024 / 1024), availableMemoryMiB: Math.floor(os.freemem() / 1024 / 1024) } });
  }

  notify(state) {
    clearTimeout(this.notificationTimer);
    this.notificationTimer = null;
    if (!this.closed && this.listenerCount('state')) this.emit('state', state ?? this.getState());
  }

  scheduleNotification() {
    if (this.closed || this.notificationTimer || !this.listenerCount('state')) return;
    // Filesystem bursts or short thumbnail batches share a metadata snapshot.
    this.notificationTimer = setTimeout(() => this.notify(), 40);
    this.notificationTimer.unref();
  }

  enqueue(callback) {
    if (this.closed) return Promise.reject(new Error('ライブラリは終了処理中です'));
    const result = this.queue.then(callback);
    this.queue = result.catch(() => {});
    return result;
  }

  apply(changes, { notify = true, relinkTargetId } = {}) {
    if (!Object.values(changes).some(rows => rows.size)) return;
    this.store.apply(changes, { relinkTargetId });
    let removedModel = false;
    for (const [id, model] of changes.models) {
      const stored = this.itemsById.get(id);
      const previousKey = stored && normalize(stored.path);
      const currentKey = model && normalize(model.path);
      if (previousKey && previousKey !== currentKey && this.itemIdsByPath.get(previousKey) === id) {
        this.itemIdsByPath.delete(previousKey);
      }
      if (!model) {
        removedModel = this.itemsById.delete(id) || removedModel;
      } else if (stored) {
        Object.assign(stored, model);
      } else {
        this.itemsById.set(id, model);
        this.data.items.push(model);
      }
      if (currentKey) this.itemIdsByPath.set(currentKey, id);
    }
    if (removedModel) this.data.items = this.data.items.filter(model => this.itemsById.has(model.id));
    if (changes.folders.size) {
      this.data.folders = this.data.folders.filter(folder => !changes.folders.has(folder.id));
      for (const folder of changes.folders.values()) if (folder) this.data.folders.push(folder);
    }
    if (changes.settings.size) this.data.settings = { ...this.data.settings, ...Object.fromEntries(changes.settings) };
    if (changes.excludedPaths.size) {
      for (const [key, excluded] of changes.excludedPaths) {
        if (excluded) this.excluded.add(key);
        else this.excluded.delete(key);
      }
      this.data.excludedPaths = [...this.excluded];
    }
    for (const key of changes.pathAliases.keys()) {
      const oldId = this.pathAliases.get(key);
      if (oldId) this.aliasPathsById.delete(oldId);
      this.pathAliases.delete(key);
    }
    for (const [key, id] of changes.pathAliases) {
      if (!id) continue;
      this.pathAliases.set(key, id);
      this.aliasPathsById.set(id, key);
    }
    for (const [id, image] of changes.thumbnails) {
      const model = this.itemsById.get(id);
      if (!model) continue;
      model.hasThumbnail = Boolean(image);
      model.thumbnailRevision = image?.revision ?? null;
    }
    if (notify) this.scheduleNotification();
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

  modelForPath(key, changes) {
    const id = changes?.newIdsByPath.get(key) ?? this.itemIdsByPath.get(key);
    return changes?.models.has(id) ? changes.models.get(id) : this.itemsById.get(id);
  }

  reservedModelId(key, changes) {
    const alias = this.pathAliases.get(key);
    if (alias) return alias;
    const derived = idFor(key);
    if (this.itemsById.has(derived) || this.aliasPathsById.has(derived) || changes?.models.has(derived)) return null;
    return derived;
  }

  async upsert(file, changes, { explicit = false, stat } = {}) {
    const absolute = path.resolve(file);
    const format = formatFor(absolute);
    if (!format || this.ignored(absolute)) return false;
    const key = normalize(absolute);
    const excluded = changes.excludedPaths.get(key) ?? this.excluded.has(key);
    if (excluded && !explicit) return;
    try { stat ??= await fs.stat(absolute); }
    catch (error) { if (error.code === 'ENOENT') return this.markMissing(absolute, changes); throw error; }
    if (!stat.isFile()) return this.markMissing(absolute, changes);
    if (excluded) changes.excludedPaths.set(key, false);
    const previous = this.modelForPath(key, changes);
    const modifiedAt = stat.mtime.toISOString();
    if (previous) {
      const { id } = previous;
      const changed = previous.modifiedAt !== modifiedAt || previous.size !== stat.size || previous.missing;
      if (changed) {
        changes.models.set(id, { ...previous, name: path.basename(absolute), path: absolute, format, size: stat.size, modifiedAt, missing: false });
        if (previous.hasThumbnail) changes.thumbnails.set(id, null);
      }
      return;
    }
    let id = this.reservedModelId(key, changes);
    if (!id) {
      // A moved model may still own the ID originally derived from this path.
      do { id = crypto.randomBytes(12).toString('hex'); }
      while (this.itemsById.has(id) || this.aliasPathsById.has(id) || changes.models.has(id));
      changes.pathAliases.set(key, id);
    }
    changes.newIdsByPath.set(key, id);
    changes.models.set(id, { id, name: path.basename(absolute), path: absolute, format, size: stat.size, modifiedAt,
      addedAt: new Date().toISOString(), missing: false, favorite: false, tags: [], notes: '', hasThumbnail: false, thumbnailRevision: null });
  }

  markMissing(file, changes) {
    const item = this.modelForPath(normalize(file), changes);
    if (item && !item.missing) changes.models.set(item.id, { ...item, missing: true });
  }

  async walk(directory, changes, visitedFiles, visitedFolders) {
    const key = normalize(directory);
    if (this.closed || visitedFolders.has(key) || this.ignored(directory)) return;
    visitedFolders.add(key);
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
      if (entry.isDirectory()) await this.walk(file, changes, visitedFiles, visitedFolders);
      else if (entry.isFile() && formatFor(file)) {
        const fileKey = normalize(file);
        if (visitedFiles.has(fileKey)) continue;
        visitedFiles.add(fileKey);
        await this.reconcileFile(file, changes);
      }
    }
  }

  rescan() {
    return this.reconcile({ returnState: true });
  }

  async reconcileFile(file, changes, stat) {
    try { await this.upsert(file, changes, { stat }); }
    catch (error) { this.status.message = `読み取りを保留: ${path.basename(file)} (${error.code || error.message})`; }
  }

  reconcile({ observedFiles, unavailableRoot, returnState = false } = {}) {
    return this.enqueue(async () => {
      this.status = { scanning: true, message: 'フォルダを確認しています…' };
      this.notify();
      let state;
      try {
        this.status.message = '';
        const changes = newChanges();
        const visitedFiles = observedFiles ? null : new Set();
        for (const item of this.data.items) {
          if (this.closed) break;
          const key = normalize(item.path);
          visitedFiles?.add(key);
          // Files outside a watch root and files removed while the app was closed still need a stat.
          const stat = observedFiles?.get(key)?.stat;
          observedFiles?.delete(key);
          await this.reconcileFile(item.path, changes, stat);
        }
        if (observedFiles) {
          for (const { file, stat } of observedFiles.values()) {
            if (this.closed) break;
            await this.reconcileFile(file, changes, stat);
          }
          if (unavailableRoot) this.status.message = `読み取れないフォルダがあります: ${unavailableRoot}`;
        } else {
          const visitedFolders = new Set();
          for (const folder of this.data.folders) await this.walk(folder.path, changes, visitedFiles, visitedFolders);
        }
        this.apply(changes, { notify: false });
      } finally {
        this.status.scanning = false;
        if (returnState) state = this.getState();
        this.notify(state);
      }
      return state;
    });
  }

  startWatchers() {
    const result = this.watcherQueue.then(() => this.restartWatchers());
    this.watcherQueue = result.catch(() => {});
    return result;
  }

  async restartWatchers() {
    if (this.closed || this.options.watch === false) return;
    const paths = this.data.folders.map(folder => folder.path);
    const roots = new Set(paths.map(normalize));
    if (this.watchedRoots?.size === roots.size && [...roots].every(root => this.watchedRoots.has(root))) return;
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    this.watchedRoots = null;
    if (this.closed || !paths.length) return;
    const { watch } = await import('chokidar');
    if (this.closed) return;
    const watcher = watch(paths, {
      ignored: file => this.ignored(file),
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: this.options.stabilityThreshold ?? 600, pollInterval: 100 },
      atomic: true,
    });
    this.watcher = watcher;
    // Reuse Chokidar's startup traversal instead of immediately walking the same tree again.
    let initialFiles = new Map();
    const unavailableRoots = new Set(roots);
    const addDir = directory => unavailableRoots.delete(normalize(directory));
    const unlinkDir = directory => {
      const key = normalize(directory);
      if (roots.has(key)) unavailableRoots.add(key);
    };
    watcher.on('addDir', addDir).on('unlinkDir', unlinkDir);
    const change = (file, stat) => {
      if (!formatFor(file) || this.closed) return;
      if (initialFiles) {
        const key = normalize(file);
        if (stat && !stat.isFile()) initialFiles.delete(key);
        else initialFiles.set(key, { file, stat });
        return;
      }
      this.enqueue(async () => {
        const changes = newChanges();
        await this.upsert(file, changes);
        this.apply(changes);
      })
        .catch(error => { this.status.message = `自動登録を保留: ${error.message}`; this.notify(); });
    };
    watcher.on('add', change).on('change', change).on('unlink', file => {
      if (this.closed || !formatFor(file)) return;
      if (initialFiles) {
        initialFiles.delete(normalize(file));
        return;
      }
      this.enqueue(() => {
        const changes = newChanges();
        this.markMissing(file, changes);
        this.apply(changes);
      })
        .catch(error => { this.status.message = error.message; this.notify(); });
    }).on('error', error => {
      this.watchedRoots = null;
      this.status.message = `監視エラー: ${error.message}`;
      this.notify();
    });
    try {
      await once(watcher, 'ready', { signal: this.watcherLifetime.signal });
      if (this.closed) return;
      const observedFiles = initialFiles;
      initialFiles = null;
      watcher.off('addDir', addDir).off('unlinkDir', unlinkDir);
      this.watchedRoots = roots;
      const unavailableRoot = paths.find(directory => unavailableRoots.has(normalize(directory)));
      await this.reconcile({ observedFiles, unavailableRoot });
    } catch (error) {
      if (this.closed) return;
      this.watcher = null;
      this.watchedRoots = null;
      await watcher.close();
      throw error;
    }
  }

  async addFolder(directory) {
    const absolute = path.resolve(directory);
    if (!(await fs.stat(absolute)).isDirectory()) throw new Error('フォルダを選んでください');
    if (this.ignored(absolute)) throw new Error('このフォルダは監視対象にできません');
    const key = normalize(absolute);
    const added = await this.enqueue(() => {
      if (this.data.folders.some(folder => normalize(folder.path) === key)) return false;
      const changes = newChanges();
      const id = idFor(absolute);
      changes.folders.set(id, { id, path: absolute });
      this.apply(changes);
      return true;
    });
    await this.startWatchers();
    if (added && this.options.watch === false) await this.reconcile();
    return this.getState();
  }

  async removeFolder(id) {
    await this.enqueue(() => {
      if (!this.data.folders.some(folder => folder.id === id)) return;
      const changes = newChanges();
      changes.folders.set(id, null);
      this.apply(changes);
    });
    await this.startWatchers();
    return this.getState();
  }

  async importPaths(paths) {
    if (!Array.isArray(paths) || paths.length > 10000 || paths.some(file => typeof file !== 'string')) throw new Error('ファイル一覧が不正です');
    const addedFolder = await this.enqueue(async () => {
      const changes = newChanges();
      const knownFolders = new Set(this.data.folders.map(folder => normalize(folder.path)));
      const visited = new Set();
      for (const file of paths) {
        const absolute = path.resolve(file);
        if (visited.has(absolute)) continue;
        visited.add(absolute);
        const stat = await fs.stat(absolute);
        if (stat.isDirectory()) {
          if (this.ignored(absolute)) throw new Error('このフォルダは監視対象にできません');
          const key = normalize(absolute);
          if (knownFolders.has(key)) continue;
          knownFolders.add(key);
          const id = idFor(absolute);
          changes.folders.set(id, { id, path: absolute });
        } else if (formatFor(absolute)) await this.upsert(absolute, changes, { explicit: true, stat });
      }
      this.apply(changes);
      return Boolean(changes.folders.size);
    });
    if (addedFolder) {
      await this.startWatchers();
      if (this.options.watch === false) await this.reconcile();
    }
    return this.getState();
  }

  item(id) {
    if (typeof id !== 'string') throw new Error('ファイルIDが不正です');
    const item = this.itemsById.get(id);
    if (!item) throw new Error('ライブラリにファイルが見つかりません');
    return item;
  }

  async captureRelinkSource(id) {
    const item = this.item(id);
    const source = { path: item.path, name: item.name, format: item.format, addedAt: item.addedAt };
    await this.assertRelinkSourceMissing(id, source);
    return source;
  }

  async assertRelinkSourceMissing(id, expected) {
    const unchanged = () => {
      const item = this.item(id);
      return item.missing && item.path === expected?.path && item.addedAt === expected?.addedAt;
    };
    if (!unchanged()) throw new Error('不在のモデルを選び直してください');
    try { await fs.lstat(expected.path); }
    catch (error) {
      // Permission or connectivity errors do not prove that a file is absent.
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('元の場所を確認できません。再紐付けは中止しました');
      if (!unchanged()) throw new Error('元の登録情報が変わりました。モデルを選び直してください');
      return;
    }
    throw new Error('元の場所にファイルが見つかりました。先にライブラリを再スキャンしてください');
  }

  async inspectRelinkTarget(id, file, source) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || this.ignored(file) ||
        formatFor(file) !== source.format || normalize(file) === normalize(source.path)) {
      throw new Error('対応する同じ形式の移動先ファイルを選んでください');
    }
    const absolute = path.resolve(file);
    const key = normalize(absolute);
    let stat;
    try {
      if (!(await fs.lstat(absolute)).isFile()) throw new Error('not a regular file');
      const handle = await fs.open(absolute, 'r');
      try { stat = await handle.stat(); }
      finally { await handle.close(); }
      if (!stat.isFile()) throw new Error('not a regular file');
    } catch {
      throw new Error('移動先のファイルが見つからないか、読み取れません');
    }
    await this.assertRelinkSourceMissing(id, source);
    const existing = this.modelForPath(key);
    const targetId = existing?.id ?? this.reservedModelId(key);
    // A path can have presets even when its library row was unregistered.
    if (targetId && targetId !== id) this.store.assertRelinkTargetReusable(targetId);
    return { path: absolute, size: stat.size, modifiedAt: stat.mtime.toISOString(),
      identity: [stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.size].join(':'),
      existing: existing ? { id: existing.id, addedAt: existing.addedAt } : null, targetId };
  }

  relinkModel(id, file, source, confirmed) {
    return this.enqueue(async () => {
      const target = await this.inspectRelinkTarget(id, file, source);
      if (!confirmed || target.path !== confirmed.path || target.identity !== confirmed.identity ||
          target.targetId !== confirmed.targetId || target.existing?.id !== confirmed.existing?.id ||
          target.existing?.addedAt !== confirmed.existing?.addedAt) {
        throw new Error('移動先のファイルまたは登録が変わりました。選び直してください');
      }
      const item = this.item(id);
      const changes = newChanges();
      if (target.existing) changes.models.set(target.existing.id, null);
      changes.models.set(id, { ...item, name: path.basename(target.path), path: target.path,
        size: target.size, modifiedAt: target.modifiedAt, missing: false });
      if (item.hasThumbnail) changes.thumbnails.set(id, null);
      changes.pathAliases.set(normalize(item.path), null);
      changes.pathAliases.set(normalize(target.path), id);
      if (this.excluded.has(normalize(target.path))) changes.excludedPaths.set(normalize(target.path), false);
      this.apply(changes, { relinkTargetId: target.targetId });
      return this.getState();
    });
  }

  updateItem(id, patch) {
    return this.enqueue(() => {
      const item = { ...this.item(id) };
      if (!patch || typeof patch !== 'object') throw new Error('更新内容が不正です');
      if (typeof patch.favorite === 'boolean') item.favorite = patch.favorite;
      if (typeof patch.notes === 'string') item.notes = patch.notes.slice(0, 20000);
      if (Array.isArray(patch.tags)) item.tags = [...new Set(patch.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
      const changes = newChanges();
      changes.models.set(id, item);
      this.apply(changes);
      return this.getState();
    });
  }

  removeItem(id) {
    return this.enqueue(() => {
      const item = this.item(id);
      const key = normalize(item.path);
      const changes = newChanges();
      changes.excludedPaths.set(key, true);
      changes.models.set(id, null);
      this.apply(changes);
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
      const changes = newChanges();
      changes.models.set(id, null);
      // Restoring the file into a watched folder must register it again.
      changes.excludedPaths.set(normalize(item.path), false);
      try { this.apply(changes); }
      catch (error) {
        this.notify();
        throw new Error(`ファイルはゴミ箱へ移動済みですが、ライブラリの保存に失敗しました: ${error.message}`);
      }
      return this.getState();
    });
  }

  updateSettings(patch) {
    return this.enqueue(() => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => key !== 'memoryBudgetMiB' && key !== 'lightweightPreview')) {
        throw new Error('設定の更新内容が不正です');
      }
      const changes = newChanges();
      if (Object.hasOwn(patch, 'memoryBudgetMiB')) {
        assertMemoryBudget(patch.memoryBudgetMiB);
        changes.settings.set('memoryBudgetMiB', patch.memoryBudgetMiB);
      }
      if (Object.hasOwn(patch, 'lightweightPreview')) {
        if (typeof patch.lightweightPreview !== 'boolean') throw new Error('軽量プレビューの設定が不正です');
        changes.settings.set('lightweightPreview', patch.lightweightPreview);
      }
      this.apply(changes);
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
    const expectedPath = normalize(expectedSource.path);
    const sourceMatches = current => !current.missing && normalize(current.path) === expectedPath &&
      current.size === expectedSource.size && current.modifiedAt === expectedSource.modifiedAt &&
      (expectedSource.addedAt === undefined || current.addedAt === expectedSource.addedAt);
    if (!sourceMatches(item)) {
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
    const current = this.item(id);
    if (current !== item || !sourceMatches(current)) throw new Error('ライブラリの登録が変更されました');
    return item;
  }

  saveThumbnail(id, dataUrl, expectedSource, options = {}) {
    return this.enqueue(async () => {
      options.signal?.throwIfAborted();
      if (expectedSource) await this.assertThumbnailSource(id, expectedSource);
      else this.item(id);
      const image = parseThumbnail(dataUrl);
      options.signal?.throwIfAborted();
      const changes = newChanges();
      changes.thumbnails.set(id, { ...image, revision: crypto.randomUUID() });
      this.apply(changes);
      return dataUrl;
    });
  }

  readThumbnailImage(id, revision) {
    if (this.closed || typeof id !== 'string') return null;
    const item = this.itemsById.get(id);
    if (!item?.hasThumbnail || (revision !== undefined && revision !== item.thumbnailRevision)) return null;
    return this.store.readThumbnailImage(id, item.thumbnailRevision);
  }

  setBambu(file) {
    return this.enqueue(async () => {
      if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.exe' || !(await fs.stat(file)).isFile()) throw new Error('Bambu Studioの実行ファイルを選んでください');
      const changes = newChanges();
      changes.settings.set('bambuPath', path.resolve(file));
      this.apply(changes);
      return this.getState();
    });
  }

  setOpenScadPath(file) {
    return this.enqueue(async () => {
      if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.exe$/i.test(file) ||
          !(await fs.stat(file).catch(() => null))?.isFile()) {
        throw new Error('OpenSCADの実行ファイル（.exe）を選んでください');
      }
      const changes = newChanges();
      changes.settings.set('openscadPath', file);
      this.apply(changes);
      return this.getState();
    });
  }

  close() {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    clearTimeout(this.notificationTimer);
    this.notificationTimer = null;
    this.watcherLifetime.abort();
    this.closeTask = this.closeResources();
    return this.closeTask;
  }

  async closeResources() {
    try {
      await this.watcherQueue;
      await this.initialScan;
      await this.watcher?.close();
    }
    finally {
      this.watcher = null;
      await this.queue;
      try { this.store?.close(); }
      finally { this.removeAllListeners(); }
    }
  }
}

module.exports = { Library, formatFor, normalize, idFor, assertModelSizeAllowed };
