import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PREVIEW_MEMORY_CONFIG, resolvePreviewLimits, normalizeMemoryBudget } from '../src/formats/preview-memory.js';
const backend = createRequire(import.meta.url)('../shared/preview-memory.cjs');

test('renderer and main process use the same limits for presets and custom budgets', () => {
  for (const value of [...PREVIEW_MEMORY_CONFIG.budgetsMiB, 1536, 12288, 32767, undefined, null, 0, '8192', NaN, Infinity]) {
    assert.deepEqual(resolvePreviewLimits(value), backend.resolvePreviewLimits(value));
    assert.equal(normalizeMemoryBudget(value), backend.normalizeMemoryBudget(value));
  }
});

test('larger budgets expand limits but preserve parser and geometry ceilings', () => {
  assert.deepEqual(resolvePreviewLimits(2048), PREVIEW_MEMORY_CONFIG.baseLimits);
  assert.equal(resolvePreviewLimits(8192).archiveBytes, 1536 * 1024 ** 2);
  assert.equal(resolvePreviewLimits(8192).xmlBytes, 256 * 1024 ** 2);
  assert.equal(resolvePreviewLimits(8192).triangles, 12_000_000);
  assert.deepEqual(resolvePreviewLimits(32768), PREVIEW_MEMORY_CONFIG.hardLimits);
  for (const bad of [null, undefined, 511, 32769, 1024.5, '2048', Infinity]) assert.throws(() => backend.assertMemoryBudget(bad));
});
