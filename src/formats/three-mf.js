import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { abortIfNeeded, DEFAULT_COLOR, disposeModel, LIMITS, limitExceeded, surfaceMaterial, validateGeometry } from './common.js';
import { HARD_LIMITS } from './preview-memory.js';

const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const localName = (node) => node.localName || node.local || node.nodeName.split(':').at(-1);
const attr = (node, name) => node?.getAttribute(name) || '';
const VERTEX_ATTRS = ['v1', 'v2', 'v3'];
const COLOR_ATTRS = ['p1', 'p2', 'p3'];

function children(node, name) {
  const result = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (!name || localName(child) === name)) result.push(child);
  }
  return result;
}

function child(node, name) {
  for (let item = node?.firstChild; item; item = item.nextSibling) {
    if (item.nodeType === 1 && localName(item) === name) return item;
  }
}

function nsAttr(node, name) {
  for (let i = 0; i < (node?.attributes?.length ?? 0); i++) {
    const item = node.attributes[i];
    if (localName(item) === name) return item.value;
  }
  return '';
}

function archivePath(value, from = '') {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { decoded = value; }
  const raw = decoded.replaceAll('\\', '/');
  const parts = raw.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('3MF内の参照先が不正です'); parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

function parseXML(data, label, parseDocument) {
  const text = strFromU8(data);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCTYPEを含む3MFは表示できません');
  const root = parseDocument(text);
  if (!root) throw new Error(`3MFのXMLが壊れています: ${label}`);
  return root;
}

function nativeXmlDocument(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  return document.getElementsByTagName('parsererror').length ? undefined : document.documentElement;
}

function finiteNumber(value, label) {
  if (value === '' || value == null) throw new Error(`3MFの${label}がありません`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`3MFの${label}が不正です`);
  return number;
}

function integer(value, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) throw new Error(`3MFの${label}が不正です`);
  return number;
}

function transform(value) {
  if (!value) return new THREE.Matrix4();
  const a = value.trim().split(/\s+/).map(Number);
  if (a.length !== 12 || a.some((number) => !Number.isFinite(number))) throw new Error('3MFの配置行列が不正です');
  return new THREE.Matrix4().set(a[0], a[3], a[6], a[9], a[1], a[4], a[7], a[10], a[2], a[5], a[8], a[11], 0, 0, 0, 1);
}

function parseColor(value) {
  if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) return new THREE.Color(DEFAULT_COLOR);
  return new THREE.Color(value.slice(0, 7));
}

/** Inspect ZIP headers only: returning false for every member prevents inflation. */
export function inspect3MFArchive(buffer, { signal, limits = LIMITS } = {}) {
  abortIfNeeded(signal);
  let expandedBytes = 0;
  let files = 0;
  const thumbnails = [];
  const selected = new Map();
  unzipSync(new Uint8Array(buffer), {
    filter: (entry) => {
      abortIfNeeded(signal);
      if (++files > 20_000) throw new Error(`3MF内のファイル数は ${files.toLocaleString('ja-JP')} で、構造上の上限20,000件を超えています。`);
      const name = archivePath(entry.name);
      if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > buffer.byteLength) throw new Error(`3MFのZIPサイズ情報が不正です: ${name}`);
      // A stored member is copied using its compressed size by fflate, so both
      // declarations must agree before applying the uncompressed-byte budget.
      if (entry.compression === 0 && entry.size !== entry.originalSize) throw new Error(`3MFの無圧縮ZIPサイズが一致しません: ${name}`);
      if (/\.(png|jpe?g)$/i.test(name) && /thumbnail|plate_\d/i.test(name)) thumbnails.push(name);
      const wanted = /\.model$/i.test(name) || /^_rels\/\.rels$/i.test(name);
      if (!wanted) return false;
      if (selected.has(name)) throw new Error(`3MFに重複したモデルファイルがあります: ${name}`);
      expandedBytes += entry.originalSize;
      if (entry.originalSize > HARD_LIMITS.xmlBytes) throw limitExceeded(`3MFの単一モデルXML「${name}」`, entry.originalSize, HARD_LIMITS.xmlBytes, { bytes: true, hard: true });
      if (entry.originalSize > limits.xmlBytes) throw limitExceeded(`3MFの単一モデルXML「${name}」`, entry.originalSize, limits.xmlBytes, { bytes: true });
      if (expandedBytes > limits.archiveBytes) throw limitExceeded('3MFの展開後XML合計サイズ', expandedBytes, limits.archiveBytes, { bytes: true, hard: limits.archiveBytes >= HARD_LIMITS.archiveBytes });
      selected.set(name, { ...entry, canonicalName: name });
      return false;
    },
  });
  return { selected, thumbnails, expandedBytes, files };
}

