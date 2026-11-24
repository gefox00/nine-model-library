import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { LIMITS, limitExceeded, surfaceMaterial, validateGeometry } from './common.js';
import { HARD_LIMITS } from './preview-memory.js';

export async function loadSTL(buffer, { limits = LIMITS } = {}) {
  // Reject oversized binary facet counts before STLLoader allocates geometry.
  if (buffer.byteLength >= 84) {
    const facets = new DataView(buffer).getUint32(80, true);
    if (84 + facets * 50 === buffer.byteLength && facets > limits.triangles) throw limitExceeded('STLの三角形数', facets, limits.triangles, { hard: limits.triangles >= HARD_LIMITS.triangles });
  }
  const geometry = new STLLoader().parse(buffer);
  try {
    validateGeometry(geometry, limits);
    geometry.computeVertexNormals();
    const options = geometry.hasColors ? { vertexColors: true, color: '#ffffff', opacity: geometry.alpha, transparent: geometry.alpha < 1 } : {};
    return { object: new THREE.Mesh(geometry, surfaceMaterial(options)), unit: 'mm', warnings: ['STLには単位情報がないため、mmとして表示しています。'] };
  } catch (error) {
    geometry.dispose();
    throw error;
  }
}
