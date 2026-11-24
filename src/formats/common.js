import * as THREE from 'three';
import { HARD_LIMITS, resolvePreviewLimits } from './preview-memory.js';

export const LIMITS = Object.freeze(resolvePreviewLimits());
export const DEFAULT_COLOR = '#a9c9cf';

function sizeLabel(value) {
  return value < 1024 * 1024 ? `${value.toLocaleString('ja-JP')} B` : `${(value / (1024 * 1024)).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} MiB`;
}

export function limitExceeded(target, actual, maximum, { bytes = false, hard = false } = {}) {
  const format = bytes ? sizeLabel : (value) => value.toLocaleString('ja-JP');
  const detail = `${target}は ${format(actual)} で、${hard ? '実装上' : '現在'}の上限 ${format(maximum)} を超えています。`;
  const guidance = hard
    ? 'この上限はメモリ設定では変更できません。モデルを分割するか、Bambu Studioで開いてください。'
    : '「設定と連携」→「プレビューメモリ」で読み込み予算を増やしてください。';
  const error = new Error(`${detail}${guidance}`);
  error.code = hard ? 'PREVIEW_IMPLEMENTATION_LIMIT' : 'PREVIEW_MEMORY_LIMIT';
  return error;
}

export function abortIfNeeded(signal) {
  if (signal?.aborted) throw new DOMException('読み込みをキャンセルしました', 'AbortError');
}

export function arrayBufferOf(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  throw new TypeError('モデルデータが不正です');
}

export function checkInput(bytes, signal, limits = LIMITS) {
  abortIfNeeded(signal);
  if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new TypeError('モデルデータが不正です');
  if (!bytes.byteLength) throw new Error('ファイルが空です');
  if (bytes.byteLength > limits.fileBytes) throw limitExceeded('入力ファイルのサイズ', bytes.byteLength, limits.fileBytes, { bytes: true, hard: limits.fileBytes >= HARD_LIMITS.fileBytes });
  return arrayBufferOf(bytes);
}

export function surfaceMaterial(options = {}) {
  return new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, roughness: 0.58, metalness: 0.08, side: THREE.DoubleSide, ...options });
}

export function validateGeometry(geometry, limits = LIMITS) {
  const positions = geometry.getAttribute('position');
  if (!positions || positions.count < 3) throw new Error('表示できる三角形がありません');
  const count = geometry.index ? geometry.index.count : positions.count;
  if (count % 3 !== 0) throw new Error('モデルの三角形データが不正です（頂点参照数が3の倍数ではありません）');
  if (count / 3 > limits.triangles) throw limitExceeded('モデルの三角形数', count / 3, limits.triangles, { hard: limits.triangles >= HARD_LIMITS.triangles });
  for (const value of positions.array) if (!Number.isFinite(value)) throw new Error('モデルに不正な座標が含まれています');
  if (geometry.index) for (const index of geometry.index.array) if (!Number.isInteger(index) || index < 0 || index >= positions.count) throw new Error('モデルに不正な頂点参照があります');
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

export function disposeModel(object) {
  if (!object) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  object.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}
