import config from '../../shared/preview-memory.json' with { type: 'json' };

export const PREVIEW_MEMORY_CONFIG = Object.freeze(config);
export const HARD_LIMITS = Object.freeze(config.hardLimits);

export function normalizeMemoryBudget(value) {
  return Number.isInteger(value) && value >= config.minBudgetMiB && value <= config.maxBudgetMiB
    ? value : config.defaultBudgetMiB;
}

export function effectivePreviewBudget(settings = {}) {
  return settings.lightweightPreview === false ? normalizeMemoryBudget(settings.memoryBudgetMiB) : config.lightweightBudgetMiB;
}

// Same policy as the Electron reader: data format and multipliers live in the shared JSON.
export function resolvePreviewLimits(value = config.defaultBudgetMiB) {
  const scale = normalizeMemoryBudget(value) / config.defaultBudgetMiB;
  return Object.fromEntries(Object.entries(config.baseLimits).map(([key, base]) => [
    key, key === 'depth' ? base : Math.min(config.hardLimits[key], Math.floor(base * scale)),
  ]));
}

export function formatMemoryBytes(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} GiB`
    : `${(bytes / 1024 ** 2).toLocaleString('ja-JP', { maximumFractionDigits: 1 })} MiB`;
}
