const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ThumbnailWorker } = require('../electron/thumbnail-worker.cjs');

const result = { dataUrl: 'data:image/png;base64,YWJj' };

function fixture(overrides = {}) {
  const handlers = new Map();
  const windows = [];
  const worker = new ThumbnailWorker({
    createWindow: () => {
      const window = new EventEmitter();
      window.webContents = new EventEmitter();
      window.webContents.mainFrame = {};
      window.webContents.setWindowOpenHandler = () => {};
      window.jobs = [];
      window.webContents.send = (channel, jobId) => {
        assert.equal(channel, 'nine-thumb:job');
        window.jobs.push(jobId);
      };
      window.isDestroyed = () => window.destroyed === true;
      window.removeMenu = () => {};
      window.destroy = () => {
        assert(!window.isDestroyed());
        window.destroyed = true;
        window.emit('closed');
      };
      windows.push(window);
      return window;
    },
    loadWindow: async () => {},
    readInput: async (item, { memoryBudgetMiB }) => ({ name: item.name, bytes: new Uint8Array(4), memoryBudgetMiB }),
    ...overrides,
  });
  worker.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler) });
  return {
    worker, windows,
    start: (name, signal = new AbortController().signal) => worker.generate({ name }, { memoryBudgetMiB: 512, signal }),
    invoke: (channel, window, ...args) => handlers.get(`nine-thumb:${channel}`)({
      sender: window.webContents, senderFrame: window.webContents.mainFrame,
    }, ...args),
    wrongFrame: (channel, window, ...args) => handlers.get(`nine-thumb:${channel}`)({
      sender: window.webContents, senderFrame: {},
    }, ...args),
  };
}

test('one worker serves consecutive jobs without accepting early, duplicate or stale responses', async () => {
  const { worker, windows, start, invoke, wrongFrame } = fixture();
  const first = start('first.stl');
  const [window] = windows;
  assert.deepEqual(window.jobs, []);
  assert.throws(() => wrongFrame('ready', window), /許可されていない/);
  invoke('ready', window);
  invoke('ready', window);
  const [firstId] = window.jobs;
  assert.equal(window.jobs.length, 1);
  assert.throws(() => invoke('complete', window, firstId, result), /不正/);
  assert.equal((await invoke('input', window, firstId)).name, 'first.stl');
  await assert.rejects(invoke('input', window, firstId), /すでに/);
  assert.throws(() => invoke('complete', window, firstId, { dataUrl: 'invalid' }), /不正/);
  invoke('complete', window, firstId, result);
  assert.deepEqual(await first, result);
  const second = start('second.stl');
  assert.equal(windows.length, 1);
  const secondId = window.jobs.at(-1);
  assert.notEqual(secondId, firstId);
  assert.throws(() => invoke('complete', window, firstId, result), /許可されていない/);
  await assert.rejects(invoke('input', window, firstId), /許可されていない/);
  assert.equal((await invoke('input', window, secondId)).name, 'second.stl');
  invoke('complete', window, secondId, result);
  assert.deepEqual(await second, result);
  worker.close();
  assert(window.isDestroyed());
});

test('ordinary model errors keep the reusable window healthy', async () => {
  const { worker, windows, start, invoke } = fixture();
  const first = start('bad.stl');
  const [window] = windows;
  invoke('ready', window);
  const id = window.jobs.at(-1);
  await invoke('input', window, id);
  invoke('fail', window, id, 'bad geometry');
  await assert.rejects(first, /bad geometry/);
  const second = start('healthy.stl');
  assert.equal(windows.length, 1);
  assert(!window.isDestroyed());
  const secondId = window.jobs.at(-1);
  await invoke('input', window, secondId);
  invoke('complete', window, secondId, result);
  await second;
  worker.close();
});

test('timed-out input cannot complete or shift across into a replacement window', async () => {
  let releaseRead;
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  const reads = [];
  const { worker, windows, start, invoke } = fixture({ readInput: (item, { signal }) => {
    reads.push({ name: item.name, signal });
    return item.name === 'hung.stl' ? pendingRead : item;
  } });
  const controller = new AbortController();
  const first = start('hung.stl', controller.signal);
  const [window] = windows;
  invoke('ready', window);
  const firstId = window.jobs.at(-1);
  const input = invoke('input', window, firstId);
  const reason = new Error('timed out');
  reason.name = 'TimeoutError';
  controller.abort(reason);
  await assert.rejects(first, { name: 'TimeoutError' });
  assert(window.isDestroyed());
  assert.equal(reads[0].signal.aborted, true);
  const second = start('healthy.stl');
  const next = windows.at(-1);
  assert.notEqual(next, window);
  invoke('ready', next);
  const secondId = next.jobs.at(-1);
  assert.throws(() => invoke('complete', window, secondId, result), /許可されていない/);
  const nextInput = invoke('input', next, secondId);
  assert.deepEqual(reads.map(read => read.name), ['hung.stl']);
  releaseRead({ name: 'hung.stl' });
  await assert.rejects(input, { name: 'TimeoutError' });
  await nextInput;
  assert.deepEqual(reads.map(read => read.name), ['hung.stl', 'healthy.stl']);
  invoke('complete', next, secondId, result);
  await second;
  worker.close();
});

test('a renderer crash replaces the window and a late error in the old window is ignored', async () => {
  const { worker, windows, start, invoke } = fixture();
  const first = start('first.stl');
  const [window] = windows;
  invoke('ready', window);
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await assert.rejects(first, /crashed/);
  assert(window.isDestroyed());
  const second = start('next.stl');
  const next = windows.at(-1);
  invoke('ready', next);
  const id = next.jobs.at(-1);
  window.webContents.emit('did-fail-load', {}, -2, 'late failure', '', true);
  assert(!next.isDestroyed());
  await invoke('input', next, id);
  invoke('complete', next, id, result);
  await second;
  worker.close();
});
