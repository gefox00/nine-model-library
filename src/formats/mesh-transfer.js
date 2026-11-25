import * as THREE from 'three';
import { surfaceMaterial } from './common.js';

/** Keep mesh arrays in transferable buffers and reuse shared 3MF resources. */
export function encodeMeshResult({ object, ...result }) {
  const geometries = [];
  const materials = [];
  const geometryIds = new Map();
  const materialIds = new Map();
  const buffers = new Set();

  function attribute({ array, itemSize, normalized }) {
    buffers.add(array.buffer);
    return { array, itemSize, normalized };
  }

  function geometryId(geometry) {
    if (geometryIds.has(geometry)) return geometryIds.get(geometry);
    const id = geometries.length;
    geometryIds.set(geometry, id);
    geometries.push({
      attributes: Object.entries(geometry.attributes).map(([name, data]) => [name, attribute(data)]),
      index: geometry.index && attribute(geometry.index),
      groups: geometry.groups,
      box: [geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()],
      sphere: [geometry.boundingSphere.center.toArray(), geometry.boundingSphere.radius],
      hasColors: geometry.hasColors,
      alpha: geometry.alpha,
    });
    return id;
  }

  function materialId(material) {
    if (materialIds.has(material)) return materialIds.get(material);
    const id = materials.length;
    materialIds.set(material, id);
    const { color, vertexColors, opacity, transparent, flatShading } = material;
    materials.push({ color: color.toArray(), vertexColors, opacity, transparent, flatShading });
    return id;
  }

  function encodeObject(node) {
    return {
      name: node.name,
      userData: node.userData,
      position: node.position.toArray(),
      quaternion: node.quaternion.toArray(),
      scale: node.scale.toArray(),
      children: node.children.map(encodeObject),
      geometry: node.isMesh ? geometryId(node.geometry) : undefined,
      material: node.isMesh ? materialId(node.material) : undefined,
    };
  }

  return {
    payload: { result, tree: object && encodeObject(object), geometries, materials },
    transfer: [...buffers],
  };
}

export function decodeMeshResult({ result, tree, geometries, materials }) {
  const attribute = ({ array, itemSize, normalized }) => new THREE.BufferAttribute(array, itemSize, normalized);
  const meshGeometries = geometries.map(({ attributes, index, groups, box, sphere, hasColors, alpha }) => {
    const geometry = new THREE.BufferGeometry();
    for (const [name, data] of attributes) geometry.setAttribute(name, attribute(data));
    if (index) geometry.setIndex(attribute(index));
    geometry.groups = groups;
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...box[0]), new THREE.Vector3(...box[1]));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...sphere[0]), sphere[1]);
    if (hasColors !== undefined) geometry.hasColors = hasColors;
    if (alpha !== undefined) geometry.alpha = alpha;
    return geometry;
  });
  const meshMaterials = materials.map(({ color, ...options }) => surfaceMaterial({ ...options, color: new THREE.Color(...color) }));

  function decodeObject({ name, userData, position, quaternion, scale, children, geometry, material }) {
    const object = geometry === undefined ? new THREE.Group() : new THREE.Mesh(meshGeometries[geometry], meshMaterials[material]);
    object.name = name;
    object.userData = userData;
    object.position.fromArray(position);
    object.quaternion.fromArray(quaternion);
    object.scale.fromArray(scale);
    for (const child of children) object.add(decodeObject(child));
    return object;
  }

  return { ...result, object: tree && decodeObject(tree) };
}
