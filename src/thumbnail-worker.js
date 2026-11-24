import * as THREE from 'three';
import { loadModel, disposeModel } from './formats/index.js';

const WIDTH = 480;
const HEIGHT = 360;
const BACKGROUND = '#141b25';
const MAX_DATA_URL_LENGTH = 250000;
const api = window.nineThumbnail;
let currentJob = null;
let renderer = null;

function encodeThumbnail(canvas) {
  const png = canvas.toDataURL('image/png');
  if (png.startsWith('data:image/png;base64,') && png.length <= MAX_DATA_URL_LENGTH) return png;
  for (const quality of [0.85, 0.72, 0.55]) {
    const jpeg = canvas.toDataURL('image/jpeg', quality);
    if (jpeg.startsWith('data:image/jpeg;base64,') && jpeg.length <= MAX_DATA_URL_LENGTH) return jpeg;
  }
  throw new Error('サムネイルを保存可能なサイズに圧縮できませんでした');
}

async function resizeSavedPreview(source, signal) {
  const image = new Image();
  let canvas;
  try {
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        image.src = '';
        reject(new DOMException('サムネイル生成をキャンセルしました', 'AbortError'));
      };
      const finish = callback => {
        signal.removeEventListener('abort', onAbort);
        image.onload = null;
        image.onerror = null;
        callback();
      };
      image.onload = () => finish(resolve);
      image.onerror = () => finish(() => reject(new Error('保存されたプレビュー画像を読み込めませんでした')));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      image.src = source;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('プレビュー画像のサイズが不正です');
    canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('サムネイル描画用のキャンバスを作成できませんでした');
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    const ratio = Math.min(WIDTH / image.naturalWidth, HEIGHT / image.naturalHeight);
    const width = image.naturalWidth * ratio;
    const height = image.naturalHeight * ratio;
    context.drawImage(image, (WIDTH - width) / 2, (HEIGHT - height) / 2, width, height);
    return encodeThumbnail(canvas);
  } finally {
    image.onload = null;
    image.onerror = null;
    image.src = '';
    if (canvas) canvas.width = canvas.height = 0;
  }
}

function renderModel(object, scene, renderer) {
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) throw new Error('サムネイルに表示できる形状がありません');
  const dimensions = bounds.getSize(new THREE.Vector3());
  if (![dimensions.x, dimensions.y, dimensions.z].every(Number.isFinite)) throw new Error('モデルの座標が不正です');
  const wrapper = new THREE.Group();
  wrapper.add(object);
  wrapper.position.set(-(bounds.min.x + bounds.max.x) / 2, -(bounds.min.y + bounds.max.y) / 2, -bounds.min.z);
  scene.add(wrapper);

  const center = new THREE.Vector3(0, 0, dimensions.z / 2);
  const radius = Math.max(dimensions.length() / 2, 0.05);
  const largest = Math.max(dimensions.x, dimensions.y, dimensions.z, 0.1);
  const camera = new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, Math.max(radius / 10000, 0.0001), radius * 150 + 100);
  camera.up.set(0, 0, 1);
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.14;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1, -1.4, 0.95).normalize(), distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();

  const ambient = new THREE.HemisphereLight(0xe9f5ff, 0x52647b, 2.5);
  ambient.position.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xffffff, 3.3);
  key.position.set(largest * 1.4, -largest * 1.1, largest * 2.6);
  key.target.position.copy(center);
  const fill = new THREE.DirectionalLight(0x8bbcf6, 1.5);
  fill.position.set(-1, 1, 0.7);
  scene.add(ambient, key, key.target, fill);

  const wantedStep = largest / 7;
  const exponent = 10 ** Math.floor(Math.log10(wantedStep));
  const step = [1, 2, 5, 10].map(n => n * exponent).find(n => n >= wantedStep);
  const grid = new THREE.GridHelper(step * 20, 20, 0x3e536b, 0x263445);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -largest * 0.001;
  scene.add(grid);

  // Explicit canvas dimensions and a synchronous render work in a hidden window.
  renderer.render(scene, camera);
  if (renderer.getContext().isContextLost()) throw new Error('3D描画中にGPUコンテキストが失われました');
  return encodeThumbnail(renderer.domElement);
}

function disposeRenderer() {
  if (!renderer) return;
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
  renderer = null;
}

function getRenderer() {
  if (renderer?.getContext().isContextLost()) disposeRenderer();
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT, false);
    renderer.setClearColor(BACKGROUND);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    document.body.appendChild(renderer.domElement);
  }
  return renderer;
}

async function generateThumbnail(input, signal) {
  if (!input?.name || !input.bytes) throw new Error('サムネイル生成の入力データが不正です');
  let result;
  let scene;
  let jobRenderer;
  try {
    result = await loadModel(input.bytes, {
      filename: input.name,
      memoryBudgetMiB: input.memoryBudgetMiB ?? 2048,
      signal,
    });
    signal.throwIfAborted();
    if (!result.object && result.previewImage) {
      return { dataUrl: await resizeSavedPreview(result.previewImage, signal) };
    }
    if (!result.object) throw new Error('モデルに形状もプレビュー画像も含まれていません');
    jobRenderer = getRenderer();
    scene = new THREE.Scene();
    return { dataUrl: renderModel(result.object, scene, jobRenderer) };
  } finally {
    // The canvas and context are reused. Model and render-list resources are
    // released before the next thumbnail job is issued.
    if (scene) {
      disposeModel(scene);
      scene.clear();
    }
    if (result?.object && !result.object.parent) disposeModel(result.object);
    jobRenderer?.renderLists.dispose();
    if (jobRenderer?.getContext().isContextLost()) disposeRenderer();
  }
}

async function reportFailure(job, cause, discard = false) {
  if (!job || currentJob !== job) return;
  currentJob = null;
  job.controller.abort();
  const message = cause instanceof Error ? cause.message : String(cause || 'サムネイル生成に失敗しました');
  document.body.dataset.status = 'failed';
  console.error('Thumbnail generation failed:', cause);
  try {
    await api.fail(job.id, message, discard);
  } catch (error) {
    console.error('Thumbnail failure report was rejected:', error);
  }
}

async function run(jobId) {
  if (currentJob) return;
  const job = { id: jobId, controller: new AbortController() };
  currentJob = job;
  document.body.dataset.status = 'loading';
  let thumbnail;
  try {
    const input = await api.getInput(jobId);
    thumbnail = await generateThumbnail(input, job.controller.signal);
  } catch (cause) {
    await reportFailure(job, cause);
    return;
  }
  if (currentJob !== job) return;
  currentJob = null;
  document.body.dataset.status = 'saving';
  try {
    await api.complete(jobId, thumbnail);
    if (!currentJob) document.body.dataset.status = 'idle';
  } catch (error) {
    // A canceled or replaced worker can no longer report this result.
    console.error('Thumbnail completion was rejected:', error);
  }
}

if (!api) throw new Error('サムネイル生成APIが見つかりません');
const disconnect = api.onJob(jobId => { void run(jobId); });
window.addEventListener('beforeunload', () => {
  disconnect();
  currentJob?.controller.abort();
  disposeRenderer();
}, { once: true });
window.addEventListener('error', event => { void reportFailure(currentJob, event.error || event.message, true); });
window.addEventListener('unhandledrejection', event => { void reportFailure(currentJob, event.reason, true); });
void api.ready().catch(error => console.error('Thumbnail worker readiness was rejected:', error));
