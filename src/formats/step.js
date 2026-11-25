import * as THREE from 'three';
import { abortIfNeeded, disposeModel, LIMITS, limitExceeded, surfaceMaterial, validateGeometry } from './common.js';
import { HARD_LIMITS } from './preview-memory.js';

export function meshFromStep(mesh, limits = LIMITS) {
  const geometry = new THREE.BufferGeometry();
  try {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
    geometry.setIndex(mesh.index.array);
    validateGeometry(geometry, limits);
    if (mesh.attributes.normal?.array?.length === mesh.attributes.position.array.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
    else geometry.computeVertexNormals();
    const materials = [];
    const materialIndices = new Map();
    const getMaterial = (color) => {
      const key = color?.join(',') ?? 'default';
      if (!materialIndices.has(key)) {
        materialIndices.set(key, materials.length);
        materials.push(surfaceMaterial(color ? { color: new THREE.Color(...color) } : {}));
      }
      return materialIndices.get(key);
    };
    const fallback = getMaterial(mesh.color);
    let cursor = 0;
    const faces = [...(mesh.brep_faces ?? [])].sort((a, b) => a.first - b.first);
    for (const face of faces) {
      const start = face.first * 3;
      const end = (face.last + 1) * 3;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end <= start || end > geometry.index.count) continue;
      if (start > cursor) geometry.addGroup(cursor, start - cursor, fallback);
      geometry.addGroup(start, end - start, getMaterial(face.color ?? mesh.color));
      cursor = end;
    }
    if (cursor < geometry.index.count) geometry.addGroup(cursor, geometry.index.count - cursor, fallback);
    const object = new THREE.Mesh(geometry, materials);
    object.name = mesh.name || 'STEP part';
    return object;
  } catch (error) {
    geometry.dispose();
    throw error;
  }
}

export function objectFromStep(result, limits = LIMITS) {
  if (!result.success || !result.meshes?.length) throw new Error('STEPから表示できる形状を読み取れませんでした');
  const triangles = result.meshes.reduce((sum, mesh) => sum + (mesh.index?.array?.length ?? 0) / 3, 0);
  if (triangles > limits.triangles) throw limitExceeded('STEPの三角形数', triangles, limits.triangles, { hard: limits.triangles >= HARD_LIMITS.triangles });
  const root = new THREE.Group();
  root.name = result.root?.name || 'STEP';
  try {
    // OCCT output positions already include assembly transforms; preserve mesh names.
    for (const mesh of result.meshes) root.add(meshFromStep(mesh, limits));
    return { object: root, unit: 'mm', warnings: [], metadata: { parts: result.meshes.length, triangles, tessellated: true } };
  } catch (error) {
    disposeModel(root);
    throw error;
  }
}

export async function loadSTEP(buffer, { signal, limits = LIMITS, ownsBuffer = false } = {}) {
  abortIfNeeded(signal);
  const worker = new Worker(new URL(`${import.meta.env.BASE_URL}occt/step-worker.js`, window.location.href));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('STEPの変換が180秒を超えました。モデルを分割して試してください。')), 180_000);
    const onAbort = () => finish(new DOMException('読み込みをキャンセルしました', 'AbortError'));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || 'STEP変換エンジンを起動できませんでした'));
    worker.onmessage = ({ data }) => {
      if (data.error) return finish(new Error(data.error));
      try { finish(null, objectFromStep(data.result, limits)); } catch (error) { finish(error); }
    };
    const transferred = ownsBuffer ? buffer : buffer.slice(0);
    try { worker.postMessage({ buffer: transferred, limits, hardTriangleLimit: HARD_LIMITS.triangles }, [transferred]); } catch (error) { finish(error); }
  });
}
