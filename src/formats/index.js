import { checkInput, abortIfNeeded, disposeModel } from './common.js';
import { loadSTL } from './stl.js';
import { loadSTEP } from './step.js';
import { load3MF } from './three-mf.js';
import { resolvePreviewLimits } from './preview-memory.js';

/** Add another adapter here; library storage and viewport do not need changes. */
export const modelAdapters = [
  { id: 'stl', extensions: ['stl'], load: loadSTL },
  { id: 'step', extensions: ['step', 'stp'], load: loadSTEP },
  { id: '3mf', extensions: ['3mf'], load: load3MF },
];

export async function loadModel(bytes, { filename = '', signal, memoryBudgetMiB = 2048 } = {}) {
  const limits = resolvePreviewLimits(memoryBudgetMiB);
  const buffer = checkInput(bytes, signal, limits);
  const extension = filename.split('.').at(-1)?.toLowerCase();
  const adapter = modelAdapters.find((candidate) => candidate.extensions.includes(extension));
  if (!adapter) throw new Error(`未対応のファイル形式です: ${extension || filename}`);
  const result = await adapter.load(buffer, { filename, signal, limits });
  try { abortIfNeeded(signal); } catch (error) { disposeModel(result.object); throw error; }
  result.object?.updateMatrixWorld(true);
  return result;
}

export { disposeModel };
