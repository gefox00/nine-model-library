import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadModel } from '../formats/index.js';
import './ModelViewer.css';

const BACKGROUND = '#141b25';
const PRESETS = {
  iso: new THREE.Vector3(1, -1.4, 0.95),
  front: new THREE.Vector3(0, -1, 0.001),
  top: new THREE.Vector3(0, -0.001, 1),
  right: new THREE.Vector3(1, 0, 0.001),
};

function disposeObject(root) {
  if (!root) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function setWireframe(root, enabled) {
  root?.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material && 'wireframe' in material) material.wireframe = enabled;
    }
  });
}

function fitCamera(engine, preset = 'iso') {
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

function makeGround(engine, dimensions) {
  if (engine.ground) {
    engine.scene.remove(engine.ground);
    disposeObject(engine.ground);
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
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(extent, extent),
    new THREE.ShadowMaterial({ opacity: 0.22 }),
  );
  plane.position.z = -largest * 0.002;
  plane.receiveShadow = true;
  group.add(grid, plane);
  group.visible = engine.showGrid;
  engine.ground = group;
  engine.gridStep = step;
  engine.scene.add(group);
  engine.keyLight.position.set(largest * 1.4, -largest * 1.1, largest * 2.6);
  engine.keyLight.target.position.copy(engine.center);
  const shadowCamera = engine.keyLight.shadow.camera;
  Object.assign(shadowCamera, {
    left: -largest, right: largest, top: largest, bottom: -largest,
    near: largest * 0.01, far: largest * 8,
  });
  shadowCamera.updateProjectionMatrix();
  engine.keyLight.shadow.normalBias = largest * 0.002;
}

export default function ModelViewer({
  item,
  onMetadata,
  onThumbnail,
  viewMode = 'solid',
  showGrid = true,
  autoRotate = false,
  viewPreset = 'iso',
  fitToken = 0,
  memoryBudgetMiB = 2048,
  reloadToken = 0,
  onOpenMemorySettings,
  scadValues,
  scadExecutable,
  onPhaseChange,
}) {
  const mountRef = useRef(null);
  const engineRef = useRef(null);
  const callbacksRef = useRef({ onMetadata, onThumbnail });
  const optionsRef = useRef({ viewMode, showGrid, autoRotate, viewPreset, memoryBudgetMiB, scadValues });
  const [phase, setPhase] = useState('empty');
  const [error, setError] = useState('');
  const [gridStep, setGridStep] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [retryToken, setRetryToken] = useState(0);
  callbacksRef.current = { onMetadata, onThumbnail };
  optionsRef.current = { viewMode, showGrid, autoRotate, viewPreset, memoryBudgetMiB, scadValues };

  useEffect(() => { onPhaseChange?.(phase); }, [phase, onPhaseChange]);

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    } catch (cause) {
      setError(`3D表示を初期化できませんでした。${cause.message}`);
      setPhase('error');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(BACKGROUND);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
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
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.autoRotateSpeed = 1.1;
    controls.screenSpacePanning = true;
    const ambient = new THREE.HemisphereLight(0xe9f5ff, 0x52647b, 2.5);
    ambient.position.set(0, 0, 1);
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.3);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0001;
    const fillLight = new THREE.DirectionalLight(0x8bbcf6, 1.5);
    fillLight.position.set(-1, 1, 0.7);
    scene.add(ambient, keyLight, keyLight.target, fillLight);

    let active = true;
    let frame = 0;
    let dirtyFrames = 2;
    const engine = {
      renderer, scene, camera, controls, keyLight,
      model: null, ground: null, dimensions: null, center: new THREE.Vector3(),
      showGrid: optionsRef.current.showGrid,
      invalidate: () => { dirtyFrames = 80; },
    };
    engineRef.current = engine;
    const onChange = () => { dirtyFrames = Math.max(dirtyFrames, 2); };
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
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      engine.invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const render = () => {
      if (!active) return;
      frame = requestAnimationFrame(render);
      controls.autoRotate = optionsRef.current.autoRotate && !!engine.model;
      if (!document.hidden && (dirtyFrames > 0 || controls.autoRotate)) {
        controls.update();
        renderer.render(scene, camera);
        dirtyFrames--;
      }
    };
    render();
    const onVisibility = () => engine.invalidate();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      controls.removeEventListener('change', onChange);
      controls.removeEventListener('start', onStart);
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const controller = new AbortController();
    let cancelled = false;
    if (engine.model) {
      engine.scene.remove(engine.model);
      disposeObject(engine.model);
      engine.model = null;
    }
    if (engine.ground) {
      engine.scene.remove(engine.ground);
      disposeObject(engine.ground);
      engine.ground = null;
    }
    engine.dimensions = null;
    engine.invalidate();
    setGridStep(null);
    setPreviewImage(null);
    setError('');
    callbacksRef.current.onMetadata?.(null);
    if (!item) {
      setPhase('empty');
      return () => { cancelled = true; controller.abort(); };
    }
    if (item.missing) {
      setPhase('error');
      setError('元ファイルが見つかりません。移動先のフォルダを追加するか、元の場所に戻してください。');
      return () => { cancelled = true; controller.abort(); };
    }
    setPhase('loading');
    // Keep a single budget for disk reading and format expansion. Saving a new
    // setting alone must not unexpectedly restart a large model.
    const loadBudgetMiB = optionsRef.current.memoryBudgetMiB;
    const isScad = item.format === 'scad';
    const overrides = optionsRef.current.scadValues || {};
    let scadRequestId;
    (async () => {
      let loadedObject;
      try {
        if (isScad && !scadExecutable) throw new Error('設定からOpenSCADの実行ファイルを指定してください。');
        const input = isScad
          ? await window.nine.renderScad(item.id, overrides, (scadRequestId = crypto.randomUUID()))
          : { bytes: await window.nine.readModel(item.id, { memoryBudgetMiB: loadBudgetMiB }) };
        scadRequestId = undefined;
        if (cancelled) return;
        const filename = isScad ? `${item.name}.stl` : item.name;
        const result = await loadModel(input.bytes, { filename, signal: controller.signal, memoryBudgetMiB: loadBudgetMiB });
        if (isScad) result.warnings = input.warnings || [];
        loadedObject = result.object;
        if (cancelled || engineRef.current !== engine) {
          disposeObject(loadedObject);
          return;
        }
        if (result.previewImage && !loadedObject) {
          setPreviewImage(result.previewImage);
          setPhase('preview');
          callbacksRef.current.onMetadata?.({ ...result.metadata, warnings: result.warnings, unit: 'mm' });
          const image = new Image();
          image.onload = () => {
            if (cancelled) return;
            const canvas = document.createElement('canvas');
            canvas.width = 360; canvas.height = 260;
            const context = canvas.getContext('2d');
            const scale = Math.min(360 / image.width, 260 / image.height);
            context.fillStyle = BACKGROUND; context.fillRect(0, 0, 360, 260);
            context.drawImage(image, (360-image.width*scale)/2, (260-image.height*scale)/2, image.width*scale, image.height*scale);
            callbacksRef.current.onThumbnail?.(canvas.toDataURL('image/png'));
          };
          image.src = result.previewImage;
          return;
        }
        const bounds = new THREE.Box3().setFromObject(loadedObject);
        if (bounds.isEmpty()) throw new Error('表示できる形状が含まれていません');
        const dimensions = bounds.getSize(new THREE.Vector3());
        if (![dimensions.x, dimensions.y, dimensions.z].every(Number.isFinite)) {
          throw new Error('モデルの座標に無効な値が含まれています');
        }
        const wrapper = new THREE.Group();
        wrapper.add(loadedObject);
        wrapper.position.set(-(bounds.min.x + bounds.max.x) / 2, -(bounds.min.y + bounds.max.y) / 2, -bounds.min.z);
        let triangles = 0;
        let objects = 0;
        loadedObject.traverse((object) => {
          if (!object.isMesh) return;
          objects++;
          triangles += ((object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3) * (object.isInstancedMesh ? object.count : 1);
          object.castShadow = true;
          object.receiveShadow = false;
        });
        engine.model = wrapper;
        engine.dimensions = dimensions;
        engine.center.set(0, 0, dimensions.z / 2);
        engine.scene.add(wrapper);
        makeGround(engine, dimensions);
        setWireframe(wrapper, optionsRef.current.viewMode === 'wireframe');
        fitCamera(engine, optionsRef.current.viewPreset);
        setGridStep(engine.gridStep);
        setPhase('ready');
        callbacksRef.current.onMetadata?.({
          ...result.metadata,
          dimensions: dimensions.toArray(),
          triangles: Math.round(triangles),
          objects,
          warnings: result.warnings || [],
          unit: result.unit || 'mm',
        });
        // Capture on the same frame as the render, so the image works without a second GPU context.
        engine.renderer.render(engine.scene, engine.camera);
        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 260;
        const context = canvas.getContext('2d');
        const source = engine.renderer.domElement;
        if (context && source.width && source.height && (!isScad || !Object.keys(overrides).length)) {
          const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
          const width = source.width * scale;
          const height = source.height * scale;
          context.fillStyle = BACKGROUND;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
          callbacksRef.current.onThumbnail?.(canvas.toDataURL('image/png'));
        }
      } catch (cause) {
        if (cancelled || cause?.name === 'AbortError') return;
        if (loadedObject && !engine.model) disposeObject(loadedObject);
        setError(cause?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || String(cause));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (scadRequestId) window.nine.cancelScadRender(scadRequestId).catch(() => {});
    };
  }, [item?.id, item?.modifiedAt, item?.missing, reloadToken, retryToken, scadExecutable]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setWireframe(engine.model, viewMode === 'wireframe');
    engine.invalidate();
  }, [viewMode]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.showGrid = showGrid;
    if (engine.ground) engine.ground.visible = showGrid;
    engine.invalidate();
  }, [showGrid]);
  useEffect(() => {
    const engine = engineRef.current;
    if (engine) fitCamera(engine, viewPreset);
  }, [viewPreset, fitToken]);
  useEffect(() => { engineRef.current?.invalidate(); }, [autoRotate]);

  return (
    <div className={`model-viewer model-viewer--${phase}`} data-testid="model-viewer" data-phase={phase}>
      <div ref={mountRef} className="model-viewer__canvas" />
      {phase === 'empty' && (
        <div className="model-viewer__state">
          <div className="model-viewer__empty-cube" aria-hidden="true">◇</div>
          <h3>モデルを選択</h3>
          <p>ライブラリからファイルを選んで、形状を確認</p>
          <span>STL · STEP · 3MF</span>
        </div>
      )}
      {phase === 'loading' && (
        <div className="model-viewer__state model-viewer__state--loading" role="status">
          <div className="model-viewer__spinner" />
          <h3>{item?.format === 'scad' ? 'OpenSCADで形状を計算中' : ['step', 'stp'].includes(item?.format?.toLowerCase()) ? 'STEPを変換中' : 'モデルを読み込み中'}</h3>
          <p>{item?.name}</p>
          <span>大きなモデルは少し時間がかかることがあります</span>
        </div>
      )}
      {phase === 'error' && (
        <div className="model-viewer__state model-viewer__state--error" role="alert">
          <div className="model-viewer__error-symbol">!</div>
          <h3>プレビューできませんでした</h3>
          <p>{error}</p>
          <div className="model-viewer__error-actions">
            <button type="button" onClick={() => setRetryToken((value) => value + 1)}>再読み込み</button>
            {onOpenMemorySettings && <button type="button" onClick={onOpenMemorySettings}>プレビューメモリ設定</button>}
          </div>
        </div>
      )}
      {phase === 'preview' && <div className="preview-only"><img src={previewImage} alt="3MFに保存されたプレビュー画像"/><div><h3>保存されたプレビュー</h3><p>このファイルには3D形状が含まれていないため、画像を表示しています。</p></div></div>}
      {phase === 'ready' && (
        <>
          <div className="model-viewer__axis" aria-label="座標軸: Z上方向">
            <span className="model-viewer__axis-z">Z</span><span className="model-viewer__axis-y">Y</span><span className="model-viewer__axis-x">X</span>
          </div>
          {showGrid && gridStep != null && <div className="model-viewer__scale">グリッド {Number(gridStep.toPrecision(6))} mm</div>}
        </>
      )}
    </div>
  );
}
