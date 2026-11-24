const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolvePreviewLimits, assertMemoryBudget } = require('../shared/preview-memory.cjs');
const { parseScadParameters, suggestPartSelector, validateScadOverrides, scadDefineArgs } = require('./scad-parameters.cjs');

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_PARTS = 256;
const DEFAULT_TIMEOUT_MS = 180000;
const abortError = () => Object.assign(new Error('OpenSCADの処理を中止しました'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw signal.reason || abortError(); };
let processBusy = false;
const processWaiters = [];
const idleWaiters = new Set();

// Preview, thumbnails, and part exports share one native process slot.
function acquireProcess(signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const waiter = { signal, resolve, reject };
    waiter.abort = () => {
      const index = processWaiters.indexOf(waiter);
      if (index !== -1) processWaiters.splice(index, 1);
      reject(signal.reason || abortError());
    };
    const enter = () => {
      processBusy = true;
      signal?.removeEventListener('abort', waiter.abort);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        processBusy = false;
        const next = processWaiters.shift();
        if (next) next.enter();
        else { for (const done of idleWaiters) done(); idleWaiters.clear(); }
      });
    };
    waiter.enter = enter;
    if (!processBusy) enter();
    else { signal?.addEventListener('abort', waiter.abort, { once: true }); processWaiters.push(waiter); }
  });
}

function waitForScadIdle() {
  if (!processBusy && !processWaiters.length) return Promise.resolve();
  return new Promise(resolve => idleWaiters.add(resolve));
}

async function isFile(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }

async function detectOpenScad() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const names = process.platform === 'win32' ? ['openscad.exe', 'openscad.com'] : ['openscad'];
  const directories = [...roots.map(root => path.join(root, 'OpenSCAD')), ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
  for (const directory of directories) for (const name of names) {
    const candidate = path.resolve(directory, name);
    if (await isFile(candidate)) return candidate;
  }
  return '';
}

async function resolveExecutable(executable) {
  if (typeof executable !== 'string' || !executable || !path.isAbsolute(executable)) throw new Error('設定でOpenSCADの実行ファイルを選んでください');
  // Some Windows .com console wrappers cannot be spawned directly. The sibling
  // executable accepts the same CLI options and works with hidden stdio pipes.
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() === '.com') {
    const sibling = path.join(path.dirname(executable), 'openscad.exe');
    if (await isFile(sibling)) executable = sibling;
  }
  if (!(await isFile(executable))) throw new Error('OpenSCADが見つかりません。設定で実行ファイルを選び直してください');
  return executable;
}

async function readScadParameters(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || path.extname(sourcePath).toLowerCase() !== '.scad') throw new Error('OpenSCADのソースファイルを指定してください');
  const handle = await fs.open(sourcePath, 'r').catch(() => { throw new Error('OpenSCADのソースが見つからないか、読み取れません'); });
  let source;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_SOURCE_BYTES) throw new Error('OpenSCADのパラメータ読み取りは8 MiB以下のソースに対応しています');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('読み取り中にOpenSCADソースが更新されました。再試行してください');
    source = bytes.toString('utf8');
  } finally { await handle.close(); }
  const parameters = parseScadParameters(source);
  return { parameters, selector: suggestPartSelector(parameters), supported: parameters.length > 0,
    diagnostics: parameters.length ? [] : ['編集可能な公開パラメータを検出できませんでした。既定のモデルは表示・書き出しできます。'] };
}

