const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MAX_PRINT_STL_BYTES = 128 * 1024 * 1024;
const MAX_STAGE_BYTES = 512 * 1024 * 1024;
const STAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_STAGED_JOBS = 32;
const stagePattern = /^print-[a-z0-9]{6}$/i;
const formatExtensions = new Map([
  ['stl', ['.stl']], ['step', ['.step', '.stp']], ['3mf', ['.3mf']], ['scad', ['.scad']],
]);

async function probeWindowsVersion(executable) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows system path unavailable');
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$info = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:NINE_STUDIO_VERSION_PROBE_FILE)',
    '$info.FileVersion', '$info.ProductName', '$info.OriginalFilename',
  ].join('; ');
  const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, NINE_STUDIO_VERSION_PROBE_FILE: executable },
    windowsHide: true, timeout: 5000, maxBuffer: 4096, shell: false,
  });
  const [version, productName, originalFilename] = stdout.trim().split(/\r?\n/);
  return { version, productName, originalFilename };
}

function studioVersion(metadata) {
  const product = metadata?.productName?.trim().replace(/[\s-]/g, '').toLowerCase();
  const originalFile = metadata?.originalFilename?.trim().toLowerCase();
  if (product !== 'bambustudio' && originalFile !== 'bambu-studio.exe') return null;
  const version = metadata?.version?.trim();
  return /^\d{1,4}(?:\.\d{1,4}){2,3}$/.test(version || '') ? version : null;
}

function launchStudio(executable, file, spawnProcess) {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('Bambu Studioを起動できませんでした。実行ファイルとインストールを確認してください'));
    try {
      const child = spawnProcess(executable, [file], {
        cwd: path.dirname(executable), detached: true, stdio: 'ignore', shell: false,
      });
      child.once('error', failed);
      child.once('spawn', () => { child.unref(); resolve(); });
    } catch { failed(); }
  });
}

function abortError() {
  return Object.assign(new Error('印刷準備を中止しました'), { name: 'AbortError' });
}

async function removeStage(root, directory) {
  const candidate = path.resolve(directory);
  if (path.dirname(candidate) !== root || !stagePattern.test(path.basename(candidate))) return false;
  const entry = await fs.lstat(candidate).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink() || path.dirname(await fs.realpath(candidate)) !== root) return false;
  await fs.rm(candidate, { recursive: true, force: true });
  return true;
}

class BambuPrint {
  #options;
  #inspection;
  #active;

