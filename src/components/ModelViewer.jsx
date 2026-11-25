import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { loadModel, disposeModel } from '../formats/index.js';
import { createViewerEngine, makeGround, fitCamera, setWireframe, captureThumbnail } from './model-viewer-engine.js';
import './ModelViewer.css';

export default function ModelViewer({
  ref,
  item,
  onMetadata,
  onThumbnail,
  viewMode = 'solid',
  showGrid = true,
  autoRotate = false,
  viewPreset = 'iso',
  memoryBudgetMiB = 2048,
  manualMemoryBudgetMiB = memoryBudgetMiB,
  lightweightPreview = true,
  onCancel,
  onOpenMemorySettings,
  scadValues,
  scadExecutable,
  onPhaseChange,
}) {
  const mountRef = useRef(null);
  const engineRef = useRef(null);
  const disposePreviewRef = useRef(null);
  const callbacksRef = useRef({ onMetadata, onThumbnail });
  const optionsRef = useRef(null);
  const [phase, setPhase] = useState('empty');
  const [error, setError] = useState('');
  const [gridStep, setGridStep] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [detailed, setDetailed] = useState(false);
  callbacksRef.current = { onMetadata, onThumbnail };
  optionsRef.current = {
    item, viewMode, showGrid, autoRotate, viewPreset,
    memoryBudgetMiB, manualMemoryBudgetMiB, lightweightPreview, scadValues, scadExecutable,
  };
  const canRetryDetailed = !item?.missing && lightweightPreview && manualMemoryBudgetMiB > memoryBudgetMiB && !detailed;

  useEffect(() => { onPhaseChange?.(phase); }, [phase, onPhaseChange]);

  const loadPreview = useCallback((options = {}) => {
    disposePreviewRef.current?.();
    disposePreviewRef.current = null;

    const {
      item, memoryBudgetMiB, manualMemoryBudgetMiB, lightweightPreview,
      scadValues, scadExecutable, detailed = false,
    } = { ...optionsRef.current, ...options };
    const controller = new AbortController();
    const { signal } = controller;
    setDetailed(detailed);
    setGridStep(null);
    setPreviewImage(null);
    setError('');
    callbacksRef.current.onMetadata?.(null);
    if (!item) {
      setPhase('empty');
      return;
    }
    if (item.missing) {
      setPhase('error');
      setError('元ファイルが見つかりません。移動先のフォルダを追加するか、元の場所に戻してください。');
      return;
    }
    setPhase('loading');
    // Keep a single budget for disk reading and format expansion. Saving a new
    // setting alone must not unexpectedly restart a large model.
    const loadBudgetMiB = detailed ? manualMemoryBudgetMiB : memoryBudgetMiB;
    const loadOptions = { memoryBudgetMiB: loadBudgetMiB, detailed };
    const isScad = item.format === 'scad';
    const overrides = scadValues || {};
    let scadRequestId;
    let modelRequestId;
    let imageUrl;
    let engine;
    (async () => {
      let loadedObject;
      try {
        if (isScad && !scadExecutable) throw new Error('設定からOpenSCADの実行ファイルを指定してください。');
        const input = isScad
          ? await window.nine.renderScad(item.id, overrides, (scadRequestId = crypto.randomUUID()), loadOptions)
          : { bytes: await window.nine.readModel(item.id, loadOptions, (modelRequestId = crypto.randomUUID())) };
        scadRequestId = undefined;
        modelRequestId = undefined;
        signal.throwIfAborted();
        const filename = isScad ? `${item.name}.stl` : item.name;
        const result = await loadModel(input.bytes, {
          filename, signal, memoryBudgetMiB: loadBudgetMiB, consumeInput: true, offThread: true,
        });
        if (isScad) result.warnings = input.warnings || [];
        loadedObject = result.object;
        signal.throwIfAborted();
        if (result.previewImage && !loadedObject) {
          setPreviewImage({ src: result.previewImage, fallback: false });
          setPhase('preview');
          callbacksRef.current.onMetadata?.({ ...result.metadata, warnings: result.warnings, unit: 'mm' });
          if (item.hasThumbnail) return;
          const image = new Image();
          image.onload = () => {
            if (signal.aborted) return;
            const thumbnail = captureThumbnail(image, image.naturalWidth, image.naturalHeight);
            if (thumbnail) callbacksRef.current.onThumbnail?.(thumbnail);
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
        try {
          engine = createViewerEngine(mountRef.current, lightweightPreview && !detailed, optionsRef);
          engineRef.current = engine;
        } catch (cause) {
          throw new Error(`3D表示を初期化できませんでした。${cause.message}`, { cause });
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
          object.castShadow = engine.renderer.shadowMap.enabled;
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
        // Existing thumbnails stay untouched on ordinary previews.
        if (item.hasThumbnail || document.hidden || (isScad && Object.keys(overrides).length)) return;
        // Capture immediately after rendering, without retaining the drawing buffer.
        engine.renderNow();
        const source = engine.renderer.domElement;
        const thumbnail = captureThumbnail(source, source.width, source.height);
        if (thumbnail) callbacksRef.current.onThumbnail?.(thumbnail);
      } catch (cause) {
        if (!engine?.model) disposeModel(loadedObject);
        if (signal.aborted || cause?.name === 'AbortError') return;
        engine?.dispose();
        if (engineRef.current === engine) engineRef.current = null;
        engine = undefined;
        const message = cause?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || String(cause);
        if (item.format === '3mf') {
          const image = await window.nine.readEmbedded3mfImage(item.id, (modelRequestId = crypto.randomUUID())).catch(() => null);
          modelRequestId = undefined;
          if (signal.aborted) return;
          if (image) {
            imageUrl = URL.createObjectURL(new Blob([image.bytes], { type: image.mime }));
            setPreviewImage({ src: imageUrl, fallback: true, message });
            callbacksRef.current.onMetadata?.({ previewOnly: true, warnings: [message] });
            setPhase('preview');
            return;
          }
        }
        setError(message);
        setPhase('error');
      }
    })();
    disposePreviewRef.current = () => {
      controller.abort();
      if (scadRequestId) window.nine.cancelScadRender(scadRequestId).catch(() => {});
      if (modelRequestId) window.nine.cancelModelRead(modelRequestId).catch(() => {});
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      engine?.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    fit(preset = optionsRef.current.viewPreset) {
      if (engineRef.current) fitCamera(engineRef.current, preset);
    },
    reload(itemId, options) {
      if (optionsRef.current.item?.id === itemId) loadPreview({ detailed, ...options });
    },
  }), [detailed, loadPreview]);

  useEffect(() => {
    loadPreview();
    return () => {
      disposePreviewRef.current?.();
      disposePreviewRef.current = null;
    };
  }, [item?.id, item?.path, item?.modifiedAt, item?.missing, scadExecutable, loadPreview]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setWireframe(engine.model, viewMode === 'wireframe');
    engine.renderer.shadowMap.needsUpdate = true;
    engine.invalidate();
  }, [viewMode]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.showGrid = showGrid;
    if (engine.ground) engine.ground.visible = showGrid;
    engine.invalidate();
  }, [showGrid]);
  useEffect(() => { engineRef.current?.invalidate(); }, [autoRotate]);

  const retryActions = (phase === 'error' || previewImage?.fallback) && (
    <div className="model-viewer__error-actions">
      <button type="button" onClick={() => loadPreview({ detailed })}>再読み込み</button>
      {canRetryDetailed && <button type="button" onClick={() => loadPreview({ detailed: true })}>詳細上限で再読み込み</button>}
      {onOpenMemorySettings && <button type="button" onClick={onOpenMemorySettings}>プレビューメモリ設定</button>}
    </div>
  );

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
          {onCancel && <div className="model-viewer__error-actions"><button type="button" onClick={onCancel}>読み込みを中止</button></div>}
        </div>
      )}
      {phase === 'error' && (
        <div className="model-viewer__state model-viewer__state--error" role="alert">
          <div className="model-viewer__error-symbol">!</div>
          <h3>プレビューできませんでした</h3>
          <p>{error}</p>
          {retryActions}
        </div>
      )}
      {phase === 'preview' && previewImage && (
        <div className="preview-only">
          <img src={previewImage.src} alt="3MFに保存されたプレビュー画像" onError={() => {
            if (previewImage.fallback) URL.revokeObjectURL(previewImage.src);
            setError(previewImage.message || '3MFの内蔵画像を表示できませんでした。');
            setPreviewImage(null);
            setPhase('error');
          }}/>
          <div>
            <h3>保存されたプレビュー</h3>
            <p>{previewImage.fallback ? '3Dを読み込めなかったため、内蔵画像を表示しています。' : 'このファイルには3D形状が含まれていないため、画像を表示しています。'}</p>
            {retryActions}
          </div>
        </div>
      )}
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