/** 3MF geometry reader. Object identity is scoped to its ZIP model part. */
export async function load3MF(buffer, { signal, limits = LIMITS, parseDocument = nativeXmlDocument } = {}) {
  // Validate every member before allocating any expanded XML, including members
  // near the end of the archive. Limits inside an inflating filter are too late.
  const { selected, thumbnails } = inspect3MFArchive(buffer, { signal, limits });
  function extractPart(name) {
    if (!selected.has(name)) return undefined;
    // Inflate model parts on demand; retaining every expanded XML at once adds
    // the entire archive budget on top of DOM nodes and GPU-ready mesh arrays.
    const extracted = unzipSync(new Uint8Array(buffer), {
      filter: (entry) => {
        abortIfNeeded(signal);
        return archivePath(entry.name) === name;
      },
    });
    const data = Object.values(extracted)[0];
    if (!data || data.byteLength !== selected.get(name).originalSize) throw new Error(`3MFの展開サイズがZIP情報と一致しません: ${name}`);
    return data;
  }
  const models = new Map();
  const warnings = new Set();
  const allocated = new THREE.Group();
  let triangleCount = 0;
  let instanceCount = 0;
  let objectCount = 0;
  let hasPaint = false;
  let unsupportedMaterial = false;

  function previewOnly(reason) {
    const choices = thumbnails.sort((a,b) => {
      const rank = name => /Metadata\/plate_1\.png$/i.test(name) ? 0 : /thumbnail_3mf\.png$/i.test(name) ? 1 : /thumbnail/i.test(name) ? 2 : 3;
      return rank(a)-rank(b);
    });
    const candidate = choices[0];
    if (!candidate) throw new Error(reason);
    const extracted = unzipSync(new Uint8Array(buffer), { filter: entry => archivePath(entry.name) === candidate && entry.originalSize <= 4 * 1024 * 1024 });
    const bytes = Object.values(extracted)[0];
    if (!bytes) throw new Error(reason);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const mime = /\.png$/i.test(candidate) ? 'image/png' : 'image/jpeg';
    return { object: null, unit: 'mm', previewImage: `data:${mime};base64,${btoa(binary)}`, warnings: [reason], metadata: { previewOnly: true, thumbnailPath: candidate } };
  }

  function cloneBounded(object) {
    let nodes = 0;
    object.traverse(() => { nodes++; });
    if (instanceCount + nodes - 1 > limits.instances) throw limitExceeded('3MFの部品配置数', instanceCount + nodes - 1, limits.instances, { hard: limits.instances >= HARD_LIMITS.instances });
    instanceCount += nodes - 1;
    return object.clone(true);
  }

  function modelAt(path) {
    if (models.has(path)) return models.get(path);
    const data = extractPart(path);
    if (!data) throw new Error(`3MFの部品ファイルが見つかりません: ${path}`);
    const xml = parseXML(data, path, parseDocument);
    if (localName(xml) !== 'model') throw new Error(`3MFのモデル定義が不正です: ${path}`);
    const unit = attr(xml, 'unit') || 'millimeter';
    if (!(unit in UNITS)) throw new Error(`未対応の3MF単位です: ${unit}`);
    const resources = child(xml, 'resources');
    const objects = new Map();
    const colors = new Map();
    for (const resource of children(resources)) {
      const name = localName(resource);
      const id = attr(resource, 'id');
      if (name === 'object') {
        if (++objectCount > limits.instances) throw limitExceeded('3MFのオブジェクト数', objectCount, limits.instances, { hard: limits.instances >= HARD_LIMITS.instances });
        if (!id || objects.has(id)) throw new Error('3MFに重複または不正なオブジェクトIDがあります');
        objects.set(id, resource);
      } else if (name === 'basematerials') {
        colors.set(id, children(resource, 'base').map((item) => parseColor(attr(item, 'displaycolor'))));
      } else if (name === 'colorgroup') {
        colors.set(id, children(resource, 'color').map((item) => parseColor(attr(item, 'color'))));
      } else if (/texture|multi|composite/i.test(name)) unsupportedMaterial = true;
    }
    const model = { path, xml, objects, colors, scale: UNITS[unit], unit, cache: new Map() };
    models.set(path, model);
    return model;
  }

  function meshFromXML(model, definition, meshXML) {
    const vertexXML = child(meshXML, 'vertices');
    const triangleXML = child(meshXML, 'triangles');
    const pointRows = vertexXML?.pointRows;
    const indexRows = triangleXML?.indexRows;
    const vertexNodes = pointRows ? null : children(vertexXML, 'vertex');
    const triangleNodes = indexRows ? null : children(triangleXML, 'triangle');
    const vertexCount = pointRows ? pointRows.length / 3 : vertexNodes.length;
    const meshTriangles = indexRows ? indexRows.length / 3 : triangleNodes.length;
    if (!vertexCount || !meshTriangles) throw new Error('3MFのメッシュに頂点または三角形がありません');
    triangleCount += meshTriangles;
    if (triangleCount > limits.triangles) throw limitExceeded('3MFの三角形数', triangleCount, limits.triangles, { hard: limits.triangles >= HARD_LIMITS.triangles });
    if (vertexCount > limits.triangles * 3) throw limitExceeded('3MFの頂点数', vertexCount, limits.triangles * 3, { hard: limits.triangles >= HARD_LIMITS.triangles });
    const vertices = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      const offset = i * 3;
      const node = vertexNodes?.[i];
      vertices[offset] = finiteNumber(pointRows ? pointRows[offset] : attr(node, 'x'), 'X座標');
      vertices[offset + 1] = finiteNumber(pointRows ? pointRows[offset + 1] : attr(node, 'y'), 'Y座標');
      vertices[offset + 2] = finiteNumber(pointRows ? pointRows[offset + 2] : attr(node, 'z'), 'Z座標');
    }
    const positions = new Float32Array(meshTriangles * 9);
    let colors;
    const defaultColor = new THREE.Color(DEFAULT_COLOR);
    const objectPID = attr(definition, 'pid');
    const objectPIndex = attr(definition, 'pindex') || '0';
    let colored = false;
    for (let i = 0; i < meshTriangles; i++) {
      const triangle = indexRows ? triangleXML.triangleStyles?.get(i) : triangleNodes[i];
      if (attr(triangle, 'paint_color')) hasPaint = true;
      const pid = attr(triangle, 'pid') || objectPID;
      const palette = model.colors.get(pid);
      if (pid && !palette) unsupportedMaterial = true;
      if (palette && !colors) {
        colors = new Float32Array(positions.length);
        for (let offset = 0; offset < colors.length; offset += 3) {
          colors[offset] = defaultColor.r;
          colors[offset + 1] = defaultColor.g;
          colors[offset + 2] = defaultColor.b;
        }
      }
      const first = attr(triangle, 'p1') || objectPIndex;
      for (let corner = 0; corner < 3; corner++) {
        const vertex = integer(indexRows ? indexRows[i * 3 + corner] : attr(triangle, VERTEX_ATTRS[corner]), '頂点インデックス');
        if (vertex >= vertexCount) throw new Error('3MFの頂点参照が範囲外です');
        const dest = i * 9 + corner * 3;
        const source = vertex * 3;
        positions[dest] = vertices[source];
        positions[dest + 1] = vertices[source + 1];
        positions[dest + 2] = vertices[source + 2];
        const pindex = attr(triangle, COLOR_ATTRS[corner]) || first;
        const color = palette?.[integer(pindex, '色インデックス')] || defaultColor;
        if (palette) colored = true;
        if (colors) {
          colors[dest] = color.r;
          colors[dest + 1] = color.g;
          colors[dest + 2] = color.b;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    try {
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      if (colored) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      validateGeometry(geometry, limits);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, surfaceMaterial(colored ? { color: '#ffffff', vertexColors: true } : {}));
      allocated.add(mesh);
      return mesh;
    } catch (error) { geometry.dispose(); throw error; }
  }

  function buildObject(model, id, stack = new Set()) {
    const key = `${model.path}#${id}`;
    if (stack.has(key)) throw new Error('3MFの部品参照が循環しています');
    if (stack.size >= limits.depth) throw new Error(`3MFの部品階層は ${stack.size + 1} 段で、構造上の上限 ${limits.depth} 段を超えています。`);
    if (++instanceCount > limits.instances) throw limitExceeded('3MFの部品配置数', instanceCount, limits.instances, { hard: limits.instances >= HARD_LIMITS.instances });
    if (model.cache.has(id)) return cloneBounded(model.cache.get(id));
    const definition = model.objects.get(id);
    if (!definition) throw new Error(`3MFの部品が見つかりません: ${key}`);
    const next = new Set(stack).add(key);
    const meshXML = child(definition, 'mesh');
    const object = meshXML ? meshFromXML(model, definition, meshXML) : new THREE.Group();
    object.name = attr(definition, 'name') || `Object ${id}`;
    object.userData = { format: '3mf', modelPath: model.path, objectId: id };
    const components = child(definition, 'components');
    for (const component of children(components, 'component')) {
      const targetPath = nsAttr(component, 'path');
      const targetModel = targetPath ? modelAt(archivePath(targetPath, model.path)) : model;
      const part = buildObject(targetModel, attr(component, 'objectid'), next);
      // Each model part has its own unit. Convert it before the parent transform.
      part.scale.multiplyScalar(targetModel.scale / model.scale);
      part.applyMatrix4(transform(attr(component, 'transform')));
      object.add(part);
    }
    if (!meshXML && !object.children.length) warnings.add('メッシュを含まない部品は表示していません。');
    model.cache.set(id, object);
    // Repeated references use the cached Three.js template, so the much larger
    // source DOM for this object no longer needs to stay alive.
    model.objects.delete(id);
    definition.parentNode?.removeChild(definition);
    return cloneBounded(object);
  }

  try {
    let rootPath;
    const relationships = extractPart('_rels/.rels');
    if (relationships) {
      const xml = parseXML(relationships, '_rels/.rels', parseDocument);
      const relationship = children(xml, 'Relationship').find((item) => /\/3dmodel$/.test(attr(item, 'Type')));
      if (relationship) rootPath = archivePath(attr(relationship, 'Target'));
    }
    rootPath ||= [...selected.keys()].find((name) => /^3D\/3dmodel\.model$/i.test(name));
    rootPath ||= [...selected.keys()].find((name) => /^3D\/[^/]+\.model$/i.test(name));
    if (!rootPath) return previewOnly('この3MFには3D形状が含まれていません。保存済みの画像を表示しています。');
    const model = modelAt(rootPath);
    const group = new THREE.Group();
    group.name = '3MF';
    const build = child(model.xml, 'build');
    const items = children(build, 'item');
    if (!items.length) return previewOnly('この3MFには配置済みの3D形状がありません。保存済みの画像を表示しています。');
    let displayedTriangles = 0;
    for (const item of items) {
      abortIfNeeded(signal);
      const targetPath = nsAttr(item, 'path');
      const targetModel = targetPath ? modelAt(archivePath(targetPath, model.path)) : model;
      const object = buildObject(targetModel, attr(item, 'objectid'));
      object.scale.multiplyScalar(targetModel.scale / model.scale);
      object.applyMatrix4(transform(attr(item, 'transform')));
      object.traverse((node) => { if (node.isMesh) displayedTriangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3; });
      if (displayedTriangles > limits.triangles) throw limitExceeded('3MFの配置後の三角形数', displayedTriangles, limits.triangles, { hard: limits.triangles >= HARD_LIMITS.triangles });
      group.add(object);
    }
    if (!displayedTriangles) throw new Error('3MFに表示できる三角形がありません');
    group.scale.setScalar(model.scale);
    if (hasPaint) warnings.add('Bambu / Orcaのペイント色は省略して形状を表示しています。印刷設定・元ファイルは保持されます。');
    if (unsupportedMaterial) warnings.add('一部のテクスチャ・複合マテリアルは基本色で表示しています。');
    return { object: group, unit: 'mm', warnings: [...warnings], metadata: { sourceUnit: model.unit, parts: models.size, objects: objectCount, triangles: displayedTriangles, thumbnails, hasPaint } };
  } catch (error) {
    disposeModel(allocated);
    throw error;
  }
}
