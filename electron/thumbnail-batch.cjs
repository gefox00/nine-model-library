const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { assertMemoryBudget } = require('../shared/preview-memory.cjs');

const initialState = () => ({
  id: null, status: 'idle', total: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0,
  current: null, failures: [], startedAt: null, finishedAt: null, scope: 'all', memoryBudgetMiB: 2048,
});

function abortError(message = 'サムネイル生成を停止しました') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || abortError());
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || abortError());
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

// Electron and filesystem operations are injected so queue ordering and cancellation
// can be verified without opening a window or parsing a model.
class ThumbnailBatch extends EventEmitter {
  constructor({ generate, saveThumbnail, persistReport = async () => {}, timeoutMs = 90000 }) {
    super();
    if (typeof generate !== 'function' || typeof saveThumbnail !== 'function') throw new Error('Thumbnail batch requires generate and saveThumbnail');
    this.generate = generate;
    this.saveThumbnail = saveThumbnail;
    this.persistReport = persistReport;
    this.timeoutMs = timeoutMs;
    this.state = initialState();
    this.cancelRequested = false;
    this.active = null;
    this.running = Promise.resolve();
    this.reportQueue = Promise.resolve();
  }

  getState() { return structuredClone(this.state); }
  isRunning() { return ['running', 'stopping'].includes(this.state.status); }

  async restore(report) {
    if (!report || typeof report !== 'object' || !['idle', 'running', 'stopping', 'completed', 'cancelled'].includes(report.status)) return this.getState();
    const clean = initialState();
    for (const key of ['id', 'startedAt', 'finishedAt']) clean[key] = typeof report[key] === 'string' ? report[key] : null;
    for (const key of ['total', 'processed', 'succeeded', 'failed', 'skipped']) clean[key] = Number.isSafeInteger(report[key]) && report[key] >= 0 ? report[key] : 0;
    clean.failures = Array.isArray(report.failures) ? report.failures.filter(item => item && typeof item.id === 'string').map(item => ({
      id: item.id, name: String(item.name || '').slice(0, 1024), error: String(item.error || '').slice(0, 4000),
    })) : [];
    try { clean.memoryBudgetMiB = assertMemoryBudget(report.memoryBudgetMiB); } catch { /* Use the default for old reports. */ }
    clean.scope = report.scope === 'single' ? 'single' : 'all';
    clean.status = ['running', 'stopping'].includes(report.status) ? 'cancelled' : report.status;
    if (['running', 'stopping'].includes(report.status)) clean.finishedAt = new Date().toISOString();
    this.state = clean;
    await this.publish();
    return this.getState();
  }

  publish() {
    const snapshot = this.getState();
    this.emit('state', snapshot);
    const pending = this.reportQueue.then(() => this.persistReport(snapshot));
    this.reportQueue = pending.catch(() => {});
    return pending;
  }

  start({ items, memoryBudgetMiB, overwrite = false, scope = 'all' }) {
    if (this.isRunning()) throw new Error('サムネイル生成はすでに実行中です');
    if (!Array.isArray(items) || typeof overwrite !== 'boolean' || !['all', 'single'].includes(scope)) throw new Error('サムネイル生成の指定が不正です');
    if (scope === 'single') {
      if (items.length !== 1 || !items[0] || typeof items[0].id !== 'string') throw new Error('サムネイルを生成するファイルを1件指定してください');
      if (items[0].missing) throw new Error('元ファイルが見つからないため、サムネイルを生成できません');
    }
    assertMemoryBudget(memoryBudgetMiB);
    // Do not retain large thumbnails or item metadata in the queue or report.
    const snapshot = items.map(item => ({ id: item.id, name: item.name, path: item.path,
      size: item.size, modifiedAt: item.modifiedAt, addedAt: item.addedAt, format: item.format,
      missing: Boolean(item.missing), hasThumbnail: Boolean(item.hasThumbnail ?? item.thumbnail) }));
    const targets = snapshot.filter(item => !item.missing && (overwrite || scope === 'single' || !item.hasThumbnail));
    const skipped = snapshot.length - targets.length;
    this.cancelRequested = false;
    this.state = { ...initialState(), id: randomUUID(), status: 'running', total: snapshot.length,
      processed: skipped, skipped, startedAt: new Date().toISOString(), memoryBudgetMiB, scope };
    const batchId = this.state.id;
    this.running = this.run(targets).catch(async error => {
      if (this.state.id !== batchId) return;
      this.state.status = 'cancelled';
      this.state.current = null;
      this.state.finishedAt = new Date().toISOString();
      this.state.reportError = `実行結果を保存できません: ${error.message || error}`;
      this.emit('state', this.getState());
      try { await this.publish(); } catch { /* The error is visible in the live report. */ }
    });
    return this.getState();
  }

  async run(targets) {
    await this.publish();
    for (const item of targets) {
      if (this.cancelRequested) break;
      this.state.current = { id: item.id, name: item.name };
      await this.publish();
      if (this.cancelRequested) break;
      const controller = new AbortController();
      this.active = controller;
      const timer = setTimeout(() => {
        const error = new Error(`プレビュー生成が ${Math.ceil(this.timeoutMs / 1000)} 秒を超えたため停止しました`);
        error.name = 'TimeoutError';
        controller.abort(error);
      }, this.timeoutMs);
      try {
        const result = await withAbort(this.generate(item, {
          memoryBudgetMiB: this.state.memoryBudgetMiB, signal: controller.signal,
        }), controller.signal);
        clearTimeout(timer);
        if (this.cancelRequested) throw abortError();
        // Persistence completes before another job is sent. Cancellation
        // during an atomic save waits for that save, then stops before the next item.
        await this.saveThumbnail(item, result, { signal: controller.signal });
        this.state.succeeded += 1;
        this.state.processed += 1;
      } catch (error) {
        if (this.cancelRequested) break;
        this.state.failed += 1;
        this.state.processed += 1;
        this.state.failures.push({ id: item.id, name: item.name, error: String(error.message || error).slice(0, 4000) });
      } finally {
        clearTimeout(timer);
        this.active = null;
      }
      this.state.current = null;
      await this.publish();
    }
    this.state.status = this.cancelRequested ? 'cancelled' : 'completed';
    this.state.current = null;
    this.state.finishedAt = new Date().toISOString();
    await this.publish();
  }

  stop() {
    if (!this.isRunning()) return this.getState();
    this.cancelRequested = true;
    this.state.status = 'stopping';
    if (this.active) this.active.abort(abortError());
    // Abort happens synchronously, before waiting for report persistence.
    void this.publish().catch(error => {
      this.state.reportError = `実行結果を保存できません: ${error.message || error}`;
      this.emit('state', this.getState());
    });
    return this.getState();
  }

  async waitForIdle() { await this.running; await this.reportQueue; return this.getState(); }
  async close() { this.stop(); await this.waitForIdle(); this.removeAllListeners(); }
}

module.exports = { ThumbnailBatch, abortError };
