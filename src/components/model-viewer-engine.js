import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeModel } from '../formats/common.js';

const BACKGROUND = '#141b25';
const PRESETS = {
  iso: new THREE.Vector3(1, -1.4, 0.95),
  front: new THREE.Vector3(0, -1, 0.001),
  top: new THREE.Vector3(0, -0.001, 1),
  right: new THREE.Vector3(1, 0, 0.001),
};

export function setWireframe(root, enabled) {
  root?.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material && 'wireframe' in material) material.wireframe = enabled;
    }
  });
}

export function fitCamera(engine, preset = 'iso') {
  const { camera, controls, dimensions, center } = engine;
  if (!dimensions) return;
  // A bounding sphere fits from every preset, including long, narrow parts.
  const radius = Math.max(dimensions.length() / 2, 0.05);
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.18;
  const direction = (PRESETS[preset] || PRESETS.iso).clone().normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(radius / 10000, 0.0001);
  camera.far = Math.max(distance + radius * 100, 100);
  camera.updateProjectionMatrix();
  controls.minDistance = radius * 0.02;
  controls.maxDistance = distance * 20;
  controls.update();
  engine.invalidate();
}

export function makeGround(engine, dimensions) {
  if (engine.ground) {
    engine.scene.remove(engine.ground);
    disposeModel(engine.ground);
  }
  const largest = Math.max(dimensions.x, dimensions.y, dimensions.z, 0.1);
  const wantedStep = largest / 7;
  const exponent = 10 ** Math.floor(Math.log10(wantedStep));
  const step = [1, 2, 5, 10].map((n) => n * exponent).find((n) => n >= wantedStep);
  const extent = step * 20;
  const group = new THREE.Group();
  const grid = new THREE.GridHelper(extent, 20, 0x3e536b, 0x263445);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -largest * 0.001;
  group.add(grid);
  if (engine.renderer.shadowMap.enabled) {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(extent, extent),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    plane.position.z = -largest * 0.002;
    plane.receiveShadow = true;
    group.add(plane);
  }
  group.visible = engine.showGrid;
  engine.ground = group;
  engine.gridStep = step;
  engine.scene.add(group);
  engine.keyLight.position.set(largest * 1.4, -largest * 1.1, largest * 2.6);
  engine.keyLight.target.position.copy(engine.center);
  if (!engine.renderer.shadowMap.enabled) return;
  const shadowCamera = engine.keyLight.shadow.camera;
  Object.assign(shadowCamera, {
    left: -largest, right: largest, top: largest, bottom: -largest,
    near: largest * 0.01, far: largest * 8,
  });
  shadowCamera.updateProjectionMatrix();
  engine.keyLight.shadow.normalBias = largest * 0.002;
  engine.renderer.shadowMap.needsUpdate = true;
}

export function createViewerEngine(host, lightweightPreview, optionsRef) {
  const renderer = new THREE.WebGLRenderer({
    antialias: !lightweightPreview, alpha: false,
    powerPreference: lightweightPreview ? 'low-power' : 'default',
  });
  renderer.setClearColor(BACKGROUND);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = !lightweightPreview;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-label', '3Dモデル。左ドラッグで回転、右ドラッグで移動、ホイールで拡大縮小');
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('data-testid', 'model-canvas');
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
  camera.up.set(0, 0, 1);
  camera.position.set(100, -140, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !lightweightPreview;
  controls.dampingFactor = 0.085;
  controls.autoRotateSpeed = 1.1;
  controls.screenSpacePanning = true;
  const ambient = new THREE.HemisphereLight(0xe9f5ff, 0x52647b, 2.5);
  ambient.position.set(0, 0, 1);
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.3);
  keyLight.castShadow = !lightweightPreview;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0001;
  const fillLight = new THREE.DirectionalLight(0x8bbcf6, 1.5);
  fillLight.position.set(-1, 1, 0.7);
  scene.add(ambient, keyLight, keyLight.target, fillLight);

  let active = true;
  let frame = null;
  const invalidate = () => {
    if (active && frame === null && !document.hidden) {
      frame = requestAnimationFrame(() => {
        frame = null;
        render();
      });
    }
  };
  function render() {
    if (!active || document.hidden) return;
    controls.autoRotate = optionsRef.current.autoRotate && Boolean(engine.model);
    controls.update();
    renderer.render(scene, camera);
    if (controls.autoRotate) invalidate();
  }
  const engine = {
    renderer, scene, camera, controls, keyLight,
    model: null, ground: null, dimensions: null, center: new THREE.Vector3(),
    showGrid: optionsRef.current.showGrid,
    invalidate,
    renderNow() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      render();
    },
  };
  const onChange = invalidate;
  controls.addEventListener('change', onChange);
  const onStart = () => engine.invalidate();
  controls.addEventListener('start', onStart);
  let lastWidth = 0;
  let lastHeight = 0;
  const resize = () => {
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    if (lastWidth === width && lastHeight === height) return;
    lastWidth = width;
    lastHeight = height;
    const pixelRatio = lightweightPreview ? Math.min(1, 1280 / width, 900 / height) : Math.min(window.devicePixelRatio || 1, 2);
    renderer.setDrawingBufferSize(width, height, pixelRatio);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    engine.invalidate();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const onVisibility = () => engine.invalidate();
  document.addEventListener('visibilitychange', onVisibility);
  engine.dispose = () => {
    active = false;
    if (frame !== null) cancelAnimationFrame(frame);
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    controls.removeEventListener('change', onChange);
    controls.removeEventListener('start', onStart);
    controls.dispose();
    disposeModel(scene);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  return engine;
}

export function captureThumbnail(source, width, height) {
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 260;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const scale = Math.min(canvas.width / width, canvas.height / height);
  const targetWidth = width * scale;
  const targetHeight = height * scale;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, (canvas.width - targetWidth) / 2, (canvas.height - targetHeight) / 2, targetWidth, targetHeight);
  return canvas.toDataURL('image/png');
}