function runNative(executable, sourcePath, output, values, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let child;
    let terminalError;
    let settled = false;
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-128 * 1024);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    const stop = error => {
      terminalError = error;
      if (child && !child.killed) child.kill('SIGKILL');
    };
    const abort = () => stop(signal.reason || abortError());
    const timer = setTimeout(() => stop(Object.assign(new Error(`OpenSCADの変換が${Math.ceil(timeoutMs / 1000)}秒を超えました`), { name: 'TimeoutError' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const args = ['--export-format', 'binstl', '-o', output, ...scadDefineArgs(values), sourcePath];
      child = spawnProcess(executable, args, { cwd: path.dirname(sourcePath), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
      child.once('error', error => finish(new Error(`OpenSCADを起動できません: ${error.message}`)));
      child.once('close', code => {
        if (terminalError) return finish(terminalError);
        const errorLines = `${stderr}\n${stdout}`.split(/\r?\n/).filter(line => /^\s*ERROR:/i.test(line));
        if (code !== 0 || errorLines.length) return finish(new Error(`OpenSCADの変換に失敗しました${code === null ? '' : `（終了コード ${code}）`}: ${(errorLines.join('\n') || stderr || stdout).trim().slice(-5000)}`));
        finish();
      });
    } catch (error) { finish(error); }
  });
}

function warningsFrom(result) {
  return [...new Set(`${result.stderr}\n${result.stdout}`.split(/\r?\n/).map(line => line.trim())
    .filter(line => /^(WARNING|DEPRECATED):/i.test(line)))].slice(0, 30);
}

async function withRenderedFile(options, consume) {
  const { sourcePath, values, signal, temporaryRoot = os.tmpdir() } = options;
  const executable = await resolveExecutable(options.executable);
  const release = await acquireProcess(signal);
  let temporary;
  try {
    checkAbort(signal);
    temporary = await fs.mkdtemp(path.join(path.resolve(temporaryRoot), 'nine-scad-'));
    const output = path.join(temporary, 'model.stl');
    const logs = await runNative(executable, sourcePath, output, values, options);
    checkAbort(signal);
    const stat = await fs.stat(output).catch(() => { throw new Error(`OpenSCADからSTLが生成されませんでした。形状が空でないか確認してください。${logs.stderr.trim().slice(-1200)}`); });
    if (!stat.isFile() || stat.size <= 84) throw new Error('OpenSCADの出力に表示できる三角形がありません');
    return await consume(output, stat, warningsFrom(logs));
  } finally {
    // Resolve and verify the sole generated directory before recursive cleanup.
    try {
      if (temporary) {
        const resolved = path.resolve(temporary);
        if (path.dirname(resolved) !== path.resolve(temporaryRoot) || !path.basename(resolved).startsWith('nine-scad-')) throw new Error('一時フォルダの範囲を確認できません');
        await fs.rm(resolved, { recursive: true, force: true });
      }
    } finally { release(); }
  }
}

async function renderScad(options) {
  const { sourcePath, values = {}, signal, memoryBudgetMiB = 2048 } = options;
  assertMemoryBudget(memoryBudgetMiB);
  checkAbort(signal);
  const info = await readScadParameters(sourcePath);
  const validated = validateScadOverrides(info.parameters, values);
  return withRenderedFile({ ...options, values: validated }, async (output, stat, warnings) => {
    const limit = resolvePreviewLimits(memoryBudgetMiB).fileBytes;
    if (stat.size > limit) throw new Error(`OpenSCADのSTLは ${Math.ceil(stat.size / 1024 / 1024)} MiB で、プレビュー入力上限 ${Math.floor(limit / 1024 / 1024)} MiB を超えています。メモリ設定を確認してください`);
    checkAbort(signal);
    const bytes = new Uint8Array(await fs.readFile(output));
    checkAbort(signal);
    return { bytes, warnings };
  });
}

async function writeScadPrintStl(options) {
  const { sourcePath, directory, values = {}, signal, maxOutputBytes, validateSource } = options;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 84) throw new Error('印刷用STLの容量上限を設定できません');
  checkAbort(signal);
  const plan = await prepareScadExport(sourcePath, { values });
  const job = plan.jobs[0];
  await validateSource();
  return withRenderedFile({ ...options, values: job.values, temporaryRoot: directory }, async (output, stat) => {
    if (stat.size > maxOutputBytes) {
      throw new Error('印刷用STLが一時ファイルの容量上限を超えました。OpenSCADで形状を簡略化するか、分割して出力してください');
    }
    const header = Buffer.alloc(84);
    const handle = await fs.open(output, 'r');
    try {
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const triangles = header.readUInt32LE(80);
      if (bytesRead !== header.length || !triangles || stat.size !== header.length + 50 * triangles) {
        throw new Error('OpenSCADが完全なバイナリSTLを生成できなかったため、印刷準備を中止しました');
      }
    } finally { await handle.close(); }
    await validateSource();
    checkAbort(signal);
    const destination = path.join(directory, job.name);
    // Both paths are in this unique, private staging directory. Move the file
    // without creating a second disk copy or loading its bytes in Electron.
    await fs.rename(output, destination);
    return destination;
  });
}

function safeStem(value, length = 70) {
  let stem = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, length);
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `part_${stem || 'model'}`;
  return stem;
}

