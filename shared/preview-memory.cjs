const config = require('./preview-memory.json');

function assertMemoryBudget(value) {
  if (!Number.isInteger(value) || value < config.minBudgetMiB || value > config.maxBudgetMiB) {
    throw new Error('プレビューメモリは512〜32768 MiB（0.5〜32 GiB）の整数で指定してください');
  }
  return value;
}

function normalizeMemoryBudget(value) {
  try { return assertMemoryBudget(value); } catch { return config.defaultBudgetMiB; }
}

// Keep the renderer calculation equivalent; parity is checked in preview-memory.test.mjs.
function resolvePreviewLimits(value = config.defaultBudgetMiB) {
  const budgetMiB = normalizeMemoryBudget(value);
  const scale = budgetMiB / config.defaultBudgetMiB;
  return Object.fromEntries(Object.entries(config.baseLimits).map(([key, base]) => [
    key, key === 'depth' ? base : Math.min(config.hardLimits[key], Math.floor(base * scale)),
  ]));
}

module.exports = { PREVIEW_MEMORY_CONFIG: config, assertMemoryBudget, normalizeMemoryBudget, resolvePreviewLimits };
