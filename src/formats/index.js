import { checkInput, abortIfNeeded, disposeModel } from './common.js';
import { loadSTL } from './stl.js';
import { loadSTEP } from './step.js';
import { load3MF } from './three-mf.js';
import { resolvePreviewLimits } from './preview-memory.js';
import { loadMeshInWorker } from './mesh-worker-client.js';

/** Add another adapter here; library storage and viewport do not need changes. */
export const modelAdapters = [
  { id: 'stl', extensions: ['stl'], load: loadSTL },
  { id: 'step', extensions: ['step', 'stp'], load: loadSTEP },
  { id: '3mf', extensions: ['3mf'], load: load3MF },
];

export async function loadModel(bytes, { filename = '', signal, memoryBudgetMiB = 2048, offThread = false, consumeInput = false } = {}) {
  const limits = resolvePreviewLimits(memoryBudgetMiB);
  const buffer = checkInput(bytes, signal, limits, consumeInput);
  const extension = filename.split('.').at(-1)?.toLowerCase();
  const adapter = modelAdapters.find((candidate) => candidate.extensions.includes(extension));
  if (!adapter) throw new Error(`未対応のファイル形式です: ${extension || filename}`);
  // A sliced view is already private. Whole caller-owned ArrayBuffers retain
  // their contents unless the caller explicitly hands ownership to the loader.
  const ownsBuffer = consumeInput || (bytes !== buffer && bytes.buffer !== buffer);
  const options = { filename, signal, limits, ownsBuffer };
  const useWorker = offThread && typeof Worker === 'function' && (
    adapter.id === '3mf' || (adapter.id === 'stl' && buffer.byteLength >= 256 * 1024)
  );
  const result = useWorker ? await loadMeshInWorker(adapter.id, buffer, options) : await adapter.load(buffer, options);
  try { abortIfNeeded(signal); } catch (error) { disposeModel(result.object); throw error; }
  result.object?.updateMatrixWorld(true);
  return result;
}

export { disposeModel };