async function prepareScadExport(sourcePath, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['values', 'selector', 'parts'].includes(key))) throw new Error('OpenSCADの書き出し設定が不正です');
  const info = await readScadParameters(sourcePath);
  const values = validateScadOverrides(info.parameters, options.values ?? {});
  const selector = options.selector ?? null;
  const parts = options.parts ?? null;
  const base = safeStem(path.basename(sourcePath, path.extname(sourcePath)));
  if (parts === null) return { values, selector: null, parts: null, jobs: [{ name: `${base}.stl`, values }] };
  if (typeof selector !== 'string' || !Array.isArray(parts) || !parts.length || parts.length > MAX_EXPORT_PARTS) throw new Error(`部品の書き出しは選択式パラメータと1〜${MAX_EXPORT_PARTS}件の値を指定してください`);
  const parameter = info.parameters.find(candidate => candidate.name === selector);
  if (!parameter?.options?.length || !['number', 'string', 'boolean'].includes(parameter.type)) throw new Error('部品の切り替えには選択肢が定義されたパラメータを指定してください');
  const seen = new Set();
  const jobs = parts.map(part => {
    if (!['number', 'string', 'boolean'].includes(typeof part)) throw new Error('部品の値は文字列・数値・真偽値で指定してください');
    const key = `${typeof part}:${JSON.stringify(part)}`;
    if (seen.has(key)) throw new Error('同じ部品の値が重複しています');
    seen.add(key);
    const overrides = validateScadOverrides(info.parameters, { ...values, [selector]: part });
    const declaredIndex = parameter.options.findIndex(option => Object.is(option.value, part));
    if (declaredIndex < 0) throw new Error('宣言されていない部品の値です');
    return { name: `${base}--${safeStem(selector, 35)}-${String(declaredIndex + 1).padStart(3, '0')}-${safeStem(part, 50)}.stl`, values: overrides, part };
  });
  return { values, selector, parts, jobs };
}

async function exportScad(options) {
  const { sourcePath, directory, signal, validateSource = async () => {}, onProgress = () => {} } = options;
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await fs.stat(directory)).isDirectory()) throw new Error('書き出し先フォルダが見つかりません');
  const plan = await prepareScadExport(sourcePath, { values: options.values, selector: options.selector, parts: options.parts });
  const result = { directory, files: [], failures: [], cancelled: false };
  let processed = 0;
  for (const job of plan.jobs) {
    if (signal?.aborted) { result.cancelled = true; break; }
    onProgress({ processed, total: plan.jobs.length, current: job.name });
    try {
      await validateSource();
      await withRenderedFile({ ...options, values: job.values }, async (output, _stat, warnings) => {
        checkAbort(signal);
        await validateSource();
        const destination = path.join(directory, job.name);
        try { await fs.copyFile(output, destination, constants.COPYFILE_EXCL); }
        catch (error) {
          if (error.code === 'EEXIST') throw new Error(`同名のファイルがあるため上書きしませんでした: ${job.name}`);
          throw error;
        }
        result.files.push({ name: job.name, path: destination, ...(job.part !== undefined ? { part: job.part } : {}), ...(warnings.length ? { warnings } : {}) });
      });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') { result.cancelled = true; break; }
      result.failures.push({ ...(job.part !== undefined ? { part: job.part } : {}), error: String(error.message || error) });
    }
    processed += 1;
    onProgress({ processed, total: plan.jobs.length, current: null });
  }
  onProgress({ processed, total: plan.jobs.length, current: null });
  return result;
}

module.exports = { detectOpenScad, resolveExecutable, readScadParameters, renderScad, prepareScadExport, exportScad, writeScadPrintStl, waitForScadIdle,
  MAX_EXPORT_PARTS, MAX_SOURCE_BYTES, DEFAULT_TIMEOUT_MS };