  constructor(options) {
    this.#options = { platform: process.platform, probeVersion: probeWindowsVersion, spawnProcess: spawn,
      now: Date.now, ...options };
  }

  async #inspect(executable) {
    if (this.#options.platform !== 'win32') return { reason: 'Bambu Studio連携はWindowsに対応しています' };
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== '.exe') {
      return { reason: '設定でBambu Studioの実行ファイルを選んでください' };
    }
    const stat = await fs.stat(executable).catch(() => null);
    if (!stat?.isFile()) return { reason: 'Bambu Studioが見つかりません。実行ファイルを選び直してください' };
    const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.dev}:${stat.ino}`;
    if (this.#inspection?.executable === executable && this.#inspection.stamp === stamp) {
      return this.#inspection.result;
    }
    const result = this.#readInstallation(executable, stamp);
    this.#inspection = { executable, stamp, result };
    const installation = await result;
    if (!installation.version && this.#inspection?.result === result) this.#inspection = undefined;
    return installation;
  }

  async #readInstallation(executable, stamp) {
    let metadata;
    try { metadata = await this.#options.probeVersion(executable); } catch { /* Report unavailable metadata below. */ }
    const version = studioVersion(metadata);
    return version ? { executable, stamp, version } : {
      reason: 'Bambu Studioのバージョンを確認できません。公式版の実行ファイルを選んでください',
    };
  }

  async requireExecutable(executable) {
    const installation = await this.#inspect(executable);
    if (!installation.version) throw new Error(installation.reason);
    return installation;
  }

  async getStatus() {
    const { version = null, reason = null } = await this.#inspect(this.#options.getExecutable());
    return { available: Boolean(version), version, reason,
      capabilities: { studioGui: Boolean(version), printerConfirmationInStudio: Boolean(version) } };
  }

  async #allocateStage() {
    const configuredRoot = path.resolve(this.#options.stagingRoot);
    await fs.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(configuredRoot)).isDirectory()) throw new Error('印刷準備の一時フォルダにアクセスできません');
    const root = await fs.realpath(configuredRoot);
    const entries = await fs.opendir(root);
    let count = 0;
    let usedBytes = 0;
    for await (const entry of entries) {
      if (!entry.isDirectory() || !stagePattern.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      const stat = await fs.lstat(directory).catch(() => null);
      if (!stat) continue;
      const expired = stat.mtimeMs < this.#options.now() - STAGE_RETENTION_MS;
      if (expired && await removeStage(root, directory).catch(() => false)) continue;
      count += 1;
      const files = await fs.opendir(directory);
      for await (const file of files) {
        if (!file.isFile() || path.extname(file.name).toLowerCase() !== '.stl') continue;
        usedBytes += (await fs.lstat(path.join(directory, file.name))).size;
      }
    }
    const maxOutputBytes = Math.min(MAX_PRINT_STL_BYTES, MAX_STAGE_BYTES - usedBytes);
    if (count >= MAX_STAGED_JOBS || maxOutputBytes <= 84) {
      throw new Error('Bambu Studioに渡した一時STLが上限に達しました。必要なモデルを保存し、しばらくしてから再試行してください');
    }
    return { root, directory: await fs.mkdtemp(path.join(root, 'print-')), maxOutputBytes };
  }

  prepare(id, values = {}) {
    if (this.#active) throw new Error('別の印刷準備が進行中です。完了を待つか中止してください');
    const task = { controller: new AbortController(), canCancel: true };
    this.#active = task;
    task.promise = this.#prepareOne(id, values, task).finally(() => { this.#active = undefined; });
    return task.promise;
  }

  isPreparing() { return Boolean(this.#active); }

  cancel() {
    if (!this.#active?.canCancel || this.#active.controller.signal.aborted) return false;
    this.#active.controller.abort(abortError());
    return true;
  }

  waitForIdle() {
    return this.#active?.promise.then(() => {}, () => {}) ?? Promise.resolve();
  }

  async #prepareOne(id, values, task) {
    const { signal } = task.controller;
    const { getExecutable, getOpenScad, getItem, captureSource, validateSource, renderScad, spawnProcess } = this.#options;
    let stage;
    let opened = false;
    try {
      const item = getItem(id);
      if (!formatExtensions.get(item.format)?.includes(path.extname(item.path).toLowerCase())) {
        throw new Error('印刷準備に対応したライブラリのモデルを選んでください');
      }
      const studio = await this.requireExecutable(getExecutable());
      signal.throwIfAborted();
      const source = await captureSource(id);
      if (source.path !== item.path) throw new Error('元のモデルが更新されました。選び直してください');
      signal.throwIfAborted();
      let file = source.path;
      if (item.format === 'scad') {
        const openScad = getOpenScad();
        if (!openScad) throw new Error('設定でOpenSCADの実行ファイルを選んでください');
        stage = await this.#allocateStage();
        signal.throwIfAborted();
        file = await renderScad({ executable: openScad, sourcePath: source.path, directory: stage.directory,
          values, signal, maxOutputBytes: stage.maxOutputBytes, validateSource: () => validateSource(id, source) });
      }
      const current = await this.requireExecutable(getExecutable());
      if (current.executable !== studio.executable || current.stamp !== studio.stamp) {
        throw new Error('印刷準備中にBambu Studioの設定が変わりました。もう一度開いてください');
      }
      await validateSource(id, source);
      signal.throwIfAborted();
      task.canCancel = false;
      // Studio owns profile selection, slicing, the printer and final confirmation.
      await launchStudio(studio.executable, file, spawnProcess);
      opened = true;
      return { status: 'opened', opened, source: stage ? 'scad-stl' : 'original', studioVersion: studio.version, steps: [
        'Bambu Studioでプリンター・プレート・フィラメント設定を確認',
        'プレートをスライス',
        '「プレートを印刷」または「送信」でプリンターを選択して確定',
      ] };
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled', opened: false };
      throw error;
    } finally {
      // Studio may be forwarding the file to an existing instance. A dispatched
      // STL stays available until the stale-stage cleanup of a later job.
      if (stage && !opened) await removeStage(stage.root, stage.directory).catch(() => {});
    }
  }
}

module.exports = { BambuPrint, studioVersion, MAX_PRINT_STL_BYTES, STAGE_RETENTION_MS, MAX_STAGED_JOBS };
